#![cfg(feature = "ssh")]
//! SSH Advanced Integration Tests.
//!
//! Tests termiHub's SSH backend for advanced scenarios:
//! - SSH-JUMP-01: 2-hop ProxyJump via bastion (port 2204 → internal target)
//! - SSH-SHELL-01/02: Restricted shell (rbash) on port 2205
//! - SSH-TUNNEL-01/02: Port forwarding through SSH tunnel on port 2207
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{
    require_docker, ssh_exec, ssh_key_config, ssh_keys_dir, ssh_password_config, PORT_SSH_BASTION,
    PORT_SSH_RESTRICTED, PORT_SSH_TUNNEL,
};
use std::time::Duration;
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::jump_host::connect_through_jump_hosts;
use termihub_core::backends::ssh::Ssh;
use termihub_core::config::{JumpHostConfig, SshConfig};
use termihub_core::connection::ConnectionType;

// ── SSH-JUMP-01: ProxyJump through a bastion to an internal target ─────

/// Drive termiHub's own jump-host connect path end-to-end: connect to the
/// internal target (`termihub-ssh-target`, reachable *only* via the bastion on
/// the isolated `jumphost-net`) by configuring a one-hop `proxy_jump` chain
/// through the bastion (published on port 2204). A successful, authenticated
/// session on the target — which has no host port — proves the hop forwarded
/// the SSH handshake correctly, replacing the earlier `ssh`-shell-out
/// reachability check (#872).
#[tokio::test]
async fn ssh_jump_01_two_hop_proxy_jump() {
    require_docker!(PORT_SSH_BASTION);

    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();

    // Target on jumphost-net, reached via a single ProxyJump hop (the bastion).
    let target = SshConfig {
        host: "termihub-ssh-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        proxy_jump: vec![JumpHostConfig {
            host: "127.0.0.1".to_string(),
            port: PORT_SSH_BASTION,
            username: "testuser".to_string(),
            auth_method: "key".to_string(),
            key_path: Some(key),
            ..Default::default()
        }],
        ..Default::default()
    };

    // Step 1: Connect to the target *through* the jump host using termiHub's
    // own ProxyJump implementation.
    let conn = connect_through_jump_hosts(&target)
        .await
        .expect("SSH-JUMP-01: jump-host connection to target should succeed");

    // Step 2: Read the target's marker over the jumped session. The target is
    // unreachable except through the bastion, so reading it confirms the chain
    // landed on the right host.
    let output = ssh_exec(&conn.session, "cat /home/testuser/marker.txt")
        .await
        .expect("SSH-JUMP-01: exec on target via jump host should succeed");
    assert!(
        output.contains("JUMPHOST_TARGET_REACHED"),
        "SSH-JUMP-01: Expected marker 'JUMPHOST_TARGET_REACHED', got: {output}"
    );

    // Step 3: Low-level regression guard — the `channel_open_direct_tcpip`
    // primitive the jump path is built on still works directly on the bastion.
    let bastion_config = ssh_key_config(PORT_SSH_BASTION, "ed25519");
    let (bastion_session, _) = connect_and_authenticate(&bastion_config)
        .await
        .expect("SSH-JUMP-01: Bastion connection should succeed");
    let _channel = bastion_session
        .channel_open_direct_tcpip("termihub-ssh-target", 22, "localhost", 0)
        .await
        .expect("SSH-JUMP-01: Direct-tcpip channel to target should succeed");
}

// ── SSH-JUMP-02: multi-hop (2-hop) ProxyJump chain ───────────────────

/// Exercise the N-hop chain in `connect_through_jump_hosts` end-to-end. There is
/// only one bastion fixture, so the second hop re-enters the bastion via its
/// docker-network name (`termihub-ssh-bastion:22`) before the final hop to the
/// target — `127.0.0.1:2204` → `termihub-ssh-bastion:22` → `termihub-ssh-target:22`.
/// This drives the full loop (direct first hop, then two channel-tunnelled hops)
/// without needing a second internal bastion container.
#[tokio::test]
async fn ssh_jump_02_multi_hop_proxy_jump() {
    require_docker!(PORT_SSH_BASTION);

    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();

    let inline_hop = |host: &str, port: u16| JumpHostConfig {
        host: host.to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        ..Default::default()
    };

    let target = SshConfig {
        host: "termihub-ssh-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        // Outermost → innermost: enter the bastion from the host, hop to the
        // bastion again over the docker network, then on to the target.
        proxy_jump: vec![
            inline_hop("127.0.0.1", PORT_SSH_BASTION),
            inline_hop("termihub-ssh-bastion", 22),
        ],
        ..Default::default()
    };

    let conn = connect_through_jump_hosts(&target)
        .await
        .expect("SSH-JUMP-02: 2-hop jump-host connection should succeed");

    // One intermediate session per hop is retained to hold the chain open.
    assert_eq!(
        conn.intermediates.len(),
        2,
        "SSH-JUMP-02: expected two retained intermediate hop sessions"
    );

    let output = ssh_exec(&conn.session, "cat /home/testuser/marker.txt")
        .await
        .expect("SSH-JUMP-02: exec on target via 2-hop chain should succeed");
    assert!(
        output.contains("JUMPHOST_TARGET_REACHED"),
        "SSH-JUMP-02: Expected marker 'JUMPHOST_TARGET_REACHED', got: {output}"
    );
}

// ── SSH-JUMP-03: shared gateway-session pooling (#924) ───────────────

/// Two connections that reach their target through the same bastion must share a
/// single, reference-counted gateway session, and the pool must drain once the
/// last reference is released.
///
/// Drives the pooled connect path (`connect_target_through_pooled_gateway`) used
/// by terminals and tunnels: connecting twice through the same one-hop chain
/// yields the *same* `SshGateway` (ref_count 2), and dropping both references
/// removes the entry from the shared pool.
#[tokio::test]
async fn ssh_jump_03_shared_gateway_session_pooling() {
    use termihub_core::backends::ssh::jump_host::{
        connect_target_through_pooled_gateway, gateway_pool_key,
    };
    use termihub_core::backends::ssh::session_pool::shared_gateway_pool;

    require_docker!(PORT_SSH_BASTION);

    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();

    let target = SshConfig {
        host: "termihub-ssh-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        proxy_jump: vec![JumpHostConfig {
            host: "127.0.0.1".to_string(),
            port: PORT_SSH_BASTION,
            username: "testuser".to_string(),
            auth_method: "key".to_string(),
            key_path: Some(key),
            ..Default::default()
        }],
        ..Default::default()
    };

    let pool = shared_gateway_pool();
    let pool_key = gateway_pool_key(&target.proxy_jump);
    assert_eq!(
        pool.ref_count(&pool_key),
        0,
        "SSH-JUMP-03: gateway must not be pooled before any connection"
    );

    // First connection: creates and pools the gateway session.
    let (session_a, _registry_a, gateway_a) = connect_target_through_pooled_gateway(&target)
        .await
        .expect("SSH-JUMP-03: first pooled connection should succeed");
    assert_eq!(
        pool.ref_count(&pool_key),
        1,
        "SSH-JUMP-03: first connection should hold one gateway reference"
    );

    // Second connection through the same bastion: reuses the pooled gateway.
    let (session_b, _registry_b, gateway_b) = connect_target_through_pooled_gateway(&target)
        .await
        .expect("SSH-JUMP-03: second pooled connection should succeed");
    assert_eq!(
        pool.ref_count(&pool_key),
        2,
        "SSH-JUMP-03: both connections must share one gateway (ref_count 2)"
    );
    assert!(
        std::sync::Arc::ptr_eq(&gateway_a, &gateway_b),
        "SSH-JUMP-03: both connections must reuse the same gateway session"
    );

    // Both independent target sessions are usable over the shared gateway.
    for (label, session) in [("A", &session_a), ("B", &session_b)] {
        let output = ssh_exec(session, "cat /home/testuser/marker.txt")
            .await
            .unwrap_or_else(|e| panic!("SSH-JUMP-03: exec on target {label} should succeed: {e}"));
        assert!(
            output.contains("JUMPHOST_TARGET_REACHED"),
            "SSH-JUMP-03: target {label} should be reachable via shared gateway, got: {output}"
        );
    }

    // Releasing one reference keeps the gateway alive for the other.
    drop(gateway_a);
    drop(session_a);
    assert_eq!(
        pool.ref_count(&pool_key),
        1,
        "SSH-JUMP-03: gateway must stay pooled while a connection still uses it"
    );

    // Releasing the last reference drains the gateway from the pool.
    drop(gateway_b);
    drop(session_b);
    assert_eq!(
        pool.ref_count(&pool_key),
        0,
        "SSH-JUMP-03: gateway must drain once the last connection is released"
    );
}

// ── SSH-SHELL-01: Restricted shell (rbash) ───────────────────────────

#[tokio::test]
async fn ssh_shell_01_restricted_shell() {
    require_docker!(PORT_SSH_RESTRICTED);

    let config = ssh_password_config(PORT_SSH_RESTRICTED);
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-SHELL-01: Restricted shell connection should succeed");

    // In rbash, `cd` should fail because changing directories is restricted.
    let output = ssh_exec(&session, "cd /tmp 2>&1; echo EXIT_CODE=$?")
        .await
        .expect("Command should execute");

    // rbash should reject the cd command.
    assert!(
        output.contains("restricted") || output.contains("EXIT_CODE=1"),
        "SSH-SHELL-01: 'cd /tmp' should fail in restricted shell, got: {output}"
    );
}

// ── SSH-SHELL-02: Unrestricted comparison ────────────────────────────

#[tokio::test]
async fn ssh_shell_02_unrestricted_shell() {
    require_docker!(PORT_SSH_RESTRICTED);

    // Connect as freeuser who has an unrestricted shell.
    let config = termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port: PORT_SSH_RESTRICTED,
        username: "freeuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..Default::default()
    };

    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-SHELL-02: Unrestricted shell connection should succeed");

    // freeuser should be able to cd freely.
    let output = ssh_exec(&session, "cd /tmp && pwd")
        .await
        .expect("Command should execute");
    assert!(
        output.trim().contains("/tmp"),
        "SSH-SHELL-02: 'cd /tmp' should succeed for freeuser, got: {output}"
    );
}

// ── SSH-TUNNEL-01: Local port forward (HTTP) ─────────────────────────

#[tokio::test]
async fn ssh_tunnel_01_local_forward_http() {
    require_docker!(PORT_SSH_TUNNEL);

    let config = ssh_password_config(PORT_SSH_TUNNEL);
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-TUNNEL-01: Tunnel connection should succeed");

    // Open a direct-tcpip channel to the internal HTTP server (port 8080).
    let channel = session
        .channel_open_direct_tcpip("127.0.0.1", 8080, "localhost", 0)
        .await
        .expect("SSH-TUNNEL-01: Direct-tcpip to HTTP should succeed");

    // Send an HTTP request through the tunnel.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = channel.into_stream();
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .expect("HTTP request write should succeed");
    stream.flush().await.expect("Flush should succeed");

    // Read the full response (HTTP/1.0 server closes connection after reply).
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("HTTP response read should succeed");
    let response = String::from_utf8_lossy(&response);

    assert!(
        response.contains("TUNNEL_TEST_OK"),
        "SSH-TUNNEL-01: HTTP response should contain 'TUNNEL_TEST_OK', got: {response}"
    );
}

// ── SSH-TUNNEL-02: TCP echo via tunnel ───────────────────────────────

#[tokio::test]
async fn ssh_tunnel_02_tcp_echo_via_tunnel() {
    require_docker!(PORT_SSH_TUNNEL);

    let config = ssh_password_config(PORT_SSH_TUNNEL);
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-TUNNEL-02: Tunnel connection should succeed");

    // Open a direct-tcpip channel to the internal echo server (port 9090).
    let channel = session
        .channel_open_direct_tcpip("127.0.0.1", 9090, "localhost", 0)
        .await
        .expect("SSH-TUNNEL-02: Direct-tcpip to echo should succeed");

    // Send test data through the tunnel.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = channel.into_stream();
    let test_data = b"ECHO_TEST_12345\n";
    stream
        .write_all(test_data)
        .await
        .expect("Echo write should succeed");
    stream.flush().await.expect("Flush should succeed");

    // Read back the echoed data.
    let mut buf = vec![0u8; 256];
    let n = stream
        .read(&mut buf)
        .await
        .expect("Echo read should succeed");

    let response = String::from_utf8_lossy(&buf[..n]);
    assert!(
        response.contains("ECHO_TEST_12345"),
        "SSH-TUNNEL-02: Echo should return test data, got: {response}"
    );
}

// ── SSH-JUMP-04/05: SFTP & monitoring routed through the jump host ────

/// Build SSH connection settings for the internal target reached through the
/// bastion (the same chain as SSH-JUMP-01), toggling the SFTP file browser and
/// monitoring providers.
fn jump_host_target_settings(
    enable_monitoring: bool,
    enable_file_browser: bool,
) -> serde_json::Value {
    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8");
    serde_json::json!({
        "host": "termihub-ssh-target",
        "port": 22,
        "username": "testuser",
        "authMethod": "key",
        "keyPath": key,
        "enableMonitoring": enable_monitoring,
        "enableFileBrowser": enable_file_browser,
        "proxyJump": [{
            "host": "127.0.0.1",
            "port": PORT_SSH_BASTION,
            "username": "testuser",
            "authMethod": "key",
            "keyPath": key,
        }],
    })
}

/// SSH-JUMP-04: the **SFTP file browser** must reach a jump-host target through
/// the bastion. The target (`termihub-ssh-target`) has no host port and is only
/// reachable via the bastion, so listing its filesystem proves the SFTP session
/// was tunnelled through the gateway rather than attempting a (failing) direct
/// connection (#939).
#[tokio::test]
async fn ssh_jump_04_sftp_through_jump_host() {
    require_docker!(PORT_SSH_BASTION);

    let mut ssh = Ssh::new();
    ssh.connect(jump_host_target_settings(false, true))
        .await
        .expect("SSH-JUMP-04: jump-host connection should succeed");

    let browser = ssh
        .file_browser()
        .expect("SSH-JUMP-04: file browser should be available");
    let entries = browser
        .list_dir("/home/testuser")
        .await
        .expect("SSH-JUMP-04: listing the target home through the jump host should succeed");

    assert!(
        entries.iter().any(|e| e.name == "marker.txt"),
        "SSH-JUMP-04: expected marker.txt in the target's home, got: {:?}",
        entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>()
    );
}

/// SSH-JUMP-05: **monitoring** must reach a jump-host target through the bastion.
/// The monitoring task connects its own SSH session; for a jump-host target a
/// direct connect would fail silently and yield no samples, so receiving a stats
/// sample proves the monitoring session was routed through the gateway (#939).
#[tokio::test]
async fn ssh_jump_05_monitoring_through_jump_host() {
    require_docker!(PORT_SSH_BASTION);

    let mut ssh = Ssh::new();
    ssh.connect(jump_host_target_settings(true, false))
        .await
        .expect("SSH-JUMP-05: jump-host connection should succeed");

    let monitoring = ssh
        .monitoring()
        .expect("SSH-JUMP-05: monitoring should be available");
    let mut rx = monitoring
        .subscribe()
        .await
        .expect("SSH-JUMP-05: monitoring subscribe should succeed");

    let stats = tokio::time::timeout(Duration::from_secs(20), rx.recv())
        .await
        .expect("SSH-JUMP-05: a monitoring sample should arrive through the jump host within 20s")
        .expect("SSH-JUMP-05: monitoring channel should yield a sample");

    assert!(
        !stats.hostname.is_empty() || stats.memory_total_kb > 0,
        "SSH-JUMP-05: expected a populated stats sample, got: {stats:?}"
    );
}
