//! Network Resilience Integration Tests (NET-FAULT-01 through NET-FAULT-10).
//!
//! Tests termiHub's SSH backend under adverse network conditions by
//! injecting faults (latency, packet loss, throttling, disconnect)
//! via the `network-fault-proxy` container.
//!
//! Container: `network-fault-proxy` on port 2209 (Docker Compose `fault` profile).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml --profile fault up -d`
//! Skips gracefully if containers are not running.
//!
//! **IMPORTANT**: These tests must run single-threaded (`--test-threads=1`)
//! because they modify shared container state via `docker exec`.

mod common;

use std::time::{Duration, Instant};

use common::{
    apply_fault, require_docker, ssh_exec, ssh_password_config, FaultGuard, PORT_NETWORK_FAULT,
};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── NET-FAULT-01: 500ms latency ─────────────────────────────────────

#[test]
fn net_fault_01_high_latency() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    // Establish baseline connection.
    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 500ms latency.
    apply_fault(&["apply-latency", "500ms"]).expect("Fault injection should succeed");

    // Measure round-trip time for a command.
    let start = Instant::now();
    let output = ssh_exec(&session, "echo NET_FAULT_01_OK").expect("Command should succeed");
    let rtt = start.elapsed();

    assert!(
        output.contains("NET_FAULT_01_OK"),
        "NET-FAULT-01: Command output should be correct"
    );
    assert!(
        rtt >= Duration::from_millis(300),
        "NET-FAULT-01: RTT should reflect latency ({rtt:?})"
    );
}

// ── NET-FAULT-02: 2000ms extreme latency ────────────────────────────

#[test]
fn net_fault_02_extreme_latency() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 2000ms latency.
    apply_fault(&["apply-latency", "2000ms"]).expect("Fault injection should succeed");

    let start = Instant::now();
    let output = ssh_exec(&session, "echo NET_FAULT_02_OK").expect("Command should still succeed");
    let rtt = start.elapsed();

    assert!(
        output.contains("NET_FAULT_02_OK"),
        "NET-FAULT-02: Command should produce output despite latency"
    );
    assert!(
        rtt >= Duration::from_millis(1500),
        "NET-FAULT-02: RTT should reflect 2s latency ({rtt:?})"
    );
}

// ── NET-FAULT-03: 10% packet loss ───────────────────────────────────

#[test]
fn net_fault_03_moderate_packet_loss() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 10% packet loss.
    apply_fault(&["apply-loss", "10%"]).expect("Fault injection should succeed");

    // SSH/TCP should handle retransmissions — the command should still succeed.
    let output =
        ssh_exec(&session, "echo NET_FAULT_03_OK").expect("Command should succeed despite loss");

    assert!(
        output.contains("NET_FAULT_03_OK"),
        "NET-FAULT-03: SSH should recover from 10% packet loss"
    );
}

// ── NET-FAULT-04: 50% severe packet loss ────────────────────────────

#[test]
fn net_fault_04_severe_packet_loss() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 50% packet loss — severe but SSH/TCP should still cope.
    apply_fault(&["apply-loss", "50%"]).expect("Fault injection should succeed");

    // This may take a while due to retransmissions, but should eventually succeed.
    let result = ssh_exec(&session, "echo NET_FAULT_04_OK");

    // With 50% loss, the command might fail or succeed very slowly.
    // Either outcome is acceptable — the important thing is no crash/hang.
    match result {
        Ok(output) => {
            assert!(
                output.contains("NET_FAULT_04_OK"),
                "NET-FAULT-04: Output should be correct if command succeeds"
            );
        }
        Err(_) => {
            // Command failed due to severe packet loss — acceptable degradation.
        }
    }
}

// ── NET-FAULT-05: 56kbps bandwidth throttle ─────────────────────────

#[test]
fn net_fault_05_dialup_throttle() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 56kbps throttle.
    apply_fault(&["apply-throttle", "56kbit"]).expect("Fault injection should succeed");

    // A simple command should still work, just slower.
    let output = ssh_exec(&session, "echo NET_FAULT_05_OK")
        .expect("Command should succeed at low bandwidth");

    assert!(
        output.contains("NET_FAULT_05_OK"),
        "NET-FAULT-05: Command should produce correct output at 56kbps"
    );
}

// ── NET-FAULT-06: 1Mbps bandwidth throttle ──────────────────────────

#[test]
fn net_fault_06_1mbps_throttle() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 1Mbps throttle.
    apply_fault(&["apply-throttle", "1mbit"]).expect("Fault injection should succeed");

    let output =
        ssh_exec(&session, "echo NET_FAULT_06_OK").expect("Command should succeed at 1Mbps");

    assert!(
        output.contains("NET_FAULT_06_OK"),
        "NET-FAULT-06: Normal operation with slight delay"
    );
}

// ── NET-FAULT-07: Full disconnect (100% loss) ───────────────────────

#[test]
fn net_fault_07_full_disconnect() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 100% packet loss — total disconnect.
    apply_fault(&["apply-disconnect"]).expect("Fault injection should succeed");

    // Attempting a command should fail or timeout.
    // Set a short timeout on the session to avoid hanging.
    session.set_timeout(5000);
    let result = ssh_exec(&session, "echo NET_FAULT_07_OK");

    assert!(
        result.is_err(),
        "NET-FAULT-07: Command should fail during full disconnect"
    );
}

// ── NET-FAULT-08: Disconnect + recovery ─────────────────────────────

#[test]
fn net_fault_08_disconnect_and_recovery() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    // Establish connection.
    let config = ssh_password_config(PORT_NETWORK_FAULT);

    // Inject disconnect.
    apply_fault(&["apply-disconnect"]).expect("Disconnect should succeed");

    // Wait briefly, then reset faults.
    std::thread::sleep(Duration::from_secs(1));
    apply_fault(&["reset-faults"]).expect("Reset should succeed");

    // A new connection should succeed after recovery.
    let session = connect_and_authenticate(&config)
        .expect("NET-FAULT-08: Reconnection after recovery should succeed");

    let output =
        ssh_exec(&session, "echo NET_FAULT_08_OK").expect("Command after recovery should work");
    assert!(
        output.contains("NET_FAULT_08_OK"),
        "NET-FAULT-08: Post-recovery command should produce output"
    );
}

// ── NET-FAULT-09: Jitter simulation ─────────────────────────────────

#[test]
fn net_fault_09_jitter() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject jitter: 200ms base ± 100ms variation.
    apply_fault(&["apply-jitter", "200ms", "100ms"]).expect("Jitter injection should succeed");

    // Session should remain stable despite variable latency.
    let output =
        ssh_exec(&session, "echo NET_FAULT_09_OK").expect("Command should succeed despite jitter");

    assert!(
        output.contains("NET_FAULT_09_OK"),
        "NET-FAULT-09: Session should be stable under jitter"
    );
}

// ── NET-FAULT-10: Packet corruption ─────────────────────────────────

#[test]
fn net_fault_10_packet_corruption() {
    require_docker!(PORT_NETWORK_FAULT);
    let _guard = FaultGuard::new();

    let config = ssh_password_config(PORT_NETWORK_FAULT);
    let session = connect_and_authenticate(&config).expect("Baseline connection should succeed");

    // Inject 5% packet corruption.
    apply_fault(&["apply-corrupt", "5%"]).expect("Corruption injection should succeed");

    // SSH has integrity checks — corrupted packets should be retransmitted.
    let result = ssh_exec(&session, "echo NET_FAULT_10_OK");

    // Either succeeds (SSH handled retransmission) or fails gracefully.
    match result {
        Ok(output) => {
            assert!(
                output.contains("NET_FAULT_10_OK"),
                "NET-FAULT-10: Output should be correct if SSH recovers"
            );
        }
        Err(_) => {
            // SSH detected corruption and the connection was reset — acceptable.
        }
    }
}
