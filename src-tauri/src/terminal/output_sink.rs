//! Tauri event-based implementation of the core [`OutputSink`] trait.
//!
//! Bridges the shared session engine to the Tauri webview frontend by
//! emitting terminal output, exit, and error events over the Tauri event bus.

use std::io;

use tauri::{Emitter, Manager};

use termihub_core::errors::SessionError;
use termihub_core::session::traits::OutputSink;

use crate::terminal::backend::{TerminalErrorEvent, TerminalExitEvent, TerminalOutputEvent};

/// Delivers terminal session events to the Tauri frontend via the event bus.
///
/// Wraps a `tauri::AppHandle` and emits:
/// - `"terminal-output"` with [`TerminalOutputEvent`]
/// - `"terminal-exit"` with [`TerminalExitEvent`]
/// - `"terminal-error"` with [`TerminalErrorEvent`]
///
/// Emit failures are mapped to `SessionError::Io(BrokenPipe)` since a Tauri
/// emit failure typically means the webview is no longer reachable.
pub struct TauriOutputSink {
    app_handle: tauri::AppHandle,
}

impl TauriOutputSink {
    /// Create a new output sink backed by the given Tauri app handle.
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

impl OutputSink for TauriOutputSink {
    fn send_output(&self, session_id: &str, data: Vec<u8>) -> Result<(), SessionError> {
        let event = TerminalOutputEvent {
            session_id: session_id.to_string(),
            data,
        };
        self.app_handle
            .emit("terminal-output", &event)
            .map_err(|_| {
                SessionError::Io(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "Tauri emit failed for terminal-output",
                ))
            })
    }

    fn send_exit(&self, session_id: &str, exit_code: Option<i32>) -> Result<(), SessionError> {
        let event = TerminalExitEvent {
            session_id: session_id.to_string(),
            exit_code,
        };
        self.app_handle
            .emit("terminal-exit", &event)
            .map_err(|_| {
                SessionError::Io(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "Tauri emit failed for terminal-exit",
                ))
            })
    }

    fn send_error(&self, session_id: &str, message: &str) -> Result<(), SessionError> {
        let event = TerminalErrorEvent {
            session_id: session_id.to_string(),
            message: message.to_string(),
        };
        self.app_handle
            .emit("terminal-error", &event)
            .map_err(|_| {
                SessionError::Io(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "Tauri emit failed for terminal-error",
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time verification that `TauriOutputSink` satisfies the
    /// `OutputSink` trait bounds (`Send + 'static`).
    fn _assert_output_sink_bounds<T: OutputSink>() {}

    #[test]
    fn tauri_output_sink_satisfies_trait_bounds() {
        _assert_output_sink_bounds::<TauriOutputSink>();
    }
}
