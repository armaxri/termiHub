//! The scheduler loop under tokio's paused clock: it really fires, it never
//! overlaps, and a wall-clock jump (sleep / closed app) takes the missed-run
//! path.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use chrono::{Duration, TimeZone, Utc};
use tempfile::TempDir;

use super::*;
use crate::schedules::config::{
    MissedRunPolicy, ScheduleAction, ScheduleRule, ScheduleRunOutcome, ScheduleTargets,
};
use crate::schedules::manager::{ScheduleInput, WindowRunReport};

/// Wall clock = a fixed base + tokio's (paused) elapsed time + a manual jump.
struct FakeClock {
    base: DateTime<Utc>,
    start: tokio::time::Instant,
    jump_secs: AtomicI64,
}

impl FakeClock {
    fn new(base: DateTime<Utc>) -> Self {
        Self {
            base,
            start: tokio::time::Instant::now(),
            jump_secs: AtomicI64::new(0),
        }
    }

    /// Simulate the machine sleeping: wall time moves, tokio time does not.
    fn jump(&self, d: Duration) {
        self.jump_secs.fetch_add(d.num_seconds(), Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> {
        let elapsed = Duration::from_std(self.start.elapsed()).unwrap_or_default();
        self.base + elapsed + Duration::seconds(self.jump_secs.load(Ordering::SeqCst))
    }
}

#[derive(Default)]
struct RecordingSink {
    fires: Mutex<Vec<ScheduleFire>>,
    changes: Mutex<u32>,
}

impl ScheduleSink for RecordingSink {
    fn live_windows(&self) -> Vec<String> {
        vec!["main".to_string()]
    }
    fn fire(&self, fire: &ScheduleFire) {
        self.fires.lock().unwrap().push(fire.clone());
    }
    fn changed(&self) {
        *self.changes.lock().unwrap() += 1;
    }
}

impl RecordingSink {
    fn fire_count(&self) -> usize {
        self.fires.lock().unwrap().len()
    }
    fn last_token(&self) -> String {
        self.fires.lock().unwrap().last().unwrap().token.clone()
    }
}

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 6, 1, 10, 0, 0).unwrap()
}

struct Harness {
    _dir: TempDir,
    manager: Arc<ScheduleManager>,
    clock: Arc<FakeClock>,
    sink: Arc<RecordingSink>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn start(every_minutes: u32, policy: MissedRunPolicy) -> Harness {
    let dir = TempDir::new().unwrap();
    let manager = Arc::new(ScheduleManager::new_test(dir.path()));
    manager
        .save(
            ScheduleInput {
                id: "s1".into(),
                name: "Ping".into(),
                action: ScheduleAction::Workflow {
                    workflow_id: "wf".into(),
                },
                targets: ScheduleTargets::Connections {
                    connection_ids: vec!["c1".into()],
                },
                rule: ScheduleRule::Interval { every_minutes },
                missed_runs: policy,
            },
            base(),
            &Utc,
        )
        .unwrap();
    manager.set_enabled("s1", true, true, base(), &Utc).unwrap();
    let clock = Arc::new(FakeClock::new(base()));
    let sink = Arc::new(RecordingSink::default());
    let task = tokio::spawn(run_loop(
        manager.clone(),
        clock.clone() as Arc<dyn Clock>,
        Utc,
        sink.clone() as Arc<dyn ScheduleSink>,
        TICK_PERIOD,
    ));
    Harness {
        _dir: dir,
        manager,
        clock,
        sink,
        task,
    }
}

async fn wait(secs: u64) {
    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
}

fn outcome(h: &Harness) -> Option<ScheduleRunOutcome> {
    h.manager.state(h.clock.now(), &Utc).unwrap().schedules[0]
        .schedule
        .last_result
        .as_ref()
        .map(|r| r.outcome)
}

fn done(h: &Harness) {
    let token = h.sink.last_token();
    h.manager
        .report(
            &token,
            "main",
            WindowRunReport {
                outcome: ScheduleRunOutcome::Completed,
                message: None,
                targets_run: 1,
            },
            h.clock.now(),
        )
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_loop_fires_on_schedule() {
    let h = start(1, MissedRunPolicy::Skip);
    wait(50).await;
    assert_eq!(h.sink.fire_count(), 0, "not due before one minute");
    wait(20).await;
    assert_eq!(h.sink.fire_count(), 1);
    assert!(*h.sink.changes.lock().unwrap() >= 1);
    done(&h);
    wait(60).await;
    assert_eq!(h.sink.fire_count(), 2);
}

#[tokio::test(start_paused = true)]
async fn the_loop_never_overlaps_a_run_still_in_flight() {
    let h = start(1, MissedRunPolicy::Skip);
    wait(70).await;
    assert_eq!(h.sink.fire_count(), 1);
    // Unreported: the next three slots are skipped, not fired.
    wait(180).await;
    assert_eq!(h.sink.fire_count(), 1);
    assert_eq!(outcome(&h), Some(ScheduleRunOutcome::Skipped));
    done(&h);
    wait(60).await;
    assert_eq!(h.sink.fire_count(), 2);
}

#[tokio::test(start_paused = true)]
async fn waking_from_sleep_skips_missed_runs_by_default() {
    let h = start(5, MissedRunPolicy::Skip);
    wait(60).await;
    h.clock.jump(Duration::hours(2));
    wait(20).await;
    assert_eq!(h.sink.fire_count(), 0);
    assert_eq!(outcome(&h), Some(ScheduleRunOutcome::Skipped));
    // Then resumes the regular cadence.
    wait(5 * 60).await;
    assert_eq!(h.sink.fire_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn waking_from_sleep_catches_up_once_when_asked_to() {
    let h = start(5, MissedRunPolicy::RunOnce);
    wait(60).await;
    h.clock.jump(Duration::hours(2));
    wait(20).await;
    assert_eq!(h.sink.fire_count(), 1);
    assert!(h.sink.fires.lock().unwrap()[0].catch_up);
    done(&h);
    wait(30).await;
    assert_eq!(h.sink.fire_count(), 1, "exactly one catch-up");
}

#[tokio::test(start_paused = true)]
async fn the_global_pause_stops_the_loop_from_firing() {
    let h = start(1, MissedRunPolicy::RunOnce);
    h.manager.set_paused(true, h.clock.now(), &Utc).unwrap();
    wait(5 * 60).await;
    assert_eq!(h.sink.fire_count(), 0);
    h.manager.set_paused(false, h.clock.now(), &Utc).unwrap();
    wait(20).await;
    assert_eq!(
        h.sink.fire_count(),
        0,
        "a resume does not replay the paused runs"
    );
    wait(60).await;
    assert_eq!(h.sink.fire_count(), 1);
}
