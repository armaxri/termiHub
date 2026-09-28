//! Desktop half of the agent-update authorization (AGT-003, #3213).
//!
//! A 0.13.0+ agent refuses `agent.request_update` / `agent.request_deferred_update`
//! unless the request carries the agent instance's per-instance update auth
//! token. The agent never sends the token over the RPC channel; it advertises
//! the **path** of an owner-only file in its `initialize` result
//! (`update_auth_token_path`). The desktop reads that file over its own,
//! already-authenticated SSH session (SFTP) right before it sends an update
//! request — proving it can read the agent owner's files — and puts the token
//! in `authToken`.
//!
//! An older agent advertises no path and needs no token, so reading nothing is
//! not an error here: the request goes out without a token and a new agent
//! refuses it with `UPDATE_UNAUTHORIZED` (fail closed on the agent side).

use std::time::Duration;

use tracing::warn;

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::protocol::methods::{InitializeResult, UpdateAuthToken};

use crate::utils::remote_exec::read_small_file_async;

/// Bound on reading the token file (SFTP open + read), so a host without an
/// SFTP subsystem cannot stall the agent I/O loop.
pub const UPDATE_TOKEN_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound on a plausible token file; the agent writes 64 hex chars.
const MAX_TOKEN_LEN: usize = 1024;

/// The token-file path an agent advertised in its `initialize` result, if any.
///
/// Generic over the capabilities payload so both the initial connect (which
/// parses the desktop capabilities) and the reconnect path (which ignores them)
/// read it off the shared [`InitializeResult`] DTO (DUP-001, #3226). An empty
/// path reads as "none advertised".
pub fn token_path_from_initialize<C>(result: &InitializeResult<C>) -> Option<String> {
    result
        .update_auth_token_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(str::to_string)
}

/// Turn the raw token-file bytes into a token: trimmed, non-empty, UTF-8 and
/// of plausible length. Anything else yields `None`.
pub fn token_from_file_bytes(bytes: &[u8]) -> Option<UpdateAuthToken> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    if text.is_empty() || text.len() > MAX_TOKEN_LEN {
        return None;
    }
    Some(UpdateAuthToken(text.to_string()))
}

/// Read the agent's update auth token from `path` over `session`.
///
/// Best effort: a read failure is logged and yields `None`, which the agent
/// then refuses — the desktop never invents a token.
pub async fn read_update_auth_token(session: &SshSession, path: &str) -> Option<UpdateAuthToken> {
    match read_small_file_async(session, path, UPDATE_TOKEN_READ_TIMEOUT).await {
        Ok(bytes) => {
            let token = token_from_file_bytes(&bytes);
            if token.is_none() {
                warn!("agent update auth token file {path} is empty or malformed");
            }
            token
        }
        Err(e) => {
            warn!("could not read the agent update auth token from {path}: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Parse an `initialize` result the way the reconnect path does
    /// (capabilities ignored).
    fn parse(v: serde_json::Value) -> InitializeResult<serde::de::IgnoredAny> {
        serde_json::from_value(v).expect("initialize result parses")
    }

    #[test]
    fn token_path_is_read_from_the_initialize_result() {
        let result = parse(json!({
            "capabilities": {},
            "update_auth_token_path": "/home/u/.config/termihub-agent/t",
        }));
        assert_eq!(
            token_path_from_initialize(&result).as_deref(),
            Some("/home/u/.config/termihub-agent/t")
        );
    }

    #[test]
    fn an_older_agent_advertises_no_token_path() {
        assert_eq!(
            token_path_from_initialize(&parse(json!({ "capabilities": {} }))),
            None
        );
        assert_eq!(
            token_path_from_initialize(&parse(json!({
                "capabilities": {},
                "update_auth_token_path": "",
            }))),
            None
        );
        // A non-string path is a malformed result, not a path.
        assert!(
            serde_json::from_value::<InitializeResult<serde::de::IgnoredAny>>(json!({
                "capabilities": {},
                "update_auth_token_path": 7,
            }))
            .is_err()
        );
    }

    #[test]
    fn token_bytes_are_trimmed() {
        let token = token_from_file_bytes(b"abc123\n").expect("token");
        assert_eq!(token.expose(), "abc123");
    }

    #[test]
    fn empty_oversized_or_non_utf8_token_files_are_rejected() {
        assert!(token_from_file_bytes(b"").is_none());
        assert!(token_from_file_bytes(b"  \n").is_none());
        assert!(token_from_file_bytes(&[0xff, 0xfe]).is_none());
        assert!(token_from_file_bytes(&vec![b'a'; MAX_TOKEN_LEN + 1]).is_none());
    }
}
