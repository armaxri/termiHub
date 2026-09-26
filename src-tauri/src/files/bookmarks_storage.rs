//! On-disk storage for the file-browser bookmarks (PROD-007, #3558).

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::bookmarks::FileBookmarkStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "file-browser-bookmarks.json";

/// Handles reading/writing the bookmarks JSON file. Mirrors
/// [`crate::network::tool_history_storage::NetworkToolHistoryStorage`].
pub struct FileBookmarkStorage {
    file_path: PathBuf,
}

impl FileBookmarkStorage {
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

    /// Load with recovery via the shared schema-migration layer: a newer file is
    /// left untouched and reported (PER-004), a corrupt entry is dropped, and
    /// only a genuinely unparseable file is backed up to `.bak` and reset.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<FileBookmarkStore>> {
        load_store_with_recovery::<FileBookmarkStore>(&self.file_path, FILE_NAME)
    }

    /// Save atomically, refusing to overwrite a file a newer schema wrote.
    pub fn save(&self, store: &FileBookmarkStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            FileBookmarkStore::STORE_NAME,
            FileBookmarkStore::CURRENT_VERSION,
        )?;
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize bookmarks")?;
        write_atomic(&self.file_path, &data).context("Failed to write bookmarks file")?;
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
    use crate::files::bookmarks::FileBookmark;
    use tempfile::TempDir;

    fn bookmark(id: &str) -> FileBookmark {
        FileBookmark {
            id: id.to_string(),
            scope: "local".to_string(),
            path: format!("/tmp/{id}"),
            name: id.to_string(),
            created_at: "2026-09-26T00:00:00Z".to_string(),
        }
    }

    fn sample_store() -> FileBookmarkStore {
        FileBookmarkStore {
            bookmarks: vec![bookmark("a"), bookmark("b")],
            ..Default::default()
        }
    }

    #[test]
    fn missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = FileBookmarkStorage::new_test(dir.path());
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.bookmarks.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = FileBookmarkStorage::new_test(dir.path());
        storage.save(&sample_store()).unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.bookmarks, vec![bookmark("a"), bookmark("b")]);
    }

    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = FileBookmarkStorage::new_test(dir.path());
        let mut value = serde_json::to_value(sample_store()).unwrap();
        value["bookmarks"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id": "broken"}));
        fs::write(&storage.file_path, value.to_string()).unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.bookmarks.len(), 2);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn newer_file_is_left_intact() {
        let dir = TempDir::new().unwrap();
        let storage = FileBookmarkStorage::new_test(dir.path());
        let newer = r#"{"version": "99", "bookmarks": [], "fromTheFuture": true}"#;
        fs::write(&storage.file_path, newer).unwrap();
        let loaded = storage.load_with_recovery().unwrap();
        assert!(!loaded.warnings.is_empty());
        assert!(storage.save(&sample_store()).is_err());
        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), newer);
    }
}
