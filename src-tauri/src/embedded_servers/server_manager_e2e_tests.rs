//! [`EmbeddedServerManager::delete_config`] end to end on a mock Tauri runtime
//! (#4053, following #1393 / #4012).
//!
//! The manager is generic over the Tauri runtime, so these tests build the real
//! manager on `tauri::test::mock_app()` with its config directory pointed at a
//! temp dir via [`ConfigDirOverride`], start real HTTP/FTP listeners through
//! [`EmbeddedServerManager::start_server`], and delete them through the public
//! API — checking the port closes, the config leaves `embedded_servers.json`,
//! its passwords leave the credential store, and other servers keep running.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::test::{mock_app, MockRuntime};
use tauri::Manager;

use super::EmbeddedServerManager;
use crate::embedded_servers::config::EmbeddedServerConfig;
use crate::embedded_servers::secrets::tests::{ftp, http, FakeStore, UNLOCKED};
use crate::embedded_servers::secrets::{credential_key, AuthSlot};
use crate::utils::config_paths::ConfigDirOverride;

/// How long a stopped listener may take to release its port.
const CLOSE_DEADLINE: Duration = Duration::from_secs(5);

/// A manager on the mock runtime, persisting under `config_dir`.
struct Harness {
    manager: EmbeddedServerManager<MockRuntime>,
    store: Arc<FakeStore>,
    config_file: std::path::PathBuf,
    // Keeps the mock app (and its managed state) alive for the manager.
    _app: tauri::App<MockRuntime>,
}

fn harness(config_dir: &Path) -> Harness {
    let app = mock_app();
    app.manage(ConfigDirOverride(config_dir.to_path_buf()));
    let store = FakeStore::new(UNLOCKED);
    let manager = EmbeddedServerManager::new(app.handle(), store.clone())
        .expect("manager builds on the mock runtime");
    Harness {
        manager,
        store,
        config_file: config_dir.join("embedded_servers.json"),
        _app: app,
    }
}

/// A config served from `root` on an OS-assigned loopback port.
fn on_free_port(mut config: EmbeddedServerConfig, root: &Path) -> EmbeddedServerConfig {
    config.port = 0;
    config.root_directory = root.to_string_lossy().into_owned();
    config
}

impl Harness {
    /// Save `config`, start it, and return the address it listens on.
    fn save_and_start(&self, config: EmbeddedServerConfig) -> SocketAddr {
        let id = config.id.clone();
        self.manager.save_config(config).expect("config saves");
        self.manager.start_server(&id).expect("server starts");
        let addr = self
            .manager
            .services
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|service| service.local_addr())
            .expect("a running desktop-hosted server has an address");
        assert!(
            TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok(),
            "the running server accepts connections on {addr}"
        );
        addr
    }

    /// Server ids currently written to `embedded_servers.json`.
    fn persisted_ids(&self) -> Vec<String> {
        let raw = std::fs::read_to_string(&self.config_file).expect("config file exists");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("config file is JSON");
        json["servers"]
            .as_array()
            .expect("servers array")
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn has_secret(&self, id: &str, slot: AuthSlot) -> bool {
        self.store.raw(&credential_key(id, slot)).is_some()
    }
}

/// Wait until nothing accepts on `addr` **and** the port can be bound again.
fn assert_port_closes(addr: SocketAddr) {
    let deadline = Instant::now() + CLOSE_DEADLINE;
    loop {
        let refused = TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err();
        if refused && TcpListener::bind(addr).is_ok() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "port {addr} still open {CLOSE_DEADLINE:?} after the server was deleted"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn deleting_a_running_http_server_closes_its_port_and_forgets_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path());
    let addr = h.save_and_start(on_free_port(http("web", "s3cret"), root.path()));
    assert_eq!(h.persisted_ids(), ["web"]);
    assert!(h.has_secret("web", AuthSlot::HttpBasic));

    h.manager.delete_config("web").expect("delete succeeds");

    assert_port_closes(addr);
    assert!(h.persisted_ids().is_empty(), "config left the file");
    assert!(h.manager.get_configs().unwrap().is_empty());
    assert!(h.manager.get_states().unwrap().is_empty());
    assert!(
        !h.has_secret("web", AuthSlot::HttpBasic),
        "password forgotten"
    );
}

#[test]
fn deleting_a_running_ftp_server_closes_its_port_and_forgets_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path());
    let addr = h.save_and_start(on_free_port(ftp("files", "hunter2"), root.path()));
    assert!(h.has_secret("files", AuthSlot::FtpLogin));

    h.manager.delete_config("files").expect("delete succeeds");

    assert_port_closes(addr);
    assert!(h.persisted_ids().is_empty(), "config left the file");
    assert!(
        !h.has_secret("files", AuthSlot::FtpLogin),
        "password forgotten"
    );
}

#[test]
fn deleting_one_running_server_leaves_the_others_running() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = harness(dir.path());
    let deleted = h.save_and_start(on_free_port(http("a", "pa"), root.path()));
    let kept_http = h.save_and_start(on_free_port(http("b", "pb"), root.path()));
    let kept_ftp = h.save_and_start(on_free_port(ftp("c", "pc"), root.path()));

    h.manager.delete_config("a").expect("delete succeeds");

    assert_port_closes(deleted);
    for addr in [kept_http, kept_ftp] {
        assert!(
            TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok(),
            "the other server keeps serving on {addr}"
        );
    }
    assert_eq!(h.persisted_ids(), ["b", "c"]);
    assert!(h.has_secret("b", AuthSlot::HttpBasic));
    assert!(h.has_secret("c", AuthSlot::FtpLogin));

    h.manager.stop_all();
    assert_port_closes(kept_http);
    assert_port_closes(kept_ftp);
}

#[test]
fn a_restarted_manager_does_not_bring_a_deleted_server_back() {
    let dir = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    {
        let h = harness(dir.path());
        h.save_and_start(on_free_port(http("gone", "x"), root.path()));
        h.save_and_start(on_free_port(http("stays", "y"), root.path()));
        h.manager.delete_config("gone").expect("delete succeeds");
        h.manager.stop_all();
    }

    let reopened = harness(dir.path());
    let ids: Vec<String> = reopened
        .manager
        .get_configs()
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, ["stays"]);
}
