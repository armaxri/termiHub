//! [`EmbeddedServerManager`] start-failure branches on a mock Tauri runtime
//! (#5288): a port another process holds, a restart after that port frees,
//! `auto_start` failing at launch, and an agent refusing to host a server.
//!
//! Every port is OS-assigned (bound to `127.0.0.1:0`) and held by the test
//! itself, so no test fights another checkout for a fixed port. The agent is
//! the injected scripted [`FakeAgent`]; no real agent or network is involved.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::{mock_app, MockRuntime};
use tauri::{Listener, Manager};
use termihub_core::protocol::methods::{SERVICE_START, SERVICE_STOP};

use super::{EmbeddedServerManager, SERVER_STATUS_EVENT};
use crate::embedded_servers::config::{EmbeddedServerConfig, ServerState, ServerStatus};
use crate::embedded_servers::secrets::tests::{http, FakeStore, LOCKED, UNLOCKED};
use crate::network::test_support::FakeAgent;
use crate::run_location::RunLocation;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::config_paths::ConfigDirOverride;

/// How long a stopped listener may take to release its port.
const CLOSE_DEADLINE: Duration = Duration::from_secs(5);

/// A manager on the mock runtime that records every status event it emits.
struct Harness {
    manager: EmbeddedServerManager<MockRuntime>,
    store: Arc<FakeStore>,
    events: Arc<Mutex<Vec<ServerState>>>,
    _app: tauri::App<MockRuntime>,
}

fn harness(config_dir: &Path, agent: Option<Arc<FakeAgent>>) -> Harness {
    let app = mock_app();
    app.manage(ConfigDirOverride(config_dir.to_path_buf()));
    if let Some(agent) = agent {
        let client: Arc<dyn AgentRpcClient> = agent;
        app.manage(client);
    }
    let events: Arc<Mutex<Vec<ServerState>>> = Arc::default();
    let log = Arc::clone(&events);
    app.handle().listen_any(SERVER_STATUS_EVENT, move |event| {
        let state: ServerState = serde_json::from_str(event.payload()).expect("ServerState");
        log.lock().unwrap().push(state);
    });
    let store = FakeStore::new(UNLOCKED);
    let manager = EmbeddedServerManager::new(app.handle(), store.clone())
        .expect("manager builds on the mock runtime");
    Harness {
        manager,
        store,
        events,
        _app: app,
    }
}

impl Harness {
    /// The status events emitted for `id`, in order.
    fn events_for(&self, id: &str) -> Vec<ServerState> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.server_id == id)
            .cloned()
            .collect()
    }

    fn state_of(&self, id: &str) -> ServerState {
        self.manager
            .get_states()
            .unwrap()
            .into_iter()
            .find(|s| s.server_id == id)
            .expect("server is listed")
    }

    fn local_addr(&self, id: &str) -> Option<SocketAddr> {
        self.manager
            .services
            .lock()
            .unwrap()
            .get(id)
            .and_then(|service| service.local_addr())
    }
}

/// An HTTP server config on `port`, served from `root`.
fn http_on(id: &str, port: u16, root: &Path) -> EmbeddedServerConfig {
    let mut config = http(id, "pw");
    config.port = port;
    config.root_directory = root.to_string_lossy().into_owned();
    config
}

/// Hold an OS-assigned loopback port, as another process would.
fn occupy_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// Wait until `port` can be bound again (a stopped server released it).
fn wait_until_free(port: u16) {
    let deadline = Instant::now() + CLOSE_DEADLINE;
    while TcpListener::bind(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < deadline, "port {port} never freed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn start_on_a_busy_port_fails_and_succeeds_once_the_port_frees() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let (blocker, port) = occupy_port();
    h.manager
        .save_config(http_on("web", port, root.path()))
        .unwrap();

    let err = h.manager.start_server("web").expect_err("port is taken");
    assert!(err.to_string().contains("already in use"), "{err}");
    assert!(
        h.local_addr("web").is_none(),
        "nothing listens after a failed start"
    );
    assert_eq!(h.state_of("web").status, ServerStatus::Stopped);

    drop(blocker);
    h.manager.start_server("web").expect("the retry starts");
    let addr = h.local_addr("web").expect("listening");
    assert_eq!(addr.port(), port, "the retry honours the configured port");
    assert!(TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok());
    assert_eq!(h.state_of("web").status, ServerStatus::Running);
    h.manager.stop_all();
}

#[test]
fn restart_when_the_port_was_taken_meanwhile_fails_then_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let (probe, port) = occupy_port();
    drop(probe);
    h.manager
        .save_config(http_on("web", port, root.path()))
        .unwrap();
    h.manager.start_server("web").expect("first start");
    h.manager.stop_server("web").unwrap();
    wait_until_free(port);

    // Another process grabs the port while the server is stopped.
    let blocker = TcpListener::bind(("127.0.0.1", port)).expect("take the freed port");
    let err = h
        .manager
        .start_server("web")
        .expect_err("restart hits the conflict");
    assert!(err.to_string().contains("already in use"), "{err}");
    let state = h.state_of("web");
    assert_eq!(state.status, ServerStatus::Stopped, "not stuck Running");
    assert_eq!(state.started_at, None);

    drop(blocker);
    h.manager.start_server("web").expect("restart recovers");
    assert_eq!(h.local_addr("web").map(|a| a.port()), Some(port));
    assert_eq!(h.state_of("web").status, ServerStatus::Running);
    h.manager.stop_all();
}

#[test]
fn auto_start_failure_surfaces_an_error_and_the_rest_still_start() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let (_blocker, busy_port) = occupy_port();
    let mut busy = http_on("busy", busy_port, root.path());
    busy.auto_start = true;
    let mut ok = http_on("ok", 0, root.path());
    ok.auto_start = true;
    let manual = http_on("manual", 0, root.path());
    for config in [busy, ok, manual] {
        h.manager.save_config(config).unwrap();
    }

    h.manager.start_auto_servers();

    let busy_events = h.events_for("busy");
    let last = busy_events.last().expect("the failure is announced");
    assert_eq!(last.status, ServerStatus::Error);
    let reason = last.error.as_deref().unwrap_or_default();
    assert!(reason.contains("already in use"), "{reason}");
    assert!(h.local_addr("busy").is_none());

    assert!(
        h.local_addr("ok").is_some(),
        "one failure does not stop the rest"
    );
    assert_eq!(h.state_of("ok").status, ServerStatus::Running);

    assert!(
        h.local_addr("manual").is_none(),
        "auto_start: false is not started"
    );
    assert!(h.events_for("manual").is_empty());
    h.manager.stop_all();
}

#[test]
fn auto_start_with_a_locked_credential_store_reports_why() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let mut locked = http_on("locked", 0, root.path());
    locked.auto_start = true;
    h.manager.save_config(locked).unwrap();
    h.store.set_status(LOCKED);

    h.manager.start_auto_servers();

    let last = h
        .events_for("locked")
        .pop()
        .expect("the failure is announced");
    assert_eq!(last.status, ServerStatus::Error);
    let reason = last.error.unwrap_or_default();
    assert!(reason.contains("credential store is locked"), "{reason}");
    assert!(h.local_addr("locked").is_none());
}

#[test]
fn starting_an_unknown_server_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let err = h.manager.start_server("ghost").expect_err("no such server");
    assert!(err.to_string().contains("Server not found: ghost"), "{err}");
}

#[test]
fn agent_hosting_without_an_agent_manager_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    h.manager
        .save_config(http_on("web", 0, root.path()))
        .unwrap();
    h.manager
        .set_run_location("web", RunLocation::Agent("edge".into()))
        .unwrap();

    let err = h.manager.start_server("web").expect_err("no agent manager");
    assert!(
        err.to_string().contains("Agent manager is not available"),
        "{err}"
    );
}

#[test]
fn an_agent_refusing_to_host_surfaces_an_error_and_keeps_no_handle() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent {
        refuse: vec![SERVICE_START],
        ..FakeAgent::default()
    });
    let h = harness(dir.path(), Some(Arc::clone(&agent)));
    h.manager
        .save_config(http_on("web", 0, root.path()))
        .unwrap();
    h.manager
        .set_run_location("web", RunLocation::Agent("edge".into()))
        .unwrap();

    let err = h.manager.start_server("web").expect_err("agent refused");
    assert!(
        err.to_string()
            .contains("agent-hosted embedded server start failed"),
        "{err}"
    );

    let last = h.events_for("web").pop().expect("the failure is announced");
    assert_eq!(last.status, ServerStatus::Error);
    assert_eq!(
        h.state_of("web").status,
        ServerStatus::Stopped,
        "no stale handle"
    );
    // Stopping it sends nothing to the agent: there is no handle to stop.
    h.manager.stop_server("web").unwrap();
    let methods: Vec<String> = agent.requests().into_iter().map(|(m, _)| m).collect();
    assert_eq!(methods, [SERVICE_START]);
}

#[test]
fn a_second_start_on_an_agent_is_rejected_until_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let h = harness(dir.path(), Some(Arc::clone(&agent)));
    h.manager
        .save_config(http_on("web", 0, root.path()))
        .unwrap();
    h.manager
        .set_run_location("web", RunLocation::Agent("edge".into()))
        .unwrap();

    h.manager.start_server("web").expect("agent hosts it");
    let err = h.manager.start_server("web").expect_err("double start");
    assert!(
        err.to_string().contains("already running on an agent"),
        "{err}"
    );

    h.manager.stop_server("web").unwrap();
    assert!(agent.requests().iter().any(|(m, _)| m == SERVICE_STOP));
    h.manager
        .start_server("web")
        .expect("a stopped server restarts");
    h.manager.stop_all();
}
