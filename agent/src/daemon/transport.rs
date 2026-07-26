//! Transport abstraction for the session daemon.
//!
//! The persistent-session daemon and its agent-side client exchange
//! length-prefixed frames (see [`super::protocol`]) over a local IPC channel.
//! The cross-platform bind/accept/connect plumbing is delegated to the shared
//! [`termihub_core::ipc`] transport, so the same daemon logic runs over a
//! **Unix domain socket** on unix and a **Windows named pipe** on windows.
//!
//! Both transports are restricted to the current user via the core
//! [`ListenerSecurity::CurrentUserOnly`] policy: on unix a `0o700` socket
//! directory and socket file, on windows a per-pipe DACL that grants access
//! only to the current user's SID and `LocalSystem`. The daemon reclaims its
//! own per-session path on restart via [`StaleReclaim::Unconditional`], and the
//! client [`connect`] retries briefly while the daemon binds its endpoint
//! during slow cold-start.
//!
//! ```text
//!  bind() ──► DaemonListener ──► accept() ──► (BoxedReader, BoxedWriter)
//!  connect(endpoint) ─────────────────────► (BoxedReader, BoxedWriter)
//! ```
//!
//! The concrete socket/pipe types are erased behind [`BoxedReader`] and
//! [`BoxedWriter`] so the daemon event loop in [`super::process`] is fully
//! platform-independent. This module keeps only the daemon's **session-policy**
//! path helpers ([`session_endpoint`], [`endpoint_alive`], [`open_daemon_log`]);
//! the transport primitives live in [`termihub_core::ipc`].

use std::io;
use std::time::Duration;

/// Env var overriding the host-wide registry endpoint.
///
/// The registry endpoint is otherwise a fixed per-user path, which is exactly
/// what makes it a rendezvous — workers find it without being told. That also
/// means every agent of one user on one machine shares it, so tests (and
/// side-by-side development checkouts) need a way to opt into an isolated one
/// rather than fighting over the live socket. Mirrors the session daemon's
/// existing `TERMIHUB_SOCKET_PATH`. A worker that sets it also passes it to any
/// registry it spawns, via the inherited environment.
pub const REGISTRY_ENDPOINT_ENV: &str = "TERMIHUB_REGISTRY_ENDPOINT";

use termihub_core::ipc::{
    self, ListenerOptions, ListenerSecurity, LocalSocketListener, StaleReclaim,
};

/// Boxed reader/writer halves, re-exported from the shared core transport.
pub use termihub_core::ipc::{BoxedReader, BoxedWriter};

// `connect` is the client side of the transport, exercised by the round-trip
// tests below; the production agent client and Windows launcher are wired onto
// it in #767, so it reads as dead code in the plain binary build until then.

/// How long [`connect`] waits for the daemon endpoint to appear before failing.
///
/// Generous on purpose: a freshly spawned daemon only binds its endpoint after
/// cold-starting a detached process and spawning its PTY/shell, which can take
/// several seconds on a loaded CI runner (Windows ConPTY especially). The
/// launcher races this connect against the daemon process exiting (see
/// `session::manager`), so a daemon that dies before binding fails fast — this
/// long window only applies while the daemon is still alive but slow to bind.
#[allow(dead_code)]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How often [`connect`] retries while the endpoint is not yet available.
#[allow(dead_code)]
const CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// A listening daemon endpoint, restricted to the current user, bound through
/// the shared [`termihub_core::ipc`] transport.
pub struct DaemonListener {
    inner: LocalSocketListener,
}

impl DaemonListener {
    /// Bind a listener at `endpoint`, creating a current-user-only endpoint
    /// (`0o700` socket dir + file on unix, per-user DACL on windows) and
    /// unconditionally reclaiming any stale endpoint left by a previous daemon.
    /// The endpoint appearing signals readiness to connecting clients.
    ///
    /// This is the **per-session** daemon policy: the endpoint path embeds a
    /// unique session id, so exactly one daemon can ever want it and reclaiming
    /// it unconditionally is safe. Roles whose endpoint is a *singleton*
    /// rendezvous that several processes may race for must use
    /// [`bind_singleton`](Self::bind_singleton) instead.
    pub async fn bind(endpoint: &str) -> io::Result<Self> {
        Self::bind_with_reclaim(endpoint, StaleReclaim::Unconditional).await
    }

    /// Bind a listener at a **singleton** `endpoint` — one that any number of
    /// processes may race to own (the host-wide registry daemon, ADR-11).
    ///
    /// Identical to [`bind`](Self::bind) but for the stale-reclaim policy:
    /// [`StaleReclaim::IfProbeDead`] only clears the path when a connect probe
    /// shows nothing is listening, so a **live** owner keeps it and this bind
    /// fails with [`io::ErrorKind::AddrInUse`]. That is what makes a spawn race
    /// safe: the loser sees `AddrInUse`, exits, and connects to the winner
    /// instead of silently stealing the endpoint out from under it. On windows
    /// `first_pipe_instance(true)` already rejects a live owner.
    pub async fn bind_singleton(endpoint: &str) -> io::Result<Self> {
        Self::bind_with_reclaim(endpoint, StaleReclaim::IfProbeDead).await
    }

    async fn bind_with_reclaim(endpoint: &str, stale_reclaim: StaleReclaim) -> io::Result<Self> {
        let inner = LocalSocketListener::bind_with_options(
            endpoint,
            ListenerOptions {
                security: ListenerSecurity::CurrentUserOnly,
                stale_reclaim,
            },
        )
        .await?;
        Ok(Self { inner })
    }

    /// Accept the next agent connection, returning erased read/write halves.
    pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
        self.inner.accept().await
    }

    /// Remove the endpoint. Call on daemon shutdown.
    pub fn cleanup(&self) {
        self.inner.cleanup();
    }
}

/// Connect to a daemon endpoint, retrying briefly while the endpoint is not yet
/// present (the daemon binds it during slow startup work).
#[allow(dead_code)] // wired into the agent client/launcher in #767
pub async fn connect(endpoint: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
    ipc::connect_with_retry(endpoint, CONNECT_TIMEOUT, CONNECT_POLL_INTERVAL).await
}

#[cfg(unix)]
#[allow(unused_imports)]
pub use unix_impl::{
    agent_forward_endpoint, endpoint_alive, ensure_agent_forward_dir, open_daemon_log,
    open_registry_log, registry_endpoint, session_endpoint,
};
#[cfg(windows)]
#[allow(unused_imports)]
pub use windows_impl::{endpoint_alive, registry_endpoint, session_endpoint};

// ── Unix session-path helpers ───────────────────────────────────────

#[cfg(unix)]
mod unix_impl {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    /// Compute the default endpoint (socket path) for a session.
    pub fn session_endpoint(session_id: &str) -> String {
        socket_dir()
            .join(format!("session-{session_id}.sock"))
            .to_string_lossy()
            .into_owned()
    }

    /// Compute the ssh-agent relay socket path for a session (#1727).
    ///
    /// A sibling of the per-session daemon socket in the same per-user `0o700`
    /// directory. Exported to the session daemon as `SSH_AUTH_SOCK`, it lets the
    /// daemon's core SSH bridge reach the desktop's agent over the JSON-RPC
    /// transport as if it were a normal local agent.
    pub fn agent_forward_endpoint(session_id: &str) -> String {
        socket_dir()
            .join(format!("session-{session_id}-agent.sock"))
            .to_string_lossy()
            .into_owned()
    }

    /// Compute the endpoint (socket path) for the host-wide registry daemon.
    ///
    /// A **singleton** sibling of the per-session sockets in the same per-user
    /// `0o700` directory (ADR-11): one registry per user per host, which is what
    /// makes it a rendezvous every worker of that user can find without being
    /// told where it is. Because the dir is already per-user, the file name
    /// needs no user component. Overridable via
    /// [`REGISTRY_ENDPOINT_ENV`](super::REGISTRY_ENDPOINT_ENV).
    pub fn registry_endpoint() -> String {
        if let Ok(endpoint) = std::env::var(super::REGISTRY_ENDPOINT_ENV) {
            if !endpoint.is_empty() {
                return endpoint;
            }
        }
        socket_dir()
            .join("registry.sock")
            .to_string_lossy()
            .into_owned()
    }

    /// Cheap liveness pre-check: whether the socket file is present on disk.
    ///
    /// A bound daemon keeps its socket file; recovery uses this to skip dead
    /// sessions without paying the [`super::connect`] retry timeout.
    pub fn endpoint_alive(endpoint: &str) -> bool {
        Path::new(endpoint).exists()
    }

    /// Get the per-user socket directory (`/tmp/termihub/{user}`).
    fn socket_dir() -> PathBuf {
        let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
        PathBuf::from("/tmp/termihub").join(user)
    }

    /// Ensure the per-user socket directory exists (mode `0700`) so the
    /// ssh-agent relay can bind its listener there before spawning the daemon
    /// (#1727). The daemon's own socket dir is created lazily on first log/bind;
    /// the relay binds first, so it must create it explicitly.
    pub fn ensure_agent_forward_dir() -> io::Result<()> {
        ensure_socket_dir(&socket_dir())
    }

    /// Ensure the socket directory exists with mode `0700`.
    fn ensure_socket_dir(dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    /// Open (truncating) the daemon's per-session log file in the socket dir.
    ///
    /// The launcher points the detached daemon's stderr here instead of
    /// inheriting the agent's stderr: over SSH that stderr is the exec channel,
    /// and keeping it tethers the daemon's life to the SSH connection (a
    /// disconnect then kills the persistent session). A sibling of the socket
    /// (`session-{id}.log`) keeps daemon diagnostics without that coupling.
    /// Best-effort: returns `None` if the dir or file can't be created, and the
    /// caller falls back to a null stderr.
    pub fn open_daemon_log(session_id: &str) -> Option<std::fs::File> {
        open_log(&format!("session-{session_id}.log"))
    }

    /// Open (truncating) the registry daemon's log file in the socket dir.
    ///
    /// Same reasoning as [`open_daemon_log`]: the registry is spawned by a
    /// worker that may itself be running over an SSH exec channel, so it must
    /// never inherit that stderr. Logs beside its socket as `registry.log`.
    pub fn open_registry_log() -> Option<std::fs::File> {
        open_log("registry.log")
    }

    fn open_log(file_name: &str) -> Option<std::fs::File> {
        let dir = socket_dir();
        ensure_socket_dir(&dir).ok()?;
        std::fs::File::create(dir.join(file_name)).ok()
    }
}

// ── Windows session-path helpers ────────────────────────────────────

#[cfg(windows)]
mod windows_impl {
    /// Compute the default endpoint (pipe name) for a session.
    ///
    /// Pipe names live in the `\\.\pipe\` namespace and are unique per session.
    pub fn session_endpoint(session_id: &str) -> String {
        format!(r"\\.\pipe\termihub-session-{session_id}")
    }

    /// Compute the pipe name for the host-wide registry daemon (ADR-11).
    ///
    /// Unlike the per-session pipes, this name is a **singleton** rendezvous
    /// with no unique component, so it must carry the user itself: the
    /// `\\.\pipe\` namespace is machine-global, and unix gets its per-user
    /// scoping for free from the `0o700` socket *directory* that has no windows
    /// analog. Two users on one host therefore get two distinct pipes — matching
    /// the "one registry per user per host" rule — on top of the per-user DACL
    /// that keeps each one unreachable by the other. Overridable via
    /// [`REGISTRY_ENDPOINT_ENV`](super::REGISTRY_ENDPOINT_ENV).
    pub fn registry_endpoint() -> String {
        if let Ok(endpoint) = std::env::var(super::REGISTRY_ENDPOINT_ENV) {
            if !endpoint.is_empty() {
                return endpoint;
            }
        }
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
        format!(r"\\.\pipe\termihub-registry-{user}")
    }

    /// Cheap liveness pre-check: whether a named-pipe instance exists.
    ///
    /// Uses `WaitNamedPipeW` with a 1 ms timeout, which does not consume an
    /// instance. Recovery uses this to skip dead sessions without paying the
    /// [`super::connect`] retry timeout. A non-existent pipe yields
    /// `ERROR_FILE_NOT_FOUND` (not alive); a busy one yields `ERROR_SEM_TIMEOUT`
    /// (the daemon is up but every instance is momentarily connected → alive).
    pub fn endpoint_alive(endpoint: &str) -> bool {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_SEM_TIMEOUT};
        use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

        let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a valid null-terminated UTF-16 string.
        if unsafe { WaitNamedPipeW(wide.as_ptr(), 1) } != 0 {
            return true;
        }
        unsafe { GetLastError() == ERROR_SEM_TIMEOUT }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::protocol;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Generate a unique session id so concurrent tests don't collide on the
    /// same socket path / pipe name.
    fn unique_session(tag: &str) -> String {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        format!(
            "itest-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    #[test]
    fn session_endpoint_contains_session_id() {
        let endpoint = session_endpoint("abc-123");
        assert!(endpoint.contains("abc-123"), "endpoint was {endpoint}");
    }

    #[cfg(unix)]
    #[test]
    fn unix_endpoint_is_per_user_socket_path() {
        let endpoint = session_endpoint("xyz");
        assert!(endpoint.starts_with("/tmp/termihub/"), "got {endpoint}");
        assert!(endpoint.ends_with("session-xyz.sock"), "got {endpoint}");
    }

    #[cfg(unix)]
    #[test]
    fn open_daemon_log_creates_a_writable_sibling_of_the_socket() {
        // The daemon logs beside its socket (never into the inherited SSH
        // channel), so the file must land in the same per-user dir and be
        // writable — otherwise the launcher falls back to a null stderr.
        let session = unique_session("log");
        let mut file = open_daemon_log(&session).expect("daemon log file");
        use std::io::Write;
        file.write_all(b"ok").expect("write to daemon log");
        // Same per-user dir as the socket, with a `.log` extension.
        let expected = session_endpoint(&session).replace(".sock", ".log");
        assert!(
            std::path::Path::new(&expected).exists(),
            "missing {expected}"
        );
        let _ = std::fs::remove_file(&expected);
    }

    #[cfg(windows)]
    #[test]
    fn windows_endpoint_is_pipe_name() {
        let endpoint = session_endpoint("xyz");
        assert!(endpoint.starts_with(r"\\.\pipe\"), "got {endpoint}");
        assert!(endpoint.contains("xyz"), "got {endpoint}");
    }

    /// Round-trip a frame through the platform transport: bind a listener,
    /// accept on one task, connect from another, and echo a frame back.
    #[tokio::test]
    async fn bind_accept_connect_round_trip() {
        let endpoint = session_endpoint(&unique_session("rt"));

        let mut listener = DaemonListener::bind(&endpoint)
            .await
            .expect("bind listener");
        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let frame = protocol::read_frame_async(&mut reader)
                .await
                .expect("read frame")
                .expect("frame present");
            protocol::write_frame_async(&mut writer, frame.msg_type, &frame.payload)
                .await
                .expect("echo frame");
            listener.cleanup();
        });

        let (mut reader, mut writer) = connect(&endpoint).await.expect("client connect");
        protocol::write_frame_async(&mut writer, protocol::MSG_INPUT, b"hello")
            .await
            .expect("client write");
        let echoed = protocol::read_frame_async(&mut reader)
            .await
            .expect("client read")
            .expect("frame present");

        assert_eq!(echoed.msg_type, protocol::MSG_INPUT);
        assert_eq!(echoed.payload, b"hello");

        server.await.expect("server task");
    }

    /// A second connection to the same listener must also succeed (verifies the
    /// listener stages a fresh instance after each accept on windows).
    #[tokio::test]
    async fn listener_accepts_sequential_connections() {
        let endpoint = session_endpoint(&unique_session("seq"));

        let mut listener = DaemonListener::bind(&endpoint)
            .await
            .expect("bind listener");
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut reader, mut writer) = listener.accept().await.expect("accept");
                let frame = protocol::read_frame_async(&mut reader)
                    .await
                    .expect("read frame")
                    .expect("frame present");
                protocol::write_frame_async(&mut writer, frame.msg_type, &frame.payload)
                    .await
                    .expect("echo frame");
            }
            listener.cleanup();
        });

        for i in 0..2u8 {
            let (mut reader, mut writer) = connect(&endpoint).await.expect("client connect");
            protocol::write_frame_async(&mut writer, protocol::MSG_INPUT, &[i])
                .await
                .expect("client write");
            let echoed = protocol::read_frame_async(&mut reader)
                .await
                .expect("client read")
                .expect("frame present");
            assert_eq!(echoed.payload, vec![i]);
            // Drop the connection so the daemon's accept loop advances.
            drop(reader);
            drop(writer);
        }

        server.await.expect("server task");
    }
}
