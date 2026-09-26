//! Persisted model of scheduled runs (PROD-043): `schedules.json`.
//!
//! Every struct is camelCase over the wire and mirrors the TypeScript types in
//! `src/types/schedule.ts` byte-for-byte.

use serde::{Deserialize, Serialize};

/// A weekday, serialised as a lowercase three-letter string (`mon` … `sun`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleWeekday {
    /// Monday.
    Mon,
    /// Tuesday.
    Tue,
    /// Wednesday.
    Wed,
    /// Thursday.
    Thu,
    /// Friday.
    Fri,
    /// Saturday.
    Sat,
    /// Sunday.
    Sun,
}

impl ScheduleWeekday {
    /// The equivalent [`chrono::Weekday`].
    pub fn to_chrono(self) -> chrono::Weekday {
        match self {
            ScheduleWeekday::Mon => chrono::Weekday::Mon,
            ScheduleWeekday::Tue => chrono::Weekday::Tue,
            ScheduleWeekday::Wed => chrono::Weekday::Wed,
            ScheduleWeekday::Thu => chrono::Weekday::Thu,
            ScheduleWeekday::Fri => chrono::Weekday::Fri,
            ScheduleWeekday::Sat => chrono::Weekday::Sat,
            ScheduleWeekday::Sun => chrono::Weekday::Sun,
        }
    }
}

/// When a schedule fires. Times are **local wall-clock** `HH:MM` (24h) in the
/// machine's time zone; see [`crate::schedules::timing`] for the DST rules.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScheduleRule {
    /// Every `every_minutes` minutes (absolute time, unaffected by DST),
    /// counted from when the schedule was enabled.
    #[serde(rename_all = "camelCase")]
    Interval {
        /// Minutes between runs (at least [`crate::schedules::timing::MIN_INTERVAL_MINUTES`]).
        every_minutes: u32,
    },
    /// Every day at `time`.
    #[serde(rename_all = "camelCase")]
    Daily {
        /// Local wall-clock time, `HH:MM`.
        time: String,
    },
    /// On each of `days` at `time`.
    #[serde(rename_all = "camelCase")]
    Weekly {
        /// The weekdays to run on (at least one).
        days: Vec<ScheduleWeekday>,
        /// Local wall-clock time, `HH:MM`.
        time: String,
    },
}

/// What a schedule runs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScheduleAction {
    /// A stored workflow (the preferred target).
    #[serde(rename_all = "camelCase")]
    Workflow {
        /// The workflow's id.
        workflow_id: String,
    },
    /// A stored macro, played into every target.
    #[serde(rename_all = "camelCase")]
    Macro {
        /// The macro's id.
        macro_id: String,
    },
}

/// Which terminals a scheduled run types into. Always explicit: the run goes
/// to the open, connected terminals of these saved connections — never to
/// "whatever tab is active".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScheduleTargets {
    /// These saved connections.
    #[serde(rename_all = "camelCase")]
    Connections {
        /// Saved connection ids (at least one).
        connection_ids: Vec<String>,
    },
    /// The members of a saved broadcast group (resolved at run time).
    #[serde(rename_all = "camelCase")]
    BroadcastGroup {
        /// The broadcast group's id.
        group_id: String,
    },
}

/// What to do about a run that was due while the app was closed or the
/// machine was asleep.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MissedRunPolicy {
    /// Skip it (logged). The default.
    #[default]
    Skip,
    /// Run once as soon as the app is back (however many runs were missed).
    RunOnce,
}

/// How a scheduled run ended.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleRunOutcome {
    /// Ran on every connected target.
    Completed,
    /// At least one target's run failed.
    Failed,
    /// The run was cancelled.
    Cancelled,
    /// Nothing ran; `message` says why (not connected, previous run still
    /// active, missed while the app was closed, …).
    Skipped,
}

/// The recorded result of one run attempt of a schedule — a fired run or a
/// skipped due slot. The most recent is `Schedule::last_result`; the last
/// [`crate::schedules::history::MAX_ATTEMPTS`] are kept in `Schedule::history`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunResult {
    /// RFC 3339 time the attempt settled.
    pub at: String,
    /// RFC 3339 time the run fired. Absent for a skipped due slot (nothing
    /// started) and for results recorded before schema v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Milliseconds from firing to settling (fired runs only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Ids of the workflow run-history records this attempt produced (one per
    /// terminal a workflow ran on). Empty for macros and skips.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_run_ids: Vec<String>,
    /// How it ended.
    pub outcome: ScheduleRunOutcome,
    /// Human-readable detail (the skip reason, the failure, the target count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `true` when this was a catch-up run for a missed slot.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub catch_up: bool,
}

/// A stored schedule.
///
/// The user-editable part is `name`, `action`, `targets`, `rule` and
/// `missed_runs`. Everything else is owned by the backend: a schedule is
/// created **disabled**, is enabled only through `set_schedule_enabled` (the
/// first enable must carry the user's confirmation of the targets), and loses
/// its enabled state + confirmation whenever its action or targets change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Unique schedule id.
    pub id: String,
    /// User-facing name.
    pub name: String,
    /// What to run.
    pub action: ScheduleAction,
    /// Where to run it.
    pub targets: ScheduleTargets,
    /// When to run it.
    pub rule: ScheduleRule,
    /// Missed-run handling (default: skip).
    #[serde(default)]
    pub missed_runs: MissedRunPolicy,
    /// Whether the schedule fires. Always `false` for a new schedule.
    #[serde(default)]
    pub enabled: bool,
    /// RFC 3339 time the user confirmed the targets on first enable; `None`
    /// until then (and again after the action/targets change).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<String>,
    /// RFC 3339 time the schedule was last enabled — the interval anchor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_at: Option<String>,
    /// RFC 3339 time the schedule last fired (the missed-run anchor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    /// The most recent run attempt's result (also `history[0]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<ScheduleRunResult>,
    /// The recent run attempts, newest first, capped at
    /// [`crate::schedules::history::MAX_ATTEMPTS`] (schema v2).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<ScheduleRunResult>,
    /// RFC 3339 creation time.
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 last-update time.
    #[serde(default)]
    pub updated_at: String,
}

/// Top-level schema for `schedules.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStore {
    /// Schema version, gated by the migration layer.
    pub version: String,
    /// Global pause switch: while `true`, no schedule fires (due runs are
    /// skipped, not queued).
    #[serde(default)]
    pub paused: bool,
    /// All schedules.
    #[serde(default)]
    pub schedules: Vec<Schedule>,
    /// Unknown top-level keys, preserved verbatim for forward compatibility
    /// (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for ScheduleStore {
    fn default() -> Self {
        Self {
            version: <Self as crate::utils::migrate::VersionedStore>::CURRENT_VERSION.to_string(),
            paused: false,
            schedules: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for ScheduleStore {
    const STORE_NAME: &'static str = "schedules.json";
    /// v2 (#3528) adds the per-schedule attempt `history`. The v1 → v2 step
    /// seeds each schedule's history with its `lastResult`; the bump is what
    /// makes the change downgrade-safe: a v1 build refuses to overwrite a v2
    /// file (PER-004) instead of silently dropping every schedule's history.
    const CURRENT_VERSION: u32 = 2;

    fn migrate(value: serde_json::Value, from_version: u32) -> anyhow::Result<serde_json::Value> {
        Ok(if from_version < 2 {
            crate::schedules::history::migrate_v1_to_v2(value)
        } else {
            value
        })
    }

    /// Per-entry salvage (PER-004): drop only the corrupt schedules.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, Schedule>(raw, file_name, "schedules")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_round_trips_with_camel_case_and_kebab_tags() {
        let json = r#"{"id":"s1","name":"Health","action":{"kind":"workflow","workflowId":"wf"},"targets":{"kind":"broadcast-group","groupId":"g1"},"rule":{"kind":"weekly","days":["mon","fri"],"time":"09:30"},"missedRuns":"run-once","enabled":true,"confirmedAt":"2026-09-26T00:00:00Z","createdAt":"c","updatedAt":"u"}"#;
        let parsed: Schedule = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.missed_runs, MissedRunPolicy::RunOnce);
        assert_eq!(
            parsed.rule,
            ScheduleRule::Weekly {
                days: vec![ScheduleWeekday::Mon, ScheduleWeekday::Fri],
                time: "09:30".to_string()
            }
        );
        let back: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&parsed).unwrap()).unwrap();
        let orig: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(back, orig);
    }

    #[test]
    fn minimal_schedule_defaults_to_disabled_and_skip() {
        let json = r#"{"id":"s","name":"n","action":{"kind":"macro","macroId":"m"},"targets":{"kind":"connections","connectionIds":["c"]},"rule":{"kind":"interval","everyMinutes":5}}"#;
        let parsed: Schedule = serde_json::from_str(json).unwrap();
        assert!(!parsed.enabled);
        assert_eq!(parsed.missed_runs, MissedRunPolicy::Skip);
        assert!(parsed.confirmed_at.is_none());
    }

    #[test]
    fn store_preserves_unknown_top_level_keys() {
        let json = r#"{"version":"2","paused":true,"schedules":[],"futureKey":{"a":1}}"#;
        let store: ScheduleStore = serde_json::from_str(json).unwrap();
        assert!(store.paused);
        let out = serde_json::to_value(&store).unwrap();
        assert_eq!(out["futureKey"]["a"], 1);
    }

    #[test]
    fn run_result_omits_false_catch_up() {
        let r = ScheduleRunResult {
            at: "t".into(),
            started_at: None,
            duration_ms: None,
            workflow_run_ids: Vec::new(),
            outcome: ScheduleRunOutcome::Skipped,
            message: Some("why".into()),
            catch_up: false,
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(!s.contains("catchUp"));
        assert!(!s.contains("startedAt"));
        assert!(!s.contains("durationMs"));
        assert!(!s.contains("workflowRunIds"));
        assert!(s.contains("\"outcome\":\"skipped\""));
    }
}
