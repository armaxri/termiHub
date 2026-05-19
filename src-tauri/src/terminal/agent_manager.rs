//! Shared agent connection manager — one SSH connection per agent,
//! with multiplexed sessions over JSON-RPC.
//!
//! Each agent runs in a dedicated async tokio task that owns the russh
//! `Channel`. Multiple sessions share the connection, with output
//! notifications routed to per-session `OutputSender` channels.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tracing::{error, info, warn};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::monitoring::{MonitoringSender, SystemStats};

use crate::connection::config::AgentSettings;
use crate::terminal::backend::{OutputSender, RemoteAgentConfig, RemoteStateChangeEvent};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub attached: bool,
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
fn parse_agent_definition(v: &Value) -> Option<AgentDefinitionInfo> {
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
fn parse_agent_folder(v: &Value) -> Option<AgentFolderInfo> {
    Some(AgentFolderInfo {
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str()?.to_string(),
        parent_id: v["parent_id"].as_str().map(|s| s.to_string()),
        is_expanded: v["is_expanded"].as_bool().unwrap_or(false),
    })
}

/// Commands sent to the agent I/O task.
enum AgentIoCommand {
    /// Send JSON-RPC request and get a response via a oneshot channel.
    Request {
        method: String,
        params: Value,
        response_tx: oneshot::Sender<Result<Value, String>>,
    },
    /// Send input to a specific session (fire-and-forget).
    SessionInput { session_id: String, data: Vec<u8> },
    /// Resize a specific session (fire-and-forget).
    SessionResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Register an output sender for a session.
    RegisterSession {
        session_id: String,
        output_tx: OutputSender,
    },
    /// Unregister a session's output sender.
    UnregisterSession { session_id: String },
    /// Register a monitoring sender for a session.
    RegisterMonitoring {
        session_id: String,
        monitoring_tx: MonitoringSender,
    },
    /// Unregister a session's monitoring sender.
    UnregisterMonitoring { session_id: String },
    /// Disconnect the agent.
    Disconnect,
}

/// State for a single connected agent.
struct AgentConnection {
    command_tx: UnboundedSender<AgentIoCommand>,
    alive: Arc<AtomicBool>,
    capabilities: AgentCapabilities,
    /// Stored for future version-gated feature checks.
    #[allow(dead_code)]
    agent_version: String,
    /// Stored for future protocol negotiation.
    #[allow(dead_code)]
    protocol_version: String,
}

/// Abstract interface over an agent connection manager.
///
/// Implemented by [`AgentConnectionManager`] in production and by mock
/// structs in tests. Consumers (e.g. [`RemoteProxy`]) depend on this trait
/// so they can be tested without real SSH connections.
///
/// [`RemoteProxy`]: crate::session::remote_proxy::RemoteProxy
// Methods called through Arc<AgentConnectionManager> in commands; will be
// routed through the trait once Tauri commands use Arc<dyn AgentRpcClient>.
#[allow(dead_code)]
pub trait AgentRpcClient: Send + Sync + 'static {
    /// Connect to a remote agent via SSH.
    fn connect_agent(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError>;

    /// Disconnect an agent.
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError>;

    /// Check if an agent is connected.
    fn is_connected(&self, agent_id: &str) -> bool;

    /// Get the capabilities of a connected agent.
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities>;

    /// Gracefully shut down a remote agent and disconnect.
    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError>;

    /// Send a JSON-RPC request to an agent and wait for the response.
    fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError>;

    /// Create a session on the agent.
    fn create_session(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError>;

    /// Attach to a session on the agent.
    fn attach_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError>;

    /// Close a session on the agent.
    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError>;

    /// List sessions on the agent.
    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError>;

    /// List saved connections and folders on the agent.
    fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError>;

    /// List saved session definitions on the agent (backward compat).
    fn list_definitions(&self, agent_id: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError>;

    /// Save a session definition on the agent.
    fn save_definition(
        &self,
        agent_id: &str,
        definition: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError>;

    /// Update a saved connection definition on the agent.
    fn update_definition(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError>;

    /// Delete a session definition on the agent.
    fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError>;

    /// Create a folder on the agent.
    fn create_folder(
        &self,
        agent_id: &str,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError>;

    /// Update a folder on the agent.
    fn update_folder(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentFolderInfo, TerminalError>;

    /// Delete a folder on the agent.
    fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError>;

    /// Register an output sender for a session.
    fn register_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        output_tx: OutputSender,
    ) -> Result<(), TerminalError>;

    /// Unregister a session's output sender.
    fn unregister_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError>;

    /// Register a monitoring channel for a remote session.
    fn register_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError>;

    /// Unregister the monitoring channel for a remote session.
    fn unregister_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError>;

    /// Send input to a session (fire-and-forget).
    fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError>;

    /// Resize a session (fire-and-forget).
    fn resize_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError>;

    /// Push updated AgentSettings to a running agent session (live reload).
    ///
    /// Sends `agent.settingsUpdate` over JSON-RPC and returns on success.
    fn apply_agent_settings(
        &self,
        agent_id: &str,
        settings: &AgentSettings,
    ) -> Result<(), TerminalError>;
}

/// Manages connections to remote agents.
///
/// Each agent is identified by its `agent_id` string. Multiple sessions
/// can be multiplexed over a single SSH connection.
pub struct AgentConnectionManager {
    agents: Mutex<HashMap<String, AgentConnection>>,
    app_handle: AppHandle,
}

impl AgentConnectionManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            agents: Mutex::new(HashMap::new()),
            app_handle,
        }
    }

    /// Connect to a remote agent via SSH.
    ///
    /// Performs SSH authentication, starts the agent, and runs `initialize`
    /// to get capabilities. Spawns a dedicated async tokio task for the I/O loop.
    pub fn connect_agent(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        let mut agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        // Evict a dead entry left behind when the I/O task exits without
        // removing itself (e.g. reconnection failed after a dropped connection).
        if let Some(existing) = agents.get(agent_id) {
            if existing.alive.load(Ordering::SeqCst) {
                return Err(TerminalError::RemoteError(format!(
                    "Agent {} is already connected",
                    agent_id
                )));
            }
            agents.remove(agent_id);
        }

        // Emit connecting state
        emit_agent_state(&self.app_handle, agent_id, "connecting");

        let default_settings;
        let settings_ref = match agent_settings {
            Some(s) => s,
            None => {
                default_settings = AgentSettings::default();
                &default_settings
            }
        };

        let ssh_config = config.to_ssh_config();
        let app_handle_clone = self.app_handle.clone();
        let agent_id_str = agent_id.to_string();
        let config_clone = config.clone();
        let settings_clone = settings_ref.clone();

        // Run the async connect+handshake on the current tokio runtime.
        let handle = tokio::runtime::Handle::current();
        let (capabilities, agent_version, protocol_version, command_tx, alive) =
            handle.block_on(async {
                // 1. SSH connect and authenticate
                let session = connect_and_authenticate(&ssh_config).inspect_err(|_| {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                })?;

                // 2. Open exec channel and launch agent
                let mut channel = session.channel_open_session().await.map_err(|e| {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                    TerminalError::RemoteError(format!("Channel open failed: {}", e))
                })?;
                let exec_cmd = config_clone.agent_exec_command();
                channel.exec(false, exec_cmd.as_str()).await.map_err(|e| {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                    TerminalError::RemoteError(format!("Exec failed: {}", e))
                })?;

                // 3. Blocking handshake: initialize
                let enabled_external_files: Vec<&str> = config_clone
                    .external_connection_files
                    .iter()
                    .filter(|f| f.enabled)
                    .map(|f| f.path.as_str())
                    .collect();

                let request_id: u64 = 1;
                let init_params = build_initialize_params(&settings_clone, &enabled_external_files);
                let req_line =
                    serialize_request(request_id, "initialize", init_params).map_err(|e| {
                        emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                        TerminalError::RemoteError(format!("Serialize initialize failed: {}", e))
                    })?;

                channel.data(req_line.as_bytes()).await.map_err(|e| {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                    TerminalError::RemoteError(format!("Write initialize failed: {}", e))
                })?;

                // Read the initialize response line-by-line from the channel
                let resp_line =
                    read_channel_line(&mut channel, &agent_id_str, &app_handle_clone).await?;

                let msg = jsonrpc::parse_message(&resp_line).map_err(|e| {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                    TerminalError::RemoteError(format!("Parse initialize response: {}", e))
                })?;

                let (capabilities, agent_version, protocol_version) = match msg {
                    jsonrpc::JsonRpcMessage::Response { result, .. } => {
                        let caps = result.get("capabilities").ok_or_else(|| {
                            emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                            TerminalError::RemoteError(
                                "Missing capabilities in initialize response".into(),
                            )
                        })?;
                        let mut capabilities = serde_json::from_value::<AgentCapabilities>(
                            caps.clone(),
                        )
                        .map_err(|e| {
                            emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                            TerminalError::RemoteError(format!("Parse capabilities: {}", e))
                        })?;
                        let agent_version = result
                            .get("agent_version")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let protocol_version = result
                            .get("protocol_version")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        // Copy agent_version into capabilities so the UI can read it.
                        capabilities.agent_version = agent_version.clone();
                        (capabilities, agent_version, protocol_version)
                    }
                    jsonrpc::JsonRpcMessage::Error { message, .. } => {
                        emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                        return Err(TerminalError::RemoteError(format!(
                            "Initialize rejected: {}",
                            message
                        )));
                    }
                    _ => {
                        emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                        return Err(TerminalError::RemoteError(
                            "Unexpected response to initialize".into(),
                        ));
                    }
                };

                // 4. Spawn the async I/O task
                let alive = Arc::new(AtomicBool::new(true));
                let (command_tx, command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();

                let alive_clone = alive.clone();
                let app_handle_task = app_handle_clone.clone();
                let agent_id_task = agent_id_str.clone();
                let config_task = config_clone.clone();
                let settings_task = settings_clone.clone();

                tokio::spawn(async move {
                    agent_io_task(
                        session,
                        channel,
                        command_rx,
                        alive_clone,
                        app_handle_task,
                        agent_id_task,
                        config_task,
                        settings_task,
                        request_id,
                    )
                    .await;
                });

                Ok::<_, TerminalError>((
                    capabilities,
                    agent_version,
                    protocol_version,
                    command_tx,
                    alive,
                ))
            })?;

        emit_agent_state(&self.app_handle, agent_id, "connected");

        let result = AgentConnectResult {
            capabilities: capabilities.clone(),
            agent_version: agent_version.clone(),
            protocol_version: protocol_version.clone(),
        };

        agents.insert(
            agent_id.to_string(),
            AgentConnection {
                command_tx,
                alive,
                capabilities,
                agent_version,
                protocol_version,
            },
        );

        Ok(result)
    }

    /// Disconnect an agent, closing all sessions.
    pub fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        let mut agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        if let Some(conn) = agents.remove(agent_id) {
            let _ = conn.command_tx.send(AgentIoCommand::Disconnect);
            conn.alive.store(false, Ordering::SeqCst);
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
            Ok(())
        } else {
            Err(TerminalError::RemoteError(format!(
                "Agent {} not connected",
                agent_id
            )))
        }
    }

    /// Check if an agent is connected.
    pub fn is_connected(&self, agent_id: &str) -> bool {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        agents
            .get(agent_id)
            .map(|c| c.alive.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// Get the capabilities of a connected agent.
    pub fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        agents.get(agent_id).map(|c| c.capabilities.clone())
    }

    /// Send `agent.shutdown` to a connected agent and disconnect it.
    ///
    /// Returns the number of sessions that were detached (left running)
    /// on the remote side, or an error if the agent is not connected.
    pub fn shutdown_agent(
        &self,
        agent_id: &str,
        reason: Option<&str>,
    ) -> Result<u32, TerminalError> {
        let mut params = serde_json::json!({});
        if let Some(r) = reason {
            params["reason"] = serde_json::Value::String(r.to_string());
        }

        let result = self.send_request(agent_id, "agent.shutdown", params)?;
        let detached = result
            .get("detached_sessions")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        // Now disconnect the local side
        let _ = self.disconnect_agent(agent_id);

        Ok(detached)
    }

    /// Send a JSON-RPC request to an agent and wait for the response.
    pub fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        let (resp_tx, resp_rx) = oneshot::channel();
        conn.command_tx
            .send(AgentIoCommand::Request {
                method: method.to_string(),
                params,
                response_tx: resp_tx,
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O task gone".to_string()))?;

        // Drop the lock before waiting for response
        drop(agents);

        resp_rx
            .blocking_recv()
            .map_err(|_| TerminalError::RemoteError("Agent request timed out".to_string()))?
            .map_err(TerminalError::RemoteError)
    }

    /// Create a session on the agent.
    pub fn create_session(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        let mut params = serde_json::json!({
            "type": session_type,
            "config": config,
        });
        if let Some(t) = title {
            params["title"] = Value::String(t.to_string());
        }

        let result = self.send_request(agent_id, "connection.create", params)?;
        Ok(AgentSessionInfo {
            session_id: result["session_id"].as_str().unwrap_or("").to_string(),
            title: result["title"].as_str().unwrap_or("").to_string(),
            session_type: result["type"].as_str().unwrap_or(session_type).to_string(),
            status: result["status"].as_str().unwrap_or("running").to_string(),
            attached: false,
        })
    }

    /// Attach to a session on the agent.
    pub fn attach_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "connection.attach",
            serde_json::json!({ "session_id": remote_session_id }),
        )?;
        Ok(())
    }

    /// Detach from a session on the agent.
    #[allow(dead_code)]
    pub fn detach_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "connection.detach",
            serde_json::json!({ "session_id": remote_session_id }),
        )?;
        Ok(())
    }

    /// Close a session on the agent.
    #[allow(dead_code)]
    pub fn close_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "connection.close",
            serde_json::json!({ "session_id": remote_session_id }),
        )?;
        Ok(())
    }

    /// List sessions on the agent.
    pub fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        let result = self.send_request(agent_id, "connection.list", serde_json::json!({}))?;
        let sessions = result["sessions"].as_array().cloned().unwrap_or_default();
        Ok(sessions
            .into_iter()
            .filter_map(|s| serde_json::from_value(s).ok())
            .collect())
    }

    /// List saved connections and folders on the agent.
    pub fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        let result = self.send_request(agent_id, "connections.list", serde_json::json!({}))?;
        let connections = result["connections"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(parse_agent_definition)
            .collect();
        let folders = result["folders"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(parse_agent_folder)
            .collect();
        Ok(AgentConnectionsData {
            connections,
            folders,
        })
    }

    /// List saved session definitions on the agent (backward compat).
    pub fn list_definitions(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        Ok(self.list_connections_and_folders(agent_id)?.connections)
    }

    /// Save a session definition on the agent.
    pub fn save_definition(
        &self,
        agent_id: &str,
        definition: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        let result = self.send_request(agent_id, "connections.create", definition)?;
        parse_agent_definition(&result)
            .ok_or_else(|| TerminalError::RemoteError("Failed to parse definition result".into()))
    }

    /// Update a saved connection definition on the agent.
    pub fn update_definition(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        let result = self.send_request(agent_id, "connections.update", params)?;
        parse_agent_definition(&result)
            .ok_or_else(|| TerminalError::RemoteError("Failed to parse definition result".into()))
    }

    /// Delete a session definition on the agent.
    pub fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "connections.delete",
            serde_json::json!({ "id": def_id }),
        )?;
        Ok(())
    }

    /// Create a folder on the agent.
    pub fn create_folder(
        &self,
        agent_id: &str,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        let result = self.send_request(
            agent_id,
            "connections.folders.create",
            serde_json::json!({ "name": name, "parent_id": parent_id }),
        )?;
        parse_agent_folder(&result)
            .ok_or_else(|| TerminalError::RemoteError("Failed to parse folder result".into()))
    }

    /// Update a folder on the agent.
    pub fn update_folder(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentFolderInfo, TerminalError> {
        let result = self.send_request(agent_id, "connections.folders.update", params)?;
        parse_agent_folder(&result)
            .ok_or_else(|| TerminalError::RemoteError("Failed to parse folder result".into()))
    }

    /// Delete a folder on the agent.
    pub fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "connections.folders.delete",
            serde_json::json!({ "id": folder_id }),
        )?;
        Ok(())
    }

    /// Register an output sender for a session on the agent's I/O task.
    pub fn register_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        output_tx: OutputSender,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::RegisterSession {
                session_id: remote_session_id.to_string(),
                output_tx,
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O task gone".to_string()))
    }

    /// Unregister a session's output sender from the agent's I/O task.
    pub fn unregister_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::UnregisterSession {
                session_id: remote_session_id.to_string(),
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O task gone".to_string()))
    }

    /// Register a monitoring channel for a remote session so that
    /// `connection.monitoring.data` notifications are forwarded to it.
    pub fn register_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::RegisterMonitoring {
                session_id: remote_session_id.to_string(),
                monitoring_tx,
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O task gone".to_string()))
    }

    /// Unregister the monitoring channel for a remote session.
    pub fn unregister_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::UnregisterMonitoring {
                session_id: remote_session_id.to_string(),
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O task gone".to_string()))
    }

    /// Send input to a session on the agent (fire-and-forget).
    pub fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::WriteFailed(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::SessionInput {
                session_id: remote_session_id.to_string(),
                data: data.to_vec(),
            })
            .map_err(|_| TerminalError::WriteFailed("Agent I/O task gone".to_string()))
    }

    /// Resize a session on the agent (fire-and-forget).
    pub fn resize_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::ResizeFailed(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::ResizeFailed(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::SessionResize {
                session_id: remote_session_id.to_string(),
                cols,
                rows,
            })
            .map_err(|_| TerminalError::ResizeFailed("Agent I/O task gone".to_string()))
    }
}

// ── AgentRpcClient impl ────────────────────────────────────────────

impl AgentRpcClient for AgentConnectionManager {
    fn connect_agent(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        AgentConnectionManager::connect_agent(self, agent_id, config, agent_settings)
    }

    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::disconnect_agent(self, agent_id)
    }

    fn is_connected(&self, agent_id: &str) -> bool {
        AgentConnectionManager::is_connected(self, agent_id)
    }

    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        AgentConnectionManager::get_capabilities(self, agent_id)
    }

    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError> {
        AgentConnectionManager::shutdown_agent(self, agent_id, reason)
    }

    fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError> {
        AgentConnectionManager::send_request(self, agent_id, method, params)
    }

    fn create_session(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        AgentConnectionManager::create_session(self, agent_id, session_type, config, title)
    }

    fn attach_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::attach_session(self, agent_id, remote_session_id)
    }

    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::close_session(self, agent_id, remote_session_id)
    }

    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        AgentConnectionManager::list_sessions(self, agent_id)
    }

    fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        AgentConnectionManager::list_connections_and_folders(self, agent_id)
    }

    fn list_definitions(&self, agent_id: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        AgentConnectionManager::list_definitions(self, agent_id)
    }

    fn save_definition(
        &self,
        agent_id: &str,
        definition: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        AgentConnectionManager::save_definition(self, agent_id, definition)
    }

    fn update_definition(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        AgentConnectionManager::update_definition(self, agent_id, params)
    }

    fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::delete_definition(self, agent_id, def_id)
    }

    fn create_folder(
        &self,
        agent_id: &str,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        AgentConnectionManager::create_folder(self, agent_id, name, parent_id)
    }

    fn update_folder(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentFolderInfo, TerminalError> {
        AgentConnectionManager::update_folder(self, agent_id, params)
    }

    fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::delete_folder(self, agent_id, folder_id)
    }

    fn register_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        output_tx: OutputSender,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::register_session_output(
            self,
            agent_id,
            remote_session_id,
            output_tx,
        )
    }

    fn unregister_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::unregister_session_output(self, agent_id, remote_session_id)
    }

    fn register_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::register_monitoring_output(
            self,
            agent_id,
            remote_session_id,
            monitoring_tx,
        )
    }

    fn unregister_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::unregister_monitoring_output(self, agent_id, remote_session_id)
    }

    fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::send_session_input(self, agent_id, remote_session_id, data)
    }

    fn resize_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::resize_session(self, agent_id, remote_session_id, cols, rows)
    }

    fn apply_agent_settings(
        &self,
        agent_id: &str,
        settings: &AgentSettings,
    ) -> Result<(), TerminalError> {
        let params = serde_json::to_value(settings)
            .map_err(|e| TerminalError::RemoteError(format!("Serialize settings: {}", e)))?;
        self.send_request(agent_id, "agent.settingsUpdate", params)?;
        Ok(())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Build the `initialize` JSON-RPC params including agent runtime settings and external files.
fn build_initialize_params(settings: &AgentSettings, external_files: &[&str]) -> Value {
    serde_json::json!({
        "protocolVersion": "0.2.0",
        "client": "termihub-desktop",
        "clientVersion": "0.1.0",
        "agentSettings": settings,
        "externalConnectionFiles": external_files
    })
}

/// Serialize a JSON-RPC request to a newline-terminated string for channel writes.
fn serialize_request(id: u64, method: &str, params: Value) -> Result<String, String> {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": id,
    });
    let mut line = serde_json::to_string(&req).map_err(|e| format!("Serialize JSON-RPC: {}", e))?;
    line.push('\n');
    Ok(line)
}

/// Read a single newline-terminated JSON-RPC line from a russh channel during
/// the handshake phase. Accumulates `ChannelMsg::Data` chunks until a `\n`
/// is encountered, then returns the trimmed line.
async fn read_channel_line(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    app_handle: &AppHandle,
) -> Result<String, TerminalError> {
    let mut buf = String::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                buf.push_str(&String::from_utf8_lossy(data));
                if let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim().to_string();
                    return Ok(line);
                }
            }
            Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                // stderr — log but don't fail
                warn!(
                    "Agent {}: stderr during handshake: {}",
                    agent_id,
                    String::from_utf8_lossy(data)
                );
            }
            Some(ChannelMsg::Eof) | None => {
                emit_agent_state(app_handle, agent_id, "disconnected");
                return Err(TerminalError::RemoteError(
                    "Channel closed before initialize response".into(),
                ));
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                emit_agent_state(app_handle, agent_id, "disconnected");
                return Err(TerminalError::RemoteError(format!(
                    "Agent process exited with status {} before initialize response",
                    exit_status
                )));
            }
            _ => {}
        }
    }
}

/// Emit an agent state change event with an optional error description.
fn emit_agent_state_with_error(
    app_handle: &AppHandle,
    agent_id: &str,
    state: &str,
    error: Option<&str>,
) {
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
fn emit_agent_state(app_handle: &AppHandle, agent_id: &str, state: &str) {
    emit_agent_state_with_error(app_handle, agent_id, state, None);
}

// ── Async I/O task ───────────────────────────────────────────────────

/// Main async I/O task for an agent connection.
///
/// Owns the russh `SshSession` and `Channel` exclusively. Concurrently polls
/// incoming SSH data and outgoing commands using `tokio::select!`. Routes
/// JSON-RPC responses to waiting callers and notifications to registered
/// session output channels.
#[allow(clippy::too_many_arguments)]
async fn agent_io_task(
    session: SshSession,
    mut channel: russh::Channel<russh::client::Msg>,
    mut command_rx: UnboundedReceiver<AgentIoCommand>,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
    agent_id: String,
    config: RemoteAgentConfig,
    agent_settings: AgentSettings,
    mut request_id: u64,
) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut line_buf = String::new();
    let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringSender> = HashMap::new();
    let mut pending_responses: HashMap<u64, oneshot::Sender<Result<Value, String>>> =
        HashMap::new();
    let mut connection_error: Option<String> = None;

    // Keep the current session handle alive. On reconnect this is replaced so
    // the old session is dropped and the new one is held for the next loop iteration.
    let mut _current_session: Option<SshSession> = Some(session);

    'outer: loop {
        // connection_broken is true when we need to reconnect.
        let connection_broken = loop {
            tokio::select! {
                biased;

                // 1. Process incoming commands
                cmd = command_rx.recv() => {
                    let cmd = match cmd {
                        Some(c) => c,
                        None => {
                            // Sender dropped — clean shutdown
                            alive.store(false, Ordering::SeqCst);
                            return;
                        }
                    };
                    match cmd {
                        AgentIoCommand::Request { method, params, response_tx } => {
                            request_id += 1;
                            match serialize_request(request_id, &method, params) {
                                Ok(line) => {
                                    if let Err(e) = channel.data(line.as_bytes()).await {
                                        let _ = response_tx
                                            .send(Err(format!("Write failed: {}", e)));
                                    } else {
                                        pending_responses.insert(request_id, response_tx);
                                    }
                                }
                                Err(e) => {
                                    let _ = response_tx.send(Err(e));
                                }
                            }
                        }
                        AgentIoCommand::SessionInput { session_id, data } => {
                            request_id += 1;
                            let encoded = b64.encode(&data);
                            if let Ok(line) = serialize_request(
                                request_id,
                                "connection.write",
                                serde_json::json!({
                                    "session_id": session_id,
                                    "data": encoded,
                                }),
                            ) {
                                let _ = channel.data(line.as_bytes()).await;
                            }
                        }
                        AgentIoCommand::SessionResize { session_id, cols, rows } => {
                            request_id += 1;
                            if let Ok(line) = serialize_request(
                                request_id,
                                "connection.resize",
                                serde_json::json!({
                                    "session_id": session_id,
                                    "cols": cols,
                                    "rows": rows,
                                }),
                            ) {
                                let _ = channel.data(line.as_bytes()).await;
                            }
                        }
                        AgentIoCommand::RegisterSession { session_id, output_tx } => {
                            session_outputs.insert(session_id, output_tx);
                        }
                        AgentIoCommand::UnregisterSession { session_id } => {
                            session_outputs.remove(&session_id);
                        }
                        AgentIoCommand::RegisterMonitoring { session_id, monitoring_tx } => {
                            monitoring_outputs.insert(session_id, monitoring_tx);
                        }
                        AgentIoCommand::UnregisterMonitoring { session_id } => {
                            monitoring_outputs.remove(&session_id);
                        }
                        AgentIoCommand::Disconnect => {
                            alive.store(false, Ordering::SeqCst);
                            return;
                        }
                    }
                }

                // 2. Poll incoming SSH channel data
                msg = channel.wait() => {
                    match msg {
                        None => {
                            // Channel closed cleanly
                            break true;
                        }
                        Some(ChannelMsg::Data { ref data }) => {
                            line_buf.push_str(&String::from_utf8_lossy(data));

                            // Process all complete newline-delimited JSON lines
                            while let Some(pos) = line_buf.find('\n') {
                                let line = line_buf[..pos].trim().to_string();
                                line_buf = line_buf[pos + 1..].to_string();

                                if line.is_empty() {
                                    continue;
                                }

                                match jsonrpc::parse_message(&line) {
                                    Ok(jsonrpc::JsonRpcMessage::Response { id, result }) => {
                                        if let Some(tx) = pending_responses.remove(&id) {
                                            let _ = tx.send(Ok(result));
                                        }
                                    }
                                    Ok(jsonrpc::JsonRpcMessage::Error { id, message, .. }) => {
                                        if let Some(tx) = pending_responses.remove(&id) {
                                            let _ = tx.send(Err(message));
                                        }
                                    }
                                    Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) => {
                                        handle_notification(
                                            &method,
                                            &params,
                                            &session_outputs,
                                            &monitoring_outputs,
                                            &b64,
                                        );
                                    }
                                    Err(e) => {
                                        warn!("Agent {}: failed to parse message: {}", agent_id, e);
                                    }
                                }
                            }
                        }
                        Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                            // stderr from the remote agent process (SSH_EXTENDED_DATA_STDERR = 1)
                            warn!(
                                "Agent {}: stderr: {}",
                                agent_id,
                                String::from_utf8_lossy(data)
                            );
                        }
                        Some(ChannelMsg::Eof) => {
                            // Remote side sent EOF — connection is gone
                            break true;
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            if exit_status != 0 {
                                let msg = format!("Agent process exited with status {}", exit_status);
                                error!("Agent {}: {}", agent_id, msg);
                                connection_error = Some(msg);
                            }
                            break true;
                        }
                        _ => {}
                    }
                }
            }
        };

        if !connection_broken {
            break;
        }

        // Connection lost — try to reconnect
        emit_agent_state_with_error(
            &app_handle,
            &agent_id,
            "reconnecting",
            connection_error.as_deref(),
        );
        info!("Agent {}: connection lost, attempting reconnect", agent_id);

        match reconnect_agent(&config, &agent_settings, &mut request_id, &alive).await {
            Ok((new_session, new_channel)) => {
                // Replace the current session handle with the new one.
                // This drops the old (broken) session and keeps the new one alive
                // for the next iteration of the outer loop.
                _current_session = Some(new_session);
                channel = new_channel;
                line_buf.clear();
                connection_error = None;
                emit_agent_state(&app_handle, &agent_id, "connected");
                info!("Agent {}: reconnected successfully", agent_id);
                // Notify all pending requests that the connection was lost
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err("Connection lost during request".to_string()));
                }
                continue 'outer;
            }
            Err(e) => {
                error!("Agent {}: reconnection failed: {}", agent_id, e);
                emit_agent_state_with_error(&app_handle, &agent_id, "disconnected", Some(&e));
                alive.store(false, Ordering::SeqCst);
                // Notify all pending requests
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err("Agent disconnected".to_string()));
                }
                return;
            }
        }
    }
}

/// Handle a notification from the agent.
///
/// Routes `connection.output` to session output channels and
/// `connection.monitoring.data` to monitoring channels.
fn handle_notification(
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    monitoring_outputs: &HashMap<String, MonitoringSender>,
    b64: &base64::engine::GeneralPurpose,
) {
    match method {
        "connection.output" => {
            let session_id = match params["session_id"].as_str() {
                Some(s) => s,
                None => return,
            };
            let data_b64 = match params["data"].as_str() {
                Some(s) => s,
                None => return,
            };
            let data = match b64.decode(data_b64) {
                Ok(d) => d,
                Err(_) => return,
            };
            if let Some(output_tx) = session_outputs.get(session_id) {
                // Use try_send to avoid blocking the async I/O task.
                let _ = output_tx.try_send(data);
            }
        }
        "connection.monitoring.data" => {
            let host = match params["host"].as_str() {
                Some(s) => s,
                None => return,
            };
            let stats: SystemStats = match serde_json::from_value(params.clone()) {
                Ok(s) => s,
                Err(_) => return,
            };
            if let Some(monitoring_tx) = monitoring_outputs.get(host) {
                let _ = monitoring_tx.try_send(stats);
            }
        }
        _ => {}
    }
}

/// Attempt to reconnect to an agent with exponential backoff.
///
/// Respects the `alive` flag — if it becomes `false` during the inter-attempt
/// delay the function returns immediately so the caller can exit cleanly.
async fn reconnect_agent(
    config: &RemoteAgentConfig,
    agent_settings: &AgentSettings,
    request_id: &mut u64,
    alive: &Arc<AtomicBool>,
) -> Result<(SshSession, russh::Channel<russh::client::Msg>), String> {
    const MAX_RETRIES: u32 = 10;
    const MAX_BACKOFF_SECS: u64 = 30;

    for attempt in 0..MAX_RETRIES {
        let backoff_secs = std::cmp::min(2u64.pow(attempt), MAX_BACKOFF_SECS);

        // Sleep in small increments so we can respect the alive flag promptly
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(backoff_secs);
        loop {
            if !alive.load(Ordering::SeqCst) {
                return Err("Reconnect stopped by user".to_string());
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline - now;
            let sleep_ms = remaining.as_millis().min(100).try_into().unwrap_or(100u64);
            tokio::time::sleep(tokio::time::Duration::from_millis(sleep_ms)).await;
        }

        if !alive.load(Ordering::SeqCst) {
            return Err("Reconnect stopped by user".to_string());
        }

        let ssh_config = config.to_ssh_config();

        // 1. Connect
        let session = match connect_and_authenticate(&ssh_config) {
            Ok(s) => s,
            Err(e) => {
                warn!("Reconnect attempt {} failed (SSH): {}", attempt + 1, e);
                continue;
            }
        };

        // 2. Open channel and start agent
        let mut channel = match session.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                warn!("Reconnect attempt {} failed (channel): {}", attempt + 1, e);
                continue;
            }
        };
        let exec_cmd = config.agent_exec_command();
        if let Err(e) = channel.exec(false, exec_cmd.as_str()).await {
            warn!("Reconnect attempt {} failed (exec): {}", attempt + 1, e);
            continue;
        }

        // 3. Initialize
        *request_id += 1;
        let enabled_files: Vec<&str> = config
            .external_connection_files
            .iter()
            .filter(|f| f.enabled)
            .map(|f| f.path.as_str())
            .collect();
        let init_params = build_initialize_params(agent_settings, &enabled_files);
        let req_line = match serialize_request(*request_id, "initialize", init_params) {
            Ok(l) => l,
            Err(e) => {
                warn!(
                    "Reconnect attempt {} failed (serialize init): {}",
                    attempt + 1,
                    e
                );
                continue;
            }
        };

        if let Err(e) = channel.data(req_line.as_bytes()).await {
            warn!(
                "Reconnect attempt {} failed (write init): {}",
                attempt + 1,
                e
            );
            continue;
        }

        // 4. Read initialize response
        let mut line_buf = String::new();
        let mut success = false;
        let resp_line = loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { ref data }) => {
                    line_buf.push_str(&String::from_utf8_lossy(data));
                    if let Some(pos) = line_buf.find('\n') {
                        let line = line_buf[..pos].trim().to_string();
                        break Some(line);
                    }
                }
                Some(ChannelMsg::Eof) | None => {
                    break None;
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    warn!(
                        "Reconnect attempt {} failed (agent exited {})",
                        attempt + 1,
                        exit_status
                    );
                    break None;
                }
                _ => {}
            }
        };

        let resp_line = match resp_line {
            Some(l) => l,
            None => {
                warn!(
                    "Reconnect attempt {} failed (channel closed during init read)",
                    attempt + 1
                );
                continue;
            }
        };

        match jsonrpc::parse_message(&resp_line) {
            Ok(jsonrpc::JsonRpcMessage::Response { .. }) => {
                success = true;
            }
            Ok(jsonrpc::JsonRpcMessage::Error { message, .. }) => {
                warn!(
                    "Reconnect attempt {} failed (init rejected): {}",
                    attempt + 1,
                    message
                );
            }
            _ => {
                warn!(
                    "Reconnect attempt {} failed (unexpected init response)",
                    attempt + 1
                );
            }
        }

        if success {
            return Ok((session, channel));
        }
    }

    Err(format!(
        "Failed to reconnect after {} attempts",
        MAX_RETRIES
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Regression test for #412: the agent sends `connection_types` as an array
    /// of full `ConnectionTypeInfo` objects, not plain strings. The desktop must
    /// accept this format without errors.
    #[test]
    fn parse_capabilities_with_connection_type_info_objects() {
        let caps_json = json!({
            "connectionTypes": [
                {
                    "typeId": "local",
                    "displayName": "Local Shell",
                    "icon": "terminal",
                    "schema": { "groups": [] },
                    "capabilities": {
                        "monitoring": false,
                        "fileBrowser": false,
                        "resize": true,
                        "persistent": false
                    }
                },
                {
                    "typeId": "ssh",
                    "displayName": "SSH",
                    "icon": "ssh",
                    "schema": { "groups": [] },
                    "capabilities": {
                        "monitoring": true,
                        "fileBrowser": true,
                        "resize": true,
                        "persistent": true
                    }
                }
            ],
            "maxSessions": 20,
            "availableShells": ["/bin/bash", "/bin/zsh"],
            "availableSerialPorts": ["/dev/ttyUSB0"],
            "dockerAvailable": true,
            "availableDockerImages": ["ubuntu:22.04"]
        });

        let caps: AgentCapabilities = serde_json::from_value(caps_json).unwrap();
        assert_eq!(caps.connection_types.len(), 2);
        assert_eq!(caps.connection_types[0]["typeId"], "local");
        assert_eq!(caps.connection_types[1]["typeId"], "ssh");
        assert_eq!(caps.max_sessions, 20);
        assert_eq!(caps.available_shells, vec!["/bin/bash", "/bin/zsh"]);
        assert_eq!(caps.available_serial_ports, vec!["/dev/ttyUSB0"]);
        assert!(caps.docker_available);
        assert_eq!(caps.available_docker_images, vec!["ubuntu:22.04"]);
    }

    /// Verify that optional fields default gracefully when absent,
    /// ensuring backward compatibility with older agents.
    #[test]
    fn parse_capabilities_with_minimal_fields() {
        let caps_json = json!({
            "connectionTypes": [],
            "maxSessions": 10
        });

        let caps: AgentCapabilities = serde_json::from_value(caps_json).unwrap();
        assert!(caps.connection_types.is_empty());
        assert_eq!(caps.max_sessions, 10);
        assert!(caps.available_shells.is_empty());
        assert!(caps.available_serial_ports.is_empty());
        assert!(!caps.docker_available);
        assert!(caps.available_docker_images.is_empty());
    }

    /// Verify that capabilities round-trip through serialization,
    /// ensuring the desktop can forward them to the frontend unchanged.
    #[test]
    fn capabilities_round_trip_serialization() {
        let caps = AgentCapabilities {
            connection_types: vec![json!({
                "typeId": "serial",
                "displayName": "Serial",
                "icon": "serial",
                "schema": { "groups": [] },
                "capabilities": {
                    "monitoring": false,
                    "fileBrowser": false,
                    "resize": false,
                    "persistent": false
                }
            })],
            max_sessions: 5,
            monitoring_supported: false,
            agent_version: String::new(),
            available_shells: vec!["/bin/sh".to_string()],
            available_serial_ports: vec!["/dev/ttyS0".to_string()],
            docker_available: false,
            available_docker_images: vec![],
        };

        let json_val = serde_json::to_value(&caps).unwrap();
        let roundtripped: AgentCapabilities = serde_json::from_value(json_val).unwrap();
        assert_eq!(roundtripped.connection_types.len(), 1);
        assert_eq!(roundtripped.connection_types[0]["typeId"], "serial");
        assert_eq!(roundtripped.max_sessions, 5);
        assert_eq!(roundtripped.available_shells, vec!["/bin/sh"]);
    }

    /// Regression: parse_agent_definition reads snake_case fields from agent wire format.
    #[test]
    fn parse_definition_from_snake_case_wire_format() {
        let wire = json!({
            "id": "conn-abc",
            "name": "Build Shell",
            "session_type": "shell",
            "config": {"shell": "/bin/bash"},
            "persistent": true,
            "folder_id": "folder-1"
        });
        let def = parse_agent_definition(&wire).unwrap();
        assert_eq!(def.id, "conn-abc");
        assert_eq!(def.name, "Build Shell");
        assert_eq!(def.session_type, "shell");
        assert!(def.persistent);
        assert_eq!(def.folder_id, Some("folder-1".to_string()));
    }

    /// parse_agent_definition handles missing optional fields.
    #[test]
    fn parse_definition_minimal() {
        let wire = json!({
            "id": "conn-1",
            "name": "Test",
            "session_type": "serial"
        });
        let def = parse_agent_definition(&wire).unwrap();
        assert_eq!(def.id, "conn-1");
        assert!(!def.persistent);
        assert_eq!(def.folder_id, None);
        assert_eq!(def.config, Value::Null);
    }

    /// parse_agent_definition returns None for invalid input.
    #[test]
    fn parse_definition_returns_none_for_missing_required() {
        let wire = json!({"id": "conn-1", "name": "Test"});
        assert!(parse_agent_definition(&wire).is_none());
    }

    /// parse_agent_definition reads the source_file field for external connections.
    #[test]
    fn parse_definition_with_source_file() {
        let wire = json!({
            "id": "ext-1",
            "name": "Team Shell",
            "session_type": "local",
            "source_file": "/home/pi/team-connections.json"
        });
        let def = parse_agent_definition(&wire).unwrap();
        assert_eq!(
            def.source_file,
            Some("/home/pi/team-connections.json".to_string())
        );
    }

    /// Primary connections have no source_file.
    #[test]
    fn parse_definition_without_source_file() {
        let wire = json!({"id": "conn-1", "name": "Shell", "session_type": "local"});
        let def = parse_agent_definition(&wire).unwrap();
        assert_eq!(def.source_file, None);
    }

    /// source_file is omitted from JSON when None.
    #[test]
    fn definition_info_source_file_omitted_when_none() {
        let def = AgentDefinitionInfo {
            id: "conn-1".to_string(),
            name: "Test".to_string(),
            session_type: "shell".to_string(),
            config: json!({}),
            persistent: false,
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: None,
        };
        let v = serde_json::to_value(&def).unwrap();
        assert!(v.get("sourceFile").is_none());
    }

    /// source_file is camelCase in JSON when present.
    #[test]
    fn definition_info_source_file_camel_case() {
        let def = AgentDefinitionInfo {
            id: "ext-1".to_string(),
            name: "External".to_string(),
            session_type: "local".to_string(),
            config: json!({}),
            persistent: false,
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: Some("/home/pi/team.json".to_string()),
        };
        let v = serde_json::to_value(&def).unwrap();
        assert_eq!(v["sourceFile"], "/home/pi/team.json");
        assert!(v.get("source_file").is_none());
    }

    /// Regression: parse_agent_folder reads snake_case fields from agent wire format.
    #[test]
    fn parse_folder_from_snake_case_wire_format() {
        let wire = json!({
            "id": "folder-abc",
            "name": "Production",
            "parent_id": "folder-root",
            "is_expanded": true
        });
        let folder = parse_agent_folder(&wire).unwrap();
        assert_eq!(folder.id, "folder-abc");
        assert_eq!(folder.name, "Production");
        assert_eq!(folder.parent_id, Some("folder-root".to_string()));
        assert!(folder.is_expanded);
    }

    /// parse_agent_folder handles root-level folder (no parent).
    #[test]
    fn parse_folder_root_level() {
        let wire = json!({"id": "folder-1", "name": "Root"});
        let folder = parse_agent_folder(&wire).unwrap();
        assert_eq!(folder.parent_id, None);
        assert!(!folder.is_expanded);
    }

    /// AgentDefinitionInfo serializes to camelCase for Tauri→frontend boundary.
    #[test]
    fn definition_info_serializes_camel_case() {
        let def = AgentDefinitionInfo {
            id: "conn-1".to_string(),
            name: "Test".to_string(),
            session_type: "shell".to_string(),
            config: json!({}),
            persistent: true,
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
            icon: None,
            source_file: None,
        };
        let v = serde_json::to_value(&def).unwrap();
        assert_eq!(v["sessionType"], "shell");
        assert_eq!(v["folderId"], "folder-1");
        // Verify no snake_case keys
        assert!(v.get("session_type").is_none());
        assert!(v.get("folder_id").is_none());
    }

    /// AgentFolderInfo serializes to camelCase for Tauri→frontend boundary.
    #[test]
    fn folder_info_serializes_camel_case() {
        let folder = AgentFolderInfo {
            id: "folder-1".to_string(),
            name: "Test".to_string(),
            parent_id: Some("folder-0".to_string()),
            is_expanded: true,
        };
        let v = serde_json::to_value(&folder).unwrap();
        assert_eq!(v["parentId"], "folder-0");
        assert_eq!(v["isExpanded"], true);
        // Verify no snake_case keys
        assert!(v.get("parent_id").is_none());
        assert!(v.get("is_expanded").is_none());
    }

    /// AgentConnectionsData contains both connections and folders.
    #[test]
    fn connections_data_serialization() {
        let data = AgentConnectionsData {
            connections: vec![AgentDefinitionInfo {
                id: "conn-1".to_string(),
                name: "Shell".to_string(),
                session_type: "shell".to_string(),
                config: json!({}),
                persistent: false,
                folder_id: None,
                terminal_options: None,
                icon: None,
                source_file: None,
            }],
            folders: vec![AgentFolderInfo {
                id: "folder-1".to_string(),
                name: "Folder".to_string(),
                parent_id: None,
                is_expanded: false,
            }],
        };
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(v["connections"].as_array().unwrap().len(), 1);
        assert_eq!(v["folders"].as_array().unwrap().len(), 1);
        assert_eq!(v["connections"][0]["sessionType"], "shell");
        assert_eq!(v["folders"][0]["parentId"], Value::Null);
    }

    /// handle_notification routes `connection.monitoring.data` to the
    /// correct monitoring channel based on the `host` field.
    #[test]
    fn handle_notification_routes_monitoring_data() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let session_outputs: HashMap<String, OutputSender> = HashMap::new();
        let mut monitoring_outputs: HashMap<String, MonitoringSender> = HashMap::new();

        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        monitoring_outputs.insert("session-42".to_string(), tx);

        let params = json!({
            "host": "session-42",
            "hostname": "myhost",
            "uptimeSeconds": 1234.5,
            "loadAverage": [0.1, 0.2, 0.3],
            "cpuUsagePercent": 50.0,
            "memoryTotalKb": 8000000,
            "memoryAvailableKb": 4000000,
            "memoryUsedPercent": 50.0,
            "diskTotalKb": 100000000,
            "diskUsedKb": 50000000,
            "diskUsedPercent": 50.0,
            "osInfo": "Linux 6.1"
        });

        handle_notification(
            "connection.monitoring.data",
            &params,
            &session_outputs,
            &monitoring_outputs,
            &b64,
        );

        let stats = rx.try_recv().expect("should have received monitoring data");
        assert_eq!(stats.hostname, "myhost");
        assert!((stats.cpu_usage_percent - 50.0).abs() < f64::EPSILON);
        assert_eq!(stats.os_info, "Linux 6.1");
    }

    /// handle_notification silently ignores monitoring data for unknown hosts.
    #[test]
    fn handle_notification_ignores_unknown_monitoring_host() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let session_outputs: HashMap<String, OutputSender> = HashMap::new();
        let monitoring_outputs: HashMap<String, MonitoringSender> = HashMap::new();

        let params = json!({
            "host": "unknown-host",
            "hostname": "myhost",
            "uptimeSeconds": 0.0,
            "loadAverage": [0.0, 0.0, 0.0],
            "cpuUsagePercent": 0.0,
            "memoryTotalKb": 0,
            "memoryAvailableKb": 0,
            "memoryUsedPercent": 0.0,
            "diskTotalKb": 0,
            "diskUsedKb": 0,
            "diskUsedPercent": 0.0,
            "osInfo": ""
        });

        // Should not panic — just silently drops the data.
        handle_notification(
            "connection.monitoring.data",
            &params,
            &session_outputs,
            &monitoring_outputs,
            &b64,
        );
    }

    /// Regression test for #627: reconnect_agent must stop when `alive` is set
    /// to false by the caller (e.g. disconnect_agent). Without the alive check
    /// the reconnect loop sleeps up to 3 minutes before giving up.
    #[tokio::test]
    async fn reconnect_agent_stops_when_alive_is_false() {
        let config = RemoteAgentConfig {
            host: "unreachable.example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
            external_connection_files: vec![],
        };
        let settings = AgentSettings::default();
        let mut request_id = 0u64;
        let alive = Arc::new(AtomicBool::new(false));

        let result = reconnect_agent(&config, &settings, &mut request_id, &alive).await;

        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(
            err.contains("stopped") || err.contains("cancelled"),
            "expected stop-related error, got: {err}"
        );
    }

    /// serialize_request produces valid newline-terminated JSON-RPC.
    #[test]
    fn serialize_request_format() {
        let line = serialize_request(42, "connection.create", json!({"type": "shell"})).unwrap();
        assert!(line.ends_with('\n'));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["id"], 42);
        assert_eq!(parsed["method"], "connection.create");
        assert_eq!(parsed["jsonrpc"], "2.0");
    }
}
