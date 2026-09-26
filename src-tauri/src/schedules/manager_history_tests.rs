//! Per-schedule attempt history (#3528): every settled attempt — fired runs
//! and skipped slots alike — is kept, newest first, with its timing and the
//! workflow run records it produced.

use super::tests::{completed, enabled_manager, skip_report, t, windows, TickAll};
use super::*;
use crate::schedules::config::{MissedRunPolicy, ScheduleRunOutcome, ScheduleRunResult};
use crate::schedules::history::MAX_ATTEMPTS;
use chrono::Utc;
use tempfile::TempDir;

fn history(m: &ScheduleManager) -> Vec<ScheduleRunResult> {
    m.state(t(0, 0), &Utc).unwrap().schedules[0]
        .schedule
        .history
        .clone()
}

#[test]
fn skips_no_longer_overwrite_each_other() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main"]);
    let token = m.tick_all(t(10, 10), &Utc, &w).fires[0].token.clone();
    m.ack(&token, "main");
    // Previous run still in flight → a logged skip.
    m.tick_all(t(10, 20), &Utc, &w);
    m.report(&token, "main", skip_report("None connected"), t(10, 21))
        .unwrap();
    let h = history(&m);
    assert_eq!(h.len(), 2);
    assert_eq!(h[0].outcome, ScheduleRunOutcome::Skipped);
    assert_eq!(h[0].message.as_deref(), Some("None connected"));
    assert!(h[1]
        .message
        .as_deref()
        .unwrap()
        .contains("still in progress"));
    assert_eq!(
        Some(&h[0]),
        m.state(t(0, 0), &Utc).unwrap().schedules[0]
            .schedule
            .last_result
            .as_ref()
    );
}

#[test]
fn a_fired_run_records_start_duration_and_workflow_run_ids() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main", "win-1"]);
    let token = m.tick_all(t(10, 10), &Utc, &w).fires[0].token.clone();
    let mut a = completed(1);
    a.workflow_run_ids = vec!["run-a".into()];
    let mut b = completed(2);
    b.workflow_run_ids = vec!["run-b".into(), "run-c".into()];
    m.report(&token, "main", a, t(10, 11)).unwrap();
    m.report(&token, "win-1", b, t(10, 12)).unwrap();
    let r = &history(&m)[0];
    assert_eq!(r.outcome, ScheduleRunOutcome::Completed);
    assert_eq!(
        r.started_at.as_deref(),
        Some(t(10, 10).to_rfc3339().as_str())
    );
    assert_eq!(r.duration_ms, Some(120_000));
    assert_eq!(r.workflow_run_ids, vec!["run-a", "run-b", "run-c"]);
}

#[test]
fn a_skipped_slot_has_no_start_or_duration() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    // Missed while closed.
    m.tick_all(t(12, 0), &Utc, &windows(&["main"]));
    let r = &history(&m)[0];
    assert_eq!(r.outcome, ScheduleRunOutcome::Skipped);
    assert!(r.message.as_deref().unwrap().contains("Missed"));
    assert!(r.started_at.is_none());
    assert!(r.duration_ms.is_none());
}

#[test]
fn a_paused_slot_records_nothing() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    m.set_paused(true, t(10, 5), &Utc).unwrap();
    m.tick_all(t(10, 10), &Utc, &windows(&["main"]));
    assert!(history(&m).is_empty());
}

#[test]
fn history_is_capped_and_survives_a_restart() {
    let dir = TempDir::new().unwrap();
    {
        let m = enabled_manager(&dir, MissedRunPolicy::Skip);
        let w = windows(&["main"]);
        for i in 0..(MAX_ATTEMPTS as u32 + 3) {
            let r = m.tick_all(t(10, 10) + Duration::minutes(10 * i as i64), &Utc, &w);
            let token = r.fires[0].token.clone();
            let at = t(10, 11) + Duration::minutes(10 * i as i64);
            m.report(&token, "main", completed(i + 1), at).unwrap();
        }
    }
    let m = ScheduleManager::new_test(dir.path());
    let h = history(&m);
    assert_eq!(h.len(), MAX_ATTEMPTS);
    let newest = format!("Ran on {} terminals", MAX_ATTEMPTS + 3);
    assert_eq!(h[0].message.as_deref(), Some(newest.as_str()));
}
