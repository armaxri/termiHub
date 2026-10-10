//! FTP server powered by [`libunftp`].
//!
//! Replaces the former hand-rolled RFC 959 implementation with the actively
//! maintained [`libunftp`] crate backed by [`unftp_sbe_fs::Filesystem`].
//! Authentication and optional read-only mode are preserved.
//!
//! Every login attempt and file operation is recorded in the server's access
//! log (PROD-034) with the client IP and username — never the password.
//!
//! libunftp does not face the network directly: termiHub's front relay
//! ([`super::ftp_relay`]) owns the public control port and the passive ports,
//! caps the control line, and forwards to one libunftp server per session that
//! listens on loopback in PROXY protocol mode (#3996).

use std::collections::HashMap;
use std::fmt::{self, Debug, Display};
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use async_trait::async_trait;
use libunftp::notification::{DataEvent, DataListener, EventMeta, PresenceEvent, PresenceListener};
use libunftp::ServerBuilder;
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::sync::CancellationToken;
use unftp_core::auth::{
    AuthenticationError, Authenticator, Credentials, Principal, UserDetail, UserDetailError,
    UserDetailProvider,
};
use unftp_core::storage::{ErrorKind as StorageErrorKind, Fileinfo, StorageBackend};
use unftp_sbe_fs::Filesystem;

use super::activity::{AccessRecord, ServerActivity, TransferGuard};
use super::auth_guard::{secret_eq, LoginThrottle};
use super::config::{AtomicServerStats, EmbeddedServerConfig, FtpAuth};
use super::ftp_relay::{BackendDialer, RelaySession, PRELOGIN_TIMEOUT};
use super::service::BindSignal;
use super::shutdown::ShutdownSignal;

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the FTP server in the current thread, blocking until `shutdown` fires.
///
/// Internally this creates a single-threaded tokio runtime so that the async
/// libunftp server can run inside the OS thread that the `EmbeddedServerManager`
/// already spawned. `ready` is signalled exactly once, with the control
/// listener's real bound address once it is bound (or with the error if binding
/// fails), so the manager only reports `Running` for a socket the server
/// actually serves on (GAP G3 #1145, #3549).
pub fn start_ftp_server(
    config: &EmbeddedServerConfig,
    shutdown: ShutdownSignal,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build tokio runtime for FTP server")
    {
        Ok(rt) => rt,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    rt.block_on(run_ftp_server(
        config,
        FtpLimits::for_config(config),
        shutdown,
        stats,
        ready,
    ))
}

/// The libunftp builder type this module configures.
type FtpServerBuilder = ServerBuilder<MaybeReadOnlyFilesystem, FtpUser>;

/// Passive data-connection port range. libunftp 0.21 made the range inclusive;
/// this is the same 49152–65534 span the former exclusive `49152..65535` gave.
/// The relay binds its passive listeners in this range (#3996).
const PASSIVE_PORTS: std::ops::RangeInclusive<u16> = 49152..=65534;

/// Grace period a per-session libunftp server gets to close its control loop
/// once its session ends or the server shuts down.
const BACKEND_GRACE: Duration = Duration::from_secs(2);

/// How long shutdown waits for open sessions to wind down before the runtime
/// drops whatever is left.
const SESSION_DRAIN: Duration = Duration::from_secs(3);

/// Default cap on concurrent FTP sessions when the config sets none
/// (CORE2-002, #4292). Each session holds a libunftp server, a loopback
/// listener and the relay's sockets, so the cap bounds what unauthenticated
/// connections can make the server hold. In line with the TFTP transfer cap.
pub(super) const DEFAULT_MAX_CONCURRENT_FTP_SESSIONS: usize = 32;

/// Reply sent to a connection refused because every session slot is taken.
const REPLY_TOO_MANY_SESSIONS: &[u8] = b"421 Too many connections, try again later.\r\n";

/// Reply sent to a connection refused because its client IP already holds its
/// share of the session slots (#4398).
const REPLY_TOO_MANY_CLIENT_SESSIONS: &[u8] =
    b"421 Too many connections from your address, try again later.\r\n";

/// Smallest per-client-IP session sub-cap: an interactive client commonly
/// opens a second control connection for a background transfer (#4398).
pub(super) const MIN_SESSIONS_PER_CLIENT: usize = 2;

/// Reply sent to a connection from a client locked out after failed logins.
const REPLY_THROTTLED: &[u8] = b"421 Too many failed logins, try again later.\r\n";

/// The effective session cap for `config` (at least one session).
pub(super) fn session_cap(config: &EmbeddedServerConfig) -> usize {
    config
        .max_concurrent_sessions
        .map_or(DEFAULT_MAX_CONCURRENT_FTP_SESSIONS, |cap| cap as usize)
        .max(1)
}

/// The per-client-IP session sub-cap for a server-wide cap of `session_cap`
/// (#4398): a quarter of the cap, at least [`MIN_SESSIONS_PER_CLIENT`], and
/// never more than the cap itself. One client IP can then not take every
/// session slot and lock everyone else out.
pub(super) fn per_client_session_cap(session_cap: usize) -> usize {
    session_cap
        .div_ceil(4)
        .max(MIN_SESSIONS_PER_CLIENT)
        .min(session_cap)
}

/// The connection limits the accept loop and the relay enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FtpLimits {
    /// Server-wide concurrent-session cap (CORE2-002, #4292).
    pub session_cap: usize,
    /// Concurrent sessions one client IP may hold (#4398).
    pub per_client_cap: usize,
    /// How long a control connection may stay open without logging in (#4398).
    pub prelogin_timeout: Duration,
}

impl FtpLimits {
    /// The limits for `config`: its session cap (or the default), the derived
    /// per-client sub-cap and the built-in pre-login timeout.
    pub(super) fn for_config(config: &EmbeddedServerConfig) -> Self {
        let session_cap = session_cap(config);
        Self {
            session_cap,
            per_client_cap: per_client_session_cap(session_cap),
            prelogin_timeout: PRELOGIN_TIMEOUT,
        }
    }
}

/// Live session counts per client IP, bounded by the per-client sub-cap
/// (#4398). An entry exists only while that IP holds a session, so the map
/// never has more entries than the server-wide session cap.
pub(super) struct ClientSessions {
    per_client_cap: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

impl ClientSessions {
    pub(super) fn new(per_client_cap: usize) -> Arc<Self> {
        Arc::new(Self {
            per_client_cap: per_client_cap.max(1),
            counts: Mutex::new(HashMap::new()),
        })
    }

    fn counts(&self) -> std::sync::MutexGuard<'_, HashMap<IpAddr, usize>> {
        // Every critical section is a single map update, so a poisoned lock
        // still holds consistent counts.
        self.counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Take one of `ip`'s session slots, or `None` when it holds them all.
    pub(super) fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ClientSlot> {
        let ip = ip.to_canonical();
        let mut counts = self.counts();
        let count = counts.entry(ip).or_insert(0);
        if *count >= self.per_client_cap {
            return None;
        }
        *count += 1;
        Some(ClientSlot {
            sessions: Arc::clone(self),
            ip,
        })
    }

    /// Sessions `ip` currently holds.
    #[cfg(test)]
    pub(super) fn held(&self, ip: IpAddr) -> usize {
        self.counts().get(&ip.to_canonical()).copied().unwrap_or(0)
    }

    /// Client IPs currently tracked.
    #[cfg(test)]
    pub(super) fn tracked(&self) -> usize {
        self.counts().len()
    }
}

/// One client IP's hold on a session slot; released on drop.
pub(super) struct ClientSlot {
    sessions: Arc<ClientSessions>,
    ip: IpAddr,
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        let mut counts = self.sessions.counts();
        if let Some(count) = counts.get_mut(&self.ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.ip);
            }
        }
    }
}

/// A session's slots: one of the server-wide cap and one of its client IP's
/// sub-cap, both held for the session's whole lifetime.
pub(super) struct SessionSlot {
    _global: tokio::sync::OwnedSemaphorePermit,
    _client: ClientSlot,
}

/// Configure a libunftp server for `config`. `client` is the session's real
/// client address, which the authenticator and the session user carry for the
/// access log (PROD-034): behind the relay, libunftp's own view of the peer
/// (and so `Credentials::source_ip`) is the relay's loopback address.
fn server_builder(
    config: &EmbeddedServerConfig,
    stats: &Arc<AtomicServerStats>,
    throttle: &Arc<LoginThrottle>,
    client: IpAddr,
) -> FtpServerBuilder {
    let root: PathBuf = config.root_directory.clone().into();
    let read_only = config.read_only;
    let activity = Arc::clone(&stats.activity);
    let activity_for_factory = Arc::clone(&activity);
    ServerBuilder::<MaybeReadOnlyFilesystem, FtpUser>::with_user_detail_provider(
        Box::new(move || MaybeReadOnlyFilesystem {
            inner: Filesystem::new(root.clone()),
            read_only,
            activity: Arc::clone(&activity_for_factory),
        }),
        Arc::new(FtpUserProvider { client }),
    )
    .authenticator(Arc::new(FtpAuthenticator::new(
        config.ftp_auth.clone(),
        activity,
        client,
        Arc::clone(throttle),
    )))
    .greeting("termiHub FTP Server ready.")
    .notify_data(StatsTracker {
        stats: Arc::clone(stats),
    })
    .notify_presence(StatsTracker {
        stats: Arc::clone(stats),
    })
}

/// The passive range libunftp reserves port numbers from. Behind the relay
/// these are only keys (the relay binds the real listeners), but libunftp
/// tells data from control connections by the PROXY destination port, so the
/// range must not contain the public control port.
fn reserved_passive_range(public_port: u16) -> std::ops::RangeInclusive<u16> {
    let (start, end) = (*PASSIVE_PORTS.start(), *PASSIVE_PORTS.end());
    if !PASSIVE_PORTS.contains(&public_port) {
        PASSIVE_PORTS
    } else if public_port - start >= end - public_port {
        start..=public_port - 1
    } else {
        public_port + 1..=end
    }
}

async fn run_ftp_server(
    config: &EmbeddedServerConfig,
    limits: FtpLimits,
    shutdown: ShutdownSignal,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let addr = format!("{}:{}", config.bind_host, config.port);

    // Validate the server configuration before binding, so a bad config fails
    // the start instead of every later connection.
    // One throttle for the whole run, shared by every session's libunftp
    // server, so failed logins add up across reconnects (CORE2-003).
    let throttle = Arc::new(LoginThrottle::new());
    if let Err(e) = server_builder(config, &stats, &throttle, IpAddr::from([0, 0, 0, 0]))
        .build()
        .context("Failed to build libunftp server")
    {
        ready.fail(&e.to_string());
        return Err(e);
    }

    // The relay owns the public control port (#3996). Bind it once and keep
    // the listener: the socket confirmed here is the one the server serves on,
    // so there is no probe-then-rebind window another process could win, and a
    // port-0 config reports the port it actually got (GAP G3 #1145, #3549).
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) => {
            let msg = format!("Failed to bind FTP server to {addr}: {e}");
            ready.fail(&msg);
            return Err(anyhow::anyhow!(msg));
        }
    };
    let local_addr = listener.local_addr().ok();
    ready.confirm(local_addr);
    let public_port = local_addr.map_or(config.port, |a| a.port());

    tracing::info!(?local_addr, "FTP server listening (relay + libunftp)");

    let slots = Arc::new(tokio::sync::Semaphore::new(limits.session_cap));
    let clients = ClientSessions::new(limits.per_client_cap);
    let config = Arc::new(config.clone());
    let mut sessions = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let Some((stream, slot)) = admit(stream, peer, &slots, &clients, &throttle, &stats)
                    else {
                        continue;
                    };
                    let session = serve_session(
                        Arc::clone(&config),
                        Arc::clone(&stats),
                        Arc::clone(&throttle),
                        stream,
                        peer,
                        RelayParams {
                            public_port,
                            prelogin_timeout: limits.prelogin_timeout,
                        },
                        shutdown.clone(),
                    );
                    sessions.spawn(async move {
                        // The slot is held for the session's whole lifetime.
                        let _slot = slot;
                        session.await;
                    });
                }
                Err(e) => tracing::warn!(error = %e, "FTP accept failed"),
            },
            Some(_) = sessions.join_next(), if !sessions.is_empty() => {}
            // Event-driven: park until the signal fires, then drop the listener
            // at once — no fixed-interval poll (WA-RS-001 / CORE-001).
            _ = shutdown.wait() => {
                tracing::info!("FTP server shutting down");
                break;
            }
        }
    }
    drop(listener);

    // Every session's libunftp server watches the same signal and closes its
    // control loop, which ends the relay. Give them a bounded moment, then
    // abort the rest (dropping the `JoinSet` aborts its tasks).
    let drained = tokio::time::timeout(SESSION_DRAIN, async {
        while sessions.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tracing::warn!("FTP sessions did not close in time; aborting them");
    }
    Ok(())
}

/// Decide whether an accepted connection may start a session.
///
/// A client locked out after failed logins, a connection arriving while every
/// session slot is taken, or one from a client IP that already holds its
/// sub-cap of sessions (#4398), is answered with `421`, recorded in the access
/// log and dropped (closing it). Otherwise the stream comes back with the
/// session's slot. The reply is a non-blocking write on a freshly accepted
/// socket, whose empty send buffer takes it whole, so a refusal never holds up
/// the accept loop or spawns a task.
fn admit(
    stream: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    slots: &Arc<tokio::sync::Semaphore>,
    clients: &Arc<ClientSessions>,
    throttle: &LoginThrottle,
    stats: &AtomicServerStats,
) -> Option<(tokio::net::TcpStream, SessionSlot)> {
    let (reply, status, detail) = if throttle.is_locked(peer.ip()) {
        (REPLY_THROTTLED, "throttled", "too many failed logins")
    } else {
        match Arc::clone(slots).try_acquire_owned() {
            Ok(global) => match clients.try_acquire(peer.ip()) {
                Some(client) => {
                    let slot = SessionSlot {
                        _global: global,
                        _client: client,
                    };
                    return Some((stream, slot));
                }
                None => (
                    REPLY_TOO_MANY_CLIENT_SESSIONS,
                    "busy",
                    "too many concurrent sessions from this client",
                ),
            },
            Err(_) => (
                REPLY_TOO_MANY_SESSIONS,
                "busy",
                "too many concurrent sessions",
            ),
        }
    };
    // tokio's `try_write` would report `WouldBlock` until the reactor has
    // seen the socket writable; the plain (still non-blocking) socket writes
    // straight away.
    if let Ok(std_stream) = stream.into_std() {
        let _ = io::Write::write(&mut &std_stream, reply);
    }
    tracing::debug!(%peer, detail, "FTP connection refused");
    stats.activity.record(
        AccessRecord::new("CONNECT", status, false)
            .client(peer.ip())
            .detail(detail),
    );
    None
}

/// A session's loopback libunftp server and the relay's connection to it.
pub(super) struct Backend {
    pub upstream: tokio::net::TcpStream,
    /// Opens (and is the only opener of) connections to the libunftp listener.
    pub dialer: BackendDialer,
    pub task: tokio::task::JoinHandle<std::result::Result<(), libunftp::ServerError>>,
    /// Cancelled when the session ends, which shuts this server down.
    pub stop: CancellationToken,
}

/// The future libunftp awaits to shut down: the server-wide signal or the end
/// of this session, whichever comes first.
async fn shutdown_indicator(
    global: ShutdownSignal,
    session: CancellationToken,
) -> libunftp::options::Shutdown {
    tokio::select! {
        _ = global.wait() => {}
        _ = session.cancelled() => {}
    }
    libunftp::options::Shutdown::new().grace_period(BACKEND_GRACE)
}

/// Start a libunftp server in PROXY protocol mode on a free loopback port for
/// one session, and connect the relay to it.
///
/// The relay binds the loopback listener and hands it to libunftp (a fork
/// delta, #4100), so no other process can take the port in between, and the
/// relay's first connection waits in the listen backlog until libunftp
/// accepts it. libunftp serves only connections the [`BackendDialer`] opened.
pub(super) async fn start_backend(
    config: &EmbeddedServerConfig,
    stats: &Arc<AtomicServerStats>,
    throttle: &Arc<LoginThrottle>,
    client: IpAddr,
    public_port: u16,
    shutdown: &ShutdownSignal,
) -> Result<Backend> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .context("Failed to bind a loopback listener for libunftp")?;
    let addr = listener
        .local_addr()
        .context("Failed to read the libunftp listener address")?;
    let dialer = BackendDialer::new(addr, Arc::clone(&stats.activity));
    let stop = CancellationToken::new();
    let server = server_builder(config, stats, throttle, client)
        .passive_ports(reserved_passive_range(public_port))
        .proxy_protocol_mode(public_port)
        .proxy_protocol_peer_filter(dialer.peer_filter())
        .shutdown_indicator(shutdown_indicator(shutdown.clone(), stop.clone()))
        .build()
        .context("Failed to build libunftp server")?;
    let task = tokio::spawn(server.listen_with_listener(listener));
    match dialer.connect().await {
        Ok(upstream) => Ok(Backend {
            upstream,
            dialer,
            task,
            stop,
        }),
        Err(e) => {
            stop.cancel();
            task.abort();
            Err(anyhow::Error::new(e).context("Failed to connect the relay to libunftp"))
        }
    }
}

/// Per-session relay settings [`serve_session`] passes to the relay.
#[derive(Debug, Clone, Copy)]
pub(super) struct RelayParams {
    /// The public control port (libunftp's `external_control_port`).
    pub public_port: u16,
    /// How long the client has to log in (#4398).
    pub prelogin_timeout: Duration,
}

/// Serve one accepted control connection: start its libunftp backend and relay
/// to it until the connection ends, then shut the backend down.
pub(super) async fn serve_session(
    config: Arc<EmbeddedServerConfig>,
    stats: Arc<AtomicServerStats>,
    throttle: Arc<LoginThrottle>,
    client: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    relay: RelayParams,
    shutdown: ShutdownSignal,
) {
    let RelayParams {
        public_port,
        prelogin_timeout,
    } = relay;
    let backend = match start_backend(
        &config,
        &stats,
        &throttle,
        peer.ip(),
        public_port,
        &shutdown,
    )
    .await
    {
        Ok(backend) => backend,
        Err(e) => {
            tracing::warn!(%peer, error = %e, "FTP session backend failed; dropping connection");
            return;
        }
    };
    let Backend {
        upstream,
        dialer,
        task,
        stop,
    } = backend;
    let session = RelaySession {
        client,
        peer,
        upstream,
        dialer,
        public_port,
        passive_ports: PASSIVE_PORTS,
        activity: Arc::clone(&stats.activity),
        prelogin_timeout,
    };
    if let Err(e) = session.run().await {
        tracing::debug!(%peer, error = %e, "FTP control relay ended with an error");
    }
    stop.cancel();
    match tokio::time::timeout(BACKEND_GRACE * 2, task).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(e))) => tracing::debug!(%peer, error = ?e, "FTP session backend stopped"),
        Ok(Err(e)) => tracing::debug!(%peer, error = %e, "FTP session backend task failed"),
        Err(_) => tracing::warn!(%peer, "FTP session backend did not stop in time"),
    }
}

// ─── Session user ─────────────────────────────────────────────────────────────

/// The authenticated FTP session user: the login name and the client address,
/// carried into every storage call so file operations can be attributed in the
/// access log (PROD-034). Deliberately holds no password.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FtpUser {
    username: String,
    client: IpAddr,
}

impl Display for FtpUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.username)
    }
}

impl UserDetail for FtpUser {}

/// Turns the authenticated [`Principal`] into the session [`FtpUser`]. One
/// provider is built per control connection, so it knows that connection's
/// client address (libunftp 0.22 split user-detail lookup out of
/// [`Authenticator`], which now only returns the login name).
#[derive(Debug)]
struct FtpUserProvider {
    client: IpAddr,
}

#[async_trait]
impl UserDetailProvider for FtpUserProvider {
    type User = FtpUser;

    async fn provide_user_detail(&self, principal: &Principal) -> Result<FtpUser, UserDetailError> {
        Ok(FtpUser {
            username: principal.username.clone(),
            client: self.client,
        })
    }
}

// ─── Storage backend: optional read-only wrapper + access log ─────────────────

/// Wraps `Filesystem`, optionally rejects all write operations, and records
/// every file operation in the access log.
///
/// `inner` holds the error when the root directory could not be opened (since
/// unftp-sbe-fs 0.3 `Filesystem::new` is fallible instead of panicking); the
/// session then fails `enter` and every storage call with that error.
#[derive(Debug)]
struct MaybeReadOnlyFilesystem {
    inner: io::Result<Filesystem>,
    read_only: bool,
    activity: Arc<ServerActivity>,
}

/// Short status token for a storage result.
fn storage_status(err: &unftp_core::storage::Error) -> &'static str {
    match err.kind() {
        StorageErrorKind::PermissionDenied => "denied",
        StorageErrorKind::PermanentFileNotAvailable
        | StorageErrorKind::TransientFileNotAvailable => "not found",
        _ => "error",
    }
}

impl MaybeReadOnlyFilesystem {
    /// The opened root filesystem, or a local error if it could not be opened.
    fn fs(&self) -> unftp_core::storage::Result<&Filesystem> {
        self.inner.as_ref().map_err(|e| {
            unftp_core::storage::Error::new(
                StorageErrorKind::LocalError,
                format!("FTP root directory unavailable: {e}"),
            )
        })
    }

    /// Start an access-log record for `command` on `path` by `user`.
    fn record_for(
        user: &FtpUser,
        command: &str,
        path: &Path,
        status: &str,
        ok: bool,
    ) -> AccessRecord {
        AccessRecord::new(command, status, ok)
            .client(user.client)
            .user(user.username.clone())
            .path(path.to_string_lossy().into_owned())
    }

    /// Record the outcome of a non-transfer command.
    fn log_result<T>(
        &self,
        user: &FtpUser,
        command: &str,
        path: &Path,
        started: Instant,
        result: &unftp_core::storage::Result<T>,
    ) {
        let record = match result {
            Ok(_) => Self::record_for(user, command, path, "ok", true),
            Err(e) => Self::record_for(user, command, path, storage_status(e), false)
                .detail(e.to_string()),
        };
        self.activity.record(record.elapsed_since(started));
    }

    /// Reject a write in read-only mode, recording the denied attempt.
    fn deny_if_read_only(
        &self,
        user: &FtpUser,
        command: &str,
        path: &Path,
    ) -> unftp_core::storage::Result<()> {
        if self.read_only {
            self.activity.record(
                Self::record_for(user, command, path, "denied", false)
                    .detail("server is read-only"),
            );
            return Err(StorageErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
}

#[async_trait]
impl StorageBackend<FtpUser> for MaybeReadOnlyFilesystem {
    type Metadata = unftp_sbe_fs::Meta;

    fn enter(&mut self, user_detail: &FtpUser) -> io::Result<()> {
        match &mut self.inner {
            Ok(fs) => StorageBackend::<FtpUser>::enter(fs, user_detail),
            Err(e) => Err(io::Error::new(
                e.kind(),
                format!("FTP root directory unavailable: {e}"),
            )),
        }
    }

    async fn metadata<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> unftp_core::storage::Result<Self::Metadata> {
        self.fs()?.metadata(user, path).await
    }

    async fn list<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> unftp_core::storage::Result<Vec<Fileinfo<PathBuf, Self::Metadata>>> {
        let started = Instant::now();
        let logged = path.as_ref().to_path_buf();
        let result = self.fs()?.list(user, path).await;
        self.log_result(user, "LIST", &logged, started, &result);
        result
    }

    async fn get<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
        start_pos: u64,
    ) -> unftp_core::storage::Result<Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin>> {
        let started = Instant::now();
        let logged = path.as_ref().to_path_buf();
        match self.fs()?.get(user, path, start_pos).await {
            Ok(reader) => {
                // The RETR entry is written when the download reader finishes
                // (or is dropped mid-transfer), with the real byte count.
                let transfer = self.activity.begin_transfer(
                    "RETR",
                    Some(user.client),
                    Some(&logged.to_string_lossy()),
                );
                Ok(Box::new(TransferReader {
                    inner: reader,
                    transfer,
                    eof: false,
                    on_done: Some(RetrDone {
                        activity: Arc::clone(&self.activity),
                        record: Self::record_for(user, "RETR", &logged, "ok", true),
                        started,
                    }),
                }))
            }
            Err(e) => {
                self.activity.record(
                    Self::record_for(user, "RETR", &logged, storage_status(&e), false)
                        .detail(e.to_string())
                        .elapsed_since(started),
                );
                Err(e)
            }
        }
    }

    async fn put<
        P: AsRef<Path> + Send + Debug,
        R: tokio::io::AsyncRead + Send + Sync + Unpin + 'static,
    >(
        &self,
        user: &FtpUser,
        input: R,
        path: P,
        start_pos: u64,
    ) -> unftp_core::storage::Result<u64> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "STOR", &logged)?;
        let started = Instant::now();
        // The upload is listed as a current transfer for as long as its input
        // reader is alive, with live byte progress.
        let input = TransferReader {
            inner: input,
            transfer: self.activity.begin_transfer(
                "STOR",
                Some(user.client),
                Some(&logged.to_string_lossy()),
            ),
            eof: false,
            on_done: None,
        };
        let result = self.fs()?.put(user, input, path, start_pos).await;
        let record = match &result {
            Ok(bytes) => Self::record_for(user, "STOR", &logged, "ok", true).bytes(*bytes),
            Err(e) => Self::record_for(user, "STOR", &logged, storage_status(e), false)
                .detail(e.to_string()),
        };
        self.activity.record(record.elapsed_since(started));
        result
    }

    async fn del<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "DELE", &logged)?;
        let started = Instant::now();
        let result = self.fs()?.del(user, path).await;
        self.log_result(user, "DELE", &logged, started, &result);
        result
    }

    async fn mkd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "MKD", &logged)?;
        let started = Instant::now();
        let result = self.fs()?.mkd(user, path).await;
        self.log_result(user, "MKD", &logged, started, &result);
        result
    }

    async fn rename<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        from: P,
        to: P,
    ) -> unftp_core::storage::Result<()> {
        let logged = from.as_ref().to_path_buf();
        self.deny_if_read_only(user, "RNFR", &logged)?;
        let started = Instant::now();
        let result = self.fs()?.rename(user, from, to).await;
        self.log_result(user, "RNFR", &logged, started, &result);
        result
    }

    async fn rmd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "RMD", &logged)?;
        let started = Instant::now();
        let result = self.fs()?.rmd(user, path).await;
        self.log_result(user, "RMD", &logged, started, &result);
        result
    }

    async fn cwd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        self.fs()?.cwd(user, path).await
    }
}

/// Deferred RETR log entry, written when the download reader is done.
struct RetrDone {
    activity: Arc<ServerActivity>,
    record: AccessRecord,
    started: Instant,
}

/// `AsyncRead` wrapper that feeds byte progress into a [`TransferGuard`] and,
/// for downloads, records the access-log entry when the reader hits EOF or is
/// dropped (an early drop means the transfer was aborted).
struct TransferReader<R> {
    inner: R,
    transfer: TransferGuard,
    eof: bool,
    on_done: Option<RetrDone>,
}

impl<R: AsyncRead + Unpin> AsyncRead for TransferReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &polled {
            let n = buf.filled().len() - before;
            if n == 0 {
                self.eof = true;
            } else {
                self.transfer.add_bytes(n as u64);
            }
        }
        polled
    }
}

impl<R> Drop for TransferReader<R> {
    fn drop(&mut self) {
        if let Some(done) = self.on_done.take() {
            let bytes = self.transfer.bytes();
            let record = if self.eof {
                done.record
            } else {
                done.record.outcome("aborted", false)
            };
            done.activity
                .record(record.bytes(bytes).elapsed_since(done.started));
        }
    }
}

// ─── Authentication ───────────────────────────────────────────────────────────

#[derive(Debug)]
struct FtpAuthenticator {
    auth: Option<FtpAuth>,
    /// Every login attempt is recorded (client IP + username, never the
    /// password) in the server's access log (PROD-034).
    activity: Arc<ServerActivity>,
    /// The session's real client address. One authenticator is built per
    /// session: behind the relay, `Credentials::source_ip` is the relay's
    /// loopback address, not the client's (#3996).
    client: IpAddr,
    /// The server-wide failed-login throttle, shared by every session
    /// (CORE2-003, #4292).
    throttle: Arc<LoginThrottle>,
}

/// The outcome of one login attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoginOutcome {
    Accepted,
    Denied,
    /// The client is locked out; its credentials were not checked.
    Throttled,
}

impl FtpAuthenticator {
    fn new(
        auth: Option<FtpAuth>,
        activity: Arc<ServerActivity>,
        client: IpAddr,
        throttle: Arc<LoginThrottle>,
    ) -> Self {
        Self {
            auth,
            activity,
            client,
            throttle,
        }
    }

    /// Decide whether `username` / `creds` may log in, and update the throttle.
    fn check(&self, username: &str, creds: &Credentials) -> LoginOutcome {
        let Some(FtpAuth::Credentials {
            username: expected_user,
            password: expected_pass,
        }) = &self.auth
        else {
            return LoginOutcome::Accepted;
        };
        if self.throttle.is_locked(self.client) {
            return LoginOutcome::Throttled;
        }
        let ok = credentials_match(
            username,
            creds.password.as_deref(),
            expected_user,
            expected_pass,
        );
        if bool::from(ok) {
            self.throttle.record_success(self.client);
            LoginOutcome::Accepted
        } else {
            self.throttle.record_failure(self.client);
            LoginOutcome::Denied
        }
    }
}

/// Constant-time check of a login against the configured credentials.
///
/// Both the username and the password go through [`secret_eq`], and the two
/// results are combined with `&` rather than `&&`, so neither a wrong username
/// nor a wrong password (nor a missing one) is distinguishable by timing.
fn credentials_match(
    username: &str,
    password: Option<&str>,
    expected_user: &str,
    expected_pass: &str,
) -> subtle::Choice {
    let user_ok = secret_eq(username.as_bytes(), expected_user.as_bytes());
    let pass_ok = secret_eq(
        password.unwrap_or_default().as_bytes(),
        expected_pass.as_bytes(),
    );
    user_ok & pass_ok & subtle::Choice::from(u8::from(password.is_some()))
}

#[async_trait]
impl Authenticator for FtpAuthenticator {
    async fn authenticate(
        &self,
        username: &str,
        creds: &Credentials,
    ) -> Result<Principal, AuthenticationError> {
        let outcome = self.check(username, creds);
        let ok = outcome == LoginOutcome::Accepted;
        // Only the login name and client address are logged — the password in
        // `creds` is never copied into the record.
        let (status, detail) = match outcome {
            LoginOutcome::Accepted => ("ok", None),
            LoginOutcome::Denied => ("denied", Some("bad username or password")),
            LoginOutcome::Throttled => ("throttled", Some("too many failed logins")),
        };
        let mut record = AccessRecord::new("LOGIN", status, ok)
            .client(self.client)
            .user(username);
        if let Some(detail) = detail {
            record = record.detail(detail);
        }
        self.activity.record(record);

        if ok {
            Ok(Principal {
                username: username.to_string(),
            })
        } else {
            Err(AuthenticationError::BadPassword)
        }
    }
}

// ─── Stats tracking ───────────────────────────────────────────────────────────

#[derive(Debug)]
struct StatsTracker {
    stats: Arc<AtomicServerStats>,
}

#[async_trait]
impl DataListener for StatsTracker {
    async fn receive_data_event(&self, e: DataEvent, _m: EventMeta) {
        match e {
            DataEvent::Got { bytes, .. } => {
                self.stats.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
            }
            DataEvent::Put { bytes, .. } => {
                self.stats
                    .bytes_received
                    .fetch_add(bytes, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

#[async_trait]
impl PresenceListener for StatsTracker {
    async fn receive_presence_event(&self, e: PresenceEvent, m: EventMeta) {
        match e {
            PresenceEvent::LoggedIn => {
                self.stats
                    .active_connections
                    .fetch_add(1, Ordering::Relaxed);
                self.stats.total_connections.fetch_add(1, Ordering::Relaxed);
            }
            PresenceEvent::LoggedOut => {
                self.stats
                    .active_connections
                    .fetch_sub(1, Ordering::Relaxed);
                // The login itself is recorded by the authenticator (which
                // knows the client IP); the logout closes the session.
                self.stats
                    .activity
                    .record(AccessRecord::new("LOGOUT", "ok", true).user(m.username));
            }
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod relay_tests;

#[cfg(test)]
mod auth_tests;

#[cfg(test)]
mod limits_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedded_servers::config::AtomicServerStats;

    // ── Event-driven shutdown (WA-RS-001 / #2782) ─────────────────────────────

    pub(super) fn ftp_test_config(root: &Path) -> EmbeddedServerConfig {
        use crate::embedded_servers::config::ServerType;
        EmbeddedServerConfig {
            id: "test-ftp-shutdown".to_string(),
            name: "test".to_string(),
            server_type: ServerType::Ftp,
            root_directory: root.to_string_lossy().into_owned(),
            bind_host: "127.0.0.1".to_string(),
            port: 0, // ephemeral — the tests only need a confirmed bind
            auto_start: false,
            read_only: false,
            directory_listing: None,
            ftp_auth: None,
            http_auth: None,
            max_transfer_bytes: None,
            max_concurrent_sessions: None,
            extra: Default::default(),
        }
    }

    /// The server must observe shutdown without any timer firing: under a paused
    /// tokio clock, a fixed-interval poll (the old 50 ms `poll_shutdown`) would
    /// have to auto-advance virtual time before it noticed the flag, whereas the
    /// event-driven `ShutdownSignal::wait` wakes with the clock standing still.
    /// Deterministic — no wall-clock bound, so no CI-jitter flake.
    #[tokio::test(start_paused = true)]
    async fn shutdown_is_observed_without_a_timer_tick() {
        use crate::embedded_servers::service::BindSignal;

        let dir = tempfile::tempdir().expect("temp dir");
        let config = ftp_test_config(dir.path());
        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();

        let server = run_ftp_server(&config, shutdown.clone(), AtomicServerStats::new(), ready);
        tokio::pin!(server);

        // Drive the server (without idling, so the paused clock never advances)
        // until it confirms its bind, then a little longer so it parks in its
        // listen/shutdown `select!`.
        let mut bound = false;
        let mut polls_after_bind = 0;
        for _ in 0..1_000_000 {
            tokio::select! {
                biased;
                res = &mut server => panic!("server exited before shutdown: {res:?}"),
                _ = tokio::task::yield_now() => {}
            }
            if bound {
                polls_after_bind += 1;
                if polls_after_bind >= 50 {
                    break;
                }
            } else if let Ok(bind) = ready_rx.try_recv() {
                assert!(bind.is_ok(), "bind should succeed, got {bind:?}");
                bound = true;
            }
        }
        assert!(bound, "server never confirmed its bind");

        let start = tokio::time::Instant::now();
        shutdown.trigger();
        let result = server.await;
        assert!(result.is_ok(), "server exited with error: {result:?}");
        assert_eq!(
            tokio::time::Instant::now() - start,
            std::time::Duration::ZERO,
            "shutdown must be event-driven, not observed by a timed poll"
        );
    }

    /// End-to-end: a real FTP server thread stops cleanly once the signal fires.
    /// The generous bound only guards against a hang; promptness itself is
    /// asserted deterministically above.
    #[test]
    fn shutdown_signal_stops_server_thread_promptly() {
        use crate::embedded_servers::service::BindSignal;
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("temp dir");
        let config = ftp_test_config(dir.path());
        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();

        let server_shutdown = shutdown.clone();
        let handle = std::thread::spawn(move || {
            start_ftp_server(&config, server_shutdown, AtomicServerStats::new(), ready)
        });

        let bind = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server should confirm its bind");
        assert!(bind.is_ok(), "bind should succeed, got {bind:?}");

        let start = Instant::now();
        shutdown.trigger();
        let result = handle.join().expect("server thread should not panic");
        assert!(result.is_ok(), "server exited with error: {result:?}");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "server did not stop promptly after the shutdown signal ({:?})",
            start.elapsed()
        );
    }

    // ── Bound-port reporting (#3549) ──────────────────────────────────────────

    /// Start a real FTP server thread for `config` and wait for its bind
    /// confirmation. Returns the confirmed address, the shutdown signal and the
    /// thread handle.
    fn start_confirmed(
        config: EmbeddedServerConfig,
    ) -> (
        Option<std::net::SocketAddr>,
        ShutdownSignal,
        std::thread::JoinHandle<Result<()>>,
    ) {
        use crate::embedded_servers::service::BindSignal;
        use std::time::Duration;

        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();
        let server_shutdown = shutdown.clone();
        let handle = std::thread::spawn(move || {
            start_ftp_server(&config, server_shutdown, AtomicServerStats::new(), ready)
        });
        let bind = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server should confirm its bind")
            .expect("bind should succeed");
        (bind, shutdown, handle)
    }

    /// A port-0 config must confirm the OS-assigned port the server actually
    /// serves on, and a client connecting to it must get the FTP greeting.
    #[test]
    fn port_zero_confirms_real_bound_port_and_serves_on_it() {
        use std::io::{BufRead, BufReader};
        use std::time::Duration;

        let dir = tempfile::tempdir().expect("temp dir");
        let (addr, shutdown, handle) = start_confirmed(ftp_test_config(dir.path()));

        let addr = addr.expect("FTP must report its real bound address");
        assert_ne!(addr.port(), 0, "reported port must be the OS-assigned one");
        assert!(
            addr.ip().is_loopback(),
            "bound to the configured host: {addr}"
        );

        let stream = std::net::TcpStream::connect(addr).expect("connect to reported port");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut greeting = String::new();
        BufReader::new(stream)
            .read_line(&mut greeting)
            .expect("read greeting");
        assert!(
            greeting.starts_with("220"),
            "expected FTP greeting on the reported port, got {greeting:?}"
        );

        shutdown.trigger();
        handle.join().expect("no panic").expect("clean exit");
    }

    /// No TOCTOU window: at the moment the bind is confirmed, the server already
    /// owns the socket, so a competing bind of the same address must fail.
    #[test]
    fn confirmed_port_is_already_held_by_the_server() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (addr, shutdown, handle) = start_confirmed(ftp_test_config(dir.path()));
        let addr = addr.expect("FTP must report its real bound address");

        let competitor = std::net::TcpListener::bind(addr);
        assert!(
            competitor.is_err(),
            "the confirmed port {addr} must already be held by the FTP server"
        );

        shutdown.trigger();
        handle.join().expect("no panic").expect("clean exit");
    }

    /// Concurrent starts on the same fixed port: exactly one may confirm, the
    /// other must fail its bind rather than report a server it never serves.
    #[test]
    fn concurrent_starts_on_same_port_confirm_at_most_one() {
        use crate::embedded_servers::service::BindSignal;
        use std::time::Duration;

        // Reserve a concrete port number, then release it for the race.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();

        let dir = tempfile::tempdir().expect("temp dir");
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut runs = Vec::new();
        for _ in 0..2 {
            let mut config = ftp_test_config(dir.path());
            config.port = port;
            let shutdown = ShutdownSignal::new();
            let (ready, ready_rx) = BindSignal::for_test();
            let server_shutdown = shutdown.clone();
            let barrier = Arc::clone(&barrier);
            let handle = std::thread::spawn(move || {
                barrier.wait();
                start_ftp_server(&config, server_shutdown, AtomicServerStats::new(), ready)
            });
            runs.push((shutdown, ready_rx, handle));
        }

        let outcomes: Vec<_> = runs
            .iter()
            .map(|(_, rx, _)| rx.recv_timeout(Duration::from_secs(5)).expect("signal"))
            .collect();
        let confirmed = outcomes.iter().filter(|o| o.is_ok()).count();
        assert!(
            confirmed <= 1,
            "two servers confirmed the same port {port}: {outcomes:?}"
        );
        for outcome in outcomes.iter().flatten() {
            assert_eq!(
                outcome.map(|a| a.port()),
                Some(port),
                "a confirmed server must report the port it serves on"
            );
        }

        for (shutdown, _, handle) in runs {
            shutdown.trigger();
            let _ = handle.join().expect("no panic");
        }
    }

    // ── FtpAuthenticator ──────────────────────────────────────────────────────

    /// An authenticator recording into a fresh, throwaway activity log.
    fn authn(auth: Option<FtpAuth>) -> FtpAuthenticator {
        FtpAuthenticator::new(
            auth,
            ServerActivity::new(),
            "127.0.0.1".parse().expect("ip"),
            Arc::new(LoginThrottle::new()),
        )
    }

    fn creds(password: Option<&str>) -> Credentials {
        Credentials {
            password: password.map(str::to_owned),
            certificate_chain: None,
            source_ip: "127.0.0.1".parse().unwrap(),
            command_channel_security: unftp_core::auth::ChannelEncryptionState::Plaintext,
        }
    }

    #[tokio::test]
    async fn auth_no_config_allows_any() {
        let auth = authn(None);
        assert!(auth.authenticate("anyone", &creds(None)).await.is_ok());
        assert!(auth
            .authenticate("anyone", &creds(Some("anything")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn auth_anonymous_allows_any() {
        let auth = authn(Some(FtpAuth::Anonymous));
        assert!(auth.authenticate("anonymous", &creds(None)).await.is_ok());
        assert!(auth.authenticate("bob", &creds(Some("pass"))).await.is_ok());
    }

    #[tokio::test]
    async fn auth_credentials_correct_pass() {
        let auth = authn(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(auth
            .authenticate("alice", &creds(Some("secret")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn auth_credentials_wrong_pass() {
        let auth = authn(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(matches!(
            auth.authenticate("alice", &creds(Some("wrong")))
                .await
                .unwrap_err(),
            AuthenticationError::BadPassword
        ));
    }

    #[tokio::test]
    async fn auth_credentials_wrong_user() {
        let auth = authn(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(matches!(
            auth.authenticate("eve", &creds(Some("secret")))
                .await
                .unwrap_err(),
            AuthenticationError::BadPassword
        ));
    }

    #[tokio::test]
    async fn auth_credentials_no_password() {
        let auth = authn(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(matches!(
            auth.authenticate("alice", &creds(None)).await.unwrap_err(),
            AuthenticationError::BadPassword
        ));
    }

    // ── libunftp 0.23 adaptation (#3975) ──────────────────────────────────────

    #[tokio::test]
    async fn authenticator_returns_principal_with_login_name() {
        let principal = authn(None)
            .authenticate("alice", &creds(None))
            .await
            .expect("accepted");
        assert_eq!(principal.username, "alice");
    }

    #[tokio::test]
    async fn user_provider_attaches_connection_client_address() {
        let client: IpAddr = "198.51.100.4".parse().expect("ip");
        let user = FtpUserProvider { client }
            .provide_user_detail(&Principal {
                username: "bob".to_string(),
            })
            .await
            .expect("user");
        assert_eq!(
            user,
            FtpUser {
                username: "bob".to_string(),
                client,
            }
        );
    }

    #[test]
    fn passive_ports_keep_the_former_exclusive_span() {
        // libunftp 0.21 made `passive_ports` inclusive; 0.20 used `49152..65535`.
        assert_eq!(PASSIVE_PORTS, 49152..=65534);
    }

    #[tokio::test]
    async fn missing_root_fails_the_session_instead_of_panicking() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");
        let activity = ServerActivity::new();
        let mut storage = fs(&missing, false, &activity);
        let user = ftp_user("alice");
        assert!(StorageBackend::<FtpUser>::enter(&mut storage, &user).is_err());
        match storage.list(&user, "/").await {
            Err(err) => assert_eq!(err.kind(), StorageErrorKind::LocalError),
            Ok(_) => panic!("listing a missing root must fail"),
        }
    }

    /// Read one (possibly multi-line) FTP reply from the control channel.
    pub(super) fn read_reply(reader: &mut impl std::io::BufRead) -> String {
        let mut first = String::new();
        reader.read_line(&mut first).expect("reply line");
        if first.as_bytes().get(3) == Some(&b'-') {
            let end = format!("{} ", &first[..3]);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).expect("reply continuation");
                if line.starts_with(&end) || line.is_empty() {
                    break;
                }
            }
        }
        first
    }

    /// End to end through libunftp 0.23 over a real socket: credential login,
    /// a passive-mode download from the configured root, and the access log
    /// attributing the transfer to the user and client address that the
    /// per-connection user-detail provider attached (#3975).
    #[test]
    fn credential_login_passive_retr_is_served_and_attributed() {
        use crate::embedded_servers::service::BindSignal;
        use std::io::{BufReader, Read, Write};
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("hello.txt"), b"hello over ftp").expect("seed file");
        let mut config = ftp_test_config(dir.path());
        config.ftp_auth = Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        });
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();
        let (server_stats, server_shutdown) = (Arc::clone(&stats), shutdown.clone());
        let handle = std::thread::spawn(move || {
            start_ftp_server(&config, server_shutdown, server_stats, ready)
        });
        let addr = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("bind confirmation")
            .expect("bind ok")
            .expect("bound address");

        let control = std::net::TcpStream::connect(addr).expect("connect");
        control
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("read timeout");
        let mut writer = control.try_clone().expect("clone control");
        let mut reader = BufReader::new(control);
        let mut cmd = |line: &str, reader: &mut BufReader<std::net::TcpStream>| {
            writer
                .write_all(format!("{line}\r\n").as_bytes())
                .expect("send command");
            read_reply(reader)
        };

        assert!(read_reply(&mut reader).starts_with("220"));
        assert!(cmd("USER alice", &mut reader).starts_with("331"));
        assert!(cmd("PASS wrong", &mut reader).starts_with("530"));
        assert!(cmd("USER alice", &mut reader).starts_with("331"));
        assert!(cmd("PASS secret", &mut reader).starts_with("230"));
        assert!(cmd("TYPE I", &mut reader).starts_with("200"));

        let pasv = cmd("PASV", &mut reader);
        assert!(pasv.starts_with("227"), "{pasv}");
        let nums: Vec<u16> = pasv[pasv.find('(').expect("(") + 1..pasv.find(')').expect(")")]
            .split(',')
            .map(|n| n.trim().parse().expect("pasv number"))
            .collect();
        let data_port = nums[4] * 256 + nums[5];
        assert!(
            PASSIVE_PORTS.contains(&data_port),
            "passive port {data_port}"
        );

        let mut data = std::net::TcpStream::connect((addr.ip(), data_port)).expect("data conn");
        let retr = cmd("RETR hello.txt", &mut reader);
        assert!(retr.starts_with("150") || retr.starts_with("125"), "{retr}");
        let mut body = Vec::new();
        data.read_to_end(&mut body).expect("download");
        assert_eq!(body, b"hello over ftp");
        assert!(read_reply(&mut reader).starts_with("226"));
        let _ = cmd("QUIT", &mut reader);

        // The RETR entry is written when the download reader is dropped.
        let deadline = Instant::now() + Duration::from_secs(5);
        let log = loop {
            let log = entries(&stats.activity);
            if log.iter().any(|e| e.method == "RETR") || Instant::now() > deadline {
                break log;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let client = Some(addr.ip().to_string());
        let logins: Vec<_> = log.iter().filter(|e| e.method == "LOGIN").collect();
        assert_eq!(logins.len(), 2, "{log:?}");
        assert!(logins
            .iter()
            .all(|e| e.user.as_deref() == Some("alice") && e.client == client));
        let retr = log
            .iter()
            .find(|e| e.method == "RETR")
            .expect("RETR logged");
        assert_eq!(retr.user.as_deref(), Some("alice"));
        assert_eq!(retr.client, client);
        assert_eq!(retr.status, "ok");

        shutdown.trigger();
        handle.join().expect("no panic").expect("clean exit");
    }

    // ── Access log (PROD-034) ────────────────────────────────────────────────

    fn ftp_user(name: &str) -> FtpUser {
        FtpUser {
            username: name.to_string(),
            client: "192.0.2.7".parse().expect("ip"),
        }
    }

    fn fs(root: &Path, read_only: bool, activity: &Arc<ServerActivity>) -> MaybeReadOnlyFilesystem {
        MaybeReadOnlyFilesystem {
            inner: Filesystem::new(root.to_path_buf()),
            read_only,
            activity: Arc::clone(activity),
        }
    }

    pub(super) fn entries(
        activity: &ServerActivity,
    ) -> Vec<crate::embedded_servers::activity::AccessLogEntry> {
        activity
            .snapshot(
                None,
                &crate::embedded_servers::config::ServerStats::default(),
            )
            .entries
    }

    #[tokio::test]
    async fn login_is_logged_with_user_and_client_but_never_password() {
        let activity = ServerActivity::new();
        let auth = FtpAuthenticator::new(
            Some(FtpAuth::Credentials {
                username: "alice".to_string(),
                password: "hunter2-secret".to_string(),
            }),
            Arc::clone(&activity),
            "127.0.0.1".parse().expect("ip"),
            Arc::new(LoginThrottle::new()),
        );
        assert!(auth
            .authenticate("alice", &creds(Some("hunter2-secret")))
            .await
            .is_ok());
        assert!(auth
            .authenticate("alice", &creds(Some("wrong-secret")))
            .await
            .is_err());

        let log = entries(&activity);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].method, "LOGIN");
        assert_eq!(log[0].user.as_deref(), Some("alice"));
        assert_eq!(log[0].client.as_deref(), Some("127.0.0.1"));
        assert!(log[0].success);
        assert_eq!(log[1].status, "denied");
        assert!(!log[1].success);
        let json = serde_json::to_string(&log).expect("serialize");
        assert!(!json.contains("hunter2"), "password leaked: {json}");
        assert!(
            !json.contains("wrong-secret"),
            "attempted password leaked: {json}"
        );
    }

    #[tokio::test]
    async fn retr_is_logged_with_bytes_when_download_completes() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("fw.bin"), b"0123456789").expect("write");
        let activity = ServerActivity::new();
        let backend = fs(dir.path(), true, &activity);
        let user = ftp_user("bob");

        let mut reader = backend.get(&user, "fw.bin", 0).await.expect("get");
        // While the reader is alive, the download is a current transfer.
        let live = activity.snapshot(None, &Default::default());
        assert_eq!(live.stats.current_transfers.len(), 1);
        assert_eq!(live.stats.current_transfers[0].method, "RETR");

        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).await.expect("read");
        drop(reader);

        let log = entries(&activity);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].method, "RETR");
        assert_eq!(log[0].status, "ok");
        assert_eq!(log[0].bytes, 10);
        assert_eq!(log[0].user.as_deref(), Some("bob"));
        assert_eq!(log[0].client.as_deref(), Some("192.0.2.7"));
        let after = activity.snapshot(None, &Default::default());
        assert!(after.stats.current_transfers.is_empty());
    }

    #[tokio::test]
    async fn retr_dropped_early_is_logged_as_aborted() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("fw.bin"), b"0123456789").expect("write");
        let activity = ServerActivity::new();
        let backend = fs(dir.path(), true, &activity);
        let reader = backend
            .get(&ftp_user("bob"), "fw.bin", 0)
            .await
            .expect("get");
        drop(reader);
        let log = entries(&activity);
        assert_eq!(log[0].status, "aborted");
        assert!(!log[0].success);
    }

    #[tokio::test]
    async fn retr_of_missing_file_is_logged_as_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let activity = ServerActivity::new();
        let backend = fs(dir.path(), true, &activity);
        assert!(backend.get(&ftp_user("bob"), "nope.bin", 0).await.is_err());
        let log = entries(&activity);
        assert_eq!(log[0].method, "RETR");
        assert!(!log[0].success);
    }

    #[tokio::test]
    async fn stor_is_logged_with_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let activity = ServerActivity::new();
        let backend = fs(dir.path(), false, &activity);
        let input = std::io::Cursor::new(b"uploaded!".to_vec());
        let written = backend
            .put(&ftp_user("carol"), input, "up.txt", 0)
            .await
            .expect("put");
        assert_eq!(written, 9);
        let log = entries(&activity);
        assert_eq!(log[0].method, "STOR");
        assert_eq!(log[0].status, "ok");
        assert_eq!(log[0].bytes, 9);
        assert!(activity
            .snapshot(None, &Default::default())
            .stats
            .current_transfers
            .is_empty());
    }

    #[tokio::test]
    async fn write_in_read_only_mode_is_logged_as_denied() {
        let dir = tempfile::tempdir().expect("temp dir");
        let activity = ServerActivity::new();
        let backend = fs(dir.path(), true, &activity);
        let input = std::io::Cursor::new(b"x".to_vec());
        assert!(backend
            .put(&ftp_user("carol"), input, "up.txt", 0)
            .await
            .is_err());
        assert!(backend.del(&ftp_user("carol"), "up.txt").await.is_err());
        let log = entries(&activity);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].method, "STOR");
        assert_eq!(log[0].status, "denied");
        assert_eq!(log[1].method, "DELE");
        assert_eq!(log[1].status, "denied");
    }

    #[tokio::test]
    async fn logout_is_logged() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };
        tracker
            .receive_presence_event(PresenceEvent::LoggedIn, meta())
            .await;
        tracker
            .receive_presence_event(PresenceEvent::LoggedOut, meta())
            .await;
        let log = entries(&stats.activity);
        assert_eq!(log.len(), 1, "login is logged by the authenticator only");
        assert_eq!(log[0].method, "LOGOUT");
        assert_eq!(log[0].user.as_deref(), Some("user"));
    }

    // ── StatsTracker ─────────────────────────────────────────────────────────

    fn meta() -> EventMeta {
        EventMeta {
            username: "user".into(),
            trace_id: "trace".into(),
            sequence_number: 0,
        }
    }

    #[tokio::test]
    async fn stats_login_logout() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };

        tracker
            .receive_presence_event(PresenceEvent::LoggedIn, meta())
            .await;
        tracker
            .receive_presence_event(PresenceEvent::LoggedIn, meta())
            .await;

        let snap = stats.snapshot();
        assert_eq!(snap.active_connections, 2);
        assert_eq!(snap.total_connections, 2);

        tracker
            .receive_presence_event(PresenceEvent::LoggedOut, meta())
            .await;
        assert_eq!(stats.active_connections.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn stats_data_bytes() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };

        tracker
            .receive_data_event(
                DataEvent::Got {
                    path: "file.txt".into(),
                    bytes: 1024,
                },
                meta(),
            )
            .await;
        tracker
            .receive_data_event(
                DataEvent::Put {
                    path: "upload.txt".into(),
                    bytes: 512,
                },
                meta(),
            )
            .await;

        let snap = stats.snapshot();
        assert_eq!(snap.bytes_sent, 1024);
        assert_eq!(snap.bytes_received, 512);
    }

    #[tokio::test]
    async fn stats_untracked_events_do_not_panic() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };
        // Should simply do nothing for non-byte events.
        tracker
            .receive_data_event(DataEvent::Deleted { path: "x".into() }, meta())
            .await;
        tracker
            .receive_data_event(
                DataEvent::Renamed {
                    from: "a".into(),
                    to: "b".into(),
                },
                meta(),
            )
            .await;
        let snap = stats.snapshot();
        assert_eq!(snap.bytes_sent, 0);
        assert_eq!(snap.bytes_received, 0);
    }
}
