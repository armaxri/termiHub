//! Agent notification/event dispatch for the agent manager (ARCH-002 /
//! TAURI-009 slice 9, #3772).
//!
//! Routes every JSON-RPC notification the remote agent pushes to its consumer:
//! `connection.output` and `connection.monitoring.*` to the per-session/per-host
//! channels, `connection.evicted` to the SM-003 eviction fold, `agent.forward.*`
//! to the desktop ssh-agent relay, `tool.event`/`tool.done` to their tool run,
//! and the `agent.update_available`/`agent.update_pending` notices to the
//! frontend as Tauri events.
//!
//! Carved verbatim out of the parent `agent_manager` module: no behaviour,
//! emit-order, channel, lock or task change. The I/O task and reconnect
//! machinery that *call* these functions stay in the parent.

use std::collections::HashMap;

use base64::Engine;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{info, warn};

use termihub_core::protocol::methods::{
    AgentForwardCloseParams, AgentForwardDataParams, AgentForwardOpenParams,
    ConnectionEvictedNotification, ConnectionOutputNotification, MonitoringData,
    MonitoringStatusNotification, UpdateAvailableNotification, UpdatePendingNotification,
};

use super::{
    fold_evicted_hosted_sessions, hosted_sessions_for_agent, AgentIoCommand, MonitoringRoute,
    ToolRunMessage, ToolRunSender,
};
use crate::terminal::agent_forward::DesktopAgentForward;
use crate::terminal::backend::OutputSender;

/// Payload of the `agent-update-available` Tauri event: the agent's
/// [`UpdateAvailableNotification`] tagged with the desktop's `agent_id`.
/// `downloadUrl` is deliberately not forwarded (the frontend never had it).
#[derive(Debug, serde::Serialize)]
struct AgentUpdateAvailableEvent<'a> {
    agent_id: &'a str,
    #[serde(rename = "currentVersion")]
    current_version: &'a str,
    #[serde(rename = "availableVersion")]
    available_version: &'a str,
    staged: bool,
}

/// Payload of the `remote-agent-update-pending` Tauri event: the agent's
/// [`UpdatePendingNotification`] tagged with the desktop's `agent_id`.
#[derive(Debug, serde::Serialize)]
struct RemoteAgentUpdatePendingEvent<'a> {
    agent_id: &'a str,
    #[serde(rename = "requestedByVersion")]
    requested_by_version: &'a str,
    #[serde(rename = "estimatedRestartSecs")]
    estimated_restart_secs: u64,
}

/// Build the `agent-update-available` event payload from the notification's
/// params via the shared DTO (DUP-001, #3226). `None` for a malformed payload.
pub(super) fn agent_update_available_event(agent_id: &str, params: &Value) -> Option<Value> {
    let n: UpdateAvailableNotification = serde_json::from_value(params.clone()).ok()?;
    serde_json::to_value(AgentUpdateAvailableEvent {
        agent_id,
        current_version: &n.current_version,
        available_version: &n.available_version,
        staged: n.staged,
    })
    .ok()
}

/// Build the `remote-agent-update-pending` event payload from the
/// notification's params via the shared DTO (DUP-001, #3226). `None` for a
/// malformed payload.
pub(super) fn remote_agent_update_pending_event(agent_id: &str, params: &Value) -> Option<Value> {
    let n: UpdatePendingNotification = serde_json::from_value(params.clone()).ok()?;
    serde_json::to_value(RemoteAgentUpdatePendingEvent {
        agent_id,
        requested_by_version: &n.requested_by_version,
        estimated_restart_secs: n.estimated_restart_secs,
    })
    .ok()
}

/// Forward an agent's `agent.update_available` notification to the frontend as
/// the `agent-update-available` Tauri event (#1352). Tags it with the desktop's
/// `agent_id` so the per-agent deferred-update banner can key off it. A payload
/// that does not match the shared DTO is logged and dropped.
fn emit_agent_update_available<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
    match agent_update_available_event(agent_id, params) {
        Some(event) => {
            let _ = app_handle.emit("agent-update-available", event);
        }
        None => warn!("Agent {agent_id}: malformed agent.update_available notification dropped"),
    }
}

/// Forward an agent's `agent.update_pending` notification to the frontend as the
/// `remote-agent-update-pending` Tauri event (#1602). Broadcast by the agent to
/// every *other* connected host when one host initiates a coordinated update
/// (#1351): this desktop is being cut over, so the frontend surfaces the "being
/// updated by another host" notice, suspends the affected session and queues an
/// auto-reconnect. Tagged with the `agent_id` so the notice keys off it exactly
/// like the deferred-update banner. A payload that does not match the shared
/// DTO is logged and dropped (the agent restart is then handled by the normal
/// transport-loss reconnect).
fn emit_remote_agent_update_pending<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
    match remote_agent_update_pending_event(agent_id, params) {
        Some(event) => {
            let _ = app_handle.emit("remote-agent-update-pending", event);
        }
        None => warn!("Agent {agent_id}: malformed agent.update_pending notification dropped"),
    }
}

/// Route a live `connection.evicted` notification (SM-003): fold the hosted tab
/// attached to that remote session to `Evicted`. Resolving the tab needs the
/// (async) session manager, so the fold runs on a spawned task.
fn handle_session_evicted_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
    let Ok(ConnectionEvictedNotification {
        session_id: remote_sid,
        ..
    }) = serde_json::from_value(params.clone())
    else {
        return;
    };
    info!(
        agent_id = %agent_id,
        remote_session_id = %remote_sid,
        "agent session taken over by another desktop (SM-003)"
    );
    let app = app_handle.clone();
    let agent_id = agent_id.to_string();
    let evicted: std::collections::HashSet<String> = [remote_sid.to_string()].into();
    // Not app-owned (#3105): one-shot eviction fold for a single agent notification.
    tauri::async_runtime::spawn(async move {
        let hosted = hosted_sessions_for_agent(&app, &agent_id).await;
        fold_evicted_hosted_sessions(&app, &hosted, &evicted);
    });
}

/// Dispatch a single agent notification to every place that consumes it.
///
/// Surfaces the agent-level update notices (`agent.update_available`,
/// `agent.update_pending`) to the frontend, then routes session/monitoring
/// notifications to their registered channels via [`handle_notification`].
///
/// Shared by the live I/O loop and the pre-init replay path (#1660): a
/// notification that arrived during the `initialize` handshake is buffered and
/// replayed through this same function once init completes, so on-attach
/// notifications are no longer silently dropped.
pub(super) fn dispatch_agent_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    monitoring_outputs: &HashMap<String, MonitoringRoute>,
    b64: &base64::engine::GeneralPurpose,
) {
    if method == termihub_core::protocol::methods::AGENT_UPDATE_AVAILABLE {
        emit_agent_update_available(app_handle, agent_id, params);
    }
    if method == termihub_core::protocol::methods::AGENT_UPDATE_PENDING {
        emit_remote_agent_update_pending(app_handle, agent_id, params);
    }
    if method == termihub_core::protocol::methods::CONNECTION_EVICTED {
        handle_session_evicted_notification(app_handle, agent_id, params);
    }
    handle_notification(method, params, session_outputs, monitoring_outputs, b64);
}

/// Route an `agent.forward.*` ssh-agent relay notification (#1727) to the
/// desktop relay handler, returning `true` if it was one (so the caller skips
/// the normal session/monitoring dispatch).
pub(super) fn handle_agent_forward_notification(
    agent_forward: &DesktopAgentForward,
    command_tx: &UnboundedSender<AgentIoCommand>,
    method: &str,
    params: &Value,
    b64: &base64::engine::GeneralPurpose,
) -> bool {
    use termihub_core::protocol::methods::{
        AGENT_FORWARD_CLOSE, AGENT_FORWARD_DATA, AGENT_FORWARD_OPEN,
    };
    match method {
        m if m == AGENT_FORWARD_OPEN => {
            if let Ok(p) = serde_json::from_value::<AgentForwardOpenParams>(params.clone()) {
                agent_forward.on_open(p.stream_id, command_tx.clone());
            }
            true
        }
        m if m == AGENT_FORWARD_DATA => {
            if let Ok(p) = serde_json::from_value::<AgentForwardDataParams>(params.clone()) {
                if let Ok(data) = b64.decode(&p.data) {
                    agent_forward.on_data(&p.stream_id, data);
                }
            }
            true
        }
        m if m == AGENT_FORWARD_CLOSE => {
            if let Ok(p) = serde_json::from_value::<AgentForwardCloseParams>(params.clone()) {
                agent_forward.on_close(&p.stream_id);
            }
            true
        }
        _ => false,
    }
}

/// Route a streaming tool run notification (`tool.event` / `tool.done`,
/// #3353) to its registered run, returning `true` if it was one. `tool.done`
/// also drops the route — it is always the run's last message. Notifications for
/// an unknown run (already unregistered, or from before a reconnect) are dropped.
pub(super) fn route_tool_run_notification(
    tool_runs: &mut HashMap<String, ToolRunSender>,
    method: &str,
    params: &Value,
) -> bool {
    use termihub_core::protocol::methods::{
        ToolDoneNotification, ToolEventNotification, TOOL_DONE, TOOL_EVENT,
    };
    match method {
        m if m == TOOL_EVENT => {
            if let Ok(n) = serde_json::from_value::<ToolEventNotification>(params.clone()) {
                if let Some(tx) = tool_runs.get(&n.run_id) {
                    let _ = tx.send(ToolRunMessage::Events(n.events));
                }
            }
            true
        }
        m if m == TOOL_DONE => {
            if let Ok(n) = serde_json::from_value::<ToolDoneNotification>(params.clone()) {
                if let Some(tx) = tool_runs.remove(&n.run_id) {
                    let _ = tx.send(ToolRunMessage::Done(n));
                }
            }
            true
        }
        _ => false,
    }
}

/// Handle a notification from the agent.
///
/// Routes `connection.output` to session output channels,
/// `connection.monitoring.data` to monitoring channels, and
/// `connection.monitoring.status` to the monitor's status channel when it
/// registered one (#3321). Any other method — including one a newer agent adds
/// that this build does not know — is ignored.
pub(super) fn handle_notification(
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    monitoring_outputs: &HashMap<String, MonitoringRoute>,
    b64: &base64::engine::GeneralPurpose,
) {
    use termihub_core::protocol::methods::{
        CONNECTION_MONITORING_DATA, CONNECTION_MONITORING_STATUS, CONNECTION_OUTPUT,
    };
    match method {
        m if m == CONNECTION_OUTPUT => {
            let Ok(n) = serde_json::from_value::<ConnectionOutputNotification>(params.clone())
            else {
                return;
            };
            let Ok(data) = b64.decode(&n.data) else {
                return;
            };
            if let Some(output_tx) = session_outputs.get(&n.session_id) {
                // Use try_send to avoid blocking the async I/O task.
                let _ = output_tx.try_send(data);
            }
        }
        m if m == CONNECTION_MONITORING_DATA => {
            let Ok(MonitoringData { host, stats }) = serde_json::from_value(params.clone()) else {
                return;
            };
            if let Some(route) = monitoring_outputs.get(&host) {
                let _ = route.stats.try_send(stats);
            }
        }
        m if m == CONNECTION_MONITORING_STATUS => {
            // An unparseable report (e.g. a status value this build does not
            // know) is dropped; the monitor keeps inferring from samples.
            let report: MonitoringStatusNotification = match serde_json::from_value(params.clone())
            {
                Ok(r) => r,
                Err(_) => return,
            };
            if let Some(status_tx) = monitoring_outputs
                .get(&report.host)
                .and_then(|route| route.status.as_ref())
            {
                let _ = status_tx.try_send(report);
            }
        }
        _ => {}
    }
}
