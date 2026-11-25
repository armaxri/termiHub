//! Agent-hosted tunnels over a scripted agent (#6028, F-2, F-3): what the row
//! says while the agent is gone, silent or back, what waits, and that a stop
//! wins.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::test::{mock_app, MockRuntime};
use tauri::Manager;
use termihub_core::protocol::methods::{TUNNEL_START, TUNNEL_STATUS, TUNNEL_STOP};

use super::{AgentTunnelPoll, LoadedTunnels, TunnelManager};
use crate::agent_service::hosted::{UNKNOWN_SETTLE, WAIT_LIMIT};
use crate::agent_service::AgentStatusPollDelegate;
use crate::app_tasks::AppTasks;
use crate::connection::config::SavedRemoteAgent;
use crate::connection::manager::ConnectionManager;
use crate::connection::recording_credential_store::RecordingStore;
use crate::session::manager::SessionManager;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::test_support::agent_rpc::{FakeAgent, Gate, Step};
use crate::tunnel::config::{TunnelState, TunnelStatus};
use crate::utils::config_paths::ConfigDirOverride;
use crate::utils::errors::TerminalError;

/// The tunnels an agent forwards. Like the real one, it refuses to start a
/// tunnel it already forwards.
#[derive(Default)]
struct Machine {
    forwards: Mutex<HashSet<String>>,
}

impl Machine {
    fn agent(self: &Arc<Self>) -> Arc<FakeAgent> {
        let this = Arc::clone(self);
        let mut agent = FakeAgent::session_host();
        agent.responder = Some(Box::new(move |method, params| this.answer(method, params)));
        Arc::new(agent)
    }

    fn forwards(&self, id: &str) -> bool {
        self.forwards.lock().unwrap().contains(id)
    }

    /// The agent ended, with everything it forwarded.
    fn forget(&self) {
        self.forwards.lock().unwrap().clear();
    }

    fn answer(&self, method: &str, params: &Value) -> Option<Result<Value, TerminalError>> {
        let id = params["tunnelId"].as_str().unwrap_or_default().to_string();
        let mut forwards = self.forwards.lock().unwrap();
        Some(Ok(match method {
            TUNNEL_START if forwards.contains(&id) => {
                return Some(Err(TerminalError::RemoteError("already running".into())))
            }
            TUNNEL_START => {
                forwards.insert(id);
                json!({"boundAddress": "127.0.0.1:5432", "reachableFrom": "agentOnly"})
            }
            TUNNEL_STOP => json!({"stopped": forwards.remove(&id)}),
            TUNNEL_STATUS if forwards.contains(&id) => json!({
                "running": true,
                "stats": {"bytesSent": 5, "bytesReceived": 0, "activeConnections": 1,
                          "totalConnections": 1},
            }),
            TUNNEL_STATUS => json!({"running": false}),
            _ => return None,
        }))
    }
}

struct Run {
    app: tauri::App<MockRuntime>,
    manager: Arc<TunnelManager<MockRuntime>>,
    agent: Arc<FakeAgent>,
    machine: Arc<Machine>,
    _dir: tempfile::TempDir,
}

fn tunnel(id: &str, change: impl FnOnce(&mut Value)) -> Value {
    let mut tunnel = json!({
        "id": id, "name": id, "sshConnectionId": "ssh", "autoStart": true,
        "host": {"kind": "agent", "agentId": "edge"},
        "tunnelType": {"type": "local", "config": {"localHost": "127.0.0.1", "localPort": 5432,
                       "remoteHost": "db", "remotePort": 5432}},
    });
    change(&mut tunnel);
    tunnel
}

/// One app run with tunnel "db" on agent "edge" (Edge box).
fn db_on_edge(change: impl FnOnce(&mut Value)) -> Run {
    run(vec![tunnel("db", change)], Arc::default(), json!([]))
}

fn run(tunnels: Vec<Value>, store: Arc<RecordingStore>, hops: Value) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let doc = json!({"version": "1", "tunnels": tunnels});
    std::fs::write(dir.path().join("tunnels.json"), doc.to_string()).unwrap();
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    let app = mock_app();
    // The status poller ends at once: a test ticks by hand.
    let tasks = AppTasks::new();
    tasks.cancellation_token().cancel();
    app.manage(tasks);
    app.manage(ConfigDirOverride(dir.path().to_path_buf()));
    let client: Arc<dyn AgentRpcClient> = agent.clone();
    app.manage(client.clone());
    let connections = ConnectionManager::new_for_test(dir.path(), store).unwrap();
    let edge: SavedRemoteAgent = serde_json::from_value(json!({
        "id": "edge", "name": "Edge box",
        "config": {"host": "edge.example", "port": 22, "username": "u", "authMethod": "agent"},
    }))
    .unwrap();
    connections.save_agent(edge).unwrap();
    let ssh = serde_json::from_value(json!({
        "id": "ssh", "name": "ssh", "folderId": null,
        "config": {"type": "ssh", "config": {"host": "jump", "port": 22, "username": "u",
                   "authMethod": "agent", "proxyJump": hops}},
    }))
    .unwrap();
    connections.save_connection(ssh).unwrap();
    app.manage(connections);
    app.manage(SessionManager::new(
        crate::session::registry::build_desktop_registry(),
        client,
    ));
    let loaded = LoadedTunnels::load(app.handle()).unwrap();
    let manager = Arc::new(TunnelManager::from_loaded(app.handle(), loaded));
    app.manage(manager.clone());
    Run {
        app,
        manager,
        agent,
        machine,
        _dir: dir,
    }
}

impl Run {
    fn online(&self, online: bool) {
        self.agent.host().connected.store(online, Ordering::SeqCst);
    }

    fn row(&self, id: &str) -> TunnelState {
        let states = self.manager.get_statuses().unwrap();
        states
            .into_iter()
            .find(|s| s.tunnel_id == id)
            .expect("listed")
    }

    #[track_caller]
    fn assert_row(&self, status: TunnelStatus, reason: &str) {
        let row = self.row("db");
        assert_eq!(row.status, status, "{row:?}");
        let said = row.error.unwrap_or_default();
        assert!(said.contains(reason), "{said:?} does not say {reason:?}");
        assert!(
            self.manager.active_tunnels.lock().unwrap().is_empty(),
            "opened on this computer"
        );
    }

    /// Wait for what runs off this thread.
    #[track_caller]
    fn becomes(&self, status: TunnelStatus) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.row("db").status != status {
            assert!(Instant::now() < deadline, "{:?}", self.row("db"));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// One tick of the status poller.
    fn tick(&self) {
        self.tick_at(Instant::now());
    }

    fn tick_at(&self, now: Instant) {
        let poll = AgentTunnelPoll {
            hosted: self.manager.hosted.clone(),
            app: self.app.handle().clone(),
        };
        self.manager.start_ready_at(now);
        let (targets, _) = poll.snapshot_targets();
        let samples = AgentTunnelPoll::<MockRuntime>::poll(poll.client().unwrap(), &targets);
        let changes = self.manager.hosted.apply(samples, now);
        self.manager.show_changes(changes);
    }

    fn sent(&self, method: &str) -> usize {
        let requests = self.agent.requests();
        requests.iter().filter(|(m, _)| m == method).count()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_is_gone_means_not_reachable_and_back_means_running() {
    let run = db_on_edge(|_| {});
    run.manager.start_tunnel("db").unwrap();
    run.tick();
    run.assert_row(TunnelStatus::Connected, "");
    assert_eq!(run.row("db").stats.bytes_sent, 5);
    assert_eq!(run.manager.live_stats().len(), 1);

    run.online(false);
    run.tick();
    run.assert_row(
        TunnelStatus::NotReachable,
        "Agent Edge box is offline. It may still run there; termiHub cannot tell.",
    );
    assert!(run.manager.live_stats().is_empty());
    assert!(!run.manager.is_tunnel_connected("db"));
    run.manager.start_tunnel("db").expect_err("may run there");
    run.manager.start_auto_tunnels();
    run.manager.start_connection_tunnels("ssh");

    run.online(true);
    run.tick();
    run.assert_row(TunnelStatus::Connected, "");
    assert_eq!(run.sent(TUNNEL_START), 1, "not started twice");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_is_back_without_it_means_stopped_unless_it_reconnects() {
    for reconnect in [false, true] {
        let run = db_on_edge(|t| t["reconnectOnDisconnect"] = json!(reconnect));
        run.manager.start_tunnel("db").unwrap();
        run.online(false);
        run.tick();
        run.machine.forget();
        run.online(true);
        run.tick();
        if reconnect {
            run.becomes(TunnelStatus::Connected);
            assert!(run.machine.forwards("db"));
            run.tick();
            assert_eq!(run.sent(TUNNEL_START), 2, "once more");
        } else {
            run.assert_row(TunnelStatus::Disconnected, "");
            run.tick();
            assert_eq!(run.sent(TUNNEL_START), 1);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_without_an_answer_is_unknown_and_the_agent_decides() {
    let timed_out = || Step::error(|| TerminalError::agent_timeout(Duration::from_secs(60)));
    let run = db_on_edge(|_| {});
    run.agent.push(TUNNEL_START, timed_out());
    run.manager.start_tunnel("db").expect("not a failed start");
    run.assert_row(
        TunnelStatus::NotReachable,
        "Agent Edge box did not answer the start. It may run there",
    );
    run.machine.forwards.lock().unwrap().insert("db".into());
    run.tick();
    run.assert_row(TunnelStatus::Connected, "");

    let run = db_on_edge(|t| t["reconnectOnDisconnect"] = json!(true));
    run.agent.push(TUNNEL_START, timed_out());
    run.manager.start_tunnel("db").unwrap();
    run.tick();
    run.assert_row(TunnelStatus::NotReachable, "did not answer");
    run.tick_at(Instant::now() + UNKNOWN_SETTLE);
    run.assert_row(TunnelStatus::Error, "it does not run there");
    assert_eq!(run.sent(TUNNEL_START), 1, "not tried again by itself");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_auto_start_and_a_start_with_the_connection_wait_for_the_agent() {
    for with_connection in [false, true] {
        let run = db_on_edge(|t| {
            t["autoStart"] = json!(!with_connection);
            t["startWithConnection"] = json!(with_connection);
        });
        run.online(false);
        let start = || {
            if with_connection {
                run.manager.start_connection_tunnels("ssh");
            } else {
                run.manager.start_auto_tunnels();
            }
        };
        start();
        start();
        run.assert_row(TunnelStatus::Waiting, "Waiting for agent Edge box");
        run.tick();
        run.assert_row(TunnelStatus::Waiting, "Edge box");
        assert_eq!(run.sent(TUNNEL_START), 0);
        run.online(true);
        run.tick();
        run.tick();
        run.assert_row(TunnelStatus::Connected, "");
        assert_eq!(run.sent(TUNNEL_START), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_while_waiting_wins_and_a_wait_is_bounded() {
    let run = db_on_edge(|_| {});
    run.online(false);
    run.manager.start_auto_tunnels();
    let err = run.manager.start_tunnel("db").expect_err("start now");
    assert!(err.to_string().contains("Waiting for agent"), "{err}");
    run.assert_row(TunnelStatus::Waiting, "");
    run.manager.stop_tunnel("db").unwrap();
    run.online(true);
    run.tick();
    run.assert_row(TunnelStatus::Disconnected, "");
    assert_eq!(run.sent(TUNNEL_START), 0);

    run.online(false);
    run.manager.start_auto_tunnels();
    run.tick_at(Instant::now() + WAIT_LIMIT);
    run.assert_row(TunnelStatus::Error, "not connected within 30 minutes");
    run.online(true);
    run.tick();
    assert_eq!(run.sent(TUNNEL_START), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_auto_start_waits_for_the_credential_store_of_its_jump_host() {
    let store = Arc::new(RecordingStore::default());
    let hops = json!([{"host": "hop", "port": 22, "username": "u", "authMethod": "password",
                       "password": "secret"}]);
    let run = run(vec![tunnel("db", |_| {})], store.clone(), hops);
    store.locked.store(true, Ordering::SeqCst);
    run.manager.start_auto_tunnels();
    run.assert_row(TunnelStatus::Waiting, "Waiting for the credential store");
    run.tick();
    assert_eq!(run.sent(TUNNEL_START), 0);
    store.locked.store(false, Ordering::SeqCst);
    run.tick();
    run.assert_row(TunnelStatus::Connected, "");
    let (_, params) = run.agent.requests().remove(0);
    let hop = &params["sshConfig"]["proxyJump"][0];
    assert_eq!(hop["password"], "secret", "with the hop's password");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_while_the_agent_is_gone_wins_when_it_is_back() {
    let run = db_on_edge(|t| {
        t["startWithConnection"] = json!(true);
        t["reconnectOnDisconnect"] = json!(true);
    });
    run.manager.start_tunnel("db").unwrap();
    run.online(false);
    run.tick();
    run.manager.stop_tunnel("db").unwrap();
    run.assert_row(
        TunnelStatus::Stopping,
        "Agent Edge box is offline. Stops as soon as",
    );
    run.manager.start_connection_tunnels("ssh");
    run.manager.start_auto_tunnels();
    run.tick();
    run.assert_row(TunnelStatus::Stopping, "");
    run.online(true);
    run.manager.start_connection_tunnels("ssh");
    run.assert_row(TunnelStatus::Stopping, "");
    run.tick();
    run.assert_row(TunnelStatus::Disconnected, "");
    assert!(!run.machine.forwards("db"));
    run.tick();
    run.assert_row(TunnelStatus::Disconnected, "");
    assert_eq!(run.sent(TUNNEL_START), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_is_sent_without_waiting_for_the_agent_on_the_callers_thread() {
    let run = db_on_edge(|_| {});
    run.manager.start_tunnel("db").unwrap();
    let gate = Gate::new();
    let _open = gate.open_on_drop();
    run.agent
        .push(TUNNEL_STOP, Step::Hang(gate.clone(), Box::new(Step::Ok)));
    run.manager.stop_tunnel("db").unwrap();
    run.assert_row(
        TunnelStatus::Stopping,
        "Waiting for agent Edge box to stop it",
    );
    gate.open();
    run.becomes(TunnelStatus::Disconnected);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_stops_first_and_waits_while_the_agent_is_gone() {
    let run = db_on_edge(|_| {});
    run.manager.start_tunnel("db").unwrap();
    run.manager.restart_tunnel("db").unwrap();
    run.assert_row(TunnelStatus::Connected, "");
    assert_eq!(run.sent(TUNNEL_START), 2);

    run.online(false);
    run.tick();
    run.manager.restart_tunnel("db").unwrap();
    run.assert_row(TunnelStatus::Waiting, "Waiting for agent Edge box");
    run.tick();
    run.online(true);
    run.tick();
    run.assert_row(TunnelStatus::Connected, "");
    assert_eq!(run.sent(TUNNEL_START), 3);
    assert!(run.machine.forwards("db"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_during_a_start_on_the_agent_stops_it_there() {
    let run = db_on_edge(|_| {});
    let gate = Gate::new();
    let reply = json!({"boundAddress": "127.0.0.1:5432", "reachableFrom": "agentOnly"});
    run.agent.push(
        TUNNEL_START,
        Step::Hang(gate.clone(), Box::new(Step::Reply(reply))),
    );
    run.machine.forwards.lock().unwrap().insert("db".into());
    std::thread::scope(|scope| {
        let _open = gate.open_on_drop();
        let manager = run.manager.clone();
        let start = scope.spawn(move || manager.start_tunnel("db"));
        while run.sent(TUNNEL_START) == 0 {
            std::thread::yield_now();
        }
        run.assert_row(TunnelStatus::Connecting, "");
        run.manager.start_tunnel("db").expect_err("one at a time");
        run.manager.stop_tunnel("db").unwrap();
        run.assert_row(TunnelStatus::Stopping, "");
        gate.open();
        start.join().unwrap().unwrap();
    });
    run.becomes(TunnelStatus::Disconnected);
    assert!(!run.machine.forwards("db"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_tunnel_is_still_stopped_on_its_agent_when_it_is_back() {
    let run = db_on_edge(|_| {});
    run.manager.start_tunnel("db").unwrap();
    run.online(false);
    run.tick();
    run.manager.delete_tunnel("db").unwrap();
    assert!(run.manager.get_tunnels().unwrap().is_empty());
    run.online(true);
    run.tick();
    assert!(!run.machine.forwards("db"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hop_to_this_computer_comes_after_its_waiting_parent() {
    // The companion waits for nothing of its own: it is started by its parent.
    let run = run(
        vec![
            tunnel("db", |_| {}),
            tunnel("hop", |t| {
                t["companionOf"] = json!("db");
                t["autoStart"] = json!(true);
            }),
        ],
        Arc::default(),
        json!([]),
    );
    run.online(false);
    // Starting the hop starts its parent, which waits; the hop does not.
    run.manager
        .start("hop", crate::agent_service::hosted::StartedBy::Itself)
        .unwrap();
    run.assert_row(TunnelStatus::Waiting, "");
    assert_eq!(run.row("hop").status, TunnelStatus::Disconnected);
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_stops_what_can_be_reached_and_does_not_wait_for_the_rest() {
    let run = db_on_edge(|_| {});
    run.manager.start_tunnel("db").unwrap();
    run.manager.stop_all();
    assert!(!run.machine.forwards("db"));

    run.manager.start_tunnel("db").unwrap();
    run.online(false);
    let asked = run.agent.requests().len();
    run.manager.stop_all();
    assert_eq!(run.agent.requests().len(), asked);
}
