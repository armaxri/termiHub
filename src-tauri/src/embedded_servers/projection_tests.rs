//! The `services` region over the real manager (#6028, F-6): what one window
//! does, every window sees, and nobody has to ask.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::test::{mock_app, MockRuntime};
use tauri::Manager;

use super::*;
use crate::embedded_servers::secrets::tests::{http, FakeStore, UNLOCKED};
use crate::projection::{apply_ops, ProjectionFrame, SnapshotFrame};
use crate::test_support::RecordingSink;
use crate::utils::config_paths::ConfigDirOverride;

struct Run {
    app: tauri::App<MockRuntime>,
    manager: Arc<EmbeddedServerManager<MockRuntime>>,
    _dir: tempfile::TempDir,
}

fn run() -> Run {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_app();
    app.manage(ConfigDirOverride(dir.path().to_path_buf()));
    app.manage(ProjectionState::new());
    let manager = EmbeddedServerManager::new(app.handle(), FakeStore::new(UNLOCKED)).unwrap();
    let manager = Arc::new(manager);
    app.manage(Arc::clone(&manager));
    publish_services(app.handle());
    Run {
        app,
        manager,
        _dir: dir,
    }
}

/// One window: what it was sent, folded into what it shows.
struct Window {
    first: SnapshotFrame,
    sink: Arc<RecordingSink>,
}

impl Window {
    fn open(run: &Run, id: &str) -> Self {
        let sink = Arc::new(RecordingSink::new());
        let state = run.app.state::<ProjectionState>();
        let first = state
            .projector
            .subscribe(SERVICES_REGION, id, id, sink.clone());
        Self { first, sink }
    }

    fn view(&self) -> Value {
        let mut view = self.first.view.clone();
        for diff in self.sink.diffs() {
            apply_ops(&mut view, &diff.ops).unwrap();
        }
        view
    }
}

fn server(run: &Run, id: &str) -> EmbeddedServerConfig {
    let mut config = http(id, "pw");
    config.port = 0;
    config.root_directory = run._dir.path().to_string_lossy().into_owned();
    config
}

#[test]
fn every_window_sees_what_one_saves_starts_stops_and_deletes() {
    let run = run();
    let (a, b) = (Window::open(&run, "a"), Window::open(&run, "b"));
    assert_eq!(a.view(), json!({"servers": [], "states": {}}));

    run.manager.save_config(server(&run, "web")).unwrap();
    for window in [&a, &b] {
        assert_eq!(window.view()["servers"][0]["id"], "web");
        assert_eq!(window.view()["states"]["web"]["status"], "stopped");
    }
    run.manager.start_server("web").unwrap();
    assert_eq!(b.view()["states"]["web"]["status"], "running");
    run.manager.stop_server("web").unwrap();
    assert_eq!(b.view()["states"]["web"]["status"], "stopped");
    run.manager.delete_config("web").unwrap();
    assert_eq!(a.view(), json!({"servers": [], "states": {}}));
    assert_eq!(a.view(), b.view());

    // A window opened later starts from the same.
    run.manager.save_config(server(&run, "late")).unwrap();
    assert_eq!(Window::open(&run, "c").view(), a.view());
}

#[test]
fn the_region_never_carries_a_password() {
    let run = run();
    let window = Window::open(&run, "a");
    run.manager.save_config(server(&run, "web")).unwrap();
    run.manager.start_server("web").unwrap();
    let frames = serde_json::to_string(&window.sink.frames()).unwrap();
    assert!(frames.contains("\"web\""));
    assert!(!frames.contains("\"pw\""), "{frames}");
    run.manager.stop_all();
}

#[test]
fn a_start_that_fails_stays_on_the_row_with_its_reason_until_the_next_try() {
    let run = run();
    let window = Window::open(&run, "a");
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut config = server(&run, "web");
    config.port = taken.local_addr().unwrap().port();
    run.manager.save_config(config).unwrap();
    run.manager.start_server("web").expect_err("taken");
    let state = window.view()["states"]["web"].clone();
    assert_eq!(state["status"], "error", "{state}");
    assert!(
        state["error"].as_str().unwrap().contains("already in use"),
        "{state}"
    );
    // Stop puts it away.
    run.manager.stop_server("web").unwrap();
    assert_eq!(window.view()["states"]["web"]["status"], "stopped");
}

#[test]
fn an_unchanged_view_sends_nothing() {
    let run = run();
    run.manager.save_config(server(&run, "web")).unwrap();
    let window = Window::open(&run, "a");
    publish_services(run.app.handle());
    run.manager.stop_server("web").unwrap();
    assert!(window.sink.frames().is_empty());
}

/// Nobody polls: traffic arrives while a server runs, and the poller ends with
/// the last one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn traffic_arrives_by_itself_while_a_server_runs() {
    let run = run();
    let mut config = server(&run, "web");
    config.http_auth = None;
    run.manager.save_config(config).unwrap();
    let window = Window::open(&run, "a");
    tokio::task::block_in_place(|| run.manager.start_server("web")).unwrap();
    let addr = run.manager.local_addr_of("web").expect("listens");
    let sent = || window.view()["states"]["web"]["stats"]["totalConnections"].clone();
    assert_eq!(sent(), 0);
    let client = tokio::net::TcpStream::connect(addr).await.unwrap();
    client.writable().await.unwrap();
    client
        .try_write(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while sent() == 0 {
        assert!(Instant::now() < deadline, "no traffic: {}", window.view());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(matches!(
        window.sink.frames().last(),
        Some(ProjectionFrame::Diff(_))
    ));
    assert!(run.manager.is_polling());
    run.manager.stop_server("web").unwrap();
    let frames = window.sink.frames().len();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(window.sink.frames().len(), frames, "quiet when stopped");
    assert!(!run.manager.is_polling(), "nothing left to publish");
}
