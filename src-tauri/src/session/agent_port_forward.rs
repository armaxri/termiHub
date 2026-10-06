//! VNC/RDP through an agent: a desktop port forward over the agent (#3241).
//!
//! A graphical connection hosted under an agent keeps running its VNC/RDP
//! backend **on the desktop**; only its TCP transport rides the agent. Before
//! the backend dials, [`AgentPortForward::start`] binds a loopback listener on
//! an ephemeral port. Every connection the backend opens to it becomes one
//! stream through the agent — `agent.forward.connect` makes the agent connect to
//! the target from its own host, and the bytes flow over the existing
//! `agent.forward.data` / `agent.forward.close` relay (see
//! [`crate::terminal::agent_forward`]). The backend itself is started against
//! `127.0.0.1:<local port>` with the settings [`rewrite_for_forward`] produces.
//!
//! Lifetime: the forward is owned by the graphical session and dropped with it,
//! which stops the listener and closes every stream (the agent then drops its
//! target connection). Because each backend dial is a fresh stream, an
//! auto-reconnect re-dial re-establishes the tunnel by itself: when the agent
//! transport drops, the relay ends every stream, the backend sees EOF, and its
//! re-dials open new streams once the agent is back. While the agent is down a
//! dial fails and [`AgentPortForward::last_error`] says why, so the session
//! shows "agent not connected" / "cannot reach host from the agent" rather than
//! a bare protocol EOF.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Read size for backend → agent bytes: the relay's own chunk size.
const FORWARD_CHUNK_SIZE: usize = 64 * 1024;

/// The settings key that routes a graphical connection through an agent: the
/// id of the agent that hosts it (the same key agent-hosted terminal sessions
/// carry).
pub const AGENT_ROUTE_KEY: &str = "agentId";

/// Default VNC port (display 0) — mirrors the VNC backend's `VNC_BASE_PORT`.
const VNC_BASE_PORT: u16 = 5900;
/// Default RDP port.
const RDP_DEFAULT_PORT: u16 = 3389;

/// Where an agent-routed graphical connection goes: the agent carrying it and
/// the target as seen **from the agent host**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRoute {
    pub agent_id: String,
    pub target_host: String,
    pub target_port: u16,
}

impl AgentRoute {
    /// The file-transfer view of this route (#4191): the agent to address and
    /// the target as seen from it (a loopback target makes the agent host the
    /// desktop host — see `graphical_files::is_same_host`).
    pub(crate) fn file_route(&self) -> super::graphical_file_channel::AgentFileRoute {
        super::graphical_file_channel::AgentFileRoute {
            agent_id: self.agent_id.clone(),
            target_host: self.target_host.clone(),
        }
    }
}

/// Read a port-ish settings value (a JSON number or a numeric string).
fn read_u16(settings: &Value, key: &str) -> Option<u16> {
    match settings.get(key)? {
        Value::Number(n) => n.as_u64().and_then(|v| u16::try_from(v).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// The agent route of a graphical connection, or `None` when it connects
/// directly from this computer (no `agentId`).
///
/// The target port follows each backend's own rule — VNC's display number wins
/// (`5900 + display`), else its port, else 5900; RDP's port, else 3389 — so the
/// agent connects exactly where a direct connection would. Errors (as the text
/// the user sees) for a route that cannot work: no host, a type without a TCP
/// target, or VNC's own SSH tunnel combined with the agent route.
pub fn agent_route(type_id: &str, settings: &Value) -> Result<Option<AgentRoute>, String> {
    let agent_id = match settings.get(AGENT_ROUTE_KEY).and_then(Value::as_str) {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => return Ok(None),
    };
    let target_host = settings
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "A host is required to connect through the agent".to_string())?
        .to_string();
    let target_port = match type_id {
        "vnc" => {
            if settings
                .get("useSshTunnel")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err(
                    "An SSH tunnel cannot be combined with connecting through an agent \
                     — the agent already carries the connection"
                        .to_string(),
                );
            }
            match read_u16(settings, "display") {
                Some(display) => VNC_BASE_PORT.saturating_add(display),
                None => read_u16(settings, "port")
                    .filter(|p| *p != 0)
                    .unwrap_or(VNC_BASE_PORT),
            }
        }
        "rdp" => read_u16(settings, "port")
            .filter(|p| *p != 0)
            .unwrap_or(RDP_DEFAULT_PORT),
        other => {
            return Err(format!(
                "Connection type '{other}' cannot be routed through an agent"
            ))
        }
    };
    Ok(Some(AgentRoute {
        agent_id,
        target_host,
        target_port,
    }))
}

/// The settings the desktop backend dials with once the forward is up: the
/// target becomes `127.0.0.1:<local_port>`, the agent route and VNC display are
/// dropped (the local port is already the resolved one), and a VNC connection
/// keeps verifying its TLS certificate against the real server name.
pub fn rewrite_for_forward(type_id: &str, settings: &Value, local_port: u16) -> Value {
    let mut dial = settings.clone();
    if let Some(map) = dial.as_object_mut() {
        let original_host = map.get("host").cloned();
        map.remove(AGENT_ROUTE_KEY);
        map.remove("display");
        map.insert("host".to_string(), Value::String("127.0.0.1".to_string()));
        map.insert("port".to_string(), Value::from(local_port));
        if type_id == "vnc" && !map.contains_key("tlsServerName") {
            if let Some(host) = original_host {
                map.insert("tlsServerName".to_string(), host);
            }
        }
    }
    dial
}

/// How one stream through the agent is opened, fed, and closed. The production
/// implementation is [`AgentClientTransport`]; tests substitute an in-process
/// fake so the forward lifecycle is exercised without a live agent.
pub trait ForwardTransport: Send + Sync + 'static {
    /// Open `stream_id` to `host:port` from the agent host, routing the agent's
    /// bytes into `sink`. **Blocking** (called from `spawn_blocking`). The error
    /// is the user-facing reason.
    fn open(
        &self,
        stream_id: &str,
        host: &str,
        port: u16,
        sink: UnboundedSender<Vec<u8>>,
    ) -> Result<(), String>;

    /// Send backend → target bytes. Non-blocking.
    fn send(&self, stream_id: &str, data: Vec<u8>) -> Result<(), String>;

    /// Close the stream from the desktop end. Non-blocking, best effort.
    fn close(&self, stream_id: &str);
}

/// [`ForwardTransport`] over a connected agent's JSON-RPC link.
pub struct AgentClientTransport {
    client: Arc<dyn AgentRpcClient>,
    agent_id: String,
}

impl AgentClientTransport {
    pub fn new(client: Arc<dyn AgentRpcClient>, agent_id: impl Into<String>) -> Self {
        Self {
            client,
            agent_id: agent_id.into(),
        }
    }
}

/// The user-facing reason an agent stream could not be opened.
pub fn forward_failure_message(host: &str, port: u16, err: &TerminalError) -> String {
    let reason = match err {
        TerminalError::AgentUnsupported(_) => {
            "this agent is too old to carry VNC/RDP connections — update the agent".to_string()
        }
        TerminalError::RemoteError(msg) if msg.ends_with("not connected") => {
            "the agent is not connected — connect the agent and retry".to_string()
        }
        TerminalError::RemoteError(msg) if msg.ends_with("is reconnecting") => {
            "the agent is reconnecting".to_string()
        }
        TerminalError::RemoteError(msg) if msg == "Agent connection lost" => {
            "the connection to the agent was lost".to_string()
        }
        TerminalError::RemoteError(msg) => msg.clone(),
        other => other.to_string(),
    };
    format!("Agent tunnel to {host}:{port} failed: {reason}")
}

impl ForwardTransport for AgentClientTransport {
    fn open(
        &self,
        stream_id: &str,
        host: &str,
        port: u16,
        sink: UnboundedSender<Vec<u8>>,
    ) -> Result<(), String> {
        self.client
            .open_forward_stream(&self.agent_id, stream_id, host, port, sink)
            .map_err(|e| forward_failure_message(host, port, &e))
    }

    fn send(&self, stream_id: &str, data: Vec<u8>) -> Result<(), String> {
        self.client
            .send_forward_data(&self.agent_id, stream_id, data)
            .map_err(|e| e.to_string())
    }

    fn close(&self, stream_id: &str) {
        self.client.close_forward_stream(&self.agent_id, stream_id);
    }
}

/// The most recent reason a stream failed to open, cleared by the next
/// successful open. Shared with the graphical session so its errors name the
/// tunnel failure.
pub type ForwardErrorSlot = Arc<Mutex<Option<String>>>;

/// A live loopback listener whose connections are tunnelled through an agent.
/// Dropping it stops the listener and closes every open stream.
pub struct AgentPortForward {
    local_port: u16,
    last_error: ForwardErrorSlot,
    cancel: CancellationToken,
    /// Owns the listener. `Option` only so a test can take it out of this
    /// `Drop` type and await its end (see `drop_and_take_accept_task`).
    accept_task: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for AgentPortForward {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentPortForward")
            .field("local_port", &self.local_port)
            .finish_non_exhaustive()
    }
}

impl AgentPortForward {
    /// Bind `127.0.0.1:0` and tunnel each accepted connection to
    /// `target_host:target_port` through `transport`.
    pub async fn start(
        transport: Arc<dyn ForwardTransport>,
        target_host: String,
        target_port: u16,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();
        let last_error: ForwardErrorSlot = Arc::default();
        let cancel = CancellationToken::new();
        info!(local_port, %target_host, target_port, "agent port forward listening");

        let accept_cancel = cancel.clone();
        let accept_error = last_error.clone();
        // Not app-owned (#3105): session-scoped; stopped when the session drops
        // its forward.
        let accept_task = tokio::spawn(async move {
            loop {
                let conn = tokio::select! {
                    _ = accept_cancel.cancelled() => break,
                    accepted = listener.accept() => match accepted {
                        Ok((conn, _)) => conn,
                        Err(e) => {
                            debug!("agent port forward accept ended: {e}");
                            break;
                        }
                    },
                };
                // Not app-owned (#3105): one stream, ended by either side or the
                // forward's cancellation.
                tokio::spawn(serve_connection(
                    conn,
                    transport.clone(),
                    target_host.clone(),
                    target_port,
                    accept_error.clone(),
                    accept_cancel.clone(),
                ));
            }
        });

        Ok(Self {
            local_port,
            last_error,
            cancel,
            accept_task: Some(accept_task),
        })
    }

    /// The loopback port the desktop backend dials.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// Why the most recent stream failed to open, if it did.
    pub fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// A shared handle on [`last_error`](Self::last_error) for the session's
    /// reconnect loop.
    pub fn error_slot(&self) -> ForwardErrorSlot {
        self.last_error.clone()
    }

    /// Drop the forward exactly as production does (cancel + abort) and hand
    /// back its accept task. The handle resolves only once the task's future —
    /// which owns the listener — has been dropped, so a test can assert the
    /// listener closed without probing the freed port, which a concurrent
    /// test's port-0 bind may already have re-taken (#3551).
    #[cfg(test)]
    pub(crate) fn drop_and_take_accept_task(mut self) -> JoinHandle<()> {
        let task = self.accept_task.take().expect("accept task present");
        task.abort();
        task
    }
}

impl Drop for AgentPortForward {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
    }
}

fn set_error(slot: &ForwardErrorSlot, value: Option<String>) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = value;
}

/// Tunnel one accepted backend connection through the agent until either side
/// ends it or the forward is dropped.
async fn serve_connection(
    conn: TcpStream,
    transport: Arc<dyn ForwardTransport>,
    host: String,
    port: u16,
    last_error: ForwardErrorSlot,
    cancel: CancellationToken,
) {
    let stream_id = format!("pf-{}", uuid::Uuid::new_v4());
    // TAURI-014-style note: unbounded like the ssh-agent relay it shares — the
    // producer is the agent I/O loop, which must never block on one slow stream.
    let (sink, mut from_agent) = mpsc::unbounded_channel::<Vec<u8>>();

    let open = {
        let transport = transport.clone();
        let (sid, host) = (stream_id.clone(), host.clone());
        tokio::task::spawn_blocking(move || transport.open(&sid, &host, port, sink)).await
    };
    match open {
        Ok(Ok(())) => set_error(&last_error, None),
        Ok(Err(reason)) => {
            debug!(%stream_id, %reason, "agent port forward stream failed to open");
            // Recorded before `conn` drops, so the backend's resulting EOF is
            // always explained by the time it surfaces.
            set_error(&last_error, Some(reason));
            return;
        }
        Err(join) => {
            set_error(
                &last_error,
                Some(format!("Agent tunnel to {host}:{port} failed: {join}")),
            );
            return;
        }
    }
    if cancel.is_cancelled() {
        transport.close(&stream_id);
        return;
    }
    let _ = conn.set_nodelay(true);
    let (mut rd, mut wr) = conn.into_split();

    // agent → backend
    let to_backend = async {
        while let Some(bytes) = from_agent.recv().await {
            if wr.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    };
    // backend → agent
    let to_agent = async {
        let mut buf = vec![0u8; FORWARD_CHUNK_SIZE];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if transport.send(&stream_id, buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = to_backend => debug!(%stream_id, "agent ended the forwarded stream"),
        _ = to_agent => debug!(%stream_id, "backend closed the forwarded stream"),
        _ = cancel.cancelled() => debug!(%stream_id, "forward dropped with its session"),
    }
    transport.close(&stream_id);
}

#[cfg(test)]
#[path = "agent_port_forward_tests.rs"]
mod tests;
