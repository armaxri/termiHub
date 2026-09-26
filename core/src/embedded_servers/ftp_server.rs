//! FTP server powered by [`libunftp`].
//!
//! Replaces the former hand-rolled RFC 959 implementation with the actively
//! maintained [`libunftp`] crate backed by [`unftp_sbe_fs::Filesystem`].
//! Authentication and optional read-only mode are preserved.
//!
//! Every login attempt and file operation is recorded in the server's access
//! log (PROD-034) with the client IP and username — never the password.

use std::fmt::{self, Debug, Display};
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use anyhow::{Context, Result};
use async_trait::async_trait;
use libunftp::auth::{AuthenticationError, Authenticator, Credentials, UserDetail};
use libunftp::notification::{DataEvent, DataListener, EventMeta, PresenceEvent, PresenceListener};
use libunftp::storage::{ErrorKind as StorageErrorKind, Fileinfo, StorageBackend};
use libunftp::ServerBuilder;
use tokio::io::{AsyncRead, ReadBuf};
use unftp_sbe_fs::Filesystem;

use super::activity::{AccessRecord, ServerActivity, TransferGuard};
use super::config::{AtomicServerStats, EmbeddedServerConfig, FtpAuth};
use super::service::BindSignal;
use super::shutdown::ShutdownSignal;

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the FTP server in the current thread, blocking until `shutdown` fires.
///
/// Internally this creates a single-threaded tokio runtime so that the async
/// libunftp server can run inside the OS thread that the `EmbeddedServerManager`
/// already spawned. `ready` is signalled exactly once once the control port is
/// confirmed bindable (or if binding fails), so the manager only reports
/// `Running` after the bind is confirmed (GAP G3, #1145).
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

    rt.block_on(run_ftp_server(config, shutdown, stats, ready))
}

async fn run_ftp_server(
    config: &EmbeddedServerConfig,
    shutdown: ShutdownSignal,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let root: PathBuf = config.root_directory.clone().into();
    let addr = format!("{}:{}", config.bind_host, config.port);
    let read_only = config.read_only;

    let root_for_factory = root.clone();
    let activity = Arc::clone(&stats.activity);
    let activity_for_factory = Arc::clone(&activity);
    let server = match ServerBuilder::with_authenticator(
        Box::new(move || MaybeReadOnlyFilesystem {
            inner: Filesystem::new(root_for_factory.clone()),
            read_only,
            activity: Arc::clone(&activity_for_factory),
        }),
        Arc::new(FtpAuthenticator::new(config.ftp_auth.clone(), activity)),
    )
    .passive_ports(49152..65535)
    .greeting("termiHub FTP Server ready.")
    .notify_data(StatsTracker {
        stats: Arc::clone(&stats),
    })
    .notify_presence(StatsTracker {
        stats: Arc::clone(&stats),
    })
    .build()
    .context("Failed to build libunftp server")
    {
        Ok(server) => server,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    // libunftp binds the control port inside `listen`, with no bound-callback.
    // Probe-bind the control port ourselves so we can confirm (or fail) the
    // bind before reporting Running; drop the probe immediately so libunftp can
    // take the port (GAP G3, #1145).
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(probe) => {
            drop(probe);
            ready.confirm();
        }
        Err(e) => {
            let msg = format!("Failed to bind FTP server to {addr}: {e}");
            ready.fail(&msg);
            return Err(anyhow::anyhow!(msg));
        }
    }

    tracing::info!(addr, "FTP server listening (libunftp)");

    tokio::select! {
        result = server.listen(&addr) => {
            result.map_err(|e| anyhow::anyhow!("FTP server error: {e}"))?;
        }
        // Event-driven: park until the signal fires, then drop the listener at
        // once — no fixed-interval poll (WA-RS-001 / CORE-001).
        _ = shutdown.wait() => {
            tracing::info!("FTP server shutting down");
        }
    }

    Ok(())
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

// ─── Storage backend: optional read-only wrapper + access log ─────────────────

/// Wraps `Filesystem`, optionally rejects all write operations, and records
/// every file operation in the access log.
#[derive(Debug)]
struct MaybeReadOnlyFilesystem {
    inner: Filesystem,
    read_only: bool,
    activity: Arc<ServerActivity>,
}

/// Short status token for a storage result.
fn storage_status(err: &libunftp::storage::Error) -> &'static str {
    match err.kind() {
        StorageErrorKind::PermissionDenied => "denied",
        StorageErrorKind::PermanentFileNotAvailable
        | StorageErrorKind::TransientFileNotAvailable => "not found",
        _ => "error",
    }
}

impl MaybeReadOnlyFilesystem {
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
        result: &libunftp::storage::Result<T>,
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
    ) -> libunftp::storage::Result<()> {
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
        StorageBackend::<FtpUser>::enter(&mut self.inner, user_detail)
    }

    async fn metadata<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> libunftp::storage::Result<Self::Metadata> {
        self.inner.metadata(user, path).await
    }

    async fn list<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> libunftp::storage::Result<Vec<Fileinfo<PathBuf, Self::Metadata>>> {
        let started = Instant::now();
        let logged = path.as_ref().to_path_buf();
        let result = self.inner.list(user, path).await;
        self.log_result(user, "LIST", &logged, started, &result);
        result
    }

    async fn get<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
        start_pos: u64,
    ) -> libunftp::storage::Result<Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin>> {
        let started = Instant::now();
        let logged = path.as_ref().to_path_buf();
        match self.inner.get(user, path, start_pos).await {
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
    ) -> libunftp::storage::Result<u64> {
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
        let result = self.inner.put(user, input, path, start_pos).await;
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
    ) -> libunftp::storage::Result<()> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "DELE", &logged)?;
        let started = Instant::now();
        let result = self.inner.del(user, path).await;
        self.log_result(user, "DELE", &logged, started, &result);
        result
    }

    async fn mkd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> libunftp::storage::Result<()> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "MKD", &logged)?;
        let started = Instant::now();
        let result = self.inner.mkd(user, path).await;
        self.log_result(user, "MKD", &logged, started, &result);
        result
    }

    async fn rename<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        from: P,
        to: P,
    ) -> libunftp::storage::Result<()> {
        let logged = from.as_ref().to_path_buf();
        self.deny_if_read_only(user, "RNFR", &logged)?;
        let started = Instant::now();
        let result = self.inner.rename(user, from, to).await;
        self.log_result(user, "RNFR", &logged, started, &result);
        result
    }

    async fn rmd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> libunftp::storage::Result<()> {
        let logged = path.as_ref().to_path_buf();
        self.deny_if_read_only(user, "RMD", &logged)?;
        let started = Instant::now();
        let result = self.inner.rmd(user, path).await;
        self.log_result(user, "RMD", &logged, started, &result);
        result
    }

    async fn cwd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &FtpUser,
        path: P,
    ) -> libunftp::storage::Result<()> {
        self.inner.cwd(user, path).await
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
}

impl FtpAuthenticator {
    fn new(auth: Option<FtpAuth>, activity: Arc<ServerActivity>) -> Self {
        Self { auth, activity }
    }

    /// Decide whether `username` / `creds` may log in.
    fn accepts(&self, username: &str, creds: &Credentials) -> bool {
        match &self.auth {
            None | Some(FtpAuth::Anonymous) => true,
            Some(FtpAuth::Credentials {
                username: expected_user,
                password: expected_pass,
            }) => {
                let pass_ok = creds
                    .password
                    .as_deref()
                    .map(|pw| pw == expected_pass.as_str())
                    .unwrap_or(false);
                username == expected_user.as_str() && pass_ok
            }
        }
    }
}

#[async_trait]
impl Authenticator<FtpUser> for FtpAuthenticator {
    async fn authenticate(
        &self,
        username: &str,
        creds: &Credentials,
    ) -> Result<FtpUser, AuthenticationError> {
        let ok = self.accepts(username, creds);
        // Only the login name and client address are logged — the password in
        // `creds` is never copied into the record.
        let (status, detail) = if ok {
            ("ok", None)
        } else {
            ("denied", Some("bad username or password"))
        };
        let mut record = AccessRecord::new("LOGIN", status, ok)
            .client(creds.source_ip)
            .user(username);
        if let Some(detail) = detail {
            record = record.detail(detail);
        }
        self.activity.record(record);

        if ok {
            Ok(FtpUser {
                username: username.to_string(),
                client: creds.source_ip,
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
mod tests {
    use super::*;
    use crate::embedded_servers::config::AtomicServerStats;

    // ── Event-driven shutdown (WA-RS-001 / #2782) ─────────────────────────────

    fn ftp_test_config(root: &Path) -> EmbeddedServerConfig {
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

    // ── FtpAuthenticator ──────────────────────────────────────────────────────

    /// An authenticator recording into a fresh, throwaway activity log.
    fn authn(auth: Option<FtpAuth>) -> FtpAuthenticator {
        FtpAuthenticator::new(auth, ServerActivity::new())
    }

    fn creds(password: Option<&str>) -> Credentials {
        Credentials {
            password: password.map(str::to_owned),
            certificate_chain: None,
            source_ip: "127.0.0.1".parse().unwrap(),
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

    fn entries(
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
