//! Forward the RDP sidecar's stderr into the desktop's tracing pipeline
//! (#4320, OBS2-003).
//!
//! The sidecar writes every `tracing` record to stderr as one plain line
//! (`LEVEL target: message fields`, no colour, no timestamp) and reports a
//! panic as one `ERROR` line. The helper used to inherit the desktop's stderr,
//! which a bundled GUI app does not have, so all of it — including the lines
//! that explain why a session ended — was lost. The desktop now pipes the
//! helper's stderr and re-emits each line here under the static target
//! [`SIDECAR_LOG_TARGET`], at the sidecar's own level, so it reaches
//! `termihub.log`, the Log Viewer and Export Diagnostics.
//!
//! Hygiene, mirroring the agent stderr side-band (#2854):
//!
//! - **Bounded lines.** One line is read up to [`MAX_LINE_BYTES`]; the rest of an
//!   over-long line is discarded, so a newline-free stream cannot grow memory.
//! - **Bounded rate.** At most [`LINES_PER_WINDOW`] lines are forwarded per
//!   [`RATE_WINDOW`]; the excess is counted and reported once as a single
//!   "suppressed" warning, so a log storm cannot flood the desktop log.
//! - **Sanitized.** Control characters are escaped, so a sidecar line can never
//!   forge a desktop log line.
//! - **Panics.** A line that reports a panic is always forwarded at `ERROR`
//!   (with `panic = true`), even past the rate budget, and the payload line
//!   that follows Rust's default `panicked at <location>:` header is attributed
//!   to the panic too.

use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, BufReader};
use tokio::time::Instant;
use tracing::Level;

/// The static `tracing` target every forwarded sidecar line is emitted under.
pub const SIDECAR_LOG_TARGET: &str = "termihub_rdp_sidecar";

/// Longest stderr line kept, in bytes; the rest of a longer line is dropped.
pub const MAX_LINE_BYTES: usize = 4096;

/// Lines forwarded per [`RATE_WINDOW`] before the excess is suppressed.
pub const LINES_PER_WINDOW: u32 = 200;

/// The rate-limit window.
pub const RATE_WINDOW: Duration = Duration::from_secs(10);

/// One sidecar stderr line, classified for re-emission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarLogLine {
    /// The desktop level the line is re-emitted at.
    pub level: Level,
    /// The sanitized message (the sidecar's level token stripped).
    pub message: String,
    /// Whether the line reports a sidecar panic.
    pub panic: bool,
}

/// What the forwarder emits for one input line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Forward {
    /// Emit this line.
    Line(SidecarLogLine),
    /// The budget for this window is spent; the line was counted and dropped.
    Suppressed,
    /// Blank line; nothing to emit.
    Skip,
}

/// Classifies sidecar stderr lines and applies the per-window rate budget.
///
/// Pure (time is passed in), so the bounds are unit-testable without a clock.
#[derive(Debug)]
pub struct SidecarStderr {
    window_start: Option<Instant>,
    forwarded_in_window: u32,
    suppressed: u64,
    /// The previous line was Rust's default `panicked at <location>:` header,
    /// so the next unformatted line is the panic payload.
    panic_payload_next: bool,
}

impl Default for SidecarStderr {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarStderr {
    /// A fresh forwarder with a full budget.
    pub fn new() -> Self {
        Self {
            window_start: None,
            forwarded_in_window: 0,
            suppressed: 0,
            panic_payload_next: false,
        }
    }

    /// Classify `raw` (one line, without its newline) at time `now`.
    ///
    /// Returns the count of lines suppressed in an earlier window alongside the
    /// verdict when a new window opens, so the caller can report them once.
    pub fn process(&mut self, raw: &str, now: Instant) -> (Forward, Option<u64>) {
        let mut reported = None;
        match self.window_start {
            Some(start) if now.duration_since(start) < RATE_WINDOW => {}
            _ => {
                self.window_start = Some(now);
                self.forwarded_in_window = 0;
                if self.suppressed > 0 {
                    reported = Some(std::mem::take(&mut self.suppressed));
                }
            }
        }

        let Some(line) = self.classify(raw) else {
            return (Forward::Skip, reported);
        };
        // A panic always gets through: it is the line that explains the crash.
        if !line.panic && self.forwarded_in_window >= LINES_PER_WINDOW {
            self.suppressed += 1;
            return (Forward::Suppressed, reported);
        }
        self.forwarded_in_window = self.forwarded_in_window.saturating_add(1);
        (Forward::Line(line), reported)
    }

    /// Lines suppressed in the current window and not yet reported; resets
    /// the count (used at EOF).
    pub fn take_suppressed(&mut self) -> u64 {
        std::mem::take(&mut self.suppressed)
    }

    fn classify(&mut self, raw: &str) -> Option<SidecarLogLine> {
        let trimmed = raw.trim_end_matches(['\r', '\n']);
        if trimmed.trim().is_empty() {
            return None;
        }
        let payload_of_panic = std::mem::take(&mut self.panic_payload_next);
        let (level, rest) = match split_level(trimmed) {
            Some((level, rest)) => (Some(level), rest),
            None => (None, trimmed.trim()),
        };
        let panic = rest.contains("panicked");
        if panic && level.is_none() && rest.trim_end().ends_with(':') {
            // Rust's default hook: `thread 'main' panicked at src/x.rs:1:2:`
            // followed by the payload on the next line.
            self.panic_payload_next = true;
        }
        let level = if panic || (payload_of_panic && level.is_none()) {
            Level::ERROR
        } else {
            // Unformatted output (a C library print, an `eprintln!`) is
            // surfaced as a warning, as the agent stderr side-band does.
            level.unwrap_or(Level::WARN)
        };
        Some(SidecarLogLine {
            level,
            message: sanitize(rest, MAX_LINE_BYTES),
            panic: panic || payload_of_panic,
        })
    }
}

/// Split the sidecar's leading level token (`ERROR` / `WARN` / `INFO` /
/// `DEBUG` / `TRACE`) off a formatted line.
fn split_level(line: &str) -> Option<(Level, &str)> {
    let line = line.trim_start();
    let (token, rest) = line.split_once(' ').unwrap_or((line, ""));
    let level = match token {
        "ERROR" => Level::ERROR,
        "WARN" => Level::WARN,
        "INFO" => Level::INFO,
        "DEBUG" => Level::DEBUG,
        "TRACE" => Level::TRACE,
        _ => return None,
    };
    Some((level, rest.trim()))
}

/// Escape control characters (other than tab) and cap the length at a char
/// boundary, so a sidecar string cannot break a desktop log line or forge one.
fn sanitize(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max));
    for c in s.chars() {
        let escape = c.is_control() && c != '\t';
        let width = if escape {
            c.escape_default().len()
        } else {
            c.len_utf8()
        };
        if out.len() + width > max {
            break;
        }
        if escape {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    out
}

/// Re-emit one classified line under [`SIDECAR_LOG_TARGET`].
pub fn emit(line: &SidecarLogLine) {
    let message = line.message.as_str();
    let panic = line.panic;
    macro_rules! reemit {
        ($level:expr) => {
            tracing::event!(target: SIDECAR_LOG_TARGET, $level, panic, "{}", message)
        };
    }
    match line.level {
        Level::ERROR => reemit!(Level::ERROR),
        Level::WARN => reemit!(Level::WARN),
        Level::INFO => reemit!(Level::INFO),
        Level::DEBUG => reemit!(Level::DEBUG),
        _ => reemit!(Level::TRACE),
    }
}

fn emit_suppressed(count: u64) {
    tracing::warn!(
        target: SIDECAR_LOG_TARGET,
        suppressed = count,
        "rdp sidecar log rate limit: suppressed {count} lines"
    );
}

/// Read one line of at most [`MAX_LINE_BYTES`] into `buf`, discarding the rest
/// of a longer line. `Ok(false)` at EOF.
async fn read_bounded_line<R>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<bool>
where
    R: AsyncBufRead + Unpin,
{
    buf.clear();
    let mut read_any = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(read_any);
        }
        read_any = true;
        let (chunk, found_newline) = match available.iter().position(|&b| b == b'\n') {
            Some(pos) => (&available[..pos], true),
            None => (available, false),
        };
        let room = MAX_LINE_BYTES.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
        let consumed = chunk.len() + usize::from(found_newline);
        reader.consume(consumed);
        if found_newline {
            return Ok(true);
        }
    }
}

/// Forward every line of the sidecar's stderr until EOF or a read error.
///
/// Generic over the reader so tests drive it from an in-memory pipe, standing
/// in for the real `ChildStderr`.
pub async fn forward_stderr<R>(stderr: R)
where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stderr);
    let mut state = SidecarStderr::new();
    let mut buf = Vec::new();
    while let Ok(true) = read_bounded_line(&mut reader, &mut buf).await {
        let raw = String::from_utf8_lossy(&buf);
        let (verdict, reported) = state.process(&raw, Instant::now());
        if let Some(count) = reported {
            emit_suppressed(count);
        }
        if let Forward::Line(line) = verdict {
            emit(&line);
        }
    }
    let count = state.take_suppressed();
    if count > 0 {
        emit_suppressed(count);
    }
}

#[cfg(test)]
#[path = "sidecar_log_tests.rs"]
mod tests;
