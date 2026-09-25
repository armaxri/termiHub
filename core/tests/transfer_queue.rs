//! Integration coverage for the pure transfer machinery moved to core (DUP-026).
//!
//! These tests exercise the state machine, per-session scheduler, and
//! retry/backoff math *together*, driving a small queue lifecycle end to end
//! **without any Tauri, `AppHandle`, async runtime, or I/O** — proving the brains
//! of the transfer queue are reusable outside the desktop app (the enabling goal
//! for agent-hosted transfers, #3242).

use std::time::Duration;

use termihub_core::files::transfer::{
    backoff_delay, resume_offset, Admission, SessionScheduler, ThroughputMeter, TransferEvent,
    TransferState, TransferStateTag, DEFAULT_MAX_CONCURRENT, MAX_RETRIES,
};

/// A minimal per-transfer record wiring the pure state machine to a scheduler
/// admission decision — the shape the desktop registry builds on, reproduced
/// here with zero desktop dependencies.
struct QueuedTransfer {
    id: String,
    state: TransferState,
}

impl QueuedTransfer {
    fn new(id: &str, scheduler: &mut SessionScheduler) -> Self {
        // Every new transfer starts Queued and asks the scheduler for a slot;
        // whether it runs now or waits is the scheduler's call.
        let state = match scheduler.request(id) {
            Admission::Run => TransferState::Queued
                .apply(TransferEvent::Activate)
                .unwrap(),
            Admission::Queue => TransferState::Queued,
        };
        Self {
            id: id.to_string(),
            state,
        }
    }
}

#[test]
fn queue_promotes_next_transfer_when_one_completes() {
    // Two slots: first two run, the third queues behind them.
    let mut scheduler = SessionScheduler::new(DEFAULT_MAX_CONCURRENT);
    let mut a = QueuedTransfer::new("a", &mut scheduler);
    let mut b = QueuedTransfer::new("b", &mut scheduler);
    let c = QueuedTransfer::new("c", &mut scheduler);

    assert_eq!(a.state, TransferState::Active);
    assert_eq!(b.state, TransferState::Active);
    assert_eq!(c.state, TransferState::Queued);
    assert_eq!(scheduler.active(), 2);
    assert_eq!(scheduler.waiting(), 1);

    // 'a' finishes → its slot frees and the scheduler promotes the waiter 'c'.
    a.state = a.state.apply(TransferEvent::Complete).unwrap();
    assert!(a.state.is_terminal());
    let promoted = scheduler.release();
    assert_eq!(promoted.as_deref(), Some("c"));
    assert_eq!(
        scheduler.active(),
        2,
        "promotion keeps the slot count constant"
    );

    // Pausing 'b' releases its slot but nothing is waiting now.
    b.state = b.state.apply(TransferEvent::Pause).unwrap();
    assert_eq!(b.state, TransferState::Paused);
    assert_eq!(scheduler.release(), None);
    assert_eq!(scheduler.active(), 1);
}

#[test]
fn failure_then_backoff_retry_reruns_through_the_scheduler() {
    let mut scheduler = SessionScheduler::new(1);
    let mut t = QueuedTransfer::new("t", &mut scheduler);
    assert_eq!(t.state, TransferState::Active);

    // First attempt fails; still under the cap, so it is retryable.
    t.state = t.state.apply(TransferEvent::Fail { attempt: 1 }).unwrap();
    assert_eq!(
        t.state,
        TransferState::Failed {
            attempt: 1,
            retryable: true
        }
    );
    // A failed transfer releases its slot.
    assert_eq!(scheduler.release(), None);

    // The backoff schedule says wait 1s before the next attempt.
    assert_eq!(backoff_delay(1), Some(Duration::from_secs(1)));

    // Retry re-queues it; with a free slot it runs immediately.
    t.state = t.state.apply(TransferEvent::Retry).unwrap();
    assert_eq!(t.state, TransferState::Queued);
    assert_eq!(scheduler.requeue(&t.id), Admission::Run);
    t.state = t.state.apply(TransferEvent::Activate).unwrap();
    assert_eq!(t.state, TransferState::Active);

    // Exhaust the retry budget: the final failure is not retryable and backoff
    // returns None (give up / permanent failure).
    t.state = t
        .state
        .apply(TransferEvent::Fail {
            attempt: MAX_RETRIES,
        })
        .unwrap();
    assert_eq!(
        t.state,
        TransferState::Failed {
            attempt: MAX_RETRIES,
            retryable: false
        }
    );
    assert_eq!(t.state.tag(), TransferStateTag::Failed);
    assert!(t.state.apply(TransferEvent::Retry).is_err());
    assert_eq!(backoff_delay(MAX_RETRIES), None);
}

#[test]
fn resume_and_throughput_math_drive_a_partial_transfer() {
    // A partial download resumes from the bytes already present.
    let total = Some(10_000u64);
    assert_eq!(resume_offset(4_000, total), 4_000);

    // Feed the throughput meter a couple of samples and get an ETA for what
    // remains — all deterministic, no clock involved.
    let mut meter = ThroughputMeter::new(1.0);
    meter.record(1_000, Duration::from_secs(1)); // 1000 B/s
    assert_eq!(meter.speed_bps(), 1_000);
    // 6000 bytes remain at 1000 B/s → 6s.
    assert_eq!(meter.eta_secs(6_000), Some(6));
}
