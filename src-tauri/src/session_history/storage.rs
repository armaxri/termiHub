use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::SessionHistoryStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "session-history.json";

/// Handles reading/writing the session-history JSON file.
///
/// The file lives alongside `connections.json`/`macros.json` in the config
/// directory and is deliberately **separate** so session history is never
/// swept into connection export/import operations.
pub struct SessionHistoryStorage {
    file_path: PathBuf,
}

impl SessionHistoryStorage {
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
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<SessionHistoryStore>> {
        load_store_with_recovery::<SessionHistoryStore>(&self.file_path, FILE_NAME)
    }

    /// Save the session-history store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file + rename) so an interrupted save cannot
    /// truncate the file into invalid JSON that the recovery path would then
    /// discard (PER-002 torn-write class). Before writing, [`guard_not_newer`]
    /// refuses to overwrite a file written by a newer schema version (PER-004).
    pub fn save(&self, store: &SessionHistoryStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            SessionHistoryStore::STORE_NAME,
            SessionHistoryStore::CURRENT_VERSION,
        )?;

        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize session history")?;

        write_atomic(&self.file_path, &data).context("Failed to write session-history file")?;

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
    use crate::session_history::config::SessionHistoryEntry;
    use serde_json::json;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> SessionHistoryStorage {
        SessionHistoryStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    fn sample_store() -> SessionHistoryStore {
        SessionHistoryStore {
            version: "1".to_string(),
            extra: Default::default(),
            entries: vec![SessionHistoryEntry {
                dedup_key: "ssh:admin@host:22".to_string(),
                title: "admin@host".to_string(),
                connection_type: "ssh".to_string(),
                config: json!({ "type": "ssh", "config": { "host": "host", "username": "admin" } }),
                first_used: 100,
                last_used: 200,
                use_count: 2,
                pinned: false,
                promoted: false,
            }],
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.entries.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&sample_store()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.entries.len(), 1);
        assert_eq!(result.data.entries[0].title, "admin@host");
        assert_eq!(result.data.entries[0].use_count, 2);
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt history data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.entries.is_empty());

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// A successful atomic save must leave only the target file behind — no
    /// leftover temporary write artifacts in the config directory (PER-002).
    #[test]
    fn save_leaves_no_stray_files() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&sample_store()).unwrap();

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

    /// Regression (PER-002): a save that cannot durably complete must fail
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
        storage.save(&sample_store()).unwrap();
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

        let result = storage.save(&SessionHistoryStore::default());

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
        serde_json::from_str::<SessionHistoryStore>(&after).expect("preserved store still parses");
    }
}
