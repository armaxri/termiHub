use std::sync::Arc;

use serde_json::Value;
use tauri::State;
use tracing::{debug, info, warn};

use crate::agents_projection::projection::fold_agent_transition;
use crate::agents_projection::store::{
    AgentDefinition as StoreAgentDefinition, AgentFolder as StoreAgentFolder,
    AgentSession as StoreAgentSession,
};
use crate::connection::config::AgentSettings;
use crate::connection::manager::ConnectionManager;
use crate::session::manager::SessionManager;
use crate::terminal::agent_cancel::AgentDeployCancellation;
use crate::terminal::agent_deploy::{AgentDeployConfig, AgentDeployResult, AgentProbeResult};
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
    AgentFolderInfo, AgentRpcClient, AgentSessionInfo,
};
use crate::terminal::agent_setup::{AgentSetupConfig, AgentSetupResult, RemoteArchInfo};
use crate::terminal::backend::{RemoteAgentConfig, UpdateStrategy};

// ── Server-authority projection folds (#2388) ────────────────────────────────
//
// The definition/folder/session CRUD commands below fold their RPC outcome into
// the shared `AgentsStore` **at the source** (see `fold_agent_transition`), so the
// `agents` projection region is fed server-side rather than only by the client
// `agent.*` mirror. Additive: every command still returns its value to the
// frontend unchanged, and the transitions are idempotent so running alongside the
// (still-present) client mirror converges without drift. The `Info` wire types
// and the store types share the same camelCase shape one-to-one; these helpers
// convert without a serde round-trip.

/// Convert an agent definition RPC value into the store's definition shape.
fn to_store_definition(info: &AgentDefinitionInfo) -> StoreAgentDefinition {
    StoreAgentDefinition {
        id: info.id.clone(),
        name: info.name.clone(),
        session_type: info.session_type.clone(),
        config: info.config.clone(),
        persistent: info.persistent,
        folder_id: info.folder_id.clone(),
        terminal_options: info.terminal_options.clone(),
        icon: info.icon.clone(),
        source_file: info.source_file.clone(),
    }
}

/// Convert an agent folder RPC value into the store's folder shape.
fn to_store_folder(info: &AgentFolderInfo) -> StoreAgentFolder {
    StoreAgentFolder {
        id: info.id.clone(),
        name: info.name.clone(),
        parent_id: info.parent_id.clone(),
        is_expanded: info.is_expanded,
    }
}

/// Convert an agent session RPC value into the store's session shape.
fn to_store_session(info: &AgentSessionInfo) -> StoreAgentSession {
    StoreAgentSession {
        session_id: info.session_id.clone(),
        title: info.title.clone(),
        session_type: info.session_type.clone(),
        status: info.status.clone(),
        attached: info.attached,
        definition_id: info.definition_id.clone(),
    }
}

/// Connect to a remote agent via SSH.
///
/// Async because SSH authentication + JSON-RPC handshake are blocking
/// network operations that must not run on the main thread (which would
/// freeze the WebView).
///
/// `backend_reattach` carries the client's default-off `sessionBackendReattach`
/// flag (#2472). When `Some(true)`, the manager retains this agent's SSH
/// transport config so the server-side reconnect redrive can cold-re-establish
/// the transport after a reap; when absent/`false` (the develop path) nothing is
/// retained and no agent secret survives a reap — byte-identical. The frontend
/// does not thread this yet; it is wired with the agent-tab routing (#2473).
#[tauri::command]
pub async fn connect_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    agent_settings: Option<AgentSettings>,
    backend_reattach: Option<bool>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentConnectResult, String> {
    info!(agent_id, host = %config.host, "Connecting to remote agent");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = manager
            .connect_agent(&agent_id, &config, agent_settings.as_ref())
            .map_err(|e| e.to_string())?;
        // Only an opted-in connect retains the reattach config (#2472); the
        // default-off path leaves the store untouched.
        if backend_reattach == Some(true) {
            manager.retain_agent_config(&agent_id, &config, agent_settings.as_ref());
        }
        Ok(result)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub fn disconnect_agent(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, "Disconnecting remote agent");
    agent_manager
        .disconnect_agent(&agent_id)
        .map_err(|e| e.to_string())
}

/// Sweep every agent whose I/O task has already died (`alive == false`).
///
/// Manual resource-hygiene escape hatch surfaced in the Open Connections panel
/// (G6, #1239). Returns the ids that were pruned.
#[tauri::command]
pub fn prune_dead_agents(
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<Vec<String>, String> {
    let pruned = agent_manager.prune_dead_agents();
    info!(count = pruned.len(), "Pruned dead remote agents");
    Ok(pruned)
}

/// Cancel an in-flight (still connecting) agent connect.
///
/// Fires the per-agent cancellation token registered by [`connect_agent`] so a
/// Cancel while connecting aborts the blocking SSH + initialize handshake
/// promptly instead of waiting out the connect timeout; the connect path then
/// emits `disconnected` (single writer). Returns whether a connecting agent was
/// found. No-op if the connect already finished (G1, #1235).
#[tauri::command]
pub fn cancel_connect_agent(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<bool, String> {
    info!(agent_id, "Cancelling in-flight agent connect");
    Ok(agent_manager.cancel_connect(&agent_id))
}

/// Gracefully shut down a remote agent and disconnect.
///
/// Sends `agent.shutdown` over JSON-RPC, waits for the response, then
/// disconnects. Returns the number of sessions left running on the remote.
#[tauri::command]
pub async fn shutdown_agent(
    agent_id: String,
    reason: Option<String>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<u32, String> {
    info!(agent_id, "Shutting down remote agent");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .shutdown_agent(&agent_id, reason.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub fn get_agent_capabilities(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentCapabilities, String> {
    agent_manager
        .get_capabilities(&agent_id)
        .ok_or_else(|| format!("Agent {} not connected", agent_id))
}

/// Push updated AgentSettings to a running agent (live reload) and persist locally.
///
/// Sends `agent.settingsUpdate` over JSON-RPC, then saves the updated settings
/// to connections.json so they take effect on the next connect as well.
#[tauri::command]
pub async fn apply_agent_settings(
    agent_id: String,
    settings: AgentSettings,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
    conn_manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    info!(agent_id, "Applying agent settings live");

    // Persist to connections.json first (source of truth)
    conn_manager
        .update_agent_settings(&agent_id, settings.clone())
        .map_err(|e| e.to_string())?;

    // Push to running agent if connected
    let manager = agent_manager.inner().clone();
    let settings_clone = settings.clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .apply_agent_settings(&agent_id, &settings_clone)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Response to a deferred-update request (`request_agent_deferred_update`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeferredUpdateResponse {
    /// `true` if the agent was idle and applied the update immediately.
    pub applied: bool,
    /// Sessions still active on the agent (0 when applied immediately).
    pub active_sessions: u32,
}

/// Request a deferred agent update (#1352).
///
/// Sends `agent.request_deferred_update` over JSON-RPC. When `binary_path` is
/// omitted the agent applies an update it already staged itself ("Apply Now").
/// The agent applies immediately only when idle; otherwise it defers until the
/// last session disconnects, never interrupting active sessions.
///
/// Note: when the agent applies immediately it re-execs the new binary, which
/// tears down the current connection — the caller should treat a subsequent
/// disconnect as expected and reconnect to observe the new version.
#[tauri::command]
pub async fn request_agent_deferred_update(
    agent_id: String,
    binary_path: Option<String>,
    version: Option<String>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<DeferredUpdateResponse, String> {
    info!(agent_id, "Requesting deferred agent update");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut params = serde_json::Map::new();
        if let Some(path) = binary_path {
            params.insert("binaryPath".to_string(), Value::String(path));
        }
        if let Some(v) = version {
            params.insert("version".to_string(), Value::String(v));
        }
        let result = manager
            .send_request(
                &agent_id,
                "agent.request_deferred_update",
                Value::Object(params),
            )
            .map_err(|e| e.to_string())?;
        Ok(DeferredUpdateResponse {
            applied: result
                .get("applied")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            active_sessions: result
                .get("activeSessions")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
        })
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Response to a coordinated-update request (`request_agent_update`, #1602).
///
/// Mirrors the agent's `agent.request_update` result (#1351): the apply outcome
/// (`applied` / `active_sessions`) plus the coordination outcome (`notified_clients`
/// / `all_acked` / `remaining_clients`), so the desktop can report *"3 hosts were
/// notified, 1 was still connected"* rather than only "done".
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatedUpdateResponse {
    /// `true` if the agent was idle and applied the update immediately.
    pub applied: bool,
    /// Sessions still active on the agent (0 when applied immediately).
    pub active_sessions: u32,
    /// How many *other* hosts were sent the `agent.update_pending` notice.
    pub notified_clients: u32,
    /// `true` when every notified host disconnected inside the window (or there
    /// was nobody to notify); `false` when the window closed with hosts still
    /// attached, or when no host-wide view was available.
    pub all_acked: bool,
    /// `client_id`s still attached when the window closed. Empty on the happy path.
    pub remaining_clients: Vec<String>,
}

/// Request a coordinated agent update (#1602, SI-5).
///
/// Sends `agent.request_update` over JSON-RPC (#1351). The agent broadcasts an
/// `agent.update_pending` notice to every *other* connected host, gives them a
/// window to disconnect cleanly, then applies the update through the same
/// deferred-apply path as [`request_agent_deferred_update`] — never interrupting
/// active sessions. When `binary_path` is omitted the agent applies an update it
/// already staged itself (the coordinated self-update "Apply Now" path).
///
/// Note: when the agent applies immediately it re-execs the new binary, which
/// tears down this connection — the caller should treat a subsequent disconnect
/// as expected and reconnect to observe the new version.
#[tauri::command]
pub async fn request_agent_update(
    agent_id: String,
    binary_path: Option<String>,
    version: Option<String>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<CoordinatedUpdateResponse, String> {
    info!(agent_id, "Requesting coordinated agent update");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut params = serde_json::Map::new();
        if let Some(path) = binary_path {
            params.insert("binaryPath".to_string(), Value::String(path));
        }
        if let Some(v) = version {
            params.insert("version".to_string(), Value::String(v));
        }
        let result = manager
            .send_request(&agent_id, "agent.request_update", Value::Object(params))
            .map_err(|e| e.to_string())?;
        Ok(CoordinatedUpdateResponse {
            applied: result
                .get("applied")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            active_sessions: result
                .get("activeSessions")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
            notified_clients: result
                .get("notifiedClients")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
            all_acked: result
                .get("allAcked")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            remaining_clients: result
                .get("remainingClients")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        })
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Close a session on a remote agent.
///
/// Sends `connection.close` over JSON-RPC to the agent, then the agent
/// tears down the backend and frees its resources (serial port, SSH channel, etc.).
#[tauri::command]
pub async fn close_agent_session(
    agent_id: String,
    session_id: String,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, session_id, "Closing session on remote agent");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let sid = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.close_session(&aid, &sid).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): drop the closed session from the shared store
    // at the source.
    if result.is_ok() {
        fold_agent_transition(&app_handle, |store| {
            store.remove_session(&agent_id, &session_id);
        });
    }
    result
}

/// List sessions on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_sessions(
    agent_id: String,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<Vec<AgentSessionInfo>, String> {
    debug!(agent_id, "Listing agent sessions");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.list_sessions(&aid).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): mirror the live-session snapshot into the
    // shared store at the source.
    if let Ok(sessions) = &result {
        let stored = sessions.iter().map(to_store_session).collect();
        fold_agent_transition(&app_handle, |store| store.set_sessions(&agent_id, stored));
    }
    result
}

/// List saved session definitions on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_definitions(
    agent_id: String,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<Vec<AgentDefinitionInfo>, String> {
    debug!(agent_id, "Listing agent definitions");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.list_definitions(&aid).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): mirror the saved-definition snapshot into the
    // shared store at the source.
    if let Ok(definitions) = &result {
        let stored = definitions.iter().map(to_store_definition).collect();
        fold_agent_transition(&app_handle, |store| {
            store.set_definitions(&agent_id, stored)
        });
    }
    result
}

/// Save a session definition on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn save_agent_definition(
    agent_id: String,
    definition: Value,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentDefinitionInfo, String> {
    debug!(agent_id, "Saving agent definition");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager
            .save_definition(&aid, definition)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): upsert the saved definition into the shared
    // store at the source.
    if let Ok(info) = &result {
        let stored = to_store_definition(info);
        fold_agent_transition(&app_handle, |store| {
            store.save_definition(&agent_id, stored)
        });
    }
    result
}

/// Delete a session definition on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn delete_agent_definition(
    agent_id: String,
    definition_id: String,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, definition_id, "Deleting agent definition");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let did = definition_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager
            .delete_definition(&aid, &did)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): drop the deleted definition from the shared
    // store at the source.
    if result.is_ok() {
        fold_agent_transition(&app_handle, |store| {
            store.delete_definition(&agent_id, &definition_id);
        });
    }
    result
}

/// List saved connections and folders on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_connections(
    agent_id: String,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentConnectionsData, String> {
    debug!(agent_id, "Listing agent connections and folders");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager
            .list_connections_and_folders(&aid)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): mirror the saved connections + folders
    // snapshot into the shared store at the source (definitions and folders slices
    // only; the live-session slice is left to `list_agent_sessions`).
    if let Ok(data) = &result {
        let definitions = data.connections.iter().map(to_store_definition).collect();
        let folders = data.folders.iter().map(to_store_folder).collect();
        fold_agent_transition(&app_handle, |store| {
            store.set_definitions(&agent_id, definitions);
            store.set_folders(&agent_id, folders);
        });
    }
    result
}

/// Update a saved connection definition on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn update_agent_definition(
    agent_id: String,
    params: Value,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentDefinitionInfo, String> {
    debug!(agent_id, "Updating agent definition");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager
            .update_definition(&aid, params)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): replace the updated definition in the shared
    // store at the source.
    if let Ok(info) = &result {
        let stored = to_store_definition(info);
        fold_agent_transition(&app_handle, |store| {
            store.update_definition(&agent_id, stored)
        });
    }
    result
}

/// Create a folder on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn create_agent_folder(
    agent_id: String,
    name: String,
    parent_id: Option<String>,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentFolderInfo, String> {
    debug!(agent_id, %name, "Creating agent folder");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager
            .create_folder(&aid, &name, parent_id.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): add the new folder to the shared store at the
    // source (upsert by id, so the additive client mirror does not duplicate it).
    if let Ok(info) = &result {
        let stored = to_store_folder(info);
        fold_agent_transition(&app_handle, |store| store.create_folder(&agent_id, stored));
    }
    result
}

/// Update a folder on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn update_agent_folder(
    agent_id: String,
    params: Value,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentFolderInfo, String> {
    debug!(agent_id, "Updating agent folder");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager
            .update_folder(&aid, params)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): replace the updated folder in the shared store
    // at the source.
    if let Ok(info) = &result {
        let stored = to_store_folder(info);
        fold_agent_transition(&app_handle, |store| store.update_folder(&agent_id, stored));
    }
    result
}

/// Delete a folder on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn delete_agent_folder(
    agent_id: String,
    folder_id: String,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, folder_id, "Deleting agent folder");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    let fid = folder_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.delete_folder(&aid, &fid).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    // Server-authority fold (#2388): drop the deleted folder from the shared store
    // at the source (reparenting its child definitions to the root, as the store's
    // `delete_folder` does).
    if result.is_ok() {
        fold_agent_transition(&app_handle, |store| {
            store.delete_folder(&agent_id, &folder_id);
        });
    }
    result
}

/// Detect the remote host's architecture before the setup dialog opens.
///
/// Establishes a temporary SSH connection, runs `uname -m` and `uname -s`,
/// and returns the architecture information including the pre-computed
/// GitHub download URL for the running termiHub version.
#[tauri::command]
pub async fn detect_agent_arch(config: RemoteAgentConfig) -> Result<RemoteArchInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::agent_setup::detect_agent_arch_info(&config).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Upload and install the agent binary on a remote host.
///
/// Async because it creates an SSH terminal session (blocking network I/O).
/// Registers a cancellation token (keyed by `agent_id`) so [`cancel_agent_setup`]
/// can abort the in-flight SFTP upload / script injection between steps and roll
/// back the partial upload (G10, #1242).
#[tauri::command]
pub async fn setup_remote_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    setup_config: AgentSetupConfig,
    app_handle: tauri::AppHandle,
    manager: State<'_, SessionManager>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentSetupResult, String> {
    info!(agent_id, host = %config.host, "Starting remote agent setup");
    let sm = manager.inner().clone();
    // Register up front so a Cancel that arrives while the background upload runs
    // finds the token. The token is `Arc`-shared with the registry; the background
    // thread checks it between steps and clears the entry on completion.
    let token = cancellation.register(&agent_id);
    let registry = cancellation.inner().clone();
    let complete_id = agent_id.clone();
    let complete_token = token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::agent_setup::setup_remote_agent(
            &agent_id,
            &config,
            &setup_config,
            &app_handle,
            &sm,
            Some((*token).clone()),
            move || registry.complete(&complete_id, &complete_token),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Cancel an in-flight agent deploy/setup.
///
/// Fires the per-agent cancellation token registered by [`setup_remote_agent`] /
/// [`deploy_agent`] / [`update_agent`] so the background SFTP upload + script
/// injection aborts between steps and rolls back the partial upload, instead of
/// running to completion. Returns whether a run was in flight (G10, #1242).
#[tauri::command]
pub fn cancel_agent_setup(
    agent_id: String,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<bool, String> {
    info!(agent_id, "Cancelling in-flight agent deploy/setup");
    Ok(cancellation.cancel(&agent_id))
}

/// Probe a remote host for an existing agent binary.
///
/// Checks if `termihub-agent` is installed and what version it is,
/// without modifying anything on the remote host.
#[tauri::command]
pub async fn probe_remote_agent(
    config: RemoteAgentConfig,
    expected_version: Option<String>,
) -> Result<AgentProbeResult, String> {
    info!(host = %config.host, "Probing remote host for agent");
    let version = expected_version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::agent_deploy::probe_remote_agent(&config, &version)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Deploy the agent binary to a remote host via SFTP.
///
/// Resolves the binary (cache → bundled → download), uploads it,
/// and verifies the installation.
#[tauri::command]
pub async fn deploy_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    info!(agent_id, host = %config.host, "Deploying agent to remote host");
    let token = cancellation.register(&agent_id);
    let registry = cancellation.inner().clone();
    let complete_id = agent_id.clone();
    let complete_token = token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::terminal::agent_deploy::deploy_agent(
            &agent_id,
            &config,
            &deploy_config,
            &app_handle,
            Some(&token),
        )
        .map_err(|e| e.to_string());
        registry.complete(&complete_id, &complete_token);
        result
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Update the agent: shut down the running instance, then deploy a new binary.
///
/// Runs the connected-host guard first: if other hosts are connected to the
/// agent, returns [`AgentDeployResult::OtherHostsConnected`] without touching
/// the remote so the desktop can warn the user (#1349). Confirming routes to
/// [`update_agent_force`].
#[tauri::command]
pub async fn update_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    run_update_agent(
        false,
        agent_id,
        config,
        deploy_config,
        app_handle,
        agent_manager.inner().clone(),
        cancellation,
    )
    .await
}

/// Force an agent update, bypassing the connected-host guard.
///
/// Called after the user confirms in the Update dialog that other connected
/// hosts may be hard-cut (#1349). Otherwise identical to [`update_agent`].
#[tauri::command]
pub async fn update_agent_force(
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    run_update_agent(
        true,
        agent_id,
        config,
        deploy_config,
        app_handle,
        agent_manager.inner().clone(),
        cancellation,
    )
    .await
}

/// Shared body for [`update_agent`] / [`update_agent_force`]. `force` skips the
/// connected-host guard.
///
/// Routes to the update path for the configured strategy:
/// - `Coordinated` → stage the binary, then dispatch `agent.request_update` so
///   the agent notifies other hosts and self-applies (Unix); Windows falls back
///   to the immediate path because the agent's self-swap is Unix-only (#1616).
/// - `Immediate` (and `Deferred`, which has no desktop-push dispatch path yet) →
///   the hard shutdown + redeploy path.
async fn run_update_agent(
    force: bool,
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    manager: Arc<dyn AgentRpcClient>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    let requested = config.update_strategy;
    let effective = config.effective_update_strategy();
    if requested != effective {
        warn!(
            agent_id,
            ?requested,
            ?effective,
            "Update strategy has no desktop-push dispatch path; falling back to immediate update"
        );
    }
    if effective == UpdateStrategy::Coordinated {
        return run_coordinated_update(
            force,
            agent_id,
            config,
            deploy_config,
            app_handle,
            manager,
            cancellation,
        )
        .await;
    }
    run_immediate_update(
        force,
        agent_id,
        config,
        deploy_config,
        app_handle,
        manager,
        cancellation,
    )
    .await
}

/// The immediate desktop-push update: hard shutdown + redeploy. Also the
/// Windows fallback for a `Coordinated` strategy (#1616).
async fn run_immediate_update(
    force: bool,
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    manager: Arc<dyn AgentRpcClient>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    info!(
        agent_id,
        host = %config.host,
        force,
        "Updating agent on remote host (immediate)"
    );
    let aid = agent_id.clone();
    let list_manager = manager.clone();
    let list_aid = agent_id.clone();
    let token = cancellation.register(&agent_id);
    let registry = cancellation.inner().clone();
    let complete_id = agent_id.clone();
    let complete_token = token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::terminal::agent_deploy::update_agent(
            &agent_id,
            &config,
            &deploy_config,
            &app_handle,
            Some(&token),
            force,
            || list_manager.list_connections(&list_aid),
            || manager.shutdown_agent(&aid, Some("update")),
        )
        .map_err(|e| e.to_string());
        registry.complete(&complete_id, &complete_token);
        result
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// The coordinated desktop-push update (#1616): stage the binary, then hand it
/// to `agent.request_update` so the agent broadcasts `agent.update_pending` to
/// every *other* connected host, gives them a clean disconnect window, and
/// self-applies (swap + re-exec) — never hard-cutting sessions.
///
/// The connected-host guard is intentionally skipped: the notice *is* the
/// courtesy. On a **Windows** host the agent cannot self-swap a running binary
/// (`agent/src/update/apply.rs` is Unix-only), so this falls back to the
/// immediate deploy path — exactly today's behaviour, with the guard intact.
async fn run_coordinated_update(
    force: bool,
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    manager: Arc<dyn AgentRpcClient>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    info!(
        agent_id,
        host = %config.host,
        force,
        "Updating agent on remote host (coordinated)"
    );

    // 1. Stage the binary (connect, detect OS, upload to temp on Unix).
    let token = cancellation.register(&agent_id);
    let registry = cancellation.inner().clone();
    let stage_id = agent_id.clone();
    let stage_config = config.clone();
    let stage_deploy = deploy_config.clone();
    let stage_app = app_handle.clone();
    let stage_token = token.clone();
    let complete_id = agent_id.clone();
    let complete_token = token.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        let result = crate::terminal::agent_deploy::stage_agent_binary(
            &stage_id,
            &stage_config,
            &stage_deploy,
            &stage_app,
            Some(&stage_token),
        )
        .map_err(|e| e.to_string());
        registry.complete(&complete_id, &complete_token);
        result
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))?;

    // 2. Windows: the agent cannot self-swap — fall back to the immediate deploy
    //    (shutdown + redeploy), which keeps the connected-host guard intact.
    let Some(binary_path) = staged.upload_path else {
        warn!(
            agent_id,
            remote_os = %staged.remote_os,
            "Coordinated update on a Windows host; falling back to immediate deploy (agent self-swap is Unix-only)"
        );
        return run_immediate_update(
            force,
            agent_id,
            config,
            deploy_config,
            app_handle,
            manager,
            cancellation,
        )
        .await;
    };

    // 3. Unix: dispatch the coordinated RPC. The agent notifies other hosts,
    //    waits out the window, then self-applies from the staged path.
    let rpc_agent = agent_id.clone();
    let rpc_manager = manager.clone();
    let version = env!("CARGO_PKG_VERSION").to_string();
    let rpc_result = tauri::async_runtime::spawn_blocking(move || {
        let mut params = serde_json::Map::new();
        params.insert("binaryPath".to_string(), Value::String(binary_path));
        params.insert("version".to_string(), Value::String(version));
        rpc_manager.send_request(&rpc_agent, "agent.request_update", Value::Object(params))
    })
    .await
    .map_err(|e| e.to_string())?;

    match rpc_result {
        Ok(value) => Ok(coordinated_deploy_result(&value)),
        Err(e) => {
            let msg = e.to_string();
            // A dropped connection right after dispatch is the agent applying an
            // idle update — swap + re-exec tears down the transport. That is
            // expected success, not a failure (mirrors the self-update path).
            if is_expected_apply_disconnect(&msg) {
                info!(
                    agent_id,
                    "Coordinated update dispatched; connection dropped as the agent swaps + re-execs (expected)"
                );
                Ok(AgentDeployResult::Coordinated {
                    applied: true,
                    active_sessions: 0,
                    notified_clients: 0,
                    all_acked: true,
                    remaining_clients: Vec::new(),
                })
            } else {
                Err(msg)
            }
        }
    }
}

/// Build an [`AgentDeployResult::Coordinated`] from the `agent.request_update`
/// JSON-RPC result (#1616). Mirrors the field extraction in
/// [`request_agent_update`]'s [`CoordinatedUpdateResponse`].
fn coordinated_deploy_result(value: &Value) -> AgentDeployResult {
    AgentDeployResult::Coordinated {
        applied: value
            .get("applied")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        active_sessions: value
            .get("activeSessions")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        notified_clients: value
            .get("notifiedClients")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        all_acked: value
            .get("allAcked")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        remaining_clients: value
            .get("remainingClients")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Whether an error from `agent.request_update` is the expected transport drop
/// caused by the agent swapping its binary and re-execing on an idle apply,
/// rather than a genuine failure. Mirrors the frontend `AgentUpdateBanner`
/// classifier so the happy path (idle agent updates) reports success (#1616).
fn is_expected_apply_disconnect(message: &str) -> bool {
    let raw = message.to_ascii_lowercase();
    [
        "disconnect",
        "connection",
        "closed",
        "timeout",
        "reset",
        "eof",
        "not connected",
        "broken pipe",
    ]
    .iter()
    .any(|needle| raw.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The coordinated deploy result carries the RPC's coordination outcome so
    /// the desktop can report "N hosts notified, M still attached" (#1616).
    #[test]
    fn coordinated_deploy_result_maps_rpc_fields() {
        let value = json!({
            "applied": false,
            "activeSessions": 2,
            "notifiedClients": 3,
            "allAcked": false,
            "remainingClients": ["id-7", "id-8"],
        });
        let result = coordinated_deploy_result(&value);
        match result {
            AgentDeployResult::Coordinated {
                applied,
                active_sessions,
                notified_clients,
                all_acked,
                remaining_clients,
            } => {
                assert!(!applied);
                assert_eq!(active_sessions, 2);
                assert_eq!(notified_clients, 3);
                assert!(!all_acked);
                assert_eq!(remaining_clients, vec!["id-7", "id-8"]);
            }
            other => panic!("expected Coordinated, got {other:?}"),
        }
    }

    /// Missing/garbage fields degrade to safe defaults rather than panicking.
    #[test]
    fn coordinated_deploy_result_defaults_on_missing_fields() {
        let result = coordinated_deploy_result(&json!({}));
        assert_eq!(
            result,
            AgentDeployResult::Coordinated {
                applied: false,
                active_sessions: 0,
                notified_clients: 0,
                all_acked: false,
                remaining_clients: vec![],
            }
        );
    }

    /// A transport drop right after dispatch is the agent swapping + re-execing,
    /// not a failure — the coordinated deploy reports it as applied success.
    #[test]
    fn expected_apply_disconnect_recognizes_transport_drops() {
        for msg in [
            "Connection reset by peer",
            "agent disconnected",
            "channel closed",
            "request timeout",
            "unexpected EOF",
            "not connected",
            "broken pipe",
        ] {
            assert!(
                is_expected_apply_disconnect(msg),
                "{msg:?} should be an expected apply disconnect"
            );
        }
    }

    /// A genuine RPC/application error must NOT be masked as success.
    #[test]
    fn expected_apply_disconnect_rejects_real_errors() {
        for msg in [
            "binary not found: /tmp/termihub-agent-upload",
            "invalid params",
            "permission denied",
        ] {
            assert!(
                !is_expected_apply_disconnect(msg),
                "{msg:?} is a real error and must surface"
            );
        }
    }
}
