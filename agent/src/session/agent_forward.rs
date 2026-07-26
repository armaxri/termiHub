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
//! Both unix and Windows agent hosts relay (#1727 shipped unix; #2038 added the
//! Windows named-pipe path). Only truly exotic targets with neither a Unix socket
//! nor a named pipe fall back to #1719's host-local model; [`should_relay`] gates
//! it.

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
    /// `stream_id` → sink writing bytes into that connection (desktop → socket).
    streams: Mutex<HashMap<String, StreamSink>>,
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

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        self.streams.lock().await.insert(stream_id.clone(), tx);
        self.notify(AGENT_FORWARD_OPEN, json!({ "stream_id": stream_id }));

        tokio::spawn(write_socket(write_half, rx));

        let relay = Arc::clone(&self);
        tokio::spawn(async move { relay.read_socket(read_half, stream_id).await });
    }

    /// Pump endpoint → desktop: forward each read as a data notification, and on
    /// EOF/error deregister the stream and tell the desktop it closed.
    #[cfg(any(unix, windows))]
    async fn read_socket<R>(self: Arc<Self>, mut read_half: R, stream_id: String)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
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

/// Pump desktop → endpoint: write each queued reply chunk to the connection until
/// the desktop closes the stream (sink dropped), then shut the write side so the
/// daemon's bridge sees EOF. Generic over the connection's write half so the unix
/// socket and Windows pipe share one body.
#[cfg(any(unix, windows))]
async fn write_socket<W>(mut write_half: W, mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>)
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
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
}
