//! `agent-state-change` emission for the agent manager (ARCH-002 / TAURI-009
//! final slice, #3794).
//!
//! The single choke point every agent `connecting`/`connected`/`disconnected`/
//! `reconnecting` transition flows through: it folds the transition into the
//! server-authoritative `AgentsStore` (publishing the `agents` region) and then
//! emits the `agent-state-change` Tauri event.
//!
//! Carved verbatim out of the parent `agent_manager` module: no behaviour,
//! emit-order, channel, lock or task change.

use tauri::{AppHandle, Emitter, Runtime};

use crate::agents_projection::projection::fold_agent_transition;
use crate::agents_projection::store::AgentConnectionState;
use crate::terminal::backend::RemoteStateChangeEvent;

/// Map an `agent-state-change` wire string to the store's connection-state enum.
///
/// The four states the agent manager emits are the camelCase variants of
/// [`AgentConnectionState`]; an unrecognised string yields `None` so the fold is
/// skipped rather than forcing a state.
pub(super) fn parse_agent_connection_state(state: &str) -> Option<AgentConnectionState> {
    match state {
        "disconnected" => Some(AgentConnectionState::Disconnected),
        "connecting" => Some(AgentConnectionState::Connecting),
        "connected" => Some(AgentConnectionState::Connected),
        "reconnecting" => Some(AgentConnectionState::Reconnecting),
        _ => None,
    }
}

/// Emit an agent state change event with an optional error description.
pub(super) fn emit_agent_state_with_error<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    state: &str,
    error: Option<&str>,
) {
    // Server-authority fold (#2388): reflect the connection-state transition into
    // the shared `AgentsStore` at the source — this function is the single choke
    // point every `connecting`/`connected`/`disconnected`/`reconnecting` emission
    // flows through. Additive: the Tauri event below and the client `agent.status`
    // mirror stay in place, so no user-facing behavior changes. The store's
    // `set_status` tracks `lastError` with the same rules the frontend's
    // `setAgentConnectionState` applies (record on `disconnected`, clear on
    // `connecting`/`connected`), so the fold and the client mirror agree.
    if let Some(connection_state) = parse_agent_connection_state(state) {
        let error_owned = error.map(|s| s.to_string());
        fold_agent_transition(app_handle, move |store| {
            store.set_status(agent_id, connection_state, error_owned);
        });
    }
    let _ = app_handle.emit(
        "agent-state-change",
        RemoteStateChangeEvent {
            session_id: agent_id.to_string(),
            state: state.to_string(),
            error: error.map(|s| s.to_string()),
        },
    );
}

/// Emit an agent state change event.
pub(super) fn emit_agent_state<R: Runtime>(app_handle: &AppHandle<R>, agent_id: &str, state: &str) {
    emit_agent_state_with_error(app_handle, agent_id, state, None);
}
