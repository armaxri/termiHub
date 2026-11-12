//! `connection.reconnect` notifications (#5396).
//!
//! An agent-hosted serial session reopens its port on the agent host, in
//! place, after its USB adapter drops, and reports each step of that loop. This
//! module routes a step to the tab hosting that remote session and folds it
//! into the shared `session-lifecycle` region
//! ([`fold_agent_session_reconnect`]), so the tab's reconnect strip shows the
//! attempt, the countdown, the reason and the give-up.
//!
//! An agent older than protocol 0.37.0 never sends the notification: its
//! session ends on a drop, exactly as before.

use serde_json::Value;
use tauri::{AppHandle, Runtime};
use tracing::{info, warn};

use termihub_core::protocol::methods::ConnectionReconnectNotification;

use super::hosted_sessions_for_agent;
use crate::session::manager::AgentHostedSession;
use crate::session_projection::projection::fold_agent_session_reconnect;

/// Route a live `connection.reconnect` notification. Resolving the tab needs
/// the (async) session manager, so the fold runs on a spawned task; the step's
/// sequence number keeps out-of-order folds from undoing a newer step.
pub(super) fn handle_session_reconnect_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
    let notification =
        match serde_json::from_value::<ConnectionReconnectNotification>(params.clone()) {
            Ok(n) => n,
            Err(e) => {
                warn!(agent_id, "malformed connection.reconnect dropped: {e}");
                return;
            }
        };
    info!(
        agent_id,
        remote_session_id = %notification.session_id,
        seq = notification.seq,
        status = ?notification.status,
        "agent session reconnecting in place"
    );
    let app = app_handle.clone();
    let agent_id = agent_id.to_string();
    // Not app-owned (#3105): one-shot fold for a single agent notification.
    tauri::async_runtime::spawn(async move {
        let hosted = hosted_sessions_for_agent(&app, &agent_id).await;
        fold_reconnect_hosted_sessions(&app, &hosted, &notification);
    });
}

/// Fold a reconnect step onto the tab hosting its remote session, if any.
pub(crate) fn fold_reconnect_hosted_sessions<R: Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    notification: &ConnectionReconnectNotification,
) {
    for h in hosted
        .iter()
        .filter(|h| h.remote_session_id == notification.session_id)
    {
        fold_agent_session_reconnect(
            app_handle,
            &h.tab_id,
            notification.seq,
            &notification.status,
        );
    }
}
