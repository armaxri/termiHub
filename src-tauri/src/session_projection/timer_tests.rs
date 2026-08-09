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

use super::{ReconnectRedrive, ReconnectScheduler, ReconnectTimerDriver};
use crate::projection::Projector;
use crate::session_projection::projection::{publish_sessions, SESSION_LIFECYCLE_REGION};
use crate::session_projection::store::{EndReason, SessionLifecycleStore, SessionStatus};

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

// ── Backend redrive hook (#2454) ───────────────────────────────────────────

/// A recording [`ReconnectRedrive`] double: captures the tab ids a fired timer
/// asked it to redrive, so a test can assert the hook is invoked on the
/// `Waiting → Attempt` edge (the transport half of #2454).
#[derive(Default)]
struct RecordingRedrive {
    calls: Mutex<Vec<String>>,
}

impl ReconnectRedrive for RecordingRedrive {
    fn redrive(&self, tab_id: &str) {
        self.calls.lock().unwrap().push(tab_id.to_string());
    }
}

/// A driver whose fire hook also invokes a recording redrive, over the same
/// store/scheduler as [`harness`]. Returns the store, scheduler, driver and the
/// recorder.
fn harness_with_redrive() -> (
    Arc<SessionLifecycleStore>,
    Arc<ManualScheduler>,
    Arc<ReconnectTimerDriver>,
    Arc<RecordingRedrive>,
) {
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    let projector = Arc::new(Projector::new());
    projector.register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let scheduler = Arc::new(ManualScheduler::new());
    let redrive = Arc::new(RecordingRedrive::default());

    let store_for_publish = store.clone();
    let projector_for_publish = projector.clone();
    let driver = Arc::new(
        ReconnectTimerDriver::new(
            store.clone(),
            scheduler.clone(),
            Arc::new(move || {
                publish_sessions(&projector_for_publish, &store_for_publish);
            }),
        )
        .with_redrive(redrive.clone() as Arc<dyn ReconnectRedrive>),
    );
    (store, scheduler, driver, redrive)
}

#[test]
fn a_fired_timer_invokes_the_backend_redrive_after_advancing_to_connecting() {
    let (store, scheduler, driver, redrive) = harness_with_redrive();
    store.connect("s1");
    store.reconnect("s1"); // Drop → Waiting
    driver.sync("s1");
    assert!(redrive.calls.lock().unwrap().is_empty(), "no redrive yet");

    scheduler.fire("s1");

    // The store advanced to Connecting first, then the redrive was asked to
    // re-establish the transport for this tab — the order the frontend relies on.
    assert_eq!(
        store.get("s1").unwrap().reconnect.phase,
        ReconnectPhase::Connecting
    );
    assert_eq!(
        &*redrive.calls.lock().unwrap(),
        &["s1".to_string()],
        "the fired attempt drove the backend redrive"
    );
}

#[test]
fn without_a_redrive_hook_a_fired_timer_only_advances_the_store() {
    // The default harness installs NO redrive (the shadow / client-driven path):
    // a fired timer advances + publishes, and the client owns the transport.
    let (store, _projector, scheduler, driver, publishes) = harness();
    store.connect("s1");
    store.reconnect("s1");
    driver.sync("s1");

    scheduler.fire("s1");

    assert_eq!(
        store.get("s1").unwrap().reconnect.phase,
        ReconnectPhase::Connecting
    );
    assert_eq!(publishes.load(Ordering::SeqCst), 1);
}

#[test]
fn a_backend_redrive_success_publishes_the_new_session_id_and_cancels_the_timer() {
    // Play the backend redrive's success role: after the fired attempt, the
    // redrive re-establishes the transport, mints a new backend session, and
    // folds `connected` + the new `sessionId` at the source, then re-syncs.
    let (store, projector, scheduler, driver, _pub) = harness();
    store.connect("s1");
    store.reconnect("s1");
    driver.sync("s1");
    scheduler.fire("s1"); // Waiting → Connecting (attempt 1)

    store.connected("s1");
    store.set_backend_session_id("s1", Some("backend-new".to_string()));
    publish_sessions(&projector, &store);
    driver.sync("s1");

    let snap = projector.snapshot(SESSION_LIFECYCLE_REGION);
    assert_eq!(snap.view["sessions"]["s1"]["status"], json!("connected"));
    assert_eq!(
        snap.view["sessions"]["s1"]["sessionId"],
        json!("backend-new"),
        "the region carries the new backend session id for the frontend to re-attach to"
    );
    assert_eq!(
        scheduler.armed_delay("s1"),
        None,
        "a successful redrive cancels the timer"
    );
}

#[test]
fn backend_redrive_giveup_settles_failed_error_distinct_from_user_cancel_disconnected() {
    // Give-up (exhausted attempts) and user-cancel are the two terminal loop
    // states the backend redrive must resolve differently (#2454): the parity
    // the frontend and the retained-request scrub both key off.

    // (a) Give-up: drive the failure loop to exhaustion.
    let (store, _p, scheduler, driver, _pub) = harness();
    store.connect("g");
    store.reconnect("g");
    driver.sync("g");
    for _ in 0..10 {
        scheduler.fire("g");
        store.reconnect_failed("g", Some("still down".into()));
        driver.sync("g");
    }
    let gave_up = store.get("g").unwrap();
    assert_eq!(gave_up.status, SessionStatus::Failed);
    assert_eq!(gave_up.reconnect.phase, ReconnectPhase::Gaveup);
    assert_eq!(gave_up.end_reason, Some(EndReason::Error));
    assert!(gave_up.error.is_some(), "give-up carries the last error");

    // (b) User cancel mid-loop: distinct terminal state.
    let (store, _p2, scheduler2, driver2, _pub2) = harness();
    store.connect("c");
    store.reconnect("c");
    driver2.sync("c");
    scheduler2.fire("c"); // attempt in flight
    store.cancel_reconnect("c");
    driver2.sync("c");
    let cancelled = store.get("c").unwrap();
    assert_eq!(cancelled.status, SessionStatus::Disconnected);
    assert_eq!(cancelled.end_reason, Some(EndReason::User));
    assert_eq!(
        cancelled.error, None,
        "a user cancel carries no failure error"
    );
}

// ── Production scheduler off the Tokio runtime (#2503) ──────────────────────

use super::TokioReconnectScheduler;

/// #2503 regression: the production [`TokioReconnectScheduler`] is reached
/// **synchronously** from the sync Tauri command `intent_dispatch`, which runs
/// on the main/webview thread *outside* any Tokio runtime. The old free
/// `tokio::spawn` panicked there ("must be called from the context of a Tokio
/// 1.x runtime") → `abort()` → the app SIGABRT-crashed on agent reconnect.
/// Spawning onto Tauri's managed runtime makes arming safe from any thread.
///
/// This is a plain `#[test]` (NOT `#[tokio::test]`) so it runs with no ambient
/// runtime, reproducing the crash context exactly. On `develop` it aborts; with
/// the fix it arms and the one-shot fires through the managed runtime.
#[test]
fn scheduling_from_a_non_runtime_thread_arms_and_fires_without_panicking() {
    use std::sync::mpsc;
    use std::time::Duration;

    let scheduler = TokioReconnectScheduler::new();
    let (tx, rx) = mpsc::channel();

    // Arm from this plain-test thread (no Tokio runtime in scope). The old free
    // `tokio::spawn` would panic/abort right here.
    scheduler.schedule(
        "s1".to_string(),
        0,
        Box::new(move || {
            let _ = tx.send(());
        }),
    );

    rx.recv_timeout(Duration::from_secs(5))
        .expect("the armed timer fired via the managed runtime");
}

/// A pending timer armed off the runtime can still be cancelled off the runtime:
/// `cancel` aborts the managed handle, so the task never runs. Guards against a
/// regression where the abort path also needs the ambient runtime.
#[test]
fn cancelling_a_pending_timer_from_a_non_runtime_thread_stops_it() {
    use std::sync::mpsc;
    use std::time::Duration;

    let scheduler = TokioReconnectScheduler::new();
    let (tx, rx) = mpsc::channel();

    // Arm far in the future, then cancel before it can elapse.
    scheduler.schedule(
        "s1".to_string(),
        60_000,
        Box::new(move || {
            let _ = tx.send(());
        }),
    );
    scheduler.cancel("s1");

    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "a cancelled timer never fires"
    );
}

/// End-to-end shape of the crash: drive the real [`ReconnectTimerDriver::sync`]
/// with the production [`TokioReconnectScheduler`] from a plain (non-runtime)
/// thread — the exact `intent_dispatch → register_session_intents → sync_timer →
/// sync → schedule` path that aborted on `develop`. Arming must not panic.
#[test]
fn driver_sync_with_the_production_scheduler_arms_off_runtime_without_panicking() {
    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    let scheduler = Arc::new(TokioReconnectScheduler::new());
    let driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(|| {}),
    ));

    // Drop → Waiting arms a real backoff one-shot via `tauri::async_runtime`.
    store.connect("s1");
    store.reconnect("s1");
    driver.sync("s1"); // panicked/aborted here on develop

    // A subsequent settle cancels the pending timer — also off-runtime.
    store.connected("s1");
    driver.sync("s1");
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
