use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::history::WorkflowRunHistoryStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "runs.json";

/// Handles reading/writing the workflow run-history JSON file (PROD-0046).
/// Mirrors [`crate::workflows::storage::WorkflowStorage`].
pub struct WorkflowRunHistoryStorage {
    file_path: PathBuf,
}

impl WorkflowRunHistoryStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set, it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;

        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery via the shared schema-migration layer.
    ///
    /// A current/older file is used as-is (or migrated forward), a **newer** file
    /// is left untouched and reported as a warning (never reset — PER-004), and
    /// only a genuinely unparseable file is backed up to `.bak` and reset.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<WorkflowRunHistoryStore>> {
        load_store_with_recovery::<WorkflowRunHistoryStore>(&self.file_path, FILE_NAME)
    }

    /// Save the run-history store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file + rename) so an interrupted save cannot
    /// truncate the history into invalid JSON (PER-003 torn-write class). Before
    /// writing, [`guard_not_newer`] refuses to overwrite a file written by a
    /// newer schema version (PER-004).
    pub fn save(&self, store: &WorkflowRunHistoryStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            WorkflowRunHistoryStore::STORE_NAME,
            WorkflowRunHistoryStore::CURRENT_VERSION,
        )?;

        let data = serde_json::to_string_pretty(store)
            .context("Failed to serialize workflow run history")?;

        write_atomic(&self.file_path, &data)
            .context("Failed to write workflow run-history file")?;

        Ok(())
    }

    /// Create a storage instance for testing (bypasses Tauri AppHandle).
    #[cfg(test)]
    pub fn new_test(dir: &std::path::Path) -> Self {
        Self {
            file_path: dir.join(FILE_NAME),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflows::history::{WorkflowRun, WorkflowRunStatus, WorkflowRunTrigger};
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> WorkflowRunHistoryStorage {
        WorkflowRunHistoryStorage {
            file_path: dir.path().join(FILE_NAME),
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

    fn sample_store() -> WorkflowRunHistoryStore {
        WorkflowRunHistoryStore {
            version: "1".to_string(),
            extra: Default::default(),
            runs: vec![run("run-1"), run("run-2")],
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.runs.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&sample_store()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.runs.len(), 2);
        assert_eq!(result.data.runs[0].id, "run-1");
        assert_eq!(result.data.runs[0].status, WorkflowRunStatus::Completed);
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt run data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.runs.is_empty());

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 granular salvage: a file with one valid run and one corrupt entry
    /// keeps the valid run and drops only the corrupt one.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let mut value = serde_json::to_value(sample_store()).unwrap();
        value["runs"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("corrupt run entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.runs.len(), 2, "the valid runs survive");
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(result.warnings[0].message.contains("index 2"));

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());

        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(reloaded.data.runs.len(), 2);
    }
}
