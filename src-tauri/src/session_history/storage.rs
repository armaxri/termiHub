use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::SessionHistoryStore;
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::config_paths::resolve_config_dir;

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

    /// Load with recovery: on parse failure, backs up the corrupt file and resets to defaults.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<SessionHistoryStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: SessionHistoryStore::default(),
                warnings: Vec::new(),
            });
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read session-history file")?;

        // Fast path: normal parse succeeds.
        if let Ok(store) = serde_json::from_str::<SessionHistoryStore>(&data) {
            return Ok(RecoveryResult {
                data: store,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up and reset to defaults.
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Session-history file is corrupt, backed up to {}",
            backup_path.display()
        );

        let parse_error = serde_json::from_str::<SessionHistoryStore>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Session-history file was corrupt and has been reset.".to_string(),
            details: parse_error,
        };
        tracing::error!("Session-history file corrupt, resetting to defaults");

        let defaults = SessionHistoryStore::default();
        self.save(&defaults)
            .context("Failed to save default session history after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save the session-history store to disk (pretty-printed JSON).
    pub fn save(&self, store: &SessionHistoryStore) -> Result<()> {
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize session history")?;

        fs::write(&self.file_path, data).context("Failed to write session-history file")?;

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
}
