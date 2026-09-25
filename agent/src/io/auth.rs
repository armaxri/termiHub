//! Per-instance authentication for the `--listen` TCP transport (AGT-002 / SEC-004).
//!
//! The `--listen` TCP listener was historically **unauthenticated**: any local
//! process that could reach the port (default `127.0.0.1:7685`, deployed as a
//! systemd service) got full agent access — the whole JSON-RPC surface — and,
//! because the `SessionManager` is shared across sequential connections, could
//! even reach sessions opened by a previous client. This module closes that hole
//! with a per-instance bearer token that a client must present, as the very
//! first message on the connection, before **any** JSON-RPC method is
//! dispatched.
//!
//! # Wire protocol
//!
//! Immediately after the TCP connection is accepted the client MUST send a
//! single NDJSON line — a JSON-RPC request naming the [`AUTH_METHOD`] method with
//! the token in `params.token` — and wait for the response before sending
//! anything else:
//!
//! ```text
//! → {"jsonrpc":"2.0","id":0,"method":"auth","params":{"token":"<token>"}}
//! ← {"jsonrpc":"2.0","id":0,"result":{"authenticated":true}}      // then proceed
//! ← {"jsonrpc":"2.0","id":0,"error":{"code":-32021,"message":...}} // then the socket closes
//! ```
//!
//! On a missing, malformed, or wrong token the agent writes the error line (best
//! effort) and **closes the connection** — fail closed, no session/RPC access,
//! nothing dispatched. Each sequential client re-authenticates.
//!
//! # Trust boundary
//!
//! The token is generated fresh on every agent start and written to a `0600`
//! file next to `state.json` (owner-only on unix; under the per-user profile ACL
//! on Windows — see [`token_file_path`]). Only a process running as the agent's
//! own user can read it, so a *different* local user, or a sandboxed / remote
//! peer that can open the loopback port but cannot read the owner's files, can no
//! longer drive the agent. Same-user processes are already inside the trust
//! boundary. This mirrors the token-file pattern used by editor/server agents
//! (Jupyter, VS Code Server).
//!
//! Only the TCP `--listen` path uses this. The `--stdio` and SSH-exec transports
//! are unchanged: their trust derives from the pipe / SSH channel already being
//! owned by the launching process.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tracing::{debug, info, warn};
use uuid::Uuid;

use termihub_core::ipc::{read_line_resumable, write_line, LineOutcome};

/// The JSON-RPC method a client must call, as its first message, to
/// authenticate a `--listen` TCP connection.
pub const AUTH_METHOD: &str = "auth";

/// Filename of the per-instance token file written next to `state.json`.
const TOKEN_FILE_NAME: &str = "listen-auth.token";

/// JSON-RPC error code returned when authentication fails.
///
/// Defined locally (rather than in the shared `termihub_core::protocol::errors`
/// enum) because this is a **transport-level, pre-RPC** rejection specific to the
/// `--listen` path — it is refused before the method dispatcher ever runs. It
/// uses the next free application-error slot after the dispatcher's codes
/// (`…-32020`), in the JSON-RPC implementation-defined range `-32000..=-32099`.
const UNAUTHORIZED_CODE: i64 = -32021;

/// Cap on the auth line. The auth request is tiny (a token plus JSON-RPC
/// envelope), so a small cap bounds how much an unauthenticated peer can make the
/// agent buffer before it has proven itself — far below the 1 MiB protocol limit
/// the post-auth transport loop allows.
const AUTH_MAX_LINE: usize = 64 * 1024;

/// Result of the pre-RPC auth handshake.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthOutcome {
    /// The client presented the correct token; proceed to the transport loop.
    Authenticated,
    /// The client did not authenticate; the caller must close the connection
    /// without dispatching any RPC.
    Rejected,
}

/// A per-instance auth token guarding the `--listen` TCP transport.
///
/// Only the SHA-256 digest of the token is retained in memory; the plaintext
/// lives just long enough to be written to its `0600` file at startup. Candidate
/// tokens are checked by hashing them to the same fixed-length digest and
/// comparing in constant time (see [`ListenAuthToken::verify`]).
#[derive(Clone)]
pub struct ListenAuthToken {
    digest: [u8; 32],
}

impl ListenAuthToken {
    /// Build a token guard from a known plaintext (its digest is stored).
    fn from_plaintext(token: &str) -> Self {
        Self {
            digest: Sha256::digest(token.as_bytes()).into(),
        }
    }

    /// Generate a fresh per-instance token, persist it to its `0600` file next
    /// to `state.json`, and return the guard (holding only the digest).
    ///
    /// Call this once, at `--listen` startup, **before** the listener binds — so
    /// that by the time the port is connectable the token file already exists for
    /// the legitimate launcher to read.
    pub fn generate_and_persist() -> Result<Self> {
        let (token, _plaintext) =
            Self::generate_and_persist_in(&crate::state::persistence::AgentState::config_dir())?;
        Ok(token)
    }

    /// Path-injectable core of [`generate_and_persist`], returning the plaintext
    /// too so tests can assert the persisted value. Not used in production, which
    /// discards the plaintext.
    ///
    /// [`generate_and_persist`]: ListenAuthToken::generate_and_persist
    fn generate_and_persist_in(dir: &Path) -> Result<(Self, String)> {
        let token = generate_token_string();
        let path = dir.join(TOKEN_FILE_NAME);
        write_token_file(&path, &token)
            .with_context(|| format!("failed to write listen auth token to {}", path.display()))?;
        info!("--listen auth token written to {}", path.display());
        Ok((Self::from_plaintext(&token), token))
    }

    /// Constant-time check of a presented candidate token.
    ///
    /// The candidate is first reduced to a fixed-length SHA-256 digest and
    /// compared to the stored digest in constant time, so neither the token's
    /// length nor how many leading bytes match can leak through timing.
    pub fn verify(&self, candidate: &str) -> bool {
        let candidate_digest = Sha256::digest(candidate.as_bytes());
        ct_eq(&self.digest, candidate_digest.as_slice())
    }
}

/// The path the per-instance token file is written to.
///
/// Resolves to `<agent config dir>/listen-auth.token`, honoring `XDG_CONFIG_HOME`
/// exactly as `state.json` does (so an integration test can point it at a
/// throwaway dir). On unix the file is created `0600`; on Windows it inherits the
/// per-user `%APPDATA%` profile ACL, which already restricts it to the owner.
pub fn token_file_path() -> PathBuf {
    crate::state::persistence::AgentState::config_dir().join(TOKEN_FILE_NAME)
}

/// Best-effort removal of the token file (called on graceful shutdown).
///
/// A stale file from a crashed agent is harmless — the next `--listen` start
/// overwrites it before the port is connectable — so removal is only hygiene and
/// a failure is logged, never fatal.
pub fn remove_token_file() {
    let path = token_file_path();
    match std::fs::remove_file(&path) {
        Ok(()) => debug!("removed --listen auth token file {}", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => warn!(
            "failed to remove --listen auth token file {}: {e}",
            path.display()
        ),
    }
}

/// Generate a fresh random token as a 64-character lowercase hex string.
///
/// The bytes come from two v4 UUIDs — the `uuid` crate draws v4 randomness from
/// the OS CSPRNG (`getrandom`). Two UUIDs yield 32 bytes carrying ~244 bits of
/// entropy (each v4 UUID fixes 6 of its 128 bits for version/variant), far beyond
/// any brute-force reach for a bearer token and comfortably past the 128-bit
/// security target. Using `uuid` keeps this to a RNG already vetted and present
/// in the tree.
fn generate_token_string() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    hex::encode(bytes)
}

/// Constant-time equality of two byte slices.
///
/// Both callers pass SHA-256 digests, so the slices are always 32 bytes and the
/// length guard never varies with secret content. The XOR-accumulate visits every
/// byte with no early exit, and [`std::hint::black_box`] stops the optimizer from
/// short-circuiting the fold — so the comparison time is independent of where (or
/// whether) the inputs first differ.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

/// Write `token` to `path`, creating it owner-only and durably.
///
/// Uses the shared atomic write (temp file in the same dir → `fsync` → rename)
/// so a concurrent reader — e.g. a client re-reading the token the instant a
/// re-execed agent rewrites it — never observes a truncated or empty file, only
/// the complete old or complete new token. On unix the file is then tightened to
/// `0600` (the `tempfile` source is already `0600`, and the rename preserves it,
/// but the mode is set explicitly so the owner-only guarantee never depends on
/// that implementation detail — mirroring `state.json`'s handling). On Windows
/// the file lives under `%APPDATA%`, whose NTFS ACL already restricts it to the
/// owner's profile, and there is no `chmod` analog to apply.
fn write_token_file(path: &Path, token: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create token dir {}", parent.display()))?;
    }
    crate::fs::write_atomic(path, token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to chmod token file {}", path.display()))?;
    }
    Ok(())
}

/// Run the pre-RPC auth handshake on a freshly-accepted `--listen` connection.
///
/// Reads exactly one NDJSON line, verifies it is a well-formed [`AUTH_METHOD`]
/// request carrying the correct token, and writes the JSON-RPC response. Returns
/// [`AuthOutcome::Authenticated`] only when the token verifies; every other case
/// (EOF before any line, an over-cap line, non-JSON, wrong method, missing or
/// wrong token) returns [`AuthOutcome::Rejected`] after best-effort writing an
/// error line, and the caller must then close the connection without dispatching
/// any RPC.
///
/// This function does **not** impose a timeout; the caller wraps it in one so a
/// silent peer cannot hold the single-client accept slot open indefinitely.
///
/// Any leftover bytes a client may have pipelined after the auth line remain
/// unconsumed in `reader`'s internal buffer (the resumable reader only consumes
/// through the first newline), so the post-auth transport loop reading from the
/// same `reader` sees them intact — no data is lost by using a fresh accumulator
/// there.
pub async fn authenticate_connection<R, W>(
    reader: &mut R,
    writer: &mut W,
    token: &ListenAuthToken,
) -> Result<AuthOutcome>
where
    R: AsyncBufReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut pending: Vec<u8> = Vec::new();
    let line = match read_line_resumable(reader, &mut pending, AUTH_MAX_LINE).await? {
        LineOutcome::Line(line) => line,
        LineOutcome::TooLarge => {
            debug!("--listen auth rejected: first line exceeded the auth size cap");
            let _ = write_error(writer, None, "auth message too large").await;
            return Ok(AuthOutcome::Rejected);
        }
        LineOutcome::Eof => {
            debug!("--listen connection closed before presenting an auth token");
            return Ok(AuthOutcome::Rejected);
        }
    };

    let trimmed = line.trim();
    let request: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => {
            debug!("--listen auth rejected: first line was not valid JSON");
            let _ = write_error(writer, None, "auth message was not valid JSON").await;
            return Ok(AuthOutcome::Rejected);
        }
    };

    // The `id` is echoed back on both success and error so the client can
    // correlate the response; default to null when absent or malformed.
    let id = request
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let method = request.get("method").and_then(|m| m.as_str());
    if method != Some(AUTH_METHOD) {
        debug!("--listen auth rejected: first message was not the `auth` method");
        let _ = write_error(
            writer,
            Some(id),
            "authentication required: send the `auth` method first",
        )
        .await;
        return Ok(AuthOutcome::Rejected);
    }

    let presented = request
        .get("params")
        .and_then(|p| p.get("token"))
        .and_then(|t| t.as_str());

    match presented {
        Some(candidate) if token.verify(candidate) => {
            write_ok(writer, id).await?;
            debug!("--listen client authenticated");
            Ok(AuthOutcome::Authenticated)
        }
        _ => {
            // Covers both a missing token and a wrong one; `verify` is
            // constant-time so the wrong-token branch does not leak match length.
            warn!("--listen auth rejected: missing or invalid token");
            let _ = write_error(writer, Some(id), "invalid or missing auth token").await;
            Ok(AuthOutcome::Rejected)
        }
    }
}

/// Write the success response for a completed auth handshake.
async fn write_ok<W>(writer: &mut W, id: serde_json::Value) -> Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "authenticated": true },
    });
    write_line(writer, &response.to_string()).await?;
    Ok(())
}

/// Write an auth error response (best effort; the caller closes the socket next).
async fn write_error<W>(writer: &mut W, id: Option<serde_json::Value>, message: &str) -> Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(serde_json::Value::Null),
        "error": { "code": UNAUTHORIZED_CODE, "message": message },
    });
    write_line(writer, &response.to_string()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    fn build_auth_line(token: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":7,"method":"auth","params":{{"token":"{token}"}}}}"#)
    }

    #[test]
    fn generated_tokens_are_per_instance_random() {
        // Two independent generations must differ — the token is per-instance.
        let a = generate_token_string();
        let b = generate_token_string();
        assert_ne!(a, b, "two generated tokens must differ");
        assert_eq!(a.len(), 64, "token is 32 bytes hex-encoded");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn verify_accepts_correct_and_rejects_wrong_token() {
        let token = ListenAuthToken::from_plaintext("s3cr3t-token-value");
        assert!(token.verify("s3cr3t-token-value"), "correct token accepted");
        assert!(
            !token.verify("s3cr3t-token-valuE"),
            "one-char diff rejected"
        );
        assert!(!token.verify(""), "empty token rejected");
        assert!(
            !token.verify("s3cr3t-token-value-longer"),
            "longer rejected"
        );
    }

    #[test]
    fn ct_eq_matches_only_identical_equal_length_slices() {
        assert!(ct_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2]));
    }

    #[test]
    fn generate_and_persist_writes_a_readable_token_file() {
        let dir = tempfile::tempdir().unwrap();
        let (token, plaintext) = ListenAuthToken::generate_and_persist_in(dir.path()).unwrap();

        let path = dir.path().join(TOKEN_FILE_NAME);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, plaintext, "file holds the generated token");
        assert!(token.verify(&on_disk), "the file's token verifies");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must be owner-only");
        }
    }

    #[tokio::test]
    async fn correct_token_authenticates() {
        let token = ListenAuthToken::from_plaintext("the-right-token");
        let input = format!("{}\n", build_auth_line("the-right-token"));
        let mut reader = BufReader::new(input.as_bytes());
        let mut out: Vec<u8> = Vec::new();

        let outcome = authenticate_connection(&mut reader, &mut out, &token)
            .await
            .unwrap();
        assert_eq!(outcome, AuthOutcome::Authenticated);

        let response: serde_json::Value =
            serde_json::from_slice(out.split(|&b| b == b'\n').next().unwrap()).unwrap();
        assert_eq!(response["result"]["authenticated"], true);
        assert_eq!(response["id"], 7);
    }

    #[tokio::test]
    async fn wrong_token_is_rejected() {
        let token = ListenAuthToken::from_plaintext("the-right-token");
        let input = format!("{}\n", build_auth_line("the-WRONG-token"));
        let mut reader = BufReader::new(input.as_bytes());
        let mut out: Vec<u8> = Vec::new();

        let outcome = authenticate_connection(&mut reader, &mut out, &token)
            .await
            .unwrap();
        assert_eq!(outcome, AuthOutcome::Rejected);

        let response: serde_json::Value =
            serde_json::from_slice(out.split(|&b| b == b'\n').next().unwrap()).unwrap();
        assert_eq!(response["error"]["code"], UNAUTHORIZED_CODE);
    }

    #[tokio::test]
    async fn missing_token_is_rejected() {
        let token = ListenAuthToken::from_plaintext("t");
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"auth\",\"params\":{}}\n";
        let mut reader = BufReader::new(input.as_bytes());
        let mut out: Vec<u8> = Vec::new();

        let outcome = authenticate_connection(&mut reader, &mut out, &token)
            .await
            .unwrap();
        assert_eq!(outcome, AuthOutcome::Rejected);
    }

    #[tokio::test]
    async fn non_auth_first_method_is_rejected() {
        // A client that skips auth and jumps straight to `initialize` is refused
        // with no RPC dispatched.
        let token = ListenAuthToken::from_plaintext("t");
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n";
        let mut reader = BufReader::new(input.as_bytes());
        let mut out: Vec<u8> = Vec::new();

        let outcome = authenticate_connection(&mut reader, &mut out, &token)
            .await
            .unwrap();
        assert_eq!(outcome, AuthOutcome::Rejected);
    }

    #[tokio::test]
    async fn eof_before_any_line_is_rejected_without_error_write() {
        // A peer that connects and immediately half-closes (e.g. the readiness
        // probe) yields a clean rejection and no error line.
        let token = ListenAuthToken::from_plaintext("t");
        let empty: &[u8] = b"";
        let mut reader = BufReader::new(empty);
        let mut out: Vec<u8> = Vec::new();

        let outcome = authenticate_connection(&mut reader, &mut out, &token)
            .await
            .unwrap();
        assert_eq!(outcome, AuthOutcome::Rejected);
        assert!(out.is_empty(), "no response is written on a bare EOF");
    }

    #[tokio::test]
    async fn malformed_json_first_line_is_rejected() {
        let token = ListenAuthToken::from_plaintext("t");
        let input = "not json at all\n";
        let mut reader = BufReader::new(input.as_bytes());
        let mut out: Vec<u8> = Vec::new();

        let outcome = authenticate_connection(&mut reader, &mut out, &token)
            .await
            .unwrap();
        assert_eq!(outcome, AuthOutcome::Rejected);
    }
}
