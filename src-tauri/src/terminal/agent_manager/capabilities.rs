//! An agent's negotiated `initialize` capabilities, shared between the
//! connection entry and its I/O task (#4440).
//!
//! The desktop decides by these flags (`outputFlow`, `fileRanges`,
//! `sessionFiles`, `hostFileAttributeOps`, ...). The in-task transport
//! reconnect re-launches the agent and runs `initialize` again — and the
//! binary may have changed underneath the live connection (an update, or a
//! downgrade). [`refresh_agent_capabilities`] replaces the cached set wholesale
//! with the new answer, so a flag the new agent lacks is dropped, and records
//! it in the agents region so every window reads the same set.

use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Runtime};
use tracing::info;

use termihub_core::protocol::methods::InitializeResult;

use super::AgentCapabilities;
use crate::agents_projection::projection::fold_agent_transition;

/// The capabilities one agent connection currently decides by. Cloning shares
/// the same cell, so the I/O task's refresh is what the manager reads.
#[derive(Debug, Clone)]
pub(super) struct SharedCapabilities(Arc<RwLock<AgentCapabilities>>);

impl From<AgentCapabilities> for SharedCapabilities {
    fn from(capabilities: AgentCapabilities) -> Self {
        Self(Arc::new(RwLock::new(capabilities)))
    }
}

impl SharedCapabilities {
    /// A copy of the current capabilities.
    pub(super) fn get(&self) -> AgentCapabilities {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Whether the current agent pauses output on `connection.output_flow`.
    pub(super) fn output_flow(&self) -> bool {
        self.0.read().unwrap_or_else(|e| e.into_inner()).output_flow
    }

    /// Replace the whole set — never a merge, so a downgrade drops every flag
    /// the older agent does not report.
    pub(super) fn replace(&self, capabilities: AgentCapabilities) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = capabilities;
    }
}

/// The capabilities an `initialize` answer reports, with the agent version
/// copied in so the UI can read it from the same object.
pub(super) fn capabilities_from_initialize(
    init: InitializeResult<AgentCapabilities>,
) -> AgentCapabilities {
    let mut capabilities = init.capabilities;
    capabilities.agent_version = init.agent_version;
    capabilities
}

/// Adopt the capabilities a reconnect's `initialize` reported: replace the
/// cached set and record it in the agents region (a no-op without a store).
pub(super) fn refresh_agent_capabilities<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    shared: &SharedCapabilities,
    fresh: AgentCapabilities,
) {
    let previous_version = shared.get().agent_version;
    if previous_version != fresh.agent_version {
        info!(
            agent_id,
            from = %previous_version,
            to = %fresh.agent_version,
            "agent version changed across reconnect; capabilities refreshed"
        );
    }
    record_capabilities_in_region(app_handle, agent_id, &fresh);
    shared.replace(fresh);
}

/// Record `capabilities` as the agent's entry in the agents region, so every
/// window derives the same state from them. A no-op without a store.
pub(super) fn record_capabilities_in_region<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    capabilities: &AgentCapabilities,
) {
    if let Ok(value) = serde_json::to_value(capabilities) {
        fold_agent_transition(app_handle, move |store| {
            store.set_capabilities(agent_id, value);
        });
    }
}
