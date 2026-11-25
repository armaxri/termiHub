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
use tauri::Manager;
use termihub_core::protocol::methods::{SERVICE_START, SERVICE_STOP};
use termihub_core::util::service_cause::ServiceCause;
use termihub_core::util::service_host::ServiceHost;

use super::host_tests::watch;
use super::{EmbeddedServerManager, UNDO_KEPT};
use crate::embedded_servers::config::{EmbeddedServerConfig, ServerState, ServerStatus};
use crate::embedded_servers::secrets::tests::{http, FakeStore, LOCKED, UNLOCKED};
use crate::embedded_servers::secrets::{credential_key, AuthSlot};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::test_support::FakeAgent;
use crate::utils::config_paths::ConfigDirOverride;

/// How long a stopped listener may take to release its port.
const CLOSE_DEADLINE: Duration = Duration::from_secs(5);

/// A manager on the mock runtime that records every status event it emits.
struct Harness {
    manager: Arc<EmbeddedServerManager<MockRuntime>>,
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
    let events = watch(&app);
    let store = FakeStore::new(UNLOCKED);
    let manager = EmbeddedServerManager::new(app.handle(), store.clone())
        .expect("manager builds on the mock runtime");
    let manager = Arc::new(manager);
    app.manage(Arc::clone(&manager));
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
    // Durable (#6028): the row says why until the next try.
    let state = h.state_of("web");
    assert_eq!(state.status, ServerStatus::Error);
    assert_eq!(
        state.error,
        Some(format!("Port {port} is already in use on this computer."))
    );
    assert_eq!(state.cause, Some(ServiceCause::PortInUse));

    drop(blocker);
    h.manager.start_server("web").expect("the retry starts");
    let addr = h.local_addr("web").expect("listening");
    assert_eq!(addr.port(), port, "the retry honours the configured port");
    assert!(TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok());
    let state = h.state_of("web");
    assert_eq!((state.status, state.cause), (ServerStatus::Running, None));
    h.manager.stop_all();
}

#[test]
fn a_start_that_fails_on_a_free_port_is_not_blamed_on_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let (probe, port) = occupy_port();
    drop(probe);
    let mut config = http_on("web", port, root.path());
    config.bind_host = "192.0.2.1".into(); // not an address of this computer
    h.manager.save_config(config).unwrap();

    h.manager.start_server("web").expect_err("cannot bind");
    let state = h.state_of("web");
    assert_eq!((state.status, state.cause), (ServerStatus::Error, None));
    let reason = state.error.unwrap_or_default();
    assert!(
        reason.starts_with(&format!("Port {port} cannot be opened")),
        "{reason}"
    );
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
    assert_eq!(state.status, ServerStatus::Error, "not stuck Running");
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
    assert!(h
        .events_for("manual")
        .iter()
        .all(|s| s.status == ServerStatus::Stopped));
    h.manager.stop_all();
}

#[test]
fn auto_start_with_a_locked_credential_store_waits_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    let mut locked = http_on("locked", 0, root.path());
    locked.auto_start = true;
    h.manager.save_config(locked).unwrap();
    h.store.set_status(LOCKED);

    h.manager.start_auto_servers();

    let last = h.events_for("locked").pop().expect("the wait is announced");
    assert_eq!(last.status, ServerStatus::Waiting);
    let reason = last.error.unwrap_or_default();
    assert!(
        reason.contains("Starts when you unlock the credential store, until "),
        "{reason}"
    );
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
    let mut config = http_on("web", 0, root.path());
    config.host = ServiceHost::agent("edge");
    h.manager.save_config(config).unwrap();

    let err = h.manager.start_server("web").expect_err("no agent manager");
    assert!(
        err.to_string().contains("its agent is not connected"),
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
    let mut config = http_on("web", 0, root.path());
    config.host = ServiceHost::agent("edge");
    h.manager.save_config(config).unwrap();

    let err = h.manager.start_server("web").expect_err("agent refused");
    assert!(
        err.to_string().contains("its agent could not start it"),
        "{err}"
    );

    let last = h.events_for("web").pop().expect("the failure is announced");
    assert_eq!(last.status, ServerStatus::Error);
    assert_eq!(
        h.state_of("web").status,
        ServerStatus::Error,
        "no stale handle, and the reason stays (#6028)"
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
    let mut config = http_on("web", 0, root.path());
    config.host = ServiceHost::agent("edge");
    h.manager.save_config(config).unwrap();

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

// ─── Undo of a delete (#6076) ────────────────────────────────────────────────

fn ids(h: &Harness) -> Vec<String> {
    let configs = h.manager.get_configs().unwrap();
    configs.into_iter().map(|config| config.id).collect()
}

fn password(h: &Harness, id: &str) -> Option<String> {
    h.store.raw(&credential_key(id, AuthSlot::HttpBasic))
}

#[test]
fn a_deleted_server_comes_back_at_its_place_with_its_password() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    for id in ["a", "b", "c"] {
        h.manager.save_config(http_on(id, 0, root.path())).unwrap();
    }
    h.manager.start_server("b").unwrap();
    h.manager.delete_config("b").unwrap();
    assert_eq!(ids(&h), ["a", "c"]);
    assert_eq!(password(&h, "b"), None, "not kept in the store");

    h.manager.restore_deleted("b").unwrap();
    assert_eq!(ids(&h), ["a", "b", "c"]);
    assert_eq!(password(&h, "b").as_deref(), Some("pw"));
    let state = h.state_of("b");
    assert_eq!(state.status, ServerStatus::Stopped, "not started");
    h.manager.start_server("b").expect("starts as before");
    h.manager.stop_all();
    // Written, too.
    let again = harness(dir.path(), None);
    assert_eq!(ids(&again), ["a", "b", "c"]);
    // Once.
    h.manager.restore_deleted("b").expect_err("nothing to undo");
    assert_eq!(ids(&h), ["a", "b", "c"]);
}

#[test]
fn a_password_comes_back_when_the_store_was_locked_meanwhile() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    h.manager.save_config(http_on("a", 0, root.path())).unwrap();
    h.manager.delete_config("a").unwrap();
    h.store.set_status(LOCKED);
    h.manager.restore_deleted("a").unwrap();
    // It starts in this session, and is stored after the unlock.
    h.manager.start_server("a").expect("held in memory");
    h.store.set_status(UNLOCKED);
    h.manager.sync_secrets();
    assert_eq!(password(&h, "a").as_deref(), Some("pw"));
    h.manager.stop_all();
}

#[test]
fn a_delete_is_final_after_a_while() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path(), None);
    h.manager.save_config(http_on("a", 0, root.path())).unwrap();
    h.manager.delete_config("a").unwrap();
    h.manager
        .forget_deleted(Instant::now() + UNDO_KEPT - Duration::from_secs(1));
    assert!(h.manager.lock_deleted().contains_key("a"));
    h.manager.forget_deleted(Instant::now() + UNDO_KEPT);
    let err = h.manager.restore_deleted("a").expect_err("too late");
    assert!(
        err.to_string().contains("no longer be brought back"),
        "{err}"
    );
    assert!(ids(&h).is_empty());
}
