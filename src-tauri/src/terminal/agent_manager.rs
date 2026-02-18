//! Shared agent connection manager — one SSH connection per agent,
//! with multiplexed sessions over JSON-RPC.
//!
//! Each agent runs in a dedicated I/O thread that owns the SSH `Session`
//! and `Channel`. Multiple sessions share the connection, with output
//! notifications routed to per-session `OutputSender` channels.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ssh2::Session;
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use crate::terminal::backend::{OutputSender, RemoteAgentConfig, RemoteStateChangeEvent};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// Capabilities returned by the agent after initialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub session_types: Vec<String>,
    pub max_sessions: u32,
    pub available_shells: Vec<String>,
    pub available_serial_ports: Vec<String>,
}

/// Result of connecting to an agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectResult {
    pub capabilities: AgentCapabilities,
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

/// Info about a saved session definition on the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinitionInfo {
    pub id: String,
    pub name: String,
    pub session_type: String,
    pub config: Value,
    pub persistent: bool,
}

/// Commands sent to the agent I/O thread.
enum AgentIoCommand {
    /// Send JSON-RPC request and get a response.
    Request {
        method: String,
        params: Value,
        response_tx: std::sync::mpsc::Sender<Result<Value, String>>,
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
    /// Disconnect the agent.
    Disconnect,
}

/// State for a single connected agent.
struct AgentConnection {
    command_tx: mpsc::Sender<AgentIoCommand>,
    alive: Arc<AtomicBool>,
    capabilities: AgentCapabilities,
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
    /// to get capabilities. Spawns a dedicated I/O thread for the connection.
    pub fn connect_agent(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
    ) -> Result<AgentConnectResult, TerminalError> {
        let mut agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        if agents.contains_key(agent_id) {
            return Err(TerminalError::RemoteError(format!(
                "Agent {} is already connected",
                agent_id
            )));
        }

        // Emit connecting state
        emit_agent_state(&self.app_handle, agent_id, "connecting");

        // 1. SSH connect and authenticate
        let ssh_config = config.to_ssh_config();
        let session = connect_and_authenticate(&ssh_config).inspect_err(|_| {
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
        })?;

        // 2. Open exec channel and launch agent
        let mut channel = session.channel_session().map_err(|e| {
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
            TerminalError::RemoteError(format!("Channel open failed: {}", e))
        })?;
        channel.exec("termihub-agent --stdio").map_err(|e| {
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
            TerminalError::RemoteError(format!("Exec failed: {}", e))
        })?;

        // 3. Blocking handshake: initialize
        let mut request_id: u64 = 0;
        request_id += 1;
        jsonrpc::write_request(
            &mut channel,
            request_id,
            "initialize",
            serde_json::json!({
                "protocol_version": "0.1.0",
                "client": "termihub-desktop",
                "client_version": "0.1.0"
            }),
        )
        .map_err(|e| {
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
            TerminalError::RemoteError(format!("Write initialize failed: {}", e))
        })?;

        let resp_line = jsonrpc::read_line_blocking(&mut channel).map_err(|e| {
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
            TerminalError::RemoteError(format!("Read initialize response: {}", e))
        })?;
        let msg = jsonrpc::parse_message(&resp_line).map_err(|e| {
            emit_agent_state(&self.app_handle, agent_id, "disconnected");
            TerminalError::RemoteError(format!("Parse initialize response: {}", e))
        })?;

        let capabilities = match msg {
            jsonrpc::JsonRpcMessage::Response { result, .. } => {
                let caps = result.get("capabilities").ok_or_else(|| {
                    emit_agent_state(&self.app_handle, agent_id, "disconnected");
                    TerminalError::RemoteError("Missing capabilities in initialize response".into())
                })?;
                serde_json::from_value::<AgentCapabilities>(caps.clone()).map_err(|e| {
                    emit_agent_state(&self.app_handle, agent_id, "disconnected");
                    TerminalError::RemoteError(format!("Parse capabilities: {}", e))
                })?
            }
            jsonrpc::JsonRpcMessage::Error { message, .. } => {
                emit_agent_state(&self.app_handle, agent_id, "disconnected");
                return Err(TerminalError::RemoteError(format!(
                    "Initialize rejected: {}",
                    message
                )));
            }
            _ => {
                emit_agent_state(&self.app_handle, agent_id, "disconnected");
                return Err(TerminalError::RemoteError(
                    "Unexpected response to initialize".into(),
                ));
            }
        };

        // 4. Switch to non-blocking and spawn I/O thread
        session.set_blocking(false);

        let alive = Arc::new(AtomicBool::new(true));
        let (command_tx, command_rx) = mpsc::channel();

        let alive_clone = alive.clone();
        let app_handle_clone = self.app_handle.clone();
        let agent_id_owned = agent_id.to_string();
        let config_clone = config.clone();

        std::thread::spawn(move || {
            agent_io_thread(
                session,
                channel,
                command_rx,
                alive_clone,
                app_handle_clone,
                agent_id_owned,
                config_clone,
                request_id,
            );
        });

        emit_agent_state(&self.app_handle, agent_id, "connected");

        let result = AgentConnectResult {
            capabilities: capabilities.clone(),
        };

        agents.insert(
            agent_id.to_string(),
            AgentConnection {
                command_tx,
                alive,
                capabilities,
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

        let (resp_tx, resp_rx) = mpsc::channel();
        conn.command_tx
            .send(AgentIoCommand::Request {
                method: method.to_string(),
                params,
                response_tx: resp_tx,
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O thread gone".to_string()))?;

        // Drop the lock before waiting for response
        drop(agents);

        resp_rx
            .recv_timeout(std::time::Duration::from_secs(10))
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

        let result = self.send_request(agent_id, "session.create", params)?;
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
            "session.attach",
            serde_json::json!({ "session_id": remote_session_id }),
        )?;
        Ok(())
    }

    /// Detach from a session on the agent.
    pub fn detach_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "session.detach",
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
            "session.close",
            serde_json::json!({ "session_id": remote_session_id }),
        )?;
        Ok(())
    }

    /// List sessions on the agent.
    pub fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        let result = self.send_request(agent_id, "session.list", serde_json::json!({}))?;
        let sessions = result["sessions"].as_array().cloned().unwrap_or_default();
        Ok(sessions
            .into_iter()
            .filter_map(|s| serde_json::from_value(s).ok())
            .collect())
    }

    /// List saved session definitions on the agent.
    pub fn list_definitions(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        let result =
            self.send_request(agent_id, "session.definitions.list", serde_json::json!({}))?;
        let defs = result["definitions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        Ok(defs
            .into_iter()
            .filter_map(|d| serde_json::from_value(d).ok())
            .collect())
    }

    /// Save a session definition on the agent.
    pub fn save_definition(
        &self,
        agent_id: &str,
        definition: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        let result = self.send_request(agent_id, "session.define", definition)?;
        serde_json::from_value(result)
            .map_err(|e| TerminalError::RemoteError(format!("Parse definition result: {}", e)))
    }

    /// Delete a session definition on the agent.
    pub fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
        self.send_request(
            agent_id,
            "session.definitions.delete",
            serde_json::json!({ "id": def_id }),
        )?;
        Ok(())
    }

    /// Register an output sender for a session on the agent's I/O thread.
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
            .map_err(|_| TerminalError::RemoteError("Agent I/O thread gone".to_string()))
    }

    /// Unregister a session's output sender from the agent's I/O thread.
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
            .map_err(|_| TerminalError::RemoteError("Agent I/O thread gone".to_string()))
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
            .map_err(|_| TerminalError::WriteFailed("Agent I/O thread gone".to_string()))
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
            .map_err(|_| TerminalError::ResizeFailed("Agent I/O thread gone".to_string()))
    }
}

/// Emit an agent state change event.
fn emit_agent_state(app_handle: &AppHandle, agent_id: &str, state: &str) {
    let _ = app_handle.emit(
        "agent-state-change",
        RemoteStateChangeEvent {
            session_id: agent_id.to_string(),
            state: state.to_string(),
        },
    );
}

/// Main I/O thread for an agent connection.
///
/// Owns the SSH Session + Channel exclusively. Processes commands from
/// the mpsc channel and routes output notifications to registered sessions.
#[allow(clippy::too_many_arguments)]
fn agent_io_thread(
    _session: Session,
    mut channel: ssh2::Channel,
    command_rx: mpsc::Receiver<AgentIoCommand>,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
    agent_id: String,
    config: RemoteAgentConfig,
    mut request_id: u64,
) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut line_buf = String::new();
    let mut read_buf = [0u8; 4096];
    let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut pending_responses: HashMap<u64, mpsc::Sender<Result<Value, String>>> = HashMap::new();

    'outer: loop {
        // Inner read loop
        let connection_broken = loop {
            // 1. Process pending commands (non-blocking)
            while let Ok(cmd) = command_rx.try_recv() {
                match cmd {
                    AgentIoCommand::Request {
                        method,
                        params,
                        response_tx,
                    } => {
                        request_id += 1;
                        pending_responses.insert(request_id, response_tx);
                        if let Err(e) =
                            jsonrpc::write_request(&mut channel, request_id, &method, params)
                        {
                            if let Some(tx) = pending_responses.remove(&request_id) {
                                let _ = tx.send(Err(format!("Write failed: {}", e)));
                            }
                        }
                    }
                    AgentIoCommand::SessionInput { session_id, data } => {
                        request_id += 1;
                        let encoded = b64.encode(&data);
                        let _ = jsonrpc::write_request(
                            &mut channel,
                            request_id,
                            "session.input",
                            serde_json::json!({
                                "session_id": session_id,
                                "data": encoded,
                            }),
                        );
                    }
                    AgentIoCommand::SessionResize {
                        session_id,
                        cols,
                        rows,
                    } => {
                        request_id += 1;
                        let _ = jsonrpc::write_request(
                            &mut channel,
                            request_id,
                            "session.resize",
                            serde_json::json!({
                                "session_id": session_id,
                                "cols": cols,
                                "rows": rows,
                            }),
                        );
                    }
                    AgentIoCommand::RegisterSession {
                        session_id,
                        output_tx,
                    } => {
                        session_outputs.insert(session_id, output_tx);
                    }
                    AgentIoCommand::UnregisterSession { session_id } => {
                        session_outputs.remove(&session_id);
                    }
                    AgentIoCommand::Disconnect => {
                        alive.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }

            // 2. Non-blocking read from SSH channel
            match channel.read(&mut read_buf) {
                Ok(0) => {
                    // EOF — connection closed
                    break true;
                }
                Ok(n) => {
                    let chunk = &read_buf[..n];
                    line_buf.push_str(&String::from_utf8_lossy(chunk));

                    // Process complete lines
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
                                handle_notification(&method, &params, &session_outputs, &b64);
                            }
                            Err(e) => {
                                warn!("Agent {}: failed to parse message: {}", agent_id, e);
                            }
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No data available — sleep briefly
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => {
                    error!("Agent {}: read error: {}", agent_id, e);
                    break true;
                }
            }
        };

        if !connection_broken {
            break;
        }

        // Connection lost — try to reconnect
        emit_agent_state(&app_handle, &agent_id, "reconnecting");
        info!("Agent {}: connection lost, attempting reconnect", agent_id);

        match reconnect_agent(&config, &mut request_id) {
            Ok((new_session, new_channel)) => {
                // Replace the old channel (session is consumed by io_thread signature)
                // We need to start a new I/O loop with the new channel
                let _ = new_session; // session set_blocking(false) already called in reconnect
                channel = new_channel;
                line_buf.clear();
                emit_agent_state(&app_handle, &agent_id, "connected");
                info!("Agent {}: reconnected successfully", agent_id);
                // Clear pending responses with errors
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err("Connection lost during request".to_string()));
                }
                continue 'outer;
            }
            Err(e) => {
                error!("Agent {}: reconnection failed: {}", agent_id, e);
                emit_agent_state(&app_handle, &agent_id, "disconnected");
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

/// Handle an output notification from the agent.
fn handle_notification(
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    b64: &base64::engine::GeneralPurpose,
) {
    if method != "session.output" {
        return;
    }
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
        let _ = output_tx.send(data);
    }
}

/// Attempt to reconnect to an agent with exponential backoff.
fn reconnect_agent(
    config: &RemoteAgentConfig,
    request_id: &mut u64,
) -> Result<(Session, ssh2::Channel), String> {
    const MAX_RETRIES: u32 = 10;
    const MAX_BACKOFF_SECS: u64 = 30;

    for attempt in 0..MAX_RETRIES {
        let backoff = std::cmp::min(2u64.pow(attempt), MAX_BACKOFF_SECS);
        std::thread::sleep(std::time::Duration::from_secs(backoff));

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
        let mut channel = match session.channel_session() {
            Ok(c) => c,
            Err(e) => {
                warn!("Reconnect attempt {} failed (channel): {}", attempt + 1, e);
                continue;
            }
        };
        if let Err(e) = channel.exec("termihub-agent --stdio") {
            warn!("Reconnect attempt {} failed (exec): {}", attempt + 1, e);
            continue;
        }

        // 3. Initialize
        *request_id += 1;
        if let Err(e) = jsonrpc::write_request(
            &mut channel,
            *request_id,
            "initialize",
            serde_json::json!({
                "protocol_version": "0.1.0",
                "client": "termihub-desktop",
                "client_version": "0.1.0"
            }),
        ) {
            warn!(
                "Reconnect attempt {} failed (write init): {}",
                attempt + 1,
                e
            );
            continue;
        }

        match jsonrpc::read_line_blocking(&mut channel) {
            Ok(line) => match jsonrpc::parse_message(&line) {
                Ok(jsonrpc::JsonRpcMessage::Response { .. }) => {
                    session.set_blocking(false);
                    return Ok((session, channel));
                }
                Ok(jsonrpc::JsonRpcMessage::Error { message, .. }) => {
                    warn!(
                        "Reconnect attempt {} failed (init rejected): {}",
                        attempt + 1,
                        message
                    );
                    continue;
                }
                _ => {
                    warn!(
                        "Reconnect attempt {} failed (unexpected init response)",
                        attempt + 1
                    );
                    continue;
                }
            },
            Err(e) => {
                warn!(
                    "Reconnect attempt {} failed (read init): {}",
                    attempt + 1,
                    e
                );
                continue;
            }
        }
    }

    Err(format!(
        "Failed to reconnect after {} attempts",
        MAX_RETRIES
    ))
}
