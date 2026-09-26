//! Bounded, persisted run history for the network diagnostic tools (PROD-032).
//!
//! The frontend records each finished run through `record_network_tool_run`;
//! this manager owns the store, enforces every bound, and persists it. The
//! bounds are enforced here — not trusted from the caller — so a buggy or
//! oversized record can never grow the file without limit:
//!
//! * [`MAX_RUNS_PER_TOOL`] — the newest runs kept per tool; older ones evicted.
//! * [`MAX_RUN_AGE_DAYS`] — runs that ended longer ago are pruned on load,
//!   record and list.
//! * [`MAX_RUN_BYTES`] — one record's serialized size; result rows beyond it
//!   are trimmed (the record keeps `totalRows` so the UI says it was trimmed).
//! * [`MAX_PARAMS_BYTES`], [`MAX_SUMMARY_CHARS`], [`MAX_ERROR_CHARS`] — the
//!   small free-form fields.
//!
//! Worst case on disk is therefore about 7 tools × 50 runs × 32 KiB ≈ 11 MiB;
//! typical runs are a few hundred bytes.

use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use tauri::AppHandle;

use super::tool_history::{NetworkHistoryTool, NetworkToolHistoryStore, NetworkToolRun};
use super::tool_history_storage::NetworkToolHistoryStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// The newest runs retained per tool.
pub const MAX_RUNS_PER_TOOL: usize = 50;
/// Runs that ended more than this many days ago are pruned.
pub const MAX_RUN_AGE_DAYS: i64 = 30;
/// The largest serialized size of one stored run; result rows are trimmed to
/// fit.
pub const MAX_RUN_BYTES: usize = 32 * 1024;
/// The largest serialized size of a run's parameters. A larger record is
/// rejected — tool parameters are a handful of short fields.
pub const MAX_PARAMS_BYTES: usize = 4 * 1024;
/// The longest stored summary line, in characters.
pub const MAX_SUMMARY_CHARS: usize = 500;
/// The longest stored error message, in characters.
pub const MAX_ERROR_CHARS: usize = 2_000;

/// Central network-tool run-history manager. Mirrors
/// [`crate::workflows::history_manager::WorkflowRunHistoryManager`].
pub struct NetworkToolHistoryManager {
    store: Mutex<NetworkToolHistoryStore>,
    storage: NetworkToolHistoryStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl NetworkToolHistoryManager {
    /// Initialize from disk, with recovery on corruption. Expired runs are
    /// dropped in memory; the file catches up on the next write.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = NetworkToolHistoryStorage::new(app_handle)
            .context("Failed to initialize network tool history storage")?;
        let mut result = storage
            .load_with_recovery()
            .context("Failed to load network tool history")?;
        prune_expired(&mut result.data, Utc::now());

        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// List recorded runs, newest first, optionally for one tool only.
    pub fn list(
        &self,
        tool: Option<NetworkHistoryTool>,
    ) -> Result<Vec<NetworkToolRun>, TerminalError> {
        let mut store = self.lock()?;
        prune_expired(&mut store, Utc::now());
        Ok(newest_first(&store, tool))
    }

    /// Record a finished run after bounding it; returns the record as stored
    /// (possibly with trimmed rows / shortened text).
    pub fn record(&self, run: NetworkToolRun) -> Result<NetworkToolRun, TerminalError> {
        self.record_at(run, Utc::now())
    }

    fn record_at(
        &self,
        run: NetworkToolRun,
        now: DateTime<Utc>,
    ) -> Result<NetworkToolRun, TerminalError> {
        let run = bound_run(run)?;
        let mut store = self.lock()?;
        // Re-recording the same id replaces the earlier record.
        store.runs.retain(|r| r.id != run.id);
        store.runs.push(run.clone());
        prune_expired(&mut store, now);
        cap_per_tool(&mut store, MAX_RUNS_PER_TOOL);
        self.persist(&store)?;
        Ok(run)
    }

    /// Delete one run by id. Deleting an unknown id is a no-op.
    pub fn delete(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self.lock()?;
        let before = store.runs.len();
        store.runs.retain(|r| r.id != id);
        if store.runs.len() != before {
            self.persist(&store)?;
        }
        Ok(())
    }

    /// Clear the history — for one tool, or every tool when `tool` is `None`.
    pub fn clear(&self, tool: Option<NetworkHistoryTool>) -> Result<(), TerminalError> {
        let mut store = self.lock()?;
        match tool {
            Some(t) => store.runs.retain(|r| r.tool != t),
            None => store.runs.clear(),
        }
        self.persist(&store)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, NetworkToolHistoryStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::NetworkError(e.to_string()))
    }

    fn persist(&self, store: &NetworkToolHistoryStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::NetworkError(e.to_string()))
    }
}

/// A newest-first copy of the recorded runs (stored oldest-first), optionally
/// filtered to one tool.
fn newest_first(
    store: &NetworkToolHistoryStore,
    tool: Option<NetworkHistoryTool>,
) -> Vec<NetworkToolRun> {
    store
        .runs
        .iter()
        .rev()
        .filter(|r| tool.is_none_or(|t| r.tool == t))
        .cloned()
        .collect()
}

/// Drop runs that ended more than [`MAX_RUN_AGE_DAYS`] before `now`. A run
/// whose timestamp does not parse is kept (never silently lose data to a
/// format quirk); the per-tool count cap still bounds it.
fn prune_expired(store: &mut NetworkToolHistoryStore, now: DateTime<Utc>) {
    let cutoff = now - Duration::days(MAX_RUN_AGE_DAYS);
    store.runs.retain(|r| {
        DateTime::parse_from_rfc3339(&r.ended_at)
            .map(|t| t.with_timezone(&Utc) >= cutoff)
            .unwrap_or(true)
    });
}

/// Keep at most `limit` runs per tool, evicting each tool's oldest first.
fn cap_per_tool(store: &mut NetworkToolHistoryStore, limit: usize) {
    let mut seen: std::collections::HashMap<NetworkHistoryTool, usize> =
        std::collections::HashMap::new();
    // Walk newest → oldest so the newest `limit` of each tool survive.
    let mut keep = vec![false; store.runs.len()];
    for (idx, run) in store.runs.iter().enumerate().rev() {
        let count = seen.entry(run.tool).or_insert(0);
        if *count < limit {
            *count += 1;
            keep[idx] = true;
        }
    }
    let mut keep_iter = keep.into_iter();
    store.runs.retain(|_| keep_iter.next().unwrap_or(false));
}

/// Truncate `text` to at most `max` characters (on a char boundary).
fn truncate_chars(text: &mut String, max: usize) {
    if let Some((idx, _)) = text.char_indices().nth(max) {
        text.truncate(idx);
    }
}

/// Apply the per-record bounds: reject oversized params, shorten text, and
/// trim result rows so the serialized record fits [`MAX_RUN_BYTES`].
fn bound_run(mut run: NetworkToolRun) -> Result<NetworkToolRun, TerminalError> {
    if run.id.trim().is_empty() {
        return Err(TerminalError::NetworkError(
            "network tool run has no id".into(),
        ));
    }
    let params_len = serde_json::to_string(&run.params)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?
        .len();
    if params_len > MAX_PARAMS_BYTES {
        return Err(TerminalError::NetworkError(format!(
            "network tool run parameters are too large ({params_len} bytes, max {MAX_PARAMS_BYTES})"
        )));
    }
    truncate_chars(&mut run.summary, MAX_SUMMARY_CHARS);
    if let Some(err) = run.error.as_mut() {
        truncate_chars(err, MAX_ERROR_CHARS);
    }

    let Some(mut result) = run.result.take() else {
        return Ok(run);
    };
    let produced = (result.rows.len() as u64).max(result.total_rows);
    let rows = std::mem::take(&mut result.rows);
    result.total_rows = produced;
    run.result = Some(result);

    // Size of the record without any rows is the fixed overhead; the rest of
    // the budget goes to rows, in order, until the next one would not fit.
    let base = serde_json::to_string(&run)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?
        .len();
    let mut budget = MAX_RUN_BYTES.saturating_sub(base);
    let mut kept = Vec::new();
    for row in rows {
        // +1 for the separating comma.
        let len = serde_json::to_string(&row)
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?
            .len()
            + 1;
        if len > budget {
            break;
        }
        budget -= len;
        kept.push(row);
    }
    if let Some(result) = run.result.as_mut() {
        result.rows = kept;
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::tool_history::{NetworkRunResult, NetworkRunStatus};
    use crate::run_location::RunLocation;
    use tempfile::TempDir;

    fn manager(dir: &TempDir) -> NetworkToolHistoryManager {
        NetworkToolHistoryManager {
            store: Mutex::new(NetworkToolHistoryStore::default()),
            storage: NetworkToolHistoryStorage::new_test(dir.path()),
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn run_at(id: &str, tool: NetworkHistoryTool, ended_at: DateTime<Utc>) -> NetworkToolRun {
        NetworkToolRun {
            id: id.to_string(),
            tool,
            params: serde_json::Map::new(),
            run_location: RunLocation::ThisComputer,
            started_at: ended_at.to_rfc3339(),
            ended_at: ended_at.to_rfc3339(),
            status: NetworkRunStatus::Completed,
            summary: String::new(),
            error: None,
            result: None,
        }
    }

    fn run(id: &str, tool: NetworkHistoryTool) -> NetworkToolRun {
        run_at(id, tool, Utc::now())
    }

    #[test]
    fn record_and_list_newest_first_filtered_by_tool() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        mgr.record(run("p1", NetworkHistoryTool::Ping)).unwrap();
        mgr.record(run("d1", NetworkHistoryTool::DnsLookup))
            .unwrap();
        mgr.record(run("p2", NetworkHistoryTool::Ping)).unwrap();

        let all: Vec<_> = mgr.list(None).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(all, ["p2", "d1", "p1"]);
        let pings: Vec<_> = mgr
            .list(Some(NetworkHistoryTool::Ping))
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(pings, ["p2", "p1"]);
    }

    #[test]
    fn per_tool_cap_evicts_only_that_tools_oldest() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        mgr.record(run("dns", NetworkHistoryTool::DnsLookup))
            .unwrap();
        for i in 0..(MAX_RUNS_PER_TOOL + 3) {
            mgr.record(run(&format!("p{i}"), NetworkHistoryTool::Ping))
                .unwrap();
        }
        let pings = mgr.list(Some(NetworkHistoryTool::Ping)).unwrap();
        assert_eq!(pings.len(), MAX_RUNS_PER_TOOL);
        assert_eq!(pings[0].id, format!("p{}", MAX_RUNS_PER_TOOL + 2));
        assert!(!pings.iter().any(|r| r.id == "p2"), "oldest evicted");
        // Another tool's history is untouched by the ping overflow.
        assert_eq!(
            mgr.list(Some(NetworkHistoryTool::DnsLookup)).unwrap().len(),
            1
        );
    }

    #[test]
    fn expired_runs_are_pruned() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = Utc::now();
        let old = now - Duration::days(MAX_RUN_AGE_DAYS + 1);
        let recent = now - Duration::days(MAX_RUN_AGE_DAYS - 1);
        mgr.record_at(run_at("old", NetworkHistoryTool::Ping, old), old)
            .unwrap();
        mgr.record_at(run_at("recent", NetworkHistoryTool::Ping, recent), now)
            .unwrap();
        let ids: Vec<_> = mgr.list(None).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["recent"]);
    }

    #[test]
    fn unparseable_timestamp_is_kept() {
        let mut store = NetworkToolHistoryStore::default();
        let mut r = run("odd", NetworkHistoryTool::Wol);
        r.ended_at = "yesterday-ish".into();
        store.runs.push(r);
        prune_expired(&mut store, Utc::now());
        assert_eq!(store.runs.len(), 1);
    }

    #[test]
    fn oversized_result_rows_are_trimmed_to_byte_cap() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let mut r = run("big", NetworkHistoryTool::PortScanner);
        let rows: Vec<Vec<serde_json::Value>> = (0..5_000)
            .map(|i| vec![serde_json::json!("10.0.0.1"), serde_json::json!(i)])
            .collect();
        r.result = Some(NetworkRunResult {
            columns: vec!["host".into(), "port".into()],
            rows,
            total_rows: 0,
        });
        let stored = mgr.record(r).unwrap();
        let result = stored.result.as_ref().unwrap();
        assert!(result.rows.len() < 5_000, "rows were trimmed");
        assert!(!result.rows.is_empty(), "as many rows as fit are kept");
        assert_eq!(result.total_rows, 5_000, "the produced count is kept");
        assert!(serde_json::to_string(&stored).unwrap().len() <= MAX_RUN_BYTES);
        // Kept rows are the first ones, in order.
        assert_eq!(result.rows[1][1], serde_json::json!(1));
    }

    #[test]
    fn small_result_is_stored_unchanged() {
        let mut r = run("small", NetworkHistoryTool::DnsLookup);
        r.result = Some(NetworkRunResult {
            columns: vec!["type".into()],
            rows: vec![vec![serde_json::json!("A")]],
            total_rows: 1,
        });
        let bounded = bound_run(r.clone()).unwrap();
        assert_eq!(bounded, r);
    }

    #[test]
    fn oversized_params_are_rejected_and_text_is_shortened() {
        let mut r = run("p", NetworkHistoryTool::Ping);
        r.params.insert(
            "host".into(),
            serde_json::json!("x".repeat(MAX_PARAMS_BYTES)),
        );
        assert!(bound_run(r).is_err());

        let mut r = run("t", NetworkHistoryTool::Ping);
        r.summary = "é".repeat(MAX_SUMMARY_CHARS + 10);
        r.error = Some("e".repeat(MAX_ERROR_CHARS + 10));
        let bounded = bound_run(r).unwrap();
        assert_eq!(bounded.summary.chars().count(), MAX_SUMMARY_CHARS);
        assert_eq!(bounded.error.unwrap().len(), MAX_ERROR_CHARS);
    }

    #[test]
    fn empty_id_is_rejected() {
        assert!(bound_run(run("  ", NetworkHistoryTool::Ping)).is_err());
    }

    #[test]
    fn delete_and_clear() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        mgr.record(run("p1", NetworkHistoryTool::Ping)).unwrap();
        mgr.record(run("p2", NetworkHistoryTool::Ping)).unwrap();
        mgr.record(run("w1", NetworkHistoryTool::Wol)).unwrap();

        mgr.delete("p1").unwrap();
        mgr.delete("unknown").unwrap();
        assert_eq!(mgr.list(None).unwrap().len(), 2);

        mgr.clear(Some(NetworkHistoryTool::Ping)).unwrap();
        let ids: Vec<_> = mgr.list(None).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["w1"]);

        mgr.clear(None).unwrap();
        assert!(mgr.list(None).unwrap().is_empty());
    }

    #[test]
    fn re_recording_an_id_replaces_it() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        mgr.record(run("same", NetworkHistoryTool::Ping)).unwrap();
        let mut again = run("same", NetworkHistoryTool::Ping);
        again.summary = "second".into();
        mgr.record(again).unwrap();
        let listed = mgr.list(None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].summary, "second");
    }

    #[test]
    fn history_persists_across_reload() {
        let dir = TempDir::new().unwrap();
        {
            let mgr = manager(&dir);
            let mut r = run("kept", NetworkHistoryTool::Traceroute);
            r.run_location = RunLocation::Agent("agent-1".into());
            mgr.record(r).unwrap();
        }
        let storage = NetworkToolHistoryStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        assert_eq!(loaded.data.runs.len(), 1);
        assert_eq!(loaded.data.runs[0].id, "kept");
        assert_eq!(
            loaded.data.runs[0].run_location,
            RunLocation::Agent("agent-1".into())
        );
    }
}
