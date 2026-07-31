use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tracing::info;

use termihub_core::backends::ssh::SftpFileBrowser;

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;

/// The privilege-elevated write outcome and the writability verdict now live in
/// [`termihub_core::backends::ssh::sftp_ops`] so a single implementation backs
/// both the core `FileBrowser` path and this desktop command layer (#2104).
/// Re-exported here so the command layer and its callers keep their import paths.
pub use termihub_core::backends::ssh::sftp_ops::{ElevatedWriteResult, Writability};

/// Map a core [`FileError`](termihub_core::errors::FileError) from an SFTP
/// operation to the desktop [`TerminalError::SftpError`], preserving the
/// operation-specific message (`readdir failed: …`, `realpath failed: …`, etc.)
/// rather than double-wrapping it behind the generic "Operation failed:" prefix.
///
/// Shared by every `sftp_*` Tauri command so they map the core browser's errors
/// uniformly (#2104).
pub(crate) fn sftp_op_error(err: termihub_core::errors::FileError) -> TerminalError {
    match err {
        termihub_core::errors::FileError::OperationFailed(msg) => TerminalError::SftpError(msg),
        other => TerminalError::SftpError(other.to_string()),
    }
}

/// Lock the session map, mapping a poisoned lock to a recoverable
/// [`TerminalError`] instead of panicking.
///
/// A prior operation that panicked while holding the lock poisons the `Mutex`;
/// a raw `.lock().unwrap()` would then abort the whole process on every
/// subsequent command. Mapping the error keeps the manager recoverable
/// (audit GAP C1, issue #1143). The guard is only ever held for the brief,
/// non-async map mutation (insert / remove / clone-out), never across an
/// `.await`.
fn lock_sessions(
    sessions: &Mutex<HashMap<String, Arc<SftpFileBrowser>>>,
) -> Result<MutexGuard<'_, HashMap<String, Arc<SftpFileBrowser>>>, TerminalError> {
    sessions
        .lock()
        .map_err(|_| TerminalError::SftpError("SFTP session map lock poisoned".to_string()))
}

/// Drain every entry from a keyed session map, poison-safe, and drop the values.
///
/// Recovers the guard even if the map mutex is poisoned — draining is cleanup
/// (e.g. on app quit) and must never itself panic, mirroring
/// [`SftpManager::close_session`]'s handling (audit GAP C1, issues #1143/#1244).
/// Returns the number of sessions removed. Values are dropped as the map clears,
/// tearing down each underlying connection.
fn drain_sessions<V>(sessions: &Mutex<HashMap<String, V>>) -> usize {
    let mut guard = sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let count = guard.len();
    guard.clear();
    count
}

/// Manages the desktop file-browser/transfer command layer's SFTP sessions,
/// keyed by UUID.
///
/// Each session is a single core [`SftpFileBrowser`] — the **one** SFTP
/// implementation, shared with the core
/// [`ConnectionType::file_browser()`](termihub_core::connection::ConnectionType::file_browser)
/// path. The desktop no longer wraps it in a synchronous adapter: the `sftp_*`
/// Tauri commands drive the fully-async browser directly with `.await`, exactly
/// as [`session::file_ops`](crate::session) does for session-scoped browsing
/// (#2104). Because the browser connects through the core `connect_target`, every
/// session reaches jump-host (`ProxyJump`) targets through their pooled gateway
/// (#939).
///
/// `Clone` (the session map is behind an `Arc`) so commands can hold a handle;
/// the browser is itself `Send + Sync` and serialises concurrent operations on
/// its own async mutex, so no per-session outer lock is needed.
#[derive(Clone)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SftpFileBrowser>>>>,
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Open a new SFTP session to the given SSH host and return its UUID.
    ///
    /// Eagerly connects (jump-host aware, via the core browser) so `sftp_open`
    /// fails loudly on a bad host / auth here rather than deferring the error to
    /// the first listing. The connection is fully async — no `spawn_blocking` /
    /// `block_in_place` bridging is needed (the core browser is what the
    /// `ConnectionType` path already awaits directly).
    pub async fn open_session(&self, config: &SshConfig) -> Result<String, TerminalError> {
        info!(host = %config.host, port = config.port, "Opening SFTP session");
        let browser = SftpFileBrowser::new(config.clone());
        browser.connect().await.map_err(sftp_op_error)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = lock_sessions(&self.sessions)?;
        sessions.insert(id.clone(), Arc::new(browser));
        Ok(id)
    }

    /// Close and drop an SFTP session, tearing down its SSH+SFTP connection.
    pub fn close_session(&self, id: &str) {
        info!(session_id = id, "Closing SFTP session");
        // Recover the guard even if the map mutex is poisoned — removing a
        // session is cleanup and must not itself panic (audit GAP C1, #1143).
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.remove(id);
    }

    /// Close and drop every open SFTP session, tearing down each SSH+SFTP
    /// connection.
    ///
    /// Called on app quit so no session is left dangling on the server until it
    /// times out. Poison-safe: a prior panic that poisoned the sessions mutex
    /// does not abort teardown (mirrors [`Self::close_session`], issue #1244).
    pub fn close_all(&self) {
        let count = drain_sessions(&self.sessions);
        info!(session_count = count, "Closing all SFTP sessions");
    }

    /// Get the [`SftpFileBrowser`] for a session for use outside the manager
    /// lock. Clones the `Arc`, so the returned handle keeps the session alive and
    /// its operations run on the shared async browser.
    pub fn get_session(&self, id: &str) -> Result<Arc<SftpFileBrowser>, TerminalError> {
        let sessions = lock_sessions(&self.sessions)?;
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::SftpSessionNotFound(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    // The pure command-composition and classification unit tests for the
    // elevated (sudo) save and the writability probe live beside the single core
    // implementation in `core::backends::ssh::sftp_ops` (#2104). The Docker-backed
    // integration tests below stay here because they drive the desktop command
    // layer's SFTP session (the core `SftpFileBrowser`) end-to-end over a live SSH
    // connection.

    // ── Docker-backed elevated-save integration tests ────────────────────
    //
    // Exercise the real `SftpFileBrowser::write_file_content_elevated` path
    // end-to-end over a live SSH connection (temp SFTP upload → `sudo -S`
    // rewrite → typed classification → temp cleanup), covering the three
    // outcomes the #1328 unit tests can only stub: correct password, wrong
    // password, and no-sudo. They self-skip when the container is not up,
    // mirroring the "Agent Deploy SFTP" test in `utils::remote_exec` and the
    // `require_docker!` convention in `core/tests/common`. Bring the fixtures
    // up with:
    //   docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo ssh-nosudo
    //
    // Ports are read from `TERMIHUB_TEST_SSH_SUDO_PORT` (default 2212) and
    // `TERMIHUB_TEST_SSH_NOSUDO_PORT` (default 2213) so a sharded / parallel
    // run can point at a separate container instance. A second, plain SSH
    // session (as `testuser`) reads the world-readable root-owned target back
    // to verify contents/owner/mode and to confirm no `/tmp/termihub-*` temp
    // leaked — never the elevated write path itself.
    //
    // The three tests share the one root-owned fixture file, so they must not
    // run concurrently against the same container (they clobber each other's
    // before/after expectations); run them with `--test-threads=1` until the
    // per-test fixture isolation tracked in #2238 lands.
    use crate::utils::remote_exec::run_remote_command;
    use crate::utils::ssh_auth::connect_and_authenticate;
    use termihub_core::backends::ssh::handler::SshSession;
    use termihub_core::backends::ssh::SftpAdvancedOps;

    /// Root-owned file the fixtures ship (see `tests/docker/ssh-sudo`).
    const ELEVATED_TARGET: &str = "/etc/termihub-elevated-target.txt";
    /// Default host ports of the elevated-save fixtures (`tests/docker`).
    const DEFAULT_SSH_SUDO_PORT: u16 = 2212;
    const DEFAULT_SSH_NOSUDO_PORT: u16 = 2213;

    fn env_port(var: &str, default: u16) -> u16 {
        std::env::var(var)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    /// Returns `true` if a TCP connection to the SSH server succeeds quickly.
    fn ssh_port_reachable(port: u16) -> bool {
        use std::net::TcpStream;
        use std::time::Duration;
        format!("127.0.0.1:{port}")
            .parse()
            .ok()
            .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok())
            .is_some()
    }

    /// Trust the loopback fixture host keys before connecting.
    ///
    /// The strict default host-key policy (#1969) trusts only a key already in
    /// the runner's `~/.ssh/known_hosts`, so a freshly-built fixture container is
    /// otherwise refused with "Unknown server key" (#2105). These loopback
    /// fixtures are trusted unconditionally, mirroring
    /// `sftp_transfer.rs::trust_fixture_host_keys` and core's
    /// `common::trust_fixture_host_keys`. The verifier is process-global and
    /// first-registration-wins, so calling it per test is a harmless no-op after
    /// the first.
    fn trust_fixture_host_keys() {
        use termihub_core::backends::ssh::host_key::{
            set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
        };

        struct TrustLocalFixtures;

        #[async_trait::async_trait]
        impl HostKeyVerifier for TrustLocalFixtures {
            async fn verify(&self, _info: &HostKeyInfo) -> bool {
                true
            }
        }

        let _ = set_host_key_verifier(Arc::new(TrustLocalFixtures));
    }

    /// Password-auth config for a fixture container on `127.0.0.1:port`.
    fn testuser_config(port: u16, password: &str) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: "testuser".to_string(),
            auth_method: "password".to_string(),
            password: Some(password.to_string()),
            ..Default::default()
        }
    }

    /// Count of leftover `/tmp/termihub-*` temp files as seen by `testuser`.
    fn temp_leftover_count(verify: &SshSession) -> Result<usize, TerminalError> {
        // `2>/dev/null` swallows the "No such file" when the glob matches
        // nothing; `grep -c` avoids `wc`'s leading whitespace.
        let out = run_remote_command(
            verify,
            "ls -1d /tmp/termihub-* 2>/dev/null | grep -c . || true",
        )?;
        Ok(out.trim().parse().unwrap_or(0))
    }

    /// Run `f` with a fresh, plain SSH verify session (as `testuser`) on a
    /// blocking-pool thread — `connect_and_authenticate` and `run_remote_command`
    /// are synchronous, so they cannot run on the async test thread. Used only to
    /// read the target file back and count temp leftovers, never for the elevated
    /// write path itself (that goes through the async core browser under test).
    async fn with_verify<T, F>(config: SshConfig, f: F) -> Result<T, TerminalError>
    where
        F: FnOnce(&SshSession) -> Result<T, TerminalError> + Send + 'static,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            let verify = connect_and_authenticate(&config)?;
            f(&verify)
        })
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
    }

    /// Correct password → `Success`: the root-owned file is rewritten, its
    /// owner/mode are preserved, and no temp upload leaks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn elevated_save_success_rewrites_root_file_over_real_ssh() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-sudo container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo)"
            );
            return;
        }

        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");
        let stat_cmd = format!("stat -c '%U %G %a' {ELEVATED_TARGET}");

        // Capture owner/group/mode before the elevated rewrite.
        let stat_before = with_verify(config.clone(), {
            let stat_cmd = stat_cmd.clone();
            move |v| run_remote_command(v, &stat_cmd)
        })
        .await
        .expect("stat before should succeed");

        // Elevated write through the single core browser (the desktop command
        // layer's SFTP path).
        let browser = SftpFileBrowser::new(config.clone());
        let new_content = format!("elevated-rewrite-{}\n", uuid::Uuid::new_v4());
        let outcome = browser
            .write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")
            .await
            .expect("elevated save (success) should complete");

        // Read the target back and confirm no temp leaked.
        let (after, stat_after, leftover) = with_verify(config.clone(), move |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let stat_after = run_remote_command(v, &stat_cmd)?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, stat_after, leftover))
        })
        .await
        .expect("readback after should succeed");

        assert_eq!(outcome, ElevatedWriteResult::Success, "expected Success");
        assert_eq!(
            after,
            new_content.trim(),
            "root-owned file should hold the newly written content"
        );
        assert_eq!(
            stat_before, stat_after,
            "owner/group/mode must be unchanged by the elevated rewrite"
        );
        assert_eq!(
            stat_after, "root root 644",
            "target must remain root-owned, mode 644"
        );
        assert_eq!(leftover, 0, "no /tmp/termihub-* temp should remain");
    }

    /// Wrong password → `IncorrectPassword`: the file is untouched and the temp
    /// upload is cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn elevated_save_wrong_password_leaves_file_untouched() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-sudo container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo)"
            );
            return;
        }

        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");

        let before = with_verify(config.clone(), move |v| {
            run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))
        })
        .await
        .expect("read before should succeed");

        let browser = SftpFileBrowser::new(config.clone());
        let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
        let outcome = browser
            .write_file_content_elevated(
                ELEVATED_TARGET,
                &new_content,
                "definitely-the-wrong-password",
            )
            .await
            .expect("elevated save (wrong password) should complete");

        let (after, leftover) = with_verify(config.clone(), move |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, leftover))
        })
        .await
        .expect("readback after should succeed");

        assert_eq!(
            outcome,
            ElevatedWriteResult::IncorrectPassword,
            "a rejected sudo password must classify as IncorrectPassword"
        );
        assert_eq!(
            after, before,
            "file must be unchanged on a rejected password"
        );
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    /// No sudo installed → `Other`: the file is untouched and the temp upload is
    /// cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn elevated_save_without_sudo_returns_other() {
        let port = env_port("TERMIHUB_TEST_SSH_NOSUDO_PORT", DEFAULT_SSH_NOSUDO_PORT);
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-nosudo container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-nosudo)"
            );
            return;
        }

        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");

        let before = with_verify(config.clone(), move |v| {
            run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))
        })
        .await
        .expect("read before should succeed");

        let browser = SftpFileBrowser::new(config.clone());
        let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
        let outcome = browser
            .write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")
            .await
            .expect("elevated save (no sudo) should complete");

        let (after, leftover) = with_verify(config.clone(), move |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, leftover))
        })
        .await
        .expect("readback after should succeed");

        match outcome {
            ElevatedWriteResult::Other(msg) => {
                assert!(!msg.is_empty(), "Other must carry a displayable message")
            }
            other => panic!("expected Other when sudo is unavailable, got {other:?}"),
        }
        assert_eq!(
            after, before,
            "file must be unchanged when sudo is unavailable"
        );
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    /// The session-map lock helper must map a poisoned mutex to a recoverable
    /// `TerminalError` instead of panicking (audit GAP C1, #1143).
    #[test]
    fn lock_sessions_maps_poisoned_mutex_to_error() {
        let sessions: Arc<Mutex<HashMap<String, Arc<SftpFileBrowser>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Poison the mutex by panicking while holding the lock.
        let poisoner = Arc::clone(&sessions);
        let handle = thread::spawn(move || {
            let _guard = poisoner.lock().expect("first lock should succeed");
            panic!("intentional panic to poison the mutex");
        });
        assert!(handle.join().is_err(), "poisoning thread should panic");

        // A raw `.lock().unwrap()` would panic here; the helper must not.
        let result = lock_sessions(&sessions);
        assert!(
            matches!(result, Err(TerminalError::SftpError(_))),
            "poisoned lock should return a recoverable SftpError, got {result:?}"
        );
        // The failure is an SFTP-session error, not a generic SSH error (#2094).
        let rendered = result.unwrap_err().to_string();
        assert!(
            rendered.starts_with("SFTP error:"),
            "SFTP session errors must carry the SFTP label, got {rendered:?}"
        );
    }

    /// On a healthy mutex the helper returns a usable guard.
    #[test]
    fn lock_sessions_returns_guard_when_healthy() {
        let sessions: Mutex<HashMap<String, Arc<SftpFileBrowser>>> = Mutex::new(HashMap::new());
        let guard = lock_sessions(&sessions).expect("healthy lock should succeed");
        assert!(guard.is_empty());
    }

    /// `close_all`'s drain must empty the map even when the map mutex is
    /// poisoned by a prior panic — teardown on quit must never itself abort
    /// (mirrors `close_session`'s poison handling, issue #1244). Uses a
    /// `String`-valued map so no real SSH/SFTP session is required.
    #[test]
    fn drain_sessions_empties_map_despite_poisoned_mutex() {
        let sessions: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut guard = sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.insert("session-a".to_string(), "a".to_string());
            guard.insert("session-b".to_string(), "b".to_string());
        }

        // Poison the sessions mutex by panicking while holding the lock.
        let poisoner = Arc::clone(&sessions);
        let handle = thread::spawn(move || {
            let _guard = poisoner.lock().expect("first lock should succeed");
            panic!("intentional panic to poison the sessions mutex");
        });
        assert!(handle.join().is_err(), "poisoning thread should panic");

        // A raw `.lock().unwrap()` inside the drain would panic here.
        let drained = drain_sessions(&sessions);
        assert_eq!(drained, 2, "drain should report the two removed sessions");

        let guard = sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(
            guard.is_empty(),
            "drain should empty the sessions map, still had {} entries",
            guard.len()
        );
    }
}
