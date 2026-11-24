//! Editing, enabling, pausing and running a schedule keep every field they do
//! not change (#5983).

use super::tests::{enabled_manager, every, input, t};
use super::*;
use crate::automations::config::LegacySource;
use crate::schedules::config::{MissedRunPolicy, ScheduleAction};
use chrono::Utc;
use serde_json::{json, Value};
use tempfile::TempDir;

const FILE: &str = "schedules.json";

/// A stored schedule with every field set, plus keys this build does not know.
fn stored() -> Value {
    json!({
        "id": "s1", "name": "Nightly", "description": "Checks the web hosts",
        "action": {"kind": "automation", "automationId": "a1", "legacySource": "macro"},
        "targets": {"kind": "connections", "connectionIds": ["c2", "c1"]},
        "rule": {"kind": "weekly", "days": ["fri", "mon"], "time": "03:15"},
        "missedRuns": "run-once", "connectIfNeeded": true,
        "enabled": true, "confirmedAt": "2026-06-01T08:00:00+00:00",
        "enabledAt": "2026-06-01T08:00:00+00:00", "lastRunAt": "2026-06-01T09:00:00+00:00",
        "lastResult": {"at": "t1", "outcome": "completed", "runIds": ["r1", "r2"]},
        "history": [{"at": "t1", "outcome": "completed", "runIds": ["r1", "r2"]}],
        "createdAt": "c", "updatedAt": "u",
        "futureFlag": true, "futureBlock": {"nested": [1, 2]}
    })
}

fn manager(dir: &TempDir, schedule: &Value) -> ScheduleManager {
    let doc = json!({"version": "3", "paused": false, "schedules": [schedule]});
    std::fs::write(dir.path().join(FILE), doc.to_string()).unwrap();
    ScheduleManager::new_test(dir.path())
}

fn on_disk(dir: &TempDir) -> Value {
    let raw = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
    serde_json::from_str::<Value>(&raw).unwrap()["schedules"][0].clone()
}

/// `stored` with `changes` applied and its update time masked.
fn expected(schedule: &Value, changes: Value) -> Value {
    let mut out = schedule.clone();
    for (key, value) in changes.as_object().unwrap() {
        out[key] = value.clone();
    }
    out["updatedAt"] = Value::Null;
    out
}

fn masked(mut schedule: Value) -> Value {
    schedule["updatedAt"] = Value::Null;
    schedule
}

/// What an editor that shows only the known fields sends for `schedule`.
fn edit_of(schedule: &Value) -> ScheduleInput {
    serde_json::from_value(schedule.clone()).unwrap()
}

#[test]
fn a_rename_changes_only_the_name() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir, &stored());
    let mut edit = edit_of(&stored());
    edit.name = "Renamed".into();
    m.save(edit, t(10, 0), &Utc).unwrap();
    assert_eq!(
        masked(on_disk(&dir)),
        expected(&stored(), json!({"name": "Renamed"}))
    );
}

#[test]
fn an_edit_that_does_not_send_legacy_source_keeps_it_and_the_confirmation() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir, &stored());
    let mut edit = edit_of(&stored());
    edit.action = ScheduleAction::Automation {
        automation_id: "a1".into(),
        legacy_source: None,
    };
    let view = m.save(edit, t(10, 0), &Utc).unwrap();
    assert_eq!(
        view.schedule.action,
        ScheduleAction::Automation {
            automation_id: "a1".into(),
            legacy_source: Some(LegacySource::Macro),
        }
    );
    assert!(view.schedule.enabled, "the same automation is no retarget");
    assert!(view.schedule.confirmed_at.is_some());
}

#[test]
fn picking_another_automation_drops_legacy_source_and_the_confirmation() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir, &stored());
    let mut edit = edit_of(&stored());
    edit.action = ScheduleAction::Automation {
        automation_id: "a2".into(),
        legacy_source: None,
    };
    let view = m.save(edit.clone(), t(10, 0), &Utc).unwrap();
    assert_eq!(view.schedule.action, edit.action);
    assert!(!view.schedule.enabled);
    assert!(view.schedule.confirmed_at.is_none());
}

#[test]
fn repeated_or_blank_stored_targets_are_no_retarget() {
    let dir = TempDir::new().unwrap();
    let mut schedule = stored();
    schedule["targets"]["connectionIds"] = json!(["c1", "c1", " "]);
    let m = manager(&dir, &schedule);
    let mut edit = edit_of(&schedule);
    edit.name = "Renamed".into();
    let view = m.save(edit, t(10, 0), &Utc).unwrap();
    assert!(view.schedule.enabled);
    assert!(view.schedule.confirmed_at.is_some());
}

#[test]
fn a_rename_with_the_same_rule_does_not_re_time_the_schedule() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir, &stored());
    let before = m.state(t(10, 0), &Utc).unwrap().schedules[0]
        .next_run_at
        .clone();
    let mut edit = edit_of(&stored());
    edit.name = "Renamed".into();
    let view = m.save(edit, t(10, 0), &Utc).unwrap();
    assert_eq!(view.next_run_at, before);
    assert_eq!(on_disk(&dir)["enabledAt"], stored()["enabledAt"]);
}

#[test]
fn disabling_and_enabling_change_only_that() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir, &stored());
    m.set_enabled("s1", false, false, t(10, 0), &Utc).unwrap();
    assert_eq!(
        masked(on_disk(&dir)),
        expected(&stored(), json!({"enabled": false}))
    );
    m.set_enabled("s1", true, false, t(10, 5), &Utc).unwrap();
    assert_eq!(
        masked(on_disk(&dir)),
        expected(&stored(), json!({"enabledAt": t(10, 5).to_rfc3339()}))
    );
}

#[test]
fn pausing_and_a_connection_rename_keep_every_other_field() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir, &stored());
    m.set_paused(true, t(10, 0), &Utc).unwrap();
    assert_eq!(on_disk(&dir), stored());

    let change = crate::connection::id_changes::ConnectionIdChange {
        old_id: "c1".into(),
        new_id: "moved/c1".into(),
    };
    let remap = crate::connection::id_changes::ConnectionIdRemap::new(&[change]);
    assert!(m.follow_connection_id_changes(&remap).unwrap());
    assert_eq!(on_disk(&dir), {
        let mut e = stored();
        e["targets"]["connectionIds"] = json!(["c2", "moved/c1"]);
        e
    });
}

#[test]
fn a_run_keeps_unknown_fields_and_earlier_run_links() {
    let dir = TempDir::new().unwrap();
    let mut schedule = stored();
    schedule["rule"] = json!({"kind": "interval", "everyMinutes": 10});
    schedule["enabledAt"] = json!(t(10, 0).to_rfc3339());
    schedule["lastRunAt"] = Value::Null;
    let m = manager(&dir, &schedule);
    m.mark_window_ready("main");
    let fired = m.tick(t(10, 10), &Utc, &["main".to_string()]);
    assert_eq!(fired.fires.len(), 1);
    let disk = on_disk(&dir);
    assert_eq!(disk["futureBlock"], schedule["futureBlock"]);
    assert_eq!(disk["history"], schedule["history"]);
    assert_eq!(disk["description"], schedule["description"]);
}

/// A new schedule never takes over keys it does not know.
#[test]
fn a_new_schedule_has_no_unknown_fields() {
    let dir = TempDir::new().unwrap();
    let m = enabled_manager(&dir, MissedRunPolicy::Skip);
    m.save(input("s2", every(5)), t(10, 0), &Utc).unwrap();
    let raw = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
    assert!(!raw.contains("extra"));
}
