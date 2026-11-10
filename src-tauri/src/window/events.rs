//! The events the multi-window commands push to the frontend (#5168).
//!
//! Every window-set / session-ownership / hand-off / quit-cancel notification
//! goes through [`WindowEventSink`]. Production implements it for
//! [`AppHandle`]; unit tests record the events instead, so the ownership
//! handshake's state-then-event ordering is testable without a webview.

use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use super::quit::QUIT_CANCELLED_EVENT;
use super::OwnershipSupersededPayload;

/// Broadcast when the set of open windows (or a window's tab count) changed.
pub const WINDOWS_CHANGED_EVENT: &str = "windows-changed";
/// Broadcast when the `session_id → window` ownership map changed (#1985).
pub const SESSION_OWNERSHIP_CHANGED_EVENT: &str = "session-ownership-changed";
/// Sent to the one window that just lost a session to another window (#3368).
pub const SESSION_OWNERSHIP_SUPERSEDED_EVENT: &str = "session-ownership-superseded";
/// Broadcast when a hand-off record was queued for an open window.
pub const WINDOW_HANDOFF_EVENT: &str = "window-handoff";
/// Broadcast when a secondary window's reported layout changed (#1925).
pub const WINDOW_LAYOUT_CHANGED_EVENT: &str = "window-layout-changed";

/// Receiver of the multi-window notifications.
///
/// Each method returns the emit error as a string so a command can choose to
/// propagate it (`?`) or only log it.
pub trait WindowEventSink {
    /// The window set, or a window's tab count, changed.
    fn windows_changed(&self) -> Result<(), String>;
    /// The session ownership map changed.
    fn session_ownership_changed(&self) -> Result<(), String>;
    /// Tell window `target` it lost a session (`payload`) to another window.
    fn session_ownership_superseded(
        &self,
        target: &str,
        payload: OwnershipSupersededPayload,
    ) -> Result<(), String>;
    /// A hand-off record was queued; every window drains its queue.
    fn window_handoff(&self) -> Result<(), String>;
    /// A secondary window's layout changed; the main window re-persists.
    fn window_layout_changed(&self) -> Result<(), String>;
    /// A pending explicit quit was cancelled (#4296).
    fn quit_cancelled(&self) -> Result<(), String>;
}

impl<R: Runtime> WindowEventSink for AppHandle<R> {
    fn windows_changed(&self) -> Result<(), String> {
        self.emit(WINDOWS_CHANGED_EVENT, ())
            .map_err(|e| e.to_string())
    }

    fn session_ownership_changed(&self) -> Result<(), String> {
        self.emit(SESSION_OWNERSHIP_CHANGED_EVENT, ())
            .map_err(|e| e.to_string())
    }

    fn session_ownership_superseded(
        &self,
        target: &str,
        payload: OwnershipSupersededPayload,
    ) -> Result<(), String> {
        self.emit_to(
            EventTarget::labeled(target),
            SESSION_OWNERSHIP_SUPERSEDED_EVENT,
            payload,
        )
        .map_err(|e| e.to_string())
    }

    fn window_handoff(&self) -> Result<(), String> {
        self.emit(WINDOW_HANDOFF_EVENT, ())
            .map_err(|e| e.to_string())
    }

    fn window_layout_changed(&self) -> Result<(), String> {
        self.emit(WINDOW_LAYOUT_CHANGED_EVENT, ())
            .map_err(|e| e.to_string())
    }

    fn quit_cancelled(&self) -> Result<(), String> {
        self.emit(QUIT_CANCELLED_EVENT, ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    /// The production sink emits each notification under its wire name — the
    /// names the frontend `listen()`s on.
    #[test]
    fn app_handle_sink_emits_the_wire_event_names() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        for name in [
            WINDOWS_CHANGED_EVENT,
            SESSION_OWNERSHIP_CHANGED_EVENT,
            SESSION_OWNERSHIP_SUPERSEDED_EVENT,
            WINDOW_HANDOFF_EVENT,
            WINDOW_LAYOUT_CHANGED_EVENT,
            QUIT_CANCELLED_EVENT,
        ] {
            let seen = seen.clone();
            handle.listen_any(name, move |_| seen.lock().unwrap().push(name.to_string()));
        }

        handle.windows_changed().unwrap();
        handle.session_ownership_changed().unwrap();
        handle
            .session_ownership_superseded(
                "main",
                OwnershipSupersededPayload {
                    session_id: "s1".into(),
                    new_owner: "win-1".into(),
                },
            )
            .unwrap();
        handle.window_handoff().unwrap();
        handle.window_layout_changed().unwrap();
        handle.quit_cancelled().unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![
                "windows-changed",
                "session-ownership-changed",
                // A labeled emit still reaches an `any` listener.
                "session-ownership-superseded",
                "window-handoff",
                "window-layout-changed",
                "app-quit-cancelled",
            ]
        );
    }
}
