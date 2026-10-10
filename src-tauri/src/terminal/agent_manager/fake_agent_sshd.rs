//! In-process SSH server standing in for a remote `termihub-agent` (#4304).
//!
//! Lets the connect / handshake / reap regression tests drive the real
//! [`AgentConnectionManager::connect_agent`] path — russh connect, password
//! auth, exec, `initialize` — on every PR, with no `sshd` binary and no agent
//! build. It serves a loopback TCP port with:
//!
//! * password auth for [`LOGIN_PASSWORD`];
//! * exec channels that accept any command (the agent launch line);
//! * an `initialize` handler whose behaviour the test picks: never answer
//!   ([`InitBehavior::Stall`]), answer at once ([`InitBehavior::Answer`]), or
//!   answer only once the test opens a gate ([`InitBehavior::AnswerWhenReleased`]).
//!
//! It also serves two test-only methods for the stdout framing tests (#4303):
//! `fake.echo` answers with its params — preceded by a `fake.note`
//! notification — one byte per SSH data message, so every chunk boundary lands
//! inside a line and inside each multi-byte character; `fake.flood` streams
//! `params.bytes` bytes with no newline. Every other JSON-RPC line is ignored.
//!
//! For the output flow control tests (#4416) it records every request it
//! receives ([`FakeAgentSshd::requests`]), can advertise the `outputFlow`
//! capability ([`InitBehavior::AnswerWithOutputFlow`]), and serves
//! `fake.output_flood`: `params.chunks` `connection.output` notifications of
//! `params.size` bytes for `params.session_id`, followed by the answer.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use termihub_core::ipc::ndjson::LineSplitter;
use tokio::sync::{watch, Notify};

use crate::terminal::backend::RemoteAgentConfig;

/// The account password the server accepts.
pub(super) const LOGIN_PASSWORD: &str = "Fake-Agent-Login-Pw-4304";

/// How the fake agent treats the desktop's `initialize` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum InitBehavior {
    /// Read the request and never answer it — a wedged agent.
    Stall,
    /// Answer straight away with a minimal valid `InitializeResult`.
    Answer,
    /// Answer once [`FakeAgentSshd::release`] is called.
    AnswerWhenReleased,
    /// Answer straight away, reporting [`SPLIT_AGENT_VERSION`] as the agent
    /// version, one byte per SSH data message (#4303).
    AnswerInOneByteChunks,
    /// Answer straight away as a protocol 0.27.0 agent advertising the
    /// `outputFlow` capability (#4416).
    AnswerWithOutputFlow,
    /// Answer the first `initialize` as [`RICH_AGENT_VERSION`] (`outputFlow`,
    /// `fileRanges`, `hostFileAttributeOps`), every later one as a minimal
    /// [`MINIMAL_AGENT_VERSION`] agent — a downgrade across a reconnect (#4440).
    DowngradeOnReconnect,
    /// The reverse of [`InitBehavior::DowngradeOnReconnect`]: minimal first,
    /// rich on every reconnect — an update across a reconnect (#4440).
    UpgradeOnReconnect,
}

/// The agent version the rich `initialize` answer reports (#4440).
pub(super) const RICH_AGENT_VERSION: &str = "0.29.0-fake";

/// The agent version the minimal `initialize` answer reports (#4440).
pub(super) const MINIMAL_AGENT_VERSION: &str = "0.26.0-fake";

/// One JSON-RPC request the fake agent received: `(method, params)`.
pub(super) type ReceivedRequest = (String, serde_json::Value);

/// The non-ASCII agent version [`InitBehavior::AnswerInOneByteChunks`] reports.
pub(super) const SPLIT_AGENT_VERSION: &str = "0.0.0-Übersicht-€-😀";

/// Bytes per data message `fake.flood` writes.
const FLOOD_CHUNK: usize = 32 * 1024;

/// A running fake agent endpoint; stops accepting when dropped.
pub(super) struct FakeAgentSshd {
    pub(super) port: u16,
    /// `initialize` requests received so far (one per connect attempt that
    /// reached the handshake).
    inits: Arc<AtomicUsize>,
    init_seen: Arc<Notify>,
    release: watch::Sender<bool>,
    accept_task: tokio::task::JoinHandle<()>,
    /// Every request received, in arrival order (#4416).
    requests: Arc<std::sync::Mutex<Vec<ReceivedRequest>>>,
}

impl Drop for FakeAgentSshd {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

impl FakeAgentSshd {
    /// Start the server on an ephemeral loopback port. Must be called inside a
    /// Tokio runtime, which then drives it.
    pub(super) async fn serve(behavior: InitBehavior) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind the fake agent SSH server");
        let port = listener.local_addr().expect("fake agent address").port();
        let config = Arc::new(russh::server::Config {
            keys: vec![russh::keys::PrivateKey::from(
                russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[43u8; 32]),
            )],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let inits = Arc::new(AtomicUsize::new(0));
        let init_seen = Arc::new(Notify::new());
        let (release, release_rx) = watch::channel(false);
        let requests: Arc<std::sync::Mutex<Vec<ReceivedRequest>>> = Arc::default();
        let task_requests = requests.clone();
        let task_inits = inits.clone();
        let task_seen = init_seen.clone();
        let accept_task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let handler = FakeAgentHandler {
                    behavior,
                    inits: task_inits.clone(),
                    init_seen: task_seen.clone(),
                    release: release_rx.clone(),
                    lines: LineSplitter::new(),
                    requests: task_requests.clone(),
                };
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(running) = russh::server::run_stream(config, stream, handler).await {
                        let _ = running.await;
                    }
                });
            }
        });
        Self {
            port,
            inits,
            init_seen,
            release,
            accept_task,
            requests,
        }
    }

    /// Every request received so far, in arrival order (#4416).
    pub(super) fn requests(&self) -> Vec<ReceivedRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// The params of every request for `method` received so far.
    pub(super) fn requests_for(&self, method: &str) -> Vec<serde_json::Value> {
        self.requests()
            .into_iter()
            .filter(|(m, _)| m == method)
            .map(|(_, params)| params)
            .collect()
    }

    /// The agent connect config pointing at this server.
    pub(super) fn agent_config(&self) -> RemoteAgentConfig {
        RemoteAgentConfig {
            host: "127.0.0.1".to_string(),
            port: self.port,
            username: "fake-agent-user".to_string(),
            auth_method: "password".to_string(),
            password: Some(LOGIN_PASSWORD.to_string()),
            key_path: None,
            save_password: None,
            agent_path: Some("/opt/fake/termihub-agent".to_string()),
            external_connection_files: vec![],
            ..Default::default()
        }
    }

    /// How many `initialize` requests have arrived.
    pub(super) fn inits(&self) -> usize {
        self.inits.load(Ordering::SeqCst)
    }

    /// Wait until at least `n` `initialize` requests have arrived, i.e. the
    /// desktop is past SSH auth and parked in the handshake read.
    pub(super) async fn wait_for_inits(&self, n: usize, within: Duration) {
        let deadline = tokio::time::Instant::now() + within;
        while self.inits() < n {
            let notified = self.init_seen.notified();
            if self.inits() >= n {
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                panic!(
                    "fake agent saw {} initialize request(s), expected {n} within {within:?}",
                    self.inits()
                );
            }
        }
    }

    /// Let every held (and future) [`InitBehavior::AnswerWhenReleased`] answer go out.
    pub(super) fn release(&self) {
        let _ = self.release.send(true);
    }
}

/// A minimal valid `initialize` answer for request `id`.
fn initialize_answer(id: u64) -> String {
    initialize_answer_with_version(id, "0.0.0-fake")
}

/// An `initialize` answer from a protocol 0.27.0 agent advertising
/// `outputFlow` (#4416).
fn initialize_answer_with_output_flow(id: u64) -> String {
    ndjson_line(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "0.27.0",
            "agentVersion": "0.0.0-fake",
            "clientId": "fake-client",
            "capabilities": { "connectionTypes": [], "maxSessions": 20, "outputFlow": true },
        },
    }))
}

/// An `initialize` answer from a protocol 0.29.0 agent advertising
/// `outputFlow`, `fileRanges` and `hostFileAttributeOps` (#4440).
fn initialize_answer_rich(id: u64) -> String {
    ndjson_line(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "0.29.0",
            "agentVersion": RICH_AGENT_VERSION,
            "clientId": "fake-client",
            "capabilities": {
                "connectionTypes": [],
                "maxSessions": 20,
                "outputFlow": true,
                "fileRanges": true,
                "hostFileAttributeOps": { "permissions": true, "owner": false, "symlink": true },
            },
        },
    }))
}

/// [`initialize_answer`] reporting `agent_version`.
fn initialize_answer_with_version(id: u64, agent_version: &str) -> String {
    let mut line = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocol_version": "0.13.0",
            "agent_version": agent_version,
            "client_id": "fake-client",
            "capabilities": { "connectionTypes": [], "maxSessions": 20 },
        },
    })
    .to_string();
    line.push('\n');
    line
}

struct FakeAgentHandler {
    behavior: InitBehavior,
    inits: Arc<AtomicUsize>,
    init_seen: Arc<Notify>,
    release: watch::Receiver<bool>,
    lines: LineSplitter,
    requests: Arc<std::sync::Mutex<Vec<ReceivedRequest>>>,
}

/// Queue `bytes` on `channel` one byte per SSH data message.
fn send_one_byte_at_a_time(session: &mut Session, channel: ChannelId, bytes: &[u8]) {
    for byte in bytes {
        let _ = session.data(channel, vec![*byte]);
    }
}

/// One NDJSON line for `value`.
fn ndjson_line(value: &serde_json::Value) -> String {
    let mut line = value.to_string();
    line.push('\n');
    line
}

impl FakeAgentHandler {
    /// Note one `initialize` request and answer it as configured.
    fn on_initialize(&self, channel: ChannelId, id: u64, session: &mut Session) {
        let first = self.inits.fetch_add(1, Ordering::SeqCst) == 0;
        self.init_seen.notify_waiters();
        match self.behavior {
            InitBehavior::DowngradeOnReconnect | InitBehavior::UpgradeOnReconnect => {
                let rich = first == (self.behavior == InitBehavior::DowngradeOnReconnect);
                let answer = if rich {
                    initialize_answer_rich(id)
                } else {
                    initialize_answer_with_version(id, MINIMAL_AGENT_VERSION)
                };
                let _ = session.data(channel, answer.into_bytes());
            }
            InitBehavior::Stall => {}
            InitBehavior::Answer => {
                let _ = session.data(channel, initialize_answer(id).into_bytes());
            }
            InitBehavior::AnswerWithOutputFlow => {
                let _ = session.data(channel, initialize_answer_with_output_flow(id).into_bytes());
            }
            InitBehavior::AnswerInOneByteChunks => {
                let answer = initialize_answer_with_version(id, SPLIT_AGENT_VERSION);
                send_one_byte_at_a_time(session, channel, answer.as_bytes());
            }
            InitBehavior::AnswerWhenReleased => {
                let handle = session.handle();
                let mut release = self.release.clone();
                tokio::spawn(async move {
                    if release.wait_for(|open| *open).await.is_ok() {
                        let _ = handle
                            .data(channel, initialize_answer(id).into_bytes())
                            .await;
                    }
                });
            }
        }
    }
}

impl russh::server::Handler for FakeAgentHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == LOGIN_PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        // Everything is answered through the handler callbacks; an unread
        // channel object would only fill up, so it is dropped right away.
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    /// The desktop's JSON-RPC lines on the agent's stdin.
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let messages: Vec<serde_json::Value> = self
            .lines
            .push(data)
            .filter_map(|line| serde_json::from_str(line.ok()?.trim()).ok())
            .collect();
        for msg in messages {
            let Some(id) = msg.get("id").and_then(|i| i.as_u64()) else {
                continue;
            };
            let params = msg.get("params").cloned().unwrap_or_default();
            if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                self.requests
                    .lock()
                    .unwrap()
                    .push((method.to_string(), params.clone()));
            }
            match msg.get("method").and_then(|m| m.as_str()) {
                Some("initialize") => self.on_initialize(channel, id, session),
                Some("fake.echo") => {
                    let note = serde_json::json!({
                        "jsonrpc": "2.0", "method": "fake.note", "params": params,
                    });
                    let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": params });
                    let wire = ndjson_line(&note) + &ndjson_line(&reply);
                    send_one_byte_at_a_time(session, channel, wire.as_bytes());
                }
                Some("fake.output_flood") => {
                    let handle = session.handle();
                    tokio::spawn(async move {
                        let sid = params["session_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string();
                        let chunks = params["chunks"].as_u64().unwrap_or(0);
                        let size = params["size"].as_u64().unwrap_or(1) as usize;
                        let b64 = base64::engine::general_purpose::STANDARD;
                        for i in 0..chunks {
                            // Each chunk is filled with its own index byte, so
                            // a lost or reordered chunk is visible.
                            let data = vec![(i % 251) as u8; size];
                            let note = serde_json::json!({
                                "jsonrpc": "2.0",
                                "method": "connection.output",
                                "params": { "session_id": sid, "data": b64.encode(&data) },
                            });
                            if handle
                                .data(channel, ndjson_line(&note).into_bytes())
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} });
                        let _ = handle.data(channel, ndjson_line(&reply).into_bytes()).await;
                    });
                }
                Some("fake.flood") => {
                    let total = params.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0);
                    let handle = session.handle();
                    tokio::spawn(async move {
                        let mut sent: u64 = 0;
                        while sent < total {
                            let n = FLOOD_CHUNK.min((total - sent) as usize);
                            if handle.data(channel, vec![b'x'; n]).await.is_err() {
                                break;
                            }
                            sent += n as u64;
                        }
                    });
                }
                _ => {}
            }
        }
        Ok(())
    }
}
