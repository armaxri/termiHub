use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use russh_sftp::client::SftpSession as RusshSftp;
use tracing::{debug, info};

use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser};
use termihub_core::files::FileEntry;

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;

/// The privilege-elevated write outcome and the writability verdict now live in
/// [`termihub_core::backends::ssh::sftp_ops`] so a single implementation backs
/// both the core `FileBrowser` path and this desktop session (#2104). Re-exported
/// here so the desktop command layer and its callers keep their import paths.
pub use termihub_core::backends::ssh::sftp_ops::{ElevatedWriteResult, Writability};

/// Map a core [`FileError`](termihub_core::errors::FileError) from an SFTP
/// operation to the desktop [`TerminalError::SftpError`], preserving the
/// operation-specific message (`readdir failed: …`, `realpath failed: …`, etc.)
/// rather than double-wrapping it behind the generic "Operation failed:" prefix.
fn sftp_op_error(err: termihub_core::errors::FileError) -> TerminalError {
    match err {
        termihub_core::errors::FileError::OperationFailed(msg) => TerminalError::SftpError(msg),
        other => TerminalError::SftpError(other.to_string()),
    }
}

/// Drive an async core [`SftpFileBrowser`] operation to completion from the
/// synchronous `SftpSession` API.
///
/// The desktop SFTP command layer is synchronous (each Tauri command runs the
/// blocking session methods on a `spawn_blocking` thread while holding the
/// session mutex), so it bridges into the fully-async core browser via
/// `block_in_place` + `Handle::current().block_on`. Both require a multi-threaded
/// Tokio runtime worker context on the calling thread — always satisfied here
/// because callers are inside `spawn_blocking` (#828).
fn block_on_sftp<F: Future>(fut: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut))
}

/// Lock a mutex, mapping a poisoned lock to a recoverable [`TerminalError`]
/// instead of panicking.
///
/// A prior SFTP op that panicked while holding the lock poisons the `Mutex`;
/// a raw `.lock().unwrap()` would then abort the whole process on every
/// subsequent command. Mapping the error keeps the session recoverable
/// (audit GAP C1, issue #1143).
pub fn lock_session<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, TerminalError> {
    mutex
        .lock()
        .map_err(|_| TerminalError::SftpError("SFTP session lock poisoned".to_string()))
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

/// SFTP session for the desktop file-browser/transfer command layer.
///
/// This is a thin **synchronous adapter** around the single core SFTP
/// implementation, [`SftpFileBrowser`](termihub_core::backends::ssh::SftpFileBrowser):
/// every operation delegates to the core browser (which owns the russh-sftp
/// session and all operation logic), so the desktop no longer maintains a
/// parallel SFTP implementation (#2104). Because it goes through the core browser
/// it reaches jump-host targets through their pooled gateway (#939) — the direct
/// `connect_and_authenticate` path it used before ignored `proxy_jump`.
///
/// The adapter exists only to keep the synchronous, session-id-keyed command API
/// (`SftpManager` + the `sftp_*` Tauri commands) working; migrating that surface
/// onto the async `FileBrowser`/`ConnectionType` path is tracked as a follow-up.
pub struct SftpSession {
    browser: SftpFileBrowser,
}

impl SftpSession {
    /// Open a new SFTP session to the given SSH host.
    ///
    /// Eagerly connects (jump-host aware, via the core browser) so `sftp_open`
    /// fails loudly on a bad host / auth here rather than deferring the error to
    /// the first listing.
    pub fn new(config: &SshConfig) -> Result<Self, TerminalError> {
        info!(host = %config.host, port = config.port, "Opening SFTP connection");
        let browser = SftpFileBrowser::new(config.clone());
        block_on_sftp(browser.connect()).map_err(sftp_op_error)?;
        Ok(Self { browser })
    }

    /// Report whether an exec (command) channel can be opened and used on the
    /// SSH connection backing this SFTP session.
    ///
    /// A normal SSH+shell connection can run the probe (`true`); an SFTP-only or
    /// relayed connection (e.g. `ForceCommand internal-sftp`) cannot (`false`).
    /// Lets the file editor know whether privilege-elevated writes — which need a
    /// shell to run `sudo` — are possible for this connection. A dropped
    /// connection maps to `false`.
    pub fn has_exec_capability(&self) -> bool {
        block_on_sftp(self.browser.has_exec_capability()).unwrap_or(false)
    }

    /// Open a **dedicated** SFTP session on a fresh channel off the same
    /// authenticated SSH connection.
    ///
    /// Used by the cancellable transfer subsystem (#1245): the returned
    /// [`RusshSftp`] owns its own channel, so a chunked copy can run on it
    /// without holding this session's `Mutex` — keeping directory listing /
    /// navigation live on the browsing channel during a transfer.
    pub async fn open_dedicated_sftp(&self) -> Result<RusshSftp, TerminalError> {
        self.browser
            .open_dedicated_channel()
            .await
            .map_err(sftp_op_error)
    }

    /// Best-effort size (in bytes) of a remote file via SFTP `stat`.
    ///
    /// Returns `0` when the size is unavailable — the UI treats `total == 0` as
    /// indeterminate and shows a spinner rather than a percentage.
    pub async fn remote_size(&self, remote_path: &str) -> u64 {
        self.browser.remote_size(remote_path).await
    }

    /// List directory contents, filtering out `.` and `..`.
    pub fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, TerminalError> {
        debug!(path, "SFTP listing directory");
        block_on_sftp(self.browser.list_dir(path)).map_err(sftp_op_error)
    }

    /// Download a remote file to a local path. Returns bytes written.
    pub fn read_file(&self, remote_path: &str, local_path: &str) -> Result<u64, TerminalError> {
        block_on_sftp(async {
            let data = self.browser.read_file(remote_path).await.map_err(sftp_op_error)?;
            tokio::fs::write(local_path, &data)
                .await
                .map_err(|e| TerminalError::SftpError(format!("write local file: {e}")))?;
            Ok::<u64, TerminalError>(data.len() as u64)
        })
    }

    /// Upload a local file to a remote path. Returns bytes written.
    pub fn write_file(&self, local_path: &str, remote_path: &str) -> Result<u64, TerminalError> {
        block_on_sftp(async {
            let data = tokio::fs::read(local_path)
                .await
                .map_err(|e| TerminalError::SftpError(format!("open local file: {e}")))?;
            self.browser
                .write_file(remote_path, &data)
                .await
                .map_err(sftp_op_error)?;
            Ok::<u64, TerminalError>(data.len() as u64)
        })
    }

    /// Create a directory on the remote host.
    pub fn mkdir(&self, path: &str) -> Result<(), TerminalError> {
        block_on_sftp(self.browser.mkdir(path)).map_err(sftp_op_error)
    }

    /// Remove a file on the remote host.
    pub fn remove_file(&self, path: &str) -> Result<(), TerminalError> {
        block_on_sftp(self.browser.delete(path)).map_err(sftp_op_error)
    }

    /// Remove an empty directory on the remote host.
    pub fn remove_dir(&self, path: &str) -> Result<(), TerminalError> {
        block_on_sftp(self.browser.delete(path)).map_err(sftp_op_error)
    }

    /// Read a remote file's contents as a UTF-8 string.
    pub fn read_file_content(&self, remote_path: &str) -> Result<String, TerminalError> {
        block_on_sftp(async {
            let data = self.browser.read_file(remote_path).await.map_err(sftp_op_error)?;
            String::from_utf8(data)
                .map_err(|e| TerminalError::SftpError(format!("read failed: invalid UTF-8: {e}")))
        })
    }

    /// Write a string to a remote file, creating or overwriting it.
    pub fn write_file_content(
        &self,
        remote_path: &str,
        content: &str,
    ) -> Result<(), TerminalError> {
        self.write_bytes(remote_path, content.as_bytes())
    }

    /// Rename a file or directory on the remote host.
    pub fn rename(&self, old_path: &str, new_path: &str) -> Result<(), TerminalError> {
        block_on_sftp(self.browser.rename(old_path, new_path)).map_err(sftp_op_error)
    }

    /// Get metadata for a single file or directory.
    pub fn stat(&self, path: &str) -> Result<FileEntry, TerminalError> {
        block_on_sftp(self.browser.stat(path)).map_err(sftp_op_error)
    }

    /// Authoritatively probe whether the connecting user can write `remote_path`.
    ///
    /// Delegates to the core [`SftpAdvancedOps::check_writable`] companion-trait
    /// implementation (#2104): opens the **existing** file for writing with
    /// `OpenFlags::WRITE` only — no `CREATE`/`TRUNCATE`/`APPEND` — so the file's
    /// contents are never modified, and never returns a hard error for the
    /// ambiguous case (a `PERMISSION_DENIED` maps to [`Writability::ReadOnly`],
    /// any other error to [`Writability::Unknown`]).
    pub fn check_writable(&self, remote_path: &str) -> Result<Writability, TerminalError> {
        block_on_sftp(self.browser.check_writable(remote_path)).map_err(sftp_op_error)
    }

    /// Resolve a remote path to its canonical absolute form via SFTP realpath.
    ///
    /// Delegates to the core [`SftpAdvancedOps::realpath`] companion-trait
    /// implementation (#2104). Passing `"."` yields the session's home directory,
    /// avoiding the fragile `/home/<user>` guess that breaks on non-Linux layouts
    /// (audit GAP C2, issue #1143).
    pub fn realpath(&self, path: &str) -> Result<String, TerminalError> {
        block_on_sftp(self.browser.realpath(path)).map_err(sftp_op_error)
    }

    /// Write raw bytes to a remote file, creating or overwriting it.
    pub fn write_bytes(&self, remote_path: &str, data: &[u8]) -> Result<(), TerminalError> {
        block_on_sftp(self.browser.write_file(remote_path, data)).map_err(sftp_op_error)
    }

    /// Write `content` to `remote_path` with `sudo`-elevated privileges (#1328).
    ///
    /// Delegates to the core [`SftpAdvancedOps::write_file_content_elevated`]
    /// companion-trait implementation (#2104): SFTP-upload the buffer to a
    /// termiHub-generated `/tmp/termihub-<uuid>`, then `sudo -S -p ''` a fixed
    /// `/bin/sh` script (`cat "$1" > "$2" && rm -f "$1"`) that rewrites the
    /// destination in place (preserving owner/mode/ACLs), classified into an
    /// [`ElevatedWriteResult`]. The destination path is POSIX-quoted and passed as
    /// a positional argument, so a hostile remote path cannot inject shell
    /// commands; the password is only ever sent on stdin and is **never** logged.
    pub fn write_file_content_elevated(
        &self,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, TerminalError> {
        block_on_sftp(
            self.browser
                .write_file_content_elevated(remote_path, content, sudo_password),
        )
        .map_err(sftp_op_error)
    }
}

/// Manages multiple SFTP sessions keyed by UUID.
///
/// `Clone` (the session map is behind an `Arc`) so SFTP commands can move a
/// handle into `spawn_blocking` — the SSH/SFTP calls block, and running them on
/// a blocking-pool thread (rather than the Tauri command thread) is what keeps
/// `block_in_place` valid and avoids starving the async runtime.
#[derive(Clone)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
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

    /// Open a new SFTP session. Returns the session UUID.
    pub fn open_session(&self, config: &SshConfig) -> Result<String, TerminalError> {
        let session = SftpSession::new(config)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = lock_session(&self.sessions)?;
        sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
        Ok(id)
    }

    /// Close and drop an SFTP session.
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

    /// Get a session Arc for use outside the manager lock.
    pub fn get_session(&self, id: &str) -> Result<Arc<Mutex<SftpSession>>, TerminalError> {
        let sessions = lock_session(&self.sessions)?;
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
    // elevated (sudo) save and the writability probe now live beside the single
    // core implementation in `core::backends::ssh::sftp_ops` (#2104). The
    // Docker-backed integration tests below stay here because they drive the
    // desktop `SftpSession` end-to-end over a live SSH connection.

    // ── Docker-backed elevated-save integration tests ────────────────────
    //
    // Exercise the real `SftpSession::write_file_content_elevated` path
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
    use crate::utils::remote_exec::run_remote_command;
    use crate::utils::ssh_auth::connect_and_authenticate;
    use termihub_core::backends::ssh::handler::SshSession;

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
        // nothing; `printf %s` avoids `wc`'s leading whitespace.
        let out = run_remote_command(
            verify,
            "ls -1d /tmp/termihub-* 2>/dev/null | grep -c . || true",
        )?;
        Ok(out.trim().parse().unwrap_or(0))
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

        let result = tokio::task::spawn_blocking(move || {
            let config = testuser_config(port, "testpass");
            let verify = connect_and_authenticate(&config)?;

            let stat_cmd = format!("stat -c '%U %G %a' {ELEVATED_TARGET}");
            let stat_before = run_remote_command(&verify, &stat_cmd)?;

            let session = SftpSession::new(&config)?;
            let new_content = format!("elevated-rewrite-{}\n", uuid::Uuid::new_v4());
            let outcome =
                session.write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")?;

            let after = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;
            let stat_after = run_remote_command(&verify, &stat_cmd)?;
            let leftover = temp_leftover_count(&verify)?;

            Ok::<_, TerminalError>((
                outcome,
                new_content,
                after,
                stat_before,
                stat_after,
                leftover,
            ))
        })
        .await
        .expect("spawn_blocking join");

        let (outcome, new_content, after, stat_before, stat_after, leftover) =
            result.expect("elevated save (success) should complete");

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

        let result = tokio::task::spawn_blocking(move || {
            let config = testuser_config(port, "testpass");
            let verify = connect_and_authenticate(&config)?;

            let before = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;

            let session = SftpSession::new(&config)?;
            let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
            let outcome = session.write_file_content_elevated(
                ELEVATED_TARGET,
                &new_content,
                "definitely-the-wrong-password",
            )?;

            let after = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(&verify)?;

            Ok::<_, TerminalError>((outcome, before, after, leftover))
        })
        .await
        .expect("spawn_blocking join");

        let (outcome, before, after, leftover) =
            result.expect("elevated save (wrong password) should complete");

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

        let result = tokio::task::spawn_blocking(move || {
            let config = testuser_config(port, "testpass");
            let verify = connect_and_authenticate(&config)?;

            let before = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;

            let session = SftpSession::new(&config)?;
            let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
            let outcome =
                session.write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")?;

            let after = run_remote_command(&verify, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(&verify)?;

            Ok::<_, TerminalError>((outcome, before, after, leftover))
        })
        .await
        .expect("spawn_blocking join");

        let (outcome, before, after, leftover) =
            result.expect("elevated save (no sudo) should complete");

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

    /// The lock helper must map a poisoned mutex to a recoverable
    /// `TerminalError` instead of panicking (audit GAP C1, #1143).
    #[test]
    fn lock_session_maps_poisoned_mutex_to_error() {
        let mutex = Arc::new(Mutex::new(0i32));

        // Poison the mutex by panicking while holding the lock.
        let poisoner = Arc::clone(&mutex);
        let handle = thread::spawn(move || {
            let _guard = poisoner.lock().expect("first lock should succeed");
            panic!("intentional panic to poison the mutex");
        });
        assert!(handle.join().is_err(), "poisoning thread should panic");

        // A raw `.lock().unwrap()` would panic here; the helper must not.
        let result = lock_session(&mutex);
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
    fn lock_session_returns_guard_when_healthy() {
        let mutex = Mutex::new(41i32);
        let mut guard = lock_session(&mutex).expect("healthy lock should succeed");
        *guard += 1;
        assert_eq!(*guard, 42);
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
