#![cfg(feature = "ssh")]
//! Local (`ssh -L`) forward integration tests against the `ssh-tunnel-target`
//! container (port 2207: internal HTTP on 8080, TCP echo on 9090, neither
//! exposed to the host — reachable only through an SSH tunnel).
//!
//! These exercise the shared [`LocalForwarder`] engine
//! (`termihub_core::tunnel`) end to end over a real SSH connection — the exact
//! data path an **agent-hosted** tunnel runs (S3, #2185): the agent calls
//! `connect_and_authenticate` then `LocalForwarder::start`, binds its listen
//! socket, and relays each connection over `channel_open_direct_tcpip`. Proving
//! it here proves the agent forwards real traffic; the agent's `tunnel.*` RPC
//! is a thin JSON wrapper over this path (unit-tested separately).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d
//! ssh-tunnel-target`. Skips gracefully when the container is not running.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{port_ssh_tunnel, require_docker, ssh_password_config};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::tunnel::config::LocalForwardConfig;
use termihub_core::tunnel::local_forward::LocalForwarder;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Reserve an ephemeral loopback port, then release it so the forwarder can bind
/// it. A small TOCTOU window exists but is harmless for a test.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral")
        .local_addr()
        .expect("local addr")
        .port()
}

/// A local (`-L`) forward to the SSH server's own internal HTTP service (8080)
/// relays a real HTTP request/response — proving the data path forwards traffic
/// that is otherwise unreachable from the host.
#[tokio::test]
async fn local_forward_relays_http_over_ssh() {
    require_docker!(port_ssh_tunnel());

    let config = ssh_password_config(port_ssh_tunnel());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("SSH connect to ssh-tunnel-target should succeed");

    let listen_port = free_port();
    let forward = LocalForwardConfig {
        local_host: "127.0.0.1".to_string(),
        local_port: listen_port,
        // Resolved from the SSH server's network — the internal HTTP service.
        remote_host: "localhost".to_string(),
        remote_port: 8080,
    };
    let _forwarder =
        LocalForwarder::start(&forward, Arc::new(session)).expect("bind local forwarder");

    // Connect to the forwarded listen socket and speak HTTP/1.0 to the internal
    // server through the tunnel.
    let mut client = TcpStream::connect(("127.0.0.1", listen_port))
        .await
        .expect("connect to the forwarded port");
    client
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .expect("send HTTP request through tunnel");
    client.shutdown().await.ok();

    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut response))
        .await
        .expect("HTTP response should arrive before timeout")
        .expect("read HTTP response");

    let text = String::from_utf8_lossy(&response);
    assert!(
        text.starts_with("HTTP/"),
        "expected an HTTP status line from the internal server through the tunnel, got: {text:?}"
    );
}

/// After the forwarder is dropped its listen socket stops accepting, so no
/// forward outlives the tunnel.
#[tokio::test]
async fn local_forward_stops_on_teardown() {
    require_docker!(port_ssh_tunnel());

    let config = ssh_password_config(port_ssh_tunnel());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("SSH connect to ssh-tunnel-target should succeed");

    let listen_port = free_port();
    let forward = LocalForwardConfig {
        local_host: "127.0.0.1".to_string(),
        local_port: listen_port,
        remote_host: "localhost".to_string(),
        remote_port: 8080,
    };
    let forwarder =
        LocalForwarder::start(&forward, Arc::new(session)).expect("bind local forwarder");

    TcpStream::connect(("127.0.0.1", listen_port))
        .await
        .expect("accepts while active");

    drop(forwarder);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        match TcpStream::connect(("127.0.0.1", listen_port)).await {
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => break,
            _ if tokio::time::Instant::now() >= deadline => {
                panic!("listener still accepting after teardown")
            }
            _ => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
}
