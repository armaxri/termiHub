//! Desktop [`OutputSink`] adapter for the shared core output pump (DUP-011).
//!
//! [`TerminalOutputSink`] is the desktop runtime's implementation of the core
//! [`OutputSink`] trait: it mirrors each forwarded batch into the session's
//! scrollback capture buffer (#1900) and transcript logger (#1960), then emits
//! it to the webview via the injected [`EventEmitter`]. It is the delivery
//! target injected into [`run_output_pump`](termihub_core::session::pump::run_output_pump)
//! by `SessionManager::run_output_reader`, replacing the three inlined
//! `capture_bytes` + `log_output` + `emit_output` calls that the reader used to
//! perform on the hot path.
//!
//! The sink covers **only** output delivery. Session exit remains the reader's
//! `emit_and_cleanup` responsibility (the exit event + genuine-drop fold, #2439
//! — the DUP-010 seam), so [`OutputSink::send_exit`] and
//! [`OutputSink::send_error`] are inert here.

use std::io;

use termihub_core::buffer::RingBuffer;
use termihub_core::errors::SessionError;
use termihub_core::session::traits::OutputSink;

use std::sync::{Arc, Mutex as StdMutex};

use super::manager::{EventEmitter, SessionLoggers, SessionManager, TerminalOutputEvent};

/// Desktop output sink: capture + log + emit for one live session.
///
/// One instance is built per output-reader task and moved into the shared pump.
/// It owns cheap clones of the manager's per-session capture buffer, transcript
/// logger map, and the event emitter, so the reader still holds its own copies
/// for the end-of-stream `emit_and_cleanup` settle.
pub(super) struct TerminalOutputSink<E: EventEmitter> {
    /// The session this sink delivers for. Matches the `session_id` the pump
    /// passes on every `send_output`; used to key the transcript logger and to
    /// stamp the emitted [`TerminalOutputEvent`].
    session_id: String,
    /// Webview event delivery.
    emitter: E,
    /// The session's 1 MiB scrollback capture ring (#1900).
    capture: Arc<StdMutex<RingBuffer>>,
    /// The active-transcript-logger registry (#1960); looked up per batch so
    /// logging can start/stop mid-session.
    session_loggers: SessionLoggers,
}

impl<E: EventEmitter> TerminalOutputSink<E> {
    /// Build a sink for `session_id` from the reader's owned handles.
    pub(super) fn new(
        session_id: String,
        emitter: E,
        capture: Arc<StdMutex<RingBuffer>>,
        session_loggers: SessionLoggers,
    ) -> Self {
        Self {
            session_id,
            emitter,
            capture,
            session_loggers,
        }
    }
}

impl<E: EventEmitter> OutputSink for TerminalOutputSink<E> {
    fn send_output(&self, session_id: &str, data: Vec<u8>) -> Result<(), SessionError> {
        // Mirror the exact hot-path triple the reader used to inline: capture
        // for scrollback replay, append to the transcript, then emit.
        SessionManager::capture_bytes(&self.capture, &data);
        SessionManager::log_output(&self.session_loggers, session_id, &data);
        let event = TerminalOutputEvent {
            session_id: self.session_id.clone(),
            data,
        };
        if self.emitter.emit_output(&event) {
            Ok(())
        } else {
            // The webview closed: signal the pump to stop, mirroring the
            // original `if !emit_output { ... }` guard.
            Err(SessionError::Io(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "webview output sink closed",
            )))
        }
    }

    fn send_exit(&self, _session_id: &str, _exit_code: Option<i32>) -> Result<(), SessionError> {
        // Exit is settled by the reader's `emit_and_cleanup` (the DUP-010 seam),
        // not by the pump — inert here.
        Ok(())
    }

    fn send_error(&self, _session_id: &str, _message: &str) -> Result<(), SessionError> {
        // Session-level errors are not routed through the output pump.
        Ok(())
    }
}
