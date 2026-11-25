//! Persisted model of scheduled runs (PROD-043): `schedules.json`.
//!
//! Every struct is camelCase over the wire. The TypeScript DTOs in
//! `src/types/schedule.ts` are generated from these types via ts-rs (audit
//! DUP-030, #3088); `skip_serializing_if` fields are absent (not `null`) on the
//! wire, so they are emitted as optional `field?: T`.

use serde::{Deserialize, Serialize};

use crate::automations::config::LegacySource;

/// A weekday, serialised as a lowercase three-letter string (`mon` … `sun`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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

/// What a schedule runs (schema v3, #5818 slice 10): one stored automation.
///
/// Up to v2 a schedule ran either a macro or a workflow; the v2 → v3
/// migration (`super::migrate`) turns both into this single kind, following
/// the ids the automation migration changed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScheduleAction {
    /// A stored automation, run on every target.
    #[serde(rename_all = "camelCase")]
    Automation {
        /// The automation's id.
        automation_id: String,
        /// Set only while the migration from a v2 action could not yet check
        /// the id against `automations.json` (a restored backup, or a boot
        /// whose automation migration failed): the legacy kind it named. The
        /// next boot resolves and removes it; until then a run is skipped
        /// unless the automation came from that kind, so a macro schedule
        /// never runs a workflow that has the same id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        legacy_source: Option<LegacySource>,
    },
}

impl ScheduleAction {
    /// The id of the automation this action runs.
    pub fn automation_id(&self) -> &str {
        match self {
            ScheduleAction::Automation { automation_id, .. } => automation_id,
        }
    }
}

/// Which terminals a scheduled run types into. Always explicit: the run goes
/// to the open, connected terminals of these saved connections — never to
/// "whatever tab is active".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunResult {
    /// RFC 3339 time the attempt settled.
    pub at: String,
    /// RFC 3339 time the run fired. Absent for a skipped due slot (nothing
    /// started) and for results recorded before schema v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub started_at: Option<String>,
    /// Milliseconds from firing to settling (fired runs only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub duration_ms: Option<u64>,
    /// Ids of the automation run-history records this attempt produced (one
    /// per terminal or window the automation ran in). Empty for skips. Schema
    /// v3 merges the v2 `workflowRunIds` / `macroRunIds` into this list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub run_ids: Vec<String>,
    /// How it ended.
    pub outcome: ScheduleRunOutcome,
    /// Human-readable detail (the skip reason, the failure, the target count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub message: Option<String>,
    /// `true` when this was a catch-up run for a missed slot.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub catch_up: bool,
    /// Present only for a skipped slot that was missed (termiHub was closed or
    /// the computer was asleep, #6024): RFC 3339 time the run was due.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub missed_due_at: Option<String>,
}

/// A stored schedule.
///
/// The user-editable part is `name`, `description`, `action`, `targets`, `rule`,
/// `missed_runs` and `connect_if_needed`. Everything else is owned by the
/// backend: a schedule is created **disabled**, is enabled only through
/// `set_schedule_enabled` (the first enable must carry the user's confirmation
/// of the targets), and loses its enabled state + confirmation whenever its
/// action or targets change, or it newly opts into connecting its targets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Unique schedule id.
    pub id: String,
    /// User-facing name.
    pub name: String,
    /// Optional short description the user wrote (#5757), shown muted under
    /// the name. Absent when unset, so older files round-trip unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    /// What to run.
    pub action: ScheduleAction,
    /// Where to run it.
    pub targets: ScheduleTargets,
    /// When to run it.
    pub rule: ScheduleRule,
    /// Missed-run handling (default: skip).
    #[serde(default)]
    pub missed_runs: MissedRunPolicy,
    /// "Connect if not connected" (#3527, opt-in, default off): a target saved
    /// connection with no connected terminal is connected **unattended** first
    /// — stored credentials / key auth and an already-trusted host key only,
    /// never a prompt — and the tab it opened is closed after the run. A target
    /// that would need input is skipped with the reason.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub connect_if_needed: bool,
    /// Whether the schedule fires. Always `false` for a new schedule.
    #[serde(default)]
    pub enabled: bool,
    /// RFC 3339 time the user confirmed the targets on first enable; `None`
    /// until then (and again after the action/targets change).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub confirmed_at: Option<String>,
    /// RFC 3339 time the schedule was last enabled — the interval anchor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub enabled_at: Option<String>,
    /// RFC 3339 time the schedule last fired (the missed-run anchor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_run_at: Option<String>,
    /// The most recent run attempt's result (also `history[0]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_result: Option<ScheduleRunResult>,
    /// The recent run attempts, newest first, capped at
    /// [`crate::schedules::history::MAX_ATTEMPTS`] (schema v2).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<ScheduleRunResult>>", optional))]
    pub history: Vec<ScheduleRunResult>,
    /// RFC 3339 creation time.
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 last-update time.
    #[serde(default)]
    pub updated_at: String,
    /// Keys of this schedule that this build does not know, kept verbatim
    /// (PER-010, #5983): an edit, an enable or a run rewrites the file.
    #[serde(flatten, default)]
    #[cfg_attr(test, ts(skip))]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
    ///
    /// v3 (#5818 slice 10) runs automations: the macro and workflow actions
    /// become `automation` and the two run-id lists merge into `runIds`. A v2
    /// build refuses to overwrite a v3 file the same way. The boot migration
    /// (`super::migrate::migrate_schedules`) does this step with the id map of
    /// `automations.json`; this in-memory path (a restored backup, or a boot
    /// whose automation migration failed) keeps the id and marks the action
    /// with its `legacySource`, for the boot migration to resolve.
    const CURRENT_VERSION: u32 = 3;

    fn migrate(
        mut value: serde_json::Value,
        from_version: u32,
    ) -> anyhow::Result<serde_json::Value> {
        if from_version < 2 {
            value = crate::schedules::history::migrate_v1_to_v2(value);
        }
        if from_version < 3 {
            value = crate::schedules::migrate::migrate_v2_to_v3(value, None);
        }
        Ok(value)
    }

    /// Per-entry salvage (PER-004): drop only the corrupt schedules.
    fn salvage(value: serde_json::Value, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, Schedule>(value, file_name, "schedules")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_round_trips_with_camel_case_and_kebab_tags() {
        let json = r#"{"id":"s1","name":"Health","action":{"kind":"automation","automationId":"wf"},"targets":{"kind":"broadcast-group","groupId":"g1"},"rule":{"kind":"weekly","days":["mon","fri"],"time":"09:30"},"missedRuns":"run-once","enabled":true,"confirmedAt":"2026-09-26T00:00:00Z","createdAt":"c","updatedAt":"u"}"#;
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
        let json = r#"{"id":"s","name":"n","action":{"kind":"automation","automationId":"m"},"targets":{"kind":"connections","connectionIds":["c"]},"rule":{"kind":"interval","everyMinutes":5}}"#;
        let parsed: Schedule = serde_json::from_str(json).unwrap();
        assert!(!parsed.enabled);
        assert_eq!(parsed.missed_runs, MissedRunPolicy::Skip);
        assert!(parsed.confirmed_at.is_none());
    }

    #[test]
    fn store_preserves_unknown_top_level_keys() {
        let json = r#"{"version":"3","paused":true,"schedules":[],"futureKey":{"a":1}}"#;
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
            run_ids: Vec::new(),
            outcome: ScheduleRunOutcome::Skipped,
            message: Some("why".into()),
            catch_up: false,
            missed_due_at: None,
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(!s.contains("catchUp"));
        assert!(!s.contains("startedAt"));
        assert!(!s.contains("durationMs"));
        assert!(!s.contains("runIds"));
        assert!(s.contains("\"outcome\":\"skipped\""));
    }
}
