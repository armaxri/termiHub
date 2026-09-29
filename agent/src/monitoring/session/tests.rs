//! Forwarding a session backend's monitoring provider to the desktop (#3871).

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedReceiver;

use super::test_support::{stats, FakeProvider};
use super::*;
use crate::monitoring::MonitoringManager;
use crate::protocol::messages::JsonRpcNotification;
use crate::session::definitions::ConnectionStore;

fn manager() -> (MonitoringManager, UnboundedReceiver<JsonRpcNotification>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!(
        "termihub-session-mon-test-{}.json",
        uuid::Uuid::new_v4()
    ));
    (
        MonitoringManager::new(tx, Arc::new(ConnectionStore::new_temp(tmp))),
        rx,
    )
}

/// The next notification, as `(method, params)`.
async fn next(rx: &mut UnboundedReceiver<JsonRpcNotification>) -> (String, Value) {
    let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("a notification in time")
        .expect("channel open");
    let v = serde_json::to_value(&n).expect("serializable");
    (
        v["method"].as_str().unwrap_or_default().to_string(),
        v["params"].clone(),
    )
}

async fn eventually(mut pred: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn a_session_provider_streams_samples_and_status_under_the_session_id() {
    let (manager, mut rx) = manager();
    let provider = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider("sess-1", provider.clone(), Some(3000))
        .await
        .expect("subscribe");
    assert_eq!(provider.calls(), ["subscribe", "interval:3000"]);

    provider
        .push_status(MonitorStatusUpdate {
            status: MonitorStatus::Live,
            reason: None,
        })
        .await;
    let (method, params) = next(&mut rx).await;
    assert_eq!(method, CONNECTION_MONITORING_STATUS);
    assert_eq!(params["host"], "sess-1");
    assert_eq!(params["status"], "live");

    provider.push(stats("container-7")).await;
    let (method, params) = next(&mut rx).await;
    assert_eq!(method, CONNECTION_MONITORING_DATA);
    assert_eq!(params["host"], "sess-1");
    assert_eq!(params["hostname"], "container-7");
    assert_eq!(params["cpuUsagePercent"], 12.5);
}

#[tokio::test]
async fn the_interval_is_floored_like_the_agents_own_collectors() {
    let (manager, _rx) = manager();
    let provider = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider("sess-1", provider.clone(), Some(10))
        .await
        .unwrap();
    assert_eq!(provider.calls(), ["subscribe", "interval:500"]);
}

#[tokio::test]
async fn a_failed_subscribe_is_the_rpcs_error_and_leaves_no_subscription() {
    let (manager, _rx) = manager();
    let provider = Arc::new(FakeProvider::failing("no readable /proc"));
    let err = manager
        .subscribe_provider("sess-1", provider, None)
        .await
        .expect_err("the provider's connect failure surfaces");
    assert!(err.to_string().contains("no readable /proc"), "{err}");
    assert!(manager.subscriptions.lock().await.is_empty());
}

#[tokio::test]
async fn unsubscribe_stops_the_session_provider() {
    let (manager, _rx) = manager();
    let provider = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider("sess-1", provider.clone(), None)
        .await
        .unwrap();
    assert!(manager.unsubscribe("sess-1").await);
    assert_eq!(
        provider.calls().last().map(String::as_str),
        Some("unsubscribe")
    );
    assert!(!provider.is_subscribed());
    assert!(!manager.unsubscribe("sess-1").await);
}

/// The desktop changes the interval and resumes by re-subscribing: the old
/// stream is stopped before the provider restarts.
#[tokio::test]
async fn a_repeat_subscribe_restarts_the_provider_in_place() {
    let (manager, _rx) = manager();
    let provider = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider("sess-1", provider.clone(), Some(2000))
        .await
        .unwrap();
    manager
        .subscribe_provider("sess-1", provider.clone(), Some(5000))
        .await
        .unwrap();
    assert_eq!(
        provider.calls(),
        [
            "subscribe",
            "interval:2000",
            "unsubscribe",
            "subscribe",
            "interval:5000"
        ]
    );
    assert_eq!(manager.subscriptions.lock().await.len(), 1);
}

#[tokio::test]
async fn shutdown_stops_every_session_provider() {
    let (manager, _rx) = manager();
    let a = Arc::new(FakeProvider::default());
    let b = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider("a", a.clone(), None)
        .await
        .unwrap();
    manager
        .subscribe_provider("b", b.clone(), None)
        .await
        .unwrap();
    manager.shutdown().await;
    assert!(!a.is_subscribed() && !b.is_subscribed());
}

/// The session ended (its daemon connection went away and took the stream
/// with it): the desktop hears `Offline` instead of waiting on a dead stream.
#[tokio::test]
async fn a_stream_that_ends_reports_offline() {
    let (manager, mut rx) = manager();
    let provider = Arc::new(FakeProvider::default());
    manager
        .subscribe_provider("sess-1", provider.clone(), None)
        .await
        .unwrap();
    provider.end();

    let (method, params) = next(&mut rx).await;
    assert_eq!(method, CONNECTION_MONITORING_STATUS);
    assert_eq!(params["host"], "sess-1");
    assert_eq!(params["status"], "offline");
    assert_eq!(params["reason"], "transport");
}

/// A provider that already reported `Offline` before stopping is not
/// reported twice.
#[tokio::test]
async fn a_provider_reported_offline_is_not_repeated() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (stats_tx, stats_rx) = tokio::sync::mpsc::channel(4);
    let (status_tx, status_rx) = tokio::sync::mpsc::channel(4);
    status_tx
        .send(MonitorStatusUpdate {
            status: MonitorStatus::Offline,
            reason: Some(MonitorStatusReason::Parse),
        })
        .await
        .unwrap();
    drop(status_tx);
    drop(stats_tx);
    forward_provider(
        "sess-1".into(),
        MonitoringSubscription {
            stats: stats_rx,
            status: status_rx,
        },
        tx,
        CancellationToken::new(),
    )
    .await;

    let (_, params) = next(&mut rx).await;
    assert_eq!(params["status"], "offline");
    assert_eq!(params["reason"], "parse");
    assert!(rx.try_recv().is_err(), "no second Offline");
}

#[tokio::test]
async fn a_cancelled_forwarder_stops_without_reporting() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (_stats_tx, stats_rx) = tokio::sync::mpsc::channel(4);
    let (_status_tx, status_rx) = tokio::sync::mpsc::channel(4);
    let cancel = CancellationToken::new();
    let task = tokio::spawn(forward_provider(
        "sess-1".into(),
        MonitoringSubscription {
            stats: stats_rx,
            status: status_rx,
        },
        tx,
        cancel.clone(),
    ));
    cancel.cancel();
    assert!(eventually(|| task.is_finished()).await);
    assert!(rx.try_recv().is_err());
}
