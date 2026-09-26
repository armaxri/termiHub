use serde::{Deserialize, Serialize};

/// The terminal state a macro playback ended in. Mirrors the frontend
/// `MacroPlaybackStatus` (`"completed" | "cancelled" | "error"`) so the
/// persisted record matches the playback outcome over the wire.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MacroRunStatus {
    /// Every step was injected.
    Completed,
    /// The playback was cancelled before all steps were injected.
    Cancelled,
    /// A target terminal stopped accepting input (disconnected / exited).
    Error,
}

/// What launched the playback. Mirrors the frontend `MacroRunOrigin`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MacroRunOrigin {
    /// Played from the Macros sidebar or the terminal's playback dialog.
    Manual,
    /// Played from the command palette.
    Palette,
    /// Replayed by a workflow's `run-macro` step.
    WorkflowStep,
    /// Fired by a schedule (PROD-043).
    Scheduled,
}

/// A single persisted, **metadata-only** record of a finished macro playback
/// (#3543). Deliberately never stores the macro's recorded input — only the
/// outcome, timing, targets, and provenance needed to browse recent playbacks.
///
/// The tag-less enums serialize as plain strings and every struct field is
/// camelCase, so the JSON shape matches the TypeScript `MacroRun` type exactly
/// (mirroring [`crate::workflows::history::WorkflowRun`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacroRun {
    /// Unique identifier for this run record.
    pub id: String,
    /// The id of the macro that was played.
    pub macro_id: String,
    /// The macro's name at run time (denormalized so history survives a later
    /// rename or deletion of the macro).
    pub macro_name: String,
    /// RFC 3339 timestamp of when the playback started.
    pub started_at: String,
    /// RFC 3339 timestamp of when the playback reached its terminal state.
    pub ended_at: String,
    /// The terminal state the playback ended in.
    pub status: MacroRunStatus,
    /// Steps injected before the playback ended.
    pub steps_played: u32,
    /// Total number of steps in the macro.
    pub total_steps: u32,
    /// Number of terminals the playback was started on.
    pub target_count: u32,
    /// Display labels (tab titles) of the target terminals, capped to
    /// [`crate::macros::history_manager::MAX_TARGET_LABELS`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_labels: Vec<String>,
    /// What launched the playback.
    pub origin: MacroRunOrigin,
    /// For a cancelled / errored playback: a human-readable reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Top-level schema for the `macro-runs.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroRunHistoryStore {
    /// Schema version, read on load and gated by the migration layer.
    pub version: String,
    /// All recorded runs, oldest first (append order). Displayed newest-first.
    pub runs: Vec<MacroRun>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for MacroRunHistoryStore {
    fn default() -> Self {
        Self {
            version: <Self as crate::utils::migrate::VersionedStore>::CURRENT_VERSION.to_string(),
            runs: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for MacroRunHistoryStore {
    const STORE_NAME: &'static str = "macro-runs.json";
    const CURRENT_VERSION: u32 = 1;

    /// Per-entry salvage (PER-004): drop only the individually-corrupt run
    /// records instead of resetting the whole browsable history.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, MacroRun>(raw, file_name, "runs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::migrate::VersionedStore;

    fn sample_run(id: &str) -> MacroRun {
        MacroRun {
            id: id.to_string(),
            macro_id: "macro-1".to_string(),
            macro_name: "Deploy".to_string(),
            started_at: "2026-09-20T00:00:00Z".to_string(),
            ended_at: "2026-09-20T00:00:05Z".to_string(),
            status: MacroRunStatus::Completed,
            steps_played: 3,
            total_steps: 3,
            target_count: 1,
            target_labels: vec!["prod-1".to_string()],
            origin: MacroRunOrigin::Manual,
            error: None,
        }
    }

    #[test]
    fn store_default_uses_current_version_and_is_empty() {
        let store = MacroRunHistoryStore::default();
        assert_eq!(
            store.version,
            MacroRunHistoryStore::CURRENT_VERSION.to_string()
        );
        assert!(store.runs.is_empty());
    }

    #[test]
    fn run_serializes_with_camel_case_keys_and_string_enums() {
        let run = sample_run("run-1");
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"macroId\":\"macro-1\""));
        assert!(json.contains("\"macroName\":\"Deploy\""));
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"endedAt\""));
        assert!(json.contains("\"stepsPlayed\":3"));
        assert!(json.contains("\"totalSteps\":3"));
        assert!(json.contains("\"targetCount\":1"));
        assert!(json.contains("\"targetLabels\":[\"prod-1\"]"));
        assert!(json.contains("\"status\":\"completed\""));
        assert!(json.contains("\"origin\":\"manual\""));
        assert!(!json.contains("\"error\""));

        let parsed: MacroRun = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, run);
    }

    #[test]
    fn record_never_carries_macro_step_content() {
        // The record type has no field that could hold recorded input: a
        // serialized record's keys are exactly the metadata fields.
        let run = MacroRun {
            error: Some("cancelled".into()),
            ..sample_run("r")
        };
        let value = serde_json::to_value(&run).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "endedAt",
                "error",
                "id",
                "macroId",
                "macroName",
                "origin",
                "startedAt",
                "status",
                "stepsPlayed",
                "targetCount",
                "targetLabels",
                "totalSteps",
            ]
        );
    }

    #[test]
    fn all_status_and_origin_kinds_round_trip() {
        for (status, wire) in [
            (MacroRunStatus::Completed, "\"completed\""),
            (MacroRunStatus::Cancelled, "\"cancelled\""),
            (MacroRunStatus::Error, "\"error\""),
        ] {
            assert_eq!(serde_json::to_string(&status).unwrap(), wire);
            let parsed: MacroRunStatus = serde_json::from_str(wire).unwrap();
            assert_eq!(parsed, status);
        }
        for (origin, wire) in [
            (MacroRunOrigin::Manual, "\"manual\""),
            (MacroRunOrigin::Palette, "\"palette\""),
            (MacroRunOrigin::WorkflowStep, "\"workflow-step\""),
            (MacroRunOrigin::Scheduled, "\"scheduled\""),
        ] {
            assert_eq!(serde_json::to_string(&origin).unwrap(), wire);
            let parsed: MacroRunOrigin = serde_json::from_str(wire).unwrap();
            assert_eq!(parsed, origin);
        }
    }

    #[test]
    fn run_defaults_absent_optionals_on_parse() {
        let raw = r#"{
            "id": "r",
            "macroId": "m",
            "macroName": "n",
            "startedAt": "2026-09-20T00:00:00Z",
            "endedAt": "2026-09-20T00:00:01Z",
            "status": "cancelled",
            "stepsPlayed": 0,
            "totalSteps": 2,
            "targetCount": 1,
            "origin": "scheduled"
        }"#;
        let run: MacroRun = serde_json::from_str(raw).unwrap();
        assert_eq!(run.status, MacroRunStatus::Cancelled);
        assert!(run.target_labels.is_empty());
        assert_eq!(run.error, None);
        assert_eq!(run.origin, MacroRunOrigin::Scheduled);
    }

    #[test]
    fn store_preserves_unknown_top_level_keys() {
        let raw = r#"{"version":"1","runs":[],"futureKey":{"a":1}}"#;
        let store: MacroRunHistoryStore = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&store).unwrap();
        assert_eq!(out["futureKey"]["a"], 1);
    }
}
