//! Shared agent connection manager — one SSH connection per agent,
//! with multiplexed sessions over JSON-RPC.
//!
//! Each agent runs in a dedicated async tokio task that owns the russh
//! `Channel`. Multiple sessions share the connection, with output
//! notifications routed to per-session `OutputSender` channels.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use base64::Engine;
use serde_json::Value;
#[cfg(test)]
use tauri::Manager;
use tauri::{AppHandle, Runtime, Wry};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use termihub_core::ipc::ndjson::LineSplitter;
use termihub_core::monitoring::MonitoringSender;
use termihub_core::protocol::methods::{
    AgentShutdownParams, AgentShutdownResult, ConnectionCreateParams, ConnectionDefinition,
    ConnectionDeleteParams, ConnectionListResult, ConnectionUpdateParams, FolderCreateParams,
    FolderDefinition, FolderDeleteParams, FolderUpdateParams, SessionAttachParams,
    SessionCloseParams, SessionCreateParams, SessionCreateResult, SessionListEntry,
};
use termihub_core::protocol::methods::{
    ClientCapabilities, EmptyParams, InitializeParams, InitializeResult,
    MonitoringStatusNotification, UpdateAuthToken,
};
use zeroize::Zeroizing;

#[cfg(all(test, unix))]
use crate::agents_projection::store::AgentConnectionState;
use crate::connection::config::AgentSettings;
#[cfg(all(test, unix))]
use crate::session::manager::SessionManager;
use crate::terminal::agent_config_store::{
    decide_reattach, AgentConfigStore, ReattachDecision, RetainedAgentConfig,
};
use crate::terminal::agent_deploy::ConnectedHost;
use crate::terminal::agent_ki_prompt::{recv_excluding_prompts, AgentPromptActivity, KiResponses};
use crate::terminal::agent_update_auth::{token_path_from_initialize, UPDATE_TOKEN_READ_TIMEOUT};
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
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

/// Bound on the post-auth agent handshake — channel open, agent exec, the
/// `initialize` write and the wait for its answer — of a connect or of one
/// reconnect attempt (CONC2-004, #4304). Matches the SSH connect timeout
/// ([`DEFAULT_SSH_CONNECT_TIMEOUT_SECS`]) that already bounds the step before
/// it, so an agent that execs but never answers fails the attempt instead of
/// parking it in `connecting` / `reconnecting` forever.
const AGENT_HANDSHAKE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(termihub_core::config::DEFAULT_SSH_CONNECT_TIMEOUT_SECS);

/// Wait bound for `agent.forward.connect` (#3241): the agent's own target
/// connect gives up after 10 s, so this only adds headroom for the round trip.
const FORWARD_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Pure data types and wire-format parse helpers (ARCH-002 / TAURI-009).
///
/// Carved into a sibling module and re-exported below so every existing
/// `crate::terminal::agent_manager::…` path stays valid.
mod types;
pub use types::*;

/// Agent notification/event dispatch (ARCH-002 / TAURI-009 slice 9, #3772).
///
/// Carved into a sibling module; the I/O task ([`io_task`]) calls these entry points.
mod notifications;
#[cfg(test)]
use notifications::{
    agent_update_available_event, handle_notification, remote_agent_update_pending_event,
};
use notifications::{
    dispatch_agent_notification, handle_agent_forward_notification, route_tool_run_notification,
};

/// Agent I/O task, `agent-state-change` emission, in-task transport reconnect
/// and post-reconnect recovery/eviction folds (ARCH-002 / TAURI-009 final slice,
/// #3794).
///
/// Carved verbatim into sibling modules; the manager below spawns
/// [`agent_io_task`] and emits through [`emit_agent_state`].
mod agent_stderr;
pub(crate) mod files_only;
mod io_lanes;
mod io_task;
mod reattach;
mod reconnect;
mod recovery;
mod state_events;
mod stdout_reader;
pub(crate) use io_lanes::AgentIoSender;
use io_lanes::{GateError, IoBudget, AGENT_IO_DATA_BUDGET, AGENT_IO_MAX_CHUNK};
use io_task::agent_io_task;
#[cfg(all(test, unix))]
use io_task::test_sever_desktop_transport;
#[cfg(test)]
use io_task::{
    filter_reconnect_backlog, log_agent_connection_lost, log_agent_reconnect_failed,
    log_agent_reconnected,
};
use reattach::reattach_after_reconnect;
use reconnect::reconnect_agent;
#[cfg(test)]
use reconnect::AGENT_RECONNECT_POLICY;
#[cfg(test)]
use reconnect::{cancel_connect_when_disconnected, RECONNECT_CANCEL_POLL_INTERVAL};
#[cfg(test)]
pub(crate) use recovery::resolve_agent_hosted_sessions;
use recovery::{
    evicted_remote_ids, hosted_sessions_for_agent, list_recovered_session_ids_bounded,
    reconcile_output_senders,
};
pub(crate) use recovery::{
    evicted_session_ids, fold_agent_hosted_reconnect_failed, fold_agent_hosted_reconnecting,
    fold_evicted_hosted_sessions, is_evicted_tab, resolve_hosted_sessions_after_reconnect,
};
#[cfg(test)]
use state_events::parse_agent_connection_state;
use state_events::{emit_agent_state, emit_agent_state_with_error};
use stdout_reader::read_handshake_line;

/// A failed agent JSON-RPC request: the agent's error `code` (when it answered
/// with a JSON-RPC error) plus the human message. Carrying the code lets
/// [`AgentConnectionManager::send_request`] map typed refusals to a typed
/// [`TerminalError`] instead of parsing message text (#3404). Local failures
/// (write error, connection lost) carry no code; the ones caused by the agent
/// transport closing are flagged [`transport_closed`](Self::transport_closed)
/// so they map to the typed [`TerminalError::AgentTransportClosed`] (#2840).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentRpcFailure {
    pub code: Option<i64>,
    pub message: String,
    /// The typed connect-failure kind an agent (0.18.0+) sends in the error
    /// `data` of a failed `connection.create` — e.g. an agent-hosted serial
    /// port that is busy (#3751). `None` from an older agent or any other error.
    pub connect_failure: Option<termihub_core::errors::ConnectFailureKind>,
    /// `true` when the request failed because the agent's transport closed
    /// (link drop / EOF / write to a dead channel) before any reply — never an
    /// agent-reported error (#2840). Set only via [`Self::transport_closed`].
    pub transport_closed: bool,
}

/// Why an agent request returned no result: the agent answered with an error
/// (its code kept), or the request failed locally — a timeout, a closed
/// transport, an agent that is not connected (#4299).
#[derive(Debug)]
pub(crate) enum AgentRequestFailure {
    /// The agent answered with a JSON-RPC error (or its transport closed).
    Agent(AgentRpcFailure),
    /// The request failed on this side, typed already.
    Local(TerminalError),
}

impl AgentRequestFailure {
    /// The typed desktop error, exactly as a plain request reports it.
    pub(crate) fn into_terminal_error(self) -> TerminalError {
        match self {
            Self::Agent(failure) => failure.into_terminal_error(),
            Self::Local(error) => error,
        }
    }

    /// The file-level error: only the agent's own `FILE_NOT_FOUND` answer is
    /// [`FileError::NotFound`](termihub_core::errors::FileError::NotFound);
    /// everything else keeps the desktop error's text as an operation failure.
    pub(crate) fn into_file_error(self) -> termihub_core::errors::FileError {
        use termihub_core::errors::FileError;
        match self {
            Self::Agent(failure)
                if !failure.transport_closed
                    && failure.code == Some(termihub_core::protocol::errors::FILE_NOT_FOUND) =>
            {
                FileError::NotFound(failure.message)
            }
            other => FileError::OperationFailed(other.into_terminal_error().to_string()),
        }
    }
}

impl From<String> for AgentRpcFailure {
    fn from(message: String) -> Self {
        Self {
            code: None,
            message,
            connect_failure: None,
            transport_closed: false,
        }
    }
}

impl AgentRpcFailure {
    /// A local failure caused by the agent transport closing before a reply
    /// arrived (#2840): the in-flight request drain on link drop, or a write to
    /// the already-dead channel.
    pub(crate) fn transport_closed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
            connect_failure: None,
            transport_closed: true,
        }
    }

    /// Build the failure from an agent JSON-RPC error response, reading the
    /// optional connect-failure kind from its `data` (#3751). Tolerant: absent
    /// or unrecognised data leaves the failure unclassified.
    pub(crate) fn from_error_response(
        code: Option<i64>,
        message: String,
        data: Option<&Value>,
    ) -> Self {
        Self {
            code,
            message,
            connect_failure:
                termihub_core::protocol::errors::SessionCreateErrorData::connect_failure_from(data),
            transport_closed: false,
        }
    }

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
        if self.transport_closed {
            return TerminalError::agent_transport_closed(self.message);
        }
        match self.code {
            Some(errors::SESSION_HELD_BY_OTHER) => TerminalError::SessionHeldByPeer(self.message),
            Some(errors::METHOD_NOT_FOUND | errors::PROCESS_NOT_SUPPORTED) => {
                TerminalError::AgentUnsupported(self.message)
            }
            // An agent-relayed OTP prompt was cancelled / its code rejected
            // (#3375): the same typed outcomes as a direct SSH connection, so the
            // frontend closes quietly / keeps the saved password.
            Some(termihub_core::protocol::errors::AUTH_CANCELLED) => TerminalError::Cancelled,
            Some(termihub_core::protocol::errors::SECOND_FACTOR_FAILED) => {
                TerminalError::SecondFactorFailed
            }
            // A typed connect failure of an agent-hosted session (#3751): tag
            // the kind so the envelope `code` carries it and the overlay shows
            // the same hint as for a direct connection. The marker is stripped
            // from the displayed message.
            _ => match self.connect_failure {
                // The agent-hosted session's server rejected the credentials
                // (0.19.0, #3089): the same typed auth failure as a direct
                // connection, so the tab folds `authFailed` and offers re-entry.
                Some(termihub_core::errors::ConnectFailureKind::AuthFailed) => {
                    TerminalError::AuthFailed(self.message)
                }
                Some(kind) => TerminalError::RemoteError(crate::utils::errors::with_code(
                    kind.code(),
                    self.message,
                )),
                None => TerminalError::RemoteError(self.message),
            },
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
    /// Pause or resume a session's output on the agent (fire-and-forget,
    /// `connection.output_flow`, #4416).
    SessionOutputFlow { session_id: String, paused: bool },
    /// Register an output sender for a session.
    RegisterSession {
        session_id: String,
        output_tx: OutputSender,
    },
    /// Unregister a session's output sender (and its files-only route, #4081).
    UnregisterSession { session_id: String },
    /// Register the watch a session's proxy reads its files-only verdict from
    /// (#4081), flipped by the agent's `connection.filesOnly` notification.
    RegisterFilesOnly {
        session_id: String,
        files_only_tx: tokio::sync::watch::Sender<bool>,
    },
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
    /// Return window credit for a flow-controlled port-forward stream: the
    /// desktop wrote `bytes` more of it to its graphical backend
    /// (`agent.forward.ack`, #4284).
    AgentForwardAck { stream_id: String, bytes: u64 },
    /// Route the agent's `agent.forward.data` / `ack` / `close` for a desktop
    /// port-forward stream (#3241) into `sink`. Registered *before*
    /// `agent.forward.connect` is sent so no early byte is missed.
    RegisterForwardStream {
        stream_id: String,
        sink: crate::terminal::agent_forward::ForwardSink,
    },
    /// Stop routing a desktop port-forward stream (#3241).
    UnregisterForwardStream { stream_id: String },
    /// Answer (or cancel, `responses: None`) an agent-relayed SSH
    /// keyboard-interactive round (`ssh.keyboard_interactive.respond`, #3375).
    /// Fire-and-forget; the answers stay in zeroizing storage up to the wire and
    /// are never replayed across a reconnect.
    KiRespond {
        request_id: String,
        responses: KiResponses,
    },
    /// Read this agent instance's update auth token (AGT-003, #3213) from the
    /// file its latest `initialize` advertised, over the I/O task's current SSH
    /// session. Replies `None` when the agent advertised no file (an older agent)
    /// or the read failed.
    ReadUpdateAuthToken {
        reply: oneshot::Sender<Option<UpdateAuthToken>>,
    },
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
    #[cfg_attr(
        not(any(all(test, unix), feature = "test-bridge")),
        expect(
            dead_code,
            reason = "test-only transport sever (#2573): reached only via the test bridge or the unix russh tests"
        )
    )]
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
    /// Agent-relayed SSH keyboard-interactive prompts open on this desktop
    /// (#3375). A `connection.create` excludes their time from its timeout.
    ki_activity: Arc<AgentPromptActivity>,
    /// Agent-assigned id for this desktop's own client connection (from the
    /// `initialize` result). Lets [`list_connections`](AgentConnectionManager::list_connections)
    /// exclude this desktop from the connected-host update guard (#1349). Empty
    /// when the agent predates protocol 0.3.0 and did not report one.
    client_id: String,
    /// The (expanded) SSH transport config + settings this connection was
    /// established with (#3661). Lives exactly as long as the connection — the
    /// I/O task already holds the same config for its in-task reconnect — and is
    /// the source [`AgentConnectionManager::retain_agent_config`] promotes into
    /// the reap-surviving [`AgentConfigStore`] when a resilient tab opts in.
    /// Zeroized on drop (see [`RetainedAgentConfig`]).
    reattach_config: RetainedAgentConfig,
}

/// Abstract interface over an agent connection manager.
///
/// Implemented by [`AgentConnectionManager`] in production and by mock
/// structs in tests. Consumers (e.g. [`RemoteProxy`]) depend on this trait
/// so they can be tested without real SSH connections.
///
/// [`RemoteProxy`]: crate::session::remote_proxy::RemoteProxy
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

    /// Disconnect an agent; for an agent that is still connecting, cancel the
    /// connect (#4304).
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError>;

    /// Check if an agent is connected.
    fn is_connected(&self, agent_id: &str) -> bool;

    /// Ids of every agent currently connected (live I/O task), sorted. Used by
    /// the diagnostics export to talk only to agents that are already connected
    /// (#3574). Default empty so mock clients need not implement it.
    fn connected_agent_ids(&self) -> Vec<String> {
        Vec::new()
    }

    /// [`send_request`](Self::send_request) bounded by `timeout` instead of the
    /// default request timeout, for best-effort calls that must not hold a UI
    /// flow for a minute (the diagnostics export, #3574). Defaults to the plain
    /// request so mock clients need not implement it.
    fn send_request_bounded(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
        _timeout: std::time::Duration,
    ) -> Result<Value, TerminalError> {
        self.send_request(agent_id, method, params)
    }

    /// Sweep every agent whose I/O task has already died (`alive == false`),
    /// returning the swept ids. Manual resource-hygiene escape hatch (G6, #1239).
    fn prune_dead_agents(&self) -> Vec<String> {
        Vec::new()
    }

    /// Get the capabilities of a connected agent.
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities>;

    /// `(host, username)` a **connected** agent's SSH transport runs to — the
    /// agent host and account an agent-routed VNC session's files land on
    /// (#4191). Default `None` so mock clients need not implement it.
    fn agent_endpoint(&self, _agent_id: &str) -> Option<(String, String)> {
        None
    }

    /// Retain a **connected** agent's SSH transport config for backend-driven
    /// reconnect reattach (#2472), so it survives a transport reap. Called when a
    /// resilient agent tab connects (#3661); returns whether a live connection's
    /// config was retained. Default no-op returning `false` so mock clients need
    /// not implement it; the production [`AgentConnectionManager`] promotes the
    /// live connection's config into its reattach store.
    fn retain_agent_config(&self, _agent_id: &str) -> bool {
        false
    }

    /// Drop and zeroize the retained reattach config for an agent (#2472).
    /// Default no-op; the production manager scrubs it.
    fn clear_retained_agent_config(&self, _agent_id: &str) {}

    /// Drop and zeroize **every** retained reattach config — the app-quit scrub
    /// point (#3661). Default no-op; the production manager scrubs them all.
    fn clear_all_retained_agent_configs(&self) {}

    /// TEST-ONLY (#2573): abruptly sever the agent's transport in-process to drive
    /// the reconnect path deterministically. Default no-op returning `false` (mock
    /// clients); the production [`AgentConnectionManager`] performs the sever.
    #[cfg_attr(
        not(feature = "test-bridge"),
        expect(
            dead_code,
            reason = "only the test-bridge command calls it through the trait"
        )
    )]
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

    /// Read the connected agent instance's update auth token (AGT-003, #3213),
    /// to send as `authToken` on `agent.request_update` /
    /// `agent.request_deferred_update`. `None` when the agent advertised no
    /// token file (it predates protocol 0.13.0 and needs none) or it could not
    /// be read — the agent then refuses the update. Default `None` so mock
    /// clients need not implement it. Call from a blocking context.
    fn update_auth_token(&self, _agent_id: &str) -> Option<UpdateAuthToken> {
        None
    }

    /// Send a JSON-RPC request to an agent and wait for the response.
    fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError>;

    /// [`send_request`](Self::send_request) for a `connection.files.*` call:
    /// the agent's `FILE_NOT_FOUND` answer comes back as
    /// [`FileError::NotFound`](termihub_core::errors::FileError::NotFound) and
    /// every other failure as an operation failure (#4299). Defaults to the
    /// plain request with every failure untyped — never "not found" — so mock
    /// clients need not implement it.
    fn send_file_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, termihub_core::errors::FileError> {
        self.send_request(agent_id, method, params)
            .map_err(|e| termihub_core::errors::FileError::OperationFailed(e.to_string()))
    }

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

    /// Open a desktop port-forward stream through the agent (#3241): route the
    /// agent's events for `stream_id` into `sink`, then ask the agent to connect
    /// to `host:port` from its host (`agent.forward.connect`), requesting a
    /// flow-control `window` (#4284). Returns the window the agent granted —
    /// `None` from an agent that predates flow control. On failure nothing
    /// stays registered. Call from a blocking context. Default errors so mock
    /// clients need not model forwarding.
    fn open_forward_stream(
        &self,
        agent_id: &str,
        _stream_id: &str,
        _host: &str,
        _port: u16,
        _window: Option<u64>,
        _sink: crate::terminal::agent_forward::ForwardSink,
    ) -> Result<Option<u64>, TerminalError> {
        Err(TerminalError::AgentUnsupported(format!(
            "Agent {agent_id} does not support port forwarding"
        )))
    }

    /// Send desktop→target bytes on a port-forward stream (#3241). Non-blocking.
    fn send_forward_data(
        &self,
        agent_id: &str,
        _stream_id: &str,
        _data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        Err(TerminalError::RemoteError(format!(
            "Agent {agent_id} not connected"
        )))
    }

    /// Return window credit on a flow-controlled port-forward stream
    /// (`agent.forward.ack`, #4284). Non-blocking, never waits behind queued
    /// data. Default no-op.
    fn ack_forward_data(&self, _agent_id: &str, _stream_id: &str, _bytes: u64) {}

    /// Close a port-forward stream from the desktop end (#3241). Best effort,
    /// non-blocking. Default no-op.
    fn close_forward_stream(&self, _agent_id: &str, _stream_id: &str) {}

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

    /// [`create_session`](Self::create_session) on behalf of the desktop
    /// connect `owner` (its `connect_id`, #3437): an SSH keyboard-interactive
    /// round the agent relays while this create runs is attributed to `owner`,
    /// so closing / cancelling that connect cancels it. `correlation_id` is the
    /// desktop session id the agent logs this session under (#3085). Defaults
    /// to a plain create so test doubles need not implement it.
    ///
    /// `unattended` (#3877) asks the agent to connect with nobody at the
    /// keyboard: it never relays a prompt and refuses with a typed kind
    /// instead. Callers send it only to an agent that advertises
    /// [`AgentCapabilities::unattended_connect`]. The default refuses it, so a
    /// test double can never silently connect attended in its place.
    #[allow(clippy::too_many_arguments)]
    fn create_session_owned(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
        _owner: Option<&str>,
        _correlation_id: Option<&str>,
        unattended: bool,
    ) -> Result<AgentSessionInfo, TerminalError> {
        if unattended {
            return Err(TerminalError::SpawnFailed(
                "unattended connect is not supported".to_string(),
            ));
        }
        self.create_session(agent_id, session_type, config, title, definition_id)
    }

    /// The desktop connect `owner` was cancelled (its tab closed, #3437): mark
    /// its in-flight owned creates cancelled on every agent, so a prompt round
    /// they raise from now on is answered `null` instead of shown. Rounds
    /// already open are cancelled through the desktop prompter. Default no-op.
    fn cancel_owned_creates(&self, _owner: &str) {}

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

    /// Register the watch a remote session's files-only verdict is delivered
    /// on (#4081): flipped to `true` when the agent reports that the session's
    /// host refused the shell but serves files. Dropped with the session's
    /// output route. The default does nothing, so the watch never flips.
    fn register_files_only(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        _files_only_tx: tokio::sync::watch::Sender<bool>,
    ) -> Result<(), TerminalError> {
        Ok(())
    }

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

    /// Whether the agent pauses a session's output on request
    /// ([`AgentCapabilities::output_flow`], #4416). Only then does the desktop
    /// pause an agent-hosted session's output reader: pausing it in front of
    /// an agent that keeps streaming would only move the backlog to the
    /// desktop. Read from [`get_capabilities`](Self::get_capabilities), so an
    /// agent that reports none (or a mock that sets none) is never paused.
    fn supports_output_flow(&self, agent_id: &str) -> bool {
        self.get_capabilities(agent_id)
            .is_some_and(|caps| caps.output_flow)
    }

    /// Pause (`true`) or resume (`false`) an agent-hosted session's output
    /// (fire-and-forget `connection.output_flow`, #4416). Non-blocking. A
    /// silent no-op for an agent that does not
    /// [support it](Self::supports_output_flow). Default no-op so mock clients
    /// need not implement it.
    fn set_session_output_paused(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        _paused: bool,
    ) -> Result<(), TerminalError> {
        Ok(())
    }

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
///
/// The registration doubles as the per-agent "connecting" reservation
/// (CONC2-001, #4304): it succeeds only when no connect for `agent_id` is in
/// flight, so the check and the insert are one atomic step and two concurrent
/// connects to the same agent can never both run their handshake. Returns
/// `false` (registering nothing) when a connect is already in flight. A
/// poisoned registry is recovered rather than treated as "busy", so a panic
/// elsewhere cannot lock an agent out of connecting for good.
fn register_connecting_token(
    registry: &ConnectingRegistry,
    agent_id: &str,
    token: CancellationToken,
) -> bool {
    let mut map = registry.lock().unwrap_or_else(|e| e.into_inner());
    if map.contains_key(agent_id) {
        return false;
    }
    map.insert(agent_id.to_string(), token);
    true
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
        // Recover a poisoned registry: a reservation that is never released
        // would refuse every later connect to this agent as "already
        // connecting" (#4304).
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
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

/// Weak back-reference to the [`IoBudgetMap`], held by the I/O task beside the
/// [`WeakAgentMap`] so a self-reap clears its budget entry too (#4304).
type WeakIoBudgetMap = std::sync::Weak<Mutex<HashMap<String, Arc<IoBudget>>>>;

/// What an I/O task needs to self-reap its own manager entry (G6 #1239,
/// CONC2-005 #4304): weak references to the agent map and to the paired
/// per-agent I/O budgets, so the task never keeps the manager alive.
#[derive(Clone)]
struct AgentReaper {
    agents: WeakAgentMap,
    io_budgets: WeakIoBudgetMap,
}

/// Reap an agent's own entry from the manager map via a weak back-reference.
///
/// Called by the I/O task when its reconnect budget is exhausted. The entry is
/// removed **only if it is the one this task owns** — identified by its `alive`
/// flag ([`Arc::ptr_eq`] against `own_alive`) — so a late reap from an old
/// connection's task can never evict a newer connection that a concurrent
/// `connect_agent` has since published under the same id (CONC2-005, #4304).
/// The matching I/O budget is cleared under the same condition and the same
/// `agents` lock (lock order `agents` → `io_budgets`). A dropped manager (dead
/// `Weak`) or poisoned lock is treated as a no-op — there is nothing left to
/// clean up.
fn reap_agent(reaper: &AgentReaper, agent_id: &str, own_alive: &Arc<AtomicBool>) {
    // `upgrade()` must be bound so the strong `Arc` outlives the guard it lends.
    let Some(agents) = reaper.agents.upgrade() else {
        return;
    };
    let Ok(mut guard) = agents.lock() else {
        return;
    };
    let owns_entry = guard
        .get(agent_id)
        .is_some_and(|conn| Arc::ptr_eq(&conn.alive, own_alive));
    if !owns_entry {
        return;
    }
    guard.remove(agent_id);
    if let Some(budgets) = reaper.io_budgets.upgrade() {
        if let Some(budget) = budgets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(agent_id)
        {
            budget.close();
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
    /// populated when a resilient agent tab opts in via
    /// [`Self::retain_agent_config`] (#3661). See
    /// [`crate::terminal::agent_config_store`].
    agent_configs: AgentConfigStore,
    /// Per-agent data-credit budgets bounding the I/O command queue (#3018),
    /// keyed by agent id. Written only under the `agents` lock (lock order:
    /// `agents` → `io_budgets`), together with the matching map entry, so a
    /// producer always pairs a connection's sender with that connection's own
    /// budget. See [`io_lanes`].
    io_budgets: IoBudgetMap,
    /// Bound on the post-auth connect handshake ([`AGENT_HANDSHAKE_TIMEOUT`];
    /// shortened only by tests).
    handshake_timeout: std::time::Duration,
    app_handle: AppHandle<R>,
}

/// Agent id → the data-credit budget of its current I/O task (#3018).
type IoBudgetMap = Arc<Mutex<HashMap<String, Arc<IoBudget>>>>;

impl<R: Runtime> AgentConnectionManager<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            agents: Arc::new(Mutex::new(HashMap::new())),
            connecting: Arc::new(Mutex::new(HashMap::new())),
            agent_configs: AgentConfigStore::new(),
            io_budgets: Arc::new(Mutex::new(HashMap::new())),
            handshake_timeout: AGENT_HANDSHAKE_TIMEOUT,
            app_handle,
        }
    }

    /// TEST-ONLY: shorten the post-auth connect handshake bound so a
    /// never-answering agent times out within a test's budget (#4304).
    #[cfg(test)]
    pub(crate) fn set_handshake_timeout_for_test(&mut self, timeout: std::time::Duration) {
        self.handshake_timeout = timeout;
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
        // Expand `${env:…}` / `~` placeholders in the non-secret fields (host,
        // username, key path) exactly as sibling connection types do on their
        // spawn path (#3661). Every agent connect funnels through here — the
        // `connect_agent` command and the redrive's cold re-establish
        // (`reconnect_retained_agent`) — and the in-task reconnect loop reuses
        // the expanded copy captured below. The password is left verbatim.
        let expanded = config.clone().expand();
        let config = &expanded;

        // CONC2-001 (#4304): the `agents` lock is held only for this short
        // check-evict-reserve step and again to publish the finished connection
        // — never across the SSH connect, its auth prompts or the `initialize`
        // handshake, so connecting one agent no longer freezes every other
        // agent operation (and the main-thread commands and session writes that
        // read the map).
        let cancel_token = CancellationToken::new();
        {
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
            }

            // Reserve the agent for this connect (#4304) and register the
            // cancellation token a Cancel fires (G1, #1235) in one atomic step.
            // A second connect to the same agent while this one is in flight is
            // refused as already connected instead of running a duplicate
            // handshake. Reserved under the `agents` lock (lock order `agents` →
            // `connecting`, as in `disconnect_agent`) so a Disconnect either sees
            // the reservation and cancels it, or runs before it exists.
            if !register_connecting_token(&self.connecting, agent_id, cancel_token.clone()) {
                return Err(TerminalError::already_connected(format!(
                    "Agent {} is already connecting",
                    agent_id
                )));
            }

            // CONC-009: force-stop the outgoing task as a fallback. A "dead" entry
            // usually means the task already returned (abort is then a harmless
            // no-op), but a task wedged in a blocking op would otherwise leak its
            // SSH session behind the fresh connection replacing it here. Its
            // budget goes with it, under the same lock that pairs them (#3018).
            if let Some(old) = agents.remove(agent_id) {
                old.io_task.abort();
                if let Some(budget) = self
                    .io_budgets
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(agent_id)
                {
                    budget.close();
                }
            }
        }
        // The guard releases the reservation when this connect finishes
        // (success, failure or cancellation), even on an early `?` return.
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
        // Weak back-references so the spawned I/O task can self-reap its own map
        // entry (and budget) on an exhausted reconnect without keeping the
        // manager alive (G6, #4304).
        let reaper = AgentReaper {
            agents: Arc::downgrade(&self.agents),
            io_budgets: Arc::downgrade(&self.io_budgets),
        };
        let handshake_timeout = self.handshake_timeout;

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

            // 2-3. The post-auth handshake, bounded as one step (CONC2-004,
            // #4304): an agent that opens, execs and then never answers
            // `initialize` fails the connect after `handshake_timeout` instead of
            // leaving it in `connecting` forever. A Cancel still aborts it at
            // once through the enclosing `run_connect_cancellable`.
            let request_id: u64 = 1;
            let handshake = tokio::time::timeout(handshake_timeout, async {
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
                let mut line_buf = LineSplitter::new();
                let (capabilities, agent_version, protocol_version, client_id, update_auth_token_path) = loop {
                    let resp_line =
                        match read_handshake_line(&mut channel, &agent_id_str, &mut line_buf).await {
                            Ok(line) => line,
                            Err(e) => {
                                emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                                return Err(TerminalError::RemoteError(match e {
                                    stdout_reader::AgentReadError::Closed => {
                                        "Channel closed before initialize response".into()
                                    }
                                    other => format!("Initialize read failed: {other}"),
                                }));
                            }
                        };

                    let msg = jsonrpc::parse_message(&resp_line).map_err(|e| {
                        emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                        TerminalError::RemoteError(format!("Parse initialize response: {}", e))
                    })?;

                    match jsonrpc::classify_handshake_message(msg, request_id) {
                        jsonrpc::HandshakeOutcome::Response(result) => {
                            // Parse into the shared `InitializeResult` DTO (DUP-001,
                            // #3226), with the desktop's own capabilities type so
                            // `connectionTypes` stays pass-through JSON for the
                            // frontend. Missing versions read as "unknown" and a
                            // missing `client_id` (pre-0.3.0 agent) as empty.
                            let init = parse_initialize_result(result).map_err(|e| {
                                emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                                TerminalError::RemoteError(e)
                            })?;
                            // AGT-003 (#3213): where this instance's update auth token
                            // lives (protocol 0.13.0+; absent on older agents).
                            let update_auth_token_path = token_path_from_initialize(&init);
                            let InitializeResult {
                                protocol_version,
                                agent_version,
                                client_id,
                                mut capabilities,
                                ..
                            } = init;
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
                            break (
                                capabilities,
                                agent_version,
                                protocol_version,
                                client_id,
                                update_auth_token_path,
                            );
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
                Ok::<_, TerminalError>((
                    channel,
                    capabilities,
                    agent_version,
                    protocol_version,
                    client_id,
                    update_auth_token_path,
                    pending_notifications,
                ))
            })
            .await;
            let (
                channel,
                capabilities,
                agent_version,
                protocol_version,
                client_id,
                update_auth_token_path,
                pending_notifications,
            ) = match handshake {
                Ok(done) => done?,
                Err(_elapsed) => {
                    emit_agent_state(&app_handle_clone, &agent_id_str, "disconnected");
                    return Err(TerminalError::RemoteError(format!(
                        "Agent handshake timed out: no initialize response within {}s",
                        handshake_timeout.as_secs_f32()
                    )));
                }
            };

            // 4. Spawn the async I/O task
            let alive = Arc::new(AtomicBool::new(true));
            let reconnecting = Arc::new(AtomicBool::new(false));
            // #3018: the command ingress is bounded by a per-agent data-credit
            // budget rather than by channel slots. Producers of terminal input and
            // forwarded bytes wait for credit (backpressure, nothing dropped);
            // control commands are never gated and the I/O task serves them ahead
            // of queued data. Survivors of a reconnect keep their credit, so the
            // task never waits on its own queue. See `io_lanes`.
            let io_budget = IoBudget::new(AGENT_IO_DATA_BUDGET);
            let (command_tx, command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();

            let alive_clone = alive.clone();
            let reconnecting_clone = reconnecting.clone();
            let app_handle_task = app_handle_clone.clone();
            let agent_id_task = agent_id_str.clone();
            let config_task = config_clone.clone();
            let settings_task = settings_clone.clone();
            let reaper_task = reaper.clone();
            let ki_activity = AgentPromptActivity::new();
            let ki_activity_task = ki_activity.clone();

            // A clone for the task itself: the agent-forward relay's pump tasks
            // send reply chunks back through it (#1727). Teardown is driven by an
            // explicit `Disconnect`, so a task-held clone does not mask it.
            let command_tx_task = command_tx.clone();
            let io_budget_task = io_budget.clone();
            // Retain the task's abort handle (CONC-009): the self-held `command_tx`
            // clone means an all-external-senders-dropped condition can never close
            // the loop, so a guaranteed force-stop is the only escape hatch for a
            // wedged task. Kept in the `AgentConnection` and fired only on teardown.
            // Not app-owned (#3105): connection-scoped; ended by Disconnect / teardown abort.
            let io_task = tokio::spawn(async move {
                agent_io_task(
                    session,
                    channel,
                    command_rx,
                    command_tx_task,
                    io_budget_task,
                    alive_clone,
                    reconnecting_clone,
                    app_handle_task,
                    agent_id_task,
                    config_task,
                    settings_task,
                    request_id,
                    reaper_task,
                    pending_notifications,
                    ki_activity_task,
                    update_auth_token_path,
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
                io_budget,
                alive,
                reconnecting,
                io_task,
                ki_activity,
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
            io_budget,
            alive,
            reconnecting,
            io_task,
            ki_activity,
        ) = match result {
            Ok(v) => v,
            Err(e) => {
                if cancel_token.is_cancelled() {
                    emit_agent_state(&self.app_handle, agent_id, "disconnected");
                }
                return Err(e);
            }
        };

        let result = AgentConnectResult {
            capabilities: capabilities.clone(),
            agent_version: agent_version.clone(),
            protocol_version: protocol_version.clone(),
        };

        // Publish under a short re-acquire of the `agents` lock (#4304). The
        // cancellation check sits under the same lock `disconnect_agent` fires
        // the token under, so a Disconnect / Cancel that landed while the
        // handshake ran off-lock is honoured: the fresh connection is torn down
        // rather than published behind the user's back.
        {
            let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            if cancel_token.is_cancelled() {
                drop(agents);
                let _ = command_tx.send(AgentIoCommand::Disconnect);
                alive.store(false, Ordering::SeqCst);
                io_task.abort();
                io_budget.close();
                emit_agent_state(&self.app_handle, agent_id, "disconnected");
                return Err(TerminalError::RemoteError("Connect cancelled".to_string()));
            }
            // Paired with the map entry under the same `agents` lock (#3018).
            self.io_budgets
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(agent_id.to_string(), io_budget);
            agents.insert(
                agent_id.to_string(),
                AgentConnection {
                    command_tx,
                    alive,
                    reconnecting,
                    io_task,
                    capabilities,
                    ki_activity,
                    client_id,
                    reattach_config: RetainedAgentConfig {
                        config: config.clone(),
                        settings: settings_ref.clone(),
                    },
                },
            );
        }

        // Announced only once the entry is published, so an observer reacting to
        // `connected` finds the agent in the map.
        emit_agent_state(&self.app_handle, agent_id, "connected");

        // An agent a resilient tab already opted into reattach (#3661) — e.g. the
        // user re-connecting a reaped agent with a changed password — refreshes
        // its retained config so a later redrive never re-establishes with a
        // stale secret. A no-op for an agent nothing opted in.
        self.agent_configs
            .refresh_if_retained(agent_id, config.clone(), settings_ref.clone());

        // Best-effort "agent crashed since last connect" check (#3593): spawned
        // off the connect path, never delays or fails this connect.
        crate::utils::agent_crash_notice::spawn_check(&self.app_handle, agent_id);

        Ok(result)
    }

    /// Disconnect an agent, closing all sessions. An agent that is still
    /// connecting has its connect cancelled instead (#4304).
    pub fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        let mut agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let live = agents.remove(agent_id);
        // #4304: the connect handshake runs off the `agents` lock, so a
        // Disconnect can now arrive while the agent is still connecting. Cancel
        // that connect — under the `agents` lock, which its publish step checks
        // the token under — so it aborts (or tears down a connection it just
        // finished) and emits `disconnected` instead of publishing it.
        let cancelled_connect = cancel_connect_token(&self.connecting, agent_id);
        // #3018: drop the budget with its entry, under the same lock that pairs
        // them, and close it now: a producer waiting for queue credit fails at
        // once instead of waiting on the ending I/O task (whose own drop guard
        // closes it too).
        if let Some(budget) = self
            .io_budgets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(agent_id)
        {
            budget.close();
        }
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
        } else if cancelled_connect {
            // The in-flight connect emits `disconnected` itself once it unwinds.
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
    #[cfg_attr(
        not(any(all(test, unix), feature = "test-bridge")),
        expect(
            dead_code,
            reason = "test-only transport sever (#2573): reached only via the test bridge or the unix russh tests"
        )
    )]
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

    /// Retain a connected agent's SSH transport config for backend-driven
    /// reconnect reattach (#2472), so the redrive can cold-re-establish the
    /// transport after a reap.
    ///
    /// Called by [`crate::session::manager::SessionManager::create_connection`]
    /// when a **resilient** agent tab connects (#3661) — the gate: a
    /// non-resilient tab never reconnects, so it never extends the secret's
    /// lifetime past the connection. Promotes the live connection's (already
    /// expanded) config, so the caller needs no copy of the secret. Returns
    /// `false` when the agent has no live connection (nothing to retain).
    ///
    /// The retained secret is zeroized on drop and scrubbed at every terminal
    /// point: user disconnect / shutdown / prune here, agent deletion, app quit,
    /// and — refcounted over the agent's resilient tabs — tab close, eviction,
    /// drop and reconnect give-up in the session layer / redrive.
    pub fn retain_agent_config(&self, agent_id: &str) -> bool {
        let live = {
            let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            agents
                .get(agent_id)
                .filter(|c| c.alive.load(Ordering::SeqCst))
                .map(|c| c.reattach_config.clone())
        };
        // The agents lock is released before the config-store lock is taken, so
        // the two are never held nested.
        match live {
            Some(retained) => {
                self.agent_configs.retain(
                    agent_id,
                    retained.config.clone(),
                    retained.settings.clone(),
                );
                true
            }
            None => false,
        }
    }

    /// Drop and zeroize every retained reattach config — the app-quit scrub
    /// point (#3661), run from the app teardown.
    pub fn clear_all_retained_agent_configs(&self) {
        self.agent_configs.clear_all();
    }

    /// Whether a reattach config is currently retained for `agent_id`. Test-only
    /// observer for the scrub-point tests.
    #[cfg(test)]
    pub(crate) fn has_retained_agent_config(&self, agent_id: &str) -> bool {
        self.agent_configs.contains(agent_id)
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
    ///   [`Self::connect_agent`], which reserves the agent for the whole connect
    ///   (#4304), so of two concurrent redrives the loser is refused as "already
    ///   connected" (mapped back to `Ok` here) while the winner's connect owns the
    ///   outcome;
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

        let result = self
            .send_request(
                agent_id,
                termihub_core::protocol::methods::AGENT_SHUTDOWN,
                params,
            )
            .inspect_err(|_| {
                // A shutdown is a terminal point even when the request fails
                // (e.g. the transport was already reaped): the retained reattach
                // secret must not outlive the user's intent (#3661). The success
                // path scrubs via `disconnect_agent` below.
                self.agent_configs.clear(agent_id);
            })?;
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
            empty_params(),
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

    /// Read the connected agent instance's update auth token (AGT-003, #3213).
    ///
    /// The I/O task reads it over its current SSH session from the file the
    /// agent's latest `initialize` advertised. Blocking, like
    /// [`send_request`](Self::send_request): call only from `spawn_blocking`.
    pub fn update_auth_token(&self, agent_id: &str) -> Option<UpdateAuthToken> {
        let (reply, rx) = oneshot::channel();
        {
            let agents = self.agents.lock().ok()?;
            agents
                .get(agent_id)?
                .command_tx
                .send(AgentIoCommand::ReadUpdateAuthToken { reply })
                .ok()?;
        }
        let wait = UPDATE_TOKEN_READ_TIMEOUT + std::time::Duration::from_secs(5);
        tokio::runtime::Handle::current()
            .block_on(async { tokio::time::timeout(wait, rx).await })
            .ok()?
            .ok()?
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
        self.request_with_timeout(agent_id, method, params, timeout)
            .map_err(AgentRequestFailure::into_terminal_error)
    }

    /// [`send_request_with_timeout`](Self::send_request_with_timeout), but an
    /// error the agent answered with keeps its JSON-RPC code (#4299).
    fn request_with_timeout(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, AgentRequestFailure> {
        let agents = self.agents.lock().map_err(|e| {
            AgentRequestFailure::Local(TerminalError::RemoteError(format!("Lock failed: {}", e)))
        })?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            AgentRequestFailure::Local(TerminalError::RemoteError(format!(
                "Agent {} not connected",
                agent_id
            )))
        })?;

        let (resp_tx, resp_rx) = oneshot::channel();
        conn.command_tx
            .send(AgentIoCommand::Request {
                method: method.to_string(),
                params,
                response_tx: resp_tx,
            })
            .map_err(|_| {
                AgentRequestFailure::Local(TerminalError::agent_transport_closed(
                    "Agent I/O task gone",
                ))
            })?;

        // Drop the lock before waiting for response
        drop(agents);

        // Bounded wait: a fired timeout returns a typed agent-timeout error and
        // frees this thread; a dropped sender (io_task gone / pending drained on drop)
        // surfaces as a connection-lost error rather than the old misleading
        // "timed out" string (CONC-003).
        match tokio::runtime::Handle::current()
            .block_on(async { tokio::time::timeout(timeout, resp_rx).await })
        {
            // No reply within the deadline while the transport was up: typed as
            // an agent timeout, not an agent-reported error (#3959).
            Err(_elapsed) => Err(AgentRequestFailure::Local(TerminalError::agent_timeout(
                timeout,
            ))),
            // The reply sender was dropped with no answer: the I/O task (and the
            // transport) went away under the request — typed, not text (#2840).
            Ok(Err(_recv)) => Err(AgentRequestFailure::Local(
                TerminalError::agent_transport_closed("Agent connection lost"),
            )),
            Ok(Ok(inner)) => inner.map_err(AgentRequestFailure::Agent),
        }
    }

    /// [`send_request_with_timeout`](Self::send_request_with_timeout), except
    /// that time the user spends on an agent-relayed SSH keyboard-interactive
    /// prompt of this agent does not count against `timeout` (#3375).
    fn send_request_excluding_prompts(
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
        let activity = conn.ki_activity.clone();
        let (resp_tx, resp_rx) = oneshot::channel();
        conn.command_tx
            .send(AgentIoCommand::Request {
                method: method.to_string(),
                params,
                response_tx: resp_tx,
            })
            .map_err(|_| TerminalError::agent_transport_closed("Agent I/O task gone"))?;
        drop(agents);

        match tokio::runtime::Handle::current()
            .block_on(recv_excluding_prompts(resp_rx, timeout, &activity))
        {
            Err(()) => Err(TerminalError::agent_timeout(timeout)),
            // The reply sender was dropped with no answer: the I/O task (and the
            // transport) went away under the request — typed, not text (#2840).
            Ok(Err(_recv)) => Err(TerminalError::agent_transport_closed(
                "Agent connection lost",
            )),
            Ok(Ok(inner)) => inner.map_err(AgentRpcFailure::into_terminal_error),
        }
    }

    /// [`create_session`](Self::create_session) with its relayed prompt rounds
    /// attributed to the desktop connect `owner` (#3437) for as long as the
    /// create is in flight, sending `correlation_id` (#3085) for the agent's logs.
    #[allow(clippy::too_many_arguments)]
    pub fn create_session_owned(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
        owner: Option<&str>,
        correlation_id: Option<&str>,
        unattended: bool,
    ) -> Result<AgentSessionInfo, TerminalError> {
        let _owned = match owner {
            Some(owner) => self
                .ki_activity(agent_id)?
                .map(|a| a.begin_owned_create(owner)),
            None => None,
        };
        let params = session_create_params(
            session_type,
            config,
            title,
            definition_id,
            correlation_id,
            unattended,
        )?;
        self.send_create(agent_id, params)
    }

    /// Mark the in-flight creates owned by the desktop connect `owner` cancelled
    /// on every connected agent (#3437).
    pub fn cancel_owned_creates(&self, owner: &str) {
        let activities: Vec<Arc<AgentPromptActivity>> = match self.agents.lock() {
            Ok(agents) => agents.values().map(|c| c.ki_activity.clone()).collect(),
            Err(_) => return,
        };
        for activity in activities {
            activity.cancel_owner(owner);
        }
    }

    /// The prompt-activity tracker of a connected agent, if it is connected.
    fn ki_activity(
        &self,
        agent_id: &str,
    ) -> Result<Option<Arc<AgentPromptActivity>>, TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;
        Ok(agents.get(agent_id).map(|conn| conn.ki_activity.clone()))
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
        let params =
            session_create_params(session_type, config, title, definition_id, None, false)?;
        self.send_create(agent_id, params)
    }

    /// Send a built `connection.create` request and parse its result.
    fn send_create(
        &self,
        agent_id: &str,
        params: Value,
    ) -> Result<AgentSessionInfo, TerminalError> {
        // The agent's SSH connect may wait on the user answering a relayed OTP
        // prompt (#3375): exclude that time from the request timeout.
        let result = self.send_request_excluding_prompts(
            agent_id,
            termihub_core::protocol::methods::CONNECTION_CREATE,
            params,
            AGENT_REQUEST_TIMEOUT,
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

    /// Close a session on the agent.
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
            empty_params(),
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
            empty_params(),
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
            empty_params(),
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

    /// Register a remote session's files-only watch on the agent's I/O task
    /// (#4081).
    pub fn register_files_only(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        files_only_tx: tokio::sync::watch::Sender<bool>,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;

        let conn = agents.get(agent_id).ok_or_else(|| {
            TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
        })?;

        conn.command_tx
            .send(AgentIoCommand::RegisterFilesOnly {
                session_id: remote_session_id.to_string(),
                files_only_tx,
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

    /// Open a desktop port-forward stream through the agent (#3241). See
    /// [`AgentRpcClient::open_forward_stream`]. An agent mid-reconnect fails at
    /// once rather than parking the caller for the request timeout.
    pub fn open_forward_stream(
        &self,
        agent_id: &str,
        stream_id: &str,
        host: &str,
        port: u16,
        window: Option<u64>,
        sink: crate::terminal::agent_forward::ForwardSink,
    ) -> Result<Option<u64>, TerminalError> {
        {
            let agents = self
                .agents
                .lock()
                .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;
            let conn = agents.get(agent_id).ok_or_else(|| {
                TerminalError::RemoteError(format!("Agent {} not connected", agent_id))
            })?;
            if conn.reconnecting.load(Ordering::SeqCst) {
                return Err(TerminalError::RemoteError(format!(
                    "Agent {} is reconnecting",
                    agent_id
                )));
            }
        }
        self.send_io_command(
            agent_id,
            AgentIoCommand::RegisterForwardStream {
                stream_id: stream_id.to_string(),
                sink,
            },
        )?;
        let params = serde_json::to_value(
            termihub_core::protocol::methods::AgentForwardConnectParams {
                stream_id: stream_id.to_string(),
                host: host.to_string(),
                port,
                window,
            },
        )
        .map_err(|e| TerminalError::InternalError(e.to_string()))?;
        let result = self.send_request_with_timeout(
            agent_id,
            termihub_core::protocol::methods::AGENT_FORWARD_CONNECT,
            params,
            FORWARD_CONNECT_TIMEOUT,
        );
        if result.is_err() {
            let _ = self.send_io_command(
                agent_id,
                AgentIoCommand::UnregisterForwardStream {
                    stream_id: stream_id.to_string(),
                },
            );
        }
        // An agent from before #4284 answers `{}`: no window, no flow control.
        result.map(|value| {
            serde_json::from_value::<termihub_core::protocol::methods::AgentForwardConnectResult>(
                value,
            )
            .unwrap_or_default()
            .window
        })
    }

    /// Return window credit on a flow-controlled port-forward stream (#4284).
    /// Best effort: a gone agent has already dropped the stream.
    pub fn ack_forward_data(&self, agent_id: &str, stream_id: &str, bytes: u64) {
        let _ = self.send_io_command(
            agent_id,
            AgentIoCommand::AgentForwardAck {
                stream_id: stream_id.to_string(),
                bytes,
            },
        );
    }

    /// Send desktop→target bytes on a port-forward stream (#3241).
    pub fn send_forward_data(
        &self,
        agent_id: &str,
        stream_id: &str,
        data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        self.send_io_command(
            agent_id,
            AgentIoCommand::AgentForwardData {
                stream_id: stream_id.to_string(),
                data,
            },
        )
    }

    /// Close a port-forward stream from the desktop end (#3241): stop routing
    /// it locally and tell the agent to drop its target connection.
    pub fn close_forward_stream(&self, agent_id: &str, stream_id: &str) {
        let _ = self.send_io_command(
            agent_id,
            AgentIoCommand::UnregisterForwardStream {
                stream_id: stream_id.to_string(),
            },
        );
        let _ = self.send_io_command(
            agent_id,
            AgentIoCommand::AgentForwardClose {
                stream_id: stream_id.to_string(),
            },
        );
    }

    /// Queue a command for an agent's I/O task. Gated data (forwarded bytes)
    /// blocks for queue credit first (#3018); control never waits.
    fn send_io_command(&self, agent_id: &str, cmd: AgentIoCommand) -> Result<(), TerminalError> {
        let sender = self.io_sender(agent_id, TerminalError::RemoteError)?;
        sender.send_blocking(cmd).map_err(|e| {
            TerminalError::RemoteError(match e {
                GateError::Closed => "Agent I/O task gone".to_string(),
                GateError::Reconnecting => format!("Agent {} is reconnecting", agent_id),
                GateError::WouldDeadlock => "Agent I/O queue full".to_string(),
            })
        })
    }

    /// Snapshot `agent_id`'s gated command sender (#3018): its ingress, its
    /// data-credit budget and its reconnecting flag, read under the `agents`
    /// lock so the three belong to the same connection. The lock is released
    /// before the caller sends, so a producer waiting for credit never holds it.
    fn io_sender(
        &self,
        agent_id: &str,
        err: fn(String) -> TerminalError,
    ) -> Result<AgentIoSender, TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| err(format!("Lock failed: {}", e)))?;
        let conn = agents
            .get(agent_id)
            .ok_or_else(|| err(format!("Agent {} not connected", agent_id)))?;
        // `connect_agent` always inserts the budget with the entry; the fallback
        // only serves entries built without it (unit tests), which get their own
        // bounded budget rather than an ungated path.
        let budget = self
            .io_budgets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(agent_id.to_string())
            .or_insert_with(|| IoBudget::new(AGENT_IO_DATA_BUDGET))
            .clone();
        Ok(AgentIoSender::new(
            conn.command_tx.clone(),
            budget,
            conn.reconnecting.clone(),
        ))
    }

    /// Send input to a session on the agent (fire-and-forget).
    pub fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        let sender = self.io_sender(agent_id, TerminalError::WriteFailed)?;

        // CONC-014: drop terminal input while the transport is down. The I/O task
        // is not draining `command_rx` during a reconnect, so anything queued now
        // would (a) sit in the queue for the whole outage and (b) replay stale
        // keystrokes into the recovered remote session once it reconnects. The tab
        // already shows a reconnecting overlay; discarding input is the safe
        // behavior. Fire-and-forget, so reporting success is correct — the
        // keystroke is intentionally not delivered.
        if sender.is_reconnecting() {
            return Ok(());
        }

        // #3018: a large paste is split into bounded chunks, each waiting for queue
        // credit in order — backpressure instead of unbounded growth, and a control
        // command never waits behind more than one chunk's write. Chunks of one
        // call are enqueued back to back by this (serialized) writer, so a
        // session's input is never reordered.
        let chunks: Vec<&[u8]> = if data.is_empty() {
            vec![data]
        } else {
            data.chunks(AGENT_IO_MAX_CHUNK).collect()
        };
        for chunk in chunks {
            let sent = sender.send_blocking(AgentIoCommand::SessionInput {
                session_id: remote_session_id.to_string(),
                data: chunk.to_vec(),
            });
            match sent {
                Ok(()) => {}
                // The transport broke while this write waited for credit: the rest
                // is dropped like any other input typed during an outage (CONC-014).
                Err(GateError::Reconnecting) => return Ok(()),
                Err(GateError::Closed) => {
                    return Err(TerminalError::WriteFailed(
                        "Agent I/O task gone".to_string(),
                    ))
                }
                Err(GateError::WouldDeadlock) => {
                    return Err(TerminalError::WriteFailed(
                        "Agent I/O queue full".to_string(),
                    ))
                }
            }
        }
        Ok(())
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

impl<R: Runtime> AgentConnectionManager<R> {
    /// Pause or resume a session's output on the agent (fire-and-forget,
    /// #4416). An agent without [`AgentCapabilities::output_flow`] is never
    /// sent the method: it would not pause, so the call is a silent no-op.
    pub fn set_session_output_paused(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        let agents = self
            .agents
            .lock()
            .map_err(|e| TerminalError::RemoteError(format!("Lock failed: {}", e)))?;
        let Some(conn) = agents.get(agent_id) else {
            // Gone already: nothing streams, so there is nothing to pause.
            return Ok(());
        };
        if !conn.capabilities.output_flow {
            return Ok(());
        }
        conn.command_tx
            .send(AgentIoCommand::SessionOutputFlow {
                session_id: remote_session_id.to_string(),
                paused,
            })
            .map_err(|_| TerminalError::RemoteError("Agent I/O task gone".to_string()))
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

    fn connected_agent_ids(&self) -> Vec<String> {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> = agents
            .iter()
            .filter(|(_, c)| c.alive.load(Ordering::SeqCst))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    fn send_request_bounded(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, TerminalError> {
        self.send_request_with_timeout(agent_id, method, params, timeout)
    }

    fn send_file_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, termihub_core::errors::FileError> {
        self.request_with_timeout(agent_id, method, params, AGENT_REQUEST_TIMEOUT)
            .map_err(AgentRequestFailure::into_file_error)
    }

    fn prune_dead_agents(&self) -> Vec<String> {
        AgentConnectionManager::prune_dead_agents(self)
    }

    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        AgentConnectionManager::get_capabilities(self, agent_id)
    }

    fn agent_endpoint(&self, agent_id: &str) -> Option<(String, String)> {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        agents
            .get(agent_id)
            .filter(|c| c.alive.load(Ordering::SeqCst))
            .map(|c| {
                let config = &c.reattach_config.config;
                (config.host.clone(), config.username.clone())
            })
    }

    fn retain_agent_config(&self, agent_id: &str) -> bool {
        AgentConnectionManager::retain_agent_config(self, agent_id)
    }

    fn clear_retained_agent_config(&self, agent_id: &str) {
        AgentConnectionManager::clear_retained_agent_config(self, agent_id)
    }

    fn clear_all_retained_agent_configs(&self) {
        AgentConnectionManager::clear_all_retained_agent_configs(self)
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

    fn update_auth_token(&self, agent_id: &str) -> Option<UpdateAuthToken> {
        AgentConnectionManager::update_auth_token(self, agent_id)
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

    fn cancel_owned_creates(&self, owner: &str) {
        AgentConnectionManager::cancel_owned_creates(self, owner);
    }

    fn create_session_owned(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
        owner: Option<&str>,
        correlation_id: Option<&str>,
        unattended: bool,
    ) -> Result<AgentSessionInfo, TerminalError> {
        AgentConnectionManager::create_session_owned(
            self,
            agent_id,
            session_type,
            config,
            title,
            definition_id,
            owner,
            correlation_id,
            unattended,
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

    fn register_files_only(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        files_only_tx: tokio::sync::watch::Sender<bool>,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::register_files_only(
            self,
            agent_id,
            remote_session_id,
            files_only_tx,
        )
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

    fn open_forward_stream(
        &self,
        agent_id: &str,
        stream_id: &str,
        host: &str,
        port: u16,
        window: Option<u64>,
        sink: crate::terminal::agent_forward::ForwardSink,
    ) -> Result<Option<u64>, TerminalError> {
        AgentConnectionManager::open_forward_stream(
            self, agent_id, stream_id, host, port, window, sink,
        )
    }

    fn ack_forward_data(&self, agent_id: &str, stream_id: &str, bytes: u64) {
        AgentConnectionManager::ack_forward_data(self, agent_id, stream_id, bytes)
    }

    fn send_forward_data(
        &self,
        agent_id: &str,
        stream_id: &str,
        data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::send_forward_data(self, agent_id, stream_id, data)
    }

    fn close_forward_stream(&self, agent_id: &str, stream_id: &str) {
        AgentConnectionManager::close_forward_stream(self, agent_id, stream_id)
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

    fn set_session_output_paused(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        AgentConnectionManager::set_session_output_paused(self, agent_id, remote_session_id, paused)
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

/// Protocol version the desktop requests in `initialize`.
///
/// 0.24.0 is the first version whose `initialize` result envelope is camelCase
/// (#3051); requesting it makes a current agent answer in that shape. The agent
/// negotiates down to its own version, so an older agent (major `0`) still
/// accepts it and answers in snake_case, which the shared DTO also reads.
/// Before #3051 this was a fixed `"0.3.0"`.
const DESKTOP_PROTOCOL_VERSION: &str = "0.24.0";

/// Build the `initialize` JSON-RPC params including agent runtime settings and
/// external files, as the shared [`InitializeParams`] DTO (DUP-001, #3226).
fn build_initialize_params(settings: &AgentSettings, external_files: &[&str]) -> Value {
    let params = InitializeParams {
        protocol_version: DESKTOP_PROTOCOL_VERSION.to_string(),
        client: "termihub-desktop".to_string(),
        // AGT-014: report the desktop crate's real version rather than a stale
        // literal. The agent records this in its per-process client registry and
        // echoes it via `agent.list_connections` (the connected-client update
        // guard, #1349), so a hardcoded constant makes every client look identical
        // and defeats any version-based reasoning. `CARGO_PKG_VERSION` is the same
        // source Tauri's `package_info().version` derives from (both come from
        // `Cargo.toml`), and matches how the rest of the desktop reports its
        // version (see `cli::version_string`, `agent_deploy`, `agent_setup`).
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        external_connection_files: external_files.iter().map(|f| f.to_string()).collect(),
        agent_settings: settings.into(),
        // Optional features this desktop supports (#3375). Older agents ignore
        // the member; newer ones only relay SSH keyboard-interactive prompts
        // to a desktop that advertises them.
        client_capabilities: ClientCapabilities {
            keyboard_interactive_prompts: true,
        },
    };
    // Serializing plain strings/bools/ints cannot fail; the fallback is
    // unreachable but keeps this path panic-free.
    serde_json::to_value(params).unwrap_or_else(|_| empty_params())
}

/// The `{}` params of a request that takes none (the shared [`EmptyParams`]
/// DTO, DUP-001 #3226).
fn empty_params() -> Value {
    serde_json::to_value(EmptyParams {}).unwrap_or_else(|_| Value::Object(Default::default()))
}

/// Parse an `initialize` result into the shared [`InitializeResult`] DTO with
/// the desktop's [`AgentCapabilities`] (DUP-001, #3226).
fn parse_initialize_result(result: Value) -> Result<InitializeResult<AgentCapabilities>, String> {
    serde_json::from_value(result).map_err(|e| format!("Parse initialize response: {}", e))
}

/// Serialize an `ssh.keyboard_interactive.respond` request line (#3375) into
/// zeroizing storage, borrowing the answers so no unwiped copy is made.
fn serialize_ki_respond(
    id: u64,
    round_id: &str,
    responses: Option<&[Zeroizing<String>]>,
) -> Option<Zeroizing<String>> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        request_id: &'a str,
        responses: Option<Vec<&'a str>>,
    }
    #[derive(serde::Serialize)]
    struct Request<'a> {
        jsonrpc: &'static str,
        method: &'static str,
        params: Params<'a>,
        id: u64,
    }
    let request = Request {
        jsonrpc: "2.0",
        method: termihub_core::protocol::methods::SSH_KEYBOARD_INTERACTIVE_RESPOND,
        params: Params {
            request_id: round_id,
            responses: responses.map(|r| r.iter().map(|s| s.as_str()).collect()),
        },
        id,
    };
    let mut line = Zeroizing::new(serde_json::to_string(&request).ok()?);
    line.push('\n');
    Some(line)
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

/// Build `connection.create` params from the shared DTO. `correlation_id` is
/// the desktop's session id (#3085, OBS-004): the agent logs the session under
/// it so both sides' log lines join on one id. Omitted from the wire when
/// `None`, and an agent older than protocol 0.16.0 ignores it. `unattended`
/// (#3877) is omitted when `false`, keeping the attended wire shape unchanged.
fn session_create_params(
    session_type: &str,
    config: Value,
    title: Option<&str>,
    definition_id: Option<&str>,
    correlation_id: Option<&str>,
    unattended: bool,
) -> Result<Value, TerminalError> {
    serde_json::to_value(SessionCreateParams {
        session_type: session_type.to_string(),
        config,
        title: title.map(str::to_string),
        definition_id: definition_id.map(str::to_string),
        correlation_id: correlation_id.map(str::to_string),
        unattended,
    })
    .map_err(|e| {
        TerminalError::RemoteError(format!("Failed to build connection.create params: {e}"))
    })
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

// #4304: connect / handshake / reap regressions against an in-process fake
// agent endpoint — no `sshd` binary and no agent build, so they run everywhere.
#[cfg(test)]
mod connect_off_lock_tests;
#[cfg(test)]
mod fake_agent_sshd;
// Output flow control + lossless output delivery for agent sessions (#4416).
#[cfg(test)]
mod output_flow_tests;

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

/// Raw agent-channel JSON-RPC helpers shared by the live agent tests.
#[cfg(test)]
mod live_channel_support;

// ── Live agent deploy/connect against a real Windows OpenSSH host (#3684) ─────
//
// Deploy + install through the cmd.exe / PowerShell `DefaultShell`, connect over
// SSH exec `--stdio`, and re-attach a named-pipe daemon session after a
// disconnect. Compiled everywhere; skips (with a stated reason) unless the
// `Windows SSH Host` nightly lane provides the fixture.
#[cfg(test)]
mod windows_ssh_host_tests;
