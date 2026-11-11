//! Reaping monitoring subscriptions no client can receive (#5306).
//!
//! Every test runs on a paused clock (`start_paused`), so the grace period is
//! crossed by advancing virtual time, never by a real sleep.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;

use super::*;
use crate::monitoring::session::test_support::{stats, FakeProvider};
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::CONNECTION_MONITORING_DATA;
use crate::session::definitions::ConnectionStore;

const GRACE: Duration = ORPHAN_GRACE;
/// Comfortably less than the grace, and its complement.
const SHORT: Duration = Duration::from_secs(10);

fn manager() -> (Arc<MonitoringManager>, UnboundedReceiver<JsonRpcNotification>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!(
        "termihub-orphan-reaper-test-{}.json",
        uuid::Uuid::new_v4()
    ));
    (
        Arc::new(MonitoringManager::new(
            tx,
            Arc::new(ConnectionStore::new_temp(tmp)),
        )),
        rx,
    )
}

/// Subscribe `host` through a fresh fake provider and return it.
async fn subscribe(manager: &MonitoringManager, host: &str) -> Arc<FakeProvider> {
    let provider = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider(host, provider.clone(), Some(1000))
        .await
        .expect("subscribe");
    provider
}

/// Advance the paused clock by `by`, then let every woken task run to idle.
async fn advance(by: Duration) {
    tokio::time::sleep(by).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

async fn hosts(manager: &MonitoringManager) -> Vec<String> {
    let mut hosts: Vec<String> = manager.subscriptions.lock().await.keys().cloned().collect();
    hosts.sort();
    hosts
}

fn unsubscribes(provider: &FakeProvider) -> usize {
    provider
        .calls()
        .iter()
        .filter(|c| *c == "unsubscribe")
        .count()
}

fn data_hosts(rx: &mut UnboundedReceiver<JsonRpcNotification>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(n) = rx.try_recv() {
        let v = serde_json::to_value(&n).expect("serializable");
        if v["method"] == CONNECTION_MONITORING_DATA {
            out.push(v["params"]["host"].as_str().unwrap_or_default().to_string());
        }
    }
    out
}

#[tokio::test(start_paused = true)]
async fn reaps_after_grace_with_no_client() {
    let (manager, _rx) = manager();
    manager.client_connected();
    let provider = subscribe(&manager, "s1").await;

    manager.client_disconnected(GRACE);
    advance(GRACE - SHORT).await;
    assert_eq!(hosts(&manager).await, ["s1"], "still within the grace");
    assert!(provider.is_subscribed());

    advance(2 * SHORT).await;
    assert!(hosts(&manager).await.is_empty(), "reaped after the grace");
    assert!(!provider.is_subscribed(), "the provider's loop was stopped");
    assert_eq!(unsubscribes(&provider), 1);
}

#[tokio::test(start_paused = true)]
async fn reconnect_within_grace_keeps_the_subscription_without_a_gap() {
    let (manager, mut rx) = manager();
    manager.client_connected();
    let provider = subscribe(&manager, "s1").await;

    manager.client_disconnected(GRACE);
    advance(GRACE - SHORT).await;
    manager.client_connected();
    // Far past the first disconnect's deadline.
    advance(3 * GRACE).await;

    assert_eq!(hosts(&manager).await, ["s1"]);
    assert_eq!(unsubscribes(&provider), 0, "the collect loop never stopped");
    let subscribes = provider.calls().iter().filter(|c| *c == "subscribe").count();
    assert_eq!(subscribes, 1, "the same subscription, not a new one");

    // The reconnected client still receives the original loop's samples.
    data_hosts(&mut rx);
    provider.push(stats("s1")).await;
    advance(Duration::ZERO).await;
    assert_eq!(data_hosts(&mut rx), ["s1"]);

    // Re-claiming (re-subscribing) still works, and a later disconnect starts
    // a fresh grace.
    let reclaimed = subscribe(&manager, "s1").await;
    manager.client_disconnected(GRACE);
    advance(GRACE - SHORT).await;
    assert!(reclaimed.is_subscribed());
    advance(2 * SHORT).await;
    assert!(hosts(&manager).await.is_empty());
    assert!(!reclaimed.is_subscribed());
}

#[tokio::test(start_paused = true)]
async fn no_reap_while_a_client_is_connected() {
    let (manager, _rx) = manager();
    manager.client_connected();
    let provider = subscribe(&manager, "s1").await;

    advance(10 * GRACE).await;
    assert_eq!(hosts(&manager).await, ["s1"]);
    assert!(provider.is_subscribed());
    assert_eq!(unsubscribes(&provider), 0);
}

#[tokio::test(start_paused = true)]
async fn concurrent_clients_reap_only_after_the_last_one_leaves() {
    let (manager, _rx) = manager();
    let mut providers = HashMap::new();

    manager.client_connected(); // client A
    providers.insert("a1", subscribe(&manager, "a1").await);
    providers.insert("a2", subscribe(&manager, "a2").await);
    manager.client_connected(); // client B
    providers.insert("b1", subscribe(&manager, "b1").await);

    manager.client_disconnected(GRACE); // A leaves; B can still receive
    advance(2 * GRACE).await;
    assert_eq!(hosts(&manager).await, ["a1", "a2", "b1"]);

    manager.client_disconnected(GRACE); // B leaves: nobody left
    advance(GRACE - SHORT).await;
    assert_eq!(hosts(&manager).await, ["a1", "a2", "b1"]);
    advance(2 * SHORT).await;
    assert!(hosts(&manager).await.is_empty());
    for (host, provider) in &providers {
        assert!(!provider.is_subscribed(), "{host} was reaped");
        assert_eq!(unsubscribes(provider), 1, "{host} stopped once");
    }
}

#[tokio::test(start_paused = true)]
async fn sequential_clients_share_one_grace_from_the_last_disconnect() {
    let (manager, _rx) = manager();

    manager.client_connected(); // client A
    let a = subscribe(&manager, "a1").await;
    manager.client_disconnected(GRACE);
    advance(GRACE - SHORT).await;

    manager.client_connected(); // client B, within A's grace
    let b = subscribe(&manager, "b1").await;
    advance(SHORT).await; // A's original deadline passes while B is connected
    manager.client_disconnected(GRACE);

    // A's stale reap must not fire when B's grace is still running.
    advance(GRACE - SHORT).await;
    assert_eq!(hosts(&manager).await, ["a1", "b1"]);
    assert!(a.is_subscribed() && b.is_subscribed());

    advance(2 * SHORT).await;
    assert!(hosts(&manager).await.is_empty());
    assert!(!a.is_subscribed() && !b.is_subscribed());
}

#[tokio::test(start_paused = true)]
async fn a_client_after_the_grace_simply_resubscribes() {
    let (manager, mut rx) = manager();
    manager.client_connected();
    subscribe(&manager, "s1").await;
    manager.client_disconnected(GRACE);
    advance(GRACE + SHORT).await;
    assert!(hosts(&manager).await.is_empty());

    manager.client_connected();
    let provider = subscribe(&manager, "s1").await;
    data_hosts(&mut rx);
    provider.push(stats("s1")).await;
    advance(Duration::ZERO).await;
    assert_eq!(data_hosts(&mut rx), ["s1"]);
    advance(2 * GRACE).await;
    assert_eq!(hosts(&manager).await, ["s1"]);
}

#[test]
fn grace_defaults_and_honours_a_valid_override() {
    assert_eq!(orphan_grace_from(|_| None), ORPHAN_GRACE);
    for bad in ["", "0", "-5", "soon"] {
        assert_eq!(
            orphan_grace_from(|_| Some(bad.to_string())),
            ORPHAN_GRACE,
            "{bad:?} keeps the default"
        );
    }
    assert_eq!(
        orphan_grace_from(|key| (key == ORPHAN_GRACE_ENV).then(|| "42".to_string())),
        Duration::from_secs(42)
    );
}
