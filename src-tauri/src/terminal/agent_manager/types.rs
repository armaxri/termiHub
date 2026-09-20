//! Pure data types and wire-format parse helpers for the agent manager.
//!
//! These are the DTOs exchanged with the remote agent over JSON-RPC and the
//! small helpers that decode the agent's snake_case wire format. They carry no
//! behaviour of their own and are re-exported from the parent `agent_manager`
//! module so every existing `crate::terminal::agent_manager::…` path stays valid.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Capabilities returned by the agent after initialization.
///
/// The `connection_types` field contains full `ConnectionTypeInfo` objects
/// from the agent (with typeId, displayName, icon, schema, capabilities).
/// We store them as raw JSON values so the desktop acts as a pass-through
/// to the frontend without needing to parse the nested structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub connection_types: Vec<Value>,
    pub max_sessions: u32,
    #[serde(default)]
    pub available_shells: Vec<String>,
    #[serde(default)]
    pub available_serial_ports: Vec<String>,
    #[serde(default)]
    pub docker_available: bool,
    #[serde(default)]
    pub available_docker_images: Vec<String>,
    /// Whether the remote system supports `/proc`-based monitoring.
    #[serde(default)]
    pub monitoring_supported: bool,
    /// Agent binary version string, e.g. "1.4.2".
    #[serde(default)]
    pub agent_version: String,
}

/// Result of connecting to an agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectResult {
    pub capabilities: AgentCapabilities,
    pub agent_version: String,
    pub protocol_version: String,
}

/// Info about a remote session on the agent.
///
/// Deserialised from the agent's snake_case wire format (see `docs/remote-protocol.md`)
/// and re-serialised to camelCase for the Tauri IPC layer that ferries it to
/// the React frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct AgentSessionInfo {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub attached: bool,
    /// ID of the saved connection definition this session was created from,
    /// when known. Lets the desktop re-link an active agent session to its
    /// source definition (e.g. to derive the persistent connectionId for reattach).
    #[serde(default)]
    pub definition_id: Option<String>,
}

/// Info about a saved connection definition on the agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionInfo {
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
    /// Source file path on the remote host, or `None` for the primary store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
}

/// Info about a folder on the agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFolderInfo {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub is_expanded: bool,
}

/// Combined connections and folders data from an agent.
#[derive(Debug, Clone, Serialize)]
pub struct AgentConnectionsData {
    pub connections: Vec<AgentDefinitionInfo>,
    pub folders: Vec<AgentFolderInfo>,
}

/// Parse an agent connection from the wire format (snake_case JSON).
pub(crate) fn parse_agent_definition(v: &Value) -> Option<AgentDefinitionInfo> {
    Some(AgentDefinitionInfo {
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str()?.to_string(),
        session_type: v["session_type"].as_str()?.to_string(),
        config: v.get("config").cloned().unwrap_or(Value::Null),
        persistent: v["persistent"].as_bool().unwrap_or(false),
        folder_id: v["folder_id"].as_str().map(|s| s.to_string()),
        terminal_options: v.get("terminal_options").and_then(|t| {
            if t.is_null() {
                None
            } else {
                Some(t.clone())
            }
        }),
        icon: v["icon"].as_str().map(|s| s.to_string()),
        source_file: v["source_file"].as_str().map(|s| s.to_string()),
    })
}

/// Parse an agent folder from the wire format (snake_case JSON).
pub(crate) fn parse_agent_folder(v: &Value) -> Option<AgentFolderInfo> {
    Some(AgentFolderInfo {
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str()?.to_string(),
        parent_id: v["parent_id"].as_str().map(|s| s.to_string()),
        is_expanded: v["is_expanded"].as_bool().unwrap_or(false),
    })
}
