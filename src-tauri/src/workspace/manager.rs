use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{
    WorkspaceDefinition, WorkspaceExportData, WorkspaceExportEntry, WorkspaceImportPreview,
    WorkspaceLayoutNode, WorkspaceStore, WorkspaceSummary, WorkspaceTabDef,
};
use super::storage::WorkspaceStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// Central workspace manager: CRUD for workspace definitions.
pub struct WorkspaceManager {
    store: Mutex<WorkspaceStore>,
    storage: WorkspaceStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl WorkspaceManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            WorkspaceStorage::new(app_handle).context("Failed to initialize workspace storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load workspaces")?;

        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// Get workspace summaries for sidebar listing.
    pub fn get_workspaces(&self) -> Result<Vec<WorkspaceSummary>, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        Ok(store.workspaces.iter().map(|ws| ws.to_summary()).collect())
    }

    /// Load a full workspace definition by ID.
    pub fn load_workspace(&self, id: &str) -> Result<WorkspaceDefinition, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        store
            .workspaces
            .iter()
            .find(|ws| ws.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::WorkspaceError(format!("Workspace not found: {id}")))
    }

    /// Save (add or update) a workspace definition.
    pub fn save_workspace(&self, definition: WorkspaceDefinition) -> Result<(), TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        if let Some(existing) = store
            .workspaces
            .iter_mut()
            .find(|ws| ws.id == definition.id)
        {
            *existing = definition;
        } else {
            store.workspaces.push(definition);
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))
    }

    /// Delete a workspace by ID.
    pub fn delete_workspace(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let len_before = store.workspaces.len();
        store.workspaces.retain(|ws| ws.id != id);

        if store.workspaces.len() == len_before {
            return Err(TerminalError::WorkspaceError(format!(
                "Workspace not found: {id}"
            )));
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))
    }

    /// Duplicate a workspace by ID, returning the new workspace's ID.
    pub fn duplicate_workspace(&self, id: &str) -> Result<String, TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let original = store
            .workspaces
            .iter()
            .find(|ws| ws.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::WorkspaceError(format!("Workspace not found: {id}")))?;

        let new_id = format!(
            "ws-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().to_string()[..6]
        );

        let duplicate = WorkspaceDefinition {
            id: new_id.clone(),
            name: format!("Copy of {}", original.name),
            description: original.description,
            layout: original.layout,
        };

        store.workspaces.push(duplicate);

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        Ok(new_id)
    }

    /// Export all workspaces as portable JSON.
    /// Connection IDs are replaced with connection names for portability.
    pub fn export_json(
        &self,
        id_to_name: &HashMap<String, String>,
    ) -> Result<String, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let entries: Vec<WorkspaceExportEntry> = store
            .workspaces
            .iter()
            .map(|ws| WorkspaceExportEntry {
                name: ws.name.clone(),
                description: ws.description.clone(),
                layout: replace_connection_ids_with_names(&ws.layout, id_to_name),
            })
            .collect();

        let export = WorkspaceExportData {
            version: "1".to_string(),
            workspaces: entries,
        };

        serde_json::to_string_pretty(&export)
            .map_err(|e| TerminalError::WorkspaceError(format!("Failed to serialize: {e}")))
    }

    /// Import workspaces from portable JSON.
    /// Connection names are resolved back to IDs. Skips workspaces whose
    /// name already exists.
    pub fn import_json(
        &self,
        json: &str,
        name_to_id: &HashMap<String, String>,
    ) -> Result<usize, TerminalError> {
        let data: WorkspaceExportData = serde_json::from_str(json)
            .map_err(|e| TerminalError::WorkspaceError(format!("Invalid import data: {e}")))?;

        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let mut count = 0;
        for entry in data.workspaces {
            // Skip if a workspace with the same name already exists
            if store.workspaces.iter().any(|ws| ws.name == entry.name) {
                continue;
            }

            let new_id = format!(
                "ws-{}-{}",
                chrono::Utc::now().timestamp_millis(),
                &uuid::Uuid::new_v4().to_string()[..6]
            );

            let definition = WorkspaceDefinition {
                id: new_id,
                name: entry.name,
                description: entry.description,
                layout: resolve_connection_names_to_ids(&entry.layout, name_to_id),
            };

            store.workspaces.push(definition);
            count += 1;
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        Ok(count)
    }

    /// Preview an import file without importing.
    pub fn preview_import_json(json: &str) -> Result<WorkspaceImportPreview, TerminalError> {
        let data: WorkspaceExportData = serde_json::from_str(json)
            .map_err(|e| TerminalError::WorkspaceError(format!("Invalid import data: {e}")))?;

        let total_tab_count = data
            .workspaces
            .iter()
            .map(|ws| count_layout_tabs(&ws.layout))
            .sum();

        Ok(WorkspaceImportPreview {
            workspace_count: data.workspaces.len(),
            total_tab_count,
        })
    }
}

/// Replace connection ref IDs with connection names for export.
fn replace_connection_ids_with_names(
    layout: &WorkspaceLayoutNode,
    id_to_name: &HashMap<String, String>,
) -> WorkspaceLayoutNode {
    match layout {
        WorkspaceLayoutNode::Leaf { tabs } => WorkspaceLayoutNode::Leaf {
            tabs: tabs
                .iter()
                .map(|tab| WorkspaceTabDef {
                    connection_ref: tab
                        .connection_ref
                        .as_ref()
                        .map(|id| id_to_name.get(id).cloned().unwrap_or_else(|| id.clone())),
                    ..tab.clone()
                })
                .collect(),
        },
        WorkspaceLayoutNode::Split {
            direction,
            children,
            sizes,
        } => WorkspaceLayoutNode::Split {
            direction: direction.clone(),
            children: children
                .iter()
                .map(|c| replace_connection_ids_with_names(c, id_to_name))
                .collect(),
            sizes: sizes.clone(),
        },
    }
}

/// Resolve connection names back to IDs for import.
fn resolve_connection_names_to_ids(
    layout: &WorkspaceLayoutNode,
    name_to_id: &HashMap<String, String>,
) -> WorkspaceLayoutNode {
    match layout {
        WorkspaceLayoutNode::Leaf { tabs } => WorkspaceLayoutNode::Leaf {
            tabs: tabs
                .iter()
                .map(|tab| WorkspaceTabDef {
                    connection_ref: tab.connection_ref.as_ref().map(|name| {
                        name_to_id
                            .get(name)
                            .cloned()
                            .unwrap_or_else(|| name.clone())
                    }),
                    ..tab.clone()
                })
                .collect(),
        },
        WorkspaceLayoutNode::Split {
            direction,
            children,
            sizes,
        } => WorkspaceLayoutNode::Split {
            direction: direction.clone(),
            children: children
                .iter()
                .map(|c| resolve_connection_names_to_ids(c, name_to_id))
                .collect(),
            sizes: sizes.clone(),
        },
    }
}

/// Count tabs in a layout tree (used by preview).
fn count_layout_tabs(node: &WorkspaceLayoutNode) -> usize {
    match node {
        WorkspaceLayoutNode::Leaf { tabs } => tabs.len(),
        WorkspaceLayoutNode::Split { children, .. } => children.iter().map(count_layout_tabs).sum(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config::{SplitDirection, WorkspaceLayoutNode, WorkspaceTabDef};
    use tempfile::TempDir;

    fn create_test_manager(dir: &TempDir) -> WorkspaceManager {
        let storage = WorkspaceStorage::new_test(dir.path());
        let store = WorkspaceStore::default();
        WorkspaceManager {
            store: Mutex::new(store),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn sample_definition(id: &str, name: &str) -> WorkspaceDefinition {
        WorkspaceDefinition {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            layout: WorkspaceLayoutNode::Leaf {
                tabs: vec![WorkspaceTabDef {
                    connection_ref: Some("conn-1".to_string()),
                    inline_config: None,
                    title: None,
                    initial_command: None,
                }],
            },
        }
    }

    #[test]
    fn get_workspaces_empty() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let workspaces = mgr.get_workspaces().unwrap();
        assert!(workspaces.is_empty());
    }

    #[test]
    fn save_and_get_workspaces() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "First"))
            .unwrap();
        mgr.save_workspace(sample_definition("ws-2", "Second"))
            .unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].name, "First");
        assert_eq!(workspaces[1].name, "Second");
    }

    #[test]
    fn save_workspace_update() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Original"))
            .unwrap();
        mgr.save_workspace(sample_definition("ws-1", "Updated"))
            .unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "Updated");
    }

    #[test]
    fn load_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let ws = WorkspaceDefinition {
            id: "ws-1".to_string(),
            name: "Test".to_string(),
            description: Some("desc".to_string()),
            layout: WorkspaceLayoutNode::Split {
                direction: SplitDirection::Horizontal,
                children: vec![
                    WorkspaceLayoutNode::Leaf {
                        tabs: vec![WorkspaceTabDef {
                            connection_ref: Some("conn-1".to_string()),
                            inline_config: None,
                            title: None,
                            initial_command: None,
                        }],
                    },
                    WorkspaceLayoutNode::Leaf {
                        tabs: vec![WorkspaceTabDef {
                            connection_ref: Some("conn-2".to_string()),
                            inline_config: None,
                            title: None,
                            initial_command: None,
                        }],
                    },
                ],
                sizes: None,
            },
        };
        mgr.save_workspace(ws).unwrap();

        let loaded = mgr.load_workspace("ws-1").unwrap();
        assert_eq!(loaded.name, "Test");
        assert_eq!(loaded.description.as_deref(), Some("desc"));
    }

    #[test]
    fn load_workspace_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let result = mgr.load_workspace("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn delete_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Test"))
            .unwrap();
        mgr.delete_workspace("ws-1").unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert!(workspaces.is_empty());
    }

    #[test]
    fn delete_workspace_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let result = mgr.delete_workspace("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn duplicate_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Original"))
            .unwrap();
        let new_id = mgr.duplicate_workspace("ws-1").unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);

        let dup = mgr.load_workspace(&new_id).unwrap();
        assert_eq!(dup.name, "Copy of Original");
    }

    #[test]
    fn duplicate_workspace_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let result = mgr.duplicate_workspace("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn export_replaces_ids_with_names() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "My Setup"))
            .unwrap();

        let id_to_name: HashMap<String, String> =
            [("conn-1".to_string(), "Dev Server".to_string())]
                .into_iter()
                .collect();

        let json = mgr.export_json(&id_to_name).unwrap();
        assert!(json.contains("Dev Server"));
        assert!(!json.contains("conn-1"));
        assert!(json.contains("My Setup"));
    }

    #[test]
    fn export_preserves_unknown_connection_ids() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Test"))
            .unwrap();

        // Empty mapping — IDs should pass through
        let id_to_name: HashMap<String, String> = HashMap::new();
        let json = mgr.export_json(&id_to_name).unwrap();
        assert!(json.contains("conn-1"));
    }

    #[test]
    fn import_resolves_names_to_ids() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let json = r#"{
            "version": "1",
            "workspaces": [{
                "name": "Imported",
                "layout": {
                    "type": "leaf",
                    "tabs": [{ "connectionRef": "Dev Server" }]
                }
            }]
        }"#;

        let name_to_id: HashMap<String, String> =
            [("Dev Server".to_string(), "conn-1".to_string())]
                .into_iter()
                .collect();

        let count = mgr.import_json(json, &name_to_id).unwrap();
        assert_eq!(count, 1);

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "Imported");

        let ws = mgr.load_workspace(&workspaces[0].id).unwrap();
        if let WorkspaceLayoutNode::Leaf { tabs } = &ws.layout {
            assert_eq!(tabs[0].connection_ref.as_deref(), Some("conn-1"));
        } else {
            panic!("Expected leaf layout");
        }
    }

    #[test]
    fn import_skips_duplicate_names() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Existing"))
            .unwrap();

        let json = r#"{
            "version": "1",
            "workspaces": [
                { "name": "Existing", "layout": { "type": "leaf", "tabs": [] } },
                { "name": "New One", "layout": { "type": "leaf", "tabs": [] } }
            ]
        }"#;

        let count = mgr.import_json(json, &HashMap::new()).unwrap();
        assert_eq!(count, 1); // Only "New One" imported

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
    }

    #[test]
    fn preview_import_counts() {
        let json = r#"{
            "version": "1",
            "workspaces": [
                { "name": "WS1", "layout": { "type": "leaf", "tabs": [
                    { "connectionRef": "a" }, { "connectionRef": "b" }
                ] } },
                { "name": "WS2", "layout": { "type": "split", "direction": "horizontal", "children": [
                    { "type": "leaf", "tabs": [{ "connectionRef": "c" }] },
                    { "type": "leaf", "tabs": [{ "connectionRef": "d" }] }
                ] } }
            ]
        }"#;

        let preview = WorkspaceManager::preview_import_json(json).unwrap();
        assert_eq!(preview.workspace_count, 2);
        assert_eq!(preview.total_tab_count, 4);
    }

    #[test]
    fn export_import_round_trip() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Setup A"))
            .unwrap();
        mgr.save_workspace(sample_definition("ws-2", "Setup B"))
            .unwrap();

        let id_to_name: HashMap<String, String> =
            [("conn-1".to_string(), "Dev Server".to_string())]
                .into_iter()
                .collect();
        let name_to_id: HashMap<String, String> =
            [("Dev Server".to_string(), "conn-1".to_string())]
                .into_iter()
                .collect();

        let exported = mgr.export_json(&id_to_name).unwrap();

        // Import into a fresh manager
        let dir2 = TempDir::new().unwrap();
        let mgr2 = create_test_manager(&dir2);
        let count = mgr2.import_json(&exported, &name_to_id).unwrap();
        assert_eq!(count, 2);

        let workspaces = mgr2.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
        assert!(workspaces.iter().any(|ws| ws.name == "Setup A"));
        assert!(workspaces.iter().any(|ws| ws.name == "Setup B"));
    }
}
