use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::config::EmbeddedServerStore;
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};

const FILE_NAME: &str = "embedded_servers.json";

/// Handles reading/writing the embedded_servers.json configuration file.
pub struct EmbeddedServerStorage {
    file_path: PathBuf,
}

impl EmbeddedServerStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = match std::env::var("TERMIHUB_CONFIG_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => app_handle
                .path()
                .app_config_dir()
                .context("Failed to resolve app config directory")?,
        };
        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;
        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery: on parse failure, back up the corrupt file and reset to defaults.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<EmbeddedServerStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: EmbeddedServerStore::default(),
                warnings: Vec::new(),
            });
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read embedded servers file")?;

        if let Ok(store) = serde_json::from_str::<EmbeddedServerStore>(&data) {
            return Ok(RecoveryResult {
                data: store,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up and reset to defaults.
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Embedded servers file is corrupt, backed up to {}",
            backup_path.display()
        );

        let parse_error = serde_json::from_str::<EmbeddedServerStore>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Embedded servers file was corrupt and has been reset.".to_string(),
            details: parse_error,
        };

        let defaults = EmbeddedServerStore::default();
        self.save(&defaults)
            .context("Failed to save defaults after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save the store to disk as pretty-printed JSON.
    pub fn save(&self, store: &EmbeddedServerStore) -> Result<()> {
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize embedded servers")?;
        fs::write(&self.file_path, data).context("Failed to write embedded servers file")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> EmbeddedServerStorage {
        EmbeddedServerStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
    }

    #[test]
    fn save_and_reload() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let store = EmbeddedServerStore::default();
        storage.save(&store).unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
    }

    #[test]
    fn corrupt_file_triggers_recovery() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "not valid json!!!").unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.servers.is_empty());
        // Backup should exist.
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }
}
