use std::sync::Arc;

use serde_json::Value;
use tauri::State;
use tracing::{debug, info, warn};

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
use crate::terminal::backend::RemoteAgentConfig;

/// Connect to a remote agent via SSH.
///
/// Async because SSH authentication + JSON-RPC handshake are blocking
/// network operations that must not run on the main thread (which would
/// freeze the WebView).
#[tauri::command]
pub async fn connect_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    agent_settings: Option<AgentSettings>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentConnectResult, String> {
    info!(agent_id, host = %config.host, "Connecting to remote agent");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .connect_agent(&agent_id, &config, agent_settings.as_ref())
            .map_err(|e| e.to_string())
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

/// Close a session on a remote agent.
///
/// Sends `connection.close` over JSON-RPC to the agent, then the agent
/// tears down the backend and frees its resources (serial port, SSH channel, etc.).
#[tauri::command]
pub async fn close_agent_session(
    agent_id: String,
    session_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, session_id, "Closing session on remote agent");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .close_session(&agent_id, &session_id)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// List sessions on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_sessions(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<Vec<AgentSessionInfo>, String> {
    debug!(agent_id, "Listing agent sessions");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.list_sessions(&agent_id).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// List saved session definitions on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_definitions(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<Vec<AgentDefinitionInfo>, String> {
    debug!(agent_id, "Listing agent definitions");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .list_definitions(&agent_id)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Save a session definition on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn save_agent_definition(
    agent_id: String,
    definition: Value,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentDefinitionInfo, String> {
    debug!(agent_id, "Saving agent definition");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .save_definition(&agent_id, definition)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Delete a session definition on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn delete_agent_definition(
    agent_id: String,
    definition_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, definition_id, "Deleting agent definition");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .delete_definition(&agent_id, &definition_id)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// List saved connections and folders on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_connections(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentConnectionsData, String> {
    debug!(agent_id, "Listing agent connections and folders");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .list_connections_and_folders(&agent_id)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Update a saved connection definition on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn update_agent_definition(
    agent_id: String,
    params: Value,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentDefinitionInfo, String> {
    debug!(agent_id, "Updating agent definition");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .update_definition(&agent_id, params)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Create a folder on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn create_agent_folder(
    agent_id: String,
    name: String,
    parent_id: Option<String>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentFolderInfo, String> {
    debug!(agent_id, %name, "Creating agent folder");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .create_folder(&agent_id, &name, parent_id.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Update a folder on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn update_agent_folder(
    agent_id: String,
    params: Value,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentFolderInfo, String> {
    debug!(agent_id, "Updating agent folder");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .update_folder(&agent_id, params)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Delete a folder on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn delete_agent_folder(
    agent_id: String,
    folder_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<(), String> {
    info!(agent_id, folder_id, "Deleting agent folder");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .delete_folder(&agent_id, &folder_id)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
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
async fn run_update_agent(
    force: bool,
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    manager: Arc<dyn AgentRpcClient>,
    cancellation: State<'_, AgentDeployCancellation>,
) -> Result<AgentDeployResult, String> {
    // Route to the update path for the configured strategy. Only the immediate
    // path (hard shutdown + redeploy) exists today; coordinated/deferred fall
    // back to it until SI-5/SI-6 land (see #1354 and its follow-ups).
    let requested = config.update_strategy;
    let effective = config.effective_update_strategy();
    if requested != effective {
        warn!(
            agent_id,
            ?requested,
            ?effective,
            "Update strategy not yet implemented; falling back to immediate update"
        );
    }
    info!(
        agent_id,
        host = %config.host,
        strategy = ?effective,
        force,
        "Updating agent on remote host"
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
