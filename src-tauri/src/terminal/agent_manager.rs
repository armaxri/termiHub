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
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::monitoring::{MonitoringSender, SystemStats};

use crate::agents_projection::projection::fold_agent_transition;
use crate::agents_projection::store::AgentConnectionState;
use crate::connection::config::AgentSettings;
use crate::session::manager::{AgentHostedSession, SessionManager};
use crate::session_projection::projection::{
    fold_agent_session_recovered, fold_agent_transport_reconnecting,
};
use crate::terminal::agent_config_store::{decide_reattach, AgentConfigStore, ReattachDecision};
use crate::terminal::agent_deploy::ConnectedHost;
use crate::terminal::agent_forward::DesktopAgentForward;
use crate::terminal::backend::{OutputSender, RemoteAgentConfig, RemoteStateChangeEvent};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::{connect_and_authenticate, connect_and_authenticate_cancellable};

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
pub(crate) enum AgentIoCommand {
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
    /// Send the operator's ssh-agent reply bytes for a forwarded stream to the
    /// agent (`agent.forward.data`, desktop→agent leg of the relay, #1727).
    AgentForwardData { stream_id: String, data: Vec<u8> },
    /// Tell the agent a forwarded ssh-agent stream has closed
    /// (`agent.forward.close`, #1727).
    AgentForwardClose { stream_id: String },
    /// Disconnect the agent.
    Disconnect,
    /// TEST-ONLY (#2573): abruptly sever this agent's russh transport in-process,
    /// then enter the reconnect path — a deterministic, cross-platform analog of a
    /// server-side transport drop that needs no sshd kill, `lsof`, or process-title
    /// matching. The I/O task drops the desktop russh session + channel so the
    /// peer's sshd handler sees an abrupt EOF/RST (no clean SSH disconnect), which
    /// is exactly what a real transport loss produces. Only ever constructed by
    /// [`AgentConnectionManager::test_sever_transport`], which is reachable solely
    /// through the test-bridge-gated `test_sever_agent_transport` command.
    TestSeverTransport,
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
    /// Agent-assigned id for this desktop's own client connection (from the
    /// `initialize` result). Lets [`list_connections`](AgentConnectionManager::list_connections)
    /// exclude this desktop from the connected-host update guard (#1349). Empty
    /// when the agent predates protocol 0.3.0 and did not report one.
    client_id: String,
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

    /// Cancel an in-flight (still connecting) agent connect. Returns whether a
    /// connecting agent was found (G1, #1235).
    fn cancel_connect(&self, agent_id: &str) -> bool;

    /// Disconnect an agent.
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError>;

    /// Check if an agent is connected.
    fn is_connected(&self, agent_id: &str) -> bool;

    /// Sweep every agent whose I/O task has already died (`alive == false`),
    /// returning the swept ids. Manual resource-hygiene escape hatch (G6, #1239).
    fn prune_dead_agents(&self) -> Vec<String> {
        Vec::new()
    }

    /// Get the capabilities of a connected agent.
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities>;

    /// Retain an agent's SSH transport config for backend-driven reconnect
    /// reattach (#2472). Default no-op so mock clients need not implement it; the
    /// production [`AgentConnectionManager`] stores it for the redrive.
    fn retain_agent_config(
        &self,
        _agent_id: &str,
        _config: &RemoteAgentConfig,
        _agent_settings: Option<&AgentSettings>,
    ) {
    }

    /// Drop and zeroize the retained reattach config for an agent (#2472).
    /// Default no-op; the production manager scrubs it.
    fn clear_retained_agent_config(&self, _agent_id: &str) {}

    /// TEST-ONLY (#2573): abruptly sever the agent's transport in-process to drive
    /// the reconnect path deterministically. Default no-op returning `false` (mock
    /// clients); the production [`AgentConnectionManager`] performs the sever.
    fn test_sever_transport(&self, _agent_id: &str) -> bool {
        false
    }

    /// Cold-re-establish a reaped agent transport from its retained config for
    /// the reconnect redrive (#2472). Default errors so mocks that do not model
    /// reattach fall through to a folded reconnect failure; the production
    /// [`AgentConnectionManager`] re-establishes from its retained config.
    fn reconnect_retained_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        Err(TerminalError::RemoteError(format!(
            "Agent {agent_id} reattach not supported"
        )))
    }

    /// Gracefully shut down a remote agent and disconnect.
    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError>;

    /// List the hosts connected to the agent other than this desktop (#1349).
    ///
    /// Default returns an empty list so mock clients need not implement it; the
    /// production [`AgentConnectionManager`] queries `agent.list_connections`.
    fn list_connections(&self, _agent_id: &str) -> Result<Vec<ConnectedHost>, TerminalError> {
        Ok(Vec::new())
    }

    /// Send a JSON-RPC request to an agent and wait for the response.
    fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError>;

    /// Create a session on the agent.
    ///
    /// `definition_id` records which saved connection definition this session
    /// came from, so it can be re-linked after restart. Pass `None` for
    /// ad-hoc sessions not derived from a saved definition.
    fn create_session(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
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

/// Registry of cancellation tokens for in-flight (still connecting) agents,
/// keyed by `agent_id`. Lets a Cancel while connecting abort the blocking
/// handshake promptly instead of waiting out the connect timeout (G1, #1235).
type ConnectingRegistry = Arc<Mutex<HashMap<String, CancellationToken>>>;

/// Register a cancellation token for an in-flight agent connect.
fn register_connecting_token(
    registry: &ConnectingRegistry,
    agent_id: &str,
    token: CancellationToken,
) {
    if let Ok(mut map) = registry.lock() {
        map.insert(agent_id.to_string(), token);
    }
}

/// Fire the cancellation token for an in-flight agent connect, if one is
/// registered. Returns `true` when a matching connect was in flight.
fn cancel_connect_token(registry: &ConnectingRegistry, agent_id: &str) -> bool {
    let token = registry
        .lock()
        .ok()
        .and_then(|map| map.get(agent_id).cloned());
    match token {
        Some(token) => {
            token.cancel();
            true
        }
        None => false,
    }
}

/// Run the blocking connect + initialize handshake future, aborting promptly
/// when the cancellation token fires (G1, #1235).
///
/// The connect body owns the russh session/channel; on cancel the future is
/// dropped (dropping the channel with it) and a cancellation error is returned
/// so the caller can emit `disconnected`.
async fn run_connect_cancellable<T, F>(
    token: &CancellationToken,
    fut: F,
) -> Result<T, TerminalError>
where
    F: std::future::Future<Output = Result<T, TerminalError>>,
{
    tokio::select! {
        biased;
        _ = token.cancelled() => {
            Err(TerminalError::RemoteError("Connect cancelled".to_string()))
        }
        res = fut => res,
    }
}

/// Removes an `agent_id` from the connecting registry when the connect attempt
/// finishes (success, failure, or cancellation) — RAII so the entry is cleared
/// even when the connect returns early via `?`.
struct ConnectingGuard {
    map: ConnectingRegistry,
    id: String,
}

impl Drop for ConnectingGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(&self.id);
        }
    }
}

/// Shared, reference-countable map of connected agents keyed by `agent_id`.
///
/// Held in an `Arc` so the async I/O task can hold a [`Weak`] back-reference and
/// self-reap its own entry on an exhausted reconnect (G6, #1239) instead of
/// leaving a zombie behind for lazy eviction on the next `connect_agent`.
type AgentMap = Arc<Mutex<HashMap<String, AgentConnection>>>;

/// Weak back-reference to the [`AgentMap`], held by the async I/O task so it can
/// self-reap its own entry without keeping the manager alive (G6, #1239).
type WeakAgentMap = std::sync::Weak<Mutex<HashMap<String, AgentConnection>>>;

/// Reap an agent's own entry from the manager map via a weak back-reference.
///
/// Called by the I/O task when its reconnect budget is exhausted. A dropped
/// manager (dead `Weak`) or poisoned lock is treated as a no-op — there is
/// nothing left to clean up.
fn reap_agent(agents: &WeakAgentMap, agent_id: &str) {
    // `upgrade()` must be bound so the strong `Arc` outlives the guard it lends.
    if let Some(agents) = agents.upgrade() {
        if let Ok(mut guard) = agents.lock() {
            guard.remove(agent_id);
        }
    }
}

/// Remove every `alive == false` entry from the agent map, returning the
/// removed ids. Backs the **Prune dead agents** escape hatch (G6, #1239).
fn prune_dead_agents_from_map(agents: &Mutex<HashMap<String, AgentConnection>>) -> Vec<String> {
    let mut removed = Vec::new();
    if let Ok(mut guard) = agents.lock() {
        guard.retain(|id, conn| {
            let alive = conn.alive.load(Ordering::SeqCst);
            if !alive {
                removed.push(id.clone());
            }
            alive
        });
    }
    removed
}

/// Manages connections to remote agents.
///
/// Each agent is identified by its `agent_id` string. Multiple sessions
/// can be multiplexed over a single SSH connection.
pub struct AgentConnectionManager {
    agents: AgentMap,
    /// Cancellation tokens for in-flight connects, keyed by agent id (G1, #1235).
    connecting: ConnectingRegistry,
    /// Retained SSH transport configs for agents that opted into backend-driven
    /// reconnect reattach, keyed by agent id (#2472). Survives a transport reap
    /// so the reconnect redrive can cold-re-establish the transport itself; only
    /// ever populated when the connect opted in (default-off flag), so it is
    /// never written on the `develop`/flag-off path. See
    /// [`crate::terminal::agent_config_store`].
    agent_configs: AgentConfigStore,
    app_handle: AppHandle,
}

impl AgentConnectionManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            agents: Arc::new(Mutex::new(HashMap::new())),
            connecting: Arc::new(Mutex::new(HashMap::new())),
            agent_configs: AgentConfigStore::new(),
            app_handle,
        }
    }

    /// Prune every agent whose I/O task has already died (`alive == false`),
    /// returning the ids that were swept. Pure resource hygiene — routing is
    /// already safe because `is_connected()` reports `false` for such entries
    /// (G6, #1239).
    pub fn prune_dead_agents(&self) -> Vec<String> {
        let pruned = prune_dead_agents_from_map(&self.agents);
        // Scrub the reattach config of every pruned agent: a manual prune of a
        // dead agent is a terminal point, so its retained secret must not linger
        // (#2472).
        for agent_id in &pruned {
            self.agent_configs.clear(agent_id);
        }
        pruned
    }

    /// Cancel an in-flight (still connecting) agent by its `agent_id`.
    ///
    /// Fires the registered cancellation token so a blocking connect+handshake
    /// aborts promptly; the connect path then emits `disconnected`. Returns
    /// `true` if a matching connect was in flight (G1, #1235).
    pub fn cancel_connect(&self, agent_id: &str) -> bool {
        cancel_connect_token(&self.connecting, agent_id)
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

        // Register a cancellation token so a Cancel while connecting can abort
        // the in-flight handshake (G1, #1235). The guard clears the entry when
        // this connect finishes, even on an early `?` return. The token is held
        // in a registry keyed by agent id, so `cancel_connect` can fire it.
        let cancel_token = CancellationToken::new();
        register_connecting_token(&self.connecting, agent_id, cancel_token.clone());
        let _connecting_guard = ConnectingGuard {
            map: self.connecting.clone(),
            id: agent_id.to_string(),
        };

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
        // Weak back-reference so the spawned I/O task can self-reap its own map
        // entry on an exhausted reconnect without keeping the manager alive (G6).
        let agents_weak = Arc::downgrade(&self.agents);

        // Run the async connect+handshake on the current tokio runtime, wrapped
        // in a `tokio::select!` against the cancellation token so a Cancel aborts
        // the blocking handshake promptly and drops the russh channel (G1, #1235).
        let handle = tokio::runtime::Handle::current();
        let cancel_for_task = cancel_token.clone();
        let result = handle.block_on(run_connect_cancellable(&cancel_for_task, async {
            // 1. SSH connect and authenticate (cancellable at the TCP/handshake
            // level so a hung connect to an unreachable host aborts promptly).
            let session =
                connect_and_authenticate_cancellable(&ssh_config, cancel_for_task.clone())
                    .inspect_err(|_| {
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

            // Diagnostic for #2480: bookend the handshake at INFO so a full-app
            // display run can see whether the stall is before the `initialize`
            // write, or while awaiting the response line from the agent. Pairs
            // with the "initialize response received" log after the loop below.
            info!(
                "Agent {}: exec launched, sending initialize over the SSH channel",
                agent_id_str
            );
            channel.data(req_line.as_bytes()).await.map_err(|e| {
                emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                TerminalError::RemoteError(format!("Write initialize failed: {}", e))
            })?;
            info!(
                "Agent {}: initialize written, awaiting response line from agent",
                agent_id_str
            );

            // Read the initialize response from the channel. The agent may emit
            // notifications before it answers (e.g. output from a session it
            // recovered on startup, or a staged `agent.update_available` notice
            // sent on attach). We loop until we see the message whose id matches
            // our initialize request; otherwise a pre-initialize notification
            // would be misread as the response ("Unexpected response to
            // initialize"). Those notifications are buffered here and replayed
            // once init completes (#1660) rather than dropped, so an on-attach
            // notification is delivered to the desktop handlers. A generous cap
            // guards against a runaway agent that never sends the response.
            const MAX_PRE_INIT_MESSAGES: u32 = 1000;
            let mut skipped: u32 = 0;
            let mut pending_notifications: Vec<(String, Value)> = Vec::new();
            let mut line_buf = String::new();
            let (capabilities, agent_version, protocol_version, client_id) = loop {
                let resp_line =
                    match read_handshake_line(&mut channel, &agent_id_str, &mut line_buf).await {
                        Some(line) => line,
                        None => {
                            emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                            return Err(TerminalError::RemoteError(
                                "Channel closed before initialize response".into(),
                            ));
                        }
                    };

                let msg = jsonrpc::parse_message(&resp_line).map_err(|e| {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                    TerminalError::RemoteError(format!("Parse initialize response: {}", e))
                })?;

                match jsonrpc::classify_handshake_message(msg, request_id) {
                    jsonrpc::HandshakeOutcome::Response(result) => {
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
                        // Agent-assigned id for this connection (protocol 0.3.0+);
                        // empty against older agents that don't report one.
                        let client_id = result
                            .get("client_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        // Copy agent_version into capabilities so the UI can read it.
                        capabilities.agent_version = agent_version.clone();
                        // Diagnostic for #2480: the handshake completed — the
                        // agent's initialize response reached the desktop. If a
                        // display run reaches this line the transport round-trip
                        // is healthy and any remaining stall is downstream.
                        info!(
                            "Agent {}: initialize response received (agent v{}, protocol {}); marking connected",
                            agent_id_str, agent_version, protocol_version
                        );
                        break (capabilities, agent_version, protocol_version, client_id);
                    }
                    jsonrpc::HandshakeOutcome::Rejected(message) => {
                        emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                        return Err(TerminalError::RemoteError(format!(
                            "Initialize rejected: {}",
                            message
                        )));
                    }
                    jsonrpc::HandshakeOutcome::Buffer { method, params } => {
                        skipped += 1;
                        if skipped > MAX_PRE_INIT_MESSAGES {
                            emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                            return Err(TerminalError::RemoteError(
                                "Agent sent too many messages before the initialize response"
                                    .into(),
                            ));
                        }
                        // Retain the notification and replay it after init so an
                        // on-attach notice is not dropped (#1660).
                        pending_notifications.push((method, params));
                        continue;
                    }
                    jsonrpc::HandshakeOutcome::Skip => {
                        skipped += 1;
                        if skipped > MAX_PRE_INIT_MESSAGES {
                            emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                            return Err(TerminalError::RemoteError(
                                "Agent sent too many messages before the initialize response"
                                    .into(),
                            ));
                        }
                        warn!(
                            "Agent {}: skipping pre-initialize message during handshake",
                            agent_id_str
                        );
                        continue;
                    }
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
            let agents_weak_task = agents_weak.clone();

            // A clone for the task itself: the agent-forward relay's pump tasks
            // send reply chunks back through it (#1727). Teardown is driven by an
            // explicit `Disconnect`, so a task-held clone does not mask it.
            let command_tx_task = command_tx.clone();
            tokio::spawn(async move {
                agent_io_task(
                    session,
                    channel,
                    command_rx,
                    command_tx_task,
                    alive_clone,
                    app_handle_task,
                    agent_id_task,
                    config_task,
                    settings_task,
                    request_id,
                    agents_weak_task,
                    pending_notifications,
                )
                .await;
            });

            Ok::<_, TerminalError>((
                capabilities,
                agent_version,
                protocol_version,
                client_id,
                command_tx,
                alive,
            ))
        }));

        // On cancel the connect future above is dropped before any I/O task is
        // spawned, so no backend `disconnected` is emitted from there — emit it
        // here so the agent returns to `disconnected` (single writer, G1 #1235).
        // Other error paths already emit `disconnected` inline before returning.
        let (capabilities, agent_version, protocol_version, client_id, command_tx, alive) =
            match result {
                Ok(v) => v,
                Err(e) => {
                    if cancel_token.is_cancelled() {
                        emit_agent_state(&self.app_handle, agent_id, "disconnected");
                    }
                    return Err(e);
                }
            };

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
                client_id,
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

        let live = agents.remove(agent_id);
        // Scrub the reattach config unconditionally, before returning either arm:
        // a user disconnect is a terminal point, and the agent may already have
        // been *reaped* (no live entry) while its reattach config lingers — that
        // config must not survive the user's disconnect (#2472). The agents lock
        // is dropped first so the config-store lock is never held nested under it.
        drop(agents);
        self.agent_configs.clear(agent_id);

        if let Some(conn) = live {
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

    /// TEST-ONLY (#2573): abruptly sever a connected agent's russh transport
    /// in-process, driving it through the same park/retry reconnect path a real
    /// server-side transport drop takes — no sshd kill, `lsof`, or process-title
    /// matching, deterministic and cross-platform.
    ///
    /// Unlike [`disconnect_agent`](Self::disconnect_agent) (user-cancel: tears the
    /// agent down for good), this keeps the I/O task alive so it re-establishes the
    /// transport and re-attaches surviving daemon sessions. It is the primitive the
    /// automated agent-reconnect grade drives; the only caller is the
    /// test-bridge-gated `test_sever_agent_transport` command, so a production
    /// launch (test bridge off) can never reach it.
    ///
    /// Returns `true` when a live agent received the sever, `false` for an unknown
    /// or already-dead agent (nothing to sever).
    pub fn test_sever_transport(&self, agent_id: &str) -> bool {
        let agents = match self.agents.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        match agents.get(agent_id) {
            Some(conn) if conn.alive.load(Ordering::SeqCst) => conn
                .command_tx
                .send(AgentIoCommand::TestSeverTransport)
                .is_ok(),
            _ => false,
        }
    }

    /// Get the capabilities of a connected agent.
    pub fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        agents.get(agent_id).map(|c| c.capabilities.clone())
    }

    /// Retain an agent's SSH transport config for backend-driven reconnect
    /// reattach (#2472), so the redrive can cold-re-establish the transport after
    /// a reap. Not currently invoked in production: the frontend agent-tab
    /// backend-redrive wiring (#2473) is not yet present, so no agent config is
    /// retained and the reattach path stays inert — byte-identical to `develop`.
    /// Exercised by tests and re-wired by #2473. The retained secret is zeroized on
    /// drop and scrubbed at every terminal point (user disconnect / shutdown /
    /// prune here, reconnect give-up in the redrive).
    pub fn retain_agent_config(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) {
        self.agent_configs.retain(
            agent_id,
            config.clone(),
            agent_settings.cloned().unwrap_or_default(),
        );
    }

    /// Drop and zeroize the retained reattach config for an agent (#2472). The
    /// loop-terminal scrub point: the redrive calls it when a tab's reconnect
    /// loop gives up. Idempotent.
    pub fn clear_retained_agent_config(&self, agent_id: &str) {
        self.agent_configs.clear(agent_id);
    }

    /// Cold-re-establish a **reaped** agent transport from its retained config
    /// for the reconnect redrive (#2472).
    ///
    /// Single-owner coordination with the in-task reconnect loop
    /// ([`agent_io_task`]'s [`reconnect_agent`]): that loop owns *transient*
    /// transport breaks while the I/O task is alive, keeping the agent map entry
    /// present. This method therefore:
    ///
    /// - **no-ops** (`Ok`) when the agent is already connected — either genuinely,
    ///   or mid in-task reconnect (the entry is still `alive`), so it never
    ///   double-drives against that loop;
    /// - otherwise cold-re-establishes from the retained config via
    ///   [`Self::connect_agent`], which locks the agent map for the whole connect,
    ///   so two concurrent redrives serialize and the loser observes the winner's
    ///   entry as "already connected" (mapped back to `Ok` here);
    /// - returns `Err` when nothing is retained (the connect did not opt in, or
    ///   the config was already scrubbed) so the redrive folds a reconnect
    ///   failure and arms the next backoff / gives up.
    ///
    /// Synchronous (wraps a blocking SSH connect); callers on an async runtime
    /// must invoke it via `spawn_blocking`, exactly as the `connect_agent`
    /// command does.
    pub fn reconnect_retained_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        // The decision (no-op / reconnect / no-config) is a pure function over the
        // config store + the connected reading, unit-tested in `agent_config_store`.
        // `Reconnect` clones the config out (its `Drop` zeroizes the copied
        // password) so the config-store lock is not held across the blocking
        // connect.
        match decide_reattach(&self.agent_configs, self.is_connected(agent_id), agent_id) {
            ReattachDecision::AlreadyConnected => Ok(()),
            ReattachDecision::NoRetainedConfig => Err(TerminalError::RemoteError(format!(
                "No retained config to re-establish agent {agent_id}"
            ))),
            ReattachDecision::Reconnect(retained) => {
                match self.connect_agent(agent_id, &retained.config, Some(&retained.settings)) {
                    Ok(_) => Ok(()),
                    // A concurrent redrive won the connect race and already
                    // re-established the transport — treat that as success, not a
                    // failure to fold.
                    Err(TerminalError::RemoteError(msg)) if msg.contains("already connected") => {
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            }
        }
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

    /// List the hosts connected to the agent **other than this desktop**.
    ///
    /// Sends `agent.list_connections`, then drops this desktop's own client
    /// (matched by the `client_id` captured at `initialize`) so the result is
    /// exactly the "other hosts" the connected-host update guard (#1349) cares
    /// about. Best-effort: because the agent runs one process per `--stdio`
    /// channel, the snapshot normally holds only this desktop, so the result is
    /// usually empty; other hosts surface only when the agent process is shared
    /// (`--listen`) or a future coordination layer aggregates clients.
    pub fn list_connections(&self, agent_id: &str) -> Result<Vec<ConnectedHost>, TerminalError> {
        let own_client_id = {
            let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            agents.get(agent_id).map(|c| c.client_id.clone())
        };

        let result =
            self.send_request(agent_id, "agent.list_connections", serde_json::json!({}))?;
        let connections = result["connections"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let own_client_id = own_client_id.unwrap_or_default();
        let hosts = connections
            .into_iter()
            .filter_map(|c| {
                let client_id = c.get("client_id")?.as_str()?.to_string();
                // Exclude this desktop's own entry (never warn about ourselves).
                if !own_client_id.is_empty() && client_id == own_client_id {
                    return None;
                }
                Some(ConnectedHost {
                    client_id,
                    client: c
                        .get("client")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    client_version: c
                        .get("client_version")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    connected_since: c
                        .get("connected_since")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .collect();

        Ok(hosts)
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
        definition_id: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        let mut params = serde_json::json!({
            "type": session_type,
            "config": config,
        });
        if let Some(t) = title {
            params["title"] = Value::String(t.to_string());
        }
        if let Some(d) = definition_id {
            params["definition_id"] = Value::String(d.to_string());
        }

        let result = self.send_request(agent_id, "connection.create", params)?;
        Ok(AgentSessionInfo {
            session_id: result["session_id"].as_str().unwrap_or("").to_string(),
            title: result["title"].as_str().unwrap_or("").to_string(),
            session_type: result["type"].as_str().unwrap_or(session_type).to_string(),
            status: result["status"].as_str().unwrap_or("running").to_string(),
            attached: false,
            definition_id: result["definition_id"].as_str().map(String::from),
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

    fn cancel_connect(&self, agent_id: &str) -> bool {
        AgentConnectionManager::cancel_connect(self, agent_id)
    }

    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::disconnect_agent(self, agent_id)
    }

    fn is_connected(&self, agent_id: &str) -> bool {
        AgentConnectionManager::is_connected(self, agent_id)
    }

    fn prune_dead_agents(&self) -> Vec<String> {
        AgentConnectionManager::prune_dead_agents(self)
    }

    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        AgentConnectionManager::get_capabilities(self, agent_id)
    }

    fn retain_agent_config(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) {
        AgentConnectionManager::retain_agent_config(self, agent_id, config, agent_settings)
    }

    fn clear_retained_agent_config(&self, agent_id: &str) {
        AgentConnectionManager::clear_retained_agent_config(self, agent_id)
    }

    fn test_sever_transport(&self, agent_id: &str) -> bool {
        AgentConnectionManager::test_sever_transport(self, agent_id)
    }

    fn reconnect_retained_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::reconnect_retained_agent(self, agent_id)
    }

    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError> {
        AgentConnectionManager::shutdown_agent(self, agent_id, reason)
    }

    fn list_connections(&self, agent_id: &str) -> Result<Vec<ConnectedHost>, TerminalError> {
        AgentConnectionManager::list_connections(self, agent_id)
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
        definition_id: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        AgentConnectionManager::create_session(
            self,
            agent_id,
            session_type,
            config,
            title,
            definition_id,
        )
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
        "protocolVersion": "0.3.0",
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
/// Read a single newline-terminated JSON-RPC line from a russh channel during
/// the handshake phase. Accumulates `ChannelMsg::Data` chunks into `buf` and,
/// once a `\n` is present, returns the trimmed line while **retaining any bytes
/// after the newline in `buf`** for the next call. Preserving the leftover is
/// essential when the caller skips pre-initialize notifications: a notification
/// and the initialize response can arrive in the same data chunk, and dropping
/// the remainder would lose the response.
///
/// Returns `None` when the channel closes or the agent process exits (stderr is
/// logged, not returned). The caller decides how to treat closure.
async fn read_handshake_line(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    buf: &mut String,
) -> Option<String> {
    loop {
        if let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            return Some(line);
        }
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                // Diagnostic for #2480: confirms the desktop is actually
                // receiving the agent's stdout (the initialize response) over the
                // SSH channel. A run that logs "awaiting response" but never this
                // means the bytes are not arriving — a transport/channel issue,
                // not the agent's initialize handler.
                info!(
                    "Agent {}: handshake received {} stdout byte(s) over the channel",
                    agent_id,
                    data.len()
                );
                buf.push_str(&String::from_utf8_lossy(data));
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
                info!("Agent {}: channel EOF/closed during handshake", agent_id);
                return None;
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                warn!(
                    "Agent {}: process exited with status {} during handshake",
                    agent_id, exit_status
                );
                return None;
            }
            other => {
                // Any other channel message (window adjust, success, etc.). Logged
                // at DEBUG so a stalled handshake still shows what russh delivered.
                debug!("Agent {}: handshake channel message: {:?}", agent_id, other);
            }
        }
    }
}

/// Map an `agent-state-change` wire string to the store's connection-state enum.
///
/// The four states the agent manager emits are the camelCase variants of
/// [`AgentConnectionState`]; an unrecognised string yields `None` so the fold is
/// skipped rather than forcing a state.
fn parse_agent_connection_state(state: &str) -> Option<AgentConnectionState> {
    match state {
        "disconnected" => Some(AgentConnectionState::Disconnected),
        "connecting" => Some(AgentConnectionState::Connecting),
        "connected" => Some(AgentConnectionState::Connected),
        "reconnecting" => Some(AgentConnectionState::Reconnecting),
        _ => None,
    }
}

/// Emit an agent state change event with an optional error description.
fn emit_agent_state_with_error(
    app_handle: &AppHandle,
    agent_id: &str,
    state: &str,
    error: Option<&str>,
) {
    // Server-authority fold (#2388): reflect the connection-state transition into
    // the shared `AgentsStore` at the source — this function is the single choke
    // point every `connecting`/`connected`/`disconnected`/`reconnecting` emission
    // flows through. Additive: the Tauri event below and the client `agent.status`
    // mirror stay in place, so no user-facing behavior changes. The store's
    // `set_status` tracks `lastError` with the same rules the frontend's
    // `setAgentConnectionState` applies (record on `disconnected`, clear on
    // `connecting`/`connected`), so the fold and the client mirror agree.
    if let Some(connection_state) = parse_agent_connection_state(state) {
        let error_owned = error.map(|s| s.to_string());
        fold_agent_transition(app_handle, move |store| {
            store.set_status(agent_id, connection_state, error_owned);
        });
    }
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

/// Forward an agent's `agent.update_available` notification to the frontend as
/// the `agent-update-available` Tauri event (#1352). Tags it with the desktop's
/// `agent_id` so the per-agent deferred-update banner can key off it.
fn emit_agent_update_available(app_handle: &AppHandle, agent_id: &str, params: &Value) {
    let _ = app_handle.emit(
        "agent-update-available",
        serde_json::json!({
            "agent_id": agent_id,
            "currentVersion": params.get("currentVersion").and_then(Value::as_str).unwrap_or(""),
            "availableVersion": params.get("availableVersion").and_then(Value::as_str).unwrap_or(""),
            "staged": params.get("staged").and_then(Value::as_bool).unwrap_or(false),
        }),
    );
}

/// Forward an agent's `agent.update_pending` notification to the frontend as the
/// `remote-agent-update-pending` Tauri event (#1602). Broadcast by the agent to
/// every *other* connected host when one host initiates a coordinated update
/// (#1351): this desktop is being cut over, so the frontend surfaces the "being
/// updated by another host" notice, suspends the affected session and queues an
/// auto-reconnect. Tagged with the `agent_id` so the notice keys off it exactly
/// like the deferred-update banner.
fn emit_remote_agent_update_pending(app_handle: &AppHandle, agent_id: &str, params: &Value) {
    let _ = app_handle.emit(
        "remote-agent-update-pending",
        serde_json::json!({
            "agent_id": agent_id,
            "requestedByVersion": params
                .get("requestedByVersion")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            "estimatedRestartSecs": params
                .get("estimatedRestartSecs")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        }),
    );
}

// ── Async I/O task ───────────────────────────────────────────────────

/// Main async I/O task for an agent connection.
///
/// TEST-ONLY (#2573): abruptly sever a desktop russh agent transport in-process
/// by dropping its channel and session handle.
///
/// Dropping both ends the russh session background task, which closes the
/// underlying TCP socket **without** a clean SSH disconnect — so the peer's sshd
/// handler sees an abrupt EOF/RST, exactly what a real transport loss produces.
/// This is the deterministic, cross-platform sever primitive the agent-reconnect
/// harness drives: no sshd kill, no `lsof`, no process-title matching, no root.
///
/// Shared by [`agent_io_task`]'s `TestSeverTransport` handling (the shipped path,
/// reached via [`AgentConnectionManager::test_sever_transport`]) and the real-sshd
/// reconnect integration tests, so both exercise the identical sever operation.
fn test_sever_desktop_transport(
    channel: russh::Channel<russh::client::Msg>,
    session: Option<SshSession>,
) {
    drop(channel);
    drop(session);
}

/// Owns the russh `SshSession` and `Channel` exclusively. Concurrently polls
/// incoming SSH data and outgoing commands using `tokio::select!`. Routes
/// JSON-RPC responses to waiting callers and notifications to registered
/// session output channels.
#[allow(clippy::too_many_arguments)]
async fn agent_io_task(
    session: SshSession,
    mut channel: russh::Channel<russh::client::Msg>,
    mut command_rx: UnboundedReceiver<AgentIoCommand>,
    command_tx: UnboundedSender<AgentIoCommand>,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
    agent_id: String,
    config: RemoteAgentConfig,
    agent_settings: AgentSettings,
    mut request_id: u64,
    agents: WeakAgentMap,
    pending_notifications: Vec<(String, Value)>,
) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut line_buf = String::new();
    let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringSender> = HashMap::new();
    let mut pending_responses: HashMap<u64, oneshot::Sender<Result<Value, String>>> =
        HashMap::new();
    // Desktop end of the ssh-agent relay (#1727): bridges forwarded ssh-agent
    // streams the agent opens to the operator's own local agent.
    let agent_forward = DesktopAgentForward::new();
    let mut connection_error: Option<String> = None;

    // Replay notifications that arrived during the `initialize` handshake before
    // entering the live loop (#1660). Agent-level notices (`agent.update_*`) go
    // straight to the frontend; session/monitoring notifications route through
    // the (as-yet-empty) sender maps and are no-ops until a session registers,
    // matching how a post-init notification for an unknown session behaves.
    for (method, params) in &pending_notifications {
        dispatch_agent_notification(
            &app_handle,
            &agent_id,
            method,
            params,
            &session_outputs,
            &monitoring_outputs,
            &b64,
        );
    }

    // Keep the current session handle alive. On reconnect this is replaced so
    // the old session is dropped and the new one is held for the next loop iteration.
    let mut _current_session: Option<SshSession> = Some(session);

    // TEST-ONLY (#2573): set when a `TestSeverTransport` command broke the inner
    // loop, so the reconnect path knows to drop the transport eagerly (a real
    // break has already closed the socket). Never set on the production path.
    let mut test_severed = false;

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
                        AgentIoCommand::AgentForwardData { stream_id, data } => {
                            request_id += 1;
                            let encoded = b64.encode(&data);
                            if let Ok(line) = serialize_request(
                                request_id,
                                "agent.forward.data",
                                serde_json::json!({
                                    "stream_id": stream_id,
                                    "data": encoded,
                                }),
                            ) {
                                let _ = channel.data(line.as_bytes()).await;
                            }
                        }
                        AgentIoCommand::AgentForwardClose { stream_id } => {
                            request_id += 1;
                            if let Ok(line) = serialize_request(
                                request_id,
                                "agent.forward.close",
                                serde_json::json!({ "stream_id": stream_id }),
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
                        AgentIoCommand::TestSeverTransport => {
                            // TEST-ONLY (#2573): model an abrupt transport loss.
                            // Flag it, record the cause, and break into the same
                            // reconnect path a real EOF takes; the transport is
                            // dropped eagerly just below so the peer sees the break
                            // at once.
                            info!("Agent {}: test-only in-process transport sever", agent_id);
                            test_severed = true;
                            connection_error =
                                Some("test-only in-process transport sever (#2573)".to_string());
                            break true;
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
                                        // The ssh-agent relay's streams (#1727)
                                        // route to the desktop's local agent, not
                                        // to a session output channel.
                                        if !handle_agent_forward_notification(
                                            &agent_forward,
                                            &command_tx,
                                            &method,
                                            &params,
                                            &b64,
                                        ) {
                                            dispatch_agent_notification(
                                                &app_handle,
                                                &agent_id,
                                                &method,
                                                &params,
                                                &session_outputs,
                                                &monitoring_outputs,
                                                &b64,
                                            );
                                        }
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

        // TEST-ONLY (#2573): a synthetic in-process sever breaks the inner loop
        // without the socket having died, so release the desktop russh transport
        // eagerly — the peer's sshd handler then sees the abrupt EOF at once,
        // faithfully modelling a real drop, before we re-establish below. `channel`
        // is moved out here and reassigned on a successful reconnect; on the Err
        // path the task returns without touching it again. A real transport break
        // leaves `test_severed` false, so this path is inert in production.
        if test_severed {
            test_severed = false;
            test_sever_desktop_transport(channel, _current_session.take());
        }

        // Connection lost — try to reconnect. Fold every hosted session's
        // `session-lifecycle` region entry to `Reconnecting` at the source (#2556):
        // the in-task loop owns this transient break, so it folds the region itself
        // (status-only, redrive never armed) rather than relying on the frontend
        // `applyAgentReconnecting` client mirror. Folded before the agent-state
        // event so the overlay/tab-dot readers see the reconnecting region.
        fold_agent_hosted_reconnecting(&app_handle, &agent_id, connection_error.as_deref()).await;
        emit_agent_state_with_error(
            &app_handle,
            &agent_id,
            "reconnecting",
            connection_error.as_deref(),
        );
        info!("Agent {}: connection lost, attempting reconnect", agent_id);

        match reconnect_agent(&config, &agent_settings, &mut request_id, &alive).await {
            Ok((new_session, new_channel, reconnect_notifications)) => {
                // Replace the current session handle with the new one.
                // This drops the old (broken) session and keeps the new one alive
                // for the next iteration of the outer loop.
                _current_session = Some(new_session);
                channel = new_channel;
                line_buf.clear();
                connection_error = None;

                // Replay any notifications the agent emitted before answering
                // `initialize` on this reconnect (#1660). Sessions are already
                // registered here, so a buffered `connection.output` routes to
                // its channel and an `agent.update_*` notice reaches the frontend.
                for (method, params) in &reconnect_notifications {
                    dispatch_agent_notification(
                        &app_handle,
                        &agent_id,
                        method,
                        params,
                        &session_outputs,
                        &monitoring_outputs,
                        &b64,
                    );
                }

                // G7 (#1239): reconcile the output/monitoring senders against the
                // sessions the agent actually recovered. Senders keyed by ids that
                // did not come back are stale — drop them so the maps don't leak.
                // #2556: the same recovered-id set resolves each hosted session's
                // `session-lifecycle` region entry `Reconnecting → Connected` for a
                // session that survived in place. Fetch it once when there is either
                // a sender to reconcile or a hosted tab to resolve; skip the extra
                // round-trip when neither applies.
                let hosted = hosted_sessions_for_agent(&app_handle, &agent_id).await;
                if !session_outputs.is_empty()
                    || !monitoring_outputs.is_empty()
                    || !hosted.is_empty()
                {
                    if let Some(live_ids) =
                        list_recovered_session_ids(&mut channel, &agent_id, &mut request_id).await
                    {
                        reconcile_output_senders(
                            &mut session_outputs,
                            &mut monitoring_outputs,
                            &live_ids,
                        );
                        resolve_agent_hosted_recovered(&app_handle, &hosted, &live_ids);
                    }
                }

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
                // G6 (#1239): self-reap our own map entry instead of leaving a
                // zombie for lazy eviction on the next `connect_agent`.
                reap_agent(&agents, &agent_id);
                // Notify all pending requests
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err("Agent disconnected".to_string()));
                }
                return;
            }
        }
    }
}

/// Fold every hosted session's `session-lifecycle` region entry to `Reconnecting`
/// at the backend source on a transient agent-transport break (#2556).
///
/// The server-authoritative move of the enter fold #2555 introduced via a client
/// mirror: `agent_io_task` owns the transient break, so it folds the region itself
/// rather than the frontend `applyAgentReconnecting`. Status-only + loop-idle, so
/// the backend redrive is never armed for a transient break (the in-task loop is
/// the single owner). Off-path no-op when the `SessionManager` is not managed
/// (a headless projection unit-test app).
pub(crate) async fn fold_agent_hosted_reconnecting<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    error: Option<&str>,
) {
    let Some(manager) = app_handle.try_state::<SessionManager>() else {
        return;
    };
    for hosted in manager.agent_hosted_sessions(agent_id).await {
        fold_agent_transport_reconnecting(app_handle, &hosted.tab_id, error);
    }
}

/// The agent's hosted-session identity tuples, or an empty vec when the
/// `SessionManager` is not managed (a headless projection unit-test app). Fetched
/// once per reconnect so the caller can both gate the `connection.list` round-trip
/// on there being a hosted tab to resolve and reuse the set for the region resolve
/// (#2556).
async fn hosted_sessions_for_agent<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
) -> Vec<AgentHostedSession> {
    match app_handle.try_state::<SessionManager>() {
        Some(manager) => manager.agent_hosted_sessions(agent_id).await,
        None => Vec::new(),
    }
}

/// Resolve each hosted session's region entry after a successful in-task reconnect:
/// fold `Connected` for every session the agent recovered **in place** (its
/// `remote_session_id` is in `live_ids`) — the survived-recovery half of #2556,
/// folded at the backend source rather than the frontend `TerminalView` resolver.
///
/// The gone-session (not recovered) and fully-failed (`agent → disconnected`)
/// resolves remain frontend-owned for now: they set local terminal view-state
/// (`terminalExitedTabs` / view-mode) that has no server-side home until the
/// stateless-UI view-state migration (#2139). The frontend's gone-case resolver
/// gates on the region still reading `reconnecting`, which this deliberately does
/// not touch, so leaving those tabs reconnecting keeps that gate intact.
pub(crate) fn resolve_agent_hosted_recovered<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    live_ids: &std::collections::HashSet<String>,
) {
    for h in hosted {
        if live_ids.contains(&h.remote_session_id) {
            fold_agent_session_recovered(app_handle, &h.tab_id);
        }
    }
}

/// Drop output/monitoring senders whose session id is not in `live_ids`.
///
/// Used after a successful reconnect to reconcile the I/O task's per-session
/// sender maps against the sessions the agent actually recovered, so senders
/// for sessions that did not survive the reconnect are released (G7, #1239).
fn reconcile_output_senders(
    session_outputs: &mut HashMap<String, OutputSender>,
    monitoring_outputs: &mut HashMap<String, MonitoringSender>,
    live_ids: &std::collections::HashSet<String>,
) {
    session_outputs.retain(|id, _| live_ids.contains(id));
    monitoring_outputs.retain(|id, _| live_ids.contains(id));
}

/// List the session ids the agent currently reports over the (freshly
/// reconnected) channel, for post-reconnect reconciliation (G7, #1239).
///
/// Sends `connection.list` and reads until the matching response arrives,
/// skipping any interleaved notifications. Returns `None` on any I/O or parse
/// failure so the caller leaves the sender maps untouched rather than dropping
/// senders it could not confirm as dead.
async fn list_recovered_session_ids(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
) -> Option<std::collections::HashSet<String>> {
    *request_id += 1;
    let req_id = *request_id;
    let line = serialize_request(req_id, "connection.list", serde_json::json!({})).ok()?;
    channel.data(line.as_bytes()).await.ok()?;

    const MAX_SKIPPED: u32 = 1000;
    let mut buf = String::new();
    let mut skipped: u32 = 0;
    loop {
        let resp = read_handshake_line(channel, agent_id, &mut buf).await?;
        if resp.is_empty() {
            continue;
        }
        match jsonrpc::parse_message(&resp) {
            Ok(jsonrpc::JsonRpcMessage::Response { id, result }) if id == req_id => {
                let ids = result["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["session_id"].as_str().map(|s| s.to_string()))
                    .collect();
                return Some(ids);
            }
            Ok(jsonrpc::JsonRpcMessage::Error { id, .. }) if id == req_id => return None,
            _ => {
                skipped += 1;
                if skipped > MAX_SKIPPED {
                    warn!(
                        "Agent {}: too many messages before connection.list response",
                        agent_id
                    );
                    return None;
                }
            }
        }
    }
}

/// Dispatch a single agent notification to every place that consumes it.
///
/// Surfaces the agent-level update notices (`agent.update_available`,
/// `agent.update_pending`) to the frontend, then routes session/monitoring
/// notifications to their registered channels via [`handle_notification`].
///
/// Shared by the live I/O loop and the pre-init replay path (#1660): a
/// notification that arrived during the `initialize` handshake is buffered and
/// replayed through this same function once init completes, so on-attach
/// notifications are no longer silently dropped.
fn dispatch_agent_notification(
    app_handle: &AppHandle,
    agent_id: &str,
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    monitoring_outputs: &HashMap<String, MonitoringSender>,
    b64: &base64::engine::GeneralPurpose,
) {
    if method == "agent.update_available" {
        emit_agent_update_available(app_handle, agent_id, params);
    }
    if method == "agent.update_pending" {
        emit_remote_agent_update_pending(app_handle, agent_id, params);
    }
    handle_notification(method, params, session_outputs, monitoring_outputs, b64);
}

/// Route an `agent.forward.*` ssh-agent relay notification (#1727) to the
/// desktop relay handler, returning `true` if it was one (so the caller skips
/// the normal session/monitoring dispatch).
fn handle_agent_forward_notification(
    agent_forward: &DesktopAgentForward,
    command_tx: &UnboundedSender<AgentIoCommand>,
    method: &str,
    params: &Value,
    b64: &base64::engine::GeneralPurpose,
) -> bool {
    match method {
        "agent.forward.open" => {
            if let Some(stream_id) = params["stream_id"].as_str() {
                agent_forward.on_open(stream_id.to_string(), command_tx.clone());
            }
            true
        }
        "agent.forward.data" => {
            if let (Some(stream_id), Some(data_b64)) =
                (params["stream_id"].as_str(), params["data"].as_str())
            {
                if let Ok(data) = b64.decode(data_b64) {
                    agent_forward.on_data(stream_id, data);
                }
            }
            true
        }
        "agent.forward.close" => {
            if let Some(stream_id) = params["stream_id"].as_str() {
                agent_forward.on_close(stream_id);
            }
            true
        }
        _ => false,
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
#[allow(clippy::type_complexity)]
async fn reconnect_agent(
    config: &RemoteAgentConfig,
    agent_settings: &AgentSettings,
    request_id: &mut u64,
    alive: &Arc<AtomicBool>,
) -> Result<
    (
        SshSession,
        russh::Channel<russh::client::Msg>,
        Vec<(String, Value)>,
    ),
    String,
> {
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

        // 4. Read the initialize response, skipping any notifications the agent
        // emits before answering (e.g. output from a session it recovered on
        // startup). Loop until the message whose id matches our request arrives.
        const MAX_PRE_INIT_MESSAGES: u32 = 1000;
        let mut line_buf = String::new();
        let mut skipped: u32 = 0;
        let mut success = false;
        // Notifications the agent emits before answering `initialize` on this
        // reconnect — buffered for replay after the channel is handed back, so
        // an on-attach notice is not dropped (#1660). Reset per attempt: a
        // failed attempt's buffer belongs to a channel that is being discarded.
        let mut buffered: Vec<(String, Value)> = Vec::new();
        loop {
            let resp_line =
                match read_handshake_line(&mut channel, &config.host, &mut line_buf).await {
                    Some(line) => line,
                    None => {
                        warn!(
                            "Reconnect attempt {} failed (channel closed during init read)",
                            attempt + 1
                        );
                        break;
                    }
                };

            let msg = match jsonrpc::parse_message(&resp_line) {
                Ok(m) => m,
                Err(e) => {
                    warn!(
                        "Reconnect attempt {} failed (parse init response): {}",
                        attempt + 1,
                        e
                    );
                    break;
                }
            };

            match jsonrpc::classify_handshake_message(msg, *request_id) {
                jsonrpc::HandshakeOutcome::Response(_) => {
                    success = true;
                    break;
                }
                jsonrpc::HandshakeOutcome::Rejected(message) => {
                    warn!(
                        "Reconnect attempt {} failed (init rejected): {}",
                        attempt + 1,
                        message
                    );
                    break;
                }
                jsonrpc::HandshakeOutcome::Buffer { method, params } => {
                    skipped += 1;
                    if skipped > MAX_PRE_INIT_MESSAGES {
                        warn!(
                            "Reconnect attempt {} failed (too many messages before init response)",
                            attempt + 1
                        );
                        break;
                    }
                    buffered.push((method, params));
                    continue;
                }
                jsonrpc::HandshakeOutcome::Skip => {
                    skipped += 1;
                    if skipped > MAX_PRE_INIT_MESSAGES {
                        warn!(
                            "Reconnect attempt {} failed (too many messages before init response)",
                            attempt + 1
                        );
                        break;
                    }
                    continue;
                }
            }
        }

        if success {
            return Ok((session, channel, buffered));
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

    /// Verify the desktop deserializes the agent's `connection.list` entry
    /// (snake_case, with optional `definition_id`). Without correct serde
    /// settings the entry would parse as empty and the Active Sessions list
    /// would be silently dropped.
    #[test]
    fn parse_agent_session_info_from_snake_case_with_definition_id() {
        let entry = json!({
            "session_id": "abc-123",
            "title": "Build",
            "type": "shell",
            "status": "running",
            "created_at": "2026-02-14T10:30:00Z",
            "last_activity": "2026-02-14T10:30:00Z",
            "attached": false,
            "definition_id": "def-42",
        });
        let info: AgentSessionInfo = serde_json::from_value(entry).unwrap();
        assert_eq!(info.session_id, "abc-123");
        assert_eq!(info.session_type, "shell");
        assert_eq!(info.definition_id.as_deref(), Some("def-42"));
    }

    #[test]
    fn agent_session_info_serializes_to_camel_case_for_frontend() {
        let info = AgentSessionInfo {
            session_id: "abc".to_string(),
            title: "T".to_string(),
            session_type: "shell".to_string(),
            status: "running".to_string(),
            attached: false,
            definition_id: Some("def-1".to_string()),
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["sessionId"], "abc");
        assert_eq!(v["type"], "shell");
        assert_eq!(v["definitionId"], "def-1");
        assert!(v.get("session_id").is_none());
        assert!(v.get("definition_id").is_none());
    }

    #[test]
    fn parse_agent_session_info_without_definition_id() {
        let entry = json!({
            "session_id": "abc-123",
            "title": "Ad hoc",
            "type": "shell",
            "status": "running",
            "created_at": "2026-02-14T10:30:00Z",
            "last_activity": "2026-02-14T10:30:00Z",
            "attached": false,
        });
        let info: AgentSessionInfo = serde_json::from_value(entry).unwrap();
        assert!(info.definition_id.is_none());
    }

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

    /// Regression test for #1660: a notification the agent emits *before* it
    /// answers `initialize` must be buffered during the handshake and replayed
    /// afterwards, not silently dropped. This reproduces the handshake read
    /// loop's classification over a message stream (notification, then the init
    /// response) and confirms the buffered notification still reaches the
    /// desktop handlers. Before the fix, `classify_handshake_message` returned
    /// `Skip` for the notification and the pre-init notice was discarded.
    #[test]
    fn preinit_notification_is_buffered_and_replayed() {
        let request_id: u64 = 1;

        // The agent emits a session output notification, then answers initialize.
        let payload = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let lines = [
            format!(
                r#"{{"jsonrpc":"2.0","method":"connection.output","params":{{"session_id":"sess-1","data":"{payload}"}}}}"#
            ),
            r#"{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}"#.to_string(),
        ];

        // Drive the same classification the handshake loop uses, collecting
        // pre-init notifications until the initialize response arrives.
        let mut buffered: Vec<(String, Value)> = Vec::new();
        let mut saw_response = false;
        for line in &lines {
            let msg = jsonrpc::parse_message(line).expect("valid message");
            match jsonrpc::classify_handshake_message(msg, request_id) {
                jsonrpc::HandshakeOutcome::Response(_) => {
                    saw_response = true;
                    break;
                }
                jsonrpc::HandshakeOutcome::Buffer { method, params } => {
                    buffered.push((method, params));
                }
                jsonrpc::HandshakeOutcome::Rejected(m) => panic!("unexpected rejection: {m}"),
                jsonrpc::HandshakeOutcome::Skip => panic!("notification should be buffered"),
            }
        }

        assert!(saw_response, "should have seen the initialize response");
        assert_eq!(buffered.len(), 1, "pre-init notification must be retained");
        assert_eq!(buffered[0].0, "connection.output");

        // Replaying the buffered notification after init reaches the registered
        // session output channel — the same dispatch the live loop performs.
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
        let monitoring_outputs: HashMap<String, MonitoringSender> = HashMap::new();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(4);
        session_outputs.insert("sess-1".to_string(), tx);

        for (method, params) in &buffered {
            handle_notification(method, params, &session_outputs, &monitoring_outputs, &b64);
        }

        let data = rx.try_recv().expect("buffered output should be delivered");
        assert_eq!(data, b"hello".to_vec());
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
            ..Default::default()
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

    // ── Resource-hygiene helpers (#1239: G6 reap / prune, G7 reconcile) ──

    /// Build a placeholder [`AgentConnection`] for map-manipulation tests.
    ///
    /// The command channel receiver is dropped immediately — none of the
    /// hygiene helpers send over it — so only `alive` is meaningful here.
    fn make_agent_connection(alive: bool) -> AgentConnection {
        let (command_tx, _command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();
        AgentConnection {
            command_tx,
            alive: Arc::new(AtomicBool::new(alive)),
            capabilities: AgentCapabilities {
                connection_types: vec![],
                max_sessions: 0,
                available_shells: vec![],
                available_serial_ports: vec![],
                docker_available: false,
                available_docker_images: vec![],
                monitoring_supported: false,
                agent_version: String::new(),
            },
            agent_version: String::new(),
            protocol_version: String::new(),
            client_id: String::new(),
        }
    }

    /// G6: an exhausted reconnect self-reaps its own entry from the manager map
    /// (via a weak reference) instead of leaving a zombie behind for lazy
    /// eviction on the next `connect_agent`.
    #[test]
    fn reap_agent_removes_its_own_map_entry() {
        let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut guard = agents.lock().unwrap();
            guard.insert("agent-1".to_string(), make_agent_connection(false));
            guard.insert("agent-2".to_string(), make_agent_connection(true));
        }

        let weak = Arc::downgrade(&agents);
        reap_agent(&weak, "agent-1");

        let guard = agents.lock().unwrap();
        assert!(
            !guard.contains_key("agent-1"),
            "reaped agent must be removed from the map"
        );
        assert!(
            guard.contains_key("agent-2"),
            "unrelated agents must be left untouched"
        );
    }

    /// A dead weak reference (manager already dropped) must not panic.
    #[test]
    fn reap_agent_tolerates_dropped_manager() {
        let weak = {
            let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
            Arc::downgrade(&agents)
        };
        // Should be a no-op, not a panic.
        reap_agent(&weak, "agent-1");
    }

    /// Prune sweeps every `alive == false` entry and returns the removed ids,
    /// while surviving (alive) entries remain.
    #[test]
    fn prune_dead_agents_removes_only_dead_entries() {
        let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut guard = agents.lock().unwrap();
            guard.insert("dead-1".to_string(), make_agent_connection(false));
            guard.insert("alive-1".to_string(), make_agent_connection(true));
            guard.insert("dead-2".to_string(), make_agent_connection(false));
        }

        let mut removed = prune_dead_agents_from_map(&agents);
        removed.sort();
        assert_eq!(removed, vec!["dead-1".to_string(), "dead-2".to_string()]);

        let guard = agents.lock().unwrap();
        assert_eq!(guard.len(), 1);
        assert!(guard.contains_key("alive-1"));
    }

    /// G7: after a successful reconnect, output/monitoring senders keyed by
    /// session ids that did *not* recover are dropped, while senders for
    /// surviving session ids remain.
    #[test]
    fn reconcile_output_senders_drops_non_recovered_sessions() {
        let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
        let mut monitoring_outputs: HashMap<String, MonitoringSender> = HashMap::new();

        let (out_survivor, _r1) = std::sync::mpsc::sync_channel(1);
        let (out_gone, _r2) = std::sync::mpsc::sync_channel(1);
        session_outputs.insert("survivor".to_string(), out_survivor);
        session_outputs.insert("gone".to_string(), out_gone);

        let (mon_survivor, _r3) = tokio::sync::mpsc::channel(1);
        let (mon_gone, _r4) = tokio::sync::mpsc::channel(1);
        monitoring_outputs.insert("survivor".to_string(), mon_survivor);
        monitoring_outputs.insert("gone".to_string(), mon_gone);

        let mut live_ids = std::collections::HashSet::new();
        live_ids.insert("survivor".to_string());

        reconcile_output_senders(&mut session_outputs, &mut monitoring_outputs, &live_ids);

        assert!(session_outputs.contains_key("survivor"));
        assert!(!session_outputs.contains_key("gone"));
        assert!(monitoring_outputs.contains_key("survivor"));
        assert!(!monitoring_outputs.contains_key("gone"));
    }

    // ── Cancellable connect (G1, #1235) ──────────────────────────────────

    /// A per-agent cancellation token registered before a connect can be fired
    /// by `cancel_connect` and reports whether an in-flight connect was found.
    #[test]
    fn cancel_connect_fires_registered_token() {
        let registry: ConnectingRegistry = Arc::new(Mutex::new(HashMap::new()));
        let token = CancellationToken::new();
        register_connecting_token(&registry, "agent-1", token.clone());

        assert!(!token.is_cancelled());
        // A matching agent id fires its token and reports success.
        assert!(cancel_connect_token(&registry, "agent-1"));
        assert!(token.is_cancelled());

        // A non-matching id is a no-op.
        assert!(!cancel_connect_token(&registry, "agent-2"));
    }

    /// The RAII guard clears the registry entry when the connect finishes, so a
    /// later cancel targets only live connects (no stale token left behind).
    #[test]
    fn connecting_guard_clears_registry_entry() {
        let registry: ConnectingRegistry = Arc::new(Mutex::new(HashMap::new()));
        {
            let token = CancellationToken::new();
            register_connecting_token(&registry, "agent-1", token);
            let _guard = ConnectingGuard {
                map: registry.clone(),
                id: "agent-1".to_string(),
            };
            assert!(registry.lock().unwrap().contains_key("agent-1"));
        }
        // Guard dropped → entry gone → cancel finds nothing.
        assert!(!cancel_connect_token(&registry, "agent-1"));
    }

    /// A token fired before the connect body begins aborts the blocking
    /// connect+handshake promptly instead of waiting it out — the core G1
    /// behaviour. Mirrors the `connect_and_authenticate` + initialize handshake
    /// being wrapped in `tokio::select!` against the token.
    #[tokio::test]
    async fn run_cancellable_aborts_when_token_already_fired() {
        let token = CancellationToken::new();
        token.cancel();

        // The connect body would sleep for 30s; a working cancel returns at once.
        let result: Result<(), TerminalError> = run_connect_cancellable(&token, async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            Ok(())
        })
        .await;

        assert!(result.is_err(), "a cancelled connect must return an error");
        let err = result.err().unwrap().to_string();
        assert!(
            err.to_lowercase().contains("cancel"),
            "expected a cancellation error, got: {err}"
        );
    }

    /// Firing the token while the connect body is in flight aborts it promptly.
    #[tokio::test]
    async fn run_cancellable_aborts_in_flight_connect() {
        let token = CancellationToken::new();
        let token_clone = token.clone();

        let join = tokio::spawn(async move {
            run_connect_cancellable(&token_clone, async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok::<(), TerminalError>(())
            })
            .await
        });

        // Give the body a moment to start, then cancel.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        token.cancel();

        let result = join.await.expect("join");
        assert!(result.is_err(), "an in-flight cancel must return an error");
    }

    /// Without a cancel the body runs to completion and its value is returned.
    #[tokio::test]
    async fn run_cancellable_returns_body_result_when_not_cancelled() {
        let token = CancellationToken::new();
        let result: Result<u32, TerminalError> =
            run_connect_cancellable(&token, async { Ok(42) }).await;
        assert_eq!(result.unwrap(), 42);
    }
}

// ── Real-russh agent reconnect over a local sshd (#2476 / #2480) ───────────────
//
// The maintainer's live bug: an agent is connected with a live session, its SSH
// transport drops, the sshd returns, and — even though the transport is back —
// the tab stays stuck "Reconnecting" (#2476). Every *other* layer has now been
// eliminated with automated coverage: the frontend re-attach chain + backend
// redrive recover in isolation (#2488), and the agent side (fresh-agent
// `connection.create` + the ADR-11 registry-daemon handshake after reconnect)
// does not stall — proven headless over the agent's own transport (#2489).
//
// The one layer no test exercised is the desktop backend's **real russh
// transport reconnect**: does [`reconnect_agent`] actually re-establish the
// russh session after a real sshd returns, and can a *fresh* `connection.create`
// then be driven over it so the session is usable again — the exact recovery
// that failed live? This test closes that gap by standing up a **real local
// sshd** with the real `termihub-agent` binary reachable (the test-owned analog
// of `scripts/dev.sh`'s dev agent and the Python `LocalAgentSshd`, #2481),
// driving `reconnect_agent` against it, killing the sshd for a genuine
// server-side transport drop, restoring it, and asserting the reconnect
// re-establishes the transport and a fresh create yields a usable session —
// all headless, no GUI/webview.
//
// WHAT THIS FOUND (#2476): `reconnect_agent`'s russh layer is correct — it
// re-establishes the transport and drives a fresh create fine. But the drop
// (kill the sshd tree) also kills the *setsid'd session daemon* (#995), leaving
// its unix socket file behind. The fresh agent's startup `recover_sessions` then
// passed its `endpoint_alive` gate (file exists) and connected via the 30s
// **spawn-path** timeout, which retries `ConnectionRefused` for the full 30s on
// the dead-but-lingering socket — **before** the stdio loop answers `initialize`.
// So `reconnect_agent` sat blocked ~31s per dead session: "transport restored
// but stuck Reconnecting". The maintainer's own psutil-recursive-kill harness
// (#2481) destroys the setsid'd daemon the same way, so it hits this too. Fixed
// by giving recovery a short connect timeout (`DaemonClient::connect_for_recovery`)
// so a dead-but-lingering socket fast-fails instead of stalling startup. See the
// hermetic transport-layer regression in `agent/src/daemon/transport.rs`.
//
// Registry isolation (#2489): the agent is pointed at a per-test
// `TERMIHUB_REGISTRY_ENDPOINT` and `XDG_CONFIG_HOME` inside its own temp dir via
// sshd `SetEnv`, so it never spawns/joins the developer's real (shared) ADR-11
// registry daemon or a parallel checkout's. The daemon self-exits after its idle
// timeout, so nothing is leaked past that.
#[cfg(all(test, unix))]
mod russh_reconnect_tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    /// Overall ceiling for the fresh-create + echo round-trip after reconnect.
    /// Generous so a slow CI shell cold-start never flakes it.
    const RECOVERY_CEILING: Duration = Duration::from_secs(45);

    /// Tight ceiling on the `reconnect_agent` call itself — the regression guard
    /// for the bug this test found and fixed (#2476).
    ///
    /// Before the fix, killing the sshd tree also killed the setsid'd session
    /// daemon (leaving its socket file), so the fresh agent's startup
    /// `recover_sessions` paid the full 30s spawn-path connect timeout on the
    /// dead-but-lingering socket **before** answering `initialize` — so
    /// `reconnect_agent` sat blocked ~31s (30s recovery + ~1s backoff), the
    /// "transport restored but stuck Reconnecting" symptom. With recovery now
    /// fast-failing the dead socket, reconnect settles in a few seconds. This
    /// bound sits comfortably above that (SSH connect + agent cold-start +
    /// backoff, with CI jitter) yet far below the pre-fix ~31s, so a regression
    /// to the long recovery path trips it.
    const RECONNECT_SETTLE_CEILING: Duration = Duration::from_secs(20);

    /// Locate a usable `sshd` binary, or `None` to skip.
    fn find_sshd() -> Option<PathBuf> {
        for cand in ["/usr/sbin/sshd", "/sbin/sshd"] {
            let p = Path::new(cand);
            if p.is_file() {
                return Some(p.to_path_buf());
            }
        }
        // PATH fallback.
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|d| d.join("sshd"))
                .find(|p| p.is_file())
        })
    }

    /// Locate the built `termihub-agent` binary, or `None` to skip.
    ///
    /// `termihub-agent` is a *separate* workspace crate, so `cargo test` for this
    /// crate does not build it and there is no `CARGO_BIN_EXE_termihub-agent` for
    /// us (that env exists only for the agent crate's own integration tests).
    /// Resolve it relative to the test binary (`target/<profile>/deps/<test>` →
    /// `target/<profile>/termihub-agent`), with an explicit env override for
    /// non-standard layouts. Skip gracefully when absent (build it first with
    /// `cargo build -p termihub-agent`).
    fn find_agent_binary() -> Option<PathBuf> {
        if let Some(p) = std::env::var_os("TERMIHUB_TEST_AGENT_BIN") {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
        }
        let exe = std::env::current_exe().ok()?;
        // exe = target/<profile>/deps/<test-bin>; profile dir is two up.
        let profile_dir = exe.parent()?.parent()?;
        [
            profile_dir.join("termihub-agent"),
            exe.parent()?.join("termihub-agent"),
        ]
        .into_iter()
        .find(|cand| cand.is_file())
    }

    /// Grab a currently-free loopback TCP port (best-effort; the caller retries a
    /// bind race by respawning on a new port).
    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .expect("bind ephemeral")
            .local_addr()
            .expect("local_addr")
            .port()
    }

    fn is_listening(port: u16) -> bool {
        std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(500),
        )
        .is_ok()
    }

    /// SIGKILL the whole process subtree rooted at `root` (master sshd + its
    /// per-connection privilege-separation children + the shell + the agent).
    ///
    /// Killing only the `-D` master leaves established connections (and the agent
    /// they spawned) alive, so it would *not* model a transport drop. We walk the
    /// live process table by ppid — the dependency-free analog of the Python
    /// harness's `psutil` recursive kill — and kill every descendant. Only
    /// processes descended from our own sshd are touched (never a name pattern).
    fn kill_subtree(root: u32) {
        // pid -> ppid for every live process.
        let out = match Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid="])
            .output()
        {
            Ok(o) => o,
            Err(_) => return,
        };
        let mut children: std::collections::HashMap<u32, Vec<u32>> =
            std::collections::HashMap::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut it = line.split_whitespace();
            if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
                if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                    children.entry(ppid).or_default().push(pid);
                }
            }
        }
        // DFS the subtree.
        let mut victims = Vec::new();
        let mut stack = vec![root];
        while let Some(pid) = stack.pop() {
            victims.push(pid);
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
        if victims.is_empty() {
            return;
        }
        // Kill leaves first so a parent cannot re-fork a replacement mid-teardown.
        victims.reverse();
        let mut cmd = Command::new("kill");
        cmd.arg("-KILL");
        for pid in &victims {
            cmd.arg(pid.to_string());
        }
        let _ = cmd.stderr(Stdio::null()).status();
    }

    /// The normalised command name of a pid, reduced to what the sshd-family match
    /// keys on. Mirrors `agent-reconnect-transport.sh`'s `comm_of` (#2550): on
    /// macOS 26 / OpenSSH 10 `ps -o comm=` is the rewritten process TITLE whose
    /// first token carries a trailing colon (`sshd:`, `sshd-session:`), so take the
    /// first token, basename it, and strip a trailing colon.
    fn comm_of(pid: u32) -> String {
        let out = match Command::new("ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .output()
        {
            Ok(o) => o,
            Err(_) => return String::new(),
        };
        let raw = String::from_utf8_lossy(&out.stdout);
        let first = raw.split_whitespace().next().unwrap_or("");
        let base = first.rsplit('/').next().unwrap_or(first);
        base.strip_suffix(':').unwrap_or(base).to_string()
    }

    /// Whether a normalised comm names an sshd-family transport process — the
    /// master listener (`sshd`) or a per-connection handler (`sshd-session`,
    /// `sshd-sess`, `sshd-auth`, …). Matches the shell harness's `is_sshd_family`.
    fn is_sshd_family(comm: &str) -> bool {
        comm == "sshd" || comm.starts_with("sshd-")
    }

    /// SIGKILL only the **sshd-family** processes in the subtree rooted at `root`
    /// (the master listener + its per-connection handlers), sparing the
    /// `termihub-agent --stdio` the handler exec'd and — crucially — the setsid'd
    /// session **daemon** that agent spawned.
    ///
    /// This is the automated analog of the *fixed* `agent-reconnect-transport.sh
    /// drop` (#2550): killing the sshd handler closes the SSH channel, so the
    /// `--stdio` agent hits EOF and exits on its own, while the reparented daemon
    /// (a different session/pgroup) keeps its shell + running process alive for the
    /// recovery. `kill_subtree` above kills the daemon too (it is still a ppid-child
    /// at kill time, #2508/#995), so it can only test *fresh-create* recovery —
    /// this daemon-sparing variant is what lets a test assert **live-session
    /// continuity** (#2512). Scoped to our own sshd's subtree, comm-matched, never a
    /// name-pattern kill.
    fn kill_sshd_only(root: u32) {
        let out = match Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid="])
            .output()
        {
            Ok(o) => o,
            Err(_) => return,
        };
        let mut children: std::collections::HashMap<u32, Vec<u32>> =
            std::collections::HashMap::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut it = line.split_whitespace();
            if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
                if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                    children.entry(ppid).or_default().push(pid);
                }
            }
        }
        // Walk the whole subtree, but select ONLY sshd-family pids to kill.
        let mut victims = Vec::new();
        let mut stack = vec![root];
        while let Some(pid) = stack.pop() {
            if is_sshd_family(&comm_of(pid)) {
                victims.push(pid);
            }
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
        if victims.is_empty() {
            return;
        }
        // Kill leaves first so the master cannot re-fork a handler mid-teardown.
        victims.reverse();
        let mut cmd = Command::new("kill");
        cmd.arg("-KILL");
        for pid in &victims {
            cmd.arg(pid.to_string());
        }
        let _ = cmd.stderr(Stdio::null()).status();
    }

    /// A killable/restartable loopback `sshd` with the real agent binary
    /// reachable over key auth — the Rust analog of the Python `LocalAgentSshd`
    /// (#2481). `start`/`stop` own the whole process tree so a `stop` severs an
    /// established agent connection at once (the server-side transport drop).
    struct LocalAgentSshd {
        sshd: PathBuf,
        dir: PathBuf,
        config: PathBuf,
        client_key: PathBuf,
        port: u16,
        username: String,
        agent_bin: PathBuf,
        child: Option<Child>,
    }

    impl LocalAgentSshd {
        fn new(sshd: PathBuf, agent_bin: PathBuf) -> std::io::Result<Self> {
            let dir = std::env::temp_dir().join(format!(
                "termihub-russh-reconnect-{}-{}",
                std::process::id(),
                free_port()
            ));
            std::fs::create_dir_all(&dir)?;
            std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;

            let host_key = dir.join("host_key");
            let client_key = dir.join("client_key");
            for key in [&host_key, &client_key] {
                let status = Command::new("ssh-keygen")
                    .args(["-t", "ed25519", "-N", "", "-q", "-f"])
                    .arg(key)
                    .status()?;
                if !status.success() {
                    return Err(std::io::Error::other("ssh-keygen failed"));
                }
                std::fs::set_permissions(key, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            }

            let username = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
            let registry_endpoint = dir.join("registry.sock");
            let xdg = dir.join("xdg");
            std::fs::create_dir_all(&xdg)?;

            let config = dir.join("sshd_config");
            // Loopback-only key auth, no PAM/strict-modes so it runs unprivileged
            // (mirrors scripts/dev.sh and the Python harness). `SetEnv` forces the
            // per-test registry endpoint + config home into the agent's env so it
            // never touches shared ADR-11 registry state (#2489).
            let config_body = [
                format!("Port {}", 0), // placeholder, rewritten per start
                "ListenAddress 127.0.0.1".to_string(),
                format!("HostKey {}", host_key.display()),
                format!("AuthorizedKeysFile {}.pub", client_key.display()),
                "UsePAM no".to_string(),
                "PasswordAuthentication no".to_string(),
                "PubkeyAuthentication yes".to_string(),
                "StrictModes no".to_string(),
                "LogLevel ERROR".to_string(),
                format!(
                    "SetEnv TERMIHUB_REGISTRY_ENDPOINT={} XDG_CONFIG_HOME={}",
                    registry_endpoint.display(),
                    xdg.display()
                ),
                String::new(),
            ]
            .join("\n");
            // The port is fixed for the lifetime of the instance (drop/restore
            // must reuse it), so pick it now and write the final config.
            let port = free_port();
            let config_body = config_body.replacen("Port 0", &format!("Port {port}"), 1);
            std::fs::write(&config, config_body)?;

            Ok(Self {
                sshd,
                dir,
                config,
                client_key,
                port,
                username,
                agent_bin,
                child: None,
            })
        }

        /// Launch sshd (foreground `-D` so we own the tree) and wait until it
        /// accepts a TCP connection.
        fn start(&mut self) {
            assert!(self.child.is_none(), "already running");
            let child = Command::new(&self.sshd)
                .arg("-D")
                .arg("-f")
                .arg(&self.config)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn sshd");
            self.child = Some(child);

            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                if is_listening(self.port) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!("sshd did not listen on 127.0.0.1:{} in time", self.port);
        }

        /// Kill the sshd tree (SIGKILL) — an abrupt server-side drop that severs
        /// the established agent connection, then wait for the port to close.
        fn stop(&mut self) {
            if let Some(mut child) = self.child.take() {
                kill_subtree(child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if !is_listening(self.port) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        /// Sever the transport the way the fixed `drop` harness does: kill only the
        /// sshd master + handlers, **sparing the setsid'd session daemon** so a live
        /// session survives the outage (the #2512 continuity path). The established
        /// russh channel still goes down (the handler is gone), but the daemon keeps
        /// the shell + its running process alive for the reconnect to recover.
        ///
        /// Reaps our master `Child` handle (it is now dead) so no zombie lingers,
        /// and waits for the port to close so `start()` can rebind it.
        fn stop_sparing_daemon(&mut self) {
            if let Some(mut child) = self.child.take() {
                kill_sshd_only(child.id());
                let _ = child.wait();
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if !is_listening(self.port) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        fn agent_config(&self) -> RemoteAgentConfig {
            RemoteAgentConfig {
                host: "127.0.0.1".to_string(),
                port: self.port,
                username: self.username.clone(),
                auth_method: "key".to_string(),
                password: None,
                key_path: Some(self.client_key.to_string_lossy().into_owned()),
                save_password: None,
                agent_path: Some(self.agent_bin.to_string_lossy().into_owned()),
                external_connection_files: vec![],
                ..Default::default()
            }
        }
    }

    impl Drop for LocalAgentSshd {
        fn drop(&mut self) {
            self.stop();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Trust every host key for the duration of the test (process-wide, set-once).
    ///
    /// The desktop SSH path is strict known_hosts-only by default; a throwaway
    /// sshd on an unknown host would otherwise block the connect pre-auth. This
    /// mirrors the sftp integration test's `trust_fixture_host_keys()` and, unlike
    /// seeding `~/.ssh/known_hosts`, mutates no shared on-disk state.
    fn trust_all_host_keys() {
        use termihub_core::backends::ssh::host_key::{
            set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
        };
        struct TrustAll;
        #[async_trait::async_trait]
        impl HostKeyVerifier for TrustAll {
            async fn verify(&self, _info: &HostKeyInfo) -> bool {
                true
            }
        }
        let _ = set_host_key_verifier(Arc::new(TrustAll));
    }

    /// Drive a single JSON-RPC request over the raw agent channel and return its
    /// matching response `result` (ignoring interleaved notifications). This is
    /// the redrive's `connection.create`/`attach` path exercised over the real
    /// re-established transport.
    async fn channel_rpc(
        channel: &mut russh::Channel<russh::client::Msg>,
        request_id: &mut u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        *request_id += 1;
        let id = *request_id;
        let line = serialize_request(id, method, params)?;
        channel
            .data(line.as_bytes())
            .await
            .map_err(|e| format!("write {method}: {e}"))?;
        let mut buf = String::new();
        loop {
            let resp = read_handshake_line(channel, "test-agent", &mut buf)
                .await
                .ok_or_else(|| format!("channel closed before {method} response"))?;
            if resp.is_empty() {
                continue;
            }
            match jsonrpc::parse_message(&resp) {
                Ok(jsonrpc::JsonRpcMessage::Response { id: rid, result }) if rid == id => {
                    return Ok(result)
                }
                Ok(jsonrpc::JsonRpcMessage::Error {
                    id: rid, message, ..
                }) if rid == id => return Err(message),
                _ => continue,
            }
        }
    }

    /// Read `connection.output` notifications off the channel until one decodes to
    /// text containing `needle`, or the deadline passes. Proves the session is
    /// genuinely usable (input → PTY echo → notification), not merely created.
    async fn wait_for_output(
        channel: &mut russh::Channel<russh::client::Msg>,
        needle: &str,
        deadline: Instant,
    ) -> bool {
        let mut buf = String::new();
        while Instant::now() < deadline {
            let read = tokio::time::timeout(
                Duration::from_millis(500),
                read_handshake_line(channel, "test-agent", &mut buf),
            )
            .await;
            match read {
                Ok(Some(line)) => {
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                        jsonrpc::parse_message(&line)
                    {
                        if method == "connection.output" {
                            if let Some(data) = params["data"].as_str() {
                                if let Ok(bytes) = B64.decode(data) {
                                    if String::from_utf8_lossy(&bytes).contains(needle) {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(None) => return false, // channel closed
                Err(_) => continue,       // read timeout — re-check the deadline
            }
        }
        false
    }

    /// Create a shell session over `channel`, attach, echo a unique marker, and
    /// assert the marker comes back — i.e. the session is usable end to end.
    async fn create_and_verify_usable(
        channel: &mut russh::Channel<russh::client::Msg>,
        request_id: &mut u64,
        marker: &str,
        deadline: Instant,
    ) -> String {
        let created = channel_rpc(
            channel,
            request_id,
            "connection.create",
            serde_json::json!({ "type": "shell", "title": marker }),
        )
        .await
        .unwrap_or_else(|e| panic!("connection.create failed for {marker}: {e}"));
        let sid = created["session_id"]
            .as_str()
            .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
            .to_string();

        channel_rpc(
            channel,
            request_id,
            "connection.attach",
            serde_json::json!({ "session_id": sid }),
        )
        .await
        .unwrap_or_else(|e| panic!("connection.attach failed for {marker}: {e}"));

        // `connection.write` is fire-and-forget (no response); send it directly.
        *request_id += 1;
        let encoded = B64.encode(format!("echo {marker}\n").as_bytes());
        let write_line = serialize_request(
            *request_id,
            "connection.write",
            serde_json::json!({ "session_id": sid, "data": encoded }),
        )
        .expect("serialize write");
        channel
            .data(write_line.as_bytes())
            .await
            .expect("write session input");

        assert!(
            wait_for_output(channel, marker, deadline).await,
            "session '{marker}' never echoed its marker — created but unusable \
             (the live 'stuck Reconnecting' symptom)"
        );
        sid
    }

    /// The definitive last-layer test: after a real russh transport drop and the
    /// sshd's return, [`reconnect_agent`] must re-establish the real transport and
    /// a fresh `connection.create` over it must yield a usable session — the exact
    /// recovery that failed live (#2476 / #2480).
    ///
    /// A stall at this layer FAILS the test (bounded by [`RECOVERY_CEILING`])
    /// rather than hanging a display-backed run. A pass proves the desktop
    /// reconnect *logic* is correct headlessly at every layer, pinning the live
    /// failure on the webview occlusion throttle (#957 / #2460).
    ///
    /// Requires `cargo build -p termihub-agent` and a local `sshd`; skips
    /// gracefully otherwise (mirrors the Docker sftp integration test).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn reconnect_agent_reestablishes_russh_transport_and_drives_fresh_create() {
        let Some(sshd) = find_sshd() else {
            eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
            return;
        };
        let Some(agent_bin) = find_agent_binary() else {
            eprintln!(
                "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
            );
            return;
        };

        trust_all_host_keys();

        let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
        sshd.start();

        let config = sshd.agent_config();
        let settings = AgentSettings::default();
        let alive = Arc::new(AtomicBool::new(true));
        let mut request_id = 0u64;

        // ── Initial establish: connect over russh, exec the agent, initialize.
        // `reconnect_agent` performs the full establishment, so it doubles as the
        // "before" connect here.
        let (session, mut channel, _buffered) =
            reconnect_agent(&config, &settings, &mut request_id, &alive)
                .await
                .expect("initial agent establishment over local sshd failed");

        // Pre-drop: a live, usable session (models the maintainer's connected tab).
        let deadline = Instant::now() + RECOVERY_CEILING;
        let _pre_sid =
            create_and_verify_usable(&mut channel, &mut request_id, "pre-drop-marker", deadline)
                .await;

        // ── Real server-side transport drop: kill the sshd tree. The established
        // russh channel must go down (EOF), proving this is a genuine transport
        // loss, not just a closed listener.
        sshd.stop();
        let old_channel_closed = {
            let close_deadline = Instant::now() + Duration::from_secs(10);
            let mut buf = String::new();
            loop {
                if Instant::now() >= close_deadline {
                    break false;
                }
                match tokio::time::timeout(
                    Duration::from_millis(500),
                    read_handshake_line(&mut channel, "test-agent", &mut buf),
                )
                .await
                {
                    Ok(None) => break true,  // channel closed — transport is down
                    Ok(Some(_)) => continue, // drain any buffered line
                    Err(_) => continue,      // read timeout — keep polling
                }
            }
        };
        assert!(
            old_channel_closed,
            "the established russh channel did not close after the sshd was killed — \
             the drop was not a real transport loss"
        );
        // Drop the dead session/channel explicitly before re-establishing.
        drop(channel);
        drop(session);

        // ── Restore the transport (same host key/config/port).
        sshd.start();

        // ── The layer under test: reconnect_agent must re-establish the real
        // russh transport now that the sshd is back, within the recovery ceiling.
        let reconnect_started = Instant::now();
        let reconnected = reconnect_agent(&config, &settings, &mut request_id, &alive).await;
        let reconnect_elapsed = reconnect_started.elapsed();
        let (session2, mut channel2, _buffered2) = reconnected.unwrap_or_else(|e| {
            panic!(
                "reconnect_agent failed to re-establish the russh transport after the sshd \
                 returned (elapsed {reconnect_elapsed:?}): {e}"
            )
        });
        assert!(
            reconnect_elapsed < RECONNECT_SETTLE_CEILING,
            "reconnect_agent took {reconnect_elapsed:?}, over the \
             {RECONNECT_SETTLE_CEILING:?} settle ceiling — the fresh agent's startup \
             session recovery is stalling initialize again (the dead-but-lingering \
             daemon-socket 30s connect-timeout regression, #2476)"
        );

        // ── The redrive drives a FRESH create over the re-established transport;
        // the new session must be usable — the exact recovery that failed live.
        let recover_deadline = Instant::now() + RECOVERY_CEILING;
        let _post_sid = create_and_verify_usable(
            &mut channel2,
            &mut request_id,
            "post-reconnect-marker",
            recover_deadline,
        )
        .await;

        // Explicit teardown so the sshd tree (and the agent it spawned) are gone
        // before the temp dir is removed.
        drop(channel2);
        drop(session2);
        sshd.stop();
    }

    /// Read `connection.output` notifications off the channel, tracking the highest
    /// `TICK=<n>` counter value seen, and return it once `want(max)` holds — else the
    /// last-seen max (or `None`) at the deadline.
    ///
    /// The counter loop prints `TICK=$i`; only *executed* output (`TICK=0`,
    /// `TICK=1`, …) carries a digit, while the one-time keystroke echo of the
    /// command line contains the literal `TICK=$i` (no digit) — so the echoed
    /// command can never be mistaken for a counter value.
    async fn read_counter_until(
        channel: &mut russh::Channel<russh::client::Msg>,
        want: impl Fn(u64) -> bool,
        deadline: Instant,
    ) -> Option<u64> {
        let mut buf = String::new();
        let mut max: Option<u64> = None;
        while Instant::now() < deadline {
            let read = tokio::time::timeout(
                Duration::from_millis(500),
                read_handshake_line(channel, "test-agent", &mut buf),
            )
            .await;
            match read {
                Ok(Some(line)) => {
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                        jsonrpc::parse_message(&line)
                    {
                        if method == "connection.output" {
                            if let Some(data) = params["data"].as_str() {
                                if let Ok(bytes) = B64.decode(data) {
                                    let text = String::from_utf8_lossy(&bytes);
                                    for tail in text.split("TICK=").skip(1) {
                                        let digits: String = tail
                                            .chars()
                                            .take_while(|c| c.is_ascii_digit())
                                            .collect();
                                        if let Ok(v) = digits.parse::<u64>() {
                                            max = Some(max.map_or(v, |m| m.max(v)));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let Some(m) = max {
                        if want(m) {
                            return Some(m);
                        }
                    }
                }
                Ok(None) => return max, // channel closed
                Err(_) => continue,     // read timeout — re-check the deadline
            }
        }
        max
    }

    /// The #2512 continuity invariant over a REAL SSH transport, headless: a
    /// daemon-backed session's running process survives a genuine transport drop and
    /// is CONTINUED — same session id, same live process — after the backend
    /// re-establishes the transport. It must not restart (counter back to 0) or pause
    /// (counter unchanged). This is the automated form of the manual
    /// `verify-agent-reconnect.sh` grade's headline check.
    ///
    /// Distinct from `..._drives_fresh_create` above: that kills the whole sshd tree,
    /// taking the setsid'd daemon with it (#2508/#995), so it can only prove
    /// *fresh-create* recovery. This severs the transport with `stop_sparing_daemon`
    /// — killing only the sshd master + handlers — so the daemon and its running
    /// process live through the outage and can be re-attached to.
    ///
    /// Requires `cargo build -p termihub-agent` and a local `sshd`; skips gracefully
    /// otherwise (mirrors the fresh-create test and the Docker sftp integration test).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn reconnect_reattaches_same_daemon_session_and_process_keeps_running() {
        let Some(sshd) = find_sshd() else {
            eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
            return;
        };
        let Some(agent_bin) = find_agent_binary() else {
            eprintln!(
                "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
            );
            return;
        };

        trust_all_host_keys();

        let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
        sshd.start();

        let config = sshd.agent_config();
        let settings = AgentSettings::default();
        let alive = Arc::new(AtomicBool::new(true));
        let mut request_id = 0u64;

        // ── Establish, create a DAEMON-BACKED session ("local" is persistent, so the
        // agent runs it in a setsid'd daemon subprocess), attach, and start a
        // self-incrementing counter in it.
        let (session, mut channel, _buffered) =
            reconnect_agent(&config, &settings, &mut request_id, &alive)
                .await
                .expect("initial agent establishment over local sshd failed");

        let created = channel_rpc(
            &mut channel,
            &mut request_id,
            "connection.create",
            serde_json::json!({ "type": "local", "title": "continuity", "config": {} }),
        )
        .await
        .expect("connection.create (persistent local shell) failed");
        let sid = created["session_id"]
            .as_str()
            .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
            .to_string();

        channel_rpc(
            &mut channel,
            &mut request_id,
            "connection.attach",
            serde_json::json!({ "session_id": sid }),
        )
        .await
        .expect("initial attach failed");

        // Fire-and-forget: a 5 Hz counter that never stops (echoes `TICK=<n>`).
        request_id += 1;
        let counter_cmd = "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n";
        let write_line = serialize_request(
            request_id,
            "connection.write",
            serde_json::json!({ "session_id": sid, "data": B64.encode(counter_cmd.as_bytes()) }),
        )
        .expect("serialize write");
        channel
            .data(write_line.as_bytes())
            .await
            .expect("write counter command");

        let before =
            read_counter_until(&mut channel, |m| m >= 3, Instant::now() + RECOVERY_CEILING)
                .await
                .expect("counter never produced TICK values before the drop");
        assert!(
            before >= 3,
            "counter not clearly running before drop: {before}"
        );

        // ── Real transport drop, SPARING the daemon: the established russh channel
        // must go down (genuine transport loss), but the daemon keeps the counter
        // running with nobody attached.
        sshd.stop_sparing_daemon();
        let channel_closed = {
            let close_deadline = Instant::now() + Duration::from_secs(10);
            let mut buf = String::new();
            loop {
                if Instant::now() >= close_deadline {
                    break false;
                }
                match tokio::time::timeout(
                    Duration::from_millis(500),
                    read_handshake_line(&mut channel, "test-agent", &mut buf),
                )
                .await
                {
                    Ok(None) => break true,  // channel closed — transport is down
                    Ok(Some(_)) => continue, // drain any buffered line
                    Err(_) => continue,      // read timeout — keep polling
                }
            }
        };
        assert!(
            channel_closed,
            "the russh channel did not close after stop_sparing_daemon — the transport \
             drop was not real"
        );
        drop(channel);
        drop(session);

        // Disconnected gap: no agent attached, but the daemon's counter keeps ticking.
        std::thread::sleep(Duration::from_millis(1500));

        // ── Restore + reconnect: the fresh `--stdio` agent's startup recovery
        // re-adopts the surviving daemon session.
        sshd.start();
        let (session2, mut channel2, _buffered2) =
            reconnect_agent(&config, &settings, &mut request_id, &alive)
                .await
                .expect("reconnect_agent failed to re-establish the russh transport");

        // Same-session recovery: the SAME id must reappear (not a fresh one).
        let list = channel_rpc(
            &mut channel2,
            &mut request_id,
            "connection.list",
            serde_json::json!({}),
        )
        .await
        .expect("connection.list after reconnect failed");
        let recovered = list["sessions"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .any(|s| s["session_id"].as_str() == Some(sid.as_str()))
            })
            .unwrap_or(false);
        assert!(
            recovered,
            "daemon session {sid} was not recovered after reconnect (a fresh shell, not the \
             continued one) — list: {list}"
        );

        // Re-attach to the SAME id — never a fresh create.
        channel_rpc(
            &mut channel2,
            &mut request_id,
            "connection.attach",
            serde_json::json!({ "session_id": sid }),
        )
        .await
        .unwrap_or_else(|e| panic!("re-attach to the same session {sid} failed: {e}"));

        // Continuity: the replay must carry a counter value strictly BEYOND the
        // pre-drop one — the loop neither reset to 0 (restart) nor stalled (pause)
        // across the outage.
        let after_gap = read_counter_until(
            &mut channel2,
            |m| m > before,
            Instant::now() + RECOVERY_CEILING,
        )
        .await
        .expect("no counter output after reconnect — the live session did not survive");
        assert!(
            after_gap > before,
            "counter did not advance across the outage: before={before}, after={after_gap} \
             — the process paused or restarted (not the same live session)"
        );

        // Live continuation: after draining the replay to the current head, a further
        // strictly-greater value can come only from the still-running loop.
        let base = read_counter_until(
            &mut channel2,
            |_| false,
            Instant::now() + Duration::from_millis(800),
        )
        .await
        .unwrap_or(after_gap);
        let after_live = read_counter_until(
            &mut channel2,
            |m| m > base,
            Instant::now() + RECOVERY_CEILING,
        )
        .await
        .expect("counter stopped advancing after reconnect");
        assert!(
            after_live > base,
            "counter stopped after reconnect: base={base}, after_live={after_live} \
             — the recovered session is not live"
        );

        // Clean up the (setsid'd) daemon explicitly — teardown's sshd kill can't
        // reach it — then tear the transport down.
        let _ = channel_rpc(
            &mut channel2,
            &mut request_id,
            "connection.close",
            serde_json::json!({ "session_id": sid }),
        )
        .await;
        drop(channel2);
        drop(session2);
        sshd.stop();
    }

    /// #2573: the SAME continuity invariant as above, but the transport is severed
    /// with the **deterministic in-process primitive** ([`test_sever_desktop_transport`])
    /// instead of `stop_sparing_daemon`'s process-title-matched sshd kill.
    ///
    /// This is the exact sever the shipped path runs: `agent_io_task`'s
    /// `TestSeverTransport` command (reached via
    /// [`AgentConnectionManager::test_sever_transport`] and the test-bridge-gated
    /// `test_sever_agent_transport`) drops the desktop russh transport through this
    /// same helper. Dropping the channel + session closes the client socket, so the
    /// sshd handler + `--stdio` agent see an abrupt EOF and exit while the setsid'd
    /// session daemon survives — no `lsof`, no comm-matching, no root, no sshd
    /// restart (the master keeps listening). The surviving daemon session must then
    /// re-attach with its process CONTINUED (counter strictly beyond the pre-drop
    /// value — neither reset to 0 nor stalled).
    ///
    /// Requires `cargo build -p termihub-agent` and a local `sshd`; skips otherwise.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn in_process_sever_reattaches_same_daemon_session_and_process_keeps_running() {
        let Some(sshd) = find_sshd() else {
            eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
            return;
        };
        let Some(agent_bin) = find_agent_binary() else {
            eprintln!(
                "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
            );
            return;
        };

        trust_all_host_keys();

        let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
        sshd.start();

        let config = sshd.agent_config();
        let settings = AgentSettings::default();
        let alive = Arc::new(AtomicBool::new(true));
        let mut request_id = 0u64;

        // Establish + a daemon-backed persistent session running a counter.
        let (session, mut channel, _buffered) =
            reconnect_agent(&config, &settings, &mut request_id, &alive)
                .await
                .expect("initial agent establishment over local sshd failed");

        let created = channel_rpc(
            &mut channel,
            &mut request_id,
            "connection.create",
            serde_json::json!({ "type": "local", "title": "continuity", "config": {} }),
        )
        .await
        .expect("connection.create (persistent local shell) failed");
        let sid = created["session_id"]
            .as_str()
            .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
            .to_string();

        channel_rpc(
            &mut channel,
            &mut request_id,
            "connection.attach",
            serde_json::json!({ "session_id": sid }),
        )
        .await
        .expect("initial attach failed");

        request_id += 1;
        let counter_cmd = "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n";
        let write_line = serialize_request(
            request_id,
            "connection.write",
            serde_json::json!({ "session_id": sid, "data": B64.encode(counter_cmd.as_bytes()) }),
        )
        .expect("serialize write");
        channel
            .data(write_line.as_bytes())
            .await
            .expect("write counter command");

        let before =
            read_counter_until(&mut channel, |m| m >= 3, Instant::now() + RECOVERY_CEILING)
                .await
                .expect("counter never produced TICK values before the sever");
        assert!(
            before >= 3,
            "counter not clearly running before the sever: {before}"
        );

        // ── THE SEVER UNDER TEST: deterministic, in-process, sshd untouched.
        // Dropping the desktop transport closes the client socket abruptly; the
        // established russh channel is gone (we consumed it), and the peer's sshd
        // handler sees the EOF. The setsid'd daemon keeps the counter running.
        assert!(
            is_listening(sshd.port),
            "sshd must stay up across an in-process sever — no kill, no restart"
        );
        test_sever_desktop_transport(channel, Some(session));
        // The daemon keeps ticking with nobody attached.
        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            is_listening(sshd.port),
            "the in-process sever must not touch the sshd — it is still listening"
        );

        // ── Reconnect over the still-listening sshd; the fresh `--stdio` agent's
        // startup recovery re-adopts the surviving daemon session.
        let (session2, mut channel2, _buffered2) =
            reconnect_agent(&config, &settings, &mut request_id, &alive)
                .await
                .expect("reconnect_agent failed to re-establish after the in-process sever");

        // Same-session recovery: the SAME id must reappear (never a fresh create).
        let list = channel_rpc(
            &mut channel2,
            &mut request_id,
            "connection.list",
            serde_json::json!({}),
        )
        .await
        .expect("connection.list after reconnect failed");
        let recovered = list["sessions"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .any(|s| s["session_id"].as_str() == Some(sid.as_str()))
            })
            .unwrap_or(false);
        assert!(
            recovered,
            "daemon session {sid} was not recovered after the in-process sever \
             (a fresh shell, not the continued one) — list: {list}"
        );

        channel_rpc(
            &mut channel2,
            &mut request_id,
            "connection.attach",
            serde_json::json!({ "session_id": sid }),
        )
        .await
        .unwrap_or_else(|e| panic!("re-attach to the same session {sid} failed: {e}"));

        // Continuity: a counter value strictly BEYOND the pre-drop one — neither a
        // restart (back to 0) nor a stall (unchanged) across the outage.
        let after_gap = read_counter_until(
            &mut channel2,
            |m| m > before,
            Instant::now() + RECOVERY_CEILING,
        )
        .await
        .expect("no counter output after the in-process sever — the live session did not survive");
        assert!(
            after_gap > before,
            "counter did not advance across the in-process sever: before={before}, \
             after={after_gap} — the process paused or restarted (not the same live session)"
        );

        // Live continuation past the drained replay head can only come from the
        // still-running loop.
        let base = read_counter_until(
            &mut channel2,
            |_| false,
            Instant::now() + Duration::from_millis(800),
        )
        .await
        .unwrap_or(after_gap);
        let after_live = read_counter_until(
            &mut channel2,
            |m| m > base,
            Instant::now() + RECOVERY_CEILING,
        )
        .await
        .expect("counter stopped advancing after the in-process sever");
        assert!(
            after_live > base,
            "counter stopped after reconnect: base={base}, after_live={after_live} \
             — the recovered session is not live"
        );

        let _ = channel_rpc(
            &mut channel2,
            &mut request_id,
            "connection.close",
            serde_json::json!({ "session_id": sid }),
        )
        .await;
        drop(channel2);
        drop(session2);
        sshd.stop();
    }

    /// #2573: a PERMANENT transport loss (endpoint gone) after an in-process sever
    /// settles distinctly from a user-cancel.
    ///
    /// After severing in-process and taking the sshd fully down, `reconnect_agent`
    /// must **park** — keep retrying with backoff — never reporting a spurious
    /// success against the dead endpoint (bounded so the test cannot hang). A
    /// user-cancel (`alive = false`) is the DISTINCT settle: the next attempt
    /// returns promptly with the stop signal, not an `Ok`. Together these pin the
    /// two terminal outcomes the reconnect grade must tell apart.
    ///
    /// Requires `cargo build -p termihub-agent` and a local `sshd`; skips otherwise.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn permanent_transport_loss_parks_distinct_from_user_cancel() {
        let Some(sshd) = find_sshd() else {
            eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
            return;
        };
        let Some(agent_bin) = find_agent_binary() else {
            eprintln!(
                "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
            );
            return;
        };

        trust_all_host_keys();

        let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
        sshd.start();

        let config = sshd.agent_config();
        let settings = AgentSettings::default();
        let alive = Arc::new(AtomicBool::new(true));
        let mut request_id = 0u64;

        let (session, channel, _buffered) =
            reconnect_agent(&config, &settings, &mut request_id, &alive)
                .await
                .expect("initial agent establishment over local sshd failed");

        // In-process sever, then take the endpoint permanently down.
        test_sever_desktop_transport(channel, Some(session));
        sshd.stop();
        let deadline = Instant::now() + Duration::from_secs(10);
        while is_listening(sshd.port) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !is_listening(sshd.port),
            "the endpoint must be fully down for the permanent-loss path"
        );

        // Permanent loss → PARK: reconnect keeps retrying, never settling early.
        // Bounded by a timeout so a regression to a false Ok/early-Err trips here.
        // (The `Ok` transport holds a russh handle that is not `Debug`, so match
        // rather than assert-format.)
        match tokio::time::timeout(
            Duration::from_secs(6),
            reconnect_agent(&config, &settings, &mut request_id, &alive),
        )
        .await
        {
            Err(_elapsed) => {} // still retrying when the window elapsed → parked
            Ok(Ok(_)) => {
                panic!("reconnect to a permanently-dead endpoint falsely reported success")
            }
            Ok(Err(e)) => {
                panic!("reconnect settled early on a permanent loss instead of parking: {e}")
            }
        }

        // User-cancel is the DISTINCT settle: with alive=false the next attempt
        // returns promptly with the stop signal — never a spurious Ok.
        alive.store(false, Ordering::SeqCst);
        match reconnect_agent(&config, &settings, &mut request_id, &alive).await {
            Err(e) => assert!(
                e.contains("stopped by user"),
                "a user-cancel must settle with the stop signal, got: {e}"
            ),
            Ok(_) => panic!("a user-cancel must not report a spurious reconnect success"),
        }
    }
}
