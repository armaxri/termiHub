use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::config::{ConnectionFolder, ConnectionStore, SavedConnection, SavedRemoteAgent};
use super::recovery::{RecoveryResult, RecoveryWarning};

const FILE_NAME: &str = "connections.json";

/// Handles reading/writing the connections JSON file.
pub struct ConnectionStorage {
    file_path: PathBuf,
}

impl ConnectionStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set, it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = match std::env::var("TERMIHUB_CONFIG_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => app_handle
                .path()
                .app_config_dir()
                .context("Failed to resolve app config directory")?,
        };

        tracing::info!("Using config directory: {}", config_dir.display());

        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery: on parse failure, attempts per-entry granular recovery.
    ///
    /// - If the file is missing, returns defaults with no warnings.
    /// - If structured parsing succeeds, returns normally.
    /// - If parsing fails, backs up the file to `.bak` and tries per-entry recovery
    ///   via `serde_json::Value`. Valid entries are kept; invalid entries are dropped
    ///   and reported as warnings.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<ConnectionStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: ConnectionStore::default(),
                warnings: Vec::new(),
            });
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read connections file")?;

        // Fast path: normal parse succeeds
        if let Ok(store) = serde_json::from_str::<ConnectionStore>(&data) {
            return Ok(RecoveryResult {
                data: store,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up the corrupt file
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Connections file is corrupt, backed up to {}",
            backup_path.display()
        );

        // Try to parse as unstructured JSON for per-entry recovery
        let value: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(e) => {
                // Completely unparseable — reset to defaults
                let warning = RecoveryWarning {
                    file_name: FILE_NAME.to_string(),
                    message: "Connections file was completely corrupt and has been reset."
                        .to_string(),
                    details: Some(e.to_string()),
                };
                tracing::error!("Connections file completely corrupt: {e}");
                let default_store = ConnectionStore::default();
                self.save(&default_store)
                    .context("Failed to save default connections after recovery")?;
                return Ok(RecoveryResult {
                    data: default_store,
                    warnings: vec![warning],
                });
            }
        };

        // Granular recovery: try each entry individually
        let mut warnings = Vec::new();
        let mut recovered_connections = Vec::new();
        let mut recovered_folders = Vec::new();
        let mut recovered_agents = Vec::new();

        if let Some(arr) = value.get("connections").and_then(|v| v.as_array()) {
            for (i, entry) in arr.iter().enumerate() {
                match serde_json::from_value::<SavedConnection>(entry.clone()) {
                    Ok(conn) => recovered_connections.push(conn),
                    Err(e) => {
                        let name = entry
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        warnings.push(RecoveryWarning {
                            file_name: FILE_NAME.to_string(),
                            message: format!(
                                "Removed corrupt connection entry at index {i} (\"{name}\")."
                            ),
                            details: Some(e.to_string()),
                        });
                        tracing::warn!("Dropped corrupt connection at index {i} (\"{name}\"): {e}");
                    }
                }
            }
        }

        if let Some(arr) = value.get("folders").and_then(|v| v.as_array()) {
            for (i, entry) in arr.iter().enumerate() {
                match serde_json::from_value::<ConnectionFolder>(entry.clone()) {
                    Ok(folder) => recovered_folders.push(folder),
                    Err(e) => {
                        let name = entry
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        warnings.push(RecoveryWarning {
                            file_name: FILE_NAME.to_string(),
                            message: format!(
                                "Removed corrupt folder entry at index {i} (\"{name}\")."
                            ),
                            details: Some(e.to_string()),
                        });
                        tracing::warn!("Dropped corrupt folder at index {i} (\"{name}\"): {e}");
                    }
                }
            }
        }

        if let Some(arr) = value.get("agents").and_then(|v| v.as_array()) {
            for (i, entry) in arr.iter().enumerate() {
                match serde_json::from_value::<SavedRemoteAgent>(entry.clone()) {
                    Ok(agent) => recovered_agents.push(agent),
                    Err(e) => {
                        let name = entry
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        warnings.push(RecoveryWarning {
                            file_name: FILE_NAME.to_string(),
                            message: format!(
                                "Removed corrupt agent entry at index {i} (\"{name}\")."
                            ),
                            details: Some(e.to_string()),
                        });
                        tracing::warn!("Dropped corrupt agent at index {i} (\"{name}\"): {e}");
                    }
                }
            }
        }

        // If no per-entry warnings, the top-level structure itself was broken
        if warnings.is_empty() {
            warnings.push(RecoveryWarning {
                file_name: FILE_NAME.to_string(),
                message: "Connections file had an invalid structure and has been repaired."
                    .to_string(),
                details: None,
            });
        }

        let version = value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("1")
            .to_string();
        let recovered_store = ConnectionStore {
            version,
            connections: recovered_connections,
            folders: recovered_folders,
            agents: recovered_agents,
        };

        self.save(&recovered_store)
            .context("Failed to save recovered connections")?;

        Ok(RecoveryResult {
            data: recovered_store,
            warnings,
        })
    }

    /// Save the connection store to disk (pretty-printed JSON).
    pub fn save(&self, store: &ConnectionStore) -> Result<()> {
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize connections")?;

        fs::write(&self.file_path, data).context("Failed to write connections file")?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> ConnectionStorage {
        ConnectionStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.connections.is_empty());
        assert!(result.data.folders.is_empty());
        assert!(result.data.agents.is_empty());
    }

    #[test]
    fn load_with_recovery_valid_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = ConnectionStore {
            version: "1".to_string(),
            folders: vec![],
            connections: vec![],
            agents: vec![],
        };
        storage.save(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.version, "1");
    }

    #[test]
    fn load_with_recovery_completely_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "this is not json at all!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("completely corrupt"));
        assert!(result.data.connections.is_empty());

        // Backup file should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            "this is not json at all!!!"
        );
    }

    #[test]
    fn load_with_recovery_partial_connections() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Write JSON with one valid and one invalid connection
        let json = r#"{
            "version": "1",
            "folders": [],
            "connections": [
                {
                    "id": "good-1",
                    "name": "Good Connection",
                    "config": { "type": "local", "config": {} }
                },
                {
                    "id": 12345,
                    "broken": true
                }
            ],
            "agents": []
        }"#;
        fs::write(&storage.file_path, json).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.connections.len(), 1);
        assert_eq!(result.data.connections[0].id, "good-1");
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("index 1"));

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    #[test]
    fn load_with_recovery_invalid_structure_but_valid_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Valid JSON but wrong structure (missing required fields)
        fs::write(&storage.file_path, r#"{"foo": "bar"}"#).unwrap();

        let result = storage.load_with_recovery().unwrap();
        // Should have a warning about invalid structure
        assert!(!result.warnings.is_empty());
        assert!(result.data.connections.is_empty());
    }
}
