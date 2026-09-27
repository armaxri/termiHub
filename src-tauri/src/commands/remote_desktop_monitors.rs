//! Multi-monitor commands for graphical remote-desktop sessions (#3696).
//!
//! - **layout** — the session's monitors in framebuffer coordinates, which the
//!   frontend turns into the toolbar's per-monitor viewport selector. Reading
//!   it exposes no remote content, so it is not ownership-gated.
//! - **set layout** — replace the layout at runtime (the "all local displays"
//!   mode re-sends it when the local display set changes). It resizes the
//!   remote, so it is gated exactly like a resize (#3388): a non-owning window's
//!   request is dropped.

use tauri::State;

use termihub_core::connection::MonitorRect;

use super::remote_desktop::{window_controls, GatedOp};
use crate::session::graphical_manager::GraphicalSessionManager;
use crate::utils::errors::TerminalError;
use crate::window::WindowManager;

/// Ownership-gated runtime layout change. Returns whether it was sent
/// (`false` = dropped because another window controls the session).
pub(crate) async fn gated_set_monitor_layout(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
    monitors: &[MonitorRect],
) -> Result<bool, TerminalError> {
    if !window_controls(window_manager, session_id, window_label, GatedOp::Resize) {
        return Ok(false);
    }
    manager.set_monitor_layout(session_id, monitors).await?;
    Ok(true)
}

/// The session's monitors in framebuffer coordinates — empty for a
/// single-monitor session.
#[tauri::command]
pub async fn remote_desktop_monitor_layout(
    session_id: String,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<Vec<MonitorRect>, TerminalError> {
    manager.monitor_layout(&session_id).await
}

/// Replace the session's monitor layout (desktop coordinates, any origin; it is
/// normalized in the backend). Ownership-gated like a resize (#3388).
#[tauri::command]
pub async fn remote_desktop_set_monitor_layout(
    session_id: String,
    monitors: Vec<MonitorRect>,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    gated_set_monitor_layout(
        &manager,
        &window_manager,
        window.label(),
        &session_id,
        &monitors,
    )
    .await
    .map(|_| ())
}

#[cfg(all(test, feature = "mock-remote-desktop"))]
#[path = "remote_desktop_monitors_tests.rs"]
mod tests;
