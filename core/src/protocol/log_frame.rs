//! Wire format of the agent's structured stderr log side-band (#2854, OBS-004).
//!
//! In `--stdio` mode the agent's **stdout** carries the JSON-RPC protocol and its
//! **stderr** is captured by the desktop over the same SSH exec channel. The
//! agent writes each `tracing` record to stderr as **one framed line**:
//!
//! ```text
//! @termihub-log/1 {"ts":"…","level":"INFO","target":"termihub_agent::…","msg":"…","cid":"…","fields":{…}}
//! ```
//!
//! - [`FRAME_PREFIX`] (`@termihub-log/`) followed by the framing version, one
//!   space, then a single-line JSON [`LogFrame`]. JSON escapes every newline, so
//!   a record can never span lines.
//! - `cid` is the desktop's **correlation id** (its own session id, #3085) hoisted
//!   from the enclosing `agent_session` span, so the desktop re-emits the record
//!   with a `correlation_id` field that joins its own `termihub.log` lines.
//! - Anything on stderr that does **not** carry the prefix — a panic message, a C
//!   library print, a pre-tracing `eprintln!` — is an *unframed* line and passes
//!   through exactly as before ([`StderrLine::Unframed`]).
//! - A framed line of an unknown version, or with a malformed body, degrades to
//!   an unframed line rather than being dropped (forward compatibility).
//!
//! The framing is stderr-only: stdout (the JSON-RPC channel) is never touched.
//! This module is the shared wire contract: the agent's encoder layer
//! (`termihub_agent::log_frame`) writes it and the desktop parses it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::diagnostics::redact::{is_secret_key_name, secret_key_terms};

/// Marker that starts every framed stderr line, followed by [`FRAME_VERSION`]
/// and a single space.
pub const FRAME_PREFIX: &str = "@termihub-log/";

/// The framing version this build writes and understands.
pub const FRAME_VERSION: u32 = 1;

/// Replacement value for a field whose name marks it as a secret.
pub const REDACTED: &str = "[REDACTED]";

/// Upper bound on a record's message, in bytes, before it is truncated.
pub const MAX_MESSAGE_BYTES: usize = 4096;

/// Upper bound on one field value, in bytes, before it is truncated.
pub const MAX_FIELD_BYTES: usize = 1024;

/// Upper bound on the number of fields carried by one record.
pub const MAX_FIELDS: usize = 32;

/// Name of the span/event field hoisted into [`LogFrame::cid`].
pub const CORRELATION_FIELD: &str = "correlation_id";

/// One agent `tracing` record as carried over the stderr side-band.
///
/// Unknown JSON members are ignored when parsing, so a newer agent may add
/// members without breaking an older desktop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogFrame {
    /// RFC 3339 UTC timestamp the agent recorded the event at.
    pub ts: String,
    /// `ERROR` / `WARN` / `INFO` / `DEBUG` / `TRACE`.
    pub level: String,
    /// The event's `tracing` target on the agent (e.g. `termihub_agent::io::stdio`).
    pub target: String,
    /// The formatted message.
    pub msg: String,
    /// The desktop correlation id the record was produced under, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    /// The event's own fields merged over its enclosing spans' fields.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

/// A classified stderr line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StderrLine {
    /// A structured agent log record.
    Framed(LogFrame),
    /// Any other stderr output, passed through verbatim (trailing CR/LF removed).
    Unframed(String),
}

/// Encode `frame` as one stderr line, **without** the trailing newline.
pub fn encode_line(frame: &LogFrame) -> String {
    // Serializing a struct of strings cannot fail; fall back to an unframed
    // rendering rather than panicking if it ever did.
    match serde_json::to_string(frame) {
        Ok(json) => format!("{FRAME_PREFIX}{FRAME_VERSION} {json}"),
        Err(_) => format!("{} {}: {}", frame.level, frame.target, frame.msg),
    }
}

/// Classify one stderr line (with or without its trailing newline).
///
/// A line is [`StderrLine::Framed`] only when it carries [`FRAME_PREFIX`], the
/// supported [`FRAME_VERSION`], and a well-formed [`LogFrame`] body. Everything
/// else — including a framed line of a future version — is returned unframed so
/// it is still logged rather than lost.
pub fn parse_line(line: &str) -> StderrLine {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(rest) = line.strip_prefix(FRAME_PREFIX) {
        if let Some((version, body)) = rest.split_once(' ') {
            if version.parse::<u32>().ok() == Some(FRAME_VERSION) {
                if let Ok(frame) = serde_json::from_str::<LogFrame>(body) {
                    return StderrLine::Framed(frame);
                }
            }
        }
    }
    StderrLine::Unframed(line.to_string())
}

/// Whether a field named `name` holds a secret and must never be logged.
///
/// Driven by the shared secret-word list `src/data/secret-key-words.json`
/// (#4701) that the free-text redactors also use, so every word they mask is a
/// secret field name here too. A name is secret when:
///
/// - the shared key pattern matches it whole, or any `.`-separated segment
///   ([`is_secret_key_name`]): `ssh_password`, `sshPassword`, `X-Auth-Token`,
///   `sshpassword`, `pin`, `otps`;
/// - any `_`/`-`/`.`-separated or camelCase component, lowercased and with an
///   optional plural `s`, is a shared word: `token_count`, `pin_code`,
///   `cookie.jar`, `credentials`; or
/// - it ends in a shared compound term (`private_key`, `myApiKey`) or is one of
///   the legacy whole names (`authorization`, `apikey`, `privatekey`).
///
/// `session_id`, `keyCount`, `spinner` and `options` are not secret.
pub fn is_secret_field(name: &str) -> bool {
    let normalized = snake_case(name).replace(['-', '.'], "_");
    if WHOLE_SECRET_NAMES.contains(&normalized.as_str()) {
        return true;
    }
    let parts: Vec<&str> = normalized.split('_').filter(|p| !p.is_empty()).collect();
    let is_word = |part: &str, word: &str| {
        part == word || part.strip_suffix('s').is_some_and(|stem| stem == word)
    };
    let terms = secret_key_terms();
    let word_hit = parts.iter().any(|part| {
        terms
            .iter()
            .any(|t| t.len() == 1 && is_word(part, t[0].as_str()))
    });
    let compound_hit = terms.iter().filter(|t| t.len() > 1).any(|t| {
        let joined = t.join("_");
        normalized.ends_with(&joined) || normalized.ends_with(&format!("{joined}s"))
    });
    word_hit || compound_hit || is_secret_key_name(name) || terms.is_empty()
}

/// Whole normalized names that are secret although no single component is a
/// shared word (`apikey` / `privatekey` glue a compound term, `authorization`
/// carries a credential).
const WHOLE_SECRET_NAMES: &[&str] = &[
    "privatekey",
    "apikey",
    "secretkey",
    "accesskey",
    "authorization",
];

/// `name` lowercased, with a `_` at every lower-to-upper camelCase boundary
/// (`sshPassword` → `ssh_password`).
fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    let mut prev_lower = false;
    for ch in name.chars() {
        if ch.is_ascii_uppercase() && prev_lower {
            out.push('_');
        }
        prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        out.push(ch.to_ascii_lowercase());
    }
    out
}

/// Truncate `s` to at most `max` bytes on a char boundary, marking the cut.
pub fn truncate(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push('…');
    s
}

#[cfg(test)]
#[path = "log_frame_tests.rs"]
mod tests;
