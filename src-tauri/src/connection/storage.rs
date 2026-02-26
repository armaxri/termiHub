use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::config::{ConnectionStore, ConnectionTreeNode, FlatConnectionStore, SavedRemoteAgent};
use super::recovery::{RecoveryResult, RecoveryWarning};
use super::tree::flatten_tree;

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

    /// Load the connections file, recovering gracefully from corruption.
    ///
    /// - If the file is missing, returns defaults with no warnings.
    /// - If parsing succeeds, flattens the tree to in-memory arrays.
    /// - If parsing fails, backs up to `.bak` and attempts recursive node recovery.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<FlatConnectionStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: FlatConnectionStore {
                    connections: Vec::new(),
                    folders: Vec::new(),
                    agents: Vec::new(),
                },
                warnings: Vec::new(),
            });
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read connections file")?;

        // Fast path: normal parse succeeds
        if let Ok(store) = serde_json::from_str::<ConnectionStore>(&data) {
            let (connections, folders) = flatten_tree(&store.children, None);
            return Ok(RecoveryResult {
                data: FlatConnectionStore {
                    connections,
                    folders,
                    agents: store.agents,
                },
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

        // Try to parse as unstructured JSON for per-node recovery
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
                self.save_store(&default_store)
                    .context("Failed to save default connections after recovery")?;
                return Ok(RecoveryResult {
                    data: FlatConnectionStore {
                        connections: Vec::new(),
                        folders: Vec::new(),
                        agents: Vec::new(),
                    },
                    warnings: vec![warning],
                });
            }
        };

        // Granular recovery: try each node individually
        let mut warnings = Vec::new();
        let mut recovered_children = Vec::new();
        let mut recovered_agents = Vec::new();

        if let Some(arr) = value.get("children").and_then(|v| v.as_array()) {
            recover_nodes_recursive(arr, &mut recovered_children, &mut warnings, "");
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

        let recovered_store = ConnectionStore {
            version: "2".to_string(),
            children: recovered_children,
            agents: recovered_agents,
        };

        self.save_store(&recovered_store)
            .context("Failed to save recovered connections")?;

        let (connections, folders) = flatten_tree(&recovered_store.children, None);

        Ok(RecoveryResult {
            data: FlatConnectionStore {
                connections,
                folders,
                agents: recovered_store.agents,
            },
            warnings,
        })
    }

    /// Save the connection store to disk (pretty-printed JSON).
    ///
    /// Takes the on-disk `ConnectionStore` (nested tree format).
    pub fn save_store(&self, store: &ConnectionStore) -> Result<()> {
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize connections")?;

        fs::write(&self.file_path, data).context("Failed to write connections file")?;

        Ok(())
    }

    /// Save flat in-memory data to disk by first building the nested tree.
    pub fn save_flat(&self, flat: &FlatConnectionStore) -> Result<()> {
        let tree = super::tree::build_tree(&flat.connections, &flat.folders);
        let store = ConnectionStore {
            version: "2".to_string(),
            children: tree,
            agents: flat.agents.clone(),
        };
        self.save_store(&store)
    }
}

/// Recursively recover valid tree nodes from a JSON array,
/// dropping corrupt entries and recording warnings.
fn recover_nodes_recursive(
    arr: &[serde_json::Value],
    recovered: &mut Vec<ConnectionTreeNode>,
    warnings: &mut Vec<RecoveryWarning>,
    path_context: &str,
) {
    for (i, entry) in arr.iter().enumerate() {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let node_path = if path_context.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", path_context, name)
        };

        let type_str = entry.get("type").and_then(|v| v.as_str());

        match type_str {
            Some("folder") => {
                // Try to recover children recursively even if this folder partially fails
                let is_expanded = entry
                    .get("isExpanded")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let mut child_nodes = Vec::new();
                if let Some(child_arr) = entry.get("children").and_then(|v| v.as_array()) {
                    recover_nodes_recursive(child_arr, &mut child_nodes, warnings, &node_path);
                }

                recovered.push(ConnectionTreeNode::Folder {
                    name: name.to_string(),
                    is_expanded,
                    children: child_nodes,
                });
            }
            Some("connection") => {
                match serde_json::from_value::<ConnectionTreeNode>(entry.clone()) {
                    Ok(node) => recovered.push(node),
                    Err(e) => {
                        warnings.push(RecoveryWarning {
                            file_name: FILE_NAME.to_string(),
                            message: format!(
                                "Removed corrupt connection at index {i} (\"{node_path}\")."
                            ),
                            details: Some(e.to_string()),
                        });
                        tracing::warn!(
                            "Dropped corrupt connection at index {i} (\"{node_path}\"): {e}"
                        );
                    }
                }
            }
            _ => {
                warnings.push(RecoveryWarning {
                    file_name: FILE_NAME.to_string(),
                    message: format!("Removed unrecognized entry at index {i} (\"{node_path}\")."),
                    details: Some(format!(
                        "Expected type 'folder' or 'connection', got {:?}",
                        type_str
                    )),
                });
                tracing::warn!(
                    "Dropped unrecognized entry at index {i} (\"{node_path}\"): type={:?}",
                    type_str
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::config::{ConnectionFolder, SavedConnection};
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
    fn load_with_recovery_valid_v2_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = ConnectionStore {
            version: "2".to_string(),
            children: vec![ConnectionTreeNode::Connection {
                name: "Test".to_string(),
                config: crate::terminal::backend::ConnectionConfig {
                    type_id: "local".to_string(),
                    settings: serde_json::json!({"shellType": "bash"}),
                },
                terminal_options: None,
            }],
            agents: vec![],
        };
        storage.save_store(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.connections.len(), 1);
        assert_eq!(result.data.connections[0].name, "Test");
        assert_eq!(result.data.connections[0].id, "Test");
        assert_eq!(result.data.connections[0].folder_id, None);
    }

    #[test]
    fn load_with_recovery_nested_folder() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = ConnectionStore {
            version: "2".to_string(),
            children: vec![ConnectionTreeNode::Folder {
                name: "Work".to_string(),
                is_expanded: true,
                children: vec![ConnectionTreeNode::Connection {
                    name: "SSH".to_string(),
                    config: crate::terminal::backend::ConnectionConfig {
                        type_id: "ssh".to_string(),
                        settings: serde_json::json!({"host": "example.com"}),
                    },
                    terminal_options: None,
                }],
            }],
            agents: vec![],
        };
        storage.save_store(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.folders.len(), 1);
        assert_eq!(result.data.folders[0].id, "Work");
        assert_eq!(result.data.connections.len(), 1);
        assert_eq!(result.data.connections[0].id, "Work/SSH");
        assert_eq!(
            result.data.connections[0].folder_id.as_deref(),
            Some("Work")
        );
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
    fn load_with_recovery_partial_children() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Write JSON with one valid connection and one corrupt entry
        let json = r#"{
            "version": "2",
            "children": [
                {
                    "type": "connection",
                    "name": "Good Connection",
                    "config": { "type": "local", "config": {} }
                },
                {
                    "type": "connection",
                    "broken": true
                }
            ],
            "agents": []
        }"#;
        fs::write(&storage.file_path, json).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.connections.len(), 1);
        assert_eq!(result.data.connections[0].name, "Good Connection");
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

    #[test]
    fn save_flat_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let flat = FlatConnectionStore {
            connections: vec![SavedConnection {
                id: "Work/SSH".to_string(),
                name: "SSH".to_string(),
                config: crate::terminal::backend::ConnectionConfig {
                    type_id: "ssh".to_string(),
                    settings: serde_json::json!({"host": "example.com"}),
                },
                folder_id: Some("Work".to_string()),
                terminal_options: None,
                source_file: None,
            }],
            folders: vec![ConnectionFolder {
                id: "Work".to_string(),
                name: "Work".to_string(),
                parent_id: None,
                is_expanded: true,
            }],
            agents: vec![],
        };

        storage.save_flat(&flat).unwrap();

        // Verify on-disk format is nested v2
        let raw = fs::read_to_string(&storage.file_path).unwrap();
        let on_disk: ConnectionStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(on_disk.version, "2");
        assert_eq!(on_disk.children.len(), 1); // One folder
        match &on_disk.children[0] {
            ConnectionTreeNode::Folder { name, children, .. } => {
                assert_eq!(name, "Work");
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected folder"),
        }

        // Load back and verify
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.connections.len(), 1);
        assert_eq!(result.data.connections[0].name, "SSH");
        assert_eq!(result.data.connections[0].id, "Work/SSH");
    }
}
