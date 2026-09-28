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
//! `initialize` result as `update_auth_token_path`. The desktop reads the token
//! out of band over its SSH session and sends it back as `authToken`. The token
//! therefore proves the caller can read the agent owner's files — a peer that
//! can merely reach the RPC surface cannot update the agent.
//!
//! A handler with no token configured (no transport wired one) refuses every
//! update RPC: fail closed.

use std::path::{Path, PathBuf};

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
    /// Written to `<config>/instance-auth/<pid>.token`. A stale file from a
    /// crashed process is harmless — its token died with that process — and a
    /// re-exec (self-update) keeps the pid, so it simply overwrites its own file.
    pub fn generate_for_stdio() -> Result<Self> {
        let dir = crate::state::persistence::AgentState::config_dir().join(INSTANCE_TOKEN_DIR);
        Self::generate_in(&dir, std::process::id()).map(|(auth, _)| auth)
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
