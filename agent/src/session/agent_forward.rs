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
//! relay endpoint — a Unix socket on unix, a named pipe on Windows (#2038) — and
//! exports it to the session daemon (as `SSH_AUTH_SOCK` on unix, via the
//! dedicated
//! [`AGENT_PIPE_ENV`](termihub_core::backends::ssh::agent_forward::AGENT_PIPE_ENV)
//! on Windows). The daemon's core SSH bridge
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
//! immediate `close`, the relay endpoint closes, and the daemon's bridge drops
//! the forwarded channel — matching #1719's no-agent behaviour.
//!
//! # Desktop-initiated TCP streams (#3241)
//!
//! The same stream protocol also carries a **desktop-side port forward**: the
//! desktop asks the agent to [`connect_tcp`](AgentForwardRelay::connect_tcp) to a
//! `host:port` target with the **request** `agent.forward.connect`
//! `{stream_id, host, port}`, and the resulting TCP connection is then relayed
//! with the very same `data` / `close` messages. This is how a VNC/RDP
//! connection hosted under an agent reaches its server: the desktop keeps
//! running the graphical backend and only its TCP transport rides the agent.
//!
//! # Flow control (#4284)
//!
//! A graphical stream is bulk traffic, so a desktop that asks for it
//! (`agent.forward.connect` with a `window`, protocol 0.28.0) gets a
//! credit-windowed stream: at most the granted window is in flight per
//! direction, acknowledged with `agent.forward.ack` — see
//! [`agent_forward_flow`](super::agent_forward_flow). A slow desktop canvas then
//! slows the remote desktop server through TCP instead of queuing data on the
//! agent. Streams without a window — an older desktop, and the ssh-agent relay,
//! whose traffic is request/response — are relayed unbounded, as before.
//!
//! Both unix and Windows agent hosts relay (#1727 shipped unix; #2038 added the
//! Windows named-pipe path). Only truly exotic targets with neither a Unix socket
//! nor a named pipe fall back to #1719's host-local model; [`should_relay`] gates
//! it.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use tokio::sync::Mutex;
use tracing::{debug, warn};

use termihub_core::backends::ssh::agent_forward::AGENT_FORWARD_CHUNK_SIZE;

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{
    AgentForwardCloseParams, AgentForwardDataParams, AgentForwardOpenParams,
};
use crate::session::agent_forward_flow::StreamFlow;
use crate::transport::to_params;

/// Both directions: a forwarded ssh-agent stream ended.
pub use crate::protocol::methods::AGENT_FORWARD_CLOSE;
/// Both directions: a chunk of ssh-agent-protocol bytes for a stream.
pub use crate::protocol::methods::AGENT_FORWARD_DATA;
/// agent → desktop: a forwarded ssh-agent connection opened on the agent host.
pub use crate::protocol::methods::AGENT_FORWARD_OPEN;

/// How long [`AgentForwardRelay::connect_tcp`] waits for the target to accept
/// before reporting it unreachable (#3241). Bounded so a black-holed target
/// fails the desktop's connect promptly instead of hanging it.
const TCP_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Sender that feeds desktop→socket bytes to one accepted relay connection.
///
/// Unbounded, but on a windowed stream (#4284) what it holds is capped by
/// [`StreamFlow::admit`]: the desktop may have at most the window unacked.
type StreamSink = tokio::sync::mpsc::UnboundedSender<Vec<u8>>;

/// One live stream: where desktop bytes go, and its flow control when the
/// desktop asked for it (#4284).
struct StreamEntry {
    sink: StreamSink,
    flow: Option<Arc<StreamFlow>>,
}

impl StreamEntry {
    /// Teardown: wake a reader parked on the stream's exhausted window.
    fn close(&self) {
        if let Some(flow) = &self.flow {
            flow.close();
        }
    }
}

/// What the socket writer needs to acknowledge desktop bytes on a windowed
/// stream (#4284).
struct InboundAcks {
    flow: Arc<StreamFlow>,
    stream_id: String,
    notifications: NotificationSender,
}

/// Per-session listener bookkeeping so a closed session tears its endpoint down.
///
/// Aborting `handle` stops the accept loop; on unix the bound socket file must
/// also be unlinked, whereas a Windows named pipe vanishes once its last server
/// handle drops (the pending instance the accept task holds), so it carries no
/// `path`.
#[cfg(any(unix, windows))]
struct ListenerGuard {
    handle: tokio::task::JoinHandle<()>,
    #[cfg(unix)]
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
    /// `stream_id` → sink writing bytes into that connection (desktop → socket)
    /// plus its flow control.
    streams: Mutex<HashMap<String, StreamEntry>>,
    /// Reader tasks of desktop-initiated TCP streams (#3241), so a desktop
    /// `close` stops reading the target too (not only writing to it) and the
    /// target connection is released at once.
    tcp_readers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// `session_id` → its listener, so [`stop_listener`](Self::stop_listener)
    /// can drop the endpoint when the session ends. Present on every relaying
    /// platform (unix socket / Windows pipe).
    #[cfg(any(unix, windows))]
    listeners: Mutex<HashMap<String, ListenerGuard>>,
}

impl AgentForwardRelay {
    /// Create a relay bound to the given desktop notification channel.
    pub fn new(notification_tx: NotificationSender) -> Arc<Self> {
        Arc::new(Self {
            notification_tx,
            streams: Mutex::new(HashMap::new()),
            tcp_readers: Mutex::new(HashMap::new()),
            #[cfg(any(unix, windows))]
            listeners: Mutex::new(HashMap::new()),
        })
    }

    /// Whether a session should get a desktop-agent relay: only an SSH session
    /// that opted into `forwardAgent`, and only on a platform whose bridge target
    /// can be overridden per session (unix socket / Windows pipe — see the module
    /// docs). Exotic targets with neither fall back to #1719's host-local model.
    pub fn should_relay(type_id: &str, settings: &serde_json::Value) -> bool {
        (cfg!(unix) || cfg!(windows))
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

    /// Feed desktop-supplied bytes (the operator's agent's reply, or a port
    /// forward's client bytes) to the matching relay connection.
    /// Unknown/closed streams are ignored. On a windowed stream (#4284) bytes
    /// past the granted window break the protocol: the stream is closed, not
    /// buffered without bound.
    pub async fn write(&self, stream_id: &str, data: Vec<u8>) {
        let overrun = {
            let streams = self.streams.lock().await;
            let Some(entry) = streams.get(stream_id) else {
                return;
            };
            let len = data.len();
            if entry.flow.as_ref().is_some_and(|flow| !flow.admit(len)) {
                true
            } else {
                let _ = entry.sink.send(data);
                false
            }
        };
        if overrun {
            warn!(
                stream_id,
                "desktop overran the forward window; closing the stream"
            );
            self.close_stream(stream_id).await;
            self.notify(
                AGENT_FORWARD_CLOSE,
                to_params(&AgentForwardCloseParams {
                    stream_id: stream_id.to_string(),
                }),
            );
        }
    }

    /// The desktop consumed `bytes` of a windowed stream (`agent.forward.ack`,
    /// #4284): return that much credit to its target reader. Unknown or
    /// unwindowed streams ignore it.
    pub async fn ack(&self, stream_id: &str, bytes: u64) {
        if let Some(flow) = self
            .streams
            .lock()
            .await
            .get(stream_id)
            .and_then(|entry| entry.flow.as_ref())
        {
            flow.ack(bytes);
        }
    }

    /// Drop a stream the desktop closed (its local agent went away, or the
    /// conversation finished). Dropping the sink ends the writer task, which
    /// shuts the socket's write side so the daemon's bridge sees EOF.
    pub async fn close_stream(&self, stream_id: &str) {
        if let Some(entry) = self.streams.lock().await.remove(stream_id) {
            entry.close();
        }
        // A desktop-initiated TCP stream also stops reading its target, so the
        // connection to it closes now rather than when the target hangs up.
        if let Some(reader) = self.tcp_readers.lock().await.remove(stream_id) {
            reader.abort();
        }
    }

    /// Open a TCP connection from the agent host to `host:port` and relay it to
    /// the desktop as stream `stream_id` (#3241) — the agent end of a desktop
    /// port forward. Bytes then flow with the ordinary `agent.forward.data` /
    /// `agent.forward.close` messages in both directions.
    ///
    /// Fails (and registers nothing) when the id is already in use, or the
    /// target refuses, is unresolvable, or does not answer within
    /// [`TCP_CONNECT_TIMEOUT`]; the error text is what the desktop shows.
    ///
    /// Unwindowed — the pre-#4284 behaviour; see
    /// [`connect_tcp_windowed`](Self::connect_tcp_windowed).
    pub async fn connect_tcp(
        self: &Arc<Self>,
        stream_id: &str,
        host: &str,
        port: u16,
    ) -> Result<(), String> {
        self.connect_tcp_windowed(stream_id, host, port, None)
            .await
            .map(|_| ())
    }

    /// [`connect_tcp`](Self::connect_tcp) with flow control (#4284): when the
    /// desktop requested a `window`, both directions of the stream are bounded
    /// by the window granted, which is returned (capped at the agent's
    /// maximum). `None` relays unbounded, for a desktop that does not ack.
    pub async fn connect_tcp_windowed(
        self: &Arc<Self>,
        stream_id: &str,
        host: &str,
        port: u16,
        window: Option<u64>,
    ) -> Result<Option<u64>, String> {
        if self.streams.lock().await.contains_key(stream_id) {
            return Err(format!("forward stream {stream_id} is already open"));
        }
        let conn = tokio::time::timeout(
            TCP_CONNECT_TIMEOUT,
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .map_err(|_| format!("timed out connecting to {host}:{port} from the agent host"))?
        .map_err(|e| format!("cannot reach {host}:{port} from the agent host: {e}"))?;
        let _ = conn.set_nodelay(true);
        let (read_half, write_half) = conn.into_split();

        let flow = window.map(|w| Arc::new(StreamFlow::granted(w)));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        self.streams.lock().await.insert(
            stream_id.to_string(),
            StreamEntry {
                sink: tx,
                flow: flow.clone(),
            },
        );
        let acks = flow.clone().map(|flow| InboundAcks {
            flow,
            stream_id: stream_id.to_string(),
            notifications: self.notification_tx.clone(),
        });
        tokio::spawn(write_socket(write_half, rx, acks));

        let relay = Arc::clone(self);
        let sid = stream_id.to_string();
        let reader_flow = flow.clone();
        let reader =
            tokio::spawn(async move { relay.read_socket(read_half, sid, reader_flow).await });
        self.tcp_readers
            .lock()
            .await
            .insert(stream_id.to_string(), reader.abort_handle());
        let granted = flow.map(|f| f.window() as u64);
        debug!(
            stream_id,
            host,
            port,
            ?granted,
            "opened desktop port-forward stream"
        );
        Ok(granted)
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

    /// Start a per-session ssh-agent relay named pipe and return its name to
    /// inject into the daemon via
    /// [`AGENT_PIPE_ENV`](termihub_core::backends::ssh::agent_forward::AGENT_PIPE_ENV)
    /// (#2038) — the Windows analog of the unix relay socket.
    ///
    /// The first server instance is bound up front so a name collision surfaces
    /// synchronously, before the daemon is told to use it; the accept loop keeps a
    /// fresh instance armed for each subsequent connection.
    #[cfg(windows)]
    pub async fn start_listener(self: &Arc<Self>, session_id: &str) -> std::io::Result<String> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe = crate::daemon::transport::agent_forward_endpoint(session_id);
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)?;

        let relay = Arc::clone(self);
        let name = pipe.clone();
        let sid = session_id.to_string();
        let handle = tokio::spawn(async move { relay.accept_loop(server, name, sid).await });

        self.listeners
            .lock()
            .await
            .insert(session_id.to_string(), ListenerGuard { handle });
        debug!(session_id, %pipe, "started ssh-agent relay pipe");
        Ok(pipe)
    }

    /// Tear a session's relay down: stop accepting, remove the socket file (unix),
    /// and drop any of its still-open streams. Idempotent; a no-op on a platform
    /// that never relays.
    pub async fn stop_listener(&self, session_id: &str) {
        #[cfg(any(unix, windows))]
        {
            if let Some(guard) = self.listeners.lock().await.remove(session_id) {
                // Aborting the accept task drops its pending pipe instance on
                // Windows, which closes the pipe; on unix the socket file must be
                // unlinked explicitly.
                guard.handle.abort();
                #[cfg(unix)]
                let _ = std::fs::remove_file(&guard.path);
            }
        }
        let prefix = stream_prefix(session_id);
        self.streams.lock().await.retain(|id, entry| {
            let keep = !id.starts_with(&prefix);
            if !keep {
                entry.close();
            }
            keep
        });
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

    /// Accept forwarded ssh-agent connections on the session's named pipe until
    /// the session ends (the task is aborted by
    /// [`stop_listener`](Self::stop_listener)).
    ///
    /// A Windows named-pipe server serves one client per instance, so after a
    /// client connects the next instance is armed immediately — before the
    /// accepted connection is handed off — so a client arriving right behind it is
    /// not refused (the core connector also retries briefly on a busy pipe).
    #[cfg(windows)]
    async fn accept_loop(
        self: Arc<Self>,
        first: tokio::net::windows::named_pipe::NamedPipeServer,
        pipe: String,
        session_id: String,
    ) {
        use tokio::net::windows::named_pipe::ServerOptions;

        let mut server = first;
        let mut counter: u64 = 0;
        loop {
            if let Err(e) = server.connect().await {
                debug!(session_id, "ssh-agent relay pipe connect ended: {e}");
                break;
            }
            let connected = server;

            // Arm the next instance before serving this one.
            let next = ServerOptions::new().create(&pipe);
            counter += 1;
            let stream_id = format!("{}{}", stream_prefix(&session_id), counter);
            Arc::clone(&self).spawn_stream(connected, stream_id).await;

            server = match next {
                Ok(s) => s,
                Err(e) => {
                    debug!(session_id, "ssh-agent relay pipe re-arm failed: {e}");
                    break;
                }
            };
        }
    }

    /// Wire one accepted connection to the desktop: register a write sink,
    /// announce it, then pump bytes endpoint→desktop for the life of the stream.
    ///
    /// Generic over the connection type so the unix socket and Windows pipe accept
    /// loops share one body.
    #[cfg(any(unix, windows))]
    async fn spawn_stream<S>(self: Arc<Self>, conn: S, stream_id: String)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
    {
        let (read_half, write_half) = tokio::io::split(conn);

        // TAURI-014: unbounded, and safe for this relay — ssh-agent traffic is
        // request/response with small messages, so no window is needed.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        self.streams.lock().await.insert(
            stream_id.clone(),
            StreamEntry {
                sink: tx,
                flow: None,
            },
        );
        self.notify(
            AGENT_FORWARD_OPEN,
            to_params(&AgentForwardOpenParams {
                stream_id: stream_id.clone(),
            }),
        );

        tokio::spawn(write_socket(write_half, rx, None));

        let relay = Arc::clone(&self);
        tokio::spawn(async move { relay.read_socket(read_half, stream_id, None).await });
    }

    /// Pump endpoint → desktop: forward each read as a data notification, and on
    /// EOF/error deregister the stream and tell the desktop it closed.
    ///
    /// On a windowed stream (#4284) each read waits for credit and takes at most
    /// that much, so no more than the window is ever queued toward the desktop;
    /// a closed window (teardown) ends the pump.
    async fn read_socket<R>(
        self: Arc<Self>,
        mut read_half: R,
        stream_id: String,
        flow: Option<Arc<StreamFlow>>,
    ) where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        use tokio::io::AsyncReadExt;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = vec![0u8; AGENT_FORWARD_CHUNK_SIZE];
        loop {
            let limit = match &flow {
                Some(flow) => match flow.outbound().wait_credit().await {
                    Some(credit) => credit.min(buf.len()),
                    None => break,
                },
                None => buf.len(),
            };
            match read_half.read(&mut buf[..limit]).await {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(flow) = &flow {
                        flow.outbound().consume(n);
                    }
                    // `into_params` moves the encoded bytes into the params
                    // object: no more allocations than the old `json!` (#3759).
                    self.notify(
                        AGENT_FORWARD_DATA,
                        AgentForwardDataParams {
                            stream_id: stream_id.clone(),
                            data: b64.encode(&buf[..n]),
                        }
                        .into_params(),
                    );
                }
                Err(e) => {
                    debug!(stream_id, "ssh-agent relay read ended: {e}");
                    break;
                }
            }
        }
        if let Some(entry) = self.streams.lock().await.remove(&stream_id) {
            entry.close();
        }
        self.tcp_readers.lock().await.remove(&stream_id);
        self.notify(
            AGENT_FORWARD_CLOSE,
            to_params(&AgentForwardCloseParams { stream_id }),
        );
    }
}

/// The desktop-initiated TCP streams (`agent.forward.connect`, #3241) one client
/// connection opened, so they close when that client disconnects.
///
/// A `--listen` agent shares one [`AgentForwardRelay`] across every client it
/// serves, so a vanished desktop's port forwards would otherwise keep their
/// target connections open (and a single-client VNC server would then refuse
/// the reconnect). Scoped per connection, not per relay, so one desktop leaving
/// never cuts another's streams.
pub struct ClientForwardStreams {
    session_manager: Arc<dyn crate::session::manager::SessionManagerApi>,
    ids: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl ClientForwardStreams {
    /// Track streams for one client connection of `session_manager`'s relay.
    pub fn new(session_manager: Arc<dyn crate::session::manager::SessionManagerApi>) -> Arc<Self> {
        Arc::new(Self {
            session_manager,
            ids: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
    }

    /// Record a stream this client opened.
    pub fn track(&self, stream_id: &str) {
        self.ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(stream_id.to_string());
    }

    /// Forget a stream this client closed itself.
    pub fn untrack(&self, stream_id: &str) {
        self.ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(stream_id);
    }

    /// Number of streams currently tracked.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.ids.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Close every stream this client still has open (it disconnected). Runs on
    /// a spawned task because the caller (the transport's disconnect path) is
    /// synchronous; a no-op outside a Tokio runtime or with nothing open.
    pub fn close_all(&self) {
        let ids: Vec<String> = self
            .ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect();
        if ids.is_empty() {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let session_manager = Arc::clone(&self.session_manager);
        rt.spawn(async move {
            for id in ids {
                session_manager.agent_forward_close(&id).await;
            }
        });
    }
}

/// Prefix that ties a `stream_id` to its `session_id` for teardown matching.
fn stream_prefix(session_id: &str) -> String {
    format!("{session_id}#")
}

/// Pump desktop → endpoint: write each queued reply chunk to the connection until
/// the desktop closes the stream (sink dropped), then shut the write side so the
/// daemon's bridge sees EOF. Generic over the connection's write half so the unix
/// socket and Windows pipe share one body. On a windowed stream (#4284) each
/// chunk is acknowledged to the desktop once written.
async fn write_socket<W>(
    mut write_half: W,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    acks: Option<InboundAcks>,
) where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tokio::io::AsyncWriteExt;
    while let Some(bytes) = rx.recv().await {
        if write_half.write_all(&bytes).await.is_err() {
            break;
        }
        let _ = write_half.flush().await;
        if let Some(acks) = &acks {
            acks.flow
                .written(bytes.len(), &acks.stream_id, &acks.notifications);
        }
    }
    let _ = write_half.shutdown().await;
}

/// Flow control for desktop port-forward streams (#4284).
#[cfg(test)]
#[path = "agent_forward_flow_tests.rs"]
mod flow_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_relay() -> (
        Arc<AgentForwardRelay>,
        tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (AgentForwardRelay::new(tx), rx)
    }

    /// Relaying is gated to SSH sessions that asked for `forwardAgent`, on any
    /// platform whose bridge target is overridable per session (unix socket /
    /// Windows pipe).
    #[test]
    fn should_relay_only_for_ssh_forward_agent() {
        let on = json!({ "forwardAgent": true });
        let off = json!({ "forwardAgent": false });
        let absent = json!({});

        assert_eq!(
            AgentForwardRelay::should_relay("ssh", &on),
            cfg!(unix) || cfg!(windows),
            "ssh + forwardAgent relays on unix and windows"
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

    /// Wait for the next notification of `method`, skipping others.
    async fn next_of(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
        method: &str,
    ) -> serde_json::Value {
        loop {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("notification in time")
                .expect("channel open");
            if n.method == method {
                return n.params;
            }
        }
    }

    /// A desktop-initiated TCP stream (#3241) relays both ways: desktop bytes
    /// reach the target, target bytes come back as `data` notifications, and a
    /// desktop `close` releases the target connection (it reads EOF).
    #[tokio::test]
    async fn connect_tcp_relays_both_ways_and_close_releases_the_target() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = target.local_addr().unwrap().port();
        let (relay, mut rx) = test_relay();

        relay
            .connect_tcp("gfx#1", "127.0.0.1", port)
            .await
            .expect("connect to a listening target");
        let (mut server, _) = target.accept().await.unwrap();

        // desktop → target
        relay.write("gfx#1", b"RFB?".to_vec()).await;
        let mut buf = [0u8; 4];
        server.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"RFB?");

        // target → desktop
        server.write_all(b"RFB 003.008\n").await.unwrap();
        let params = next_of(&mut rx, AGENT_FORWARD_DATA).await;
        assert_eq!(params["stream_id"], "gfx#1");
        let b64 = base64::engine::general_purpose::STANDARD;
        let data = b64.decode(params["data"].as_str().unwrap()).unwrap();
        assert_eq!(data, b"RFB 003.008\n");

        // desktop close → the target sees EOF and nothing stays registered.
        relay.close_stream("gfx#1").await;
        let mut rest = Vec::new();
        let n = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            server.read_to_end(&mut rest),
        )
        .await
        .expect("target released in time")
        .unwrap();
        assert_eq!(n, 0);
        assert!(relay.streams.lock().await.is_empty());
        assert!(relay.tcp_readers.lock().await.is_empty());
    }

    /// The target hanging up closes the stream toward the desktop.
    #[tokio::test]
    async fn connect_tcp_target_hangup_notifies_close() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = target.local_addr().unwrap().port();
        let (relay, mut rx) = test_relay();
        relay.connect_tcp("gfx#2", "127.0.0.1", port).await.unwrap();
        let (server, _) = target.accept().await.unwrap();
        drop(server);

        let params = next_of(&mut rx, AGENT_FORWARD_CLOSE).await;
        assert_eq!(params["stream_id"], "gfx#2");
        assert!(relay.streams.lock().await.is_empty());
    }

    /// An unreachable target fails the connect with a readable reason and
    /// registers nothing; a duplicate stream id is refused.
    #[tokio::test]
    async fn connect_tcp_unreachable_target_errors_and_duplicate_is_refused() {
        // Bind then drop to get a port nothing listens on.
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let (relay, _rx) = test_relay();
        let err = relay
            .connect_tcp("gfx#3", "127.0.0.1", port)
            .await
            .unwrap_err();
        assert!(err.contains("from the agent host"), "{err}");
        assert!(relay.streams.lock().await.is_empty());

        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live = target.local_addr().unwrap().port();
        relay.connect_tcp("gfx#4", "127.0.0.1", live).await.unwrap();
        let dup = relay
            .connect_tcp("gfx#4", "127.0.0.1", live)
            .await
            .unwrap_err();
        assert!(dup.contains("already open"), "{dup}");
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
        // #3759: byte-identical to the legacy `json!` builder.
        assert_eq!(
            serde_json::to_string(&open).unwrap(),
            serde_json::to_string(&JsonRpcNotification::new(
                AGENT_FORWARD_OPEN,
                json!({ "stream_id": stream_id })
            ))
            .unwrap()
        );

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

    /// End-to-end proof of the relay's data path against a **real** ssh-agent:
    /// a real `ssh-add -l` client connects to the relay socket, a stand-in
    /// desktop bridges the tunnelled stream to a live `ssh-agent`, and the client
    /// sees the agent's actual key — i.e. the target's `$SSH_AUTH_SOCK` (the
    /// relay socket) exposes the operator's keys, which is the whole point of
    /// #1727. Skips where `ssh-agent`/`ssh-add`/`ssh-keygen` are unavailable.
    #[cfg(unix)]
    #[tokio::test]
    async fn relay_socket_exposes_a_real_ssh_agent_key_end_to_end() {
        use std::collections::HashMap as Map;
        use std::process::Command;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        fn have(bin: &str) -> bool {
            Command::new("sh")
                .arg("-c")
                .arg(format!("command -v {bin}"))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        if !(have("ssh-agent") && have("ssh-add") && have("ssh-keygen")) {
            eprintln!("skipping: ssh-agent/ssh-add/ssh-keygen not available");
            return;
        }

        let dir = std::env::temp_dir().join(format!("thub-1727-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let agent_sock = dir.join("agent.sock");
        let key = dir.join("id_ed25519");

        // A live ssh-agent bound to a known socket, holding one generated key.
        let out = Command::new("ssh-agent")
            .arg("-a")
            .arg(&agent_sock)
            .output()
            .expect("spawn ssh-agent");
        assert!(out.status.success(), "ssh-agent failed to start");
        let agent_pid = String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.trim().strip_prefix("SSH_AGENT_PID="))
            .and_then(|s| s.split(';').next())
            .map(|s| s.to_string());

        let cleanup = |pid: Option<String>, dir: std::path::PathBuf| {
            if let Some(pid) = pid {
                let _ = Command::new("kill").arg(&pid).status();
            }
            let _ = std::fs::remove_dir_all(&dir);
        };

        let keygen = Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-C", "thub-1727-e2e"])
            .arg("-f")
            .arg(&key)
            .output()
            .expect("ssh-keygen");
        assert!(keygen.status.success(), "ssh-keygen failed");

        let add = Command::new("ssh-add")
            .arg(&key)
            .env("SSH_AUTH_SOCK", &agent_sock)
            .output()
            .expect("ssh-add");
        assert!(add.status.success(), "ssh-add failed: {add:?}");

        // The relay under test, plus a stand-in desktop that bridges each
        // tunnelled stream to the live agent (the src-tauri DesktopAgentForward
        // in miniature).
        let (relay, mut rx) = test_relay();
        let session_id = format!("afr-e2e-{}", std::process::id());
        let relay_path = relay.start_listener(&session_id).await.expect("listener");

        let desktop_relay = Arc::clone(&relay);
        let real_sock = agent_sock.clone();
        let desktop = tokio::spawn(async move {
            let mut streams: Map<String, tokio::sync::mpsc::UnboundedSender<Vec<u8>>> = Map::new();
            let b64 = base64::engine::general_purpose::STANDARD;
            while let Some(n) = rx.recv().await {
                let sid = n.params["stream_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                match n.method.as_str() {
                    m if m == AGENT_FORWARD_OPEN => {
                        let conn = tokio::net::UnixStream::connect(&real_sock).await.unwrap();
                        let (mut ar, mut aw) = tokio::io::split(conn);
                        let (tx, mut inbound) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
                        streams.insert(sid.clone(), tx);
                        tokio::spawn(async move {
                            while let Some(b) = inbound.recv().await {
                                if aw.write_all(&b).await.is_err() {
                                    break;
                                }
                                let _ = aw.flush().await;
                            }
                            let _ = aw.shutdown().await;
                        });
                        let relay = Arc::clone(&desktop_relay);
                        let sid2 = sid.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 4096];
                            loop {
                                match ar.read(&mut buf).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(k) => relay.write(&sid2, buf[..k].to_vec()).await,
                                }
                            }
                            relay.close_stream(&sid2).await;
                        });
                    }
                    m if m == AGENT_FORWARD_DATA => {
                        if let Some(tx) = streams.get(&sid) {
                            if let Ok(d) = b64.decode(n.params["data"].as_str().unwrap_or_default())
                            {
                                let _ = tx.send(d);
                            }
                        }
                    }
                    m if m == AGENT_FORWARD_CLOSE => {
                        streams.remove(&sid);
                    }
                    _ => {}
                }
            }
        });

        // The real client: `ssh-add -l` against the relay socket must list the
        // key the live agent holds — proving the keys travelled the tunnel.
        let listed = tokio::task::spawn_blocking({
            let relay_path = relay_path.clone();
            move || {
                Command::new("ssh-add")
                    .arg("-l")
                    .env("SSH_AUTH_SOCK", &relay_path)
                    .output()
            }
        })
        .await
        .unwrap()
        .expect("ssh-add -l");

        desktop.abort();
        relay.stop_listener(&session_id).await;
        let stdout = String::from_utf8_lossy(&listed.stdout).to_string();
        cleanup(agent_pid, dir);

        assert!(
            listed.status.success() && stdout.contains("thub-1727-e2e"),
            "relay socket must expose the live agent's key; got status={:?} stdout={stdout:?}",
            listed.status
        );
    }

    /// Windows analog of `accepted_connection_streams_open_data_close`: a client
    /// connecting to the per-session **named pipe** is announced with `open`, its
    /// bytes tunnel as base64 `data`, and disconnecting yields `close`. Exercises
    /// the whole pipe→desktop pump on the platform #2038 added.
    #[cfg(windows)]
    #[tokio::test]
    async fn accepted_pipe_connection_streams_open_data_close() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::windows::named_pipe::ClientOptions;

        let (relay, mut rx) = test_relay();
        let session_id = format!("afr-win-{}", std::process::id());
        let pipe = relay
            .start_listener(&session_id)
            .await
            .expect("start listener");

        let mut client = ClientOptions::new()
            .open(&pipe)
            .expect("connect relay pipe");
        client.write_all(b"hello-agent").await.expect("write");
        client.flush().await.expect("flush");

        let open = rx.recv().await.expect("open notification");
        assert_eq!(open.method, AGENT_FORWARD_OPEN);
        let stream_id = open.params["stream_id"].as_str().unwrap().to_string();
        assert!(stream_id.starts_with(&stream_prefix(&session_id)));
        // #3759: byte-identical to the legacy `json!` builder.
        assert_eq!(
            serde_json::to_string(&open).unwrap(),
            serde_json::to_string(&JsonRpcNotification::new(
                AGENT_FORWARD_OPEN,
                json!({ "stream_id": stream_id })
            ))
            .unwrap()
        );

        let data = rx.recv().await.expect("data notification");
        assert_eq!(data.method, AGENT_FORWARD_DATA);
        assert_eq!(data.params["stream_id"], stream_id);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data.params["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, b"hello-agent");

        drop(client);
        let close = rx.recv().await.expect("close notification");
        assert_eq!(close.method, AGENT_FORWARD_CLOSE);
        assert_eq!(close.params["stream_id"], stream_id);

        relay.stop_listener(&session_id).await;
    }

    /// Windows analog of `desktop_reply_bytes_reach_the_client`: bytes the desktop
    /// supplies via `write` reach the client connected to the relay pipe.
    #[cfg(windows)]
    #[tokio::test]
    async fn desktop_reply_bytes_reach_the_pipe_client() {
        use tokio::io::AsyncReadExt;
        use tokio::net::windows::named_pipe::ClientOptions;

        let (relay, mut rx) = test_relay();
        let session_id = format!("afr-win-reply-{}", std::process::id());
        let pipe = relay
            .start_listener(&session_id)
            .await
            .expect("start listener");

        let mut client = ClientOptions::new()
            .open(&pipe)
            .expect("connect relay pipe");

        // The server accepts on connect, so `open` fires without the client
        // writing anything.
        let open = rx.recv().await.expect("open notification");
        let stream_id = open.params["stream_id"].as_str().unwrap().to_string();

        relay.write(&stream_id, b"agent-reply".to_vec()).await;

        let mut buf = vec![0u8; 11];
        client.read_exact(&mut buf).await.expect("read reply");
        assert_eq!(&buf, b"agent-reply");

        relay.stop_listener(&session_id).await;
    }

    /// Windows analog of `stop_listener_removes_socket_and_streams`: tearing a
    /// session down drops its still-open streams (the pipe closes when the accept
    /// task's pending instance is aborted).
    #[cfg(windows)]
    #[tokio::test]
    async fn stop_listener_clears_streams_on_windows() {
        use tokio::net::windows::named_pipe::ClientOptions;

        let (relay, _rx) = test_relay();
        let session_id = format!("afr-win-stop-{}", std::process::id());
        let pipe = relay
            .start_listener(&session_id)
            .await
            .expect("start listener");

        let _client = ClientOptions::new().open(&pipe).expect("connect");
        // Let the accept loop register the stream.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        relay.stop_listener(&session_id).await;
        assert!(
            relay.streams.lock().await.is_empty(),
            "session's streams dropped on teardown"
        );
    }

    /// #3759: the relay's `agent.forward.data` / `agent.forward.close`
    /// notifications stay byte-identical to the legacy `json!` builders.
    #[tokio::test]
    async fn tcp_stream_wire_is_byte_identical_to_legacy_json() {
        use tokio::io::AsyncWriteExt;

        let wire = |method: &str, params: serde_json::Value| {
            serde_json::to_string(&JsonRpcNotification::new(method, params)).unwrap()
        };
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = target.local_addr().unwrap().port();
        let (relay, mut rx) = test_relay();
        relay
            .connect_tcp("gfx#\"w\"", "127.0.0.1", port)
            .await
            .unwrap();
        let (mut server, _) = target.accept().await.unwrap();

        let payload: Vec<u8> = (0..=255u8).collect();
        server.write_all(&payload).await.unwrap();
        server.flush().await.unwrap();
        drop(server);

        // Reads may split the payload; compare every data notification.
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut received = Vec::new();
        loop {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("notification in time")
                .expect("channel open");
            let actual = serde_json::to_string(&n).unwrap();
            if n.method == AGENT_FORWARD_DATA {
                let data = n.params["data"].as_str().unwrap().to_owned();
                received.extend(b64.decode(&data).unwrap());
                let legacy = json!({ "stream_id": "gfx#\"w\"", "data": data });
                assert_eq!(actual, wire(AGENT_FORWARD_DATA, legacy));
            } else {
                assert_eq!(n.method, AGENT_FORWARD_CLOSE);
                let legacy = json!({ "stream_id": "gfx#\"w\"" });
                assert_eq!(actual, wire(AGENT_FORWARD_CLOSE, legacy));
                break;
            }
        }
        assert_eq!(received, payload);
    }
}
