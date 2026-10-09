//! Desktop end of the ssh-agent relay (#1727).
//!
//! When an SSH session routed through a deployed agent opts into `forwardAgent`
//! and the desktop reaches that agent over the **TCP transport**, there is no
//! SSH leg to carry agent forwarding (unlike #1719's host-local chaining). The
//! agent instead tunnels each forwarded ssh-agent connection to the desktop over
//! the JSON-RPC transport via `agent.forward.*` messages; this module is the
//! desktop side of that tunnel.
//!
//! For each stream the agent opens, we connect to the **operator's own** local
//! ssh-agent — through [`termihub_core::backends::ssh::agent_forward::connect_local_agent_boxed`],
//! the exact connector the russh bridge uses — and pump bytes both ways:
//!
//! - `agent.forward.open`  → connect the local agent, start pumping.
//! - `agent.forward.data`  (agent→desktop) → write to the local agent.
//! - local agent → desktop → `agent.forward.data`/`agent.forward.close` requests
//!   back to the agent (carried as [`AgentIoCommand`]).
//! - `agent.forward.close` → drop the stream.
//!
//! The same stream table also carries **desktop port forwards** (#3241): a
//! VNC/RDP connection hosted under an agent registers a stream here with
//! [`register_stream`](DesktopAgentForward::register_stream) before asking the
//! agent to `agent.forward.connect` to its target, so the agent's `data` /
//! `close` notifications for that stream reach the local loopback socket the
//! graphical backend dialled (see `session::agent_port_forward`). Such a stream
//! also receives the agent's `agent.forward.ack` credit (#4284) as
//! [`ForwardEvent::Ack`], so the port forward can keep its own bytes within the
//! window the agent granted.
//!
//! No local agent is a graceful no-op: the connect fails, we answer with an
//! immediate `agent.forward.close`, and the agent drops the forwarded channel —
//! matching the no-agent behaviour of the SSH-reached path (#1699/#1719).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use termihub_core::backends::ssh::agent_forward::{
    connect_local_agent_boxed, LocalAgentStream, AGENT_FORWARD_CHUNK_SIZE,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{self, UnboundedSender};
use tracing::debug;

use super::agent_manager::{AgentIoCommand, AgentIoSender};

/// What the agent sends for one forwarded stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForwardEvent {
    /// Stream bytes (`agent.forward.data`).
    Data(Vec<u8>),
    /// The agent wrote this many of the desktop's bytes to the target
    /// (`agent.forward.ack`, #4284), returning that much window credit.
    Ack(u64),
}

/// Where the agent's events for one stream are delivered. Dropped (the receiver
/// sees the channel close) when the stream ends.
///
/// Unbounded, and bounded in practice by the protocol: an ssh-agent stream is
/// request/response (TAURI-014), and a flow-controlled port-forward stream
/// carries at most the granted window of data before the desktop acks it
/// (#4284). Only a port forward to an agent older than #4284 is unbounded, as
/// it always was.
pub type ForwardSink = UnboundedSender<ForwardEvent>;

/// A one-shot factory that connects to the operator's local ssh-agent, yielding
/// a duplex byte stream (or a `NotFound`-style error when no agent is
/// reachable). Injected into the pump so tests can drive the no-local-agent path
/// deterministically — by handing over a connector that fails — instead of
/// pointing the process-global `SSH_AUTH_SOCK` at a dead path and racing sibling
/// tests (#2127).
type LocalAgentConnector = Box<
    dyn FnOnce() -> Pin<Box<dyn Future<Output = std::io::Result<Box<dyn LocalAgentStream>>> + Send>>
        + Send,
>;

/// The production connector: the operator's own local ssh-agent (Unix
/// `$SSH_AUTH_SOCK` / the Windows OpenSSH named pipe), the exact connector the
/// russh bridge uses.
fn default_connector() -> LocalAgentConnector {
    Box::new(|| Box::pin(connect_local_agent_boxed()))
}

/// Routes the desktop end of forwarded ssh-agent streams to the operator's
/// local ssh-agent. One instance per connected agent's I/O loop.
///
/// Cloneable (shares one stream table) so pump tasks can deregister themselves.
#[derive(Clone, Default)]
pub struct DesktopAgentForward {
    /// `stream_id` → sink feeding agent→desktop events into the local-agent
    /// writer (or the port forward) for that stream.
    streams: Arc<Mutex<HashMap<String, ForwardSink>>>,
}

impl DesktopAgentForward {
    /// Create an empty relay handler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Handle `agent.forward.open`: register the stream and start a task that
    /// connects to the local agent and pumps bytes for the stream's lifetime.
    ///
    /// `command_tx` is the I/O task's gated sender (#3018): the pump awaits data
    /// credit before each reply chunk, so a slow agent link backpressures the
    /// local ssh-agent read instead of queuing without bound.
    pub(crate) fn on_open(&self, stream_id: String, command_tx: AgentIoSender) {
        self.on_open_with(stream_id, command_tx, default_connector());
    }

    /// [`on_open`] with an injectable local-agent connector — the seam tests use
    /// to exercise the no-local-agent path without mutating `SSH_AUTH_SOCK`
    /// (#2127). Production calls [`on_open`], which passes [`default_connector`].
    fn on_open_with(
        &self,
        stream_id: String,
        command_tx: impl Into<AgentIoSender>,
        connect: LocalAgentConnector,
    ) {
        let command_tx = command_tx.into();
        // TAURI-014: intentionally UNBOUNDED, and safe. The producer is the remote
        // agent forwarding one operator ssh-agent connection, whose traffic is
        // protocol-bounded: ssh-agent is strictly request/response with small
        // messages (a sign request → a signature), so bytes arrive only as fast as
        // the local agent answers the previous one — there is no streaming firehose
        // to outrun the writer task that drains this channel. A bound here would buy
        // no memory safety and risks stalling the agent's I/O loop, so it stays
        // unbounded by design (contrast the process-output path in local_process.rs,
        // which is genuinely unbounded and uses a bounded, backpressured channel).
        let (tx, rx) = mpsc::unbounded_channel::<ForwardEvent>();
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(stream_id.clone(), tx);

        let streams = self.streams.clone();
        // Not app-owned (#3105): stream-scoped relay; ends when the forwarded stream closes.
        tokio::spawn(async move {
            pump_local_agent(stream_id, rx, command_tx, streams, connect).await;
        });
    }

    /// Handle `agent.forward.data` from the agent: feed the bytes to the local
    /// agent. Unknown/closed streams are ignored.
    pub fn on_data(&self, stream_id: &str, data: Vec<u8>) {
        if let Some(tx) = self
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(stream_id)
        {
            let _ = tx.send(ForwardEvent::Data(data));
        }
    }

    /// Handle `agent.forward.ack` from the agent (#4284): hand the credit to
    /// the stream's owner. Unknown/closed streams are ignored.
    pub fn on_ack(&self, stream_id: &str, bytes: u64) {
        if let Some(tx) = self
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(stream_id)
        {
            let _ = tx.send(ForwardEvent::Ack(bytes));
        }
    }

    /// Register a desktop-initiated port-forward stream (#3241): the agent's
    /// `data` and `ack` for `stream_id` are fed into `sink`, and its `close` (or
    /// [`clear`](Self::clear)) drops `sink`, which the owner reads as the stream
    /// ending.
    pub fn register_stream(&self, stream_id: String, sink: ForwardSink) {
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(stream_id, sink);
    }

    /// Drop every stream — the agent transport broke, so none of them survives
    /// into a reconnected agent (#3241). Each owner sees its sink close.
    pub fn clear(&self) {
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Handle `agent.forward.close` from the agent: drop the stream. Dropping the
    /// sink ends the writer, which shuts the local agent connection.
    pub fn on_close(&self, stream_id: &str) {
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(stream_id);
    }
}

/// Connect to the operator's local ssh-agent and pump one forwarded stream both
/// ways until either end closes.
async fn pump_local_agent(
    stream_id: String,
    rx: mpsc::UnboundedReceiver<ForwardEvent>,
    command_tx: AgentIoSender,
    streams: Arc<Mutex<HashMap<String, ForwardSink>>>,
    connect: LocalAgentConnector,
) {
    let agent = match connect().await {
        Ok(agent) => agent,
        Err(e) => {
            // No local agent — mirror the russh no-op: tell the agent to drop the
            // forwarded channel, and forget the stream.
            debug!("no local ssh-agent to answer forwarded stream {stream_id}: {e}");
            let _ = command_tx
                .send(AgentIoCommand::AgentForwardClose {
                    stream_id: stream_id.clone(),
                })
                .await;
            streams
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&stream_id);
            return;
        }
    };

    let (mut read_half, mut write_half) = tokio::io::split(agent);

    // Writer: agent→desktop bytes → local agent, until the stream is closed.
    // Not app-owned (#3105): stream-scoped writer; ends when the stream's channel closes.
    let writer = tokio::spawn(async move {
        let mut rx = rx;
        while let Some(event) = rx.recv().await {
            // An ssh-agent stream is never windowed, so no ack arrives here.
            let ForwardEvent::Data(bytes) = event else {
                continue;
            };
            if write_half.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
        let _ = write_half.shutdown().await;
    });

    // Reader: local agent replies → agent, as forward-data requests.
    let mut buf = vec![0u8; AGENT_FORWARD_CHUNK_SIZE];
    loop {
        match read_half.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                // Awaits data credit (#3018); fails once the agent I/O loop is
                // gone or reconnecting (the stream died with the transport).
                let sent = command_tx
                    .send(AgentIoCommand::AgentForwardData {
                        stream_id: stream_id.clone(),
                        data: buf[..n].to_vec(),
                    })
                    .await;
                if sent.is_err() {
                    break;
                }
            }
            Err(e) => {
                debug!("forwarded ssh-agent stream {stream_id} read ended: {e}");
                break;
            }
        }
    }

    let _ = command_tx
        .send(AgentIoCommand::AgentForwardClose {
            stream_id: stream_id.clone(),
        })
        .await;
    streams
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&stream_id);
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `on_data`/`on_close` for a stream that was never opened (or already
    /// closed) are silent no-ops — a late frame must never panic.
    #[tokio::test]
    async fn data_and_close_for_unknown_stream_are_noops() {
        let relay = DesktopAgentForward::new();
        relay.on_data("ghost#1", b"bytes".to_vec());
        relay.on_close("ghost#1");
        assert!(relay.streams.lock().unwrap().is_empty());
    }

    /// A registered port-forward stream (#3241) receives the agent's bytes, and
    /// both `close` and `clear` end it (its receiver sees the channel close).
    #[tokio::test]
    async fn registered_stream_receives_data_until_closed_or_cleared() {
        let relay = DesktopAgentForward::new();
        let (tx, mut rx) = mpsc::unbounded_channel::<ForwardEvent>();
        relay.register_stream("gfx-1".to_string(), tx);
        relay.on_data("gfx-1", b"frame".to_vec());
        assert_eq!(rx.recv().await, Some(ForwardEvent::Data(b"frame".to_vec())));
        // #4284: the agent's window credit reaches the stream's owner.
        relay.on_ack("gfx-1", 4096);
        assert_eq!(rx.recv().await, Some(ForwardEvent::Ack(4096)));
        relay.on_close("gfx-1");
        assert_eq!(rx.recv().await, None);
        relay.on_ack("gfx-1", 1);

        let (tx2, mut rx2) = mpsc::unbounded_channel::<ForwardEvent>();
        relay.register_stream("gfx-2".to_string(), tx2);
        relay.clear();
        assert_eq!(rx2.recv().await, None);
        assert!(relay.streams.lock().unwrap().is_empty());
    }

    /// With no local ssh-agent reachable, an opened stream answers the agent with
    /// a `close` and deregisters itself — the graceful no-op the target sees as
    /// "no keys forwarded".
    #[tokio::test]
    async fn open_without_local_agent_closes_and_deregisters() {
        let relay = DesktopAgentForward::new();
        let (tx, mut rx) = mpsc::unbounded_channel::<AgentIoCommand>();
        // Inject a connector that always fails — the no-local-agent path — so the
        // test drives it deterministically, without pointing the process-global
        // SSH_AUTH_SOCK at a dead path and racing sibling tests (#2127).
        relay.on_open_with(
            "sess#1".to_string(),
            tx,
            Box::new(|| {
                Box::pin(async {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no local ssh-agent",
                    ))
                })
            }),
        );

        // The pump task must report the stream closed …
        let cmd = rx.recv().await.expect("a close command");
        match cmd {
            AgentIoCommand::AgentForwardClose { stream_id } => assert_eq!(stream_id, "sess#1"),
            _ => panic!("expected AgentForwardClose"),
        }
        // … and drop it from the table.
        for _ in 0..50 {
            if relay.streams.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(relay.streams.lock().unwrap().is_empty());
    }
}
