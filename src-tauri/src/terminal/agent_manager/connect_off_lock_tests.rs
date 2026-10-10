//! Regression tests for #4304 (CONC2-001 / CONC2-004 / CONC2-005): the agent
//! connect handshake runs off the `agents` lock, every handshake step is
//! bounded, and reaping is race-free against a concurrent connect.
//!
//! They drive the real `connect_agent` path — russh connect, password auth,
//! exec, `initialize` — against the in-process [`FakeAgentSshd`], so they run on
//! every PR with no `sshd` binary and no agent build.

use std::time::{Duration, Instant};

use tauri::test::MockRuntime;
use termihub_core::backends::ssh::handler::SshSession;

use super::fake_agent_sshd::{FakeAgentSshd, InitBehavior};
use super::io_task::give_up_after_exhausted_reconnect;
use super::reconnect::reconnect_handshake;
use super::tests::make_agent_connection;
use super::*;

/// How long an operation on another agent may take while one agent connects.
/// Generous for a loaded CI runner, yet far below the handshake bound a
/// blocked operation would sit out.
const PROMPT: Duration = Duration::from_secs(3);

/// Ceiling for the fake server to see the desktop's `initialize`.
const REACH_HANDSHAKE: Duration = Duration::from_secs(20);

/// Trust every host key for the duration of the test (process-wide, set-once).
fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

type Manager = AgentConnectionManager<MockRuntime>;

fn new_manager(app: &tauri::App<MockRuntime>) -> Manager {
    AgentConnectionManager::new(app.handle().clone())
}

/// Run a (possibly blocking) manager call off the async workers and fail the
/// test — instead of hanging it — when it does not return within [`PROMPT`].
async fn promptly<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::time::timeout(PROMPT, tokio::task::spawn_blocking(f)).await {
        Ok(joined) => joined.expect("blocking call panicked"),
        Err(_) => panic!("{what} blocked for over {PROMPT:?} while another agent was connecting"),
    }
}

/// Start `connect_agent(agent_id)` against `server` on a blocking thread.
fn spawn_connect(
    manager: &Arc<Manager>,
    agent_id: &str,
    server: &FakeAgentSshd,
) -> tokio::task::JoinHandle<Result<AgentConnectResult, TerminalError>> {
    let (m, aid, cfg) = (manager.clone(), agent_id.to_string(), server.agent_config());
    tokio::task::spawn_blocking(move || m.connect_agent(&aid, &cfg, None))
}

fn connecting_ids(manager: &Manager) -> Vec<String> {
    manager.connecting.lock().unwrap().keys().cloned().collect()
}

fn has_budget(manager: &Manager, agent_id: &str) -> bool {
    manager.io_budgets.lock().unwrap().contains_key(agent_id)
}

/// CONC2-001: while agent A sits in its handshake (the agent never answers
/// `initialize`), every operation on agent B — and listing agents — returns at
/// once, and a duplicate connect to A is refused instead of queueing behind it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connecting_agent_does_not_block_other_agents() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Stall).await;
    let app = tauri::test::mock_app();
    let manager = Arc::new(new_manager(&app));
    manager
        .agents
        .lock()
        .unwrap()
        .insert("agent-b".to_string(), make_agent_connection(true));

    let connect_a = spawn_connect(&manager, "agent-a", &server);
    server.wait_for_inits(1, REACH_HANDSHAKE).await;

    let m = manager.clone();
    assert!(promptly("is_connected(B)", move || m.is_connected("agent-b")).await);
    let m = manager.clone();
    assert!(
        promptly("get_capabilities(B)", move || m.get_capabilities("agent-b"))
            .await
            .is_some()
    );
    let m = manager.clone();
    let listed = promptly("connected_agent_ids", move || {
        AgentRpcClient::connected_agent_ids(&*m)
    })
    .await;
    assert_eq!(listed, vec!["agent-b".to_string()], "A is not listed yet");
    let m = manager.clone();
    assert!(
        !promptly("is_connected(A)", move || m.is_connected("agent-a")).await,
        "a still-connecting agent is not connected"
    );

    // A second connect to A while the first is in flight is refused as
    // already connected, rather than running a duplicate handshake.
    let (m, cfg) = (manager.clone(), server.agent_config());
    let dup = promptly("duplicate connect(A)", move || {
        m.connect_agent("agent-a", &cfg, None)
    })
    .await;
    match dup {
        Err(e) => assert_eq!(
            e.code(),
            crate::utils::errors::IpcErrorCode::AlreadyConnected
        ),
        Ok(_) => panic!("a duplicate connect must not succeed"),
    }

    let m = manager.clone();
    promptly("disconnect_agent(B)", move || m.disconnect_agent("agent-b"))
        .await
        .expect("disconnecting B works while A connects");

    // Disconnecting the still-connecting A cancels its connect.
    let m = manager.clone();
    promptly("disconnect_agent(A)", move || m.disconnect_agent("agent-a"))
        .await
        .expect("a Disconnect while connecting cancels the connect");
    let outcome = tokio::time::timeout(PROMPT, connect_a)
        .await
        .expect("the cancelled connect unwinds promptly")
        .expect("connect join");
    assert!(outcome.is_err(), "a cancelled connect must fail");
    assert!(!manager.is_connected("agent-a"));
    assert!(!manager.agents.lock().unwrap().contains_key("agent-a"));
    assert!(!has_budget(&manager, "agent-a"));
    assert!(connecting_ids(&manager).is_empty(), "reservation released");
}

/// CONC2-001 + CONC2-004: an agent that execs but never answers `initialize`
/// fails the connect after the handshake bound, leaving no entry, no budget and
/// no reservation behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn never_answering_handshake_times_out() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Stall).await;
    let app = tauri::test::mock_app();
    let mut manager = new_manager(&app);
    manager.set_handshake_timeout_for_test(Duration::from_millis(300));
    let manager = Arc::new(manager);

    let started = Instant::now();
    let outcome =
        tokio::time::timeout(REACH_HANDSHAKE, spawn_connect(&manager, "agent-a", &server))
            .await
            .expect("the handshake must time out rather than hang")
            .expect("connect join");
    let err = match outcome {
        Err(e) => e.to_string(),
        Ok(_) => panic!("a never-answering agent must not connect"),
    };
    assert!(err.contains("timed out"), "timeout error, got: {err}");
    assert_eq!(server.inits(), 1, "the connect reached the handshake");
    assert!(started.elapsed() < REACH_HANDSHAKE);
    assert!(!manager.is_connected("agent-a"));
    assert!(!manager.agents.lock().unwrap().contains_key("agent-a"));
    assert!(!has_budget(&manager, "agent-a"));
    assert!(connecting_ids(&manager).is_empty(), "reservation released");
}

/// The happy path still publishes: the off-lock handshake completes, the entry
/// and its budget land together and the agent reads connected.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn answered_handshake_publishes_the_connection() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let app = tauri::test::mock_app();
    let manager = Arc::new(new_manager(&app));

    let result = tokio::time::timeout(REACH_HANDSHAKE, spawn_connect(&manager, "agent-a", &server))
        .await
        .expect("connect settles")
        .expect("connect join")
        .expect("an answering agent connects");
    assert_eq!(result.agent_version, "0.0.0-fake");
    assert!(manager.is_connected("agent-a"));
    assert!(has_budget(&manager, "agent-a"));
    assert!(connecting_ids(&manager).is_empty());

    manager.disconnect_agent("agent-a").expect("disconnect");
    assert!(!has_budget(&manager, "agent-a"));
}

/// CONC2-005: a reap from the old connection's I/O task — whether it fires
/// while the new connect is in its handshake or after the new connection is
/// published — never evicts the new connection or its budget. Only the new
/// connection's own task can reap it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reap_during_connect_leaves_a_consistent_state() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::AnswerWhenReleased).await;
    let app = tauri::test::mock_app();
    let manager = Arc::new(new_manager(&app));
    let reaper = AgentReaper {
        agents: Arc::downgrade(&manager.agents),
        io_budgets: Arc::downgrade(&manager.io_budgets),
    };

    // A dead entry left by an earlier connection whose task is about to reap.
    let old = make_agent_connection(false);
    let old_alive = old.alive.clone();
    manager
        .agents
        .lock()
        .unwrap()
        .insert("agent-a".to_string(), old);

    let connect = spawn_connect(&manager, "agent-a", &server);
    server.wait_for_inits(1, REACH_HANDSHAKE).await;

    // The old task reaps while the new connect is mid-handshake.
    reap_agent(&reaper, "agent-a", &old_alive);
    assert!(!manager.is_connected("agent-a"));
    assert_eq!(connecting_ids(&manager), vec!["agent-a".to_string()]);

    server.release();
    tokio::time::timeout(REACH_HANDSHAKE, connect)
        .await
        .expect("connect settles")
        .expect("connect join")
        .expect("the new connection publishes");
    assert!(manager.is_connected("agent-a"));
    assert!(has_budget(&manager, "agent-a"));

    // A stale reap arriving after the publish spares the new connection.
    reap_agent(&reaper, "agent-a", &old_alive);
    assert!(
        manager.is_connected("agent-a"),
        "a stale reap must not evict the newer connection"
    );
    assert!(has_budget(&manager, "agent-a"));

    // The new connection's own task can still reap it, budget and all.
    let new_alive = manager.agents.lock().unwrap()["agent-a"].alive.clone();
    new_alive.stop();
    reap_agent(&reaper, "agent-a", &new_alive);
    assert!(!manager.agents.lock().unwrap().contains_key("agent-a"));
    assert!(!has_budget(&manager, "agent-a"));
    // Whatever the reaped task left running is gone with the manager.
    let _ = manager.disconnect_agent("agent-a");
}

/// Open an authenticated session to `server` the way a reconnect attempt does.
async fn open_session(server: &FakeAgentSshd) -> SshSession {
    let ssh_config = server.agent_config().to_ssh_config();
    tokio::task::spawn_blocking(move || {
        connect_and_authenticate_cancellable(&ssh_config, CancellationToken::new())
    })
    .await
    .expect("connect join")
    .expect("password auth to the fake agent")
}

/// CONC2-004: a reconnect attempt whose agent execs but never answers
/// `initialize` fails after the handshake bound — the caller then counts it as
/// a failed attempt — instead of parking the I/O task in `reconnecting`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_handshake_times_out_when_the_agent_never_answers() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Stall).await;
    let session = open_session(&server).await;
    let config = server.agent_config();
    let mut request_id = 7;

    let outcome = tokio::time::timeout(
        PROMPT,
        reconnect_handshake(
            &session,
            &config,
            &AgentSettings::default(),
            &mut request_id,
            Duration::from_millis(300),
            &CancellationToken::new(),
        ),
    )
    .await
    .expect("the reconnect handshake must be bounded");
    match outcome {
        Err(reason) => assert!(reason.contains("timed out"), "got: {reason}"),
        Ok(_) => panic!("a never-answering agent must fail the attempt"),
    }
    assert_eq!(server.inits(), 1);
    assert_eq!(request_id, 8, "the attempt used a fresh request id");
}

/// CONC2-004: a Disconnect (the `alive`-driven cancel token) aborts a reconnect
/// handshake at once, without waiting out its bound.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_handshake_aborts_on_cancel() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Stall).await;
    let session = open_session(&server).await;
    let config = server.agent_config();
    let cancel = CancellationToken::new();
    let mut request_id = 1;

    let fire = cancel.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        fire.cancel();
    });
    let outcome = tokio::time::timeout(
        PROMPT,
        reconnect_handshake(
            &session,
            &config,
            &AgentSettings::default(),
            &mut request_id,
            Duration::from_secs(600),
            &cancel,
        ),
    )
    .await
    .expect("a cancelled reconnect handshake returns at once");
    canceller.await.expect("canceller");
    match outcome {
        Err(reason) => assert!(reason.contains("cancelled"), "got: {reason}"),
        Ok(_) => panic!("a cancelled attempt must fail"),
    }
}

/// The bounded reconnect handshake still succeeds against an answering agent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_handshake_succeeds_when_the_agent_answers() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let session = open_session(&server).await;
    let config = server.agent_config();
    let mut request_id = 3;

    let outcome = reconnect_handshake(
        &session,
        &config,
        &AgentSettings::default(),
        &mut request_id,
        PROMPT,
        &CancellationToken::new(),
    )
    .await;
    let (_channel, buffered, token_path, capabilities) =
        outcome.expect("an answering agent re-initializes");
    assert!(buffered.is_empty());
    assert_eq!(token_path, None);
    // #4440: the re-initialized agent's capabilities come back for the cache.
    assert_eq!(
        capabilities.map(|c| c.agent_version).as_deref(),
        Some("0.0.0-fake")
    );
}

/// CONC2-005: an exhausted reconnect clears `alive` before anyone can observe
/// the `disconnected` event, then reaps only its own entry.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn give_up_clears_alive_before_disconnected_is_observed() {
    use tauri::Listener;
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let manager = new_manager(&app);
    let reaper = AgentReaper {
        agents: Arc::downgrade(&manager.agents),
        io_budgets: Arc::downgrade(&manager.io_budgets),
    };
    let conn = make_agent_connection(true);
    let alive = conn.alive.clone();
    manager
        .agents
        .lock()
        .unwrap()
        .insert("agent-a".to_string(), conn);

    // What `alive` read when each `disconnected` event for agent-a fired.
    let seen: Arc<Mutex<Vec<bool>>> = Arc::default();
    let (sink, observed_alive) = (seen.clone(), alive.clone());
    handle.listen_any("agent-state-change", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        if payload["session_id"].as_str() == Some("agent-a")
            && payload["state"].as_str() == Some("disconnected")
        {
            sink.lock().unwrap().push(observed_alive.is_alive());
        }
    });

    give_up_after_exhausted_reconnect(&handle, "agent-a", &alive, &reaper, "gave up").await;

    let deadline = Instant::now() + PROMPT;
    while seen.lock().unwrap().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        *seen.lock().unwrap(),
        vec![false],
        "`disconnected` must never be observable while `alive` is still true"
    );
    assert!(!manager.agents.lock().unwrap().contains_key("agent-a"));
}
