//! Per-instance authorization of the agent-update RPCs (AGT-003, #3213).
//!
//! `agent.request_update` and `agent.request_deferred_update` make the agent
//! stage — and eventually exec — a new binary. Being `initialize`d is not enough
//! authority for that: the caller must also present this agent **instance's**
//! auth token, in addition to the binary carrying a valid release signature
//! (AGT-005). A missing or wrong token is refused before anything is staged.
//!
//! # Where the token comes from
//!
//! It is the same per-instance bearer token as the `--listen` connection
//! handshake ([`super::auth`], AGT-002):
//!
//! - **`--listen`** reuses that instance's `listen-auth.token` — the client
//!   already read it to authenticate the connection.
//! - **`--stdio`** (one agent process per desktop connection) generates a fresh
//!   token per process and writes it to its own owner-only file,
//!   `<config>/instance-auth/<pid>.token` (`0700` directory, `0600` file).
//!
//! Either way the agent advertises the file's **path** (never the token) in the
//! `initialize` result as `updateAuthTokenPath` (`update_auth_token_path` for
//! a pre-0.24.0 client). The desktop reads the token out of band over its SSH
//! session and sends it back as `authToken`. The token
//! therefore proves the caller can read the agent owner's files — a peer that
//! can merely reach the RPC surface cannot update the agent.
//!
//! A handler with no token configured (no transport wired one) refuses every
//! update RPC: fail closed.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

use super::auth::{generate_token_string, write_token_file, ListenAuthToken};
use crate::protocol::methods::{
    UpdateAuthToken, AGENT_REQUEST_DEFERRED_UPDATE, AGENT_REQUEST_UPDATE,
};

/// Directory (under the agent config dir) holding the per-process `--stdio`
/// update auth token files.
const INSTANCE_TOKEN_DIR: &str = "instance-auth";

/// The update auth token of one agent instance, plus the path of the
/// owner-only file it is published in.
#[derive(Clone)]
pub struct UpdateAuth {
    token: ListenAuthToken,
    token_path: PathBuf,
}

impl UpdateAuth {
    /// Gate update RPCs with `token`, which the desktop can read from
    /// `token_path`.
    pub fn new(token: ListenAuthToken, token_path: PathBuf) -> Self {
        Self { token, token_path }
    }

    /// Generate and persist a fresh per-process token for a `--stdio` agent.
    ///
    /// Written to `<config>/instance-auth/<pid>.token`. A re-exec (self-update)
    /// keeps the pid, so it simply overwrites its own file. Token files left
    /// behind by crashed agents are pruned first (#3744) — see
    /// [`prune_stale_token_files`].
    pub fn generate_for_stdio() -> Result<Self> {
        let dir = crate::state::persistence::AgentState::config_dir().join(INSTANCE_TOKEN_DIR);
        let own_pid = std::process::id();
        prune_stale_token_files(&dir, own_pid, super::process_probe::owner_may_be_live);
        Self::generate_in(&dir, own_pid).map(|(auth, _)| auth)
    }

    /// Path-injectable core of [`generate_for_stdio`](Self::generate_for_stdio),
    /// returning the plaintext too so tests can assert the persisted value.
    fn generate_in(dir: &Path, pid: u32) -> Result<(Self, String)> {
        create_private_dir(dir)?;
        let plaintext = generate_token_string();
        let path = dir.join(format!("{pid}.token"));
        write_token_file(&path, &plaintext)
            .with_context(|| format!("failed to write update auth token to {}", path.display()))?;
        info!("update auth token written to {}", path.display());
        Ok((
            Self::new(ListenAuthToken::from_plaintext(&plaintext), path),
            plaintext,
        ))
    }

    /// The path the desktop reads the token from (advertised in `initialize`).
    pub fn token_path(&self) -> String {
        self.token_path.to_string_lossy().into_owned()
    }

    /// Constant-time check of a presented token; `None` never verifies.
    pub fn verify(&self, presented: Option<&UpdateAuthToken>) -> bool {
        presented.is_some_and(|t| self.token.verify(t.expose()))
    }

    /// Best-effort removal of this instance's token file (graceful shutdown).
    pub fn remove_token_file(&self) {
        match std::fs::remove_file(&self.token_path) {
            Ok(()) => debug!(
                "removed update auth token file {}",
                self.token_path.display()
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => warn!(
                "failed to remove update auth token file {}: {e}",
                self.token_path.display()
            ),
        }
    }
}

/// Whether a raw request line is an update RPC — it carries the update auth
/// token, so its body must never be logged.
pub fn carries_update_auth_token(line: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct MethodOnly<'a> {
        #[serde(borrow)]
        method: Option<std::borrow::Cow<'a, str>>,
    }
    serde_json::from_str::<MethodOnly<'_>>(line)
        .ok()
        .and_then(|m| m.method)
        .is_some_and(|m| m == AGENT_REQUEST_UPDATE || m == AGENT_REQUEST_DEFERRED_UPDATE)
}

/// Remove `<pid>.token` files in `dir` whose writing agent is provably gone
/// (#3744). Returns how many were removed.
///
/// A stale token is harmless — it died with its process — but the files would
/// otherwise accumulate. Only regular files named exactly `<decimal pid>.token`
/// are considered; `own_pid`'s file is never touched, and a file is removed only
/// when `may_be_live(pid, mtime)` says its owner cannot still be running (see
/// [`super::process_probe::owner_may_be_live`]: the pid is gone, belongs to
/// another user, or was reused by a process started after the file was
/// written). Best effort: every error is logged and skipped.
fn prune_stale_token_files(
    dir: &Path,
    own_pid: u32,
    may_be_live: impl Fn(u32, Option<SystemTime>) -> bool,
) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(e) => {
            warn!(
                "cannot scan {} for stale update auth tokens: {e}",
                dir.display()
            );
            return 0;
        }
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Some(pid) = token_file_pid(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        if pid == own_pid {
            continue;
        }
        // symlink_metadata: never follow a link out of the private dir.
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        if !meta.is_file() || may_be_live(pid, meta.modified().ok()) {
            continue;
        }
        let path = entry.path();
        match std::fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
                debug!("removed stale update auth token {}", path.display());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => warn!(
                "failed to remove stale update auth token {}: {e}",
                path.display()
            ),
        }
    }
    if removed > 0 {
        info!(
            "removed {removed} stale update auth token file(s) from {}",
            dir.display()
        );
    }
    removed
}

/// The pid of a `<pid>.token` file name, if it is exactly that (canonical
/// decimal, no sign or leading zeros).
fn token_file_pid(name: &str) -> Option<u32> {
    let stem = name.strip_suffix(".token")?;
    let pid: u32 = stem.parse().ok()?;
    (pid.to_string() == stem).then_some(pid)
}

/// Create `dir` (and parents), owner-only on unix.
fn create_private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("failed to create token dir {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("failed to chmod token dir {}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
impl UpdateAuth {
    /// A token guard for `plaintext` at a fake path — handler tests only.
    pub fn for_test(plaintext: &str) -> Self {
        Self::new(
            ListenAuthToken::from_plaintext(plaintext),
            PathBuf::from("/test/instance-auth/0.token"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdio_token_is_persisted_owner_only_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let token_dir = dir.path().join(INSTANCE_TOKEN_DIR);
        let (auth, plaintext) = UpdateAuth::generate_in(&token_dir, 4242).unwrap();

        let path = token_dir.join("4242.token");
        assert_eq!(auth.token_path(), path.to_string_lossy());
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, plaintext);
        assert!(auth.verify(Some(&UpdateAuthToken(on_disk))));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must be owner-only");
            let mode = std::fs::metadata(&token_dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "token dir must be owner-only");
        }

        auth.remove_token_file();
        assert!(!path.exists(), "graceful shutdown removes the token file");
        // Removing again is a harmless no-op.
        auth.remove_token_file();
    }

    #[test]
    fn each_instance_gets_its_own_token() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _) = UpdateAuth::generate_in(dir.path(), 1).unwrap();
        let (b, b_plain) = UpdateAuth::generate_in(dir.path(), 2).unwrap();
        assert_ne!(a.token_path(), b.token_path());
        assert!(!a.verify(Some(&UpdateAuthToken(b_plain))));
    }

    #[test]
    fn token_file_names_are_parsed_strictly() {
        assert_eq!(token_file_pid("4242.token"), Some(4242));
        assert_eq!(token_file_pid("0.token"), Some(0));
        assert_eq!(token_file_pid("007.token"), None);
        assert_eq!(token_file_pid("+7.token"), None);
        assert_eq!(token_file_pid("abc.token"), None);
        assert_eq!(token_file_pid("42.token.tmp"), None);
        assert_eq!(token_file_pid("42"), None);
        assert_eq!(token_file_pid(".token"), None);
    }

    #[test]
    fn prune_removes_only_dead_agents_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        for name in ["100.token", "200.token", "300.token", "301.token"] {
            std::fs::write(d.join(name), "t").unwrap();
        }
        // Files that are not `<pid>.token` are never touched.
        for name in ["notes.txt", "abc.token", "0300.token", ".tmpXYZ"] {
            std::fs::write(d.join(name), "x").unwrap();
        }
        std::fs::create_dir(d.join("302.token")).unwrap();

        let probed = std::sync::Mutex::new(Vec::new());
        // pid 100 is us, 200 is a live agent, 300/301/302 are gone.
        let removed = prune_stale_token_files(d, 100, |pid, mtime| {
            assert!(mtime.is_some(), "a regular file has an mtime");
            probed.lock().unwrap().push(pid);
            pid == 200
        });

        assert_eq!(removed, 2);
        assert!(d.join("100.token").exists(), "own token is kept");
        assert!(d.join("200.token").exists(), "a live agent's token is kept");
        assert!(!d.join("300.token").exists());
        assert!(!d.join("301.token").exists());
        assert!(d.join("302.token").is_dir(), "directories are ignored");
        for name in ["notes.txt", "abc.token", "0300.token", ".tmpXYZ"] {
            assert!(d.join(name).exists(), "{name} must be left alone");
        }
        let mut probed = probed.into_inner().unwrap();
        probed.sort_unstable();
        assert!(!probed.contains(&100), "own pid is never probed");
        assert!(!probed.contains(&302), "a directory is never probed");
    }

    #[test]
    fn prune_of_missing_dir_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let removed = prune_stale_token_files(&dir.path().join("absent"), 1, |_, _| false);
        assert_eq!(removed, 0);
    }

    #[cfg(unix)]
    #[test]
    fn prune_does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim");
        std::fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("300.token")).unwrap();
        prune_stale_token_files(dir.path(), 1, |_, _| false);
        assert!(target.exists(), "the link target must never be removed");
    }

    /// End to end with the real process probe: a token of the running process
    /// (written now) survives; one of an exited process and one whose pid was
    /// reused after it was written are removed.
    #[test]
    fn prune_with_real_probe_keeps_live_and_removes_dead() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let me = std::process::id();

        #[cfg(unix)]
        let mut child = std::process::Command::new("true").spawn().unwrap();
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .unwrap();
        let dead = child.id();
        child.wait().unwrap();
        let dead_is_gone = super::super::process_probe::probe(dead)
            == super::super::process_probe::ProcessProbe::Gone;

        let live_path = d.join(format!("{me}.token"));
        std::fs::write(&live_path, "t").unwrap();
        let dead_path = d.join(format!("{dead}.token"));
        std::fs::write(&dead_path, "t").unwrap();

        // Pretend we are some other agent so our own file is subject to pruning.
        let not_me = if me == 1 { 2 } else { 1 };
        prune_stale_token_files(d, not_me, super::super::process_probe::owner_may_be_live);
        assert!(
            live_path.exists(),
            "a live agent's fresh token must be kept"
        );
        if dead_is_gone {
            assert!(!dead_path.exists(), "a dead agent's token must be removed");
        }

        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        {
            // The live pid "wrote" this file long before it started: reused pid.
            let f = std::fs::File::options()
                .write(true)
                .open(&live_path)
                .unwrap();
            f.set_modified(std::time::UNIX_EPOCH).unwrap();
            drop(f);
            prune_stale_token_files(d, not_me, super::super::process_probe::owner_may_be_live);
            assert!(!live_path.exists(), "a reused pid's older token is removed");
        }
    }

    #[test]
    fn missing_or_wrong_token_does_not_verify() {
        let auth = UpdateAuth::for_test("right");
        assert!(auth.verify(Some(&UpdateAuthToken("right".into()))));
        assert!(!auth.verify(Some(&UpdateAuthToken("wrong".into()))));
        assert!(!auth.verify(Some(&UpdateAuthToken(String::new()))));
        assert!(!auth.verify(None));
    }

    #[test]
    fn update_rpcs_are_recognised_as_token_bearing() {
        assert!(carries_update_auth_token(
            r#"{"jsonrpc":"2.0","id":1,"method":"agent.request_update","params":{}}"#
        ));
        assert!(carries_update_auth_token(
            r#"{"jsonrpc":"2.0","id":1,"method":"agent.request_deferred_update"}"#
        ));
        assert!(!carries_update_auth_token(
            r#"{"jsonrpc":"2.0","id":1,"method":"connection.list"}"#
        ));
        assert!(!carries_update_auth_token("not json"));
    }
}
