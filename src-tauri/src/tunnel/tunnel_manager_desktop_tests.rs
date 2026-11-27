//! A tunnel started on this computer against SSH servers that do not answer
//! (#6139): a start ends on its own, says why, and a Stop ends it at once.

use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::test::{mock_app, MockRuntime};
use tauri::Manager;

use super::{LoadedTunnels, TunnelManager};
use crate::app_tasks::AppTasks;
use crate::commands::projection::ProjectionState;
use crate::connection::manager::ConnectionManager;
use crate::connection::recording_credential_store::RecordingStore;
use crate::session::manager::SessionManager;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::test_support::agent_rpc::FakeAgent;
use crate::tunnel::config::{TunnelState, TunnelStatus};
use crate::tunnel::projection::TUNNELS_REGION;
use crate::utils::config_paths::ConfigDirOverride;

/// How an SSH server on loopback behaves.
enum Server {
    /// Nothing listens on the port.
    Refuses,
    /// Accepts the TCP connection and never says a word.
    Silent,
    /// Accepts and closes at once.
    Closes,
}

/// The port of a loopback server that behaves like `server`, and what keeps it
/// alive.
fn serve(server: Server) -> (u16, Option<std::thread::JoinHandle<()>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    match server {
        Server::Refuses => {
            drop(listener);
            (port, None)
        }
        Server::Silent => {
            let held: Arc<Mutex<Vec<TcpStream>>> = Arc::default();
            let thread = std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    held.lock().unwrap().push(stream);
                }
            });
            (port, Some(thread))
        }
        Server::Closes => {
            let thread = std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    drop(stream);
                }
            });
            (port, Some(thread))
        }
    }
}

struct Run {
    app: tauri::App<MockRuntime>,
    manager: Arc<TunnelManager<MockRuntime>>,
    _dir: tempfile::TempDir,
}

/// An app with tunnel "web" on this computer over SSH connection "ssh" to
/// `127.0.0.1:port`, whose connect may take `timeout_secs`.
fn boot(port: u16, timeout_secs: u64) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let tunnel = json!({
        "id": "web", "name": "web", "sshConnectionId": "ssh",
        "host": {"kind": "thisComputer"},
        "tunnelType": {"type": "local", "config": {"localHost": "127.0.0.1", "localPort": 0,
                       "remoteHost": "127.0.0.1", "remotePort": 80}},
    });
    let doc = json!({"version": "1", "tunnels": [tunnel]});
    std::fs::write(dir.path().join("tunnels.json"), doc.to_string()).unwrap();
    let app = mock_app();
    let tasks = AppTasks::new();
    tasks.cancellation_token().cancel();
    app.manage(tasks);
    app.manage(ProjectionState::new());
    app.manage(ConfigDirOverride(dir.path().to_path_buf()));
    let client: Arc<dyn AgentRpcClient> = Arc::new(FakeAgent::session_host());
    let connections =
        ConnectionManager::new_for_test(dir.path(), Arc::new(RecordingStore::default())).unwrap();
    let ssh: crate::connection::config::SavedConnection = serde_json::from_value(json!({
        "id": "ssh", "name": "ssh", "folderId": null,
        "config": {"type": "ssh", "config": {"host": "127.0.0.1", "port": port,
                   "username": "u", "authMethod": "agent",
                   "connectTimeoutSecs": timeout_secs}},
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
        _dir: dir,
    }
}

impl Run {
    fn row(&self) -> TunnelState {
        let states = self.manager.get_statuses().unwrap();
        states.into_iter().find(|s| s.tunnel_id == "web").unwrap()
    }

    /// The status the UI was last sent for the tunnel: the published region,
    /// which is all the UI sees.
    fn shown(&self) -> String {
        let projection = self.app.state::<ProjectionState>();
        let view = projection.projector.snapshot(TUNNELS_REGION).view;
        view["states"]["web"]["status"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    /// Start on another thread, as the `tunnel.start` intent does; the join
    /// handle yields what the start returned and how long it took.
    fn start(&self) -> std::thread::JoinHandle<(Result<(), String>, Duration)> {
        let manager = self.manager.clone();
        let handle = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let _runtime = handle.enter();
            let started = Instant::now();
            let result = manager.start_tunnel("web").map_err(|e| e.to_string());
            (result, started.elapsed())
        })
    }

    #[track_caller]
    fn becomes(&self, status: TunnelStatus, within: Duration) -> TunnelState {
        let deadline = Instant::now() + within;
        loop {
            let row = self.row();
            if row.status == status {
                return row;
            }
            assert!(
                Instant::now() < deadline,
                "not {status:?} in {within:?}: {row:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_that_refuses_ends_the_start_with_who_refused() {
    let (port, _server) = serve(Server::Refuses);
    let run = boot(port, 30);
    let (result, took) = run.start().join().unwrap();
    assert!(result.is_err(), "{result:?}");
    assert!(took < Duration::from_secs(10), "took {took:?}");
    let row = run.becomes(TunnelStatus::Error, Duration::from_secs(1));
    let said = row.error.unwrap_or_default();
    assert!(said.contains("ssh refused the connection"), "{said:?}");
    assert_eq!(run.shown(), "error", "what the UI was last sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_ends_a_start_on_a_server_that_never_answers() {
    let (port, _server) = serve(Server::Silent);
    let run = boot(port, 60);
    let start = run.start();
    run.becomes(TunnelStatus::Connecting, Duration::from_secs(5));
    let stopped = Instant::now();
    run.manager.stop_tunnel("web").unwrap();
    run.becomes(TunnelStatus::Disconnected, Duration::from_secs(2));
    let (_, _) = start.join().unwrap();
    assert!(
        stopped.elapsed() < Duration::from_secs(3),
        "the start ran on {:?} after the stop",
        stopped.elapsed()
    );
    assert!(run.manager.active_tunnels.lock().unwrap().is_empty());
    assert_eq!(run.shown(), "disconnected", "what the UI was last sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_on_a_server_that_never_answers_ends_at_its_timeout() {
    let (port, _server) = serve(Server::Silent);
    let run = boot(port, 1);
    let (result, took) = run.start().join().unwrap();
    assert!(result.is_err(), "{result:?}");
    assert!(took < Duration::from_secs(5), "took {took:?}");
    let row = run.becomes(TunnelStatus::Error, Duration::from_secs(1));
    let said = row.error.unwrap_or_default();
    assert!(said.contains("ssh"), "{said:?}");
    assert_eq!(run.shown(), "error", "what the UI was last sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_that_closes_at_once_ends_the_start_with_a_reason() {
    let (port, _server) = serve(Server::Closes);
    let run = boot(port, 30);
    let (result, took) = run.start().join().unwrap();
    assert!(result.is_err(), "{result:?}");
    assert!(took < Duration::from_secs(10), "took {took:?}");
    let row = run.becomes(TunnelStatus::Error, Duration::from_secs(1));
    assert!(!row.error.unwrap_or_default().is_empty());
    assert_eq!(run.shown(), "error", "what the UI was last sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_on_a_failed_tunnel_dismisses_its_failure_in_the_ui() {
    let (port, _server) = serve(Server::Refuses);
    let run = boot(port, 30);
    let _ = run.start().join().unwrap();
    run.becomes(TunnelStatus::Error, Duration::from_secs(1));
    run.manager.stop_tunnel("web").unwrap();
    assert_eq!(run.row().status, TunnelStatus::Disconnected);
    assert_eq!(run.shown(), "disconnected", "what the UI was last sent");
}
