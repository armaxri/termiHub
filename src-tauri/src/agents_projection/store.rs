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

use std::collections::{HashMap, HashSet};
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

/// The persisted identity of one configured agent, as produced by the backend
/// authority (the `ConnectionManager` agent list) — the input to
/// [`AgentsStore::reflect_saved_agents`] (#2403).
///
/// Carries **only** the persisted fields the backend owns (id / name / config /
/// settings); it deliberately excludes the live status the store owns
/// (connection state, capabilities, last error, expansion, sessions), so
/// reflecting the persisted list can create/refresh list-membership without
/// clobbering an agent's in-flight connection state.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedAgentSeed {
    /// Stable agent id.
    pub id: String,
    /// Human-readable agent name.
    pub name: String,
    /// The agent's `RemoteAgentConfig`, serialised opaquely (matches the shape
    /// the frontend stores, so the eventual render cut is a parity swap).
    pub config: Value,
    /// The agent's `AgentSettings`, serialised opaquely.
    pub agent_settings: Value,
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
    /// Per-agent folders/definitions that were created optimistically on the client
    /// but not yet confirmed by a server snapshot (#2486). They protect a fresh
    /// create from being clobbered by a **stale** whole-list snapshot
    /// (`set_folders` / `set_definitions` / `refresh`) that was taken *before* the
    /// create was persisted but delivered *after* it. An entry is dropped the moment
    /// a snapshot confirms it (the snapshot now contains it), or the user deletes it
    /// locally, or the agent is removed/disconnected — so a genuinely deleted item
    /// is never resurrected.
    pending_folders: HashMap<String, Vec<AgentFolder>>,
    pending_definitions: HashMap<String, Vec<AgentDefinition>>,
}

impl Inner {
    /// Find one agent by id for in-place mutation.
    fn agent_mut(&mut self, id: &str) -> Option<&mut AgentEntry> {
        self.agents.iter_mut().find(|a| a.id == id)
    }

    /// Record a folder as an unconfirmed local create so a later stale snapshot
    /// cannot drop it (upsert by id — a re-create of the same id replaces it).
    fn track_pending_folder(&mut self, id: &str, folder: &AgentFolder) {
        let list = self.pending_folders.entry(id.to_string()).or_default();
        list.retain(|f| f.id != folder.id);
        list.push(folder.clone());
    }

    /// Stop protecting a folder (confirmed by a snapshot, deleted locally, …).
    fn untrack_pending_folder(&mut self, id: &str, folder_id: &str) {
        if let Some(list) = self.pending_folders.get_mut(id) {
            list.retain(|f| f.id != folder_id);
            if list.is_empty() {
                self.pending_folders.remove(id);
            }
        }
    }

    /// Record a definition as an unconfirmed local create (see
    /// [`Self::track_pending_folder`]).
    fn track_pending_definition(&mut self, id: &str, definition: &AgentDefinition) {
        let list = self.pending_definitions.entry(id.to_string()).or_default();
        list.retain(|d| d.id != definition.id);
        list.push(definition.clone());
    }

    /// Stop protecting a definition.
    fn untrack_pending_definition(&mut self, id: &str, definition_id: &str) {
        if let Some(list) = self.pending_definitions.get_mut(id) {
            list.retain(|d| d.id != definition_id);
            if list.is_empty() {
                self.pending_definitions.remove(id);
            }
        }
    }

    /// Reconcile a server folder snapshot with the agent's unconfirmed local
    /// creates (#2486): take the snapshot as the authoritative base, confirm-and-drop
    /// any pending folder the snapshot now contains, and append any pending folder
    /// the snapshot is missing (a create the snapshot predates) so it survives. The
    /// snapshot's own ordering is preserved; preserved creates follow it.
    fn reconcile_folders(&mut self, id: &str, snapshot: Vec<AgentFolder>) -> Vec<AgentFolder> {
        let snapshot_ids: HashSet<String> = snapshot.iter().map(|f| f.id.clone()).collect();
        let mut merged = snapshot;
        if let Some(pending) = self.pending_folders.get_mut(id) {
            pending.retain(|f| !snapshot_ids.contains(&f.id));
            merged.extend(pending.iter().cloned());
            if pending.is_empty() {
                self.pending_folders.remove(id);
            }
        }
        merged
    }

    /// Reconcile a server definition snapshot with the agent's unconfirmed local
    /// creates (see [`Self::reconcile_folders`]).
    fn reconcile_definitions(
        &mut self,
        id: &str,
        snapshot: Vec<AgentDefinition>,
    ) -> Vec<AgentDefinition> {
        let snapshot_ids: HashSet<String> = snapshot.iter().map(|d| d.id.clone()).collect();
        let mut merged = snapshot;
        if let Some(pending) = self.pending_definitions.get_mut(id) {
            pending.retain(|d| !snapshot_ids.contains(&d.id));
            merged.extend(pending.iter().cloned());
            if pending.is_empty() {
                self.pending_definitions.remove(id);
            }
        }
        merged
    }

    /// Forget every unconfirmed local create for an agent (removal / disconnect /
    /// whole-slice replace — the live view is being reset from an authority).
    fn clear_pending(&mut self, id: &str) {
        self.pending_folders.remove(id);
        self.pending_definitions.remove(id);
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

    /// Reflect the whole persisted agent list into the store from the backend
    /// authority (the `ConnectionManager` agent list), making the `agents` region
    /// authoritative for **list-membership** — not just the per-field status /
    /// sessions / definitions / folders #2388 already folds (#2403, prerequisite
    /// for #2226).
    ///
    /// This is the entry-**creation** + list-**load** counterpart to the #2388
    /// per-field setters (all of which are a no-op for an unknown id): the persisted
    /// list is the sole source of agent identity, so the store must reflect it to be
    /// authoritative. It is the agents analog of the `connections_projection`
    /// `ConnectionsStore::replace` from the manager snapshot (#2389), the difference
    /// being that an agent's **live status lives only in the store** (never in the
    /// persisted config), so this reflects list-membership *without* the clobbering a
    /// naive whole-slice replace would cause:
    ///
    /// - a `seed` whose id is **new** → a fresh disconnected entry (like [`Self::add`]);
    /// - a `seed` whose id **exists** → its persisted fields (name / config / settings)
    ///   are refreshed while its live status (connection state, capabilities, last
    ///   error, expansion) and its sessions / definitions / folders are **preserved**;
    /// - an existing agent **absent** from `seed`s → dropped, along with its
    ///   sessions / definitions / folders (it was deleted from the persisted list).
    ///
    /// The resulting list order follows `seeds` (the persisted order the frontend's
    /// `reorderRemoteAgents` writes back), so the region mirrors the sidebar order.
    /// Idempotent: reflecting the same list twice yields no change, so it composes
    /// with the still-present client `agent.*` mirror without drift.
    pub fn reflect_saved_agents(&self, seeds: Vec<SavedAgentSeed>) {
        let mut inner = self.lock();
        // Index the current entries by id so surviving agents keep their live status.
        let mut previous: HashMap<String, AgentEntry> = std::mem::take(&mut inner.agents)
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        let mut kept: HashSet<String> = HashSet::with_capacity(seeds.len());
        let mut next: Vec<AgentEntry> = Vec::with_capacity(seeds.len());
        for seed in seeds {
            kept.insert(seed.id.clone());
            match previous.remove(&seed.id) {
                // Existing agent: refresh persisted fields, preserve live status.
                Some(mut entry) => {
                    entry.name = seed.name;
                    entry.config = seed.config;
                    entry.agent_settings = seed.agent_settings;
                    next.push(entry);
                }
                // New agent: a fresh disconnected entry.
                None => next.push(AgentEntry::new(
                    &seed.id,
                    &seed.name,
                    seed.config,
                    seed.agent_settings,
                )),
            }
        }
        inner.agents = next;
        // Drop the sub-state of agents no longer in the persisted list (self-cleaning
        // for any orphan folder/definition map created before its entry existed, #2486).
        inner.sessions.retain(|id, _| kept.contains(id));
        inner.definitions.retain(|id, _| kept.contains(id));
        inner.folders.retain(|id, _| kept.contains(id));
        inner.pending_folders.retain(|id, _| kept.contains(id));
        inner.pending_definitions.retain(|id, _| kept.contains(id));
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
        inner.clear_pending(id);
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
            // The live folder view is reset; the next connect's refresh reloads it
            // from the server (which by then includes any persisted create), so no
            // unconfirmed create should be re-applied across a disconnect (#2486).
            inner.clear_pending(id);
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
        // Reconcile the once-per-connect snapshot with unconfirmed local creates so a
        // create racing this refresh survives it (#2486).
        let definitions = inner.reconcile_definitions(id, definitions);
        let folders = inner.reconcile_folders(id, folders);
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

    /// Replace one agent's live-session list with a server-produced snapshot (the
    /// `list_agent_sessions` RPC outcome, #2388). Distinct from [`Self::refresh`],
    /// which replaces sessions/definitions/folders together; this sets only the
    /// sessions slice so folding a `list_agent_sessions` result does not clobber
    /// the saved definitions/folders. A no-op for an unknown id. Idempotent, so
    /// running it alongside the additive client `agent.refresh` mirror converges
    /// without drift.
    pub fn set_sessions(&self, id: &str, sessions: Vec<AgentSession>) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_some() {
            inner.sessions.insert(id.to_string(), sessions);
        }
    }

    /// Remove one live session from an agent by session id (the
    /// `close_agent_session` RPC outcome, #2388). A no-op if the agent or session
    /// is unknown; idempotent.
    pub fn remove_session(&self, id: &str, session_id: &str) {
        let mut inner = self.lock();
        if let Some(list) = inner.sessions.get_mut(id) {
            list.retain(|s| s.session_id != session_id);
        }
    }

    /// Replace one agent's saved-definition list with a server-produced snapshot
    /// (the `list_agent_definitions` / `list_agent_connections` RPC outcome,
    /// #2388). Sets only the definitions slice (see [`Self::set_sessions`]). A
    /// no-op for an unknown id; idempotent.
    pub fn set_definitions(&self, id: &str, definitions: Vec<AgentDefinition>) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_some() {
            // Preserve unconfirmed local creates a stale snapshot would drop (#2486).
            let definitions = inner.reconcile_definitions(id, definitions);
            inner.definitions.insert(id.to_string(), definitions);
        }
    }

    /// Replace one agent's folder list with a server-produced snapshot (the
    /// `list_agent_connections` RPC outcome, #2388). Sets only the folders slice
    /// (see [`Self::set_sessions`]). A no-op for an unknown id; idempotent.
    pub fn set_folders(&self, id: &str, folders: Vec<AgentFolder>) {
        let mut inner = self.lock();
        if inner.agent_mut(id).is_some() {
            // Preserve unconfirmed local creates a stale snapshot would drop (#2486).
            let folders = inner.reconcile_folders(id, folders);
            inner.folders.insert(id.to_string(), folders);
        }
    }

    // ── Definition CRUD (on-agent connection definitions) ─────────────────────

    /// `agent.saveDefinition` — upsert a saved definition on an agent
    /// (`saveAgentDef`): replace any existing entry with the same id, else append.
    ///
    /// Applies even when the agent entry is not (yet) present (#2486): the create is
    /// recorded in the per-agent definition map (and as an unconfirmed pending
    /// create) so that if the entry lands moments later — via the persisted-list fold
    /// or the client `agent.add` mirror — the definition is already there and
    /// renders, instead of being silently dropped by a bare unknown-id no-op. The
    /// map key is self-cleaning: `reflect_saved_agents` drops sub-state for any id
    /// that is not a real persisted agent.
    pub fn save_definition(&self, id: &str, definition: AgentDefinition) {
        let mut inner = self.lock();
        inner.track_pending_definition(id, &definition);
        let list = inner.definitions.entry(id.to_string()).or_default();
        list.retain(|d| d.id != definition.id);
        list.push(definition);
    }

    /// `agent.updateDefinition` — replace an existing definition by id
    /// (`updateAgentDef`). A no-op if the agent or definition is unknown.
    pub fn update_definition(&self, id: &str, definition: AgentDefinition) {
        let mut inner = self.lock();
        // Keep an unconfirmed create's pending copy current so an edit made before a
        // snapshot confirms it is not lost when a stale snapshot is reconciled (#2486).
        if inner
            .pending_definitions
            .get(id)
            .is_some_and(|list| list.iter().any(|d| d.id == definition.id))
        {
            inner.track_pending_definition(id, &definition);
        }
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
        // A locally deleted definition must stay deleted — stop protecting it (#2486).
        inner.untrack_pending_definition(id, definition_id);
        if let Some(list) = inner.definitions.get_mut(id) {
            list.retain(|d| d.id != definition_id);
        }
    }

    // ── Folder CRUD ───────────────────────────────────────────────────────────

    /// `agent.createFolder` — add a folder to an agent (`createAgentFolder`).
    /// Upsert by id: replace any existing folder with the same id, else append. A
    /// no-op for an unknown agent id.
    ///
    /// Upsert (rather than a bare append) keeps the transition idempotent so the
    /// server-side fold of the `create_agent_folder` RPC outcome (#2388) and the
    /// additive client `agent.createFolder` mirror — both carrying the same
    /// server-assigned folder id — converge on one entry instead of duplicating
    /// it. Folder ids are unique, so legitimate creates never collide and see no
    /// behavior change.
    ///
    /// Applies even when the agent entry is not (yet) present (#2486): the folder is
    /// recorded in the per-agent folder map (and as an unconfirmed pending create) so
    /// a create that races the agent's entry-creation fold is not silently dropped —
    /// it renders as soon as the entry lands. See [`Self::save_definition`].
    pub fn create_folder(&self, id: &str, folder: AgentFolder) {
        let mut inner = self.lock();
        inner.track_pending_folder(id, &folder);
        let list = inner.folders.entry(id.to_string()).or_default();
        list.retain(|f| f.id != folder.id);
        list.push(folder);
    }

    /// `agent.updateFolder` — replace an existing folder by id
    /// (`updateAgentFolder` / `toggleAgentFolder`). A no-op if unknown.
    pub fn update_folder(&self, id: &str, folder: AgentFolder) {
        let mut inner = self.lock();
        // Keep an unconfirmed create's pending copy current (see update_definition, #2486).
        if inner
            .pending_folders
            .get(id)
            .is_some_and(|list| list.iter().any(|f| f.id == folder.id))
        {
            inner.track_pending_folder(id, &folder);
        }
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
        // A locally deleted folder must stay deleted — stop protecting it (#2486).
        inner.untrack_pending_folder(id, folder_id);
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
        // The whole slice is replaced from an authority; unconfirmed creates it does
        // not carry are subsumed by it (#2486).
        inner.pending_folders.clear();
        inner.pending_definitions.clear();
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
