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
//! Every other JSON-RPC line the desktop writes after `initialize` is ignored.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
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
}

/// A running fake agent endpoint; stops accepting when dropped.
pub(super) struct FakeAgentSshd {
    pub(super) port: u16,
    /// `initialize` requests received so far (one per connect attempt that
    /// reached the handshake).
    inits: Arc<AtomicUsize>,
    init_seen: Arc<Notify>,
    release: watch::Sender<bool>,
    accept_task: tokio::task::JoinHandle<()>,
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
        let task_inits = inits.clone();
        let task_seen = init_seen.clone();
        let accept_task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let handler = FakeAgentHandler {
                    behavior,
                    inits: task_inits.clone(),
                    init_seen: task_seen.clone(),
                    release: release_rx.clone(),
                    line_buf: String::new(),
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
        }
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
    let mut line = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocol_version": "0.13.0",
            "agent_version": "0.0.0-fake",
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
    line_buf: String,
}

impl FakeAgentHandler {
    /// Note one `initialize` request and answer it as configured.
    fn on_initialize(&self, channel: ChannelId, id: u64, session: &mut Session) {
        self.inits.fetch_add(1, Ordering::SeqCst);
        self.init_seen.notify_waiters();
        match self.behavior {
            InitBehavior::Stall => {}
            InitBehavior::Answer => {
                let _ = session.data(channel, initialize_answer(id).into_bytes());
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
        self.line_buf.push_str(&String::from_utf8_lossy(data));
        while let Some(pos) = self.line_buf.find('\n') {
            let line: String = self.line_buf.drain(..=pos).collect();
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if msg.get("method").and_then(|m| m.as_str()) == Some("initialize") {
                if let Some(id) = msg.get("id").and_then(|i| i.as_u64()) {
                    self.on_initialize(channel, id, session);
                }
            }
        }
        Ok(())
    }
}
