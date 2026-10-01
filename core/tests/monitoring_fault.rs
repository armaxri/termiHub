#![cfg(feature = "ssh")]
//! Monitoring fault injection against a live SSH host (#1230, #4006).
//!
//! The collector loop's `Live → Stale → Reconnecting → Live` campaign is
//! unit-tested with a fake transport in `core/src/backends/ssh/monitoring.rs`.
//! This test drives the real SSH monitoring provider against a real sshd and
//! takes the host away mid-stream with `docker pause` — the process freeze a
//! hung or unreachable host looks like: collects time out, the loop reports
//! `Stale` (reason: transport), starts re-dialling (`Reconnecting`), and once
//! the host is unpaused it re-establishes and reports `Live` again.
//!
//! The monitored host is the `network-fault-proxy` container (Docker Compose
//! `fault` profile, port 2209), which exists to be disturbed, so pausing it
//! never interferes with another suite's fixture. A drop guard unpauses it
//! even when an assertion fails. Serialized with the other `network_fault`
//! users via `#[serial(network_fault)]`.
//!
//! The terminal `Offline` arm (reconnect budget exhausted, ~3 minutes with the
//! production backoff) stays covered by the fake-transport unit test
//! `collect_loop_emits_offline_when_reconnect_exhausted`.
//!
//! ```bash
//! docker compose -f tests/docker/docker-compose.yml --profile fault up -d --wait network-fault-proxy
//! cargo test -p termihub-core --features ssh --test monitoring_fault -- --nocapture
//! ```

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{docker_cli, fixture_container, port_network_fault, require_docker};
use serial_test::serial;
use termihub_core::backends::ssh::Ssh;
use termihub_core::connection::ConnectionType;
use termihub_core::monitoring::{MonitorStatus, MonitorStatusReason, MonitorStatusUpdate};

/// The paused host's container for this checkout.
fn fault_container() -> String {
    fixture_container("network-fault")
}

/// Unpauses the fault container on drop, so a frozen fixture never outlives
/// the test — also when an assertion panics.
struct UnpauseOnDrop;

impl Drop for UnpauseOnDrop {
    fn drop(&mut self) {
        let _ = docker_cli(&["unpause", &fault_container()]);
    }
}

/// Every status update the loop emitted, in order.
type Statuses = Arc<Mutex<Vec<MonitorStatusUpdate>>>;

/// Wait until the loop has emitted `status` at or after index `from`, and
/// return that update's index.
async fn wait_for(
    statuses: &Statuses,
    status: MonitorStatus,
    from: usize,
    within: Duration,
) -> usize {
    let deadline = Instant::now() + within;
    loop {
        if let Some(i) = statuses
            .lock()
            .expect("lock")
            .iter()
            .skip(from)
            .position(|u| u.status == status)
        {
            return from + i;
        }
        assert!(
            Instant::now() < deadline,
            "monitoring never reported {status:?} within {within:?}; statuses: {:?}",
            statuses.lock().expect("lock")
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
#[serial(network_fault)]
async fn mon_fault_01_paused_host_goes_stale_reconnects_and_recovers() {
    require_docker!(port_network_fault());
    // A leftover pause from a crashed earlier run would fail the baseline.
    let _ = docker_cli(&["unpause", &fault_container()]);

    let mut ssh = Ssh::new();
    ssh.connect(serde_json::json!({
        "host": "127.0.0.1",
        "port": port_network_fault(),
        "username": "testuser",
        "authMethod": "password",
        "password": "testpass",
        "enableMonitoring": true,
        // A frozen host must fail each re-dial fast, not after the default.
        "connectTimeoutSecs": 5,
    }))
    .await
    .expect("SSH connection with monitoring should succeed");
    let provider = ssh.monitoring().expect("monitoring provider");
    let subscription = provider.subscribe().await.expect("subscribe");

    // Drain stats (a full stats channel would stall the loop) and record every
    // status transition.
    let mut stats = subscription.stats;
    tokio::spawn(async move { while stats.recv().await.is_some() {} });
    let statuses: Statuses = Arc::new(Mutex::new(Vec::new()));
    let recorder = statuses.clone();
    let mut status_rx = subscription.status;
    tokio::spawn(async move {
        while let Some(update) = status_rx.recv().await {
            recorder.lock().expect("lock").push(update);
        }
    });

    let live = wait_for(&statuses, MonitorStatus::Live, 0, Duration::from_secs(30)).await;

    // Freeze the host mid-stream.
    let unpause = UnpauseOnDrop;
    docker_cli(&["pause", &fault_container()]).expect("pause the monitored host");

    let stale = wait_for(
        &statuses,
        MonitorStatus::Stale,
        live,
        Duration::from_secs(60),
    )
    .await;
    let reconnecting = wait_for(
        &statuses,
        MonitorStatus::Reconnecting,
        stale,
        Duration::from_secs(30),
    )
    .await;
    {
        let seen = statuses.lock().expect("lock");
        assert_eq!(
            seen[stale].reason,
            Some(MonitorStatusReason::Transport),
            "a frozen host is a transport failure: {seen:?}"
        );
        assert!(
            seen[live + 1..reconnecting]
                .iter()
                .all(|u| u.status != MonitorStatus::Offline),
            "no Offline before the reconnect campaign: {seen:?}"
        );
    }

    // Bring the host back: the campaign re-dials and the loop is Live again.
    docker_cli(&["unpause", &fault_container()]).expect("unpause the monitored host");
    drop(unpause);
    wait_for(
        &statuses,
        MonitorStatus::Live,
        reconnecting,
        Duration::from_secs(90),
    )
    .await;
    assert!(
        statuses
            .lock()
            .expect("lock")
            .iter()
            .all(|u| u.status != MonitorStatus::Offline),
        "the host came back before the budget ran out: never Offline"
    );

    provider.unsubscribe().await.ok();
    ssh.disconnect().await.ok();
}
