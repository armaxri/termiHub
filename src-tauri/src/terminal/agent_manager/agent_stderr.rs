//! Desktop side of the agent's structured stderr log side-band (#2854, OBS-004).
//!
//! The `--stdio` agent writes each of its `tracing` records to stderr as one
//! framed line ([`termihub_agent::log_frame`]). This module reassembles those
//! lines from the SSH channel's `ExtendedData` chunks and **re-emits each record
//! into the desktop's tracing pipeline at its real level**, carrying the agent
//! target, timestamp, structured fields and the desktop correlation id — instead
//! of flattening every line into one desktop-side `WARN`.
//!
//! `tracing` targets are static per callsite, so re-emitted records share the
//! target [`AGENT_REEMIT_TARGET`] and carry the agent's real target in the
//! `agent_target` field. The LogViewer's capture layer
//! ([`crate::utils::log_capture`]) substitutes that field back in as the entry's
//! target; `termihub.log` shows it as a field.
//!
//! Anything on stderr that is not a framed record — a panic, a C library print,
//! output from an older agent — is still logged as `agent process stderr` at
//! `WARN`, one line at a time, exactly as before.
//!
//! Hygiene: every string is control-character-escaped and length-capped so an
//! agent record can never forge a desktop log line, secret-named fields are
//! re-redacted (defense in depth over the agent's own redaction), and the
//! correlation id is only carried when well-formed.

use termihub_core::protocol::log_frame::{self, LogFrame, StderrLine};
use termihub_core::protocol::methods::is_valid_correlation_id;
use tracing::{warn, Level};

use crate::utils::log_capture::AGENT_REEMIT_TARGET;

/// Longest partial line held while waiting for its newline. Past this the
/// pending bytes are emitted as-is, so a newline-free stream cannot grow the
/// buffer without bound.
pub(super) const MAX_PENDING_BYTES: usize = 64 * 1024;

/// Cap for one re-emitted value (target, timestamp, one field).
const MAX_VALUE_BYTES: usize = log_frame::MAX_FIELD_BYTES;

/// Reassembles an agent's stderr byte stream into lines and re-emits each one.
pub(super) struct AgentStderr {
    agent_id: String,
    pending: Vec<u8>,
}

impl AgentStderr {
    /// A decoder for the agent identified by `agent_id` in desktop logs.
    pub(super) fn new(agent_id: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            pending: Vec::new(),
        }
    }

    /// Feed one `ExtendedData` chunk; re-emits every line it completes.
    pub(super) fn push(&mut self, data: &[u8]) {
        self.pending.extend_from_slice(data);
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            reemit_line(&self.agent_id, &String::from_utf8_lossy(&line));
        }
        if self.pending.len() > MAX_PENDING_BYTES {
            self.flush();
        }
    }

    /// Re-emit whatever partial line is still pending (channel closed, or a
    /// one-shot decode during the handshake).
    pub(super) fn flush(&mut self) {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            reemit_line(&self.agent_id, &String::from_utf8_lossy(&line));
        }
    }
}

impl Drop for AgentStderr {
    /// A trailing partial line (the agent died mid-write) is still logged.
    fn drop(&mut self) {
        self.flush();
    }
}

/// Re-emit one stderr line (framed or not) into the desktop tracing pipeline.
pub(super) fn reemit_line(agent_id: &str, line: &str) {
    match log_frame::parse_line(line) {
        StderrLine::Framed(frame) => reemit_frame(agent_id, &frame),
        StderrLine::Unframed(text) => {
            if !text.trim().is_empty() {
                warn!(
                    agent_id = %agent_id,
                    "agent process stderr: {}",
                    sanitize(&text, log_frame::MAX_MESSAGE_BYTES)
                );
            }
        }
    }
}

/// The desktop level a framed record is re-emitted at. An unknown level (a
/// newer agent) is surfaced as `WARN`, as unframed stderr always was.
pub(super) fn frame_level(level: &str) -> Level {
    match level.trim().to_ascii_uppercase().as_str() {
        "ERROR" => Level::ERROR,
        "WARN" | "WARNING" => Level::WARN,
        "INFO" => Level::INFO,
        "DEBUG" => Level::DEBUG,
        "TRACE" => Level::TRACE,
        _ => Level::WARN,
    }
}

/// Render the record's fields as `key=value` pairs, sanitized and with
/// secret-named fields redacted. `None` when there are no fields.
pub(super) fn render_fields(frame: &LogFrame) -> Option<String> {
    let rendered: Vec<String> = frame
        .fields
        .iter()
        .take(log_frame::MAX_FIELDS)
        .map(|(k, v)| {
            let key = sanitize(k, 64);
            let value = if log_frame::is_secret_field(k) {
                log_frame::REDACTED.to_string()
            } else {
                sanitize(v, MAX_VALUE_BYTES)
            };
            format!("{key}={value}")
        })
        .collect();
    (!rendered.is_empty()).then(|| rendered.join(" "))
}

/// Escape control characters (other than tab) and cap the length, so an agent
/// string cannot break a desktop log line or forge a new one.
pub(super) fn sanitize(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max));
    for c in s.chars() {
        if c.is_control() && c != '\t' {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    log_frame::truncate(out, max)
}

fn reemit_frame(agent_id: &str, frame: &LogFrame) {
    let target = sanitize(&frame.target, MAX_VALUE_BYTES);
    let ts = sanitize(&frame.ts, 64);
    let msg = sanitize(&frame.msg, log_frame::MAX_MESSAGE_BYTES);
    let cid = frame
        .cid
        .as_deref()
        .filter(|id| is_valid_correlation_id(id));
    let fields = render_fields(frame);
    let fields = fields.as_deref();

    macro_rules! reemit {
        ($level:expr) => {
            tracing::event!(
                target: AGENT_REEMIT_TARGET,
                $level,
                agent_id = %agent_id,
                agent_target = %target,
                agent_ts = %ts,
                correlation_id = cid,
                agent_fields = fields,
                "{}",
                msg
            )
        };
    }

    match frame_level(&frame.level) {
        Level::ERROR => reemit!(Level::ERROR),
        Level::WARN => reemit!(Level::WARN),
        Level::INFO => reemit!(Level::INFO),
        Level::DEBUG => reemit!(Level::DEBUG),
        _ => reemit!(Level::TRACE),
    }
}

#[cfg(test)]
#[path = "agent_stderr_tests.rs"]
mod tests;
