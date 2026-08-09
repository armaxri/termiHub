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
/// How long [`connect_for_recovery`] waits for an **already-running** daemon
/// endpoint to accept before giving up on it.
///
/// Short on purpose, and the mirror image of [`CONNECT_TIMEOUT`]'s reasoning.
/// Recovery targets a daemon that a *previous* agent process bound long ago, so
/// a live daemon is already in its accept loop and connects instantly — there is
/// no slow-bind window to wait out. The spawn path can afford the long window
/// because it races the connect against the daemon process exiting (see
/// `session::manager`); recovery has no such process to race, so the retry loop
/// is its only bound. Retrying `ConnectionRefused` for the full 30s against a
/// dead daemon whose socket file merely lingers is exactly what stalled a fresh
/// agent's startup — and therefore the desktop's `initialize` handshake — after a
/// reconnect (#2476). This only needs to cover scheduling jitter for a live
/// daemon; a dead-but-lingering socket fast-fails within it.
const RECOVERY_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
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

/// Connect to an **already-running** daemon during session recovery, failing
/// fast on a dead daemon whose socket file merely lingers.
///
/// Same as [`connect`] but bounded by the short [`RECOVERY_CONNECT_TIMEOUT`]
/// instead of [`CONNECT_TIMEOUT`]. Use this on the recovery path, where a live
/// daemon is already accepting and a dead-but-lingering socket must not stall the
/// fresh agent's startup for 30s (#2476). See [`RECOVERY_CONNECT_TIMEOUT`].
pub async fn connect_for_recovery(endpoint: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
    ipc::connect_with_retry(endpoint, RECOVERY_CONNECT_TIMEOUT, CONNECT_POLL_INTERVAL).await
}

#[cfg(unix)]
#[allow(unused_imports)]
pub use unix_impl::{
    agent_forward_endpoint, endpoint_alive, ensure_agent_forward_dir, open_daemon_log,
    open_registry_log, registry_endpoint, session_endpoint,
};
#[cfg(windows)]
#[allow(unused_imports)]
pub use windows_impl::{
    agent_forward_endpoint, endpoint_alive, ensure_agent_forward_dir, registry_endpoint,
    session_endpoint,
};

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

    /// Compute the ssh-agent relay pipe name for a session (#2038).
    ///
    /// A per-session sibling of the daemon's own pipe, uniquely named so it never
    /// collides with the agent host's *real* `\\.\pipe\openssh-ssh-agent`.
    /// Injected into the session daemon via
    /// [`AGENT_PIPE_ENV`](termihub_core::backends::ssh::agent_forward::AGENT_PIPE_ENV),
    /// it lets the daemon's core SSH bridge reach the desktop's agent over the
    /// JSON-RPC transport as if it were a normal local agent — the Windows analog
    /// of the unix `SSH_AUTH_SOCK` relay socket (#1727).
    pub fn agent_forward_endpoint(session_id: &str) -> String {
        format!(r"\\.\pipe\termihub-agent-forward-{session_id}")
    }

    /// No directory to pre-create for a named-pipe relay on Windows: the pipe
    /// lives in the machine-global `\\.\pipe\` namespace, so binding it needs no
    /// filesystem setup. The unix analog makes the `0o700` socket dir the relay
    /// socket binds into; here it is a no-op that keeps the call site uniform.
    pub fn ensure_agent_forward_dir() -> std::io::Result<()> {
        Ok(())
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

    /// Env var carrying the socket path for [`bind_lingering_socket_helper`].
    ///
    /// Set by [`connect_for_recovery_fast_fails_dead_lingering_socket`] only on
    /// the child test process it spawns; absent in every normal test run.
    #[cfg(unix)]
    const LINGERING_SOCKET_ENV: &str = "TERMIHUB_TEST_LINGERING_SOCKET";

    /// Child-process helper for
    /// [`connect_for_recovery_fast_fails_dead_lingering_socket`].
    ///
    /// A **no-op** in a normal test run: it does nothing unless the parent test
    /// re-execs this binary with [`LINGERING_SOCKET_ENV`] pointing at a socket
    /// path. In that mode it binds a real listener at the path and leaks it, so
    /// when this process exits the kernel reclaims the listening socket while the
    /// socket *file* lingers on disk. That is the whole point: a socket whose
    /// owning process has truly exited deterministically refuses connections,
    /// whereas an in-process close does not (see the parent test).
    #[cfg(unix)]
    #[test]
    fn bind_lingering_socket_helper() {
        let Ok(path) = std::env::var(LINGERING_SOCKET_ENV) else {
            return;
        };
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("helper: bind lingering socket");
        // Keep it bound until the process exits, so the socket file is left behind
        // exactly as a SIGKILLed daemon leaves it. Process exit — not this drop —
        // is what reclaims the socket, so `forget` vs `drop` is immaterial to
        // correctness; forgetting just makes the intent ("still listening at exit")
        // explicit.
        std::mem::forget(listener);
    }

    /// Regression for #2476: recovery must fast-fail a dead daemon whose socket
    /// file merely lingers, instead of retrying `ConnectionRefused` for the full
    /// 30s [`CONNECT_TIMEOUT`].
    ///
    /// A dead-but-lingering socket is the exact state a killed session daemon
    /// leaves behind (the file persists after the process dies). Before the fix,
    /// `recover_sessions` connected via the spawn-path 30s timeout and blocked the
    /// fresh agent's startup — and thus the desktop's `initialize` handshake —
    /// after a reconnect, the "transport restored but stuck Reconnecting" symptom.
    /// [`connect_for_recovery`] must give up well within [`CONNECT_TIMEOUT`].
    ///
    /// The dead daemon is simulated by a **separate process that binds the socket
    /// and then exits** ([`bind_lingering_socket_helper`]), not by binding and
    /// closing a listener in this process. That distinction is load-bearing and is
    /// what fixed the #2500 flake: on macOS under parallel-test load, a just-closed
    /// in-process AF_UNIX listener stays *transiently connectable* (the kernel
    /// defers teardown while the owning process is still alive), so `connect`
    /// intermittently *succeeded* against the supposedly-dead socket. A socket
    /// whose owning process has actually exited is fully reclaimed by the kernel,
    /// so it refuses connections deterministically — which is precisely the state
    /// production recovery meets, and the only faithful simulation of it.
    #[cfg(unix)]
    #[tokio::test]
    async fn connect_for_recovery_fast_fails_dead_lingering_socket() {
        use std::time::Instant;

        // The per-user socket dir must exist before the child binds into it.
        ensure_agent_forward_dir().expect("ensure socket dir");
        let address = session_endpoint(&unique_session("recovery-dead"));

        // Re-exec this test binary to run only the bind-and-exit helper, handing it
        // the socket path via the environment. When it returns, the child process
        // has exited and left a genuinely-dead socket file behind.
        let exe = std::env::current_exe().expect("current test exe");
        let output = std::process::Command::new(exe)
            .args([
                "--exact",
                "--test-threads=1",
                "-q",
                "daemon::transport::tests::bind_lingering_socket_helper",
            ])
            .env(LINGERING_SOCKET_ENV, &address)
            .output()
            .expect("run lingering-socket helper");
        assert!(
            output.status.success(),
            "lingering-socket helper failed: {status}\nstdout: {out}\nstderr: {err}",
            status = output.status,
            out = String::from_utf8_lossy(&output.stdout),
            err = String::from_utf8_lossy(&output.stderr),
        );
        assert!(
            endpoint_alive(&address),
            "the lingering socket file should still exist (endpoint_alive true)"
        );

        let start = Instant::now();
        let result = connect_for_recovery(&address).await;
        let elapsed = start.elapsed();

        // Two independent guarantees, both from the #2476/#2491 recovery fix:
        //  (1) a dead-but-lingering socket is rejected, not silently treated as a
        //      live daemon;
        assert!(
            result.is_err(),
            "connecting to a dead-but-lingering socket must fail (got a live \
             connection to a socket whose owning process has exited)"
        );
        //  (2) it fast-fails nowhere near the 30s spawn-path timeout. Generous
        //      bound (well above RECOVERY_CONNECT_TIMEOUT + retry jitter, well below
        //      CONNECT_TIMEOUT) so it never flakes on a loaded runner yet still
        //      trips if recovery ever regresses to the long path.
        assert!(
            elapsed < Duration::from_secs(10),
            "connect_for_recovery took {elapsed:?} — a dead-but-lingering socket \
             must fast-fail, not pay the {CONNECT_TIMEOUT:?} spawn-path timeout (#2476)"
        );

        let _ = std::fs::remove_file(&address);
    }
}
