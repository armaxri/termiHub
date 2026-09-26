//! Scheduler-authority tests: the safety rules and every tick decision.

use super::*;
use crate::schedules::config::{
    MissedRunPolicy, ScheduleAction, ScheduleRule, ScheduleRunOutcome, ScheduleRunResult,
    ScheduleWeekday,
};
use chrono::Utc;
use tempfile::TempDir;

fn t(h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 6, 1, h, m, 0).unwrap()
}

/// Tick with every given window registered as listening (the normal case).
trait TickAll {
    fn tick_all<Tz: TimeZone>(&self, now: DateTime<Utc>, tz: &Tz, w: &[String]) -> TickResult;
}

impl TickAll for ScheduleManager {
    fn tick_all<Tz: TimeZone>(&self, now: DateTime<Utc>, tz: &Tz, w: &[String]) -> TickResult {
        for label in w {
            self.mark_window_ready(label);
        }
        self.tick(now, tz, w)
    }
}

fn windows(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|s| s.to_string()).collect()
}

fn input(id: &str, rule: ScheduleRule) -> ScheduleInput {
    ScheduleInput {
        id: id.to_string(),
        name: "Health check".to_string(),
        action: ScheduleAction::Workflow {
            workflow_id: "wf-1".to_string(),
        },
        targets: ScheduleTargets::Connections {
            connection_ids: vec!["conn-a".to_string(), "conn-b".to_string()],
        },
        rule,
        missed_runs: MissedRunPolicy::Skip,
    }
}

fn every(m: u32) -> ScheduleRule {
    ScheduleRule::Interval { every_minutes: m }
}

fn completed(n: u32) -> WindowRunReport {
    WindowRunReport {
        outcome: ScheduleRunOutcome::Completed,
        message: None,
        targets_run: n,
    }
}

fn skip_report(msg: &str) -> WindowRunReport {
    WindowRunReport {
        outcome: ScheduleRunOutcome::Skipped,
        message: Some(msg.to_string()),
        targets_run: 0,
    }
}

/// A manager with one enabled 10-minute schedule, enabled at 10:00.
fn enabled_manager(dir: &TempDir, policy: MissedRunPolicy) -> ScheduleManager {
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input("s1", every(10));
    i.missed_runs = policy;
    m.save(i, t(10, 0), &Utc).unwrap();
    m.set_enabled("s1", true, true, t(10, 0), &Utc).unwrap();
    m
}

fn last_result(m: &ScheduleManager) -> ScheduleRunResult {
    m.state(t(0, 0), &Utc).unwrap().schedules[0]
        .schedule
        .last_result
        .clone()
        .expect("a recorded result")
}

// ── safety: disabled by default, confirmation, retargeting ─────────────

#[test]
fn a_new_schedule_is_created_disabled_and_unconfirmed() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let view = m.save(input("s1", every(5)), t(10, 0), &Utc).unwrap();
    assert!(!view.schedule.enabled);
    assert!(view.schedule.confirmed_at.is_none());
    assert!(view.next_run_at.is_none());
}

#[test]
fn first_enable_requires_confirmation() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    m.save(input("s1", every(5)), t(10, 0), &Utc).unwrap();
    let e = m
        .set_enabled("s1", true, false, t(10, 0), &Utc)
        .unwrap_err();
    assert!(e.to_string().contains("Confirm"));
    let v = m.set_enabled("s1", true, true, t(10, 0), &Utc).unwrap();
    assert!(v.schedule.enabled);
    assert!(v.schedule.confirmed_at.is_some());
    assert_eq!(
        v.next_run_at.as_deref(),
        Some(t(10, 5).to_rfc3339().as_str())
    );
    // Once confirmed, a later re-enable needs no new confirmation.
    m.set_enabled("s1", false, false, t(10, 1), &Utc).unwrap();
    assert!(m.set_enabled("s1", true, false, t(10, 2), &Utc).is_ok());
}

#[test]
fn changing_targets_or_action_disables_and_drops_confirmation() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let mut i = input("s1", every(10));
    i.targets = ScheduleTargets::BroadcastGroup {
        group_id: "g1".to_string(),
    };
    let v = m.save(i, t(10, 1), &Utc).unwrap();
    assert!(!v.schedule.enabled);
    assert!(v.schedule.confirmed_at.is_none());
    assert!(m.set_enabled("s1", true, false, t(10, 2), &Utc).is_err());

    let m2dir = TempDir::new().unwrap();
    let m2 = enabled_manager(&m2dir, MissedRunPolicy::Skip);
    let mut i = input("s1", every(10));
    i.action = ScheduleAction::Macro {
        macro_id: "mac".to_string(),
    };
    assert!(!m2.save(i, t(10, 1), &Utc).unwrap().schedule.enabled);
}

#[test]
fn renaming_or_retiming_keeps_the_schedule_enabled() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let mut i = input("s1", every(30));
    i.name = "Renamed".to_string();
    let v = m.save(i, t(10, 7), &Utc).unwrap();
    assert!(v.schedule.enabled);
    assert_eq!(v.schedule.name, "Renamed");
    // Re-timed from the edit, never a catch-up.
    assert_eq!(
        v.next_run_at.as_deref(),
        Some(t(10, 37).to_rfc3339().as_str())
    );
}

#[test]
fn save_refuses_invalid_input() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut blank = input("s", every(5));
    blank.name = "  ".to_string();
    assert!(m.save(blank, t(0, 0), &Utc).is_err());
    assert!(m.save(input("s", every(0)), t(0, 0), &Utc).is_err());
    let mut no_targets = input("s", every(5));
    no_targets.targets = ScheduleTargets::Connections {
        connection_ids: vec![" ".to_string()],
    };
    assert!(m.save(no_targets, t(0, 0), &Utc).is_err());
    let mut no_group = input("s", every(5));
    no_group.targets = ScheduleTargets::BroadcastGroup {
        group_id: String::new(),
    };
    assert!(m.save(no_group, t(0, 0), &Utc).is_err());
    let mut no_wf = input("s", every(5));
    no_wf.action = ScheduleAction::Workflow {
        workflow_id: String::new(),
    };
    assert!(m.save(no_wf, t(0, 0), &Utc).is_err());
    let weekly_no_days = ScheduleRule::Weekly {
        days: vec![],
        time: "09:00".to_string(),
    };
    assert!(m.save(input("s", weekly_no_days), t(0, 0), &Utc).is_err());
    assert!(m.state(t(0, 0), &Utc).unwrap().schedules.is_empty());
}

#[test]
fn save_generates_an_id_and_dedups_connections() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input("", every(5));
    i.targets = ScheduleTargets::Connections {
        connection_ids: vec!["a".into(), "a".into(), "b".into()],
    };
    let v = m.save(i, t(0, 0), &Utc).unwrap();
    assert!(v.schedule.id.starts_with("schedule-"));
    assert_eq!(
        v.schedule.targets,
        ScheduleTargets::Connections {
            connection_ids: vec!["a".into(), "b".into()]
        }
    );
}

#[test]
fn delete_removes_and_unknown_id_errors() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    m.delete("s1").unwrap();
    assert!(m.delete("s1").is_err());
    assert!(m
        .tick_all(t(10, 10), &Utc, &windows(&["main"]))
        .fires
        .is_empty());
}

// ── firing ─────────────────────────────────────────────────────────────

#[test]
fn fires_when_due_and_not_before() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main"]);
    assert!(m.tick_all(t(10, 9), &Utc, &w).fires.is_empty());
    let r = m.tick_all(t(10, 10), &Utc, &w);
    assert_eq!(r.fires.len(), 1);
    assert!(r.changed);
    let fire = &r.fires[0];
    assert_eq!(fire.schedule_id, "s1");
    assert!(!fire.catch_up);
    assert_eq!(
        fire.action,
        ScheduleAction::Workflow {
            workflow_id: "wf-1".into()
        }
    );
    let view = &m.state(t(10, 10), &Utc).unwrap().schedules[0];
    assert!(view.running);
    assert_eq!(
        view.next_run_at.as_deref(),
        Some(t(10, 20).to_rfc3339().as_str())
    );
}

#[test]
fn a_disabled_schedule_never_fires() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    m.save(input("s1", every(1)), t(10, 0), &Utc).unwrap();
    for minute in 0..30 {
        assert!(m
            .tick_all(t(10, minute), &Utc, &windows(&["main"]))
            .fires
            .is_empty());
    }
}

#[test]
fn no_overlap_skips_while_the_previous_run_is_in_flight() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main"]);
    let token = m.tick_all(t(10, 10), &Utc, &w).fires[0].token.clone();
    m.ack(&token, "main");
    // Next slot while still running → skipped + logged, not fired.
    let r = m.tick_all(t(10, 20), &Utc, &w);
    assert!(r.fires.is_empty());
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Skipped);
    assert!(res.message.unwrap().contains("still in progress"));
    // Report → settles, and the following slot fires again.
    assert!(m.report(&token, "main", completed(2), t(10, 21)).unwrap());
    assert_eq!(last_result(&m).outcome, ScheduleRunOutcome::Completed);
    assert_eq!(m.tick_all(t(10, 30), &Utc, &w).fires.len(), 1);
}

#[test]
fn a_run_settles_only_after_every_window_reported() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main", "win-1"]);
    let token = m.tick_all(t(10, 10), &Utc, &w).fires[0].token.clone();
    assert!(!m
        .report(
            &token,
            "main",
            skip_report("No target connected"),
            t(10, 10)
        )
        .unwrap());
    // A duplicate report from the same window is ignored.
    assert!(!m.report(&token, "main", completed(1), t(10, 10)).unwrap());
    assert!(m.report(&token, "win-1", completed(1), t(10, 11)).unwrap());
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Completed);
    assert_eq!(res.message.as_deref(), Some("Ran on 1 terminal"));
}

#[test]
fn disconnected_targets_everywhere_record_a_skip_with_the_reason() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main", "win-1"]);
    let token = m.tick_all(t(10, 10), &Utc, &w).fires[0].token.clone();
    let reason = "None of the target connections are connected";
    m.report(&token, "main", skip_report(reason), t(10, 10))
        .unwrap();
    m.report(&token, "win-1", skip_report(reason), t(10, 10))
        .unwrap();
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Skipped);
    assert_eq!(res.message.as_deref(), Some(reason));
}

#[test]
fn a_failure_in_any_window_marks_the_run_failed() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main", "win-1"]);
    let token = m.tick_all(t(10, 10), &Utc, &w).fires[0].token.clone();
    m.report(&token, "main", completed(2), t(10, 10)).unwrap();
    let failed = WindowRunReport {
        outcome: ScheduleRunOutcome::Failed,
        message: Some("step 2 failed".into()),
        targets_run: 1,
    };
    m.report(&token, "win-1", failed, t(10, 11)).unwrap();
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Failed);
    assert_eq!(
        res.message.as_deref(),
        Some("Ran on 3 terminals: step 2 failed")
    );
}

#[test]
fn unknown_tokens_and_windows_are_ignored() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    assert!(!m.report("nope", "main", completed(1), t(10, 0)).unwrap());
    let token = m.tick_all(t(10, 10), &Utc, &windows(&["main"])).fires[0]
        .token
        .clone();
    assert!(!m
        .report(&token, "stranger", completed(1), t(10, 10))
        .unwrap());
    assert!(m.state(t(10, 10), &Utc).unwrap().schedules[0].running);
}

#[test]
fn a_closed_window_no_longer_blocks_the_run() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let token = m
        .tick_all(t(10, 10), &Utc, &windows(&["main", "win-1"]))
        .fires[0]
        .token
        .clone();
    m.report(&token, "main", completed(1), t(10, 10)).unwrap();
    // win-1 closed before reporting: the next tick prunes it and settles.
    let r = m.tick_all(t(10, 11), &Utc, &windows(&["main"]));
    assert!(r.changed);
    assert_eq!(last_result(&m).outcome, ScheduleRunOutcome::Completed);
    assert!(!m.state(t(10, 11), &Utc).unwrap().schedules[0].running);
}

#[test]
fn a_run_nobody_settles_is_closed_as_failed_after_the_stale_timeout() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    m.save(input("s1", every(24 * 60)), t(0, 0), &Utc).unwrap();
    m.set_enabled("s1", true, true, t(0, 0), &Utc).unwrap();
    let w = windows(&["main"]);
    let fired = Utc.with_ymd_and_hms(2026, 6, 2, 0, 0, 0).unwrap();
    let token = m.tick_all(fired, &Utc, &w).fires[0].token.clone();
    m.ack(&token, "main");
    m.tick_all(fired + Duration::hours(5), &Utc, &w);
    assert!(m.state(fired, &Utc).unwrap().schedules[0].running);
    m.tick_all(fired + Duration::hours(6) + Duration::minutes(1), &Utc, &w);
    assert!(!m.state(fired, &Utc).unwrap().schedules[0].running);
    assert_eq!(last_result(&m).outcome, ScheduleRunOutcome::Failed);
}

#[test]
fn a_due_run_waits_until_a_window_is_listening() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main"]);
    // The window exists but its frontend has not registered yet (app boot).
    assert!(m.tick(t(10, 10), &Utc, &w).fires.is_empty());
    let v = &m.state(t(10, 10), &Utc).unwrap().schedules[0];
    assert!(v.schedule.last_result.is_none(), "held, not skipped");
    // It registers a few seconds later: the held slot fires on time.
    m.mark_window_ready("main");
    let r = m.tick(t(10, 10) + Duration::seconds(20), &Utc, &w);
    assert_eq!(r.fires.len(), 1);
    assert!(!r.fires[0].catch_up);
}

#[test]
fn a_window_that_never_acknowledges_is_dropped_from_the_run() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main", "win-1"]);
    let fired = t(10, 10);
    let token = m.tick_all(fired, &Utc, &w).fires[0].token.clone();
    m.ack(&token, "main");
    // win-1 was reloading and never received the fire.
    m.tick(fired + Duration::seconds(30), &Utc, &w);
    assert!(m.state(fired, &Utc).unwrap().schedules[0].running);
    m.tick(fired + Duration::seconds(61), &Utc, &w);
    assert!(
        m.state(fired, &Utc).unwrap().schedules[0].running,
        "main still owes a report"
    );
    m.report(&token, "main", completed(1), fired + Duration::seconds(62))
        .unwrap();
    assert_eq!(last_result(&m).outcome, ScheduleRunOutcome::Completed);
}

#[test]
fn a_run_nobody_acknowledges_settles_as_skipped() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let w = windows(&["main"]);
    m.tick_all(t(10, 10), &Utc, &w);
    m.tick(t(10, 11) + Duration::seconds(5), &Utc, &w);
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Skipped);
    assert!(!m.state(t(10, 12), &Utc).unwrap().schedules[0].running);
}

#[test]
fn a_closed_window_must_register_again() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    m.mark_window_ready("main");
    // "main" closed, then a new "main" opened (not yet listening).
    m.tick(t(10, 5), &Utc, &[]);
    assert!(m
        .tick(t(10, 10), &Utc, &windows(&["main"]))
        .fires
        .is_empty());
}

// ── missed runs: skip vs catch-up ───────────────────────────────────────

#[test]
fn a_run_within_the_grace_period_is_on_time() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let r = m.tick_all(t(10, 11), &Utc, &windows(&["main"]));
    assert_eq!(r.fires.len(), 1);
    assert!(!r.fires[0].catch_up);
}

#[test]
fn missed_runs_are_skipped_by_default() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    m.tick_all(t(10, 5), &Utc, &windows(&["main"]));
    // The machine slept from 10:05 to 11:03: the 10:10 … 11:00 slots passed.
    let r = m.tick_all(t(11, 3), &Utc, &windows(&["main"]));
    assert!(r.fires.is_empty());
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Skipped);
    assert!(res
        .message
        .unwrap()
        .contains("Missed the run due at 2026-06-01 10:10"));
    // Back on the regular cadence (anchor-aligned).
    let v = &m.state(t(11, 3), &Utc).unwrap().schedules[0];
    assert_eq!(
        v.next_run_at.as_deref(),
        Some(t(11, 10).to_rfc3339().as_str())
    );
    assert_eq!(
        m.tick_all(t(11, 10), &Utc, &windows(&["main"])).fires.len(),
        1
    );
}

#[test]
fn run_once_catches_up_exactly_once_however_many_slots_were_missed() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::RunOnce);
    m.tick_all(t(10, 5), &Utc, &windows(&["main"]));
    let r = m.tick_all(t(11, 3), &Utc, &windows(&["main"]));
    assert_eq!(r.fires.len(), 1);
    assert!(r.fires[0].catch_up);
    let token = r.fires[0].token.clone();
    m.report(&token, "main", completed(1), t(11, 4)).unwrap();
    assert!(last_result(&m).catch_up);
    // No second catch-up on the next tick.
    assert!(m
        .tick_all(t(11, 4), &Utc, &windows(&["main"]))
        .fires
        .is_empty());
}

#[test]
fn a_missed_daily_run_is_detected_after_an_app_restart() {
    let dir = TempDir::new().unwrap();
    {
        let m = ScheduleManager::new_test(dir.path());
        let mut i = input(
            "s1",
            ScheduleRule::Daily {
                time: "09:00".to_string(),
            },
        );
        i.missed_runs = MissedRunPolicy::RunOnce;
        m.save(i, t(8, 0), &Utc).unwrap();
        m.set_enabled("s1", true, true, t(8, 0), &Utc).unwrap();
        let token = m.tick_all(t(9, 0), &Utc, &windows(&["main"])).fires[0]
            .token
            .clone();
        m.report(&token, "main", completed(1), t(9, 1)).unwrap();
    }
    // App closed; reopened two days later at 12:00.
    let m = ScheduleManager::new_test(dir.path());
    let later = Utc.with_ymd_and_hms(2026, 6, 3, 12, 0, 0).unwrap();
    let r = m.tick_all(later, &Utc, &windows(&["main"]));
    assert_eq!(r.fires.len(), 1, "one catch-up for the missed slots");
    assert!(r.fires[0].catch_up);
    let v = &m.state(later, &Utc).unwrap().schedules[0];
    assert_eq!(
        v.next_run_at.as_deref(),
        Some(
            Utc.with_ymd_and_hms(2026, 6, 4, 9, 0, 0)
                .unwrap()
                .to_rfc3339()
                .as_str()
        )
    );
}

#[test]
fn enabling_never_catches_up_on_slots_from_before() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input(
        "s1",
        ScheduleRule::Daily {
            time: "09:00".to_string(),
        },
    );
    i.missed_runs = MissedRunPolicy::RunOnce;
    m.save(i, t(8, 0), &Utc).unwrap();
    m.set_enabled("s1", true, true, t(12, 0), &Utc).unwrap();
    assert!(m
        .tick_all(t(12, 0), &Utc, &windows(&["main"]))
        .fires
        .is_empty());
}

// ── global pause ───────────────────────────────────────────────────────

#[test]
fn global_pause_stops_firing_and_resume_does_not_replay() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::RunOnce);
    let w = windows(&["main"]);
    assert!(m.set_paused(true, t(10, 1), &Utc).unwrap().paused);
    for minute in [10, 20, 30, 40] {
        assert!(m.tick_all(t(10, minute), &Utc, &w).fires.is_empty());
    }
    let state = m.set_paused(false, t(10, 45), &Utc).unwrap();
    assert!(!state.paused);
    assert_eq!(
        state.schedules[0].next_run_at.as_deref(),
        Some(t(10, 50).to_rfc3339().as_str())
    );
    assert!(m.tick_all(t(10, 46), &Utc, &w).fires.is_empty());
    assert_eq!(m.tick_all(t(10, 50), &Utc, &w).fires.len(), 1);
}

#[test]
fn pause_survives_a_restart() {
    let dir = TempDir::new().unwrap();
    {
        let m = enabled_manager(&dir, MissedRunPolicy::Skip);
        m.set_paused(true, t(10, 1), &Utc).unwrap();
    }
    let m = ScheduleManager::new_test(dir.path());
    assert!(m.state(t(10, 1), &Utc).unwrap().paused);
    assert!(m
        .tick_all(t(10, 10), &Utc, &windows(&["main"]))
        .fires
        .is_empty());
}

// ── persistence ─────────────────────────────────────────────────────────

#[test]
fn state_and_results_persist_across_restarts() {
    let dir = TempDir::new().unwrap();
    {
        let m = enabled_manager(&dir, MissedRunPolicy::Skip);
        let token = m.tick_all(t(10, 10), &Utc, &windows(&["main"])).fires[0]
            .token
            .clone();
        m.report(&token, "main", completed(2), t(10, 11)).unwrap();
    }
    let m = ScheduleManager::new_test(dir.path());
    let v = &m.state(t(10, 12), &Utc).unwrap().schedules[0];
    assert!(v.schedule.enabled);
    assert!(v.schedule.confirmed_at.is_some());
    assert_eq!(
        v.schedule.last_run_at.as_deref(),
        Some(t(10, 10).to_rfc3339().as_str())
    );
    assert_eq!(
        v.schedule.last_result.as_ref().map(|r| r.outcome),
        Some(ScheduleRunOutcome::Completed)
    );
    assert_eq!(
        v.next_run_at.as_deref(),
        Some(t(10, 20).to_rfc3339().as_str())
    );
}

#[test]
fn weekly_schedule_in_a_dst_zone_reports_local_next_run() {
    use crate::schedules::timing::tests::{Berlin, DstTz};
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let tz = DstTz(Berlin);
    let rule = ScheduleRule::Weekly {
        days: vec![ScheduleWeekday::Sun],
        time: "02:30".into(),
    };
    let before = Utc.with_ymd_and_hms(2026, 3, 23, 0, 0, 0).unwrap();
    m.save(input("s1", rule), before, &tz).unwrap();
    let v = m.set_enabled("s1", true, true, before, &tz).unwrap();
    // 02:30 does not exist on 29 Mar in Berlin → 03:00 CEST = 01:00Z.
    let expected = Utc.with_ymd_and_hms(2026, 3, 29, 1, 0, 0).unwrap();
    assert_eq!(
        v.next_run_at.as_deref(),
        Some(expected.to_rfc3339().as_str())
    );
    assert_eq!(
        m.tick_all(expected, &tz, &windows(&["main"])).fires.len(),
        1
    );
}
