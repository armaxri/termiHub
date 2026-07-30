//! Deterministic tests for the backend reconnect timer driver (#2203).
//!
//! A `ManualScheduler` records armed delays and fires on command, so a full
//! reconnect sequence runs synchronously with exact delays (the store's jitter
//! source is pinned to 0.5 → zero swing, so attempt N's delay is its uncapped
//! base: 1000, 2000, 4000, … ms). No wall-clock, no `tokio`, no flake.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use termihub_core::reconnect_backoff::ReconnectPhase;

use super::{ReconnectScheduler, ReconnectTimerDriver};
use crate::projection::Projector;
use crate::session_projection::projection::{publish_sessions, SESSION_LIFECYCLE_REGION};
use crate::session_projection::store::{SessionLifecycleStore, SessionStatus};

/// The armed one-shots a [`ManualScheduler`] records: `key → (delay, task)`.
type ArmedTasks = std::collections::HashMap<String, (u64, Box<dyn FnOnce() + Send>)>;

/// A test scheduler that records the armed one-shots instead of sleeping, so a
/// test can inspect the armed delay and fire the timer synchronously.
#[derive(Default)]
struct ManualScheduler {
    tasks: Mutex<ArmedTasks>,
}

impl ManualScheduler {
    fn new() -> Self {
        Self::default()
    }

    /// The delay a key is currently armed for, or `None` if nothing is armed.
    fn armed_delay(&self, key: &str) -> Option<u64> {
        self.tasks.lock().unwrap().get(key).map(|(delay, _)| *delay)
    }

    /// Run and consume the armed task for `key` (the timer "elapsed").
    fn fire(&self, key: &str) {
        let task = self.tasks.lock().unwrap().remove(key);
        if let Some((_, task)) = task {
            task();
        }
    }
}

impl ReconnectScheduler for ManualScheduler {
    fn schedule(&self, key: String, delay_ms: u64, task: Box<dyn FnOnce() + Send>) {
        self.tasks.lock().unwrap().insert(key, (delay_ms, task));
    }

    fn cancel(&self, key: &str) {
        self.tasks.lock().unwrap().remove(key);
    }
}

/// The test harness bundle: store, projector, scheduler, driver, publish counter.
type Harness = (
    Arc<SessionLifecycleStore>,
    Arc<Projector>,
    Arc<ManualScheduler>,
    Arc<ReconnectTimerDriver>,
    Arc<AtomicUsize>,
);

/// A store (zero jitter), projector-registered region, a manual scheduler, and a
/// driver whose publish hook fans the region out. Returns them all so a test can
/// both drive intents and inspect the timer.
fn harness() -> Harness {
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let scheduler = Arc::new(ManualScheduler::new());

    let publishes = Arc::new(AtomicUsize::new(0));
    let store_for_publish = store.clone();
    let projector_for_publish = projector.clone();
    let publishes_for_hook = publishes.clone();
    let driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(move || {
            publishes_for_hook.fetch_add(1, Ordering::SeqCst);
            publish_sessions(&projector_for_publish, &store_for_publish);
        }),
    ));
    (store, projector, scheduler, driver, publishes)
}

#[test]
fn a_waiting_phase_arms_the_backoff_delay_and_a_success_cancels_it() {
    let (store, _projector, scheduler, driver, _pub) = harness();

    // Drop → reconnect enters Waiting with the attempt-1 delay (1000 ms).
    store.connect("s1");
    store.connected("s1");
    store.dropped("s1", Some("reset".into()));
    driver.sync("s1");
    assert_eq!(
        scheduler.armed_delay("s1"),
        None,
        "a plain drop does not retry"
    );

    store.reconnect("s1");
    driver.sync("s1");
    assert_eq!(store.get("s1").unwrap().status, SessionStatus::Reconnecting);
    assert_eq!(
        scheduler.armed_delay("s1"),
        Some(1000),
        "attempt-1 backoff armed"
    );

    // The timer fires: the store advances Waiting → Connecting (attempt++).
    scheduler.fire("s1");
    let s = store.get("s1").unwrap();
    assert_eq!(s.reconnect.phase, ReconnectPhase::Connecting);
    assert_eq!(s.reconnect.attempt, 1);
    assert_eq!(
        scheduler.armed_delay("s1"),
        None,
        "no timer while connecting"
    );

    // The attempt succeeds → the loop settles and any timer is cancelled.
    store.connected("s1");
    driver.sync("s1");
    assert_eq!(store.get("s1").unwrap().status, SessionStatus::Connected);
    assert_eq!(scheduler.armed_delay("s1"), None);
}

#[test]
fn the_timer_drives_the_expected_backoff_attempt_sequence_until_giveup() {
    let (store, _projector, scheduler, driver, _pub) = harness();
    store.connect("s1");
    store.connected("s1");
    store.reconnect("s1"); // Drop → Waiting (attempt 0, delay for attempt 1)
    driver.sync("s1");

    // Expected uncapped backoff schedule (base 1000, factor 2, cap 30000):
    // attempt 1..=10 → 1000, 2000, 4000, 8000, 16000, then capped at 30000.
    let expected = [
        1000u64, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000,
    ];
    for (i, want) in expected.iter().enumerate() {
        assert_eq!(
            scheduler.armed_delay("s1"),
            Some(*want),
            "attempt {} backoff delay",
            i + 1
        );
        // Timer fires → an attempt starts (Waiting → Connecting).
        scheduler.fire("s1");
        let s = store.get("s1").unwrap();
        assert_eq!(s.reconnect.phase, ReconnectPhase::Connecting);
        assert_eq!(s.reconnect.attempt, (i as i64) + 1);
        // The frontend would redrive; here we play its role and fail the attempt.
        store.reconnect_failed("s1", Some("still down".into()));
        driver.sync("s1");
    }

    // The 10th failure exhausts max_attempts (DEFAULT_BACKOFF = 10): terminal.
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::Failed);
    assert_eq!(s.reconnect.phase, ReconnectPhase::Gaveup);
    assert_eq!(
        scheduler.armed_delay("s1"),
        None,
        "give-up cancels the timer"
    );
}

#[test]
fn a_fired_timer_publishes_the_advanced_region_as_a_diff() {
    let (store, projector, scheduler, driver, publishes) = harness();
    store.connect("s1");
    store.reconnect("s1");
    driver.sync("s1");
    let before = projector.region_version(SESSION_LIFECYCLE_REGION).unwrap();

    scheduler.fire("s1");

    assert_eq!(publishes.load(Ordering::SeqCst), 1, "fire published once");
    let after = projector.region_version(SESSION_LIFECYCLE_REGION).unwrap();
    assert_eq!(after, before + 1, "the fired attempt fanned out one diff");
    let snap = projector.snapshot(SESSION_LIFECYCLE_REGION);
    assert_eq!(
        snap.view["sessions"]["s1"]["reconnect"]["phase"],
        json!("connecting")
    );
}

#[test]
fn cancel_reconnect_stops_the_timer() {
    let (store, _projector, scheduler, driver, _pub) = harness();
    store.connect("s1");
    store.reconnect("s1");
    driver.sync("s1");
    assert!(scheduler.armed_delay("s1").is_some());

    store.cancel_reconnect("s1");
    driver.sync("s1");
    assert_eq!(
        scheduler.armed_delay("s1"),
        None,
        "user cancel disarms the loop"
    );
    assert_eq!(store.get("s1").unwrap().status, SessionStatus::Disconnected);
}

#[test]
fn remove_disarms_any_pending_timer() {
    let (store, _projector, scheduler, driver, _pub) = harness();
    store.connect("s1");
    store.reconnect("s1");
    driver.sync("s1");
    assert!(scheduler.armed_delay("s1").is_some());

    store.remove("s1");
    driver.sync("s1");
    assert_eq!(
        scheduler.armed_delay("s1"),
        None,
        "a removed session has no timer"
    );
}
