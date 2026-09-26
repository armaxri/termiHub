use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::ScheduleStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "schedules.json";

/// Handles reading/writing the schedules JSON file. Mirrors
/// [`crate::workflows::storage::WorkflowStorage`].
pub struct ScheduleStorage {
    file_path: PathBuf,
}

impl ScheduleStorage {
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
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<ScheduleStore>> {
        load_store_with_recovery::<ScheduleStore>(&self.file_path, FILE_NAME)
    }

    /// Save the schedule store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file + rename) so an interrupted save cannot
    /// truncate user-authored schedules into invalid JSON that the recovery
    /// path would discard (PER-003 torn-write class). Before writing,
    /// [`guard_not_newer`] refuses to overwrite a file written by a newer schema
    /// version (PER-004).
    pub fn save(&self, store: &ScheduleStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            ScheduleStore::STORE_NAME,
            ScheduleStore::CURRENT_VERSION,
        )?;

        // Always stamp the current schema version: a store migrated in memory or
        // built from an older default must not be written back under a stale one.
        let mut value = serde_json::to_value(store).context("Failed to serialize schedules")?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "version".to_string(),
                serde_json::Value::String(ScheduleStore::CURRENT_VERSION.to_string()),
            );
        }
        let data = serde_json::to_string_pretty(&value).context("Failed to serialize schedules")?;

        write_atomic(&self.file_path, &data).context("Failed to write schedules file")?;

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
    use tempfile::TempDir;

    #[test]
    fn missing_file_loads_empty_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.schedules.is_empty());
        assert!(!result.data.paused);
    }

    #[test]
    fn save_and_load_round_trip_keeps_pause_and_unknown_keys() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        let mut store = ScheduleStore {
            paused: true,
            ..Default::default()
        };
        store
            .extra
            .insert("future".to_string(), serde_json::json!([1, 2]));
        storage.save(&store).unwrap();
        let loaded = storage.load_with_recovery().unwrap().data;
        assert!(loaded.paused);
        assert_eq!(loaded.extra["future"], serde_json::json!([1, 2]));
    }

    #[test]
    fn newer_file_is_never_overwritten() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        let newer = r#"{"version":"99","schedules":[]}"#;
        fs::write(dir.path().join(FILE_NAME), newer).unwrap();
        let loaded = storage.load_with_recovery().unwrap();
        assert!(!loaded.warnings.is_empty(), "a newer file is reported");
        assert!(storage.save(&ScheduleStore::default()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join(FILE_NAME)).unwrap(),
            newer
        );
    }

    /// #3528: a v1 file (only `lastResult`) migrates to v2 on load, seeding each
    /// schedule's history, and is rewritten on disk as v2 once.
    #[test]
    fn v1_file_migrates_to_v2_and_is_persisted() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        let raw = r#"{"version":"1","paused":true,"schedules":[
            {"id":"a","name":"n","action":{"kind":"macro","macroId":"m"},
             "targets":{"kind":"connections","connectionIds":["c"]},
             "rule":{"kind":"interval","everyMinutes":5},
             "lastResult":{"at":"t","outcome":"completed"}}]}"#;
        fs::write(dir.path().join(FILE_NAME), raw).unwrap();
        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.warnings.is_empty());
        assert!(loaded.data.paused);
        assert_eq!(loaded.data.schedules[0].history.len(), 1);
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(on_disk["version"], "2");
        assert_eq!(
            on_disk["schedules"][0]["history"][0]["outcome"],
            "completed"
        );
    }

    #[test]
    fn save_stamps_the_current_version() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        let store = ScheduleStore {
            version: "1".to_string(),
            ..Default::default()
        };
        storage.save(&store).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(on_disk["version"], "2");
    }

    /// #3528 downgrade safety: a build that only knows v1 must refuse to
    /// overwrite a v2 file (which would silently drop every schedule's
    /// history). Simulated with the shared guard at the old version.
    #[test]
    fn v1_build_refuses_to_overwrite_v2_file() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        storage.save(&ScheduleStore::default()).unwrap();
        let err = guard_not_newer(&dir.path().join(FILE_NAME), "schedules.json", 1).unwrap_err();
        assert!(err.to_string().contains("newer version"));
    }

    #[test]
    fn corrupt_entry_is_salvaged_without_losing_the_rest() {
        let dir = TempDir::new().unwrap();
        let storage = ScheduleStorage::new_test(dir.path());
        let raw = r#"{"version":"1","schedules":[
            {"id":"ok","name":"n","action":{"kind":"macro","macroId":"m"},
             "targets":{"kind":"connections","connectionIds":["c"]},
             "rule":{"kind":"interval","everyMinutes":5}},
            {"id":"bad","rule":"nope"}]}"#;
        fs::write(dir.path().join(FILE_NAME), raw).unwrap();
        let loaded = storage.load_with_recovery().unwrap();
        assert_eq!(loaded.data.schedules.len(), 1);
        assert_eq!(loaded.data.schedules[0].id, "ok");
    }
}
