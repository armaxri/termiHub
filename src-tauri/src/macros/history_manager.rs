use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use tauri::AppHandle;

use super::history::{MacroRun, MacroRunHistoryStore};
use super::history_storage::MacroRunHistoryStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// The most-recent playbacks retained on disk (#3543), matching the workflow
/// run history's count cap.
pub const MAX_MACRO_RUNS: usize = 200;

/// Playbacks older than this many days are dropped when a new one is recorded.
pub const MAX_MACRO_RUN_AGE_DAYS: i64 = 90;

/// At most this many target labels are kept per record (a fan-out playback into
/// dozens of terminals still records its full `targetCount`).
pub const MAX_TARGET_LABELS: usize = 10;

/// Longest target label / error string kept, in characters.
pub const MAX_TEXT_CHARS: usize = 200;

/// Central macro run-history manager: appends playback records, caps the
/// history by count ([`MAX_MACRO_RUNS`]) and age ([`MAX_MACRO_RUN_AGE_DAYS`]),
/// and persists through storage. Mirrors
/// [`crate::workflows::history_manager::WorkflowRunHistoryManager`].
pub struct MacroRunHistoryManager {
    store: Mutex<MacroRunHistoryStore>,
    storage: MacroRunHistoryStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl MacroRunHistoryManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = MacroRunHistoryStorage::new(app_handle)
            .context("Failed to initialize macro run-history storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load macro run history")?;

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

    /// List all recorded playbacks, most-recent first (display order).
    pub fn list(&self) -> Result<Vec<MacroRun>, TerminalError> {
        let store = self.lock()?;
        Ok(newest_first(&store))
    }

    /// Record a finished playback, then apply the age and count caps.
    ///
    /// Returns the full, display-ordered (newest-first) list.
    pub fn record(&self, run: MacroRun) -> Result<Vec<MacroRun>, TerminalError> {
        self.record_at(run, Utc::now())
    }

    /// [`Self::record`] with an explicit "now", for deterministic age pruning.
    fn record_at(&self, run: MacroRun, now: DateTime<Utc>) -> Result<Vec<MacroRun>, TerminalError> {
        let mut store = self.lock()?;
        store.runs.push(bounded(run));
        prune_older_than(&mut store, now - Duration::days(MAX_MACRO_RUN_AGE_DAYS));
        cap_to_limit(&mut store, MAX_MACRO_RUNS);
        self.persist(&store)?;
        Ok(newest_first(&store))
    }

    /// Clear all run-history records.
    pub fn clear(&self) -> Result<Vec<MacroRun>, TerminalError> {
        let mut store = self.lock()?;
        store.runs.clear();
        self.persist(&store)?;
        Ok(Vec::new())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, MacroRunHistoryStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::MacroError(e.to_string()))
    }

    fn persist(&self, store: &MacroRunHistoryStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::MacroError(e.to_string()))
    }
}

/// Truncate `text` to at most [`MAX_TEXT_CHARS`] characters.
fn truncate(text: String) -> String {
    if text.chars().count() <= MAX_TEXT_CHARS {
        text
    } else {
        text.chars().take(MAX_TEXT_CHARS).collect()
    }
}

/// Bound a record's free-text fields so one record cannot bloat the file.
fn bounded(mut run: MacroRun) -> MacroRun {
    run.target_labels.truncate(MAX_TARGET_LABELS);
    run.target_labels = run.target_labels.into_iter().map(truncate).collect();
    run.macro_name = truncate(run.macro_name);
    run.error = run.error.map(truncate);
    run
}

/// Drop records that ended before `cutoff`. A record whose `endedAt` does not
/// parse is kept (never lose history over a timestamp-format quirk).
fn prune_older_than(store: &mut MacroRunHistoryStore, cutoff: DateTime<Utc>) {
    store
        .runs
        .retain(|r| match DateTime::parse_from_rfc3339(&r.ended_at) {
            Ok(ended) => ended.with_timezone(&Utc) >= cutoff,
            Err(_) => true,
        });
}

/// A newest-first copy of the recorded runs (they are stored oldest-first).
fn newest_first(store: &MacroRunHistoryStore) -> Vec<MacroRun> {
    let mut runs = store.runs.clone();
    runs.reverse();
    runs
}

/// Drop the oldest records until the store holds at most `limit` runs.
fn cap_to_limit(store: &mut MacroRunHistoryStore, limit: usize) {
    if store.runs.len() > limit {
        let overflow = store.runs.len() - limit;
        store.runs.drain(0..overflow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::macros::history::{MacroRunOrigin, MacroRunStatus};
    use tempfile::TempDir;

    fn create_test_manager(dir: &TempDir) -> MacroRunHistoryManager {
        MacroRunHistoryManager {
            store: Mutex::new(MacroRunHistoryStore::default()),
            storage: MacroRunHistoryStorage::new_test(dir.path()),
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-20T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn run_ended(id: &str, ended_at: &str) -> MacroRun {
        MacroRun {
            id: id.to_string(),
            macro_id: "macro-1".to_string(),
            macro_name: "Deploy".to_string(),
            started_at: ended_at.to_string(),
            ended_at: ended_at.to_string(),
            status: MacroRunStatus::Completed,
            steps_played: 2,
            total_steps: 2,
            target_count: 1,
            target_labels: vec!["prod-1".to_string()],
            origin: MacroRunOrigin::Manual,
            error: None,
        }
    }

    fn run(id: &str) -> MacroRun {
        run_ended(id, "2026-09-20T11:00:00Z")
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

        mgr.record_at(run("run-1"), now()).unwrap();
        let listed = mgr.record_at(run("run-2"), now()).unwrap();

        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "run-2");
        assert_eq!(listed[1].id, "run-1");
    }

    #[test]
    fn record_caps_history_by_count_dropping_oldest() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        for i in 0..(MAX_MACRO_RUNS + 5) {
            mgr.record_at(run(&format!("run-{i}")), now()).unwrap();
        }

        let listed = mgr.list().unwrap();
        assert_eq!(listed.len(), MAX_MACRO_RUNS, "history is capped");
        assert_eq!(listed[0].id, format!("run-{}", MAX_MACRO_RUNS + 4));
        assert_eq!(listed[MAX_MACRO_RUNS - 1].id, "run-5");
    }

    #[test]
    fn record_prunes_runs_older_than_the_age_cap() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let expired = (now() - Duration::days(MAX_MACRO_RUN_AGE_DAYS + 1)).to_rfc3339();
        let recent = (now() - Duration::days(MAX_MACRO_RUN_AGE_DAYS - 1)).to_rfc3339();
        mgr.record_at(run_ended("old", &expired), now()).unwrap();
        mgr.record_at(run_ended("kept", &recent), now()).unwrap();
        mgr.record_at(run_ended("odd", "not-a-timestamp"), now())
            .unwrap();
        let listed = mgr.record_at(run("new"), now()).unwrap();

        let ids: Vec<&str> = listed.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "odd", "kept"]);
    }

    #[test]
    fn record_bounds_labels_and_text() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let long = "x".repeat(MAX_TEXT_CHARS + 50);
        let recorded = MacroRun {
            target_count: 25,
            target_labels: (0..25).map(|i| format!("{long}{i}")).collect(),
            error: Some(long.clone()),
            ..run("big")
        };
        let listed = mgr.record_at(recorded, now()).unwrap();

        let r = &listed[0];
        assert_eq!(r.target_count, 25, "the true target count is kept");
        assert_eq!(r.target_labels.len(), MAX_TARGET_LABELS);
        assert!(r
            .target_labels
            .iter()
            .all(|l| l.chars().count() == MAX_TEXT_CHARS));
        assert_eq!(r.error.as_ref().unwrap().chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn clear_empties_history() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.record_at(run("run-1"), now()).unwrap();
        let cleared = mgr.clear().unwrap();

        assert!(cleared.is_empty());
        assert!(mgr.list().unwrap().is_empty());
    }

    #[test]
    fn history_persists_across_reload() {
        let dir = TempDir::new().unwrap();
        {
            let mgr = create_test_manager(&dir);
            mgr.record_at(run("persisted"), now()).unwrap();
        }

        let storage = MacroRunHistoryStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        let mgr = MacroRunHistoryManager {
            store: Mutex::new(loaded.data),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
        };

        let listed = mgr.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "persisted");
    }
}
