//! Persisted run history for the one-shot network diagnostic tools (PROD-032).
//!
//! Ping, traceroute, port scan, ping sweep, DNS lookup, open ports and
//! Wake-on-LAN results used to live only in a panel's React state, so they
//! vanished on re-run, panel close or app restart. Each finished run is now
//! recorded here as a bounded, self-contained [`NetworkToolRun`]: the tool, the
//! parameters it ran with (enough to re-run it), where it ran, when, how it
//! ended, a one-line summary and a size-capped result table.
//!
//! The bounds live in [`crate::network::tool_history_manager`]; this module is
//! only the on-disk shape. Everything stays on this computer — results can hold
//! hostnames and IP addresses, and nothing here is synced or sent anywhere.

use serde::{Deserialize, Serialize};

use crate::run_location::RunLocation;

/// The network tool a run belongs to. The kebab-case names are exactly the
/// frontend `NetworkTool` ids, so the JSON shape matches the TypeScript type.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkHistoryTool {
    /// ICMP/TCP ping.
    Ping,
    /// Traceroute.
    Traceroute,
    /// TCP port scanner.
    PortScanner,
    /// Subnet / range ping sweep.
    PingSweep,
    /// DNS lookup.
    DnsLookup,
    /// Listening-ports viewer.
    OpenPorts,
    /// Wake-on-LAN magic packet.
    Wol,
}

/// The terminal state a recorded run ended in. Mirrors the frontend
/// `DiagnosticStatus` terminal values.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkRunStatus {
    /// The run finished normally.
    Completed,
    /// The user stopped the run; the result holds what arrived until then.
    Canceled,
    /// The run failed; [`NetworkToolRun::error`] carries the reason.
    Error,
}

/// A run's results as a plain table — the same columns the tool's CSV export
/// uses — so the history view renders and exports every tool the same way.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRunResult {
    /// Column headers.
    pub columns: Vec<String>,
    /// Row cells (strings, numbers, booleans or null), one inner vec per row.
    pub rows: Vec<Vec<serde_json::Value>>,
    /// How many rows the run actually produced. Larger than `rows.len()` when
    /// the stored rows were trimmed to the per-run size cap.
    #[serde(default)]
    pub total_rows: u64,
}

/// One recorded, finished network-tool run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkToolRun {
    /// Unique identifier for this record.
    pub id: String,
    /// Which tool ran.
    pub tool: NetworkHistoryTool,
    /// The tool's input parameters (host, ports, interval, …) — opaque to the
    /// backend, used by the frontend to show and re-run the invocation.
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
    /// Where the tool ran: this computer or a named agent.
    #[serde(default)]
    pub run_location: RunLocation,
    /// RFC 3339 timestamp of when the run started.
    pub started_at: String,
    /// RFC 3339 timestamp of when the run reached its terminal state.
    pub ended_at: String,
    /// How the run ended.
    pub status: NetworkRunStatus,
    /// One-line human summary (e.g. "4/4 received, avg 12ms").
    #[serde(default)]
    pub summary: String,
    /// Failure reason for an [`NetworkRunStatus::Error`] run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The (possibly trimmed) result table; absent for tools with no rows
    /// (Wake-on-LAN) or a run that failed before producing any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<NetworkRunResult>,
}

/// Top-level schema for the `network-tool-history.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkToolHistoryStore {
    /// Schema version, read on load and gated by the migration layer. A
    /// version-less (hand-edited) file is read as v1.
    #[serde(default = "default_version")]
    pub version: String,
    /// All recorded runs, oldest first (append order). Displayed newest-first.
    pub runs: Vec<NetworkToolRun>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_version() -> String {
    "1".to_string()
}

impl Default for NetworkToolHistoryStore {
    fn default() -> Self {
        Self {
            version: default_version(),
            runs: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for NetworkToolHistoryStore {
    const STORE_NAME: &'static str = "network-tool-history.json";
    const CURRENT_VERSION: u32 = 1;

    /// Per-entry salvage (PER-004): drop only the individually-corrupt run
    /// records instead of resetting the whole history.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, NetworkToolRun>(raw, file_name, "runs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::migrate::{load_versioned, LoadOutcome};

    fn sample_run() -> NetworkToolRun {
        let mut params = serde_json::Map::new();
        params.insert("host".into(), serde_json::json!("example.com"));
        NetworkToolRun {
            id: "run-1".into(),
            tool: NetworkHistoryTool::PortScanner,
            params,
            run_location: RunLocation::Agent("agent-7".into()),
            started_at: "2026-09-20T00:00:00Z".into(),
            ended_at: "2026-09-20T00:00:05Z".into(),
            status: NetworkRunStatus::Canceled,
            summary: "1 open".into(),
            error: None,
            result: Some(NetworkRunResult {
                columns: vec!["host".into(), "port".into()],
                rows: vec![vec![
                    serde_json::json!("example.com"),
                    serde_json::json!(22),
                ]],
                total_rows: 1,
            }),
        }
    }

    #[test]
    fn run_serializes_with_frontend_shape() {
        let run = sample_run();
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"tool\":\"port-scanner\""));
        assert!(json.contains("\"status\":\"canceled\""));
        assert!(json.contains("\"runLocation\":{\"kind\":\"agent\",\"agentId\":\"agent-7\"}"));
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"totalRows\":1"));
        assert!(!json.contains("\"error\""));
        let parsed: NetworkToolRun = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, run);
    }

    #[test]
    fn all_tool_ids_match_frontend_network_tool_ids() {
        let expected = [
            (NetworkHistoryTool::Ping, "ping"),
            (NetworkHistoryTool::Traceroute, "traceroute"),
            (NetworkHistoryTool::PortScanner, "port-scanner"),
            (NetworkHistoryTool::PingSweep, "ping-sweep"),
            (NetworkHistoryTool::DnsLookup, "dns-lookup"),
            (NetworkHistoryTool::OpenPorts, "open-ports"),
            (NetworkHistoryTool::Wol, "wol"),
        ];
        for (tool, id) in expected {
            assert_eq!(serde_json::to_value(tool).unwrap(), serde_json::json!(id));
        }
    }

    #[test]
    fn minimal_record_defaults_optionals() {
        let raw = r#"{
            "id": "r", "tool": "wol",
            "startedAt": "2026-09-20T00:00:00Z", "endedAt": "2026-09-20T00:00:00Z",
            "status": "completed"
        }"#;
        let run: NetworkToolRun = serde_json::from_str(raw).unwrap();
        assert_eq!(run.run_location, RunLocation::ThisComputer);
        assert!(run.params.is_empty());
        assert!(run.result.is_none());
        assert_eq!(run.summary, "");
    }

    #[test]
    fn versionless_file_loads_as_v1() {
        let raw = r#"{"runs": []}"#;
        match load_versioned::<NetworkToolHistoryStore>(raw) {
            LoadOutcome::Loaded { data, .. } => assert!(data.runs.is_empty()),
            _ => panic!("a version-less file must load as v1"),
        }
    }

    #[test]
    fn newer_version_is_reported_not_parsed() {
        let raw = r#"{"version": "2", "runs": [], "futureField": true}"#;
        assert!(matches!(
            load_versioned::<NetworkToolHistoryStore>(raw),
            LoadOutcome::Newer(_)
        ));
    }

    #[test]
    fn unknown_top_level_keys_survive_round_trip() {
        let raw = r#"{"version": "1", "runs": [], "addedLater": {"x": 1}}"#;
        let store: NetworkToolHistoryStore = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&store).unwrap();
        assert_eq!(out["addedLater"], serde_json::json!({"x": 1}));
    }
}
