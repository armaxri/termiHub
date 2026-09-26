//! Persisted check history for the HTTP monitors (PROD-032 follow-up, #3462).
//!
//! An HTTP monitor polls its URL continuously, and each monitor's rolling buffer
//! of checks used to live only in the panel's React state — so a monitor's chart
//! and "Recent Checks" table were empty again after a stop/resume or an app
//! restart. Unlike the one-shot tools ([`super::tool_history`]), a monitor's
//! history is a **time series**, so it is stored as one [`HttpMonitorSeries`]
//! per monitor id — the same id as the monitor's entry in `http-monitors.json`.
//!
//! Checks are recorded on the backend for desktop-hosted and agent-hosted
//! monitors alike (see [`super::monitor_history_manager`]), so the history does
//! not depend on the panel being open. The bounds live in the manager; this
//! module is only the on-disk shape. Everything stays on this computer.

use serde::{Deserialize, Serialize};

use super::http_monitor::HttpCheckResult;

/// Schema version written by this binary. [`HttpMonitorHistoryStore::default`]
/// and the [`VersionedStore`](crate::utils::migrate::VersionedStore) gate both
/// read it, so they can never disagree.
pub const HTTP_MONITOR_HISTORY_VERSION: u32 = 1;

/// One recorded HTTP check. The monitor id lives on the owning
/// [`HttpMonitorSeries`], so it is not repeated per check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpMonitorCheck {
    /// When the check completed (Unix epoch milliseconds).
    pub timestamp_ms: u64,
    /// The HTTP status code, when a response arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    /// The response latency in milliseconds, when a response arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Whether the check passed (expected status within the timeout).
    pub ok: bool,
    /// The failure reason for a failed check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HttpMonitorCheck {
    /// Project a live check result into its stored form (drops the monitor id).
    pub fn from_result(result: &HttpCheckResult) -> Self {
        Self {
            timestamp_ms: result.timestamp_ms,
            status_code: result.status_code,
            latency_ms: result.latency_ms,
            ok: result.ok,
            error: result.error.clone(),
        }
    }

    /// Re-attach the owning monitor id — the shape the frontend already
    /// consumes for live checks, so history and live checks render the same.
    pub fn to_result(&self, monitor_id: &str) -> HttpCheckResult {
        HttpCheckResult {
            monitor_id: monitor_id.to_string(),
            status_code: self.status_code,
            latency_ms: self.latency_ms,
            ok: self.ok,
            error: self.error.clone(),
            timestamp_ms: self.timestamp_ms,
        }
    }
}

/// One monitor's recorded checks, oldest first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpMonitorSeries {
    /// The monitor id (matches the monitor's `http-monitors.json` entry). Named
    /// `id` so a backup merges series by monitor.
    pub id: String,
    /// The recorded checks, oldest first (append order).
    #[serde(default)]
    pub checks: Vec<HttpMonitorCheck>,
}

impl HttpMonitorSeries {
    /// The newest check's timestamp, or `0` for an empty series.
    pub fn last_timestamp_ms(&self) -> u64 {
        self.checks.last().map(|c| c.timestamp_ms).unwrap_or(0)
    }
}

/// Top-level schema for the `http-monitor-history.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpMonitorHistoryStore {
    /// Schema version, read on load and gated by the migration layer. A
    /// version-less (hand-edited) file is read as v1.
    #[serde(default = "default_version")]
    pub version: String,
    /// One series per monitor.
    #[serde(default)]
    pub monitors: Vec<HttpMonitorSeries>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_version() -> String {
    // A version-less file predates versioning, i.e. it is v1.
    "1".to_string()
}

impl Default for HttpMonitorHistoryStore {
    fn default() -> Self {
        Self {
            version: HTTP_MONITOR_HISTORY_VERSION.to_string(),
            monitors: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for HttpMonitorHistoryStore {
    const STORE_NAME: &'static str = "http-monitor-history.json";
    const CURRENT_VERSION: u32 = HTTP_MONITOR_HISTORY_VERSION;

    /// Per-entry salvage (PER-004): drop only the individually-corrupt monitor
    /// series instead of resetting every monitor's history.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, HttpMonitorSeries>(
            raw, file_name, "monitors",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::migrate::{load_versioned, LoadOutcome, VersionedStore};

    #[test]
    fn default_uses_the_current_version() {
        assert_eq!(
            HttpMonitorHistoryStore::default().version,
            <HttpMonitorHistoryStore as VersionedStore>::CURRENT_VERSION.to_string()
        );
    }

    #[test]
    fn check_serializes_compactly_with_camel_case() {
        let check = HttpMonitorCheck {
            timestamp_ms: 42,
            status_code: Some(200),
            latency_ms: Some(12),
            ok: true,
            error: None,
        };
        let json = serde_json::to_string(&check).unwrap();
        assert_eq!(
            json,
            r#"{"timestampMs":42,"statusCode":200,"latencyMs":12,"ok":true}"#
        );
        let parsed: HttpMonitorCheck = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, check);
    }

    #[test]
    fn result_round_trips_through_the_stored_form() {
        let result = HttpCheckResult {
            monitor_id: "mon-1".into(),
            status_code: None,
            latency_ms: None,
            ok: false,
            error: Some("timeout".into()),
            timestamp_ms: 7,
        };
        let stored = HttpMonitorCheck::from_result(&result);
        let back = stored.to_result("mon-1");
        assert_eq!(back.monitor_id, "mon-1");
        assert_eq!(back.error.as_deref(), Some("timeout"));
        assert!(!back.ok);
        assert_eq!(back.timestamp_ms, 7);
    }

    #[test]
    fn versionless_file_loads_as_v1() {
        match load_versioned::<HttpMonitorHistoryStore>(r#"{"monitors": []}"#) {
            LoadOutcome::Loaded { data, .. } => assert!(data.monitors.is_empty()),
            _ => panic!("a version-less file must load as v1"),
        }
    }

    #[test]
    fn newer_version_is_reported_not_parsed() {
        let raw = r#"{"version": "2", "monitors": [], "futureField": true}"#;
        assert!(matches!(
            load_versioned::<HttpMonitorHistoryStore>(raw),
            LoadOutcome::Newer(_)
        ));
    }

    #[test]
    fn unknown_top_level_keys_survive_round_trip() {
        let raw = r#"{"version": "1", "monitors": [], "addedLater": {"x": 1}}"#;
        let store: HttpMonitorHistoryStore = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&store).unwrap();
        assert_eq!(out["addedLater"], serde_json::json!({"x": 1}));
    }
}
