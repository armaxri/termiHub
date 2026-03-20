use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{WorkspaceDefinition, WorkspaceStore, WorkspaceSummary};
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
}
