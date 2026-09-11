use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::WorkspaceStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "workspaces.json";

/// Handles reading/writing the workspaces JSON file.
pub struct WorkspaceStorage {
    file_path: PathBuf,
}

impl WorkspaceStorage {
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
    /// Reads the on-disk `version` first: a current/older file is used as-is (or
    /// migrated forward), a **newer** file is left untouched and reported as a
    /// warning (never reset — PER-004), and only a genuinely unparseable file is
    /// backed up to `.bak` and reset to defaults.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<WorkspaceStore>> {
        load_store_with_recovery::<WorkspaceStore>(&self.file_path, FILE_NAME)
    }

    /// Save the workspace store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file in the same directory + rename), so an
    /// interrupted save can never truncate the existing store and lose every
    /// saved workspace (#2318). Before writing, [`guard_not_newer`] refuses to
    /// overwrite a file written by a newer schema version (PER-004).
    pub fn save(&self, store: &WorkspaceStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            WorkspaceStore::STORE_NAME,
            WorkspaceStore::CURRENT_VERSION,
        )?;

        let data = serde_json::to_string_pretty(store).context("Failed to serialize workspaces")?;

        write_atomic(&self.file_path, &data).context("Failed to write workspaces file")?;

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

    fn create_test_storage(dir: &TempDir) -> WorkspaceStorage {
        WorkspaceStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.workspaces.is_empty());
    }

    #[test]
    fn load_with_recovery_valid_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = WorkspaceStore::default();
        storage.save(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt workspace data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.workspaces.is_empty());

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 (the real downgrade hazard): a workspaces file written by a NEWER
    /// schema version whose *structure* an older build cannot parse must never be
    /// wiped. Here `workspaces` is no longer an array — the old fast-path typed
    /// parse fails, and the pre-fix code would treat that as corruption, back it
    /// up to `.bak`, and overwrite the live file with empty defaults (silent total
    /// data loss on a rollback). The version gate now catches `version > current`
    /// *before* the typed parse, so the file is left byte-for-byte intact with no
    /// `.bak`, the load runs on defaults in memory, and a warning is surfaced.
    #[test]
    fn newer_version_file_is_not_wiped_on_load() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        // version newer than current AND a shape this build can't deserialize.
        let newer = r#"{"version":"99","workspaces":{"v100":"restructured"}}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1, "a newer file surfaces a warning");
        assert!(result.data.workspaces.is_empty(), "runs on defaults");

        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(after, newer, "the newer file must be left intact");
        assert!(
            !storage.file_path.with_extension("json.bak").exists(),
            "a newer file must never be backed up/reset"
        );
    }

    /// PER-004 (write side): a save must refuse to overwrite a newer file and
    /// leave it intact, so an in-version change can't clobber future data.
    #[test]
    fn save_refuses_to_overwrite_newer_file() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let newer = r#"{"version":"99","workspaces":[]}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let result = storage.save(&WorkspaceStore::default());
        assert!(result.is_err(), "saving over a newer file must fail");
        assert_eq!(
            fs::read_to_string(&storage.file_path).unwrap(),
            newer,
            "the newer file must be untouched"
        );
    }

    /// PER-010: an unknown top-level field survives a load -> save round-trip
    /// instead of being silently dropped by the typed struct.
    #[test]
    fn unknown_field_survives_load_save_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        // Same current version, but with an extra field a newer build added.
        fs::write(
            &storage.file_path,
            r#"{"version":"1","workspaces":[],"experimentalFlag":{"on":true}}"#,
        )
        .unwrap();

        let loaded = storage.load_with_recovery().unwrap().data;
        storage.save(&loaded).unwrap();

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.file_path).unwrap()).unwrap();
        assert_eq!(
            after.get("experimentalFlag"),
            Some(&serde_json::json!({"on": true})),
            "unknown field must survive the round-trip"
        );
    }

    /// A successful atomic save must leave only the target file behind — no
    /// leftover temporary write artifacts in the config directory.
    #[test]
    fn save_leaves_no_stray_files() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&WorkspaceStore::default()).unwrap();

        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![FILE_NAME.to_string()],
            "atomic save must leave only the target file, got {names:?}"
        );
    }

    /// Regression (#2318): a save that cannot durably complete must fail
    /// **without** clobbering the previously-saved store. The old truncate-in-place
    /// `fs::write` succeeds here by overwriting the existing file, so this fails
    /// red on it; the atomic temp+rename write cannot create its temp file in a
    /// read-only directory and therefore leaves the prior file untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_store() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Seed a good, complete store and capture its exact on-disk bytes.
        storage.save(&WorkspaceStore::default()).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

        // Make the directory read-only so no new (temp) file can be created in it.
        let restore = fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        fs::set_permissions(dir.path(), ro).unwrap();

        // A privileged/root process can create files regardless of mode — skip.
        let probe = dir.path().join(".probe");
        if fs::write(&probe, b"x").is_ok() {
            let _ = fs::remove_file(&probe);
            fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let updated = WorkspaceStore {
            version: "2".to_string(),
            workspaces: Vec::new(),
            extra: Default::default(),
        };
        let result = storage.save(&updated);

        // Restore permissions before asserting so TempDir can clean up.
        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous store fully intact"
        );
        // And the preserved file must still be valid JSON.
        serde_json::from_str::<WorkspaceStore>(&after).expect("preserved store still parses");
    }
}
