//! Deleting a **running** embedded server stops it and closes its listen port
//! (#1393, #4012).
//!
//! The confirmation dialog is covered in
//! `EmbeddedServerSidebar.delete.test.tsx`; these tests cover what happens once
//! the user confirms: [`EmbeddedServerManager::delete_config`] hands the
//! desktop-hosted service to [`remove_local_service`], which must shut the real
//! listener down so nothing keeps serving on the port.

use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use super::{remove_local_service, EmbeddedServerService};
use crate::embedded_servers::config::{EmbeddedServerConfig, ServerType};

/// How long a stopped listener may take to release its port.
const CLOSE_DEADLINE: Duration = Duration::from_secs(5);

fn config(id: &str, server_type: ServerType, root: &std::path::Path) -> EmbeddedServerConfig {
    EmbeddedServerConfig {
        id: id.to_string(),
        name: format!("{id} server"),
        server_type,
        root_directory: root.to_string_lossy().into_owned(),
        bind_host: "127.0.0.1".to_string(),
        // Port 0: the OS picks a free port; `local_addr` reports it.
        port: 0,
        auto_start: false,
        read_only: true,
        directory_listing: Some(true),
        ftp_auth: None,
        http_auth: None,
        max_transfer_bytes: None,
        max_concurrent_sessions: None,
        extra: Default::default(),
    }
}

/// Start a real server and return the services map holding it plus its address.
fn running(
    id: &str,
    server_type: ServerType,
    root: &std::path::Path,
) -> (HashMap<String, EmbeddedServerService>, SocketAddr) {
    let mut service = EmbeddedServerService::new(server_type.clone());
    service
        .start_with(config(id, server_type, root))
        .expect("server starts on an OS-assigned port");
    let addr = service
        .local_addr()
        .expect("a running server has an address");
    assert!(service.is_live());
    assert!(
        TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok(),
        "the running server accepts connections on {addr}"
    );
    let mut services = HashMap::new();
    services.insert(id.to_string(), service);
    (services, addr)
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
fn deleting_a_running_http_server_closes_its_port() {
    let root = tempfile::tempdir().unwrap();
    let (mut services, addr) = running("web", ServerType::Http, root.path());

    assert!(remove_local_service(&mut services, "web"));

    assert!(
        services.is_empty(),
        "the deleted server is no longer listed"
    );
    assert_port_closes(addr);
}

#[test]
fn deleting_a_running_ftp_server_closes_its_port() {
    let root = tempfile::tempdir().unwrap();
    let (mut services, addr) = running("files", ServerType::Ftp, root.path());

    assert!(remove_local_service(&mut services, "files"));

    assert_port_closes(addr);
}

#[test]
fn deleting_one_server_leaves_the_others_running() {
    let root = tempfile::tempdir().unwrap();
    let (mut services, deleted) = running("a", ServerType::Http, root.path());
    let (others, kept) = running("b", ServerType::Http, root.path());
    services.extend(others);

    assert!(remove_local_service(&mut services, "a"));

    assert_port_closes(deleted);
    assert!(services["b"].is_live());
    assert!(
        TcpStream::connect_timeout(&kept, Duration::from_secs(2)).is_ok(),
        "the other server keeps serving on {kept}"
    );
    assert!(remove_local_service(&mut services, "b"));
    assert_port_closes(kept);
}

#[test]
fn deleting_a_stopped_or_unknown_server_is_harmless() {
    let mut services = HashMap::new();
    services.insert(
        "never-started".to_string(),
        EmbeddedServerService::new(ServerType::Http),
    );

    assert!(remove_local_service(&mut services, "never-started"));
    assert!(!remove_local_service(&mut services, "missing"));
    assert!(services.is_empty());
}
