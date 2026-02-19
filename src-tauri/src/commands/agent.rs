use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionManager, AgentDefinitionInfo,
    AgentSessionInfo,
};
use crate::terminal::agent_setup::{AgentSetupConfig, AgentSetupResult};
use crate::terminal::backend::RemoteAgentConfig;
use crate::terminal::manager::TerminalManager;

#[tauri::command]
pub fn connect_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<AgentConnectResult, String> {
    agent_manager
        .connect_agent(&agent_id, &config)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn disconnect_agent(
    agent_id: String,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<(), String> {
    agent_manager
        .disconnect_agent(&agent_id)
        .map_err(|e| e.to_string())
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

#[tauri::command]
pub fn list_agent_sessions(
    agent_id: String,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<Vec<AgentSessionInfo>, String> {
    agent_manager
        .list_sessions(&agent_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_definitions(
    agent_id: String,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<Vec<AgentDefinitionInfo>, String> {
    agent_manager
        .list_definitions(&agent_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_agent_definition(
    agent_id: String,
    definition: Value,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<AgentDefinitionInfo, String> {
    agent_manager
        .save_definition(&agent_id, definition)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_agent_definition(
    agent_id: String,
    definition_id: String,
    agent_manager: State<'_, Arc<AgentConnectionManager>>,
) -> Result<(), String> {
    agent_manager
        .delete_definition(&agent_id, &definition_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn setup_remote_agent(
    agent_id: String,
    config: RemoteAgentConfig,
    setup_config: AgentSetupConfig,
    app_handle: tauri::AppHandle,
    manager: State<'_, TerminalManager>,
) -> Result<AgentSetupResult, String> {
    crate::terminal::agent_setup::setup_remote_agent(
        &agent_id,
        &config,
        &setup_config,
        &app_handle,
        &manager,
    )
    .map_err(|e| e.to_string())
}
