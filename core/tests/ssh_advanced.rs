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

#[test]
fn ssh_jump_01_two_hop_proxy_jump() {
    require_docker!(PORT_SSH_BASTION);

    // Step 1: Connect to the bastion host.
    let bastion_config = ssh_key_config(PORT_SSH_BASTION, "ed25519");
    let bastion_session = connect_and_authenticate(&bastion_config)
        .expect("SSH-JUMP-01: Bastion connection should succeed");

    assert!(bastion_session.authenticated());

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
    .expect("SSH-JUMP-01: SSH through bastion to target should succeed");

    assert!(
        output.contains("JUMPHOST_TARGET_REACHED"),
        "SSH-JUMP-01: Expected marker 'JUMPHOST_TARGET_REACHED', got: {output}"
    );

    // Step 3: Also verify direct-tcpip channel creation works
    // (this is the underlying mechanism for ProxyJump).
    let _channel = bastion_session
        .channel_direct_tcpip("termihub-ssh-target", 22, None)
        .expect("SSH-JUMP-01: Direct-tcpip channel to target should succeed");
}

// ── SSH-SHELL-01: Restricted shell (rbash) ───────────────────────────

#[test]
fn ssh_shell_01_restricted_shell() {
    require_docker!(PORT_SSH_RESTRICTED);

    let config = ssh_password_config(PORT_SSH_RESTRICTED);
    let session = connect_and_authenticate(&config)
        .expect("SSH-SHELL-01: Restricted shell connection should succeed");

    assert!(session.authenticated());

    // In rbash, `cd` should fail because changing directories is restricted.
    let output =
        ssh_exec(&session, "cd /tmp 2>&1; echo EXIT_CODE=$?").expect("Command should execute");

    // rbash should reject the cd command.
    assert!(
        output.contains("restricted") || output.contains("EXIT_CODE=1"),
        "SSH-SHELL-01: 'cd /tmp' should fail in restricted shell, got: {output}"
    );
}

// ── SSH-SHELL-02: Unrestricted comparison ────────────────────────────

#[test]
fn ssh_shell_02_unrestricted_shell() {
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

    let session = connect_and_authenticate(&config)
        .expect("SSH-SHELL-02: Unrestricted shell connection should succeed");

    assert!(session.authenticated());

    // freeuser should be able to cd freely.
    let output = ssh_exec(&session, "cd /tmp && pwd").expect("Command should execute");
    assert!(
        output.trim().contains("/tmp"),
        "SSH-SHELL-02: 'cd /tmp' should succeed for freeuser, got: {output}"
    );
}

// ── SSH-TUNNEL-01: Local port forward (HTTP) ─────────────────────────

#[test]
fn ssh_tunnel_01_local_forward_http() {
    require_docker!(PORT_SSH_TUNNEL);

    let config = ssh_password_config(PORT_SSH_TUNNEL);
    let session =
        connect_and_authenticate(&config).expect("SSH-TUNNEL-01: Tunnel connection should succeed");

    assert!(session.authenticated());

    // Open a direct-tcpip channel to the internal HTTP server (port 8080).
    let mut channel = session
        .channel_direct_tcpip("127.0.0.1", 8080, None)
        .expect("SSH-TUNNEL-01: Direct-tcpip to HTTP should succeed");

    // Send an HTTP request through the tunnel.
    use std::io::{Read, Write};
    channel
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .expect("HTTP request write should succeed");
    channel.flush().expect("Flush should succeed");

    // Read the response.
    let mut response = String::new();
    channel
        .read_to_string(&mut response)
        .expect("HTTP response read should succeed");

    assert!(
        response.contains("TUNNEL_TEST_OK"),
        "SSH-TUNNEL-01: HTTP response should contain 'TUNNEL_TEST_OK', got: {response}"
    );
}

// ── SSH-TUNNEL-02: TCP echo via tunnel ───────────────────────────────

#[test]
fn ssh_tunnel_02_tcp_echo_via_tunnel() {
    require_docker!(PORT_SSH_TUNNEL);

    let config = ssh_password_config(PORT_SSH_TUNNEL);
    let session =
        connect_and_authenticate(&config).expect("SSH-TUNNEL-02: Tunnel connection should succeed");

    assert!(session.authenticated());

    // Open a direct-tcpip channel to the internal echo server (port 9090).
    let mut channel = session
        .channel_direct_tcpip("127.0.0.1", 9090, None)
        .expect("SSH-TUNNEL-02: Direct-tcpip to echo should succeed");

    // Send test data through the tunnel.
    use std::io::{Read, Write};
    let test_data = b"ECHO_TEST_12345\n";
    channel
        .write_all(test_data)
        .expect("Echo write should succeed");
    channel.flush().expect("Flush should succeed");

    // Read back the echoed data.
    let mut buf = vec![0u8; 256];
    // Use a short timeout — the echo server should respond immediately.
    session.set_blocking(true);
    let n = channel.read(&mut buf).expect("Echo read should succeed");

    let response = String::from_utf8_lossy(&buf[..n]);
    assert!(
        response.contains("ECHO_TEST_12345"),
        "SSH-TUNNEL-02: Echo should return test data, got: {response}"
    );
}
