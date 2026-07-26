//! Relaying the **desktop's** ssh-agent to a session daemon over the JSON-RPC
//! transport (#1727).
//!
//! # The gap this fills
//!
//! #1719 made SSH agent forwarding work through a deployed agent by bridging the
//! target's forwarded-agent channel to the ssh-agent **local to the agent host**
//! (`$SSH_AUTH_SOCK`). That transparently reaches the operator's keys only when
//! the desktop→agent leg is *itself* SSH with agent forwarding on, so the agent
//! host's `$SSH_AUTH_SOCK` chains back to the operator. Over the **TCP
//! (`--listen`) transport** there is no such SSH leg, so nothing on the agent
//! host points at the operator's agent.
//!
//! # The relay
//!
//! When a session opts into `forwardAgent`, the agent worker binds a per-session
//! Unix socket and exports it to the session daemon as `SSH_AUTH_SOCK` (see
//! [`crate::session::manager`]). The daemon's core SSH bridge
//! ([`termihub_core::backends::ssh::agent_forward`]) then connects to *that*
//! socket exactly as it would a normal agent — "the target sees a normal
//! `$SSH_AUTH_SOCK`". Each connection the daemon opens is tunnelled, byte for
//! byte, over the desktop↔agent JSON-RPC transport to the desktop, which pumps
//! it against the operator's own local ssh-agent. So the operator's keys reach
//! the final target regardless of how the desktop reached the agent.
//!
//! The sub-protocol mirrors the PTY plumbing (`connection.output` /
//! `connection.write`): an id-tagged stream carrying base64 chunks.
//!
//! - agent → desktop **notification** [`AGENT_FORWARD_OPEN`] `{stream_id}` — a
//!   forwarded ssh-agent connection appeared on the agent host.
//! - agent → desktop **notification** [`AGENT_FORWARD_DATA`] `{stream_id, data}`
//!   — bytes the target's client wrote (chunked ≤ 64 KiB, like `send_output`).
//! - desktop → agent **request** [`AGENT_FORWARD_DATA`] `{stream_id, data}` —
//!   the operator's agent's reply bytes.
//! - either side **`agent.forward.close`** `{stream_id}` — the stream ended.
//!
//! No desktop agent is a graceful no-op: the desktop answers `open` with an
//! immediate `close`, the relay socket closes, and the daemon's bridge drops the
//! forwarded channel — matching #1719's no-agent behaviour.
//!
//! Relaying is **unix-only** for now: the desktop bridge target on Windows is a
//! fixed OpenSSH named pipe rather than a `SSH_AUTH_SOCK` we can override, so a
//! Windows agent host keeps #1719's host-local model. [`should_relay`] gates it.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use serde_json::json;
use tokio::sync::Mutex;
use tracing::debug;

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;

/// agent → desktop: a forwarded ssh-agent connection opened on the agent host.
pub const AGENT_FORWARD_OPEN: &str = "agent.forward.open";
/// Both directions: a chunk of ssh-agent-protocol bytes for a stream.
pub const AGENT_FORWARD_DATA: &str = "agent.forward.data";
/// Both directions: a forwarded ssh-agent stream ended.
pub const AGENT_FORWARD_CLOSE: &str = "agent.forward.close";

/// Max bytes per data notification — mirrors `JsonRpcOutputSink`'s 64 KiB chunk
/// so a burst stays under the transport's 1 MiB NDJSON line cap.
const CHUNK_SIZE: usize = 65536;

/// Sender that feeds desktop→socket bytes to one accepted relay connection.
type StreamSink = tokio::sync::mpsc::UnboundedSender<Vec<u8>>;

/// Per-session listener bookkeeping so a closed session tears its socket down.
#[cfg(unix)]
struct ListenerGuard {
    handle: tokio::task::JoinHandle<()>,
    path: String,
}

/// Bridges each forwarded ssh-agent connection on the agent host to the
/// desktop's own agent over the JSON-RPC transport.
///
/// One instance per [`crate::session::manager::SessionManager`]: it owns the
/// desktop notification channel and the live-stream registry the dispatch
/// handlers write into.
pub struct AgentForwardRelay {
    notification_tx: NotificationSender,
    /// `stream_id` → sink writing bytes into that connection (desktop → socket).
    streams: Mutex<HashMap<String, StreamSink>>,
    /// `session_id` → its listener, so [`stop_listener`](Self::stop_listener)
    /// can drop the socket when the session ends. Unix-only (the only relaying
    /// platform).
    #[cfg(unix)]
    listeners: Mutex<HashMap<String, ListenerGuard>>,
}

impl AgentForwardRelay {
    /// Create a relay bound to the given desktop notification channel.
    pub fn new(notification_tx: NotificationSender) -> Arc<Self> {
        Arc::new(Self {
            notification_tx,
            streams: Mutex::new(HashMap::new()),
            #[cfg(unix)]
            listeners: Mutex::new(HashMap::new()),
        })
    }

    /// Whether a session should get a desktop-agent relay: only an SSH session
    /// that opted into `forwardAgent`, and only on unix (see the module docs on
    /// the Windows limitation).
    pub fn should_relay(type_id: &str, settings: &serde_json::Value) -> bool {
        cfg!(unix)
            && type_id == "ssh"
            && settings
                .get("forwardAgent")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
    }

    /// Send a JSON-RPC notification to the desktop, ignoring a closed channel
    /// (a disconnected desktop simply loses forwarding — never fatal).
    fn notify(&self, method: &str, params: serde_json::Value) {
        let _ = self
            .notification_tx
            .send(JsonRpcNotification::new(method, params));
    }

    /// Feed desktop-supplied bytes (the operator's agent's reply) to the
    /// matching relay connection. Unknown/closed streams are ignored.
    pub async fn write(&self, stream_id: &str, data: Vec<u8>) {
        if let Some(sink) = self.streams.lock().await.get(stream_id) {
            let _ = sink.send(data);
        }
    }

    /// Drop a stream the desktop closed (its local agent went away, or the
    /// conversation finished). Dropping the sink ends the writer task, which
    /// shuts the socket's write side so the daemon's bridge sees EOF.
    pub async fn close_stream(&self, stream_id: &str) {
        self.streams.lock().await.remove(stream_id);
    }

    /// Start a per-session ssh-agent relay listener and return the socket path
    /// to export as the daemon's `SSH_AUTH_SOCK`.
    ///
    /// The daemon connects to this socket through the same core bridge a real
    /// agent would use; every connection is tunnelled to the desktop.
    #[cfg(unix)]
    pub async fn start_listener(self: &Arc<Self>, session_id: &str) -> std::io::Result<String> {
        crate::daemon::transport::ensure_agent_forward_dir()?;
        let path = crate::daemon::transport::agent_forward_endpoint(session_id);
        // A stale socket from a crashed predecessor would fail the bind.
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path)?;

        let relay = Arc::clone(self);
        let sid = session_id.to_string();
        let handle = tokio::spawn(async move { relay.accept_loop(listener, sid).await });

        self.listeners.lock().await.insert(
            session_id.to_string(),
            ListenerGuard {
                handle,
                path: path.clone(),
            },
        );
        debug!(session_id, %path, "started ssh-agent relay listener");
        Ok(path)
    }

    /// Tear a session's relay down: stop accepting, remove the socket file, and
    /// drop any of its still-open streams. Idempotent; a no-op on non-unix.
    pub async fn stop_listener(&self, session_id: &str) {
        #[cfg(unix)]
        {
            if let Some(guard) = self.listeners.lock().await.remove(session_id) {
                guard.handle.abort();
                let _ = std::fs::remove_file(&guard.path);
            }
        }
        let prefix = stream_prefix(session_id);
        self.streams
            .lock()
            .await
            .retain(|id, _| !id.starts_with(&prefix));
        let _ = session_id;
    }

    /// Accept forwarded ssh-agent connections until the session ends (the task
    /// is aborted by [`stop_listener`](Self::stop_listener)).
    #[cfg(unix)]
    async fn accept_loop(self: Arc<Self>, listener: tokio::net::UnixListener, session_id: String) {
        let mut counter: u64 = 0;
        loop {
            match listener.accept().await {
                Ok((conn, _)) => {
                    counter += 1;
                    let stream_id = format!("{}{}", stream_prefix(&session_id), counter);
                    Arc::clone(&self).spawn_stream(conn, stream_id).await;
                }
                Err(e) => {
                    debug!(session_id, "ssh-agent relay accept ended: {e}");
                    break;
                }
            }
        }
    }

    /// Wire one accepted connection to the desktop: register a write sink,
    /// announce it, then pump bytes socket→desktop for the life of the stream.
    #[cfg(unix)]
    async fn spawn_stream(self: Arc<Self>, conn: tokio::net::UnixStream, stream_id: String) {
        let (read_half, write_half) = tokio::io::split(conn);

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        self.streams.lock().await.insert(stream_id.clone(), tx);
        self.notify(AGENT_FORWARD_OPEN, json!({ "stream_id": stream_id }));

        tokio::spawn(write_socket(write_half, rx));

        let relay = Arc::clone(&self);
        tokio::spawn(async move { relay.read_socket(read_half, stream_id).await });
    }

    /// Pump socket → desktop: forward each read as a data notification, and on
    /// EOF/error deregister the stream and tell the desktop it closed.
    #[cfg(unix)]
    async fn read_socket(
        self: Arc<Self>,
        mut read_half: tokio::io::ReadHalf<tokio::net::UnixStream>,
        stream_id: String,
    ) {
        use tokio::io::AsyncReadExt;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            match read_half.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = b64.encode(&buf[..n]);
                    self.notify(
                        AGENT_FORWARD_DATA,
                        json!({ "stream_id": stream_id, "data": encoded }),
                    );
                }
                Err(e) => {
                    debug!(stream_id, "ssh-agent relay read ended: {e}");
                    break;
                }
            }
        }
        self.streams.lock().await.remove(&stream_id);
        self.notify(AGENT_FORWARD_CLOSE, json!({ "stream_id": stream_id }));
    }
}

/// Prefix that ties a `stream_id` to its `session_id` for teardown matching.
fn stream_prefix(session_id: &str) -> String {
    format!("{session_id}#")
}

/// Pump desktop → socket: write each queued reply chunk to the connection until
/// the desktop closes the stream (sink dropped), then shut the write side so the
/// daemon's bridge sees EOF.
#[cfg(unix)]
async fn write_socket(
    mut write_half: tokio::io::WriteHalf<tokio::net::UnixStream>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) {
    use tokio::io::AsyncWriteExt;
    while let Some(bytes) = rx.recv().await {
        if write_half.write_all(&bytes).await.is_err() {
            break;
        }
        let _ = write_half.flush().await;
    }
    let _ = write_half.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_relay() -> (
        Arc<AgentForwardRelay>,
        tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (AgentForwardRelay::new(tx), rx)
    }

    /// Relaying is gated to SSH sessions that asked for `forwardAgent` — and,
    /// because the desktop bridge target is only overridable on unix, to unix.
    #[test]
    fn should_relay_only_for_ssh_forward_agent() {
        let on = json!({ "forwardAgent": true });
        let off = json!({ "forwardAgent": false });
        let absent = json!({});

        assert_eq!(
            AgentForwardRelay::should_relay("ssh", &on),
            cfg!(unix),
            "ssh + forwardAgent relays on unix only"
        );
        assert!(!AgentForwardRelay::should_relay("ssh", &off));
        assert!(!AgentForwardRelay::should_relay("ssh", &absent));
        assert!(
            !AgentForwardRelay::should_relay("local", &on),
            "only ssh sessions forward an agent"
        );
    }

    /// `write`/`close_stream` for an unknown stream are silent no-ops — a stray
    /// desktop frame for a stream that already closed must never panic.
    #[tokio::test]
    async fn write_and_close_unknown_stream_are_noops() {
        let (relay, _rx) = test_relay();
        relay.write("nope#1", b"data".to_vec()).await;
        relay.close_stream("nope#1").await;
    }

    /// An accepted connection announces itself with an `open` notification and
    /// tunnels the bytes the client writes as base64 `data`; closing the client
    /// side yields a `close`. Exercises the whole socket→desktop pump.
    #[cfg(unix)]
    #[tokio::test]
    async fn accepted_connection_streams_open_data_close() {
        use tokio::io::AsyncWriteExt;

        let (relay, mut rx) = test_relay();
        let session_id = format!("afr-test-{}", std::process::id());
        let path = relay
            .start_listener(&session_id)
            .await
            .expect("start listener");

        let mut client = tokio::net::UnixStream::connect(&path)
            .await
            .expect("connect relay socket");
        client.write_all(b"hello-agent").await.expect("write");
        client.flush().await.expect("flush");

        // open, then data carrying our bytes.
        let open = rx.recv().await.expect("open notification");
        assert_eq!(open.method, AGENT_FORWARD_OPEN);
        let stream_id = open.params["stream_id"].as_str().unwrap().to_string();
        assert!(stream_id.starts_with(&stream_prefix(&session_id)));

        let data = rx.recv().await.expect("data notification");
        assert_eq!(data.method, AGENT_FORWARD_DATA);
        assert_eq!(data.params["stream_id"], stream_id);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data.params["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, b"hello-agent");

        // Client closes → close notification and the stream is deregistered.
        drop(client);
        let close = rx.recv().await.expect("close notification");
        assert_eq!(close.method, AGENT_FORWARD_CLOSE);
        assert_eq!(close.params["stream_id"], stream_id);

        relay.stop_listener(&session_id).await;
    }

    /// Desktop-supplied reply bytes reach the connected client through `write`.
    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_reply_bytes_reach_the_client() {
        use tokio::io::AsyncReadExt;

        let (relay, mut rx) = test_relay();
        let session_id = format!("afr-reply-{}", std::process::id());
        let path = relay
            .start_listener(&session_id)
            .await
            .expect("start listener");

        let mut client = tokio::net::UnixStream::connect(&path)
            .await
            .expect("connect relay socket");

        let open = rx.recv().await.expect("open notification");
        let stream_id = open.params["stream_id"].as_str().unwrap().to_string();

        relay.write(&stream_id, b"agent-reply".to_vec()).await;

        let mut buf = vec![0u8; 11];
        client.read_exact(&mut buf).await.expect("read reply");
        assert_eq!(&buf, b"agent-reply");

        relay.stop_listener(&session_id).await;
    }

    /// Tearing a session down removes its socket and any lingering stream
    /// entries, so a later session cannot bind a stale path or route to a dead
    /// stream.
    #[cfg(unix)]
    #[tokio::test]
    async fn stop_listener_removes_socket_and_streams() {
        let (relay, _rx) = test_relay();
        let session_id = format!("afr-stop-{}", std::process::id());
        let path = relay
            .start_listener(&session_id)
            .await
            .expect("start listener");
        assert!(std::path::Path::new(&path).exists());

        let _client = tokio::net::UnixStream::connect(&path)
            .await
            .expect("connect");
        // Let the accept loop register the stream.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        relay.stop_listener(&session_id).await;
        assert!(
            !std::path::Path::new(&path).exists(),
            "socket file removed on teardown"
        );
        assert!(
            relay.streams.lock().await.is_empty(),
            "session's streams dropped on teardown"
        );
    }
}
