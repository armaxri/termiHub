//! Session monitoring over the daemon frame protocol (#3871): the wire shape,
//! the daemon's monitor worker, and the worker-side channel.

use std::time::Duration;

use termihub_core::monitoring::MonitorStatus;

use super::*;
use crate::monitoring::session::test_support::{stats, FakeProvider};

type Events = mpsc::Receiver<(u64, MonitoringEvent)>;

fn worker(provider: Arc<FakeProvider>) -> (mpsc::Sender<MonitorCommand>, Events) {
    let (tx, rx) = mpsc::channel(32);
    (spawn_monitor_worker(provider, tx), rx)
}

async fn request(commands: &mpsc::Sender<MonitorCommand>, gen: u64, id: u64, op: MonitoringOp) {
    commands
        .send(MonitorCommand::Request {
            gen,
            request: MonitoringRequest { id, op },
        })
        .await
        .expect("worker alive");
}

async fn next(events: &mut Events) -> (u64, MonitoringEvent) {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("an event in time")
        .expect("worker alive")
}

/// The next event that is not a sample (the worker may interleave them).
async fn next_reply(events: &mut Events) -> (u64, u64, Option<String>) {
    loop {
        match next(events).await {
            (gen, MonitoringEvent::Reply { id, error }) => return (gen, id, error),
            (_, MonitoringEvent::Stats { .. } | MonitoringEvent::Status { .. }) => continue,
            (_, MonitoringEvent::Ended) => panic!("unexpected end of stream"),
        }
    }
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

// ── Wire shape ──────────────────────────────────────────────────────

#[test]
fn requests_and_events_have_a_stable_json_shape() {
    let req = MonitoringRequest {
        id: 3,
        op: MonitoringOp::SetInterval { interval_ms: 2000 },
    };
    let v = serde_json::to_value(&req).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"id": 3, "op": "set_interval", "interval_ms": 2000})
    );
    assert_eq!(serde_json::from_value::<MonitoringRequest>(v).unwrap(), req);

    let ok = serde_json::to_value(MonitoringEvent::Reply { id: 3, error: None }).unwrap();
    assert_eq!(ok, serde_json::json!({"event": "reply", "id": 3}));

    let sample = serde_json::to_value(MonitoringEvent::Stats {
        stats: Box::new(stats("box")),
    })
    .unwrap();
    assert_eq!(sample["event"], "stats");
    assert_eq!(sample["stats"]["hostname"], "box");
}

// ── Daemon side: the monitor worker ─────────────────────────────────

#[tokio::test]
async fn subscribe_replies_and_streams_the_providers_samples() {
    let provider = Arc::new(FakeProvider::default());
    let (commands, mut events) = worker(provider.clone());

    request(&commands, 1, 10, MonitoringOp::Subscribe).await;
    assert_eq!(next_reply(&mut events).await, (1, 10, None));

    provider.push(stats("container-1")).await;
    match next(&mut events).await {
        (1, MonitoringEvent::Stats { stats }) => assert_eq!(stats.hostname, "container-1"),
        other => panic!("expected a sample for gen 1, got {other:?}"),
    }
    provider
        .push_status(MonitorStatusUpdate {
            status: MonitorStatus::Stale,
            reason: None,
        })
        .await;
    match next(&mut events).await {
        (1, MonitoringEvent::Status { update }) => assert_eq!(update.status, MonitorStatus::Stale),
        other => panic!("expected a status, got {other:?}"),
    }
}

#[tokio::test]
async fn a_failed_subscribe_replies_with_the_providers_error() {
    let provider = Arc::new(FakeProvider::failing("no readable /proc"));
    let (commands, mut events) = worker(provider);
    request(&commands, 1, 4, MonitoringOp::Subscribe).await;
    let (_, id, error) = next_reply(&mut events).await;
    assert_eq!(id, 4);
    assert!(error.unwrap().contains("no readable /proc"));
}

#[tokio::test]
async fn interval_and_pause_reach_the_provider_with_the_interval_floored() {
    let provider = Arc::new(FakeProvider::default());
    let (commands, mut events) = worker(provider.clone());
    request(
        &commands,
        1,
        1,
        MonitoringOp::SetInterval { interval_ms: 10 },
    )
    .await;
    request(&commands, 1, 2, MonitoringOp::SetPaused { paused: true }).await;
    assert_eq!(next_reply(&mut events).await, (1, 1, None));
    assert_eq!(next_reply(&mut events).await, (1, 2, None));
    assert_eq!(provider.calls(), ["interval:500", "paused:true"]);
}

#[tokio::test]
async fn unsubscribe_stops_the_provider_and_the_stream() {
    let provider = Arc::new(FakeProvider::default());
    let (commands, mut events) = worker(provider.clone());
    request(&commands, 1, 1, MonitoringOp::Subscribe).await;
    next_reply(&mut events).await;
    request(&commands, 1, 2, MonitoringOp::Unsubscribe).await;
    assert_eq!(next_reply(&mut events).await, (1, 2, None));
    assert_eq!(provider.calls(), ["subscribe", "unsubscribe"]);
    assert!(!provider.is_subscribed());
}

/// Single-attach: once the subscriber no longer holds the session the daemon
/// releases the stream, and the provider stops collecting.
#[tokio::test]
async fn release_stops_the_provider() {
    let provider = Arc::new(FakeProvider::default());
    let (commands, mut events) = worker(provider.clone());
    request(&commands, 1, 1, MonitoringOp::Subscribe).await;
    next_reply(&mut events).await;
    commands.send(MonitorCommand::Release).await.unwrap();
    assert!(eventually(|| !provider.is_subscribed()).await);
    assert_eq!(provider.calls(), ["subscribe", "unsubscribe"]);

    // A release with nothing subscribed does not touch the provider.
    commands.send(MonitorCommand::Release).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(provider.calls(), ["subscribe", "unsubscribe"]);
}

/// The session ended: the daemon loop drops its command sender and the
/// worker stops the provider rather than leave its loop running.
#[tokio::test]
async fn the_worker_stops_the_provider_when_the_daemon_loop_ends() {
    let provider = Arc::new(FakeProvider::default());
    let (commands, mut events) = worker(provider.clone());
    request(&commands, 1, 1, MonitoringOp::Subscribe).await;
    next_reply(&mut events).await;
    drop(commands);
    assert!(eventually(|| !provider.is_subscribed()).await);
}

#[tokio::test]
async fn a_provider_stream_that_ends_is_reported_as_ended() {
    let provider = Arc::new(FakeProvider::default());
    let (commands, mut events) = worker(provider.clone());
    request(&commands, 1, 1, MonitoringOp::Subscribe).await;
    next_reply(&mut events).await;
    provider.end();
    assert!(matches!(
        next(&mut events).await,
        (1, MonitoringEvent::Ended)
    ));
}

// ── Worker side: the channel ────────────────────────────────────────

fn encode(event: &MonitoringEvent) -> Vec<u8> {
    serde_json::to_vec(event).unwrap()
}

#[tokio::test]
async fn the_channel_routes_replies_and_streams_to_the_subscriber() {
    let channel = MonitoringChannel::default();
    let (id, reply) = channel.register();
    channel.deliver(&encode(&MonitoringEvent::Reply {
        id,
        error: Some("nope".into()),
    }));
    assert_eq!(reply.await.unwrap(), Some("nope".into()));
    assert_eq!(channel.pending_len(), 0);

    let (stats_tx, mut stats_rx) = mpsc::channel(4);
    let (status_tx, mut status_rx) = mpsc::channel(4);
    channel.install_sink(MonitorSink {
        stats: stats_tx,
        status: status_tx,
    });
    channel.deliver(&encode(&MonitoringEvent::Stats {
        stats: Box::new(stats("h")),
    }));
    channel.deliver(&encode(&MonitoringEvent::Status {
        update: MonitorStatusUpdate {
            status: MonitorStatus::Live,
            reason: None,
        },
    }));
    assert_eq!(stats_rx.recv().await.unwrap().hostname, "h");
    assert_eq!(status_rx.recv().await.unwrap().status, MonitorStatus::Live);

    // The daemon's stream ended: the subscriber's receivers close.
    channel.deliver(&encode(&MonitoringEvent::Ended));
    assert!(!channel.has_sink());
    assert!(stats_rx.recv().await.is_none());
}

#[tokio::test]
async fn a_lost_connection_fails_requests_and_ends_the_stream() {
    let channel = MonitoringChannel::default();
    let (_id, reply) = channel.register();
    let (stats_tx, mut stats_rx) = mpsc::channel(4);
    let (status_tx, _status_rx) = mpsc::channel(4);
    channel.install_sink(MonitorSink {
        stats: stats_tx,
        status: status_tx,
    });

    channel.fail_all();
    assert!(
        reply.await.is_err(),
        "the waiter hears the connection is gone"
    );
    assert!(stats_rx.recv().await.is_none(), "the stream ends");
    assert_eq!(channel.pending_len(), 0);
}

#[test]
fn malformed_and_unknown_events_are_dropped() {
    let channel = MonitoringChannel::default();
    channel.deliver(b"not json");
    channel.deliver(&encode(&MonitoringEvent::Reply {
        id: 99,
        error: None,
    }));
    // Samples with no subscriber are dropped too.
    channel.deliver(&encode(&MonitoringEvent::Stats {
        stats: Box::new(stats("h")),
    }));
    assert_eq!(channel.pending_len(), 0);
}

#[tokio::test]
async fn a_detached_session_refuses_to_subscribe() {
    let channel = Arc::new(MonitoringChannel::default());
    let provider =
        DaemonMonitoringProvider::new(Arc::new(tokio::sync::Mutex::new(None)), channel.clone());
    let err = match provider.subscribe().await {
        Ok(_) => panic!("no writer, no subscription"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("not attached"), "{err}");
    assert!(!channel.has_sink(), "a failed subscribe leaves no sink");
    assert_eq!(channel.pending_len(), 0);
}
