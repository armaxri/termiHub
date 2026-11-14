//! The optional schedule description (#5757): normalised to one line, blank
//! means none, capped in length, persisted, absent from older files, and
//! editing it never disables or re-times a schedule.

use super::tests::{enabled_manager, every, input, t};
use super::*;
use crate::schedules::config::MissedRunPolicy;
use crate::schedules::wire::MAX_DESCRIPTION_CHARS;
use chrono::Utc;
use tempfile::TempDir;

#[test]
fn a_description_is_saved_as_one_trimmed_line() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input("s1", every(5));
    i.description = Some("  Nightly\n  health   check ".to_string());
    let v = m.save(i, t(10, 0), &Utc).unwrap();
    assert_eq!(
        v.schedule.description.as_deref(),
        Some("Nightly health check")
    );
}

#[test]
fn a_blank_description_is_none_and_absent_on_the_wire() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input("s1", every(5));
    i.description = Some("   ".to_string());
    let v = m.save(i, t(10, 0), &Utc).unwrap();
    assert!(v.schedule.description.is_none());
    let json = serde_json::to_value(&v).unwrap();
    assert!(json.get("description").is_none(), "absent, not null");
}

#[test]
fn an_overlong_description_is_refused() {
    let dir = TempDir::new().unwrap();
    let m = ScheduleManager::new_test(dir.path());
    let mut i = input("s1", every(5));
    i.description = Some("x".repeat(MAX_DESCRIPTION_CHARS + 1));
    assert!(m.save(i, t(10, 0), &Utc).is_err());
    let mut ok = input("s1", every(5));
    ok.description = Some("x".repeat(MAX_DESCRIPTION_CHARS));
    assert!(m.save(ok, t(10, 0), &Utc).is_ok());
}

#[test]
fn the_description_persists_across_a_reload() {
    let dir = TempDir::new().unwrap();
    {
        let m = ScheduleManager::new_test(dir.path());
        let mut i = input("s1", every(5));
        i.description = Some("Checks the web hosts".to_string());
        m.save(i, t(10, 0), &Utc).unwrap();
    }
    let m = ScheduleManager::new_test(dir.path());
    let state = m.state(t(10, 0), &Utc).unwrap();
    assert_eq!(
        state.schedules[0].schedule.description.as_deref(),
        Some("Checks the web hosts")
    );
}

#[test]
fn an_older_file_without_descriptions_still_loads() {
    let json = serde_json::json!({
        "id": "s1",
        "name": "Legacy",
        "action": { "kind": "workflow", "workflowId": "wf" },
        "targets": { "kind": "connections", "connectionIds": ["c1"] },
        "rule": { "kind": "interval", "everyMinutes": 5 },
    });
    let s: Schedule = serde_json::from_value(json).unwrap();
    assert!(s.description.is_none());
    assert!(serde_json::to_value(&s)
        .unwrap()
        .get("description")
        .is_none());
}

#[test]
fn editing_the_description_keeps_the_schedule_enabled() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    let mut i = input("s1", every(10));
    i.description = Some("Now with notes".to_string());
    let v = m.save(i, t(10, 3), &Utc).unwrap();
    assert!(v.schedule.enabled);
    assert!(v.schedule.confirmed_at.is_some());
    assert_eq!(v.schedule.description.as_deref(), Some("Now with notes"));
    // Clearing it removes it.
    let v = m.save(input("s1", every(10)), t(10, 4), &Utc).unwrap();
    assert!(v.schedule.description.is_none());
}
