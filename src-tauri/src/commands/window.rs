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
use crate::window::{HandoffRecord, WindowLayoutReport, WindowManager, MAIN_WINDOW_LABEL};

/// A window known to the app, as reported to the frontend window picker.
///
/// The display name is derived from the label by the frontend; the tab count is
/// the value the window last reported via [`report_window_tab_count`] (#1910),
/// so the "Move to Window ▸" picker can show a live "N tabs" / "empty" hint
/// sourced from real per-window state rather than a placeholder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// The window's runtime label (`main`, `win-1`, …).
    pub label: String,
    /// The window's live tab count, or `None` if it has not reported one yet
    /// (a window that just booted and has not drawn its tabs).
    pub tab_count: Option<usize>,
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
    restore: Option<serde_json::Value>,
) -> Result<String, String> {
    let label = window_manager.next_label();
    if let Some(record) = handoff {
        window_manager.queue_handoff(&label, record);
    }
    // A restore-spawned window carries the tab groups it should hydrate on boot
    // (#1925), drained via `take_pending_window_restore`.
    if let Some(groups) = restore {
        window_manager.queue_restore(&label, groups);
    }

    let app_for_build = app.clone();
    let label_for_build = label.clone();
    app.run_on_main_thread(move || {
        match WebviewWindowBuilder::new(
            &app_for_build,
            &label_for_build,
            WebviewUrl::App("index.html".into()),
        )
        .title("termiHub")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()
        {
            Ok(_) => {
                // Notify every open window that the window set changed so the
                // status-bar affordance (#1902) can refresh its count. The
                // matching close-side emit lives in the `Destroyed` RunEvent
                // handler in `lib.rs`.
                if let Err(e) = app_for_build.emit("windows-changed", ()) {
                    tracing::warn!("Failed to emit windows-changed for {label_for_build}: {e}");
                }
            }
            Err(e) => tracing::error!("Failed to create window {label_for_build}: {e}"),
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

/// A snapshot of the full `session_id → owning_window_label` map (#1926).
///
/// The Open Connections panel reads this once when it opens to stamp each
/// session row with an owning-window badge (and a "focus owning window"
/// affordance). Only claimed sessions appear — an unclaimed session has no
/// entry, so its row shows no window badge.
#[tauri::command]
pub fn list_session_owners(
    window_manager: State<'_, WindowManager>,
) -> std::collections::HashMap<String, String> {
    window_manager.all_owners()
}

/// Bring the window addressed by `label` to the foreground (#1926).
///
/// The "focus owning window" affordance in the Open Connections panel calls this
/// to surface the window that owns a session. Unminimizes first so a minimized
/// window is restored, then shows and focuses it. A `label` with no live window
/// (it was closed between the panel opening and the click) is a no-op.
#[tauri::command]
pub fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List all currently open windows, each with its last-reported tab count.
///
/// The tab count is whatever the owning window last pushed via
/// [`report_window_tab_count`] (#1910); a window that has not reported yet
/// carries `None`, which the picker renders as no hint until its first report.
#[tauri::command]
pub fn list_windows(app: AppHandle, window_manager: State<'_, WindowManager>) -> Vec<WindowInfo> {
    app.webview_windows()
        .into_keys()
        .map(|label| {
            let tab_count = window_manager.tab_count_of(&label);
            WindowInfo { label, tab_count }
        })
        .collect()
}

/// Record the **calling** window's current tab count so other windows'
/// "Move to Window ▸" pickers can show a live "N tabs" hint (#1910).
///
/// The window calls this whenever its tab set changes. Every open window is then
/// nudged with `windows-changed` so an open picker / the status-bar affordance
/// (#1902) refreshes; a window reads the fresh counts back through
/// [`list_windows`].
#[tauri::command]
pub fn report_window_tab_count(
    app: AppHandle,
    window: WebviewWindow,
    count: usize,
    window_manager: State<'_, WindowManager>,
) -> Result<(), String> {
    window_manager.set_tab_count(window.label(), count);
    app.emit("windows-changed", ()).map_err(|e| e.to_string())?;
    Ok(())
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

/// Report the **calling** window's captured layout slice for multi-window
/// persistence aggregation (#1925).
///
/// Each window's tab groups live in its own JS context, so the main window
/// cannot see another window's layout. Every window reports its own slice here;
/// the main window assembles the full last-session / workspace document from
/// [`collect_window_layouts`]. A report from a **secondary** window whose layout
/// actually changed nudges every window with `window-layout-changed` so the main
/// window re-persists. The main window's own reports never nudge — it persists
/// from its own layout subscription — which prevents a self-triggering save loop.
#[tauri::command]
pub fn report_window_layout(
    app: AppHandle,
    window: WebviewWindow,
    tab_groups: serde_json::Value,
    active_group_index: usize,
    window_manager: State<'_, WindowManager>,
) -> Result<(), String> {
    let changed = window_manager.report_layout(window.label(), tab_groups, active_group_index);
    if changed && window.label() != MAIN_WINDOW_LABEL {
        app.emit("window-layout-changed", ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every open window's reported layout slice, main-window-first, for the main
/// window to assemble the full multi-window persisted document (#1925).
#[tauri::command]
pub fn collect_window_layouts(window_manager: State<'_, WindowManager>) -> Vec<WindowLayoutReport> {
    window_manager.collect_layouts()
}

/// Take (and clear) the tab groups the **calling** window should hydrate on boot
/// when it was spawned by a multi-window restore (#1925).
///
/// Mirrors [`take_pending_handoffs`] but carries whole tab groups seeded by the
/// restore rather than a single moved tab. Returns `None` for a window that was
/// not restore-spawned (e.g. the empty-window or move-to-window paths).
#[tauri::command]
pub fn take_pending_window_restore(
    window: WebviewWindow,
    window_manager: State<'_, WindowManager>,
) -> Option<serde_json::Value> {
    window_manager.take_restore(window.label())
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
