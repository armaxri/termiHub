use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::history::{WorkflowRun, WorkflowRunHistoryStore};
use super::history_storage::WorkflowRunHistoryStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// The most-recent runs retained on disk (PROD-0046). A count-based cap, kept
/// deliberately simple and metadata-only; the maintainer can raise it later.
pub const MAX_WORKFLOW_RUNS: usize = 200;

/// Central workflow run-history manager: appends run records, caps the history
/// to the most-recent [`MAX_WORKFLOW_RUNS`], and persists through storage.
/// Mirrors [`crate::workflows::manager::WorkflowManager`].
pub struct WorkflowRunHistoryManager {
    store: Mutex<WorkflowRunHistoryStore>,
    storage: WorkflowRunHistoryStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl WorkflowRunHistoryManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = WorkflowRunHistoryStorage::new(app_handle)
            .context("Failed to initialize workflow run-history storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load workflow run history")?;

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

    /// List all recorded runs, most-recent first (display order).
    pub fn list(&self) -> Result<Vec<WorkflowRun>, TerminalError> {
        let store = self.lock()?;
        Ok(newest_first(&store))
    }

    /// Record a finished run, appending it and trimming the history to the
    /// most-recent [`MAX_WORKFLOW_RUNS`] by dropping the oldest records.
    ///
    /// Returns the full, display-ordered (newest-first) list.
    pub fn record(&self, run: WorkflowRun) -> Result<Vec<WorkflowRun>, TerminalError> {
        let mut store = self.lock()?;
        store.runs.push(run);
        cap_to_limit(&mut store, MAX_WORKFLOW_RUNS);
        self.persist(&store)?;
        Ok(newest_first(&store))
    }

    /// Clear all run-history records.
    pub fn clear(&self) -> Result<Vec<WorkflowRun>, TerminalError> {
        let mut store = self.lock()?;
        store.runs.clear();
        self.persist(&store)?;
        Ok(Vec::new())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, WorkflowRunHistoryStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))
    }

    fn persist(&self, store: &WorkflowRunHistoryStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))
    }
}

/// A newest-first copy of the recorded runs (they are stored oldest-first).
fn newest_first(store: &WorkflowRunHistoryStore) -> Vec<WorkflowRun> {
    let mut runs = store.runs.clone();
    runs.reverse();
    runs
}

/// Drop the oldest records until the store holds at most `limit` runs. A `limit`
/// of 0 is treated as "unbounded".
fn cap_to_limit(store: &mut WorkflowRunHistoryStore, limit: usize) {
    if limit == 0 {
        return;
    }
    if store.runs.len() > limit {
        let overflow = store.runs.len() - limit;
        store.runs.drain(0..overflow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflows::history::{WorkflowRunStatus, WorkflowRunTrigger};
    use tempfile::TempDir;

    fn create_test_manager(dir: &TempDir) -> WorkflowRunHistoryManager {
        WorkflowRunHistoryManager {
            store: Mutex::new(WorkflowRunHistoryStore::default()),
            storage: WorkflowRunHistoryStorage::new_test(dir.path()),
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn run(id: &str) -> WorkflowRun {
        WorkflowRun {
            id: id.to_string(),
            workflow_id: "wf-1".to_string(),
            workflow_name: "Login".to_string(),
            started_at: "2026-09-20T00:00:00Z".to_string(),
            ended_at: "2026-09-20T00:00:05Z".to_string(),
            status: WorkflowRunStatus::Completed,
            steps_completed: 2,
            total: 2,
            failed_step_index: None,
            error: None,
            continued_failures: None,
            tab_id: Some("tab-1".to_string()),
            triggered_by: WorkflowRunTrigger::Manual,
        }
    }

    #[test]
    fn list_empty() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        assert!(mgr.list().unwrap().is_empty());
    }

    #[test]
    fn record_appends_and_lists_newest_first() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.record(run("run-1")).unwrap();
        let listed = mgr.record(run("run-2")).unwrap();

        // Newest-first display order.
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "run-2");
        assert_eq!(listed[1].id, "run-1");
    }

    #[test]
    fn record_caps_history_dropping_oldest() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        // Record one more than the cap.
        for i in 0..(MAX_WORKFLOW_RUNS + 5) {
            mgr.record(run(&format!("run-{i}"))).unwrap();
        }

        let listed = mgr.list().unwrap();
        assert_eq!(listed.len(), MAX_WORKFLOW_RUNS, "history is capped");
        // The newest is first; the oldest five were evicted.
        assert_eq!(listed[0].id, format!("run-{}", MAX_WORKFLOW_RUNS + 4));
        assert_eq!(listed[MAX_WORKFLOW_RUNS - 1].id, "run-5");
        assert!(
            !listed.iter().any(|r| r.id == "run-4"),
            "the oldest overflow record was evicted"
        );
    }

    #[test]
    fn clear_empties_history() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.record(run("run-1")).unwrap();
        mgr.record(run("run-2")).unwrap();
        let cleared = mgr.clear().unwrap();

        assert!(cleared.is_empty());
        assert!(mgr.list().unwrap().is_empty());
    }

    #[test]
    fn history_persists_across_reload() {
        let dir = TempDir::new().unwrap();
        {
            let mgr = create_test_manager(&dir);
            mgr.record(run("persisted")).unwrap();
        }

        // A fresh manager reading the same file sees the recorded run.
        let storage = WorkflowRunHistoryStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        let mgr = WorkflowRunHistoryManager {
            store: Mutex::new(loaded.data),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
        };

        let listed = mgr.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "persisted");
    }
}
