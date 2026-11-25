//! Where a file server runs is stored with it (#6028, F-1), and a host that
//! cannot be honoured never falls back to this computer: the server is not
//! started, no port opens, and its row says why.
//!
//! Each "restart" is a second [`EmbeddedServerManager`] over the same config
//! folder. Every server listens on an OS-assigned port (`0`), so a listener
//! that should not exist is visible as a local address.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::test::{mock_app, MockRuntime};
use tauri::Manager;
use termihub_core::protocol::methods::{SERVICE_START, SERVICE_STOP};

use super::EmbeddedServerManager;
use crate::app_tasks::AppTasks;
use crate::commands::projection::ProjectionState;
use crate::connection::config::SavedRemoteAgent;
use crate::connection::manager::ConnectionManager;
use crate::credential::NullStore;
use crate::embedded_servers::config::{EmbeddedServerConfig, ServerState, ServerStatus};
use crate::embedded_servers::projection::{publish_services, SERVICES_REGION};
use crate::embedded_servers::secrets::tests::{FakeStore, UNLOCKED};
use crate::projection::{apply_ops, ProjectionError, ProjectionFrame, ProjectionSink};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::test_support::agent_rpc::{FakeAgent, Gate, Step};
use crate::utils::config_paths::ConfigDirOverride;
use crate::utils::errors::TerminalError;

const FILE: &str = "embedded_servers.json";

pub(super) struct Harness {
    pub(super) manager: Arc<EmbeddedServerManager<MockRuntime>>,
    /// Every change of a server's state or reason that the windows were told.
    pub(super) events: Arc<Mutex<Vec<ServerState>>>,
    pub(super) app: tauri::App<MockRuntime>,
}

/// One app run over `dir`. `agents` are the saved agents (`id`, `name`).
pub(super) fn run(dir: &Path, agent: &Arc<FakeAgent>, agents: &[(&str, &str)]) -> Harness {
    run_with(dir, agent, agents, FakeStore::new(UNLOCKED))
}

/// [`run`] over a credential store of its own.
pub(super) fn run_with(
    dir: &Path,
    agent: &Arc<FakeAgent>,
    agents: &[(&str, &str)],
    store: Arc<FakeStore>,
) -> Harness {
    let app = mock_app();
    // The status poller ends at once: a test ticks by hand (or not at all).
    let tasks = AppTasks::new();
    tasks.cancellation_token().cancel();
    app.manage(tasks);
    app.manage(ConfigDirOverride(dir.to_path_buf()));
    let client: Arc<dyn AgentRpcClient> = agent.clone();
    app.manage(client);
    let connections =
        ConnectionManager::new_for_test(dir, Arc::new(NullStore)).expect("connection manager");
    for (id, name) in agents {
        let saved: SavedRemoteAgent = serde_json::from_value(json!({
            "id": id, "name": name,
            "config": {"host": "edge.example", "port": 22, "username": "u", "authMethod": "agent"},
        }))
        .expect("agent parses");
        connections.save_agent(saved).expect("agent saved");
    }
    app.manage(connections);
    let events = watch(&app);
    let manager = Arc::new(EmbeddedServerManager::new(app.handle(), store).expect("manager"));
    app.manage(Arc::clone(&manager));
    publish_services(app.handle());
    events.lock().unwrap().clear();
    Harness {
        manager,
        events,
        app,
    }
}

/// A window over the `services` region: the states it was told, one per change
/// of a server's status or reason.
struct Window {
    view: Mutex<Value>,
    told: Arc<Mutex<Vec<ServerState>>>,
}

impl ProjectionSink for Window {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        let mut view = self.view.lock().unwrap();
        let before = view.clone();
        match frame {
            ProjectionFrame::Diff(diff) => apply_ops(&mut view, &diff.ops).unwrap(),
            ProjectionFrame::Snapshot(snapshot) => *view = snapshot.view.clone(),
        }
        let Some(states) = view["states"].as_object() else {
            return Ok(());
        };
        for (id, state) in states {
            let old = &before["states"][id];
            if old["status"] != state["status"] || old["error"] != state["error"] {
                let state = serde_json::from_value(state.clone()).expect("ServerState");
                self.told.lock().unwrap().push(state);
            }
        }
        Ok(())
    }
}

/// Manage the projection of `app` and open a window over its file servers.
pub(super) fn watch(app: &tauri::App<MockRuntime>) -> Arc<Mutex<Vec<ServerState>>> {
    let told = Arc::<Mutex<Vec<ServerState>>>::default();
    let projection = ProjectionState::new();
    let window = Window {
        view: Mutex::new(Value::Null),
        told: Arc::clone(&told),
    };
    projection
        .projector
        .subscribe(SERVICES_REGION, "s1", "window", Arc::new(window));
    app.manage(projection);
    told
}

impl Harness {
    pub(super) fn state(&self, id: &str) -> ServerState {
        self.manager
            .get_states()
            .unwrap()
            .into_iter()
            .find(|s| s.server_id == id)
            .expect("server is listed")
    }

    /// Whether a listener of `id` is open on this computer.
    pub(super) fn listens_here(&self, id: &str) -> bool {
        self.manager
            .services
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|service| service.local_addr().is_some())
    }

    /// `id` did not start anywhere, and its row says `reason`.
    pub(super) fn assert_refused(&self, id: &str, reason: &str) {
        assert!(
            !self.listens_here(id),
            "{id} opened a port on this computer"
        );
        let state = self.state(id);
        assert_eq!(state.status, ServerStatus::Error, "{state:?}");
        let error = state.error.unwrap_or_default();
        assert!(error.contains(reason), "{error:?} does not say {reason:?}");
        let last = self
            .events
            .lock()
            .unwrap()
            .iter()
            .rfind(|s| s.server_id == id)
            .cloned()
            .expect("announced");
        assert_eq!(last.error.as_deref(), Some(error.as_str()));
    }
}

/// A stored HTTP server on any free port; `host` is the raw field, when there.
pub(super) fn server(id: &str, root: &Path, host: Option<Value>) -> Value {
    let mut server = json!({
        "id": id, "name": id, "serverType": "http", "bindHost": "127.0.0.1", "port": 0,
        "rootDirectory": root.to_string_lossy(), "autoStart": true, "readOnly": true,
    });
    if let Some(host) = host {
        server["host"] = host;
    }
    server
}

pub(super) fn write(dir: &Path, servers: Vec<Value>) {
    let doc = json!({"version": "2", "servers": servers});
    std::fs::write(dir.join(FILE), doc.to_string()).unwrap();
}

fn stored(dir: &Path, id: &str) -> Value {
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
    doc["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .expect("stored")
        .clone()
}

pub(super) fn edit(
    h: &Harness,
    id: &str,
    change: impl FnOnce(&mut Value),
) -> Result<(), TerminalError> {
    let config = h.manager.get_configs().unwrap();
    let mut value =
        serde_json::to_value(config.iter().find(|c| c.id == id).expect("listed")).unwrap();
    change(&mut value);
    let config: EmbeddedServerConfig = serde_json::from_value(value).unwrap();
    h.manager.save_config(config)
}

pub(super) fn on_agent(id: &str) -> Value {
    json!({"kind": "agent", "agentId": id})
}

fn started_on_agent(agent: &FakeAgent) -> usize {
    agent
        .requests()
        .iter()
        .filter(|(method, _)| method == SERVICE_START)
        .count()
}

#[test]
fn a_server_set_to_an_agent_starts_there_after_a_restart() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::default());
    write(dir.path(), vec![server("web", root.path(), None)]);
    let first = run(dir.path(), &agent, &[("edge", "Edge box")]);
    edit(&first, "web", |s| s["host"] = on_agent("edge")).unwrap();
    drop(first);

    let second = run(dir.path(), &agent, &[]);
    second.manager.start_auto_servers();

    assert!(!second.listens_here("web"), "opened on this computer");
    assert_eq!(started_on_agent(&agent), 1);
    assert_eq!(stored(dir.path(), "web")["host"], on_agent("edge"));
}

#[test]
fn a_server_without_a_host_runs_on_this_computer_as_before() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::offline());
    write(
        dir.path(),
        vec![
            server("old", root.path(), None),
            server("here", root.path(), Some(json!({"kind": "thisComputer"}))),
        ],
    );
    let h = run(dir.path(), &agent, &[]);
    h.manager.start_auto_servers();
    assert!(h.listens_here("old"));
    assert!(h.listens_here("here"));
    h.manager.stop_all();
    // Saving another server leaves the stored one without a host.
    edit(&h, "here", |s| s["name"] = json!("renamed")).unwrap();
    assert!(stored(dir.path(), "old").get("host").is_none());
}

#[test]
fn an_offline_agent_means_not_started() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::offline());
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_server("web").expect_err("offline");
    h.assert_refused("web", "agent Edge box is not connected");
    assert!(agent.requests().is_empty());
}

#[test]
fn a_removed_agent_means_not_started_and_no_request() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    // Connected by accident: the id must not reach it.
    let agent = Arc::new(FakeAgent::default());
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("gone")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_auto_servers();
    h.assert_refused("web", "the agent it runs on was removed");
    assert!(agent.requests().is_empty());
}

#[test]
fn a_renamed_agent_keeps_hosting_and_is_named_as_it_is_now() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let agent = Arc::new(FakeAgent::default());
    let h = run(dir.path(), &agent, &[("edge", "Old name")]);
    h.manager.start_server("web").expect("starts on the agent");
    h.manager.stop_all();
    drop(h);
    let offline = Arc::new(FakeAgent::offline());
    let h = run(dir.path(), &offline, &[("edge", "New name")]);
    h.manager.start_server("web").expect_err("offline");
    h.assert_refused("web", "agent New name is not connected");
}

#[test]
fn an_agent_that_is_too_old_means_not_started() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::default().on(
        SERVICE_START,
        Step::error(|| TerminalError::AgentUnsupported("method not found".into())),
    ));
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_server("web").expect_err("too old");
    h.assert_refused("web", "agent Edge box is too old");
}

#[test]
fn an_agent_that_refuses_means_not_started() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent {
        refuse: vec![SERVICE_START],
        ..FakeAgent::default()
    });
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_server("web").expect_err("refused");
    h.assert_refused("web", "agent Edge box could not start it");
}

/// Every host this build cannot read: from a newer build, or damaged.
fn unreadable_hosts() -> Vec<Value> {
    vec![
        Value::Null,
        json!("edge"),
        json!(5),
        json!([]),
        json!({}),
        json!({"kind": "agent"}),
        json!({"kind": "agent", "agentId": ""}),
        json!({"kind": "agent", "agentId": 5}),
        json!({"kind": "cluster", "clusterId": "a"}),
        // Known kinds with something this build does not know beside them.
        json!({"kind": "thisComputer", "jail": "/srv"}),
        json!({"kind": "agent", "agentId": "edge", "container": "web"}),
    ]
}

#[test]
fn an_unreadable_host_means_not_started_and_is_kept() {
    for host in unreadable_hosts() {
        let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let agent = Arc::new(FakeAgent::default());
        write(
            dir.path(),
            vec![
                server("web", root.path(), Some(host.clone())),
                server("other", root.path(), None),
            ],
        );
        let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
        h.manager.start_server("web").expect_err(&host.to_string());
        h.assert_refused("web", "cannot read where it runs");
        assert!(agent.requests().is_empty(), "{host}");

        // A rename keeps it, whether the editor sends it back or leaves it out;
        // so does a save of another server.
        edit(&h, "web", |s| s["name"] = json!("renamed")).unwrap();
        assert_eq!(stored(dir.path(), "web").get("host"), Some(&host));
        edit(&h, "web", |s| {
            s.as_object_mut().unwrap().remove("host");
        })
        .unwrap();
        assert_eq!(stored(dir.path(), "web").get("host"), Some(&host));
        edit(&h, "other", |s| s["name"] = json!("renamed")).unwrap();
        assert_eq!(stored(dir.path(), "web").get("host"), Some(&host));
        assert_eq!(stored(dir.path(), "web")["name"], "renamed");

        // Choosing a machine is the way out.
        edit(&h, "web", |s| s["host"] = json!({"kind": "thisComputer"})).unwrap();
        assert_eq!(h.state("web").status, ServerStatus::Stopped, "{host}");
        h.manager.start_server("web").expect("runs here now");
        assert!(h.listens_here("web"));
        h.manager.stop_all();
    }
}

#[test]
fn a_save_without_a_host_keeps_the_agent() {
    // A window with an old copy of the list must not move the server here.
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::default());
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    edit(&h, "web", |s| {
        s["name"] = json!("renamed");
        s.as_object_mut().unwrap().remove("host");
    })
    .unwrap();
    assert_eq!(stored(dir.path(), "web")["host"], on_agent("edge"));
    h.manager.start_server("web").unwrap();
    assert!(!h.listens_here("web"));
}

#[test]
fn moving_a_running_server_stops_it_where_it_ran() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::default());
    write(dir.path(), vec![server("web", root.path(), None)]);
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_server("web").unwrap();
    assert!(h.listens_here("web"));

    // A change of anything else leaves it running.
    edit(&h, "web", |s| s["name"] = json!("renamed")).unwrap();
    assert!(h.listens_here("web"));

    edit(&h, "web", |s| s["host"] = on_agent("edge")).unwrap();
    assert!(!h.listens_here("web"), "still open on this computer");
    assert_eq!(h.state("web").status, ServerStatus::Stopped);

    h.manager.start_server("web").unwrap();
    assert!(!h.listens_here("web"));
    edit(&h, "web", |s| s["host"] = json!({"kind": "thisComputer"})).unwrap();
    assert!(agent.requests().iter().any(|(m, _)| m == SERVICE_STOP));
    assert_eq!(h.state("web").status, ServerStatus::Stopped);
    assert!(!h.listens_here("web"), "a move does not start it");
}

#[test]
fn the_reason_goes_away_with_stop_and_with_a_good_start() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let agent = Arc::new(FakeAgent {
        refuse_times: Mutex::new(vec![(SERVICE_START, 2)]),
        ..FakeAgent::default()
    });
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_server("web").expect_err("first");
    h.assert_refused("web", "could not start it");
    h.manager.stop_server("web").unwrap();
    assert_eq!(h.state("web").status, ServerStatus::Stopped);
    h.manager.start_server("web").expect_err("second");
    h.manager.start_server("web").expect("third");
    assert_ne!(h.state("web").status, ServerStatus::Error);
}

#[test]
fn the_agent_is_not_sent_the_host() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let agent = Arc::new(FakeAgent::default());
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    h.manager.start_server("web").unwrap();
    let (_, params) = agent.requests().remove(0);
    assert!(params["config"].get("host").is_none(), "{params}");
}

#[test]
fn unknown_fields_survive_a_change_of_host() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut entry = server("web", root.path(), None);
    entry["futureField"] = json!({"nested": [1, {"deep": true}]});
    write(dir.path(), vec![entry]);
    let h = run(
        dir.path(),
        &Arc::new(FakeAgent::default()),
        &[("edge", "Edge box")],
    );
    edit(&h, "web", |s| s["host"] = on_agent("edge")).unwrap();
    assert_eq!(
        stored(dir.path(), "web")["futureField"],
        json!({"nested": [1, {"deep": true}]})
    );
}

/// F-4: a copy has no saved password. It is refused, never started open.
#[test]
fn a_copy_without_its_password_is_refused() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut entry = server("web", root.path(), None);
    entry["httpAuth"] = json!({"username": "web", "password": "secret"});
    let h = run(dir.path(), &Arc::new(FakeAgent::default()), &[]);
    let config: EmbeddedServerConfig = serde_json::from_value(entry).unwrap();
    h.manager.save_config(config).unwrap();
    let mut copy = h.manager.get_configs().unwrap().remove(0);
    copy.id = "copy".into();
    h.manager.save_config(copy).unwrap();
    h.manager.start_server("web").expect("the original starts");
    let err = h.manager.start_server("copy").expect_err("no password");
    assert!(
        err.to_string().contains("enter the password again"),
        "{err}"
    );
    assert!(!h.listens_here("copy"));
    h.manager.stop_all();
}

/// A save that moves the server while it is starting here wins: the listener is
/// opened only for a server that is still stored to run here.
#[test]
fn a_server_moved_away_before_its_port_opens_does_not_open() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write(dir.path(), vec![server("web", root.path(), None)]);
    let h = run(
        dir.path(),
        &Arc::new(FakeAgent::default()),
        &[("edge", "Edge box")],
    );
    let as_it_was = h.manager.get_configs().unwrap().remove(0);
    edit(&h, "web", |s| s["host"] = on_agent("edge")).unwrap();
    h.manager
        .listen_here("web", as_it_was)
        .expect_err("moved meanwhile");
    assert!(!h.listens_here("web"));
}

/// The same for an agent: moved while the agent was starting it means stopped
/// there again.
#[test]
fn a_server_moved_while_the_agent_starts_it_is_stopped_there() {
    let (dir, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let gate = Gate::new();
    let agent = Arc::new(FakeAgent::default().on(
        SERVICE_START,
        Step::Hang(
            gate.clone(),
            Box::new(Step::Reply(json!({"status": {"state": "running"}}))),
        ),
    ));
    write(
        dir.path(),
        vec![server("web", root.path(), Some(on_agent("edge")))],
    );
    let h = run(dir.path(), &agent, &[("edge", "Edge box")]);
    std::thread::scope(|scope| {
        let _release = gate.open_on_drop();
        let start = scope.spawn(|| h.manager.start_server("web"));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while started_on_agent(&agent) == 0 {
            assert!(std::time::Instant::now() < deadline, "never asked");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        edit(&h, "web", |s| s["host"] = json!({"kind": "thisComputer"})).unwrap();
        gate.open();
        start.join().unwrap().expect("stopped, not failed");
    });
    assert!(agent.requests().iter().any(|(m, _)| m == SERVICE_STOP));
    assert_eq!(h.state("web").status, ServerStatus::Stopped);
    assert!(!h.listens_here("web"));
}
