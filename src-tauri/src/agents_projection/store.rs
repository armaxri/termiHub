//! The authoritative, shared agents state behind the shadow `agents` projection
//! region (#2226, Phase 5 of #2139).
//!
//! Models the agents slice the frontend currently drives in `appStore`: the
//! ordered `remoteAgents` list (each agent's persisted config/settings plus its
//! live connection status, capabilities and last error) and the per-agent
//! `agentSessions` / `agentDefinitions` / `agentFolders` maps. The view model is
//! shaped to match those frontend structures one-to-one, keeping the eventual
//! render cut a pure parity swap.
//!
//! # Shared region — Open Design Decision #4
//!
//! An agent's connection/session status is a property of the agent, not of a
//! viewing client: two clients observing the same configured agent see the same
//! `connected`/`reconnecting` state and the same live sessions (like SSH tunnels,
//! [`crate::tunnel::projection`], and session-lifecycle,
//! [`crate::session_projection`]). Agent **definitions and folders** are shared,
//! persisted config. The region is therefore a single **shared** `agents` region.
//! Any per-client presentation (which agent a client has focused, banner
//! dismissal) stays a frontend concern under partial projection.
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not** authoritative. The store exists, accepts
//! `agent.*` intents, and projects diffs, but nothing in the live UI subscribes
//! to or renders the `agents` region, and no frontend code dispatches `agent.*`
//! intents yet. The existing `appStore` agents slice remains authoritative. Later
//! steps cut rendering, then mutation, over to the region, then remove the
//! `appStore` state.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The live connection state of a configured agent — mirrors the frontend
/// `RemoteAgentDefinition["connectionState"]` union. Written only by the
/// backend-authoritative `agent.status` transition (the single-writer rule the
/// frontend documents as G4/#1234).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AgentConnectionState {
    /// Not connected (the default for a freshly added agent).
    #[default]
    Disconnected,
    /// A connect attempt is in flight.
    Connecting,
    /// The transport is up and the agent handshake completed.
    Connected,
    /// The transport dropped and auto-reconnect is retrying.
    Reconnecting,
}

/// The authoritative record for one configured agent — the render-ready
/// projection of the frontend `RemoteAgentDefinition`. Held in an ordered list so
/// the sidebar order (`reorderRemoteAgents`) is preserved.
///
/// `config`, `agentSettings` and `capabilities` are carried as opaque JSON so the
/// store owns the agent's identity and status without coupling to the internals
/// of those blobs (which the connection/agent-setup layers define).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    /// Stable agent id.
    pub id: String,
    /// Human-readable agent name shown in the sidebar.
    pub name: String,
    /// The agent's `RemoteAgentConfig` (opaque here).
    pub config: Value,
    /// The agent's `AgentSettings` (opaque here).
    pub agent_settings: Value,
    /// Sidebar expansion state.
    pub is_expanded: bool,
    /// Live connection state (backend-authoritative, single-writer).
    pub connection_state: AgentConnectionState,
    /// Negotiated capabilities once connected; absent until then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Value>,
    /// Last terminal error after auto-reconnect exhausted (G3/#1236); absent when
    /// clear. Surfaced as the Reconnect-button tooltip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl AgentEntry {
    /// A freshly added, disconnected, collapsed agent (mirrors the frontend
    /// `addRemoteAgent` shape for a new definition).
    fn new(id: &str, name: &str, config: Value, agent_settings: Value) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            config,
            agent_settings,
            is_expanded: false,
            connection_state: AgentConnectionState::Disconnected,
            capabilities: None,
            last_error: None,
        }
    }
}

/// A live remote session on an agent — mirrors the frontend `AgentSessionInfo`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub attached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_id: Option<String>,
}

/// A saved connection definition on an agent — mirrors the frontend
/// `AgentDefinitionInfo`. `config` and `terminalOptions` stay opaque.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub session_type: String,
    pub config: Value,
    pub persistent: bool,
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
}

/// A folder on an agent — mirrors the frontend `AgentFolderInfo`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub is_expanded: bool,
}

/// The private mutable core: the ordered agent list plus the per-agent
/// sessions/definitions/folders maps (keyed by agent id). One mutex guards it so
/// intents never interleave — the substrate's single-writer contract also holds
/// within the store.
#[derive(Default)]
struct Inner {
    agents: Vec<AgentEntry>,
    sessions: HashMap<String, Vec<AgentSession>>,
    definitions: HashMap<String, Vec<AgentDefinition>>,
    folders: HashMap<String, Vec<AgentFolder>>,
}

impl Inner {
    /// Find one agent by id for in-place mutation.
    fn agent_mut(&mut self, id: &str) -> Option<&mut AgentEntry> {
        self.agents.iter_mut().find(|a| a.id == id)
    }
}

/// The shadow agents authority. Owns the ordered [`AgentEntry`] list plus the
/// per-agent live sessions, saved definitions and folders. The single shared
/// `agents` region projects this state.
#[derive(Default)]
pub struct AgentsStore {
    inner: Mutex<Inner>,
}

impl AgentsStore {
    /// A store with no agents yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The render-ready view model for the whole region:
    /// `{ "agents": [AgentEntry, …], "sessions": {…}, "definitions": {…}, "folders": {…} }`.
    ///
    /// Pure with respect to agent state (never mutates), so the projector can
    /// safely diff two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        let inner = self.lock();
        json!({
            "agents": inner.agents,
            "sessions": inner.sessions,
            "definitions": inner.definitions,
            "folders": inner.folders,
        })
    }

    // ── Agent definition/config lifecycle (the persisted agent list) ──────────

    /// `agent.add` — append a fresh disconnected agent. Ignored if the id already
    /// exists (idempotent, mirrors the append-only `addRemoteAgent`).
    pub fn add(&self, id: &str, name: &str, config: Value, agent_settings: Value) {
        let mut inner = self.lock();
        if inner.agents.iter().any(|a| a.id == id) {
            return;
        }
        inner
            .agents
            .push(AgentEntry::new(id, name, config, agent_settings));
    }

    /// `agent.update` — update one agent's persisted fields (name, config,
    /// settings), preserving its live status (connection state, capabilities,
    /// last error, expansion). Mirrors `updateRemoteAgent`, which the editor drives
    /// with the runtime fields carried over. A no-op for an unknown id.
    pub fn update(&self, id: &str, name: &str, config: Value, agent_settings: Value) {
        let mut inner = self.lock();
        if let Some(agent) = inner.agent_mut(id) {
            agent.name = name.to_string();
            agent.config = config;
            agent.agent_settings = agent_settings;
        }
    }

    /// `agent.applySettings` — update just one agent's `AgentSettings`
    /// (`updateAgentSettings`). A no-op for an unknown id.
    pub fn apply_settings(&self, id: &str, agent_settings: Value) {
        let mut inner = self.lock();
        if let Some(agent) = inner.agent_mut(id) {
            agent.agent_settings = agent_settings;
        }
    }

    /// `agent.remove` — drop an agent and all of its sessions/definitions/folders
    /// (`deleteRemoteAgent`). Idempotent.
    pub fn remove(&self, id: &str) {
        let mut inner = self.lock();
        inner.agents.retain(|a| a.id != id);
        inner.sessions.remove(id);
        inner.definitions.remove(id);
        inner.folders.remove(id);
    }

    /// `agent.reorder` — move the agent at `old_index` to `new_index`
    /// (`reorderRemoteAgents`). Out-of-range indices are a no-op.
    pub fn reorder(&self, old_index: usize, new_index: usize) {
        let mut inner = self.lock();
        let len = inner.agents.len();
        if old_index >= len || new_index >= len {
            return;
        }
        let moved = inner.agents.remove(old_index);
        inner.agents.insert(new_index, moved);
    }

    /// `agent.toggleExpanded` — flip the sidebar expansion of one agent
    /// (`toggleRemoteAgent`). A no-op for an unknown id.
    pub fn toggle_expanded(&self, id: &str) {
        let mut inner = self.lock();
        if let Some(agent) = inner.agent_mut(id) {
            agent.is_expanded = !agent.is_expanded;
        }
    }

    // ── Connection status (backend-authoritative single writer, G4/#1234) ─────

    /// `agent.status` — set one agent's connection state, tracking `lastError`
    /// exactly as `setAgentConnectionState`: record the error on `disconnected`
    /// (falling back to the stored one), clear it on `connecting`/`connected`, and
    /// leave it untouched otherwise. A no-op for an unknown id.
    pub fn set_status(&self, id: &str, state: AgentConnectionState, error: Option<String>) {
        let mut inner = self.lock();
        if let Some(agent) = inner.agent_mut(id) {
            let next_error = match state {
                AgentConnectionState::Disconnected => error.or_else(|| agent.last_error.clone()),
                AgentConnectionState::Connecting | AgentConnectionState::Connected => None,
                AgentConnectionState::Reconnecting => agent.last_error.clone(),
            };
            agent.connection_state = state;
            agent.last_error = next_error;
        }
    }

    /// `agent.setCapabilities` — record the negotiated capabilities for one agent
    /// (`setAgentCapabilities`). A no-op for an unknown id.
    pub fn set_capabilities(&self, id: &str, capabilities: Value) {
        let mut inner = self.lock();
        if let Some(agent) = inner.agent_mut(id) {
            agent.capabilities = Some(capabilities);
        }
    }

    /// `agent.disconnect` — the optimistic disconnect path
    /// (`disconnectRemoteAgent` / `shutdownRemoteAgent`): force the agent to
    /// `disconnected` and clear its live sessions and folders (definitions are the
    /// persisted config and stay). A no-op for an unknown id.
    pub fn disconnect(&self, id: &str) {
        let mut inner = self.lock();
        let known = inner.agent_mut(id).is_some();
        if let Some(agent) = inner.agent_mut(id) {
            agent.connection_state = AgentConnectionState::Disconnected;
        }
        if known {
            inner.sessions.insert(id.to_string(), Vec::new());
            inner.folders.insert(id.to_string(), Vec::new());
        }
    }

    // ── Live sessions / definitions / folders (refreshed on connect) ──────────

    /// `agent.refresh` — replace one agent's live sessions plus its saved
    /// definitions and folders in one shot (the `refreshAgentSessions` set that
    /// runs once per connect). A no-op for an unknown id.
    pub fn refresh(
        &self,
        id: &str,
        sessions: Vec<AgentSession>,
        definitions: Vec<AgentDefinition>,
        folders: Vec<AgentFolder>,
    ) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_none() {
            return;
        }
        inner.sessions.insert(id.to_string(), sessions);
        inner.definitions.insert(id.to_string(), definitions);
        inner.folders.insert(id.to_string(), folders);
    }

    /// `agent.clearSessions` — empty one agent's live-session list
    /// (`clearAgentSessions`). A no-op for an unknown id.
    pub fn clear_sessions(&self, id: &str) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_some() {
            inner.sessions.insert(id.to_string(), Vec::new());
        }
    }

    // ── Definition CRUD (on-agent connection definitions) ─────────────────────

    /// `agent.saveDefinition` — upsert a saved definition on an agent
    /// (`saveAgentDef`): replace any existing entry with the same id, else append.
    /// A no-op for an unknown agent id.
    pub fn save_definition(&self, id: &str, definition: AgentDefinition) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_none() {
            return;
        }
        let list = inner.definitions.entry(id.to_string()).or_default();
        list.retain(|d| d.id != definition.id);
        list.push(definition);
    }

    /// `agent.updateDefinition` — replace an existing definition by id
    /// (`updateAgentDef`). A no-op if the agent or definition is unknown.
    pub fn update_definition(&self, id: &str, definition: AgentDefinition) {
        let mut inner = self.lock();
        if let Some(list) = inner.definitions.get_mut(id) {
            if let Some(slot) = list.iter_mut().find(|d| d.id == definition.id) {
                *slot = definition;
            }
        }
    }

    /// `agent.deleteDefinition` — remove a saved definition by id
    /// (`deleteAgentDef`). A no-op if the agent or definition is unknown.
    pub fn delete_definition(&self, id: &str, definition_id: &str) {
        let mut inner = self.lock();
        if let Some(list) = inner.definitions.get_mut(id) {
            list.retain(|d| d.id != definition_id);
        }
    }

    // ── Folder CRUD ───────────────────────────────────────────────────────────

    /// `agent.createFolder` — append a folder to an agent (`createAgentFolder`).
    /// A no-op for an unknown agent id.
    pub fn create_folder(&self, id: &str, folder: AgentFolder) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_none() {
            return;
        }
        inner
            .folders
            .entry(id.to_string())
            .or_default()
            .push(folder);
    }

    /// `agent.updateFolder` — replace an existing folder by id
    /// (`updateAgentFolder` / `toggleAgentFolder`). A no-op if unknown.
    pub fn update_folder(&self, id: &str, folder: AgentFolder) {
        let mut inner = self.lock();
        if let Some(list) = inner.folders.get_mut(id) {
            if let Some(slot) = list.iter_mut().find(|f| f.id == folder.id) {
                *slot = folder;
            }
        }
    }

    /// `agent.deleteFolder` — remove a folder and reparent its child definitions
    /// to the root (`deleteAgentFolder`, mirroring the agent's own reparenting). A
    /// no-op if the agent or folder is unknown.
    pub fn delete_folder(&self, id: &str, folder_id: &str) {
        let mut inner = self.lock();
        if let Some(list) = inner.folders.get_mut(id) {
            list.retain(|f| f.id != folder_id);
        }
        if let Some(defs) = inner.definitions.get_mut(id) {
            for def in defs.iter_mut() {
                if def.folder_id.as_deref() == Some(folder_id) {
                    def.folder_id = None;
                }
            }
        }
    }

    // ── Whole-region mirror (render-cut seed) ─────────────────────────────────

    /// `agent.replace` — overwrite the whole agents slice (the ordered agent list
    /// plus the per-agent sessions/definitions/folders maps) with a
    /// caller-supplied snapshot. Used by the frontend render-cut mirror (#2226) to
    /// keep the shared `agents` region a faithful copy of `appStore`'s agents slice
    /// while `appStore` remains authoritative (the mutation cut is a later step) —
    /// the analog of the system-monitor bridge's `monitor.replace` seed. Idempotent
    /// server-side: replacing with the same content yields no diff.
    pub fn replace(
        &self,
        agents: Vec<AgentEntry>,
        sessions: HashMap<String, Vec<AgentSession>>,
        definitions: HashMap<String, Vec<AgentDefinition>>,
        folders: HashMap<String, Vec<AgentFolder>>,
    ) {
        let mut inner = self.lock();
        inner.agents = agents;
        inner.sessions = sessions;
        inner.definitions = definitions;
        inner.folders = folders;
    }

    /// Read one agent entry (test / diagnostics helper).
    #[cfg(test)]
    pub fn get(&self, id: &str) -> Option<AgentEntry> {
        self.lock().agents.iter().find(|a| a.id == id).cloned()
    }

    /// Read one agent's ordered id list (test / diagnostics helper).
    #[cfg(test)]
    pub fn agent_ids(&self) -> Vec<String> {
        self.lock().agents.iter().map(|a| a.id.clone()).collect()
    }

    /// Read one agent's saved definitions (test / diagnostics helper).
    #[cfg(test)]
    pub fn definitions_of(&self, id: &str) -> Vec<AgentDefinition> {
        self.lock().definitions.get(id).cloned().unwrap_or_default()
    }

    /// Read one agent's folders (test / diagnostics helper).
    #[cfg(test)]
    pub fn folders_of(&self, id: &str) -> Vec<AgentFolder> {
        self.lock().folders.get(id).cloned().unwrap_or_default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
