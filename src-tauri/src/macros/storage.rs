use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::MacroStore;
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::config_paths::resolve_config_dir;

const FILE_NAME: &str = "macros.json";

/// Handles reading/writing the macros JSON file.
pub struct MacroStorage {
    file_path: PathBuf,
}

impl MacroStorage {
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
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<MacroStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: MacroStore::default(),
                warnings: Vec::new(),
            });
        }

        let data = fs::read_to_string(&self.file_path).context("Failed to read macros file")?;

        // Fast path: normal parse succeeds
        if let Ok(store) = serde_json::from_str::<MacroStore>(&data) {
            return Ok(RecoveryResult {
                data: store,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up and reset to defaults
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Macros file is corrupt, backed up to {}",
            backup_path.display()
        );

        let parse_error = serde_json::from_str::<MacroStore>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Macros file was corrupt and has been reset.".to_string(),
            details: parse_error,
        };
        tracing::error!("Macros file corrupt, resetting to defaults");

        let defaults = MacroStore::default();
        self.save(&defaults)
            .context("Failed to save default macros after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save the macro store to disk (pretty-printed JSON).
    pub fn save(&self, store: &MacroStore) -> Result<()> {
        let data = serde_json::to_string_pretty(store).context("Failed to serialize macros")?;

        fs::write(&self.file_path, data).context("Failed to write macros file")?;

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
    use crate::macros::config::{Macro, MacroStep};
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> MacroStorage {
        MacroStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    fn sample_store() -> MacroStore {
        MacroStore {
            version: "1".to_string(),
            macros: vec![Macro {
                id: "macro-1".to_string(),
                name: "List".to_string(),
                description: Some("List files".to_string()),
                tags: vec!["fs".to_string()],
                steps: vec![MacroStep {
                    data: "ls -la\r".to_string(),
                    delay_ms: 100,
                }],
                created_at: "2026-07-19T00:00:00Z".to_string(),
                updated_at: "2026-07-19T00:00:00Z".to_string(),
            }],
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.macros.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = sample_store();
        storage.save(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.macros.len(), 1);
        assert_eq!(result.data.macros[0].name, "List");
        assert_eq!(result.data.macros[0].steps[0].data, "ls -la\r");
        assert_eq!(result.data.macros[0].steps[0].delay_ms, 100);
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt macro data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.macros.is_empty());

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }
}
