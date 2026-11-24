//! The automation run-history manager (#5818, slice 2): appends one record
//! per finished run on one terminal, keeps the newest
//! [`MAX_AUTOMATION_RUNS`](super::history::MAX_AUTOMATION_RUNS) within
//! [`MAX_AUTOMATION_RUN_AGE_DAYS`](super::history::MAX_AUTOMATION_RUN_AGE_DAYS),
//! and persists through `automation-runs.json`.

use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use tauri::{AppHandle, Runtime};

use super::history::{apply_retention, AutomationRun, AutomationRunHistoryStore};
use super::storage::StoreFile;
use crate::connection::recovery::RecoveryWarning;
use crate::macros::history_manager::{MAX_TARGET_LABELS, MAX_TEXT_CHARS};
use crate::utils::errors::TerminalError;

/// Central automation run-history manager.
pub struct AutomationRunHistoryManager {
    store: Mutex<AutomationRunHistoryStore>,
    storage: StoreFile<AutomationRunHistoryStore>,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl AutomationRunHistoryManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new<R: Runtime>(app_handle: &AppHandle<R>) -> Result<Self> {
        let storage = StoreFile::new(app_handle)
            .context("Failed to initialize automation run-history storage")?;
        Self::with_storage(storage)
    }

    /// Initialize from a store file, with recovery on corruption.
    pub fn with_storage(storage: StoreFile<AutomationRunHistoryStore>) -> Result<Self> {
        let result = storage
            .load_with_recovery()
            .context("Failed to load automation run history")?;
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

    /// All recorded runs, newest first.
    pub fn list(&self) -> Result<Vec<AutomationRun>, TerminalError> {
        Ok(newest_first(&*self.lock()?))
    }

    /// Record a finished run, then apply the age and count caps. Returns the
    /// full newest-first list.
    pub fn record(&self, run: AutomationRun) -> Result<Vec<AutomationRun>, TerminalError> {
        self.record_at(run, Utc::now())
    }

    /// [`Self::record`] with an explicit "now", for deterministic pruning.
    pub fn record_at(
        &self,
        run: AutomationRun,
        now: DateTime<Utc>,
    ) -> Result<Vec<AutomationRun>, TerminalError> {
        let mut store = self.lock()?;
        let mut next = store.clone();
        next.runs.push(bounded(run));
        apply_retention(&mut next.runs, now);
        self.persist(&next)?;
        *store = next;
        Ok(newest_first(&store))
    }

    /// Clear every record.
    pub fn clear(&self) -> Result<Vec<AutomationRun>, TerminalError> {
        self.clear_runs(None)
    }

    /// Clear the records with the given ids, or every record for `None`.
    /// Returns the remaining records, newest first. The macro and workflow
    /// history panels each clear only the runs they show (#5818, slice 4).
    pub fn clear_runs(
        &self,
        run_ids: Option<&[String]>,
    ) -> Result<Vec<AutomationRun>, TerminalError> {
        let mut store = self.lock()?;
        let mut next = store.clone();
        match run_ids {
            None => next.runs.clear(),
            Some(ids) => {
                let ids: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
                next.runs.retain(|r| !ids.contains(r.id.as_str()));
            }
        }
        self.persist(&next)?;
        *store = next;
        Ok(newest_first(&store))
    }

    fn lock(&self) -> Result<MutexGuard<'_, AutomationRunHistoryStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::AutomationError(e.to_string()))
    }

    fn persist(&self, store: &AutomationRunHistoryStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::AutomationError(e.to_string()))
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
fn bounded(mut run: AutomationRun) -> AutomationRun {
    run.target_labels.truncate(MAX_TARGET_LABELS);
    run.target_labels = run.target_labels.into_iter().map(truncate).collect();
    run.automation_name = truncate(run.automation_name);
    run.target_label = run.target_label.map(truncate);
    run.error = run.error.map(truncate);
    run
}

fn newest_first(store: &AutomationRunHistoryStore) -> Vec<AutomationRun> {
    store.runs.iter().rev().cloned().collect()
}
