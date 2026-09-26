//! Pure data types and wire-format parse helpers for the agent manager.
//!
//! These are the DTOs exchanged with the remote agent over JSON-RPC and the
//! small helpers that decode the agent's snake_case wire format. They carry no
//! behaviour of their own and are re-exported from the parent `agent_manager`
//! module so every existing `crate::terminal::agent_manager::…` path stays valid.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use termihub_core::protocol::methods::{
    ConnectionDefinition, FolderDefinition, HostSessionEntry, SessionCreateResult, SessionListEntry,
};

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
    /// Whether the agent streams tool runs (`tool.start` / `tool.cancel` with
    /// `tool.event` / `tool.done` notifications, #3353). `false` for older agents,
    /// which only offer the collect-and-return `tool.run`.
    #[serde(default)]
    pub tool_streaming: bool,
    /// Whether the agent serves an agent-hosted embedded server's access log
    /// and detailed stats (`embedded_server.activity`, #3453). `false` for older
    /// agents, whose hosted servers show "not supported by this agent version".
    #[serde(default)]
    pub embedded_server_activity: bool,
    /// Agent binary version string, e.g. "1.4.2".
    #[serde(default)]
    pub agent_version: String,
}

/// One update for a streaming tool run (#3353), routed by the agent I/O task
/// from the run's `tool.event` / `tool.done` notifications.
#[derive(Debug, Clone)]
pub enum ToolRunMessage {
    /// A batch of streamed events, in emission order.
    Events(Vec<termihub_core::tool::ToolEvent>),
    /// The run finished (always the last message).
    Done(termihub_core::protocol::methods::ToolDoneNotification),
}

/// Where the agent I/O task delivers one streaming run's updates. Dropped (the
/// receiver sees the channel close) when the agent transport breaks.
pub type ToolRunSender = tokio::sync::mpsc::UnboundedSender<ToolRunMessage>;

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

// The agent replies (`connections.list` / `.create` / `.update` and the
// `.folders.*` twins) are deserialized into the shared wire DTOs
// [`ConnectionDefinition`] / [`FolderDefinition`] (DUP-001 — one definition of
// the snake_case wire, shared with the agent that emits it) and re-serialized to
// the desktop's camelCase Tauri→frontend DTOs via these `From` conversions. This
// replaces the old hand-written `serde_json::Value` field indexing.

impl From<ConnectionDefinition> for AgentDefinitionInfo {
    fn from(d: ConnectionDefinition) -> Self {
        AgentDefinitionInfo {
            id: d.id,
            name: d.name,
            session_type: d.session_type,
            config: d.config,
            persistent: d.persistent,
            folder_id: d.folder_id,
            terminal_options: d.terminal_options,
            icon: d.icon,
            source_file: d.source_file,
        }
    }
}

impl From<FolderDefinition> for AgentFolderInfo {
    fn from(f: FolderDefinition) -> Self {
        AgentFolderInfo {
            id: f.id,
            name: f.name,
            parent_id: f.parent_id,
            is_expanded: f.is_expanded,
        }
    }
}

/// A freshly-created session reply (`connection.create`) becomes an
/// [`AgentSessionInfo`] (DUP-001). A brand-new session is never already
/// attached, so `attached` is `false`; the agent's `created_at` is bookkeeping
/// the desktop DTO does not carry.
impl From<SessionCreateResult> for AgentSessionInfo {
    fn from(r: SessionCreateResult) -> Self {
        AgentSessionInfo {
            session_id: r.session_id,
            title: r.title,
            session_type: r.session_type,
            status: r.status,
            attached: false,
            definition_id: r.definition_id,
        }
    }
}

/// A `connection.list` entry (`SessionListEntry`) becomes an
/// [`AgentSessionInfo`] (DUP-001), carrying the agent's `attached` flag; the
/// `created_at`/`last_activity` timestamps are bookkeeping the desktop DTO does
/// not carry.
impl From<SessionListEntry> for AgentSessionInfo {
    fn from(e: SessionListEntry) -> Self {
        AgentSessionInfo {
            session_id: e.session_id,
            title: e.title,
            session_type: e.session_type,
            status: e.status,
            attached: e.attached,
            definition_id: e.definition_id,
        }
    }
}

/// A session running on the agent host with who controls it (#3369) — one
/// `connection.list_host_sessions` entry, re-serialised to camelCase for the
/// frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostSessionInfo {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub created_at: String,
    pub last_activity: String,
    /// `"self"` (this desktop), `"none"` (running unattached) or `"other"`
    /// (another desktop holds it; opening it is a takeover).
    pub holder: String,
    pub definition_id: Option<String>,
}

impl From<HostSessionEntry> for AgentHostSessionInfo {
    fn from(e: HostSessionEntry) -> Self {
        AgentHostSessionInfo {
            session_id: e.session_id,
            title: e.title,
            session_type: e.session_type,
            status: e.status,
            created_at: e.created_at,
            last_activity: e.last_activity,
            holder: e.holder,
            definition_id: e.definition_id,
        }
    }
}

/// Result of listing an agent host's running sessions (#3369).
///
/// `supported == false` means the agent predates `connection.list_host_sessions`
/// (it answered "method not found"); the UI then disables the entry point with
/// a reason instead of showing an empty list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostSessionsResult {
    pub supported: bool,
    pub sessions: Vec<AgentHostSessionInfo>,
}

/// Decode a `connection.list_host_sessions` reply (#3369). An older agent's
/// JSON-RPC `METHOD_NOT_FOUND` (-32601) reply — surfaced by `send_request` as
/// [`TerminalError::AgentUnsupported`](crate::utils::errors::TerminalError::AgentUnsupported),
/// classified by code, never by message text (#3408) — maps to
/// `supported: false`; any other error is returned as-is. Malformed entries are dropped, not fatal to the whole list.
pub fn parse_host_sessions_reply(
    reply: Result<Value, crate::utils::errors::TerminalError>,
) -> Result<AgentHostSessionsResult, crate::utils::errors::TerminalError> {
    match reply {
        Ok(result) => {
            let sessions = result["sessions"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            serde_json::from_value::<HostSessionEntry>(v.clone())
                                .ok()
                                .map(AgentHostSessionInfo::from)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(AgentHostSessionsResult {
                supported: true,
                sessions,
            })
        }
        Err(crate::utils::errors::TerminalError::AgentUnsupported(_)) => {
            Ok(AgentHostSessionsResult {
                supported: false,
                sessions: Vec::new(),
            })
        }
        Err(e) => Err(e),
    }
}
