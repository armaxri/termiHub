use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{ConnectionStore, ConnectionTreeNode, FlatConnectionStore, SavedRemoteAgent};
use super::recovery::{RecoveryResult, RecoveryWarning};
use super::tree::flatten_tree;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_versioned, LoadOutcome, VersionedStore};

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
        let config_dir = resolve_config_dir(Some(app_handle))?;

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

        // Version gate first (PER-001/PER-004): read the on-disk `version` before
        // the typed parse. A current/older file loads (or migrates) as usual; a
        // NEWER file is left completely intact and reported — never treated as
        // corrupt and reset. Only a genuinely-unparseable file falls through to
        // the granular per-node recovery below.
        match load_versioned::<ConnectionStore>(&data) {
            LoadOutcome::Loaded { data: store, .. } => {
                let (connections, folders) = flatten_tree(&store.children, None);
                let mut flat = FlatConnectionStore {
                    connections,
                    folders,
                    agents: store.agents,
                };
                self.migrate_plugin_type_ids(&mut flat);
                return Ok(RecoveryResult {
                    data: flat,
                    warnings: Vec::new(),
                });
            }
            LoadOutcome::Newer(err) => {
                tracing::error!("{err}");
                return Ok(RecoveryResult {
                    data: FlatConnectionStore {
                        connections: Vec::new(),
                        folders: Vec::new(),
                        agents: Vec::new(),
                    },
                    warnings: vec![RecoveryWarning {
                        file_name: FILE_NAME.to_string(),
                        message: format!(
                            "This connections file was written by a newer version of termiHub \
                             (schema v{}). It was left unchanged to avoid data loss; changes made \
                             now will not be saved over it. Update termiHub to use this data.",
                            err.found
                        ),
                        details: Some(err.to_string()),
                    }],
                });
            }
            // Genuinely unparseable at/below the current version — fall through to
            // the granular per-node recovery, which salvages what it can.
            LoadOutcome::Corrupt(_) => {}
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
            version: ConnectionStore::CURRENT_VERSION.to_string(),
            children: recovered_children,
            agents: recovered_agents,
        };

        self.save_store(&recovered_store)
            .context("Failed to save recovered connections")?;

        let (connections, folders) = flatten_tree(&recovered_store.children, None);
        let mut flat = FlatConnectionStore {
            connections,
            folders,
            agents: recovered_store.agents,
        };
        self.migrate_plugin_type_ids(&mut flat);

        Ok(RecoveryResult {
            data: flat,
            warnings,
        })
    }

    /// Rewrite legacy (load-order-disambiguated) plugin connection-type ids to
    /// their stable `plugin:<plugin-id>:<type>` form (PLG-007), resolving them
    /// against the plugins installed next to this file. A connection whose
    /// plugin is not installed is kept unchanged. When anything was rewritten the
    /// result is persisted right away (best-effort) so the resolution sticks even
    /// if the plugin set changes before the next user edit.
    fn migrate_plugin_type_ids(&self, flat: &mut FlatConnectionStore) {
        let Some(config_dir) = self.file_path.parent() else {
            return;
        };
        let resolver = super::plugin_type_ids::legacy_resolver(config_dir);
        if super::plugin_type_ids::migrate_connections(&mut flat.connections, &resolver) {
            if let Err(e) = self.save_flat(flat) {
                tracing::warn!("Failed to persist migrated plugin connection types: {e:#}");
            }
        }
    }

    /// Save the connection store to disk (pretty-printed JSON).
    ///
    /// Takes the on-disk `ConnectionStore` (nested tree format). Before writing,
    /// [`guard_not_newer`] refuses to overwrite a file written by a newer schema
    /// version (PER-004), so an older build can never clobber a newer one's
    /// connections. (`save_flat` routes through here, so it is guarded too.)
    pub fn save_store(&self, store: &ConnectionStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            ConnectionStore::STORE_NAME,
            ConnectionStore::CURRENT_VERSION,
        )?;

        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize connections")?;

        write_atomic(&self.file_path, &data).context("Failed to write connections file")?;

        Ok(())
    }

    /// Save flat in-memory data to disk by first building the nested tree.
    pub fn save_flat(&self, flat: &FlatConnectionStore) -> Result<()> {
        let tree = super::tree::build_tree(&flat.connections, &flat.folders);
        let store = ConnectionStore {
            version: ConnectionStore::CURRENT_VERSION.to_string(),
            children: tree,
            agents: flat.agents.clone(),
        };
        self.save_store(&store)
    }

    /// Create a storage instance pointing directly at `file_path`.
    /// Only available in tests; production code must go through `new()`.
    #[cfg(test)]
    pub fn new_for_test(file_path: std::path::PathBuf) -> Self {
        Self { file_path }
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

    /// Regression (#2320): a `save_store` that cannot durably complete must fail
    /// **without** clobbering the previously-saved connections. The old
    /// truncate-in-place `fs::write` would succeed by overwriting the existing
    /// file, so this fails red on it; the atomic temp+rename write cannot create
    /// its temp file in a read-only directory and therefore leaves the prior
    /// `connections.json` untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_connections() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = ConnectionStore {
            version: "2".to_string(),
            children: vec![],
            agents: vec![],
        };
        storage.save_store(&store).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

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

        let result = storage.save_store(&store);
        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous connections fully intact"
        );
        serde_json::from_str::<ConnectionStore>(&after).expect("preserved store still parses");
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
                icon: None,
                name: "Test".to_string(),
                config: crate::terminal::backend::ConnectionConfig {
                    type_id: "local".to_string(),
                    settings: serde_json::json!({"shell": "bash"}),
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
                    icon: None,
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
                icon: None,
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

        // Verify on-disk format is the nested tree, at the current schema (v3)
        let raw = fs::read_to_string(&storage.file_path).unwrap();
        let on_disk: ConnectionStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(on_disk.version, "3");
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

    /// A v2 file carrying legacy plugin type ids, alongside a built-in.
    fn legacy_v2_file(types: &[(&str, &str)]) -> String {
        let children: Vec<serde_json::Value> = types
            .iter()
            .map(|(name, ty)| {
                serde_json::json!({
                    "type": "connection",
                    "name": name,
                    "config": { "type": ty, "config": { "pod": name } }
                })
            })
            .collect();
        serde_json::json!({ "version": "2", "children": children }).to_string()
    }

    fn type_of<'a>(flat: &'a FlatConnectionStore, name: &str) -> &'a str {
        &flat
            .connections
            .iter()
            .find(|c| c.name == name)
            .unwrap()
            .config
            .type_id
    }

    /// PLG-007: loading a pre-namespacing (v2) file rewrites legacy plugin type
    /// ids to `plugin:<id>:<type>` against the installed plugins, persists that as
    /// v3, keeps built-ins, resolves an ambiguous plain id deterministically, and
    /// keeps (never drops) a connection whose plugin is not installed.
    #[test]
    fn load_migrates_legacy_plugin_type_ids_to_namespaced() {
        use crate::connection::plugin_type_ids::write_backend_plugin_manifest;

        let dir = TempDir::new().unwrap();
        write_backend_plugin_manifest(dir.path(), "beta", "k8s");
        write_backend_plugin_manifest(dir.path(), "alpha", "k8s");
        write_backend_plugin_manifest(dir.path(), "gamma", "ssh");
        let storage = create_test_storage(&dir);
        fs::write(
            &storage.file_path,
            legacy_v2_file(&[
                ("builtin", "ssh"),
                ("first", "k8s"),
                ("second", "k8s-beta"),
                ("collider", "ssh-gamma"),
                ("orphan", "mqtt"),
            ]),
        )
        .unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.warnings.is_empty());
        let flat = &loaded.data;
        assert_eq!(flat.connections.len(), 5, "no connection may be dropped");
        assert_eq!(type_of(flat, "builtin"), "ssh");
        assert_eq!(type_of(flat, "first"), "plugin:alpha:k8s");
        assert_eq!(type_of(flat, "second"), "plugin:beta:k8s");
        assert_eq!(type_of(flat, "collider"), "plugin:gamma:ssh");
        assert_eq!(type_of(flat, "orphan"), "mqtt");
        // Settings ride along untouched.
        let second = flat
            .connections
            .iter()
            .find(|c| c.name == "second")
            .unwrap();
        assert_eq!(second.config.settings["pod"], "second");

        // The migration was persisted at the new schema version.
        let raw = fs::read_to_string(&storage.file_path).unwrap();
        let on_disk: ConnectionStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(on_disk.version, "3");
        assert!(raw.contains("plugin:beta:k8s"));
        assert!(!raw.contains("k8s-beta"));
    }

    /// The migration does not depend on which order the plugins were installed
    /// (the directory scan order): the same file resolves identically.
    #[test]
    fn legacy_migration_is_independent_of_plugin_install_order() {
        use crate::connection::plugin_type_ids::write_backend_plugin_manifest;

        let mut results = Vec::new();
        for order in [["alpha", "beta"], ["beta", "alpha"]] {
            let dir = TempDir::new().unwrap();
            for id in order {
                write_backend_plugin_manifest(dir.path(), id, "k8s");
            }
            let storage = create_test_storage(&dir);
            fs::write(
                &storage.file_path,
                legacy_v2_file(&[("a", "k8s"), ("b", "k8s-alpha"), ("c", "k8s-beta")]),
            )
            .unwrap();
            let flat = storage.load_with_recovery().unwrap().data;
            results.push(
                ["a", "b", "c"]
                    .map(|n| type_of(&flat, n).to_string())
                    .to_vec(),
            );
        }
        assert_eq!(results[0], results[1]);
        assert_eq!(
            results[0],
            ["plugin:alpha:k8s", "plugin:alpha:k8s", "plugin:beta:k8s"]
        );
    }

    /// A connection whose plugin is missing keeps its legacy id and heals on a
    /// later load once the plugin is installed. Nothing is rewritten (or saved)
    /// while it cannot be resolved.
    #[test]
    fn missing_plugin_connection_is_kept_and_heals_once_installed() {
        use crate::connection::plugin_type_ids::write_backend_plugin_manifest;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let original = legacy_v2_file(&[("orphan", "k8s")]);
        fs::write(&storage.file_path, &original).unwrap();

        let flat = storage.load_with_recovery().unwrap().data;
        assert_eq!(type_of(&flat, "orphan"), "k8s");
        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), original);

        write_backend_plugin_manifest(dir.path(), "beta", "k8s");
        let flat = storage.load_with_recovery().unwrap().data;
        assert_eq!(type_of(&flat, "orphan"), "plugin:beta:k8s");
    }

    /// Downgrade safety: a file the current build wrote (v3, namespaced ids) is
    /// refused for overwrite by a v2 build — the version gate an older binary runs
    /// before every save — so it cannot mangle ids it does not understand.
    #[test]
    fn v3_file_is_protected_from_a_v2_build() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        storage.save_store(&ConnectionStore::default()).unwrap();

        let err = guard_not_newer(&storage.file_path, ConnectionStore::STORE_NAME, 2).unwrap_err();
        assert!(err.to_string().contains("newer version"), "{err}");
        let raw = fs::read_to_string(&storage.file_path).unwrap();
        assert!(matches!(
            load_versioned::<ConnectionStore>(&raw),
            LoadOutcome::Loaded { .. }
        ));
    }
}
