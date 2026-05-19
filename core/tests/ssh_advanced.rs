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
    require_docker, ssh_exec, ssh_key_config, ssh_password_config, PORT_SSH_BASTION,
    PORT_SSH_RESTRICTED, PORT_SSH_TUNNEL,
};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-JUMP-01: 2-hop ProxyJump chain ───────────────────────────────

#[tokio::test]
async fn ssh_jump_01_two_hop_proxy_jump() {
    require_docker!(PORT_SSH_BASTION);

    // Step 1: Connect to the bastion host.
    let bastion_config = ssh_key_config(PORT_SSH_BASTION, "ed25519");
    let (bastion_session, _) = connect_and_authenticate(&bastion_config)
        .await
        .expect("SSH-JUMP-01: Bastion connection should succeed");

    // Step 2: Verify the bastion can reach the internal target.
    // The ssh2 crate's `set_tcp_stream` requires `AsRawFd`, which
    // `ssh2::Channel` does not implement. Instead, we verify jump host
    // connectivity by executing an SSH command through the bastion to
    // the target — this exercises the same network path that termiHub's
    // ProxyJump implementation would use.
    let output = ssh_exec(
        &bastion_session,
        "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -i /home/testuser/.ssh/ed25519 \
         testuser@termihub-ssh-target 'cat /home/testuser/marker.txt'",
    )
    .await
    .expect("SSH-JUMP-01: SSH through bastion to target should succeed");

    assert!(
        output.contains("JUMPHOST_TARGET_REACHED"),
        "SSH-JUMP-01: Expected marker 'JUMPHOST_TARGET_REACHED', got: {output}"
    );

    // Step 3: Also verify direct-tcpip channel creation works
    // (this is the underlying mechanism for ProxyJump).
    let _channel = bastion_session
        .channel_open_direct_tcpip("termihub-ssh-target", 22, "localhost", 0)
        .await
        .expect("SSH-JUMP-01: Direct-tcpip channel to target should succeed");
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
