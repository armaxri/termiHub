//! What a file server's row says is true (#6028, F-2, F-3): an agent-hosted one
//! is not "running" when its agent is gone, an automatic start waits for its
//! agent or the credential store instead of failing for good, and a stop wins
//! over an agent that comes back.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::Manager;
use termihub_core::protocol::methods::{SERVICE_START, SERVICE_STATUS, SERVICE_STOP};
use termihub_core::util::service_cause::ServiceCause;

use super::host_tests::{edit, on_agent, run_with, server, write, Harness};
use super::EmbeddedServerManager;
use crate::agent_service::hosted::{UNKNOWN_SETTLE, WAIT_LIMIT};
use crate::agent_service::AgentStatusPollDelegate;
use crate::connection::manager::ConnectionManager;
use crate::embedded_servers::config::ServerStatus;
use crate::embedded_servers::secrets::tests::{FakeStore, LOCKED, UNLOCKED};
use crate::test_support::agent_rpc::{FakeAgent, Gate, Step};
use crate::utils::errors::TerminalError;

/// The servers an agent machine hosts.
#[derive(Default)]
struct Machine {
    hosted: Mutex<HashSet<String>>,
}

impl Machine {
    /// The agent on it, connected.
    fn agent(self: &Arc<Self>) -> Arc<FakeAgent> {
        let this = Arc::clone(self);
        let mut agent = FakeAgent::session_host();
        agent.responder = Some(Box::new(move |method, params| this.answer(method, params)));
        Arc::new(agent)
    }

    fn hosts(&self, id: &str) -> bool {
        self.hosted.lock().unwrap().contains(id)
    }

    /// The agent ended, with everything it hosted.
    fn forget(&self) {
        self.hosted.lock().unwrap().clear();
    }

    fn answer(&self, method: &str, params: &Value) -> Option<Result<Value, TerminalError>> {
        let id = params["instanceId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let mut hosted = self.hosted.lock().unwrap();
        Some(Ok(match method {
            SERVICE_START => {
                hosted.insert(id);
                json!({"status": {"state": "running"}})
            }
            SERVICE_STOP => json!({"stopped": hosted.remove(&id)}),
            SERVICE_STATUS => {
                let running = hosted.contains(&id);
                json!({"running": running, "status": running.then(|| json!({"state": "running"}))})
            }
            _ => return None,
        }))
    }
}

fn online(agent: &FakeAgent, online: bool) {
    agent.host().connected.store(online, Ordering::SeqCst);
}

fn sent(agent: &FakeAgent, method: &str) -> usize {
    let requests = agent.requests();
    requests.iter().filter(|(m, _)| m == method).count()
}

/// One tick of the status poller at `now`.
fn tick_at(h: &Harness, now: Instant) {
    let poll = h.manager.status_poll();
    h.manager.start_ready_at(now);
    let (targets, _) = poll.snapshot_targets();
    let samples = super::HostedServices::<super::HostedServers>::poll(
        poll.client().expect("client").as_ref(),
        &targets,
    );
    let changes = h.manager.hosted.apply(samples, now);
    h.manager.show_changes(changes);
}

fn tick(h: &Harness) {
    tick_at(h, Instant::now());
}

/// What every window was told last about `id`.
fn told(h: &Harness, id: &str) -> ServerStatus {
    let events = h.events.lock().unwrap();
    let last = events.iter().rfind(|s| s.server_id == id);
    last.expect("announced").status.clone()
}

/// The cause that goes with what a row says: its button must fit its words.
fn cause_of(said: &str) -> Option<ServiceCause> {
    let offline = [
        "agent is offline",
        "agent is not connected",
        "agent was not connected",
        "when its agent connects",
    ];
    if offline.iter().any(|words| said.contains(words)) {
        Some(ServiceCause::AgentOffline)
    } else if said.contains("keeps asking") {
        Some(ServiceCause::AgentSilent)
    } else if said.contains("credential store") {
        Some(ServiceCause::StoreLocked)
    } else {
        None
    }
}

/// `id` shows `status`, every window was told so, and the row says `reason`.
fn assert_row(h: &Harness, id: &str, status: ServerStatus, reason: &str) {
    let state = h.state(id);
    assert_eq!(state.status, status, "{state:?}");
    assert_eq!(told(h, id), status);
    let said = state.error.unwrap_or_default();
    assert!(said.contains(reason), "{said:?} does not say {reason:?}");
    assert_eq!(state.cause, cause_of(&said), "{said:?}");
    assert!(!h.listens_here(id), "opened on this computer");
}

struct Run {
    h: Harness,
    agent: Arc<FakeAgent>,
    machine: Arc<Machine>,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

/// One auto-start server "web" on agent "edge" (Edge box).
fn web_on_edge() -> Run {
    web_on_edge_with(|_| {}, FakeStore::new(UNLOCKED))
}

fn web_on_edge_with(change: impl FnOnce(&mut Value), store: Arc<FakeStore>) -> Run {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    let mut web = server("web", root.path(), Some(on_agent("edge")));
    change(&mut web);
    write(dir.path(), vec![web]);
    let h = run_with(dir.path(), &agent, &[("edge", "Edge box")], store);
    Run {
        h,
        agent,
        machine,
        _dirs: (dir, root),
    }
}

// ─── Not reachable (F-2) ─────────────────────────────────────────────────────

#[test]
fn an_agent_that_is_gone_means_not_reachable_and_back_means_running() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    h.manager.start_server("web").unwrap();
    assert_row(h, "web", ServerStatus::Running, "");
    online(agent, false);
    tick(h);
    assert_row(
        h,
        "web",
        ServerStatus::NotReachable,
        "Its agent is offline. It may still run there; termiHub cannot tell.",
    );
    online(agent, true);
    tick(h);
    assert_row(h, "web", ServerStatus::Running, "");
    assert_eq!(sent(agent, SERVICE_START), 1, "not started twice");
}

#[test]
fn an_agent_that_is_back_without_it_means_stopped() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    tick(h);
    machine.forget();
    online(agent, true);
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
    tick(h);
    assert_eq!(sent(agent, SERVICE_START), 1, "not started again by itself");
}

#[test]
fn an_agent_that_was_replaced_between_two_ticks_shows_no_stale_green() {
    let run = web_on_edge();
    let Run { h, machine, .. } = &run;
    h.manager.start_server("web").unwrap();
    machine.forget();
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
}

#[test]
fn a_start_while_it_may_run_there_is_not_sent() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    tick(h);
    h.manager.start_server("web").expect_err("may run there");
    h.manager.start_auto_servers();
    assert_row(h, "web", ServerStatus::NotReachable, "Its agent is offline");
    assert_eq!(sent(agent, SERVICE_START), 1);
}

#[test]
fn a_removed_agent_is_named_as_removed_and_a_stop_is_the_way_out() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    let connections = h.app.state::<ConnectionManager>();
    connections.delete_agent("edge").unwrap();
    tick(h);
    assert_row(h, "web", ServerStatus::NotReachable, "was removed");
    h.manager.stop_server("web").unwrap();
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
}

// ─── Unknown ─────────────────────────────────────────────────────────────────

fn unanswered(make: fn() -> TerminalError) -> Run {
    let run = web_on_edge();
    run.agent.push(SERVICE_START, Step::error(make));
    run.h
        .manager
        .start_server("web")
        .expect("not a failed start");
    run
}

#[test]
fn a_start_without_an_answer_is_unknown_not_refused_and_the_agent_decides() {
    for make in [
        (|| TerminalError::agent_timeout(Duration::from_secs(60))) as fn() -> TerminalError,
        || TerminalError::agent_transport_closed("gone"),
    ] {
        let run = unanswered(make);
        let Run { h, machine, .. } = &run;
        assert_row(
            h,
            "web",
            ServerStatus::NotReachable,
            "Its agent did not answer the start. It may run there",
        );
        // It did start.
        machine.hosted.lock().unwrap().insert("web".into());
        tick(h);
        assert_row(h, "web", ServerStatus::Running, "");
    }
}

/// "Check again" (#6068) does not wait for the tick.
#[test]
fn checking_again_asks_the_agent_now() {
    let run = unanswered(|| TerminalError::agent_timeout(Duration::from_secs(60)));
    run.machine.hosted.lock().unwrap().insert("web".into());
    run.h.manager.check_again();
    assert_row(&run.h, "web", ServerStatus::Running, "");
}

#[test]
fn a_start_without_an_answer_that_never_ran_says_so_when_it_is_certain() {
    let run = unanswered(|| TerminalError::agent_timeout(Duration::from_secs(60)));
    let Run { h, .. } = &run;
    tick(h);
    assert_row(h, "web", ServerStatus::NotReachable, "did not answer");
    tick_at(h, Instant::now() + UNKNOWN_SETTLE);
    assert_row(
        h,
        "web",
        ServerStatus::Error,
        "did not answer the start, and it does not run there",
    );
    // Durable, and a good start ends it.
    h.manager.start_server("web").unwrap();
    assert_row(h, "web", ServerStatus::Running, "");
}

// ─── Waiting (F-3) ───────────────────────────────────────────────────────────

#[test]
fn an_auto_start_waits_for_its_agent_and_then_starts_there_once() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    assert_row(
        h,
        "web",
        ServerStatus::Waiting,
        "Starts when its agent connects, until ",
    );
    tick(h);
    tick(h);
    assert_row(h, "web", ServerStatus::Waiting, "its agent");
    assert_eq!(sent(agent, SERVICE_START), 0);

    online(agent, true);
    tick(h);
    tick(h);
    assert_row(h, "web", ServerStatus::Running, "");
    assert!(machine.hosts("web"));
    assert_eq!(sent(agent, SERVICE_START), 1);
}

#[test]
fn a_stop_while_waiting_wins_when_the_agent_comes() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    h.manager.stop_server("web").unwrap();
    assert_row(h, "web", ServerStatus::Stopped, "");
    online(agent, true);
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
    assert_eq!(sent(agent, SERVICE_START), 0);
}

#[test]
fn a_wait_ends_with_the_reason_after_its_time() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    tick_at(h, Instant::now() + WAIT_LIMIT);
    assert_row(
        h,
        "web",
        ServerStatus::Error,
        "its agent was not connected within 30 minutes",
    );
    online(agent, true);
    tick(h);
    assert_eq!(sent(agent, SERVICE_START), 0, "for good");
}

#[test]
fn start_now_on_a_waiting_server_goes_on_waiting_when_it_cannot() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    let err = h.manager.start_server("web").expect_err("offline");
    assert!(
        err.to_string()
            .contains("Starts when its agent connects, until "),
        "{err}"
    );
    assert_row(h, "web", ServerStatus::Waiting, "its agent");
    online(agent, true);
    h.manager.start_server("web").expect("now");
    assert_row(h, "web", ServerStatus::Running, "");
    tick(h);
    assert_eq!(sent(agent, SERVICE_START), 1);
}

#[test]
fn a_removed_agent_ends_the_wait_and_a_move_or_delete_does_too() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    let connections = h.app.state::<ConnectionManager>();
    connections.delete_agent("edge").unwrap();
    tick(h);
    h.assert_refused("web", "the agent it runs on was removed");

    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    edit(h, "web", |s| s["host"] = json!({"kind": "thisComputer"})).unwrap();
    online(agent, true);
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
    assert_eq!(sent(agent, SERVICE_START), 0);

    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    h.manager.delete_config("web").unwrap();
    online(agent, true);
    tick(h);
    assert_eq!(sent(agent, SERVICE_START), 0);
}

#[test]
fn a_rename_keeps_it_waiting() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    edit(h, "web", |s| s["name"] = json!("renamed")).unwrap();
    assert_row(h, "web", ServerStatus::Waiting, "its agent");
}

#[test]
fn an_auto_start_that_fails_on_its_agent_after_the_wait_says_why() {
    let run = web_on_edge();
    let Run { h, agent, .. } = &run;
    online(agent, false);
    h.manager.start_auto_servers();
    agent.push(SERVICE_START, Step::fail("port in use"));
    online(agent, true);
    tick(h);
    assert_row(h, "web", ServerStatus::Error, "port in use");
    tick(h);
    assert_eq!(sent(agent, SERVICE_START), 1, "not tried again and again");
}

fn with_password(web: &mut Value) {
    web["httpAuth"] = json!({"username": "web", "password": ""});
}

#[test]
fn an_auto_start_waits_for_the_credential_store_then_starts() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    let store = FakeStore::new(UNLOCKED);
    let mut here = server("here", root.path(), None);
    with_password(&mut here);
    let mut there = server("there", root.path(), Some(on_agent("edge")));
    with_password(&mut there);
    write(
        dir.path(),
        vec![here, there, server("open", root.path(), None)],
    );
    let h = run_with(dir.path(), &agent, &[("edge", "Edge box")], store.clone());
    for id in ["here", "there"] {
        edit(&h, id, |s| s["httpAuth"]["password"] = json!("secret")).unwrap();
    }
    store.set_status(LOCKED);
    online(&agent, false);

    h.manager.start_auto_servers();
    assert!(h.listens_here("open"), "what needs no password starts");
    assert_row(
        &h,
        "here",
        ServerStatus::Waiting,
        "Starts when you unlock the credential store, until ",
    );
    // Both are missing: first one, then the other.
    assert_row(
        &h,
        "there",
        ServerStatus::Waiting,
        "Starts when its agent connects, until ",
    );
    online(&agent, true);
    tick(&h);
    assert_row(
        &h,
        "there",
        ServerStatus::Waiting,
        "Starts when you unlock the credential store, until ",
    );
    assert_eq!(sent(&agent, SERVICE_START), 0);
    store.set_status(UNLOCKED);
    tick(&h);
    assert!(h.listens_here("here"));
    assert!(!h.listens_here("there"));
    assert!(machine.hosts("there"));
    h.manager.stop_all();
}

#[test]
fn a_wait_for_the_credential_store_ends_with_the_reason() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let store = FakeStore::new(UNLOCKED);
    let mut here = server("here", root.path(), None);
    with_password(&mut here);
    write(dir.path(), vec![here]);
    let h = run_with(
        dir.path(),
        &Arc::new(Machine::default()).agent(),
        &[],
        store.clone(),
    );
    edit(&h, "here", |s| s["httpAuth"]["password"] = json!("secret")).unwrap();
    store.set_status(LOCKED);
    h.manager.start_auto_servers();
    tick_at(&h, Instant::now() + WAIT_LIMIT);
    assert_row(
        &h,
        "here",
        ServerStatus::Error,
        "credential store stayed locked",
    );
    store.set_status(UNLOCKED);
    tick(&h);
    assert!(!h.listens_here("here"));
}

/// "Keep running" (#6076).
#[test]
fn a_pending_stop_can_be_taken_back() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    h.manager.stop_server("web").unwrap();
    assert_row(h, "web", ServerStatus::Stopping, "Its agent is offline");
    h.manager.keep_running("web").unwrap();
    assert_row(h, "web", ServerStatus::NotReachable, "Its agent is offline");
    online(agent, true);
    tick(h);
    assert_row(h, "web", ServerStatus::Running, "");
    assert!(machine.hosts("web"), "not stopped");
    // Nothing to take back.
    h.manager.keep_running("web").unwrap();
    assert_row(h, "web", ServerStatus::Running, "");
}

// ─── A stop wins ─────────────────────────────────────────────────────────────

#[test]
fn a_stop_while_the_agent_is_gone_wins_when_it_is_back() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    tick(h);
    h.manager.stop_server("web").unwrap();
    assert_row(
        h,
        "web",
        ServerStatus::Stopping,
        "Its agent is offline. It may still run there; it will be stopped when",
    );
    // Nothing that starts by itself undoes it.
    h.manager.start_auto_servers();
    tick(h);
    assert_row(h, "web", ServerStatus::Stopping, "Its agent");
    assert!(machine.hosts("web"));

    online(agent, true);
    h.events.lock().unwrap().clear();
    h.manager.start_auto_servers();
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
    assert!(!machine.hosts("web"));
    let events = h.events.lock().unwrap();
    assert!(
        events.iter().all(|s| s.status != ServerStatus::Running),
        "{events:?}"
    );
    assert_eq!(sent(agent, SERVICE_START), 1);
}

#[test]
fn a_stop_the_agent_does_not_answer_is_sent_again() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    h.manager.start_server("web").unwrap();
    agent.push(
        SERVICE_STOP,
        Step::error(|| TerminalError::agent_timeout(Duration::from_secs(10))),
    );
    h.manager.stop_server("web").unwrap();
    assert_row(
        h,
        "web",
        ServerStatus::Stopping,
        "Waiting for its agent to stop it",
    );
    tick(h);
    assert_row(h, "web", ServerStatus::Stopped, "");
    assert!(!machine.hosts("web"));
}

#[test]
fn a_server_deleted_or_moved_while_its_agent_is_gone_is_stopped_there_later() {
    for delete in [true, false] {
        let run = web_on_edge();
        let Run {
            h, agent, machine, ..
        } = &run;
        h.manager.start_server("web").unwrap();
        online(agent, false);
        tick(h);
        if delete {
            h.manager.delete_config("web").unwrap();
        } else {
            edit(h, "web", |s| s["host"] = json!({"kind": "thisComputer"})).unwrap();
            assert_eq!(h.state("web").status, ServerStatus::Stopped);
            h.manager.start_server("web").expect("here now");
            assert!(h.listens_here("web"));
        }
        online(agent, true);
        tick(h);
        assert!(!machine.hosts("web"), "still open on the agent");
        h.manager.stop_all();
    }
}

#[test]
fn a_start_after_a_stop_that_is_owed_stops_first() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    tick(h);
    h.manager.stop_server("web").unwrap();
    h.manager.start_server("web").expect_err("offline");
    online(agent, true);
    h.manager.start_server("web").expect("again");
    let order: Vec<String> = agent.requests().into_iter().map(|(m, _)| m).collect();
    assert_eq!(order, [SERVICE_START, SERVICE_STOP, SERVICE_START]);
    tick(h);
    assert_row(h, "web", ServerStatus::Running, "");
    assert!(machine.hosts("web"));
}

#[test]
fn a_stop_during_the_start_wins_and_a_second_start_is_not_sent() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    let gate = Gate::new();
    agent.push(
        SERVICE_START,
        Step::Hang(
            gate.clone(),
            Box::new(Step::Reply(json!({"status": {"state": "running"}}))),
        ),
    );
    machine.hosted.lock().unwrap().insert("web".into());
    std::thread::scope(|scope| {
        let _open = gate.open_on_drop();
        let manager = &h.manager;
        let start = scope.spawn(move || manager.start_server("web"));
        while sent(agent, SERVICE_START) == 0 {
            std::thread::yield_now();
        }
        assert_row(h, "web", ServerStatus::Starting, "");
        h.manager.start_server("web").expect_err("one at a time");
        h.manager.start_auto_servers();
        h.manager.stop_server("web").unwrap();
        assert_row(h, "web", ServerStatus::Stopping, "");
        gate.open();
        start.join().unwrap().unwrap();
    });
    assert_row(h, "web", ServerStatus::Stopped, "");
    assert!(!machine.hosts("web"));
    assert_eq!(sent(agent, SERVICE_START), 1);
}

#[test]
fn quitting_does_not_wait_for_an_agent_that_is_gone() {
    let run = web_on_edge();
    let Run {
        h, agent, machine, ..
    } = &run;
    h.manager.start_server("web").unwrap();
    online(agent, false);
    let asked = agent.requests().len();
    h.manager.stop_all();
    assert_eq!(agent.requests().len(), asked);
    online(agent, true);
    h.manager.stop_all();
    assert!(
        machine.hosts("web"),
        "the record of it is gone with the app"
    );
}

// ─── The poller does it by itself ────────────────────────────────────────────

/// The whole way over the real poller: wait, start, lose the agent, come back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_poller_starts_what_waits_and_follows_the_agent() {
    use crate::terminal::agent_manager::AgentRpcClient;
    use crate::utils::config_paths::ConfigDirOverride;

    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    online(&agent, false);
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let app = tauri::test::mock_app();
    app.manage(ConfigDirOverride(dir.path().to_path_buf()));
    let client: Arc<dyn AgentRpcClient> = agent.clone();
    app.manage(client);
    let manager = EmbeddedServerManager::new(app.handle(), FakeStore::new(UNLOCKED)).unwrap();
    app.manage(Arc::new(manager));
    let manager = app.state::<Arc<EmbeddedServerManager<MockRuntime>>>();
    let becomes = |status: ServerStatus| {
        let manager = &manager;
        async move {
            for _ in 0..200 {
                if manager.get_states().unwrap()[0].status == status {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("{:?}", manager.get_states().unwrap());
        }
    };
    tokio::task::block_in_place(|| manager.start_auto_servers());
    becomes(ServerStatus::Waiting).await;
    online(&agent, true);
    becomes(ServerStatus::Running).await;
    online(&agent, false);
    becomes(ServerStatus::NotReachable).await;
    online(&agent, true);
    becomes(ServerStatus::Running).await;
    assert_eq!(sent(&agent, SERVICE_START), 1);
    manager.stop_all();
}
