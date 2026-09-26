//! Per-schedule attempt history (#3528).
//!
//! Every settled run attempt of a schedule — a fired run's aggregated result or
//! a skipped due slot (not connected, previous run still in progress, missed
//! while the app was closed, …) — is recorded as the schedule's `lastResult`
//! **and** pushed onto its `history`, newest first, capped at [`MAX_ATTEMPTS`].
//! So a burst of skips no longer overwrites the one result the user could see.
//!
//! The log lives inside `schedules.json` (schema v2): at most
//! `MAX_ATTEMPTS` small, metadata-only records per schedule (a few KiB), so a
//! separate store would buy nothing but a second file to keep consistent. A
//! global pause deliberately records nothing — an interval schedule paused for
//! a day would otherwise flush every meaningful attempt out of the log.

use serde_json::Value;

use super::config::{Schedule, ScheduleRunResult};

/// How many recent attempts each schedule keeps.
pub const MAX_ATTEMPTS: usize = 20;

/// Record a settled attempt: it becomes the schedule's `last_result` and the
/// newest entry of its capped `history`.
pub fn record(s: &mut Schedule, result: ScheduleRunResult) {
    s.history.insert(0, result.clone());
    s.history.truncate(MAX_ATTEMPTS);
    s.last_result = Some(result);
}

/// Schema v1 → v2: seed each schedule's `history` with its `lastResult` (a v1
/// file only knew the latest attempt) and stamp version `"2"`. A schedule that
/// already carries a `history` (hand-edited / partially upgraded) is left as-is.
pub fn migrate_v1_to_v2(mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    if let Some(schedules) = obj.get_mut("schedules").and_then(Value::as_array_mut) {
        for schedule in schedules.iter_mut().filter_map(Value::as_object_mut) {
            if schedule.contains_key("history") {
                continue;
            }
            if let Some(last) = schedule.get("lastResult").filter(|v| v.is_object()) {
                let seeded = Value::Array(vec![last.clone()]);
                schedule.insert("history".to_string(), seeded);
            }
        }
    }
    obj.insert("version".to_string(), Value::String("2".to_string()));
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedules::config::{ScheduleRunOutcome, ScheduleStore};
    use crate::utils::migrate::{load_versioned, LoadOutcome};
    use serde_json::json;

    fn schedule() -> Schedule {
        serde_json::from_value(json!({"id":"s","name":"n",
            "action":{"kind":"macro","macroId":"m"},
            "targets":{"kind":"connections","connectionIds":["c"]},
            "rule":{"kind":"interval","everyMinutes":5}}))
        .unwrap()
    }

    fn attempt(i: usize) -> ScheduleRunResult {
        ScheduleRunResult {
            at: format!("t{i}"),
            started_at: None,
            duration_ms: None,
            workflow_run_ids: Vec::new(),
            outcome: ScheduleRunOutcome::Skipped,
            message: Some(format!("skip {i}")),
            catch_up: false,
        }
    }

    #[test]
    fn record_sets_last_result_and_prepends_to_history() {
        let mut s = schedule();
        record(&mut s, attempt(1));
        record(&mut s, attempt(2));
        assert_eq!(s.last_result, Some(attempt(2)));
        assert_eq!(s.history, vec![attempt(2), attempt(1)]);
    }

    #[test]
    fn history_is_capped_to_the_newest_attempts() {
        let mut s = schedule();
        for i in 0..MAX_ATTEMPTS + 5 {
            record(&mut s, attempt(i));
        }
        assert_eq!(s.history.len(), MAX_ATTEMPTS);
        assert_eq!(s.history[0], attempt(MAX_ATTEMPTS + 4));
        assert_eq!(s.history[MAX_ATTEMPTS - 1], attempt(5));
    }

    #[test]
    fn an_empty_history_is_not_serialized() {
        let out = serde_json::to_value(schedule()).unwrap();
        assert!(out.get("history").is_none());
    }

    #[test]
    fn v1_file_migrates_seeding_history_from_last_result() {
        let raw = json!({"version":"1","paused":false,"schedules":[
            {"id":"a","name":"n","action":{"kind":"macro","macroId":"m"},
             "targets":{"kind":"connections","connectionIds":["c"]},
             "rule":{"kind":"interval","everyMinutes":5},
             "lastResult":{"at":"t","outcome":"skipped","message":"why"}},
            {"id":"b","name":"n","action":{"kind":"macro","macroId":"m"},
             "targets":{"kind":"connections","connectionIds":["c"]},
             "rule":{"kind":"interval","everyMinutes":5}}]})
        .to_string();
        let LoadOutcome::Loaded {
            data,
            migrated_from,
        } = load_versioned::<ScheduleStore>(&raw)
        else {
            panic!("a v1 file loads");
        };
        assert_eq!(migrated_from, Some(1));
        assert_eq!(data.version, "2");
        let a = &data.schedules[0];
        assert_eq!(a.history.len(), 1);
        assert_eq!(Some(&a.history[0]), a.last_result.as_ref());
        assert_eq!(a.history[0].message.as_deref(), Some("why"));
        assert!(data.schedules[1].history.is_empty());
    }

    #[test]
    fn migration_keeps_an_existing_history() {
        let v = migrate_v1_to_v2(json!({"version":"1","schedules":[
            {"id":"a","lastResult":{"at":"new"},"history":[{"at":"old"}]}]}));
        assert_eq!(v["schedules"][0]["history"], json!([{"at":"old"}]));
        assert_eq!(v["version"], "2");
    }

    #[test]
    fn migration_tolerates_odd_shapes() {
        assert_eq!(migrate_v1_to_v2(json!([1])), json!([1]));
        let v = migrate_v1_to_v2(json!({"version":"1","schedules":[1, {"id":"x"}]}));
        assert_eq!(v["schedules"], json!([1, {"id":"x"}]));
    }
}
