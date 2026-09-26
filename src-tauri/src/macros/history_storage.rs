use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::history::MacroRunHistoryStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "macro-runs.json";

/// Handles reading/writing the macro run-history JSON file (#3543).
/// Mirrors [`crate::workflows::history_storage::WorkflowRunHistoryStorage`].
pub struct MacroRunHistoryStorage {
    file_path: PathBuf,
}

impl MacroRunHistoryStorage {
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
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<MacroRunHistoryStore>> {
        load_store_with_recovery::<MacroRunHistoryStore>(&self.file_path, FILE_NAME)
    }

    /// Save the run-history store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file + rename), and [`guard_not_newer`] refuses
    /// to overwrite a file written by a newer schema version (PER-004).
    pub fn save(&self, store: &MacroRunHistoryStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            MacroRunHistoryStore::STORE_NAME,
            MacroRunHistoryStore::CURRENT_VERSION,
        )?;

        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize macro run history")?;

        write_atomic(&self.file_path, &data).context("Failed to write macro run-history file")?;

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
    use crate::macros::history::{MacroRun, MacroRunOrigin, MacroRunStatus};
    use tempfile::TempDir;

    fn run(id: &str) -> MacroRun {
        MacroRun {
            id: id.to_string(),
            macro_id: "macro-1".to_string(),
            macro_name: "Deploy".to_string(),
            started_at: "2026-09-20T00:00:00Z".to_string(),
            ended_at: "2026-09-20T00:00:05Z".to_string(),
            status: MacroRunStatus::Completed,
            steps_played: 2,
            total_steps: 2,
            target_count: 1,
            target_labels: vec!["prod-1".to_string()],
            origin: MacroRunOrigin::Manual,
            error: None,
        }
    }

    fn sample_store() -> MacroRunHistoryStore {
        MacroRunHistoryStore {
            runs: vec![run("run-1"), run("run-2")],
            ..MacroRunHistoryStore::default()
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = MacroRunHistoryStorage::new_test(dir.path());

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.runs.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = MacroRunHistoryStorage::new_test(dir.path());

        storage.save(&sample_store()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.runs, sample_store().runs);
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = MacroRunHistoryStorage::new_test(dir.path());
        fs::write(&storage.file_path, "corrupt run data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.data.runs.is_empty());
        assert!(storage.file_path.with_extension("json.bak").exists());
    }

    /// PER-004 granular salvage: one corrupt entry is dropped, the rest survive.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = MacroRunHistoryStorage::new_test(dir.path());

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
    }

    /// Downgrade safety (PER-004): a file from a newer schema is neither reset
    /// on load nor overwritten on save.
    #[test]
    fn newer_file_is_left_intact() {
        let dir = TempDir::new().unwrap();
        let storage = MacroRunHistoryStorage::new_test(dir.path());
        let newer = r#"{"version": "99", "runs": [], "fromTheFuture": true}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.data.runs.is_empty());
        assert!(!loaded.warnings.is_empty(), "the newer file is reported");

        assert!(storage.save(&sample_store()).is_err());
        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), newer);
    }
}
