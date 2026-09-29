//! "Connect if not connected" (#3527): the opt-in is off by default,
//! persisted, backward-compatible, re-confirmed when newly turned on, and names
//! exactly one connecting window in the fire.

use super::tests::{
    completed, enabled_manager, every, input, last_result, skip_report, t, windows, TickAll,
};
use super::*;
use crate::schedules::config::{MissedRunPolicy, ScheduleRunOutcome};
use chrono::Utc;
use tempfile::TempDir;

#[test]
fn the_opt_in_is_off_by_default_and_the_fire_names_no_connect_window() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let state = m.state(t(10, 0), &Utc).unwrap();
    assert!(!state.schedules[0].schedule.connect_if_needed);
    let fire = &m.tick_all(t(10, 10), &Utc, &windows(&["main"])).fires[0];
    assert_eq!(fire.connect_window, None);
    let json = serde_json::to_value(fire).unwrap();
    assert!(json.get("connectWindow").is_none(), "absent, not null");
}

#[test]
fn the_opt_in_is_persisted_and_the_main_window_connects() {
    let dir = TempDir::new().unwrap();
    {
        let m = ScheduleManager::new_test(dir.path());
        let mut i = input("s1", every(10));
        i.connect_if_needed = true;
        let v = m.save(i, t(10, 0), &Utc).unwrap();
        assert!(v.schedule.connect_if_needed);
        m.set_enabled("s1", true, true, t(10, 0), &Utc).unwrap();
    }
    let m = ScheduleManager::new_test(dir.path());
    assert!(
        m.state(t(10, 0), &Utc).unwrap().schedules[0]
            .schedule
            .connect_if_needed
    );
    let fires = m
        .tick_all(t(10, 10), &Utc, &windows(&["aux-2", "main", "aux-1"]))
        .fires;
    assert_eq!(fires[0].connect_window.as_deref(), Some("main"));
    let json = serde_json::to_value(&fires[0]).unwrap();
    assert_eq!(json["connectWindow"], "main");
}

#[test]
fn without_the_main_window_the_first_listening_window_connects() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input("s1", every(10));
    i.connect_if_needed = true;
    m.save(i, t(10, 0), &Utc).unwrap();
    m.set_enabled("s1", true, true, t(10, 0), &Utc).unwrap();
    let fires = m
        .tick_all(t(10, 10), &Utc, &windows(&["win-b", "win-a"]))
        .fires;
    assert_eq!(fires[0].connect_window.as_deref(), Some("win-a"));
}

#[test]
fn turning_the_opt_in_on_needs_a_fresh_confirmation_but_off_does_not() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let mut on = input("s1", every(10));
    on.connect_if_needed = true;
    let v = m.save(on, t(10, 1), &Utc).unwrap();
    assert!(!v.schedule.enabled, "a wider reach disables the schedule");
    assert!(v.schedule.confirmed_at.is_none());
    m.set_enabled("s1", true, true, t(10, 2), &Utc).unwrap();

    let off = input("s1", every(10));
    let v = m.save(off, t(10, 3), &Utc).unwrap();
    assert!(v.schedule.enabled, "turning it off narrows the reach");
    assert!(!v.schedule.connect_if_needed);
}

#[test]
fn a_legacy_schedule_file_loads_with_the_opt_in_off() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("schedules.json"),
        r#"{"version":"2","paused":false,"schedules":[{"id":"old","name":"Old",
        "action":{"kind":"workflow","workflowId":"wf"},
        "targets":{"kind":"connections","connectionIds":["c"]},
        "rule":{"kind":"interval","everyMinutes":5},"enabled":true,
        "confirmedAt":"2026-06-01T10:00:00Z","enabledAt":"2026-06-01T10:00:00Z",
        "createdAt":"c","updatedAt":"u"}]}"#,
    )
    .unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let state = m.state(t(10, 0), &Utc).unwrap();
    assert_eq!(state.schedules.len(), 1);
    assert!(!state.schedules[0].schedule.connect_if_needed);
    assert!(state.schedules[0].schedule.enabled);
    // A save of the untouched store never writes the default-off key.
    let out = serde_json::to_value(&state.schedules[0].schedule).unwrap();
    assert!(out.get("connectIfNeeded").is_none());
}

#[test]
fn a_run_that_also_skipped_targets_records_why() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let token = m.tick_all(t(10, 10), &Utc, &windows(&["main"])).fires[0]
        .token
        .clone();
    let mut report = completed(1);
    report.message = Some("web-2: needs a password".to_string());
    assert!(m.report(&token, "main", report, t(10, 11)).unwrap());
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Completed);
    assert_eq!(
        res.message.as_deref(),
        Some("Ran on 1 terminal (web-2: needs a password)")
    );
}

#[test]
fn every_target_refused_records_a_skip_with_each_reason() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let token = m.tick_all(t(10, 10), &Utc, &windows(&["main"])).fires[0]
        .token
        .clone();
    let reason = "web-1: host key not trusted; web-2: credential store locked";
    m.report(&token, "main", skip_report(reason), t(10, 10))
        .unwrap();
    let res = last_result(&m);
    assert_eq!(res.outcome, ScheduleRunOutcome::Skipped);
    assert_eq!(res.message.as_deref(), Some(reason));
}
