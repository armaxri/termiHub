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
//!
//! Flow control (#4284): every stream asks the agent for a window
//! ([`AGENT_FORWARD_WINDOW`]). An agent that grants one keeps at most that
//! many unacknowledged bytes in flight toward the desktop, and the desktop
//! acknowledges them only once written to the backend's socket — so a slow
//! canvas stops the acks and the agent stops reading the remote desktop server,
//! instead of frames queuing up on the agent or here. The desktop likewise
//! keeps its own bytes within the window, released by the agent's acks. An
//! agent that predates flow control grants nothing and the stream is relayed
//! unbounded, exactly as before.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use termihub_core::backends::ssh::agent_forward::AGENT_FORWARD_CHUNK_SIZE;
use termihub_core::session::forward_window::{ack_threshold, ForwardWindow, AGENT_FORWARD_WINDOW};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use crate::terminal::agent_forward::{ForwardEvent, ForwardSink};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// The settings key that routes a graphical connection through an agent: the
/// id of the agent that hosts it (the same key agent-hosted terminal sessions
/// carry).
pub const AGENT_ROUTE_KEY: &str = "agentId";

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

/// The agent route of a graphical connection, or `None` when it connects
/// directly from this computer (no `agentId`).
///
/// The target port is resolved by the backend's own config — core's
/// `VncConfig::effective_port` / `RdpConfig::effective_port`, the very rule
/// the direct connection dials (DUP2-008, #4284) — so the agent connects
/// exactly where a direct connection would, and settings the direct path would
/// reject are rejected here too. Errors (as the text the user sees) for a
/// route that cannot work: no host, invalid settings, no target port, a type
/// without a TCP target, or VNC's own SSH tunnel combined with the agent
/// route.
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
    let target_port = routed_target_port(type_id, settings)?;
    if target_port == 0 {
        return Err("A target port is required to connect through the agent".to_string());
    }
    Ok(Some(AgentRoute {
        agent_id,
        target_host,
        target_port,
    }))
}

/// The port the backend of `type_id` would dial for `settings`, from core's own
/// config type (DUP2-008).
#[cfg_attr(
    not(any(feature = "vnc", feature = "rdp-sidecar")),
    allow(unused_variables)
)]
fn routed_target_port(type_id: &str, settings: &Value) -> Result<u16, String> {
    match type_id {
        #[cfg(feature = "vnc")]
        "vnc" => {
            let cfg = termihub_core::backends::vnc::VncConfig::from_settings(settings.clone())
                .map_err(|e| format!("Invalid VNC settings: {e}"))?;
            if cfg.use_ssh_tunnel {
                return Err(
                    "An SSH tunnel cannot be combined with connecting through an agent \
                     — the agent already carries the connection"
                        .to_string(),
                );
            }
            Ok(cfg.effective_port())
        }
        #[cfg(feature = "rdp-sidecar")]
        "rdp" => {
            termihub_core::backends::rdp_sidecar::config::RdpConfig::from_settings(settings.clone())
                .map(|cfg| cfg.effective_port())
                .map_err(|e| format!("Invalid RDP settings: {e}"))
        }
        other => Err(format!(
            "Connection type '{other}' cannot be routed through an agent"
        )),
    }
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
    /// Open `stream_id` to `host:port` from the agent host, requesting a
    /// flow-control `window` (#4284), routing the agent's events into `sink`.
    /// Returns the window the agent granted (`None`: an agent without flow
    /// control). **Blocking** (called from `spawn_blocking`). The error is the
    /// user-facing reason.
    fn open(
        &self,
        stream_id: &str,
        host: &str,
        port: u16,
        window: Option<u64>,
        sink: ForwardSink,
    ) -> Result<Option<u64>, String>;

    /// Send backend → target bytes. Waits only for the agent link's own queue
    /// budget (#3018).
    fn send(&self, stream_id: &str, data: Vec<u8>) -> Result<(), String>;

    /// Acknowledge `bytes` of target data written to the backend, returning
    /// that much window credit to the agent (#4284). Non-blocking.
    fn ack(&self, stream_id: &str, bytes: u64);

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
        window: Option<u64>,
        sink: ForwardSink,
    ) -> Result<Option<u64>, String> {
        self.client
            .open_forward_stream(&self.agent_id, stream_id, host, port, window, sink)
            .map_err(|e| forward_failure_message(host, port, &e))
    }

    fn ack(&self, stream_id: &str, bytes: u64) {
        self.client
            .ack_forward_data(&self.agent_id, stream_id, bytes);
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
    // Unbounded so the agent I/O loop never blocks on one slow stream; on a
    // flow-controlled stream it holds at most the granted window of data,
    // because nothing is acked before it reaches the backend (#4284).
    let (sink, from_agent) = mpsc::unbounded_channel::<ForwardEvent>();

    let open = {
        let transport = transport.clone();
        let (sid, host) = (stream_id.clone(), host.clone());
        let window = Some(AGENT_FORWARD_WINDOW as u64);
        tokio::task::spawn_blocking(move || transport.open(&sid, &host, port, window, sink)).await
    };
    let granted = match open {
        Ok(Ok(granted)) => {
            set_error(&last_error, None);
            granted
        }
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
    };
    if cancel.is_cancelled() {
        transport.close(&stream_id);
        return;
    }
    // Never trust a grant past our own request.
    let window = granted.map(|w| {
        usize::try_from(w)
            .unwrap_or(usize::MAX)
            .clamp(1, AGENT_FORWARD_WINDOW)
    });
    debug!(%stream_id, ?window, "agent port forward stream open");
    let _ = conn.set_nodelay(true);
    let (rd, wr) = conn.into_split();
    let outbound = window.map(|w| Arc::new(ForwardWindow::new(w)));

    let pipe = StreamPipe {
        transport: transport.as_ref(),
        stream_id: &stream_id,
        window,
        outbound: outbound.as_deref(),
    };
    tokio::select! {
        _ = pipe.agent_to_backend(from_agent, wr) => {
            debug!(%stream_id, "agent ended the forwarded stream");
        }
        _ = pipe.backend_to_agent(rd) => debug!(%stream_id, "backend closed the forwarded stream"),
        _ = cancel.cancelled() => debug!(%stream_id, "forward dropped with its session"),
    }
    if let Some(outbound) = &outbound {
        outbound.close();
    }
    transport.close(&stream_id);
}

/// The two pumps of one forwarded stream.
struct StreamPipe<'a> {
    transport: &'a dyn ForwardTransport,
    stream_id: &'a str,
    /// The granted window; `None` for an agent without flow control.
    window: Option<usize>,
    /// Credit for backend → agent bytes, released by the agent's acks.
    outbound: Option<&'a ForwardWindow>,
}

impl StreamPipe<'_> {
    /// Agent → backend: route the agent's events — acks to the outbound credit,
    /// data to the backend writer — until the agent ends the stream.
    ///
    /// The router never waits on the backend socket, so the agent's acks keep
    /// releasing credit even while a slow backend holds the writer up.
    async fn agent_to_backend(
        &self,
        mut from_agent: mpsc::UnboundedReceiver<ForwardEvent>,
        mut wr: OwnedWriteHalf,
    ) {
        let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let route = async move {
            while let Some(event) = from_agent.recv().await {
                match event {
                    ForwardEvent::Data(bytes) => {
                        if data_tx.send(bytes).is_err() {
                            break;
                        }
                    }
                    ForwardEvent::Ack(bytes) => {
                        if let Some(outbound) = self.outbound {
                            outbound.release(usize::try_from(bytes).unwrap_or(usize::MAX));
                        }
                    }
                }
            }
            // Dropping `data_tx` lets the writer finish what it has.
        };
        let write = async {
            let threshold = self.window.map(ack_threshold);
            let mut consumed = 0usize;
            while let Some(bytes) = data_rx.recv().await {
                if wr.write_all(&bytes).await.is_err() {
                    break;
                }
                if let Some(threshold) = threshold {
                    consumed += bytes.len();
                    if consumed >= threshold {
                        self.transport.ack(self.stream_id, consumed as u64);
                        consumed = 0;
                    }
                }
            }
            let _ = wr.shutdown().await;
        };
        tokio::join!(route, write);
    }

    /// Backend → agent: read only while the agent's window has credit (when it
    /// granted one) and send each read through the transport.
    async fn backend_to_agent(&self, mut rd: OwnedReadHalf) {
        let mut buf = vec![0u8; AGENT_FORWARD_CHUNK_SIZE];
        loop {
            let limit = match self.outbound {
                Some(outbound) => match outbound.wait_credit().await {
                    Some(credit) => credit.min(buf.len()),
                    None => break,
                },
                None => buf.len(),
            };
            match rd.read(&mut buf[..limit]).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(outbound) = self.outbound {
                        outbound.consume(n);
                    }
                    if self
                        .transport
                        .send(self.stream_id, buf[..n].to_vec())
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "agent_port_forward_tests.rs"]
mod tests;
