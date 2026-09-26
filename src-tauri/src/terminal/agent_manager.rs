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
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::monitoring::{MonitoringSender, SystemStats};
use termihub_core::protocol::methods::MonitoringStatusNotification;
use termihub_core::protocol::methods::{
    AgentForwardCloseParams, AgentForwardDataParams, AgentShutdownParams, AgentShutdownResult,
    ConnectionCreateParams, ConnectionDefinition, ConnectionDeleteParams, ConnectionListResult,
    ConnectionUpdateParams, FolderCreateParams, FolderDefinition, FolderDeleteParams,
    FolderUpdateParams, SessionAttachParams, SessionCloseParams, SessionCreateParams,
    SessionCreateResult, SessionDetachParams, SessionInputParams, SessionListEntry,
    SessionListResult, SessionResizeParams,
};
use termihub_core::reconnect_backoff::{
    reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase, INITIAL_RECONNECT_STATE,
};

use crate::agents_projection::projection::fold_agent_transition;
use crate::agents_projection::store::AgentConnectionState;
use crate::connection::config::AgentSettings;
use crate::session::manager::{AgentHostedSession, SessionManager};
use crate::session_projection::projection::{
    fold_agent_reconnect_failed, fold_agent_session_evicted, fold_agent_session_lost,
    fold_agent_session_recovered, fold_agent_session_unconfirmed,
    fold_agent_transport_reconnecting,
};
use crate::session_projection::store::{SessionLifecycleStore, SessionStatus};
use crate::terminal::agent_config_store::{decide_reattach, AgentConfigStore, ReattachDecision};
use crate::terminal::agent_deploy::ConnectedHost;
use crate::terminal::agent_forward::DesktopAgentForward;
use crate::terminal::backend::{OutputSender, RemoteAgentConfig, RemoteStateChangeEvent};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate_cancellable;

/// Wall-clock cap on a single agent JSON-RPC round-trip (CONC-003).
///
/// Without it, [`send_request`](AgentConnectionManager::send_request) parks its
/// `spawn_blocking` thread on the response channel for the entire reconnect
/// window (up to minutes) whenever the link drops mid-RPC — and a burst of agent
/// operations during an outage piles up dozens of parked blocking threads. The
/// bound is generous enough to cover a legitimately slow agent-side operation
/// (e.g. a nested `connection.create` that itself connects out, bounded by the
/// 45 s SSH connect timeout) while still failing in seconds-to-a-minute rather
/// than minutes.
const AGENT_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Pure data types and wire-format parse helpers (ARCH-002 / TAURI-009).
///
/// Carved into a sibling module and re-exported below so every existing
/// `crate::terminal::agent_manager::…` path stays valid.
mod types;
pub use types::*;

/// A failed agent JSON-RPC request: the agent's error `code` (when it answered
/// with a JSON-RPC error) plus the human message. Carrying the code lets
/// [`AgentConnectionManager::send_request`] map typed refusals to a typed
/// [`TerminalError`] instead of parsing message text (#3404). Local failures
/// (write error, connection lost) carry no code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentRpcFailure {
    pub code: Option<i64>,
    pub message: String,
}

impl From<String> for AgentRpcFailure {
    fn from(message: String) -> Self {
        Self {
            code: None,
            message,
        }
    }
}

impl AgentRpcFailure {
    /// The typed desktop error for this failure. A plain attach refused because
    /// another desktop holds the session (`SESSION_HELD_BY_OTHER`, SM-003) maps
    /// to [`TerminalError::SessionHeldByPeer`]; an agent lacking the capability
    /// (`METHOD_NOT_FOUND` from an older agent, or `PROCESS_NOT_SUPPORTED`) maps
    /// to [`TerminalError::AgentUnsupported`] (#3408); everything else stays a
    /// generic [`TerminalError::RemoteError`].
    ///
    /// No message-text fallback is needed for the "unsupported" case: every
    /// agent build answers an unknown method with the standard JSON-RPC
    /// `-32601` code (the dispatcher has done so since it was introduced), and
    /// `PROCESS_NOT_SUPPORTED` shipped together with the process methods.
    pub(crate) fn into_terminal_error(self) -> TerminalError {
        use termihub_core::protocol::errors;
        match self.code {
            Some(errors::SESSION_HELD_BY_OTHER) => TerminalError::SessionHeldByPeer(self.message),
            Some(errors::METHOD_NOT_FOUND | errors::PROCESS_NOT_SUPPORTED) => {
                TerminalError::AgentUnsupported(self.message)
            }
            _ => TerminalError::RemoteError(self.message),
        }
    }
}

/// Commands sent to the agent I/O task.
pub(crate) enum AgentIoCommand {
    /// Send JSON-RPC request and get a response via a oneshot channel.
    Request {
        method: String,
        params: Value,
        response_tx: oneshot::Sender<Result<Value, AgentRpcFailure>>,
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
    /// Attach a status sender to a registered monitoring route (#3321).
    RegisterMonitoringStatus {
        session_id: String,
        status_tx: MonitoringStatusSender,
    },
    /// Unregister a session's monitoring sender (and its status sender).
    UnregisterMonitoring { session_id: String },
    /// Route a streaming tool run's `tool.event` / `tool.done` notifications to
    /// `tx` (#3353). Registered *before* `tool.start` is sent so no early event
    /// can be missed.
    RegisterToolRun { run_id: String, tx: ToolRunSender },
    /// Stop routing a streaming tool run's notifications.
    UnregisterToolRun { run_id: String },
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
    /// True while the I/O task is inside its reconnect path (transport down).
    /// Shared with the task so the send-side (`send_session_input`) can drop
    /// terminal input at the source during an outage instead of queuing it for a
    /// post-reconnect replay (CONC-014) — bounding the otherwise-unbounded input
    /// backlog and keeping stale keystrokes out of the recovered session.
    reconnecting: Arc<AtomicBool>,
    /// Force-stop handle for the per-agent I/O task (CONC-009). The normal
    /// shutdown remains the cooperative `Disconnect` command; this is the
    /// guaranteed fallback so `disconnect_agent`, connect-time eviction, and prune
    /// can abort a task that is wedged (e.g. parked in a blocking reconnect) and
    /// could never observe `Disconnect`. Only ever fired on teardown/replacement —
    /// never during normal operation — so it cannot interrupt live protocol
    /// framing on a healthy agent. Dropping the handle (self-reap) does not abort
    /// the task, so the task's own self-termination paths are unaffected.
    io_task: AbortHandle,
    capabilities: AgentCapabilities,
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
// The trait is live (consumed as `Arc<dyn AgentRpcClient>` across commands, session,
// network, tunnel and embedded-servers), but `retain_agent_config` belongs to the
// default-off backend-reconnect reattach feature (#2472) and has no caller yet, so the
// blanket allow stays until that path is wired up.
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

    /// Route a streaming tool run's notifications (`tool.event` / `tool.done`,
    /// #3353) to `tx`. The channel closes without a `Done` if the agent transport
    /// breaks. Default errors so mock clients that do not model streaming make
    /// the caller fall back to the collect-and-return `tool.run`.
    fn register_tool_run(
        &self,
        agent_id: &str,
        _run_id: &str,
        _tx: ToolRunSender,
    ) -> Result<(), TerminalError> {
        Err(TerminalError::RemoteError(format!(
            "Agent {agent_id} does not support streaming tool runs"
        )))
    }

    /// Stop routing a streaming tool run's notifications (#3353). Default no-op.
    fn unregister_tool_run(&self, _agent_id: &str, _run_id: &str) {}

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

    /// Explicit **Reclaim** (SM-003, single-attach): `connection.attach` with
    /// `takeover: true`, taking control of the session back from whichever
    /// desktop holds it (which is evicted in turn). Defaults to a plain attach so
    /// test doubles need not implement it.
    fn reclaim_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.attach_session(agent_id, remote_session_id)
    }

    /// Close a session on the agent.
    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError>;

    /// List sessions on the agent.
    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError>;

    /// List every session running on the agent host with who controls it
    /// (`connection.list_host_sessions`, #3369). Defaults to "unsupported" so
    /// test doubles need not implement it.
    fn list_host_sessions(
        &self,
        _agent_id: &str,
    ) -> Result<AgentHostSessionsResult, TerminalError> {
        Ok(AgentHostSessionsResult {
            supported: false,
            sessions: Vec::new(),
        })
    }

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
        definition: ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError>;

    /// Update a saved connection definition on the agent.
    fn update_definition(
        &self,
        agent_id: &str,
        params: ConnectionUpdateParams,
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
        params: FolderUpdateParams,
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

    /// Route the agent's `connection.monitoring.status` reports for an
    /// already-registered monitored host to `status_tx` (#3321).
    ///
    /// Call after [`register_monitoring_output`](Self::register_monitoring_output);
    /// [`unregister_monitoring_output`](Self::unregister_monitoring_output)
    /// drops it too. The default is a no-op: a client that never forwards
    /// status reports leaves the monitor on sample-flow inference, exactly as
    /// against an older agent that never sends them.
    fn register_monitoring_status_output(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        _status_tx: MonitoringStatusSender,
    ) -> Result<(), TerminalError> {
        Ok(())
    }

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

/// Sender for an agent-hosted monitor's `connection.monitoring.status`
/// reports (#3321).
pub type MonitoringStatusSender = mpsc::Sender<MonitoringStatusNotification>;

/// Where the I/O task routes one monitored host's notifications: its
/// `connection.monitoring.data` samples, and — once the monitor asked for them —
/// its `connection.monitoring.status` reports (#3321).
pub(crate) struct MonitoringRoute {
    stats: MonitoringSender,
    status: Option<MonitoringStatusSender>,
}

impl From<MonitoringSender> for MonitoringRoute {
    fn from(stats: MonitoringSender) -> Self {
        Self {
            stats,
            status: None,
        }
    }
}

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
                // CONC-009: force-stop as a fallback. A dead entry's task has
                // usually already returned (abort is a no-op), but a wedged task
                // that flipped `alive` false without exiting is force-stopped here.
                conn.io_task.abort();
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
///
/// Generic over the Tauri [`Runtime`] (defaulting to [`Wry`] so production wiring,
/// `commands/*`, `lib.rs`, and the `Arc<dyn AgentRpcClient>` state are unchanged):
/// tests instantiate it against a `tauri::test::MockRuntime` via `mock_app()` so
/// the full shipped command → I/O-task → reconnect path can be driven headlessly
/// (#2576). The production behavior for `Wry` is identical — only the runtime type
/// parameter is threaded through.
pub struct AgentConnectionManager<R: Runtime = Wry> {
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
    app_handle: AppHandle<R>,
}

impl<R: Runtime> AgentConnectionManager<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
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
                return Err(TerminalError::already_connected(format!(
                    "Agent {} is already connected",
                    agent_id
                )));
            }
            // CONC-009: force-stop the outgoing task as a fallback. A "dead" entry
            // usually means the task already returned (abort is then a harmless
            // no-op), but a task wedged in a blocking op would otherwise leak its
            // SSH session behind the fresh connection replacing it here.
            if let Some(old) = agents.remove(agent_id) {
                old.io_task.abort();
            }
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
                TerminalError::agent_missing(format!("Exec failed: {}", e))
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
            let req_line = serialize_request(
                request_id,
                termihub_core::protocol::methods::INITIALIZE,
                init_params,
            )
            .map_err(|e| {
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
                TerminalError::agent_missing(format!("Write initialize failed: {}", e))
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
                        return Err(TerminalError::agent_outdated(format!(
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
            let reconnecting = Arc::new(AtomicBool::new(false));
            // TAURI-014: this channel stays UNBOUNDED, deliberately. A bounded +
            // backpressured version was assessed and deferred (see follow-up), for
            // three reasons: (1) the sole consumer (`agent_io_task`) re-queues
            // survivors into this same channel during reconnect (the
            // `command_tx.send` at the CONC-014 drain below) — under a full bounded
            // channel `send().await` would self-deadlock, and `try_send`+drop would
            // silently discard control commands (forbidden); (2) the task holds its
            // own `command_tx` clone (CONC-009), so the channel never closes and a
            // full bound would block every producer for the entire reconnect window;
            // (3) the real unbounded-growth vector — terminal input piling up while
            // the consumer stalls — is already bounded by CONC-014, which drops
            // `SessionInput` at the source (via `reconnecting`) during the only
            // window the loop stops draining. Under normal operation the loop drains
            // continuously, so the queue does not grow. Bounding this safely needs a
            // producer-context refactor tracked as a follow-up.
            let (command_tx, command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();

            let alive_clone = alive.clone();
            let reconnecting_clone = reconnecting.clone();
            let app_handle_task = app_handle_clone.clone();
            let agent_id_task = agent_id_str.clone();
            let config_task = config_clone.clone();
            let settings_task = settings_clone.clone();
            let agents_weak_task = agents_weak.clone();

            // A clone for the task itself: the agent-forward relay's pump tasks
            // send reply chunks back through it (#1727). Teardown is driven by an
            // explicit `Disconnect`, so a task-held clone does not mask it.
            let command_tx_task = command_tx.clone();
            // Retain the task's abort handle (CONC-009): the self-held `command_tx`
            // clone means an all-external-senders-dropped condition can never close
            // the loop, so a guaranteed force-stop is the only escape hatch for a
            // wedged task. Kept in the `AgentConnection` and fired only on teardown.
            let io_task = tokio::spawn(async move {
                agent_io_task(
                    session,
                    channel,
                    command_rx,
                    command_tx_task,
                    alive_clone,
                    reconnecting_clone,
                    app_handle_task,
                    agent_id_task,
                    config_task,
                    settings_task,
                    request_id,
                    agents_weak_task,
                    pending_notifications,
                )
                .await;
            })
            .abort_handle();

            Ok::<_, TerminalError>((
                capabilities,
                agent_version,
                protocol_version,
                client_id,
                command_tx,
                alive,
                reconnecting,
                io_task,
            ))
        }));

        // On cancel the connect future above is dropped before any I/O task is
        // spawned, so no backend `disconnected` is emitted from there — emit it
        // here so the agent returns to `disconnected` (single writer, G1 #1235).
        // Other error paths already emit `disconnected` inline before returning.
        let (
            capabilities,
            agent_version,
            protocol_version,
            client_id,
            command_tx,
            alive,
            reconnecting,
            io_task,
        ) = match result {
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
                reconnecting,
                io_task,
                capabilities,
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
            // Cooperative shutdown first: a live task processes `Disconnect` and
            // returns, dropping its russh session/channel.
            let _ = conn.command_tx.send(AgentIoCommand::Disconnect);
            conn.alive.store(false, Ordering::SeqCst);
            // CONC-009: guaranteed force-stop fallback. A task parked in a blocking
            // reconnect can never observe `Disconnect` (it holds its own
            // `command_tx` clone, so the channel never closes either); the abort is
            // the only escape hatch. Safe here because the agent is being torn down
            // for good, so interrupting an in-flight write cannot corrupt any
            // framing we still care about. A no-op if the task already exited.
            conn.io_task.abort();
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
                    // Matched by the structured `already_connected` code, not by
                    // message text (#3408).
                    Err(e) if e.code() == crate::utils::errors::IpcErrorCode::AlreadyConnected => {
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
        let params = serde_json::to_value(AgentShutdownParams {
            reason: reason.map(str::to_string),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build agent.shutdown params: {e}"))
        })?;

        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::AGENT_SHUTDOWN,
            params,
        )?;
        // Tolerate a reply that omits/garbles the count (best-effort shutdown):
        // an unparseable result means "shut down, count unknown" → 0, matching the
        // pre-migration `unwrap_or(0)`.
        let detached = serde_json::from_value::<AgentShutdownResult>(result)
            .map(|r| r.detached_sessions)
            .unwrap_or(0);

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

        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::AGENT_LIST_CONNECTIONS,
            serde_json::json!({}),
        )?;
        // Deserialize the reply into the shared `ConnectionListResult` wire DTO
        // (DUP-001); a malformed reply degrades to "no other hosts", matching the
        // old hand-parser's tolerance (it silently dropped unparseable entries).
        let connections = serde_json::from_value::<ConnectionListResult>(result)
            .map(|r| r.connections)
            .unwrap_or_default();

        let own_client_id = own_client_id.unwrap_or_default();
        let hosts = connections
            .into_iter()
            // Exclude this desktop's own entry (never warn about ourselves).
            .filter(|c| own_client_id.is_empty() || c.client_id != own_client_id)
            .map(|c| ConnectedHost {
                client_id: c.client_id,
                client: c.client,
                client_version: c.client_version,
                connected_since: c.connected_since,
            })
            .collect();

        Ok(hosts)
    }

    /// Send a JSON-RPC request to an agent and wait for the response.
    ///
    /// Bounded by [`AGENT_REQUEST_TIMEOUT`] so a request never parks its
    /// `spawn_blocking` thread for the whole reconnect window when the link
    /// drops mid-RPC (CONC-003).
    pub fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError> {
        self.send_request_with_timeout(agent_id, method, params, AGENT_REQUEST_TIMEOUT)
    }

    /// [`send_request`](Self::send_request) with an explicit wait bound.
    ///
    /// The blocking wait on the response oneshot is capped by `timeout`: a real
    /// [`tokio::time::timeout`], not the old channel-close-only path that
    /// returned a "timed out" error which never actually timed out (CONC-003).
    /// When it elapses the caller gets a genuine timeout error and its
    /// `spawn_blocking` thread is freed, instead of hanging for the entire
    /// (up to multi-minute) reconnect window. `timeout` is a parameter so tests
    /// can drive the elapsed path deterministically without the production wait.
    ///
    /// Same runtime-context requirement as the previous `blocking_recv`: call
    /// only from inside `spawn_blocking` or another non-async-task context (as
    /// every `commands/agent.rs` site does).
    fn send_request_with_timeout(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
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

        // Bounded wait: a fired timeout returns a real timeout error and frees
        // this thread; a dropped sender (io_task gone / pending drained on drop)
        // surfaces as a connection-lost error rather than the old misleading
        // "timed out" string (CONC-003).
        match tokio::runtime::Handle::current()
            .block_on(async { tokio::time::timeout(timeout, resp_rx).await })
        {
            Err(_elapsed) => Err(TerminalError::RemoteError(format!(
                "Agent request timed out after {:?}",
                timeout
            ))),
            Ok(Err(_recv)) => Err(TerminalError::RemoteError(
                "Agent connection lost".to_string(),
            )),
            Ok(Ok(inner)) => inner.map_err(AgentRpcFailure::into_terminal_error),
        }
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
        let params = serde_json::to_value(SessionCreateParams {
            session_type: session_type.to_string(),
            config,
            title: title.map(str::to_string),
            definition_id: definition_id.map(str::to_string),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connection.create params: {e}"))
        })?;

        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_CREATE,
            params,
        )?;
        serde_json::from_value::<SessionCreateResult>(result)
            .map(AgentSessionInfo::from)
            .map_err(|_| {
                TerminalError::RemoteError("Failed to parse connection.create result".into())
            })
    }

    /// Attach to a session on the agent.
    pub fn attach_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.send_attach(agent_id, remote_session_id, false)
    }

    /// Explicit Reclaim (SM-003): `connection.attach` with `takeover: true`.
    pub fn reclaim_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.send_attach(agent_id, remote_session_id, true)
    }

    fn send_attach(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        takeover: bool,
    ) -> Result<(), TerminalError> {
        let params = serde_json::to_value(SessionAttachParams {
            session_id: remote_session_id.to_string(),
            takeover,
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connection.attach params: {e}"))
        })?;
        self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_ATTACH,
            params,
        )?;
        Ok(())
    }

    /// Detach from a session on the agent.
    // allow(dead_code): session-lifecycle API counterpart to the wired-up attach
    // path; retained for the backend-driven reattach/close flows, not yet routed to.
    #[allow(dead_code)]
    pub fn detach_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        let params = serde_json::to_value(SessionDetachParams {
            session_id: remote_session_id.to_string(),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connection.detach params: {e}"))
        })?;
        self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_DETACH,
            params,
        )?;
        Ok(())
    }

    /// Close a session on the agent.
    // allow(dead_code): session-lifecycle API counterpart to the wired-up attach
    // path; retained for the backend-driven reattach/close flows, not yet routed to.
    #[allow(dead_code)]
    pub fn close_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        let params = serde_json::to_value(SessionCloseParams {
            session_id: remote_session_id.to_string(),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connection.close params: {e}"))
        })?;
        self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_CLOSE,
            params,
        )?;
        Ok(())
    }

    /// List sessions on the agent.
    pub fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_LIST,
            serde_json::json!({}),
        )?;
        // Deserialize each entry into the shared `SessionListEntry` wire DTO
        // (DUP-001) and convert to the frontend `AgentSessionInfo`.
        // `filter_map(... .ok())` keeps the old per-entry tolerance: a malformed
        // entry is dropped, not fatal to the whole list.
        let sessions = result["sessions"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        serde_json::from_value::<SessionListEntry>(v.clone())
                            .ok()
                            .map(AgentSessionInfo::from)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(sessions)
    }

    /// List every session running on the agent host with who controls it
    /// (#3369). An older agent without the method yields `supported: false`.
    pub fn list_host_sessions(
        &self,
        agent_id: &str,
    ) -> Result<AgentHostSessionsResult, TerminalError> {
        parse_host_sessions_reply(self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_LIST_HOST_SESSIONS,
            serde_json::json!({}),
        ))
    }

    /// List saved connections and folders on the agent.
    pub fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_LIST,
            serde_json::json!({}),
        )?;
        // Deserialize each entry into the shared `ConnectionDefinition` /
        // `FolderDefinition` wire DTO (DUP-001) and convert to the frontend
        // camelCase DTO. `filter_map(... .ok())` preserves the old hand-parser's
        // tolerance: a malformed entry is dropped, not fatal to the whole list.
        let connections = result["connections"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        serde_json::from_value::<ConnectionDefinition>(v.clone())
                            .ok()
                            .map(AgentDefinitionInfo::from)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let folders = result["folders"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        serde_json::from_value::<FolderDefinition>(v.clone())
                            .ok()
                            .map(AgentFolderInfo::from)
                    })
                    .collect()
            })
            .unwrap_or_default();
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
        definition: ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        let params = serde_json::to_value(definition).map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connections.create params: {e}"))
        })?;
        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_CREATE,
            params,
        )?;
        serde_json::from_value::<ConnectionDefinition>(result)
            .map(AgentDefinitionInfo::from)
            .map_err(|_| TerminalError::RemoteError("Failed to parse definition result".into()))
    }

    /// Update a saved connection definition on the agent.
    pub fn update_definition(
        &self,
        agent_id: &str,
        params: ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        let params = serde_json::to_value(params).map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connections.update params: {e}"))
        })?;
        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_UPDATE,
            params,
        )?;
        serde_json::from_value::<ConnectionDefinition>(result)
            .map(AgentDefinitionInfo::from)
            .map_err(|_| TerminalError::RemoteError("Failed to parse definition result".into()))
    }

    /// Delete a session definition on the agent.
    pub fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
        let params = serde_json::to_value(ConnectionDeleteParams {
            id: def_id.to_string(),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!("Failed to build connections.delete params: {e}"))
        })?;
        self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_DELETE,
            params,
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
        let params = serde_json::to_value(FolderCreateParams {
            name: name.to_string(),
            parent_id: parent_id.map(str::to_string),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!(
                "Failed to build connections.folders.create params: {e}"
            ))
        })?;
        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_FOLDERS_CREATE,
            params,
        )?;
        serde_json::from_value::<FolderDefinition>(result)
            .map(AgentFolderInfo::from)
            .map_err(|_| TerminalError::RemoteError("Failed to parse folder result".into()))
    }

    /// Update a folder on the agent.
    pub fn update_folder(
        &self,
        agent_id: &str,
        params: FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        let params = serde_json::to_value(params).map_err(|e| {
            TerminalError::RemoteError(format!(
                "Failed to build connections.folders.update params: {e}"
            ))
        })?;
        let result = self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_FOLDERS_UPDATE,
            params,
        )?;
        serde_json::from_value::<FolderDefinition>(result)
            .map(AgentFolderInfo::from)
            .map_err(|_| TerminalError::RemoteError("Failed to parse folder result".into()))
    }

    /// Delete a folder on the agent.
    pub fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError> {
        let params = serde_json::to_value(FolderDeleteParams {
            id: folder_id.to_string(),
        })
        .map_err(|e| {
            TerminalError::RemoteError(format!(
                "Failed to build connections.folders.delete params: {e}"
            ))
        })?;
        self.send_request(
            agent_id,
            termihub_core::protocol::methods::CONNECTIONS_FOLDERS_DELETE,
            params,
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

    /// Route `connection.monitoring.status` reports for a registered monitored
    /// host to `status_tx` (#3321).
    pub fn register_monitoring_status_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        status_tx: MonitoringStatusSender,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::RegisterMonitoringStatus {
                session_id: remote_session_id.to_string(),
                status_tx,
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

    /// Route a streaming tool run's notifications to `tx` (#3353).
    pub fn register_tool_run(
        &self,
        agent_id: &str,
        run_id: &str,
        tx: ToolRunSender,
    ) -> Result<(), TerminalError> {
        self.send_io_command(
            agent_id,
            AgentIoCommand::RegisterToolRun {
                run_id: run_id.to_string(),
                tx,
            },
        )
    }

    /// Stop routing a streaming tool run's notifications (#3353). Best effort:
    /// a gone agent has already dropped the route.
    pub fn unregister_tool_run(&self, agent_id: &str, run_id: &str) {
        let _ = self.send_io_command(
            agent_id,
            AgentIoCommand::UnregisterToolRun {
                run_id: run_id.to_string(),
            },
        );
    }

    /// Queue a command for an agent's I/O task.
    fn send_io_command(&self, agent_id: &str, cmd: AgentIoCommand) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;
        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;
        conn.command_tx
            .send(cmd)
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

        // CONC-014: drop terminal input while the transport is down. The I/O task
        // is not draining `command_rx` during a reconnect, so anything queued now
        // would (a) grow the unbounded channel without bound for the whole outage
        // and (b) replay stale keystrokes into the recovered remote session once it
        // reconnects. The tab already shows a reconnecting overlay; discarding input
        // is the safe behavior. Fire-and-forget, so reporting success is correct —
        // the keystroke is intentionally not delivered.
        if conn.reconnecting.load(Ordering::SeqCst) {
            return Ok(());
        }

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

impl<R: Runtime> AgentRpcClient for AgentConnectionManager<R> {
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

    fn reclaim_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::reclaim_session(self, agent_id, remote_session_id)
    }

    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        AgentConnectionManager::close_session(self, agent_id, remote_session_id)
    }

    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        AgentConnectionManager::list_sessions(self, agent_id)
    }

    fn list_host_sessions(&self, agent_id: &str) -> Result<AgentHostSessionsResult, TerminalError> {
        AgentConnectionManager::list_host_sessions(self, agent_id)
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
        definition: ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        AgentConnectionManager::save_definition(self, agent_id, definition)
    }

    fn update_definition(
        &self,
        agent_id: &str,
        params: ConnectionUpdateParams,
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
        params: FolderUpdateParams,
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

    fn register_monitoring_status_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        status_tx: MonitoringStatusSender,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::register_monitoring_status_output(
            self,
            agent_id,
            remote_session_id,
            status_tx,
        )
    }

    fn register_tool_run(
        &self,
        agent_id: &str,
        run_id: &str,
        tx: ToolRunSender,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::register_tool_run(self, agent_id, run_id, tx)
    }

    fn unregister_tool_run(&self, agent_id: &str, run_id: &str) {
        AgentConnectionManager::unregister_tool_run(self, agent_id, run_id)
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
        self.send_request(
            agent_id,
            termihub_core::protocol::methods::AGENT_SETTINGS_UPDATE,
            params,
        )?;
        Ok(())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Build the `initialize` JSON-RPC params including agent runtime settings and external files.
fn build_initialize_params(settings: &AgentSettings, external_files: &[&str]) -> Value {
    serde_json::json!({
        "protocolVersion": "0.3.0",
        "client": "termihub-desktop",
        // AGT-014: report the desktop crate's real version rather than a stale
        // literal. The agent records this in its per-process client registry and
        // echoes it via `agent.list_connections` (the connected-client update
        // guard, #1349), so a hardcoded constant makes every client look identical
        // and defeats any version-based reasoning. `CARGO_PKG_VERSION` is the same
        // source Tauri's `package_info().version` derives from (both come from
        // `Cargo.toml`), and matches how the rest of the desktop reports its
        // version (see `cli::version_string`, `agent_deploy`, `agent_setup`).
        "clientVersion": env!("CARGO_PKG_VERSION"),
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
fn emit_agent_state_with_error<R: Runtime>(
    app_handle: &AppHandle<R>,
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
fn emit_agent_state<R: Runtime>(app_handle: &AppHandle<R>, agent_id: &str, state: &str) {
    emit_agent_state_with_error(app_handle, agent_id, state, None);
}

/// Forward an agent's `agent.update_available` notification to the frontend as
/// the `agent-update-available` Tauri event (#1352). Tags it with the desktop's
/// `agent_id` so the per-agent deferred-update banner can key off it.
fn emit_agent_update_available<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
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
fn emit_remote_agent_update_pending<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
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

/// Decide which queued I/O commands survive an agent reconnect (CONC-014).
///
/// While the transport is down the I/O task cannot drain its command channel, so
/// input/resize/control commands issued during the outage buffer up. Replaying
/// buffered terminal **input** into the freshly recovered session is a
/// correctness/safety hazard — stale keystrokes would land in a remote shell the
/// user saw as disconnected — so `SessionInput` is dropped outright. `SessionResize`
/// is coalesced to the latest dimensions per session so the recovered PTY is sized
/// correctly without replaying every intermediate drag. Every other command
/// (registrations, requests, agent-forward, disconnect) is control and is preserved
/// in its original order. The send-side gate (`send_session_input` while
/// `reconnecting`) already drops the bulk of the input; this handles the residue
/// that slipped in before the flag was set and enforces the resize policy.
fn filter_reconnect_backlog(drained: Vec<AgentIoCommand>) -> Vec<AgentIoCommand> {
    let mut kept: Vec<AgentIoCommand> = Vec::new();
    // Latest resize per session, tracked in first-seen order for determinism.
    let mut resize_order: Vec<String> = Vec::new();
    let mut latest_resize: HashMap<String, (u16, u16)> = HashMap::new();
    for cmd in drained {
        match cmd {
            AgentIoCommand::SessionInput { .. } => {
                // Stale keystrokes — never replay into the recovered session.
            }
            AgentIoCommand::SessionResize {
                session_id,
                cols,
                rows,
            } => {
                if !latest_resize.contains_key(&session_id) {
                    resize_order.push(session_id.clone());
                }
                latest_resize.insert(session_id, (cols, rows));
            }
            other => kept.push(other),
        }
    }
    for session_id in resize_order {
        if let Some((cols, rows)) = latest_resize.remove(&session_id) {
            kept.push(AgentIoCommand::SessionResize {
                session_id,
                cols,
                rows,
            });
        }
    }
    kept
}

/// Owns the russh `SshSession` and `Channel` exclusively. Concurrently polls
/// incoming SSH data and outgoing commands using `tokio::select!`. Routes
/// JSON-RPC responses to waiting callers and notifications to registered
/// session output channels.
#[allow(clippy::too_many_arguments)]
/// Structured reconnect-lifecycle log vocabulary (OBS-004).
///
/// Each line carries `agent_id` (and the failure `error`) as a `tracing`
/// **field** rather than interpolating it into the message, so a supporter can
/// filter `termihub.log` by agent across a reconnect. The enclosing
/// [`agent_io_task`] span already scopes these to one agent; the explicit field
/// keeps each line self-describing when read in isolation.
fn log_agent_connection_lost(agent_id: &str) {
    info!(agent_id = %agent_id, "connection lost, attempting reconnect");
}

fn log_agent_reconnected(agent_id: &str) {
    info!(agent_id = %agent_id, "reconnected successfully");
}

fn log_agent_reconnect_failed(agent_id: &str, error: &str) {
    error!(agent_id = %agent_id, error, "reconnection failed");
}

/// Drive one agent's live I/O and reconnect loop.
///
/// Wrapped in an `agent_io` span (OBS-004) keyed by `agent_id`, so every nested
/// log event — handshake, parse errors, reconnect attempts — is groupable and
/// filterable by the agent it belongs to when a `termihub.log` interleaves many
/// concurrent agents.
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip_all, fields(agent_id = %agent_id))]
async fn agent_io_task<R: Runtime>(
    session: SshSession,
    mut channel: russh::Channel<russh::client::Msg>,
    mut command_rx: UnboundedReceiver<AgentIoCommand>,
    command_tx: UnboundedSender<AgentIoCommand>,
    alive: Arc<AtomicBool>,
    reconnecting: Arc<AtomicBool>,
    app_handle: AppHandle<R>,
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
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();
    // Streaming tool runs (#3353): run id → where its notifications go.
    let mut tool_runs: HashMap<String, ToolRunSender> = HashMap::new();
    let mut pending_responses: HashMap<u64, oneshot::Sender<Result<Value, AgentRpcFailure>>> =
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
                                            .send(Err(format!("Write failed: {}", e).into()));
                                    } else {
                                        pending_responses.insert(request_id, response_tx);
                                    }
                                }
                                Err(e) => {
                                    let _ = response_tx.send(Err(e.into()));
                                }
                            }
                        }
                        AgentIoCommand::SessionInput { session_id, data } => {
                            request_id += 1;
                            let encoded = b64.encode(&data);
                            // DUP-001: build the request from the shared param DTO.
                            if let Ok(params) = serde_json::to_value(SessionInputParams {
                                session_id,
                                data: encoded,
                            }) {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::CONNECTION_WRITE,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::SessionResize { session_id, cols, rows } => {
                            request_id += 1;
                            if let Ok(params) = serde_json::to_value(SessionResizeParams {
                                session_id,
                                cols,
                                rows,
                            }) {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::CONNECTION_RESIZE,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::AgentForwardData { stream_id, data } => {
                            request_id += 1;
                            let encoded = b64.encode(&data);
                            if let Ok(params) = serde_json::to_value(AgentForwardDataParams {
                                stream_id,
                                data: encoded,
                            }) {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::AGENT_FORWARD_DATA,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::AgentForwardClose { stream_id } => {
                            request_id += 1;
                            if let Ok(params) =
                                serde_json::to_value(AgentForwardCloseParams { stream_id })
                            {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::AGENT_FORWARD_CLOSE,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::RegisterSession { session_id, output_tx } => {
                            session_outputs.insert(session_id, output_tx);
                        }
                        AgentIoCommand::UnregisterSession { session_id } => {
                            session_outputs.remove(&session_id);
                        }
                        AgentIoCommand::RegisterMonitoring { session_id, monitoring_tx } => {
                            monitoring_outputs.insert(session_id, monitoring_tx.into());
                        }
                        AgentIoCommand::RegisterMonitoringStatus { session_id, status_tx } => {
                            if let Some(route) = monitoring_outputs.get_mut(&session_id) {
                                route.status = Some(status_tx);
                            }
                        }
                        AgentIoCommand::UnregisterMonitoring { session_id } => {
                            monitoring_outputs.remove(&session_id);
                        }
                        AgentIoCommand::RegisterToolRun { run_id, tx } => {
                            tool_runs.insert(run_id, tx);
                        }
                        AgentIoCommand::UnregisterToolRun { run_id } => {
                            tool_runs.remove(&run_id);
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
                            info!("test-only in-process transport sever");
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
                                    Ok(jsonrpc::JsonRpcMessage::Error { id, code, message }) => {
                                        if let Some(tx) = pending_responses.remove(&id) {
                                            let _ = tx.send(Err(AgentRpcFailure { code, message }));
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
                                        ) && !route_tool_run_notification(
                                            &mut tool_runs,
                                            &method,
                                            &params,
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
                                        warn!(error = %e, "failed to parse agent message");
                                    }
                                }
                            }
                        }
                        Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                            // stderr from the remote agent process (SSH_EXTENDED_DATA_STDERR = 1)
                            warn!(stderr = %String::from_utf8_lossy(data), "agent process stderr");
                        }
                        Some(ChannelMsg::Eof) => {
                            // Remote side sent EOF — connection is gone
                            break true;
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            if exit_status != 0 {
                                let msg = format!("Agent process exited with status {}", exit_status);
                                error!(exit_status, "agent process exited with nonzero status");
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

        // The agent cancels a connection's streaming tool runs when it drops
        // (#3353), so none survives into the reconnected session. Drop every
        // route: each run's receiver sees its channel close and fails the run.
        tool_runs.clear();

        // CONC-014: the transport is down and this task will not drain `command_rx`
        // again until the reconnect resolves. Flag it so `send_session_input` drops
        // terminal input at the source for the duration of the outage rather than
        // letting it pile up unbounded and replay stale keystrokes into the
        // recovered session. Cleared after the post-reconnect backlog is filtered
        // below (or left set on the failure path, where the entry is reaped anyway).
        reconnecting.store(true, Ordering::SeqCst);

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
        log_agent_connection_lost(&agent_id);

        // CONC-003: fail every in-flight request the moment the link drops, so
        // its caller (and the `spawn_blocking` thread it pins) unblocks now
        // rather than parking for the entire reconnect window. New requests
        // issued during the outage are bounded separately by the
        // `AGENT_REQUEST_TIMEOUT` in `send_request`. The reconnect-resolved
        // drains below then run against an already-empty map (the io_task does
        // not touch `command_rx`/`pending_responses` while reconnecting).
        for (_, tx) in pending_responses.drain() {
            let _ = tx.send(Err("Agent connection lost".to_string().into()));
        }

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
                // #2556/#2564: the same recovered-id set resolves each hosted
                // session's `session-lifecycle` region entry at the backend source —
                // `Reconnecting → Connected` for a session that survived in place, or
                // `Reconnecting → SessionLost` for one the agent did not recover.
                // Fetch it once when there is either a sender to reconcile or a hosted
                // tab to resolve; skip the extra round-trip when neither applies.
                let hosted = hosted_sessions_for_agent(&app_handle, &agent_id).await;
                // SM-003: sessions the fresh worker found held by another desktop
                // (`connection.evicted`, reason `heldByPeer`, emitted during its
                // start-up recovery) fold the explicit `Evicted` state *before* the
                // resolve below, so a peer-held — alive — session is never
                // relabelled "session lost". The dispatch above also spawns this
                // fold; doing it inline here orders it ahead of the resolve.
                let held_elsewhere = evicted_session_ids(&reconnect_notifications);
                fold_evicted_hosted_sessions(&app_handle, &hosted, &held_elsewhere);
                if !session_outputs.is_empty()
                    || !monitoring_outputs.is_empty()
                    || !hosted.is_empty()
                {
                    // SM-001: the transport is back, but the hosted tabs are still
                    // folded to `Reconnecting(Idle)` (no timer armed — the in-task
                    // loop owns the break). They are resolved off `Reconnecting`
                    // ONLY from the `connection.list` result here, so this call must
                    // ALWAYS settle them to a terminal outcome. `list_recovered_
                    // session_ids` has no timeout of its own, so a bounded, per-
                    // attempt-timed retry both recovers a transient first failure and
                    // guarantees this returns (a hung agent can no longer strand the
                    // task — and every hosted tab — in a no-exit reconnecting state).
                    let live_ids = list_recovered_session_ids_bounded(
                        &mut channel,
                        &agent_id,
                        &mut request_id,
                    )
                    .await;
                    if let Some(ref live_ids) = live_ids {
                        // SM-003: keep the output sender of every evicted hosted
                        // session too — it is alive on another desktop, and an
                        // explicit Reclaim re-attaches it through the same channel.
                        let mut keep = live_ids.clone();
                        keep.extend(evicted_remote_ids(&app_handle, &hosted));
                        reconcile_output_senders(
                            &mut session_outputs,
                            &mut monitoring_outputs,
                            &keep,
                        );
                    }
                    // Always resolve: `Some` → recovered/lost per the listed ids;
                    // `None` (list unavailable after the bounded budget) → settle every
                    // hosted tab to the terminal `SessionLost` state rather than leaving
                    // it stuck `Reconnecting` forever (SM-001).
                    resolve_hosted_sessions_after_reconnect(
                        &app_handle,
                        &hosted,
                        live_ids.as_ref(),
                    )
                    .await;
                }

                // CONC-014: filter the command backlog that accumulated in the
                // narrow window between the transport dying and `reconnecting` being
                // set (the send-side gate drops the bulk of it, but a few frames can
                // slip in). Terminal `SessionInput` is dropped so stale keystrokes
                // are never replayed into the recovered session; `SessionResize` is
                // coalesced to the latest per session so the recovered PTY still gets
                // correct dimensions; all control commands are preserved in order.
                // Survivors are re-queued through `command_tx` and processed normally
                // by the resumed loop. Clear the flag only after this drain so no new
                // input races in ahead of it.
                let mut drained = Vec::new();
                while let Ok(cmd) = command_rx.try_recv() {
                    drained.push(cmd);
                }
                for cmd in filter_reconnect_backlog(drained) {
                    let _ = command_tx.send(cmd);
                }
                reconnecting.store(false, Ordering::SeqCst);

                emit_agent_state(&app_handle, &agent_id, "connected");
                log_agent_reconnected(&agent_id);
                // Notify all pending requests that the connection was lost
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err("Connection lost during request".to_string().into()));
                }
                continue 'outer;
            }
            Err(e) => {
                log_agent_reconnect_failed(&agent_id, &e);
                // #2612/#2564: the in-task reconnect budget is exhausted — fold every
                // hosted session's `session-lifecycle` region entry `Reconnecting →
                // Failed` at the backend source with the reconnect error, the same
                // authority the "Reconnect failed" overlay reads, rather than leaving it
                // stuck `Reconnecting` for the frontend `disconnected` handler to resolve
                // (whose `session.connectFailed` mirror was a no-op while the region read
                // `reconnecting`). Folded before the agent-state event so the overlay /
                // tab-dot readers see the failed region.
                fold_agent_hosted_reconnect_failed(&app_handle, &agent_id, &e).await;
                emit_agent_state_with_error(&app_handle, &agent_id, "disconnected", Some(&e));
                alive.store(false, Ordering::SeqCst);
                // G6 (#1239): self-reap our own map entry instead of leaving a
                // zombie for lazy eviction on the next `connect_agent`.
                reap_agent(&agents, &agent_id);
                // Notify all pending requests
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err("Agent disconnected".to_string().into()));
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

/// Fold every hosted session's `session-lifecycle` region entry to the terminal
/// `Failed` state at the backend source when the agent's in-task reconnect loop
/// exhausts its budget (#2612/#2564). The fully-failed twin of
/// [`fold_agent_hosted_reconnecting`]: the in-task loop owns the transient break, so it
/// folds the definitive failure itself with the reconnect error rather than leaving the
/// region `Reconnecting` for the frontend `disconnected` resolver. Loop-idle, so no
/// redrive is armed for a definitively-failed session. Off-path no-op when the
/// `SessionManager` is not managed (a headless projection unit-test app).
pub(crate) async fn fold_agent_hosted_reconnect_failed<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    error: &str,
) {
    let Some(manager) = app_handle.try_state::<SessionManager>() else {
        return;
    };
    for hosted in manager.agent_hosted_sessions(agent_id).await {
        fold_agent_reconnect_failed(app_handle, &hosted.tab_id, Some(error));
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

/// Resolve each hosted session's region entry after a successful in-task reconnect,
/// folded at the **backend source** rather than the frontend `TerminalView`
/// resolver:
///  - a session the agent recovered **in place** (its `remote_session_id` is in
///    `live_ids`) folds back to `Connected` — the survived-recovery half of #2556;
///  - a session the agent did **not** recover (absent from `live_ids`) folds the
///    terminal `SessionLost` state — the gone-session half (#2564). Previously this
///    was left `Reconnecting` for the frontend `TerminalView` `connected` handler to
///    resolve via `setTerminalExited`; the backend now owns the region authority so
///    the "Session lost" overlay renders straight from the region (#2512). The
///    frontend only reflects the local presentation view-state (`terminalExitedTabs`,
///    which mounts the overlay) via `settleSessionLost`, pending the full
///    view-state migration (#2139).
///
/// The fully-failed (`agent → disconnected`, the agent's in-task reconnect loop
/// exhausted) resolve is folded by its sibling [`fold_agent_hosted_reconnect_failed`]
/// (`Reconnecting → Failed`, #2612/#2564). The remaining frontend-owned piece is the
/// local terminal **view-state** (`terminalExitedTabs` / `terminalViewMode` /
/// `terminalExitInfo`), which mounts the overlay and has no server-side home until the
/// stateless-UI view-state migration (#2139); a precise follow-up carries it.
pub(crate) async fn resolve_agent_hosted_sessions<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    live_ids: &std::collections::HashSet<String>,
) {
    for h in hosted {
        if live_ids.contains(&h.remote_session_id) {
            // Guard the user-cancel race (SM-002). The agent recovered this session
            // in place, but if the user hit Stop while the transport was
            // re-establishing, `cancel_reconnect` (store.rs) has already folded the
            // tab to `Disconnected(User)` — or the tab was removed. Silently folding
            // `Connected` here would resurrect a tab the user explicitly Stopped and
            // re-adopt a session they asked to abandon. So only fold when the tab is
            // still `Reconnecting`; otherwise tear the recovered agent session down
            // instead of adopting it, mirroring the redrive create/re-attach guard
            // (`redrive.rs` `still_connecting`), so nothing outlives the cancelled tab.
            if still_reconnecting(app_handle, &h.tab_id) {
                fold_agent_session_recovered(app_handle, &h.tab_id);
            } else if is_evicted_tab(app_handle, &h.tab_id) {
                // SM-003: an evicted tab's session is controlled by (or was just
                // released by) another desktop. Never tear it down — that would
                // kill the other desktop's live process — and never silently
                // re-claim it: the tab waits for an explicit Reclaim.
            } else if let Some(manager) = app_handle.try_state::<SessionManager>() {
                let _ = manager.close_session(&h.session_id).await;
            }
        } else {
            fold_agent_session_lost(app_handle, &h.tab_id);
        }
    }
}

/// Whether the tab is in the sticky SM-003 `Evicted` state.
pub(crate) fn is_evicted_tab<R: Runtime>(app: &AppHandle<R>, tab_id: &str) -> bool {
    app.try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.status(tab_id))
        == Some(SessionStatus::Evicted)
}

/// The remote session ids of every hosted session whose tab is `Evicted` (SM-003).
fn evicted_remote_ids<R: Runtime>(
    app: &AppHandle<R>,
    hosted: &[AgentHostedSession],
) -> Vec<String> {
    hosted
        .iter()
        .filter(|h| is_evicted_tab(app, &h.tab_id))
        .map(|h| h.remote_session_id.clone())
        .collect()
}

/// The session ids named by `connection.evicted` notifications (SM-003).
pub(crate) fn evicted_session_ids(
    notifications: &[(String, Value)],
) -> std::collections::HashSet<String> {
    notifications
        .iter()
        .filter(|(method, _)| method == termihub_core::protocol::methods::CONNECTION_EVICTED)
        .filter_map(|(_, params)| params["session_id"].as_str().map(str::to_string))
        .collect()
}

/// Fold every hosted tab whose remote session is in `evicted` to the explicit
/// `Evicted` state (SM-003, single-attach): another desktop controls it now.
pub(crate) fn fold_evicted_hosted_sessions<R: Runtime>(
    app: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    evicted: &std::collections::HashSet<String>,
) {
    for h in hosted {
        if evicted.contains(&h.remote_session_id) {
            fold_agent_session_evicted(app, &h.tab_id);
        }
    }
}

/// Route a live `connection.evicted` notification (SM-003): fold the hosted tab
/// attached to that remote session to `Evicted`. Resolving the tab needs the
/// (async) session manager, so the fold runs on a spawned task.
fn handle_session_evicted_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
    let Some(remote_sid) = params["session_id"].as_str() else {
        return;
    };
    info!(
        agent_id = %agent_id,
        remote_session_id = %remote_sid,
        "agent session taken over by another desktop (SM-003)"
    );
    let app = app_handle.clone();
    let agent_id = agent_id.to_string();
    let evicted: std::collections::HashSet<String> = [remote_sid.to_string()].into();
    tauri::async_runtime::spawn(async move {
        let hosted = hosted_sessions_for_agent(&app, &agent_id).await;
        fold_evicted_hosted_sessions(&app, &hosted, &evicted);
    });
}

/// Whether the tab is still in the `Reconnecting` status — the guard the agent-task
/// recover resolve uses to avoid flipping a user-Stopped tab back to `Connected`
/// (SM-002). The agent transport reconnect leaves the reconnect engine `Idle` with
/// the status `Reconnecting` (unlike the redrive's `Connecting` sub-phase), so the
/// guard keys on the status, not the engine phase. A cancelled tab has folded to
/// `Disconnected(User)` and a removed tab has no entry — both fail the check and take
/// the teardown path.
fn still_reconnecting<R: Runtime>(app: &AppHandle<R>, tab_id: &str) -> bool {
    app.try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.status(tab_id))
        == Some(SessionStatus::Reconnecting)
}

/// Resolve every hosted session's region entry after the agent's in-task transport
/// reconnect, given the post-reconnect `connection.list` result — the single point
/// that lifts a hosted tab out of `Reconnecting` (SM-001).
///
///  - `Some(live_ids)`: delegate to [`resolve_agent_hosted_sessions`] — a session the
///    agent recovered in place folds back to `Connected`, one it did not folds the
///    terminal `SessionLost` state (#2564).
///  - `None`: the transport came back but `connection.list` never answered within the
///    bounded retry budget, so which sessions survived cannot be confirmed. Settle
///    **every** hosted tab to the terminal `SessionLost` state via
///    [`fold_agent_session_unconfirmed`]. Leaving them `Reconnecting` here is the
///    SM-001 no-exit state: the fold keeps the reconnect loop `Idle`, the backend
///    timer arms only on `Waiting`, and no other task drives the machine — so nothing
///    would ever move the tab again except a manual Stop. Settling instead surfaces an
///    honest, actionable failure (the "session lost" overlay with a manual restart).
pub(crate) async fn resolve_hosted_sessions_after_reconnect<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    live_ids: Option<&std::collections::HashSet<String>>,
) {
    match live_ids {
        Some(live_ids) => resolve_agent_hosted_sessions(app_handle, hosted, live_ids).await,
        None => {
            for h in hosted {
                fold_agent_session_unconfirmed(app_handle, &h.tab_id);
            }
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
    monitoring_outputs: &mut HashMap<String, MonitoringRoute>,
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
/// Number of `connection.list` attempts after an in-task transport reconnect before
/// giving up and settling the hosted tabs (SM-001). The transport is already back, so a
/// first failure is usually transient; a small bounded retry recovers it while still
/// guaranteeing the loop always terminates.
const RECOVERY_LIST_ATTEMPTS: u32 = 3;

/// Wall-clock cap per post-reconnect `connection.list` attempt (SM-001).
/// [`list_recovered_session_ids`] reads via [`read_handshake_line`], which has **no
/// timeout of its own** — so without this a reconnected-but-unresponsive agent that never
/// answers `connection.list` would block `agent_io_task`, and every hosted tab, forever.
/// Bounding each attempt guarantees the resolve path is always reached.
const RECOVERY_LIST_ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Delay between bounded `connection.list` retry attempts (SM-001).
const RECOVERY_LIST_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// Bounded, per-attempt-timed wrapper over [`list_recovered_session_ids`] (SM-001).
///
/// Retries the list up to [`RECOVERY_LIST_ATTEMPTS`] times, each attempt capped at
/// [`RECOVERY_LIST_ATTEMPT_TIMEOUT`], so a transient failure right after reconnect
/// recovers while a hung agent can never strand the task. Returns the first successful
/// list, or `None` once the budget is exhausted — the caller then settles the hosted tabs
/// to a terminal state rather than leaving them stuck `Reconnecting`.
async fn list_recovered_session_ids_bounded(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
) -> Option<std::collections::HashSet<String>> {
    for attempt in 1..=RECOVERY_LIST_ATTEMPTS {
        match tokio::time::timeout(
            RECOVERY_LIST_ATTEMPT_TIMEOUT,
            list_recovered_session_ids(channel, agent_id, request_id),
        )
        .await
        {
            Ok(Some(ids)) => return Some(ids),
            Ok(None) => warn!(
                "Agent {}: connection.list after reconnect failed (attempt {}/{})",
                agent_id, attempt, RECOVERY_LIST_ATTEMPTS
            ),
            Err(_) => warn!(
                "Agent {}: connection.list after reconnect timed out (attempt {}/{})",
                agent_id, attempt, RECOVERY_LIST_ATTEMPTS
            ),
        }
        if attempt < RECOVERY_LIST_ATTEMPTS {
            tokio::time::sleep(RECOVERY_LIST_RETRY_DELAY).await;
        }
    }
    warn!(
        "Agent {}: connection.list unavailable after {} attempts; settling hosted sessions",
        agent_id, RECOVERY_LIST_ATTEMPTS
    );
    None
}

async fn list_recovered_session_ids(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
) -> Option<std::collections::HashSet<String>> {
    *request_id += 1;
    let req_id = *request_id;
    let line = serialize_request(
        req_id,
        termihub_core::protocol::methods::CONNECTION_LIST,
        serde_json::json!({}),
    )
    .ok()?;
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
                // Parse the reply into the shared `SessionListResult` DTO (DUP-001);
                // a malformed reply degrades to an empty id set.
                let ids = serde_json::from_value::<SessionListResult>(result)
                    .map(|r| r.sessions.into_iter().map(|e| e.session_id).collect())
                    .unwrap_or_default();
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
fn dispatch_agent_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    monitoring_outputs: &HashMap<String, MonitoringRoute>,
    b64: &base64::engine::GeneralPurpose,
) {
    if method == termihub_core::protocol::methods::AGENT_UPDATE_AVAILABLE {
        emit_agent_update_available(app_handle, agent_id, params);
    }
    if method == termihub_core::protocol::methods::AGENT_UPDATE_PENDING {
        emit_remote_agent_update_pending(app_handle, agent_id, params);
    }
    if method == termihub_core::protocol::methods::CONNECTION_EVICTED {
        handle_session_evicted_notification(app_handle, agent_id, params);
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
    use termihub_core::protocol::methods::{
        AGENT_FORWARD_CLOSE, AGENT_FORWARD_DATA, AGENT_FORWARD_OPEN,
    };
    match method {
        m if m == AGENT_FORWARD_OPEN => {
            if let Some(stream_id) = params["stream_id"].as_str() {
                agent_forward.on_open(stream_id.to_string(), command_tx.clone());
            }
            true
        }
        m if m == AGENT_FORWARD_DATA => {
            if let (Some(stream_id), Some(data_b64)) =
                (params["stream_id"].as_str(), params["data"].as_str())
            {
                if let Ok(data) = b64.decode(data_b64) {
                    agent_forward.on_data(stream_id, data);
                }
            }
            true
        }
        m if m == AGENT_FORWARD_CLOSE => {
            if let Some(stream_id) = params["stream_id"].as_str() {
                agent_forward.on_close(stream_id);
            }
            true
        }
        _ => false,
    }
}

/// Route a streaming tool run notification (`tool.event` / `tool.done`,
/// #3353) to its registered run, returning `true` if it was one. `tool.done`
/// also drops the route — it is always the run's last message. Notifications for
/// an unknown run (already unregistered, or from before a reconnect) are dropped.
fn route_tool_run_notification(
    tool_runs: &mut HashMap<String, ToolRunSender>,
    method: &str,
    params: &Value,
) -> bool {
    use termihub_core::protocol::methods::{
        ToolDoneNotification, ToolEventNotification, TOOL_DONE, TOOL_EVENT,
    };
    match method {
        m if m == TOOL_EVENT => {
            if let Ok(n) = serde_json::from_value::<ToolEventNotification>(params.clone()) {
                if let Some(tx) = tool_runs.get(&n.run_id) {
                    let _ = tx.send(ToolRunMessage::Events(n.events));
                }
            }
            true
        }
        m if m == TOOL_DONE => {
            if let Ok(n) = serde_json::from_value::<ToolDoneNotification>(params.clone()) {
                if let Some(tx) = tool_runs.remove(&n.run_id) {
                    let _ = tx.send(ToolRunMessage::Done(n));
                }
            }
            true
        }
        _ => false,
    }
}

/// Handle a notification from the agent.
///
/// Routes `connection.output` to session output channels,
/// `connection.monitoring.data` to monitoring channels, and
/// `connection.monitoring.status` to the monitor's status channel when it
/// registered one (#3321). Any other method — including one a newer agent adds
/// that this build does not know — is ignored.
fn handle_notification(
    method: &str,
    params: &Value,
    session_outputs: &HashMap<String, OutputSender>,
    monitoring_outputs: &HashMap<String, MonitoringRoute>,
    b64: &base64::engine::GeneralPurpose,
) {
    use termihub_core::protocol::methods::{
        CONNECTION_MONITORING_DATA, CONNECTION_MONITORING_STATUS, CONNECTION_OUTPUT,
    };
    match method {
        m if m == CONNECTION_OUTPUT => {
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
        m if m == CONNECTION_MONITORING_DATA => {
            let host = match params["host"].as_str() {
                Some(s) => s,
                None => return,
            };
            let stats: SystemStats = match serde_json::from_value(params.clone()) {
                Ok(s) => s,
                Err(_) => return,
            };
            if let Some(route) = monitoring_outputs.get(host) {
                let _ = route.stats.try_send(stats);
            }
        }
        m if m == CONNECTION_MONITORING_STATUS => {
            // An unparseable report (e.g. a status value this build does not
            // know) is dropped; the monitor keeps inferring from samples.
            let report: MonitoringStatusNotification = match serde_json::from_value(params.clone())
            {
                Ok(r) => r,
                Err(_) => return,
            };
            if let Some(status_tx) = monitoring_outputs
                .get(&report.host)
                .and_then(|route| route.status.as_ref())
            {
                let _ = status_tx.try_send(report);
            }
        }
        _ => {}
    }
}

/// Poll cadence for the reconnect connect-cancellation watcher (CONC-002).
const RECONNECT_CANCEL_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Fire `token` as soon as the shared `alive` flag goes `false`.
///
/// Bridges the reconnect path's `alive` [`AtomicBool`] — flipped by a user
/// Disconnect or app shutdown (see [`disconnect_agent`](AgentConnectionManager::disconnect_agent))
/// — to the [`CancellationToken`] the cancellable SSH connect selects on, so a
/// hung reconnect to a black-holed host aborts promptly instead of parking the
/// I/O task for the full connect timeout (CONC-002). Returns once it has fired
/// the token; the caller aborts it when the connect completes first.
async fn cancel_connect_when_disconnected(alive: Arc<AtomicBool>, token: CancellationToken) {
    while alive.load(Ordering::SeqCst) {
        tokio::time::sleep(RECONNECT_CANCEL_POLL_INTERVAL).await;
    }
    token.cancel();
}

/// Agent reconnect backoff as a canonical [`BackoffConfig`] (SM-020 slice 3).
///
/// The agent's long-standing schedule — a 1 s first retry, doubling up to a 30 s
/// ceiling, 10 attempts — now driven through the shared [`reconnect_reducer`]
/// engine instead of a hand-rolled capped-exponential. `jitter_ratio: 0.0` keeps
/// the schedule deterministic and byte-identical (1, 2, 4, 8, 16, 30, 30, 30,
/// 30, 30 s) to what it replaced; the agent-reconnect golden-vector test pins
/// that equivalence. These numbers equal the workspace `DEFAULT_BACKOFF` in every
/// field except `jitter_ratio` (which `DEFAULT_BACKOFF` sets to `0.2`), so the
/// agent path spells its jitterless config out explicitly rather than reusing it.
const AGENT_BACKOFF: BackoffConfig = BackoffConfig {
    base_delay_ms: 1_000.0,
    factor: 2.0,
    max_delay_ms: 30_000.0,
    max_attempts: 10,
    jitter_ratio: 0.0,
};

/// Attempt to reconnect to an agent with exponential backoff.
///
/// Respects the `alive` flag — if it becomes `false` during the inter-attempt
/// delay the function returns immediately so the caller can exit cleanly. The
/// per-attempt SSH connect is also cancellable on `alive` (CONC-002), so a
/// Disconnect during a hung connect aborts it without waiting out the timeout.
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
    // SM-020 slice 3: the reconnect delay, attempt count, and give-up decision
    // are driven through the canonical reconnect engine ([`reconnect_backoff`])
    // rather than a hand-rolled capped-exponential. Jitter is disabled
    // ([`AGENT_BACKOFF`]), so the RNG is never consulted and the schedule stays
    // deterministic and byte-identical to what it replaced. The separate bounded
    // `connection.list` re-probe budget and the `fold_agent_session_*` paths are
    // unchanged.
    let mut no_jitter = || 0.0;
    // A fresh drop arms the first backoff window.
    let mut state = reconnect_reducer(
        &INITIAL_RECONNECT_STATE,
        ReconnectEvent::Drop,
        &AGENT_BACKOFF,
        &mut no_jitter,
    );

    while state.phase == ReconnectPhase::Waiting {
        // The armed backoff delay for the attempt about to start.
        let backoff = tokio::time::Duration::from_millis(state.delay_ms.max(0) as u64);
        // The backoff timer fires: begin an attempt (advances the attempt count).
        state = reconnect_reducer(
            &state,
            ReconnectEvent::Attempt,
            &AGENT_BACKOFF,
            &mut no_jitter,
        );
        // 0-based attempt index, preserved for the existing `attempt + 1` logs.
        let attempt = state.attempt - 1;

        // Sleep in small increments so we can respect the alive flag promptly
        let deadline = tokio::time::Instant::now() + backoff;
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

        // 1. Connect — cancellable so a user Disconnect / app shutdown (which
        //    flips `alive`) aborts a hung connect to a black-holed host promptly,
        //    instead of parking the I/O task for the whole connect timeout
        //    (CONC-002). The connect itself stays bounded by the 45 s
        //    `SshConfig::connect_timeout`. A watcher task fires the token the
        //    moment `alive` goes false and is aborted once the connect returns.
        let connect_token = CancellationToken::new();
        let cancel_watcher = tokio::spawn(cancel_connect_when_disconnected(
            alive.clone(),
            connect_token.clone(),
        ));
        let connect_result = connect_and_authenticate_cancellable(&ssh_config, connect_token);
        cancel_watcher.abort();
        let session = match connect_result {
            Ok(s) => s,
            Err(e) => {
                // A Disconnect that fired the token aborts the loop now rather
                // than looping into another backoff (CONC-002).
                if !alive.load(Ordering::SeqCst) {
                    return Err("Reconnect stopped by user".to_string());
                }
                warn!("Reconnect attempt {} failed (SSH): {}", attempt + 1, e);
                state = reconnect_reducer(
                    &state,
                    ReconnectEvent::Failure,
                    &AGENT_BACKOFF,
                    &mut no_jitter,
                );
                continue;
            }
        };

        // 2. Open channel and start agent
        let mut channel = match session.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                warn!("Reconnect attempt {} failed (channel): {}", attempt + 1, e);
                state = reconnect_reducer(
                    &state,
                    ReconnectEvent::Failure,
                    &AGENT_BACKOFF,
                    &mut no_jitter,
                );
                continue;
            }
        };
        let exec_cmd = config.agent_exec_command();
        if let Err(e) = channel.exec(false, exec_cmd.as_str()).await {
            warn!("Reconnect attempt {} failed (exec): {}", attempt + 1, e);
            state = reconnect_reducer(
                &state,
                ReconnectEvent::Failure,
                &AGENT_BACKOFF,
                &mut no_jitter,
            );
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
        let req_line = match serialize_request(
            *request_id,
            termihub_core::protocol::methods::INITIALIZE,
            init_params,
        ) {
            Ok(l) => l,
            Err(e) => {
                warn!(
                    "Reconnect attempt {} failed (serialize init): {}",
                    attempt + 1,
                    e
                );
                state = reconnect_reducer(
                    &state,
                    ReconnectEvent::Failure,
                    &AGENT_BACKOFF,
                    &mut no_jitter,
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
            state = reconnect_reducer(
                &state,
                ReconnectEvent::Failure,
                &AGENT_BACKOFF,
                &mut no_jitter,
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

        // The init handshake did not complete (channel closed / rejected / parse
        // failure): this attempt failed. Arm the next backoff window, or give up
        // once the attempt budget is spent (the `while` then exits).
        state = reconnect_reducer(
            &state,
            ReconnectEvent::Failure,
            &AGENT_BACKOFF,
            &mut no_jitter,
        );
    }

    Err(format!(
        "Failed to reconnect after {} attempts",
        AGENT_BACKOFF.max_attempts
    ))
}

/// Test-only `tracing` capture used by the OBS-004 span/field assertions in this
/// crate (see `session::manager` and this module's tests). A minimal capturing
/// [`Layer`] that records each event's fields plus the fields inherited from its
/// enclosing spans, so a test can assert that a session/agent identity is carried
/// as a **structured field** rather than interpolated into the message.
#[cfg(test)]
pub(crate) mod tracing_capture;

#[cfg(test)]
mod tests;

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
mod russh_reconnect_tests;
