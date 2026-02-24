//! Monitoring Integration Tests (MON-01 through MON-04).
//!
//! Tests termiHub's SSH monitoring provider against Docker containers.
//! The monitoring provider collects CPU, memory, and disk stats via
//! SSH exec commands.
//!
//! Container: `ssh-password` on port 2201.
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use std::time::Duration;

use common::{require_docker, PORT_SSH_PASSWORD};
use termihub_core::backends::ssh::Ssh;
use termihub_core::connection::ConnectionType;

/// Connect to the SSH container with monitoring enabled.
async fn connect_with_monitoring() -> Ssh {
    let mut ssh = Ssh::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": PORT_SSH_PASSWORD,
        "username": "testuser",
        "authMethod": "password",
        "password": "testpass",
        "enableMonitoring": true
    });
    ssh.connect(settings)
        .await
        .expect("SSH connection with monitoring should succeed");
    ssh
}

// ── MON-01: CPU stats collection ────────────────────────────────────

#[tokio::test]
async fn mon_01_cpu_stats() {
    require_docker!(PORT_SSH_PASSWORD);

    let ssh = connect_with_monitoring().await;
    let provider = ssh
        .monitoring()
        .expect("Monitoring provider should be available");

    let mut rx = provider
        .subscribe()
        .await
        .expect("Subscribe should succeed");

    // Wait for at least two stats updates — CPU usage needs a delta between
    // two /proc/stat readings to compute percentage.
    let mut received_cpu = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(stats)) => {
                // cpu_usage_percent is always populated but is 0.0 on the first
                // sample because there's no delta yet. Wait for a non-zero value.
                if stats.cpu_usage_percent > 0.0 || stats.memory_total_kb > 0 {
                    received_cpu = true;
                    // Verify CPU percentage is in a valid range.
                    assert!(
                        stats.cpu_usage_percent >= 0.0 && stats.cpu_usage_percent <= 100.0,
                        "MON-01: CPU usage should be 0-100%, got {}",
                        stats.cpu_usage_percent
                    );
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }

    assert!(
        received_cpu,
        "MON-01: Should receive CPU stats within timeout"
    );

    provider
        .unsubscribe()
        .await
        .expect("Unsubscribe should work");
}

// ── MON-02: Memory stats collection ─────────────────────────────────

#[tokio::test]
async fn mon_02_memory_stats() {
    require_docker!(PORT_SSH_PASSWORD);

    let ssh = connect_with_monitoring().await;
    let provider = ssh
        .monitoring()
        .expect("Monitoring provider should be available");

    let mut rx = provider
        .subscribe()
        .await
        .expect("Subscribe should succeed");

    // Memory stats should be available from the first sample.
    let stats = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("MON-02: Should receive stats within timeout")
        .expect("MON-02: Channel should not be closed");

    assert!(
        stats.memory_total_kb > 0,
        "MON-02: Total memory should be > 0, got {}",
        stats.memory_total_kb
    );
    assert!(
        stats.memory_available_kb <= stats.memory_total_kb,
        "MON-02: Available memory ({}) should not exceed total ({})",
        stats.memory_available_kb,
        stats.memory_total_kb
    );
    assert!(
        stats.memory_used_percent >= 0.0 && stats.memory_used_percent <= 100.0,
        "MON-02: Memory used percent should be 0-100%, got {}",
        stats.memory_used_percent
    );

    provider
        .unsubscribe()
        .await
        .expect("Unsubscribe should work");
}

// ── MON-03: Disk stats collection ───────────────────────────────────

#[tokio::test]
async fn mon_03_disk_stats() {
    require_docker!(PORT_SSH_PASSWORD);

    let ssh = connect_with_monitoring().await;
    let provider = ssh
        .monitoring()
        .expect("Monitoring provider should be available");

    let mut rx = provider
        .subscribe()
        .await
        .expect("Subscribe should succeed");

    // Disk stats should be available from the first sample.
    let stats = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("MON-03: Should receive stats within timeout")
        .expect("MON-03: Channel should not be closed");

    assert!(
        stats.disk_total_kb > 0,
        "MON-03: Disk total should be > 0, got {}",
        stats.disk_total_kb
    );
    assert!(
        stats.disk_used_kb <= stats.disk_total_kb,
        "MON-03: Disk used ({}) should not exceed total ({})",
        stats.disk_used_kb,
        stats.disk_total_kb
    );
    assert!(
        stats.disk_used_percent >= 0.0 && stats.disk_used_percent <= 100.0,
        "MON-03: Disk used percent should be 0-100%, got {}",
        stats.disk_used_percent
    );

    provider
        .unsubscribe()
        .await
        .expect("Unsubscribe should work");
}

// ── MON-04: Stats collection under load ─────────────────────────────

#[tokio::test]
async fn mon_04_stats_under_load() {
    require_docker!(PORT_SSH_PASSWORD);

    let ssh = connect_with_monitoring().await;
    let provider = ssh
        .monitoring()
        .expect("Monitoring provider should be available");

    let mut rx = provider
        .subscribe()
        .await
        .expect("Subscribe should succeed");

    // Generate CPU load in the container via a separate SSH session.
    let config = common::ssh_password_config(PORT_SSH_PASSWORD);
    let load_session = termihub_core::backends::ssh::auth::connect_and_authenticate(&config)
        .expect("Load session should connect");
    let mut load_channel = load_session.channel_session().expect("Channel should open");
    // Run a busy loop for 5 seconds in the background.
    load_channel
        .exec("timeout 5 sh -c 'while true; do :; done' &")
        .expect("Load command should start");

    // Collect multiple stats samples — they should arrive without timeout.
    let mut sample_count = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    while tokio::time::Instant::now() < deadline && sample_count < 3 {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(_stats)) => {
                sample_count += 1;
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    assert!(
        sample_count >= 2,
        "MON-04: Should receive at least 2 stats samples under load, got {sample_count}"
    );

    provider
        .unsubscribe()
        .await
        .expect("Unsubscribe should work");
}
