use std::sync::{Arc, Mutex};

use tracing::Level;
use tracing_subscriber::layer::SubscriberExt;

use super::*;

#[test]
fn run_buffered_returns_the_value_and_buffers_events_in_order() {
    let (value, log) = run_buffered(|| {
        tracing::info!(lock_file = "/x/.termihub.lock", "locked");
        tracing::warn!("degraded");
        42
    });
    assert_eq!(value, 42);
    let events = log.events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].level, Level::INFO);
    assert_eq!(events[0].message, "locked lock_file=/x/.termihub.lock");
    assert!(events[0].target.ends_with("early_log::tests"));
    assert_eq!(events[1].level, Level::WARN);
    assert_eq!(events[1].message, "degraded");
}

#[test]
fn replay_reemits_every_event_with_its_level() {
    let (_, log) = run_buffered(|| {
        tracing::error!("refused");
        tracing::info!("locked");
    });

    let replayed = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry().with(BufferLayer {
        events: replayed.clone(),
    });
    tracing::subscriber::with_default(subscriber, || log.replay());

    let replayed = replayed.lock().unwrap();
    let got: Vec<(Level, &str)> = replayed
        .iter()
        .map(|e| (e.level, e.message.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                Level::ERROR,
                "refused origin=termihub_lib::boot::early_log::tests"
            ),
            (
                Level::INFO,
                "locked origin=termihub_lib::boot::early_log::tests"
            ),
        ]
    );
}
