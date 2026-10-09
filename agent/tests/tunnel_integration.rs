//! Agent-hosted SSH tunnel forwarding end to end (#2185, #2198) against the
//! `ssh-tunnel-target` Docker fixture: local (`-L`), remote (`-R`) and dynamic
//! (`-D`, SOCKS5) forwards driven through the real [`AgentTunnelRegistry`].
//!
//! These tests live in their own integration-test binary (#4288, TBE2-001) for
//! two reasons:
//!
//! - **A CI lane runs them.** The fixtures lane (`integration-fixtures.yml`)
//!   runs `--test tunnel_integration` with the fixture up and
//!   `TERMIHUB_REQUIRE_DOCKER=1`, so an unreachable fixture is a failure there
//!   instead of a silent skip. Without the fixture and without that variable
//!   (the per-PR gate, a plain local `cargo test`) they skip.
//! - **The trust-all verifier stays in this process.** The fixture's host key
//!   is not in `known_hosts`, so these tests register a trust-everything
//!   process-wide host-key verifier. In the agent's unit-test binary that
//!   registration would race the unattended-connect tests
//!   (`session::unattended_tests`), which need their own verifier.
//!
//! ```sh
//! docker compose -f tests/docker/docker-compose.yml up -d --wait ssh-tunnel-target
//! TERMIHUB_REQUIRE_DOCKER=1 cargo test -p termihub-agent --test tunnel_integration
//! ```

use std::sync::Arc;

use termihub_agent::tunnel::AgentTunnelRegistry;
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::host_key::{set_host_key_verifier, HostKeyInfo, HostKeyVerifier};
use termihub_core::config::SshConfig;
use termihub_core::test_fixtures;
use termihub_core::tunnel::config::{LocalForwardConfig, RemoteForwardConfig};
use termihub_core::tunnel::ReachableFrom;

/// Host port of the `ssh-tunnel-target` fixture: `TERMIHUB_TEST_SSH_TUNNEL_PORT`
/// when set, else 2207 shifted by this checkout's test-port offset (env or
/// `dev.local.json`, the same scheme as `docker-compose.yml` and core/tests).
fn tunnel_port() -> u16 {
    test_fixtures::fixture_port("TERMIHUB_TEST_SSH_TUNNEL_PORT", 2207)
}

/// The fixture's port when it accepts connections; `None` (skip) when it does
/// not. Panics instead of skipping under `TERMIHUB_REQUIRE_DOCKER=1`, so the
/// fixtures lane cannot go green without exercising the tunnel.
async fn tunnel_fixture_port() -> Option<u16> {
    let port = tunnel_port();
    let reachable = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|r| r.is_ok());
    test_fixtures::require(
        reachable,
        test_fixtures::REQUIRE_DOCKER_ENV,
        &format!("ssh-tunnel-target not reachable on 127.0.0.1:{port}"),
        "start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-tunnel-target",
    )
    .then_some(port)
}

/// Trusts every host key — the fixture's key is not in this machine's
/// `known_hosts`. Mirrors core/tests' `trust_fixture_host_keys`.
struct TrustAll;

#[async_trait::async_trait]
impl HostKeyVerifier for TrustAll {
    async fn verify(&self, _info: &HostKeyInfo) -> bool {
        true
    }
}

/// Register [`TrustAll`] as this binary's process-wide verifier. Set-once:
/// every test here registers the same policy, so a lost race is harmless; no
/// other verifier is ever registered in this process.
fn trust_fixture_host_key() {
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

/// Port parsed from a reported `host:port` / `[v6]:port` bound address.
fn reported_port(bound_address: &str) -> u16 {
    bound_address
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse().ok())
        .expect("bound_address ends in :port")
}

/// Full end-to-end start against the `ssh-tunnel-target` container (port
/// 2207: internal HTTP on 8080, unreachable from the host). Drives the real
/// agent registry — `start_local` opens the SSH session, binds on the agent,
/// and forwards — then fetches HTTP through it and stops it.
#[tokio::test]
async fn start_local_forwards_http_over_ssh() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let Some(port) = tunnel_fixture_port().await else {
        return;
    };

    trust_fixture_host_key();

    let ssh_config = SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..Default::default()
    };
    let forward = LocalForwardConfig {
        local_host: "127.0.0.1".to_string(),
        // Port 0: the forwarder binds an OS-assigned port itself and the test
        // reads it back, so no other test can take it in between (#3533).
        local_port: 0,
        remote_host: "localhost".to_string(),
        remote_port: 8080,
    };

    let registry = AgentTunnelRegistry::new();
    let outcome = registry
        .start_local("t-http", &ssh_config, &forward)
        .await
        .expect("agent-hosted local forward should start");
    assert_eq!(outcome.reachable_from, ReachableFrom::AgentOnly);
    let listen_port = reported_port(&outcome.bound_address);
    assert_ne!(listen_port, 0, "the forwarder must bind a real port");
    assert_eq!(registry.active_count().await, 1);
    assert!(registry.status("t-http").await.is_some());

    // Fetch HTTP through the agent-hosted forward.
    let mut client = TcpStream::connect(("127.0.0.1", listen_port))
        .await
        .expect("connect to the agent-bound port");
    client
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .expect("send request through agent tunnel");
    client.shutdown().await.ok();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut response))
        .await
        .expect("HTTP response before timeout")
        .expect("read HTTP response");
    assert!(
        String::from_utf8_lossy(&response).starts_with("HTTP/"),
        "expected HTTP response through the agent-hosted tunnel"
    );

    // Stopping removes the forward and frees the port.
    // Assert the listener closed via the forwarder's death signal, not by
    // probing the freed port: a concurrent test's port-0 bind may already
    // have re-taken it (#3551).
    let death = registry
        .take_death_signal("t-http")
        .await
        .expect("death signal");
    assert!(registry.stop("t-http").await);
    assert_eq!(registry.active_count().await, 0);
    tokio::time::timeout(Duration::from_secs(3), death)
        .await
        .expect("forwarder (and its listener) should end after stop")
        .expect_err("the death signal resolves by its sender dropping");
}

/// Full end-to-end start of an agent-hosted **remote** (`-R`) forward against
/// the `ssh-tunnel-target` container. The listen socket is bound on the SSH
/// server; the target is resolved from **this agent** (the tunnel host):
///
/// 1. Stand up a loopback echo server on the agent — this is the `-R` target.
/// 2. `start_remote` asks the server to listen on `127.0.0.1:0` and forward
///    back to the agent's echo server; the server picks an ephemeral port.
/// 3. Drive traffic through the server-side listener by opening a
///    `direct-tcpip` channel from a **second** SSH session to the server's
///    own `127.0.0.1:<bound_port>` — the server connects to its own forwarded
///    listener, which fans a `forwarded-tcpip` channel back to the forwarder,
///    which relays it to the agent's echo server. Bytes round-trip.
#[tokio::test]
async fn start_remote_forwards_over_ssh() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let Some(port) = tunnel_fixture_port().await else {
        return;
    };

    trust_fixture_host_key();

    // 1. A loopback echo server on the agent — the `-R` forward target.
    let echo = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind agent echo server");
    let agent_target_port = echo.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = echo.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    let ssh_config = SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..Default::default()
    };

    // 2. Ask the SSH server to bind an ephemeral loopback port and forward
    //    back to the agent's echo server.
    let forward = RemoteForwardConfig {
        remote_host: "127.0.0.1".to_string(),
        remote_port: 0,
        local_host: "127.0.0.1".to_string(),
        local_port: agent_target_port,
    };

    let registry = AgentTunnelRegistry::new();
    let outcome = registry
        .start_remote("t-remote", &ssh_config, &forward)
        .await
        .expect("agent-hosted remote forward should start");
    assert_eq!(
        outcome.reachable_from,
        ReachableFrom::SshServer,
        "an -R listen socket lives on the SSH server"
    );
    assert_eq!(registry.active_count().await, 1);
    assert!(registry.status("t-remote").await.is_some());

    let bound_port: u16 = outcome
        .bound_address
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .expect("server-bound port in bound_address");
    assert_ne!(bound_port, 0, "server must report the port it bound");

    // 3. Drive traffic: a second SSH session opens a direct-tcpip channel to
    //    the server's own forwarded listener, so the server connects into it.
    let (driver, _reg) = connect_and_authenticate(&ssh_config)
        .await
        .expect("second SSH session to drive the forwarded listener");
    let channel = driver
        .channel_open_direct_tcpip("127.0.0.1", bound_port as u32, "127.0.0.1", 0)
        .await
        .expect("open channel to the server-side forwarded listener");
    let mut stream = channel.into_stream();

    stream
        .write_all(b"ping-through-R")
        .await
        .expect("write into the forwarded channel");
    let mut echoed = [0u8; 14];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut echoed))
        .await
        .expect("echo before timeout")
        .expect("read echoed bytes");
    assert_eq!(
        &echoed, b"ping-through-R",
        "bytes should relay server -> agent target and back"
    );

    // Stopping removes the forward and the server tears down its listener.
    assert!(registry.stop("t-remote").await);
    assert_eq!(registry.active_count().await, 0);
}

/// Full end-to-end start of an agent-hosted **dynamic** (`-D`, SOCKS5)
/// forward against the `ssh-tunnel-target` container (port 2207: internal
/// HTTP on 8080, unreachable from the host). The SOCKS proxy listen socket
/// binds on the agent; the per-connection target is chosen by the SOCKS
/// client and reached from the SSH server:
///
/// 1. `start_dynamic` opens the SSH session and binds the SOCKS5 proxy on an
///    ephemeral agent loopback port.
/// 2. A SOCKS5 client negotiates no-auth and issues `CONNECT localhost:8080`
///    — the container's internal HTTP server, resolved from the **server**.
/// 3. An HTTP request flows through the proxied channel and a response comes
///    back, proving the agent-hosted SOCKS proxy reaches a server-only target.
#[tokio::test]
async fn start_dynamic_socks_forwards_http_over_ssh() {
    use std::time::Duration;
    use termihub_core::tunnel::config::DynamicForwardConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let Some(port) = tunnel_fixture_port().await else {
        return;
    };

    trust_fixture_host_key();

    let ssh_config = SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..Default::default()
    };
    let forward = DynamicForwardConfig {
        local_host: "127.0.0.1".to_string(),
        // Port 0: the forwarder binds an OS-assigned port itself and the test
        // reads it back, so no other test can take it in between (#3533).
        local_port: 0,
    };

    let registry = AgentTunnelRegistry::new();
    let outcome = registry
        .start_dynamic("t-socks", &ssh_config, &forward)
        .await
        .expect("agent-hosted dynamic forward should start");
    assert_eq!(
        outcome.reachable_from,
        ReachableFrom::AgentOnly,
        "a loopback SOCKS bind is reachable only from the agent"
    );
    let listen_port = reported_port(&outcome.bound_address);
    assert_ne!(listen_port, 0, "the forwarder must bind a real port");
    assert_eq!(registry.active_count().await, 1);

    // Drive an HTTP request through the SOCKS proxy: negotiate no-auth, then
    // `CONNECT localhost:8080` (resolved from the SSH server) and speak HTTP.
    let mut client = TcpStream::connect(("127.0.0.1", listen_port))
        .await
        .expect("connect to the agent-bound SOCKS port");
    client
        .write_all(&[0x05, 0x01, 0x00])
        .await
        .expect("send SOCKS5 no-auth greeting");
    let mut method = [0u8; 2];
    client
        .read_exact(&mut method)
        .await
        .expect("read method selection");
    assert_eq!(method, [0x05, 0x00], "server selects no-auth");

    let host = b"localhost";
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host);
    req.extend_from_slice(&8080u16.to_be_bytes());
    client
        .write_all(&req)
        .await
        .expect("send SOCKS5 CONNECT localhost:8080");
    let mut reply = [0u8; 10];
    client
        .read_exact(&mut reply)
        .await
        .expect("read SOCKS5 CONNECT reply");
    assert_eq!(reply[1], 0x00, "CONNECT should succeed through the server");

    client
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .expect("send HTTP request through the SOCKS tunnel");
    client.shutdown().await.ok();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut response))
        .await
        .expect("HTTP response before timeout")
        .expect("read HTTP response");
    assert!(
        String::from_utf8_lossy(&response).starts_with("HTTP/"),
        "expected an HTTP response proxied through the agent-hosted SOCKS tunnel"
    );

    // Stopping removes the forward and frees the SOCKS listen port.
    // Assert the listener closed via the forwarder's death signal, not by
    // probing the freed port: a concurrent test's port-0 bind may already
    // have re-taken it (#3551).
    let death = registry
        .take_death_signal("t-socks")
        .await
        .expect("death signal");
    assert!(registry.stop("t-socks").await);
    assert_eq!(registry.active_count().await, 0);
    tokio::time::timeout(Duration::from_secs(3), death)
        .await
        .expect("forwarder (and its listener) should end after stop")
        .expect_err("the death signal resolves by its sender dropping");
}
