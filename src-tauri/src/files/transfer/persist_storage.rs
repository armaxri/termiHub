//! Reading/writing the persisted transfer-queue JSON file (PROD-0011).
//!
//! Mirrors [`crate::workflows::history_storage::WorkflowRunHistoryStorage`]: the
//! write is atomic (temp file + rename) so an interrupted save cannot truncate
//! the queue into invalid JSON (PER-003), and it goes through the shared
//! schema-migration / downgrade-safety layer ([`crate::utils::migrate`]) so a
//! newer-version file is never clobbered (PER-004) and a corrupt file recovers
//! per-entry rather than resetting the whole queue.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::persist::PersistedTransferStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "transfers.json";

/// Handles reading/writing the `transfers.json` file (PROD-0011).
pub struct TransferPersistenceStorage {
    file_path: PathBuf,
}

impl TransferPersistenceStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set, it overrides the default Tauri config
    /// directory (portable / test isolation).
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;
        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;
        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery via the shared schema-migration layer: a current/older
    /// file is used as-is (or migrated forward), a **newer** file is left
    /// untouched and reported as a warning (never reset — PER-004), and only a
    /// genuinely unparseable file is backed up to `.bak` and reset.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<PersistedTransferStore>> {
        load_store_with_recovery::<PersistedTransferStore>(&self.file_path, FILE_NAME)
    }

    /// Save the store to disk (pretty-printed JSON, atomically). Refuses to
    /// overwrite a file written by a newer schema version (PER-004).
    pub fn save(&self, store: &PersistedTransferStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            PersistedTransferStore::STORE_NAME,
            PersistedTransferStore::CURRENT_VERSION,
        )?;
        let data = serde_json::to_string_pretty(store)
            .context("Failed to serialize persisted transfer queue")?;
        write_atomic(&self.file_path, &data)
            .context("Failed to write persisted transfer-queue file")?;
        Ok(())
    }

    /// Create a storage instance for testing (bypasses the Tauri `AppHandle`).
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
    use crate::files::transfer::persist::{PersistedTransfer, PersistedTransferStatus};
    use crate::files::transfer::TransferDirection;
    use tempfile::TempDir;

    fn entry(id: &str, status: PersistedTransferStatus) -> PersistedTransfer {
        PersistedTransfer {
            transfer_id: id.to_string(),
            session_id: "sess-a".to_string(),
            direction: TransferDirection::Upload,
            file_name: "f.bin".to_string(),
            remote_path: "/remote/f.bin".to_string(),
            local_path: Some("/tmp/f.bin".to_string()),
            status,
            transferred: 10,
            total: 100,
            resume_offset: 10,
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    fn sample_store() -> PersistedTransferStore {
        let mut store = PersistedTransferStore::default();
        store.upsert(entry("t1", PersistedTransferStatus::Active));
        store.upsert(entry("t2", PersistedTransferStatus::Paused));
        store
    }

    #[test]
    fn missing_file_returns_empty() {
        let dir = TempDir::new().unwrap();
        let storage = TransferPersistenceStorage::new_test(dir.path());
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.transfers.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = TransferPersistenceStorage::new_test(dir.path());
        storage.save(&sample_store()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.transfers.len(), 2);
        assert_eq!(
            result.data.get("t1").unwrap().status,
            PersistedTransferStatus::Active
        );
        assert_eq!(
            result.data.get("t2").unwrap().status,
            PersistedTransferStatus::Paused
        );
    }

    #[test]
    fn corrupt_file_recovers_to_empty_and_backs_up() {
        let dir = TempDir::new().unwrap();
        let storage = TransferPersistenceStorage::new_test(dir.path());
        fs::write(&storage.file_path, "not valid json !!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.transfers.is_empty());
        assert!(storage.file_path.with_extension("json.bak").exists());
    }

    /// PER-004 granular salvage: one valid + one corrupt entry keeps the valid
    /// one and drops only the corrupt one.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = TransferPersistenceStorage::new_test(dir.path());

        let mut value = serde_json::to_value(sample_store()).unwrap();
        value["transfers"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("corrupt transfer entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(
            result.data.transfers.len(),
            2,
            "the valid transfers survive"
        );
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(storage.file_path.with_extension("json.bak").exists());
    }

    /// PER-004: a newer-version file is left untouched and reported, never reset.
    #[test]
    fn newer_version_file_is_preserved() {
        let dir = TempDir::new().unwrap();
        let storage = TransferPersistenceStorage::new_test(dir.path());
        let newer = r#"{"version":"99","transfers":[]}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        // The save guard refuses to overwrite it.
        assert!(storage.save(&sample_store()).is_err());
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(after, newer, "the newer file is left byte-for-byte intact");
    }
}
