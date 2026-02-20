use std::sync::Arc;

use serde_json::Value;
use tauri::State;
use tracing::{debug, info};

use crate::terminal::agent_deploy::{
    AgentDeployConfig, AgentDeployResult, AgentProbeResult,
};
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionManager, AgentDefinitionInfo,
    AgentSessionInfo,
};
use crate::terminal::agent_setup::{AgentSetupConfig, AgentSetupResult};
use crate::terminal::backend::RemoteAgentConfig;
use crate::terminal::manager::TerminalManager;

/// Connect to a remote agent via SSH.
///
/// Async because SSH authentication + JSON-RPC handshake are blocking
/// network operations that must not run on the main thread (which would
/// freeze the WebView).
#[tauri::command]
pub async fn connect_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<AgentConnectResult, String> {
    info!(agent_id, host = %config.host, "Connecting to remote agent");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .connect_agent(&agent_id, &config)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
pub fn disconnect_agent(
    agent_id: String,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<(), String> {
    info!(agent_id, "Disconnecting remote agent");
    agent_manager
        .disconnect_agent(&agent_id)
        .map_err(|e| e.to_string())
}

/// Gracefully shut down a remote agent and disconnect.
///
/// Sends `agent.shutdown` over JSON-RPC, waits for the response, then
/// disconnects. Returns the number of sessions left running on the remote.
#[tauri::command]
pub async fn shutdown_agent(
    agent_id: String,
    reason: Option<String>,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
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
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<AgentCapabilities, String> {
    agent_manager
        .get_capabilities(&agent_id)
        .ok_or_else(|| format!("Agent {} not connected", agent_id))
}

/// List sessions on a remote agent.
///
/// Async because it sends a JSON-RPC request over SSH.
#[tauri::command]
pub async fn list_agent_sessions(
    agent_id: String,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
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
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
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
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
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
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
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

/// Upload and install the agent binary on a remote host.
///
/// Async because it creates an SSH terminal session (blocking network I/O).
#[tauri::command]
pub async fn setup_remote_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    setup_config: AgentSetupConfig,
    app_handle: tauri::AppHandle,
    manager: State<'_, TerminalManager>,
) -> Result<AgentSetupResult, String> {
    info!(agent_id, host = %config.host, "Starting remote agent setup");
    let tm = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::agent_setup::setup_remote_agent(
            &agent_id,
            &config,
            &setup_config,
            &app_handle,
            &tm,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
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
) -> Result<AgentDeployResult, String> {
    info!(agent_id, host = %config.host, "Deploying agent to remote host");
    tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::agent_deploy::deploy_agent(
            &agent_id,
            &config,
            &deploy_config,
            &app_handle,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Update the agent: shut down the running instance, then deploy a new binary.
#[tauri::command]
pub async fn update_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    deploy_config: AgentDeployConfig,
    app_handle: tauri::AppHandle,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<AgentDeployResult, String> {
    info!(agent_id, host = %config.host, "Updating agent on remote host");
    let manager = agent_manager.inner().clone();
    let aid = agent_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::terminal::agent_deploy::update_agent(
            &agent_id,
            &config,
            &deploy_config,
            &app_handle,
            || manager.shutdown_agent(&aid, Some("update")),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}
