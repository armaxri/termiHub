#![cfg(feature = "ssh")]
//! SSH Advanced Integration Tests.
//!
//! Tests termiHub's SSH backend for advanced scenarios:
//! - SSH-JUMP-01: 2-hop ProxyJump via bastion (port 2204 → internal target)
//! - SSH-JUMP-06: a hung intermediate hop times out within its per-hop budget
//! - SSH-JUMP-07: two sessions reconnect through ONE new shared gateway after the
//!   bastion container is stopped and restarted (MT-SSH-44, #3688)
//! - SSH-SHELL-01/02: Restricted shell (rbash) on port 2205
//! - SSH-TUNNEL-01/02: Port forwarding through SSH tunnel on port 2207
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.
//!
//! **IMPORTANT**: The SSH-JUMP-* tests all reach their target through the single
//! shared `termihub-ssh-bastion` fixture. Running them concurrently opens many
//! unauthenticated SSH handshakes against that one sshd at once, which trips its
//! `MaxStartups` back-pressure and randomly drops connections — surfacing as
//! intermittent `SFTP init failed: Timeout` or `SSH handshake failed: Disconnected`
//! that move between tests under load (#1026). They are serialized in-source with
//! `#[serial(ssh_bastion)]`, which keeps the suite parallel-safe regardless of
//! `--test-threads`. The rbash and tunnel tests use their own fixtures and are left
//! parallel.

mod common;

use common::{
    port_ssh_bastion, port_ssh_restricted, port_ssh_tunnel, require_docker, ssh_exec,
    ssh_key_config, ssh_keys_dir, ssh_password_config,
};
use serial_test::serial;
use std::time::Duration;
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::jump_host::connect_through_jump_hosts;
use termihub_core::backends::ssh::Ssh;
use termihub_core::config::{JumpHostConfig, SshConfig};
use termihub_core::connection::ConnectionType;

// ── SSH-JUMP-01: ProxyJump through a bastion to an internal target ─────

/// Drive termiHub's own jump-host connect path end-to-end: connect to the
/// internal target (`ssh-jumphost-target`, reachable *only* via the bastion on
/// the isolated `jumphost-net`) by configuring a one-hop `proxy_jump` chain
/// through the bastion (published on port 2204). A successful, authenticated
/// session on the target — which has no host port — proves the hop forwarded
/// the SSH handshake correctly, replacing the earlier `ssh`-shell-out
/// reachability check (#872).
#[tokio::test]
#[serial(ssh_bastion)]
async fn ssh_jump_01_two_hop_proxy_jump() {
    require_docker!(port_ssh_bastion());

    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();

    // Target on jumphost-net, reached via a single ProxyJump hop (the bastion).
    let target = SshConfig {
        host: "ssh-jumphost-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        proxy_jump: vec![JumpHostConfig {
            host: "127.0.0.1".to_string(),
            port: port_ssh_bastion(),
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
    let bastion_config = ssh_key_config(port_ssh_bastion(), "ed25519");
    let (bastion_session, _) = connect_and_authenticate(&bastion_config)
        .await
        .expect("SSH-JUMP-01: Bastion connection should succeed");
    let _channel = bastion_session
        .channel_open_direct_tcpip("ssh-jumphost-target", 22, "localhost", 0)
        .await
        .expect("SSH-JUMP-01: Direct-tcpip channel to target should succeed");
}

// ── SSH-JUMP-02: multi-hop (2-hop) ProxyJump chain ───────────────────

/// Exercise the N-hop chain in `connect_through_jump_hosts` end-to-end. There is
/// only one bastion fixture, so the second hop re-enters the bastion via its
/// docker-network name (`ssh-jumphost-bastion:22`) before the final hop to the
/// target — `127.0.0.1:2204` → `ssh-jumphost-bastion:22` → `ssh-jumphost-target:22`.
/// This drives the full loop (direct first hop, then two channel-tunnelled hops)
/// without needing a second internal bastion container.
#[tokio::test]
#[serial(ssh_bastion)]
async fn ssh_jump_02_multi_hop_proxy_jump() {
    require_docker!(port_ssh_bastion());

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
        host: "ssh-jumphost-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        // Outermost → innermost: enter the bastion from the host, hop to the
        // bastion again over the docker network, then on to the target.
        proxy_jump: vec![
            inline_hop("127.0.0.1", port_ssh_bastion()),
            inline_hop("ssh-jumphost-bastion", 22),
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

// ── SSH-JUMP-06: a hung intermediate hop times out within its budget ──

/// A blackholed *intermediate* hop must fail the whole chain within that hop's
/// per-hop connect timeout — naming the offending hop — instead of hanging until
/// the OS TCP timeout (#938/#950). Where the fast unit tests bound `run_hop_step`
/// in isolation, this drives a *real* two-hop chain end-to-end: the first hop is
/// the reachable bastion, and the second hop targets a black-holed address behind
/// it.
///
/// The black-holed address is `192.0.2.1` (RFC 5737 TEST-NET-1, guaranteed
/// non-routable). The bastion has a default route, so its `direct-tcpip` connect
/// to that address is sent and silently dropped — the channel-open never
/// confirms — exactly the "hung intermediate hop" shape #938 added the per-hop
/// timeout for. The hop carries a short `connect_timeout_secs` (the #951 per-hop
/// override), so the connect aborts in ~2 s, well under the multi-minute OS TCP
/// timeout that would otherwise apply.
#[tokio::test]
#[serial(ssh_bastion)]
async fn ssh_jump_06_hung_intermediate_hop_times_out() {
    require_docker!(port_ssh_bastion());

    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();

    const HOP_TIMEOUT_SECS: u64 = 2;
    // Comfortably above the per-hop budget (to tolerate scheduling/build slack)
    // but far below the multi-minute OS TCP timeout a missing per-hop bound would
    // incur — the whole point of the assertion.
    const MAX_ELAPSED_SECS: u64 = 30;

    let target = SshConfig {
        host: "ssh-jumphost-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        // Outermost → innermost: the real bastion (reachable), then a black-holed
        // intermediate hop that accepts no connection. The chain never reaches the
        // target; it must fail at the second hop within its timeout.
        proxy_jump: vec![
            JumpHostConfig {
                host: "127.0.0.1".to_string(),
                port: port_ssh_bastion(),
                username: "testuser".to_string(),
                auth_method: "key".to_string(),
                key_path: Some(key.clone()),
                ..Default::default()
            },
            JumpHostConfig {
                host: "192.0.2.1".to_string(),
                port: 22,
                username: "testuser".to_string(),
                auth_method: "key".to_string(),
                key_path: Some(key),
                connect_timeout_secs: Some(HOP_TIMEOUT_SECS),
                ..Default::default()
            },
        ],
        ..Default::default()
    };

    let start = std::time::Instant::now();
    let result = connect_through_jump_hosts(&target).await;
    let elapsed = start.elapsed();

    // `JumpHostConnection` is not `Debug`, so match rather than `expect_err`.
    let msg = match result {
        Ok(_) => panic!("SSH-JUMP-06: a black-holed intermediate hop must fail the chain"),
        Err(err) => err.to_string(),
    };
    assert!(
        msg.contains("timed out"),
        "SSH-JUMP-06: error should report a timeout, got: {msg}"
    );
    // The chain is `[hop 1 (bastion), hop 2 (192.0.2.1:22)]`; the failure must
    // name the offending second hop, not the reachable bastion.
    assert!(
        msg.contains("hop 2") && msg.contains("192.0.2.1"),
        "SSH-JUMP-06: error should name the offending hop, got: {msg}"
    );
    assert!(
        elapsed < Duration::from_secs(MAX_ELAPSED_SECS),
        "SSH-JUMP-06: connect should abort within the per-hop budget, took {elapsed:?}"
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
#[serial(ssh_bastion)]
async fn ssh_jump_03_shared_gateway_session_pooling() {
    use termihub_core::backends::ssh::jump_host::{
        connect_target_through_pooled_gateway, gateway_pool_key,
    };
    use termihub_core::backends::ssh::session_pool::shared_gateway_pool;

    require_docker!(port_ssh_bastion());

    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();

    let target = SshConfig {
        host: "ssh-jumphost-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        proxy_jump: vec![JumpHostConfig {
            // Unique connection_id so this test's gateway gets its own pool key,
            // isolated from the other jump-host tests that share the process-wide
            // pool through the same bastion (they would otherwise contend the same
            // ref-counted entry when run in parallel).
            connection_id: Some("ssh-jump-03-pool-test".to_string()),
            host: "127.0.0.1".to_string(),
            port: port_ssh_bastion(),
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
    let (session_a, _registry_a, gateway_a) = connect_target_through_pooled_gateway(&target, None)
        .await
        .expect("SSH-JUMP-03: first pooled connection should succeed");
    assert_eq!(
        pool.ref_count(&pool_key),
        1,
        "SSH-JUMP-03: first connection should hold one gateway reference"
    );

    // Second connection through the same bastion: reuses the pooled gateway.
    let (session_b, _registry_b, gateway_b) = connect_target_through_pooled_gateway(&target, None)
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
    require_docker!(port_ssh_restricted());

    let config = ssh_password_config(port_ssh_restricted());
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
    require_docker!(port_ssh_restricted());

    // Connect as freeuser who has an unrestricted shell.
    let config = termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port: port_ssh_restricted(),
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
    require_docker!(port_ssh_tunnel());

    let config = ssh_password_config(port_ssh_tunnel());
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
    require_docker!(port_ssh_tunnel());

    let config = ssh_password_config(port_ssh_tunnel());
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
        "host": "ssh-jumphost-target",
        "port": 22,
        "username": "testuser",
        "authMethod": "key",
        "keyPath": key,
        "enableMonitoring": enable_monitoring,
        "enableFileBrowser": enable_file_browser,
        "proxyJump": [{
            "host": "127.0.0.1",
            "port": port_ssh_bastion(),
            "username": "testuser",
            "authMethod": "key",
            "keyPath": key,
        }],
    })
}

/// SSH-JUMP-04: the **SFTP file browser** must reach a jump-host target through
/// the bastion. The target (`ssh-jumphost-target`) has no host port and is only
/// reachable via the bastion, so listing its filesystem proves the SFTP session
/// was tunnelled through the gateway rather than attempting a (failing) direct
/// connection (#939).
#[tokio::test]
#[serial(ssh_bastion)]
async fn ssh_jump_04_sftp_through_jump_host() {
    require_docker!(port_ssh_bastion());

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
#[serial(ssh_bastion)]
async fn ssh_jump_05_monitoring_through_jump_host() {
    require_docker!(port_ssh_bastion());

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
        .expect("SSH-JUMP-05: monitoring subscribe should succeed")
        .stats;

    let stats = tokio::time::timeout(Duration::from_secs(20), rx.recv())
        .await
        .expect("SSH-JUMP-05: a monitoring sample should arrive through the jump host within 20s")
        .expect("SSH-JUMP-05: monitoring channel should yield a sample");

    assert!(
        !stats.hostname.is_empty() || stats.memory_total_kb > 0,
        "SSH-JUMP-05: expected a populated stats sample, got: {stats:?}"
    );
}

// ── SSH-JUMP-07: reconnect through a restarted bastion (MT-SSH-44, #3688) ──

/// The pool key both SSH-JUMP-07 sessions share. A dedicated `connectionId`
/// keeps this test's gateway entry apart from the other jump tests' entries.
const JUMP_07_GATEWAY_ID: &str = "ssh-jump-07-reconnect-test";

/// The bastion container of this checkout (`<project>-ssh-bastion`).
fn bastion_container() -> String {
    common::fixture_container("ssh-bastion")
}

/// Settings for a terminal session on the internal target through the bastion,
/// with the hop pinned to [`JUMP_07_GATEWAY_ID`] and no side providers, so the
/// only gateway references are the two terminals'.
fn jump_07_settings() -> serde_json::Value {
    let mut settings = jump_host_target_settings(false, false);
    settings["proxyJump"][0]["connectionId"] = serde_json::json!(JUMP_07_GATEWAY_ID);
    settings
}

/// Number of authenticated SSH sessions the bastion's sshd is serving right now.
///
/// OpenSSH 9.6 runs one `sshd: <user> [priv]` monitor per authenticated
/// connection. A target session rides a `direct-tcpip` channel on the gateway,
/// so it adds no process here: the count is the number of gateway sessions.
/// The image has no `ps`, so read `/proc` directly.
fn bastion_gateway_sessions() -> usize {
    let out = common::docker_cli(&[
        "exec",
        &bastion_container(),
        "sh",
        "-c",
        "for p in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$p\"; echo; done 2>/dev/null",
    ])
    .expect("SSH-JUMP-07: listing the bastion's processes should succeed");
    out.lines()
        .filter(|l| l.trim_start().starts_with("sshd: testuser [priv]"))
        .count()
}

/// Poll until the bastion serves exactly `expected` gateway sessions.
async fn wait_for_gateway_sessions(expected: usize, why: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let now = bastion_gateway_sessions();
        if now == expected {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "SSH-JUMP-07: {why}: expected {expected} gateway session(s) on the bastion, got {now}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Starts the bastion on drop and waits until it accepts connections again, so
/// a stopped bastion never outlives this test — also when an assertion fails.
struct RestartBastionOnDrop;

impl Drop for RestartBastionOnDrop {
    fn drop(&mut self) {
        let _ = common::docker_cli(&["start", &bastion_container()]);
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !common::is_port_reachable("127.0.0.1", port_ssh_bastion())
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

/// Wait until the restarted bastion completes a key-authenticated login.
async fn wait_for_bastion_login() {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let config = ssh_key_config(port_ssh_bastion(), "ed25519");
    loop {
        if common::is_port_reachable("127.0.0.1", port_ssh_bastion())
            && connect_and_authenticate(&config).await.is_ok()
        {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "SSH-JUMP-07: the bastion did not accept logins again within 60s"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Wait until a terminal session reports it is no longer connected.
async fn wait_for_disconnect(ssh: &Ssh, label: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while ssh.is_connected() {
        assert!(
            std::time::Instant::now() < deadline,
            "SSH-JUMP-07: session {label} must notice the bastion going down within 30s"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Run `echo` in a connected terminal and wait for its output, proving the
/// session is live end to end through the gateway.
async fn assert_terminal_echoes(ssh: &Ssh, label: &str) {
    let marker = format!("JUMP07_{label}_OK");
    let mut rx = ssh.subscribe_output();
    // Quote part of the word so the echoed command line never matches the
    // marker; only the command's output does.
    ssh.write(format!("echo JUMP07_{label}_'OK'\n").as_bytes())
        .unwrap_or_else(|e| panic!("SSH-JUMP-07: write to session {label} failed: {e}"));
    let mut seen = String::new();
    let found = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(chunk) = rx.recv().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if seen.contains(&marker) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(
        found,
        "SSH-JUMP-07: session {label} should echo through the gateway, got: {seen:?}"
    );
}

/// MT-SSH-44: two terminals reach the target through one shared bastion
/// gateway. The bastion is stopped and restarted; both terminals notice the
/// drop, and reconnecting them re-establishes the chain through **one new**
/// shared gateway session — not one per terminal, and not the dead old one.
///
/// The reconnects run concurrently while the dead sessions are still held (as
/// two tabs auto-reconnecting at once would), so the pool must evict the dead
/// gateway, dial a single replacement for both (single-flight), and ignore the
/// stale references when the dead sessions are finally released (#1315).
/// The bastion's own process table confirms the single gateway session.
#[tokio::test]
#[serial(ssh_bastion)]
async fn ssh_jump_07_reconnect_through_restarted_bastion_shares_one_new_gateway() {
    use termihub_core::backends::ssh::session_pool::shared_gateway_pool;

    require_docker!(port_ssh_bastion());

    let pool = shared_gateway_pool();
    let pool_key = format!("gateway|id:{JUMP_07_GATEWAY_ID}");
    assert_eq!(
        pool.ref_count(&pool_key),
        0,
        "SSH-JUMP-07: pool must start empty"
    );
    wait_for_gateway_sessions(0, "before connecting").await;

    // Two tabs through the bastion share one gateway.
    let mut old_a = Ssh::new();
    old_a
        .connect(jump_07_settings())
        .await
        .expect("SSH-JUMP-07: first connection should succeed");
    let mut old_b = Ssh::new();
    old_b
        .connect(jump_07_settings())
        .await
        .expect("SSH-JUMP-07: second connection should succeed");
    assert_eq!(
        pool.ref_count(&pool_key),
        2,
        "SSH-JUMP-07: both tabs must share one pooled gateway"
    );
    wait_for_gateway_sessions(1, "two tabs before the drop").await;
    assert_terminal_echoes(&old_a, "A").await;
    assert_terminal_echoes(&old_b, "B").await;

    // Drop the bastion. Both tabs must notice.
    let restore = RestartBastionOnDrop;
    common::docker_cli(&["stop", "-t", "1", &bastion_container()])
        .expect("SSH-JUMP-07: stopping the bastion should succeed");
    wait_for_disconnect(&old_a, "A").await;
    wait_for_disconnect(&old_b, "B").await;

    // Reconnecting while the bastion is down fails, and leaves no pool entry
    // behind that a later reconnect could adopt.
    let mut early = Ssh::new();
    assert!(
        early.connect(jump_07_settings()).await.is_err(),
        "SSH-JUMP-07: connecting through a stopped bastion must fail"
    );

    // Restore the bastion.
    common::docker_cli(&["start", &bastion_container()])
        .expect("SSH-JUMP-07: starting the bastion should succeed");
    drop(restore);
    wait_for_bastion_login().await;
    wait_for_gateway_sessions(0, "after the readiness probe").await;

    // Both tabs reconnect at once while the dead sessions are still held.
    let mut new_a = Ssh::new();
    let mut new_b = Ssh::new();
    let (res_a, res_b) = tokio::join!(
        new_a.connect(jump_07_settings()),
        new_b.connect(jump_07_settings())
    );
    res_a.expect("SSH-JUMP-07: tab A should reconnect through the restarted bastion");
    res_b.expect("SSH-JUMP-07: tab B should reconnect through the restarted bastion");
    assert!(new_a.is_connected() && new_b.is_connected());
    assert_eq!(
        pool.ref_count(&pool_key),
        2,
        "SSH-JUMP-07: both reconnected tabs must share the one new gateway"
    );
    wait_for_gateway_sessions(1, "two reconnected tabs").await;
    assert_terminal_echoes(&new_a, "A2").await;
    assert_terminal_echoes(&new_b, "B2").await;

    // Releasing the dead sessions must not touch the new gateway's refcount.
    old_a.disconnect().await.expect("disconnect old A");
    old_b.disconnect().await.expect("disconnect old B");
    drop(old_a);
    drop(old_b);
    assert_eq!(
        pool.ref_count(&pool_key),
        2,
        "SSH-JUMP-07: releasing the dead sessions must not release the new gateway"
    );
    assert_terminal_echoes(&new_a, "A3").await;

    // The new gateway drains once both reconnected tabs close.
    new_a.disconnect().await.expect("disconnect new A");
    drop(new_a);
    assert_eq!(pool.ref_count(&pool_key), 1);
    assert_terminal_echoes(&new_b, "B3").await;
    new_b.disconnect().await.expect("disconnect new B");
    drop(new_b);
    assert_eq!(
        pool.ref_count(&pool_key),
        0,
        "SSH-JUMP-07: the gateway must drain once both tabs close"
    );
    wait_for_gateway_sessions(0, "after both tabs closed").await;
}
