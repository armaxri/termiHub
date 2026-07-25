//! Multi-window Tauri commands (#1900).
//!
//! The frontend seam for the multi-window foundation: create native windows,
//! broker the `session_id → owning_window` ownership handshake, ferry tab
//! hand-off records between windows, and replay a session's scrollback into a
//! freshly re-parented view. See [`crate::window`] for the coordinator.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::session::manager::SessionManager;
use crate::utils::errors::TerminalError;
use crate::window::{HandoffRecord, WindowManager};

/// A window known to the app, as reported to the frontend window picker.
///
/// Kept intentionally minimal for the foundation — tab counts and display
/// names are frontend concerns layered on by the "Move to Window" UI (#1901)
/// and the status-bar affordance (#1902).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// The window's runtime label (`main`, `win-1`, …).
    pub label: String,
}

/// Open a new native window loading the same frontend bundle.
///
/// If a hand-off record is supplied it is queued for the new window, which
/// drains it on boot via [`take_pending_handoffs`]. Returns the new window's
/// unique label so the caller can address it.
///
/// Window creation is dispatched onto the main thread because some platforms
/// (notably Linux/GTK) require it there.
#[tauri::command]
pub fn open_window(
    app: AppHandle,
    window_manager: State<'_, WindowManager>,
    handoff: Option<HandoffRecord>,
) -> Result<String, String> {
    let label = window_manager.next_label();
    if let Some(record) = handoff {
        window_manager.queue_handoff(&label, record);
    }

    let app_for_build = app.clone();
    let label_for_build = label.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = WebviewWindowBuilder::new(
            &app_for_build,
            &label_for_build,
            WebviewUrl::App("index.html".into()),
        )
        .title("termiHub")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()
        {
            tracing::error!("Failed to create window {label_for_build}: {e}");
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(label)
}

/// Claim `session_id` for the **calling** window (the grant side of the
/// ownership handshake). Returns the previous owner, if any.
#[tauri::command]
pub fn claim_session(
    session_id: String,
    window: WebviewWindow,
    window_manager: State<'_, WindowManager>,
) -> Option<String> {
    window_manager.claim(&session_id, window.label())
}

/// Release `session_id` from the **calling** window. No-op unless the calling
/// window is the current owner. Returns `true` if an entry was removed.
#[tauri::command]
pub fn release_session(
    session_id: String,
    window: WebviewWindow,
    window_manager: State<'_, WindowManager>,
) -> bool {
    window_manager.release(&session_id, window.label())
}

/// The window label currently rendering `session_id`, if any.
#[tauri::command]
pub fn get_session_owner(
    session_id: String,
    window_manager: State<'_, WindowManager>,
) -> Option<String> {
    window_manager.owner_of(&session_id)
}

/// List all currently open windows (label only).
#[tauri::command]
pub fn list_windows(app: AppHandle) -> Vec<WindowInfo> {
    app.webview_windows()
        .into_keys()
        .map(|label| WindowInfo { label })
        .collect()
}

/// Take (and clear) the hand-off records queued for the **calling** window.
///
/// A destination window calls this on boot and on a `window-handoff` nudge to
/// hydrate incoming tabs. Mirrors [`take_pending_spawn`](crate::commands::spawn::take_pending_spawn).
#[tauri::command]
pub fn take_pending_handoffs(
    window: WebviewWindow,
    window_manager: State<'_, WindowManager>,
) -> Vec<HandoffRecord> {
    window_manager.take_handoffs(window.label())
}

/// Queue a hand-off record for an already-open window and nudge every window to
/// drain its queue.
///
/// The nudge is a global `window-handoff` event; only the target window has a
/// queued record, so every other window's drain is a cheap no-op. This avoids
/// coupling to per-window event targeting for the foundation.
#[tauri::command]
pub fn send_handoff_to_window(
    app: AppHandle,
    target_label: String,
    handoff: HandoffRecord,
    window_manager: State<'_, WindowManager>,
) -> Result<(), String> {
    window_manager.queue_handoff(&target_label, handoff);
    app.emit("window-handoff", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Replay a session's ring-buffered scrollback so a freshly-created xterm in a
/// destination window can repaint history after a re-parent.
///
/// Returns the buffered bytes (empty when nothing has been captured yet or the
/// session is unknown). The backend session is never touched — this is a pure
/// read of the capture buffer.
#[tauri::command]
pub async fn replay_session_scrollback(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<Vec<u8>, TerminalError> {
    Ok(manager.replay_scrollback(&session_id).await)
}
