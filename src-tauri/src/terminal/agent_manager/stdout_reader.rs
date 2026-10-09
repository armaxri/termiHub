//! The desktop's one reader for the agent's JSON-RPC stdout (#4303).
//!
//! The agent writes newline-delimited JSON on stdout, which reaches the desktop
//! as russh `ChannelMsg::Data` chunks whose boundaries fall anywhere — inside a
//! line, and inside a multi-byte UTF-8 character. Every path that reads those
//! chunks (the handshake, reconnect, recovery and re-attach reads here, and the
//! steady-state I/O loop in `io_task`) frames them with one
//! [`LineSplitter`], which:
//!
//! - decodes only complete lines, so a character split across chunks survives
//!   (AGT2-001);
//! - caps a line at [`MAX_LINE_LEN`](termihub_core::ipc::ndjson::MAX_LINE_LEN)
//!   without ever buffering past it (AGT2-003);
//! - scans each byte once (no quadratic rescans or tail copies).
//!
//! An over-cap line is a protocol error: [`frame`] logs it and reports
//! [`AgentReadError::Frame`], and the caller tears the connection down.

use russh::ChannelMsg;
use termihub_core::ipc::ndjson::{LineError, LineSplitter};
use tracing::{debug, error, info, warn};

use super::agent_stderr;

/// Why reading the agent's stdout stopped.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum AgentReadError {
    /// The channel hit EOF or closed.
    #[error("agent channel closed")]
    Closed,
    /// The agent process exited.
    #[error("agent process exited with status {0}")]
    Exited(u32),
    /// The agent sent a line the desktop refuses to frame (over the size cap).
    #[error("agent sent an invalid stdout frame: {0}")]
    Frame(LineError),
}

/// What to do with one item from the [`LineSplitter`].
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Frame {
    /// A non-empty, trimmed JSON-RPC line.
    Line(String),
    /// Nothing to parse: a blank line, or a line that was not UTF-8 (logged and
    /// dropped, like any other unparseable line).
    Skip,
    /// The stream is broken; tear the connection down.
    Fatal(AgentReadError),
}

/// Classify one splitter item for `agent_id`, logging what is dropped.
pub(super) fn frame(agent_id: &str, item: Result<String, LineError>) -> Frame {
    match item {
        Ok(line) => {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                Frame::Skip
            } else if trimmed.len() == line.len() {
                Frame::Line(line)
            } else {
                Frame::Line(trimmed.to_string())
            }
        }
        Err(err @ LineError::InvalidUtf8(_)) => {
            warn!(agent_id, error = %err, "dropping a non-UTF-8 line from agent stdout");
            Frame::Skip
        }
        Err(err @ LineError::TooLong { .. }) => {
            error!(
                agent_id,
                error = %err,
                "agent stdout line over the size cap; closing the agent connection"
            );
            Frame::Fatal(AgentReadError::Frame(err))
        }
    }
}

/// Read the next JSON-RPC line from a russh channel outside the steady-state
/// I/O loop (handshake, reconnect, recovery, re-attach).
///
/// Lines already buffered in `lines` are returned first; only then is the
/// channel read. Bytes after the returned line **stay in `lines`** for the next
/// call. That matters when the caller skips pre-initialize notifications: a
/// notification and the initialize response can arrive in the same chunk, and
/// dropping the rest would lose the response.
///
/// Blank and non-UTF-8 lines are skipped. Fails with
/// [`AgentReadError::Closed`] / [`AgentReadError::Exited`] when the channel
/// closes or the agent exits (stderr is logged, not returned), and with
/// [`AgentReadError::Frame`] on an over-cap line.
pub(super) async fn read_handshake_line(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    lines: &mut LineSplitter,
) -> Result<String, AgentReadError> {
    loop {
        while let Some(item) = lines.next_line() {
            match frame(agent_id, item) {
                Frame::Line(line) => return Ok(line),
                Frame::Skip => {}
                Frame::Fatal(err) => return Err(err),
            }
        }
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                // Diagnostic for #2480: confirms the desktop is actually
                // receiving the agent's stdout (the initialize response) over the
                // SSH channel. A run that logs "awaiting response" but never this
                // means the bytes are not arriving — a transport/channel issue,
                // not the agent's initialize handler.
                info!(
                    "Agent {}: handshake received {} stdout byte(s) over the channel",
                    agent_id,
                    data.len()
                );
                // Lines are taken by the `next_line` loop above.
                lines.push(data);
            }
            Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                // stderr — re-emit the agent's framed log records at their real
                // level (#2854); never fails the handshake. Decoded per chunk:
                // the agent writes each record in one write, so a record is
                // not split across chunks in practice, and a split one still
                // degrades to plain `WARN` passthrough rather than being lost.
                let mut stderr = agent_stderr::AgentStderr::new(agent_id);
                stderr.push(data);
                stderr.flush();
            }
            Some(ChannelMsg::Eof) | None => {
                info!("Agent {}: channel EOF/closed during handshake", agent_id);
                return Err(AgentReadError::Closed);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                warn!(
                    "Agent {}: process exited with status {} during handshake",
                    agent_id, exit_status
                );
                return Err(AgentReadError::Exited(exit_status));
            }
            other => {
                // Any other channel message (window adjust, success, etc.). Logged
                // at DEBUG so a stalled handshake still shows what russh delivered.
                debug!("Agent {}: handshake channel message: {:?}", agent_id, other);
            }
        }
    }
}

#[cfg(test)]
#[path = "stdout_reader_tests.rs"]
mod tests;
