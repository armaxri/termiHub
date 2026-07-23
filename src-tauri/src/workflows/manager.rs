use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{Workflow, WorkflowStore};
use super::storage::WorkflowStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// Central workflow manager: CRUD for stored workflows, persisting through
/// storage. Mirrors [`crate::macros::manager::MacroManager`].
pub struct WorkflowManager {
    store: Mutex<WorkflowStore>,
    storage: WorkflowStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl WorkflowManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            WorkflowStorage::new(app_handle).context("Failed to initialize workflow storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load workflows")?;

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

    /// List all stored workflows.
    pub fn list_workflows(&self) -> Result<Vec<Workflow>, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))?;
        Ok(store.workflows.clone())
    }

    /// Get a single workflow by ID.
    pub fn get_workflow(&self, id: &str) -> Result<Workflow, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))?;
        store
            .workflows
            .iter()
            .find(|w| w.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::WorkflowError(format!("Workflow not found: {id}")))
    }

    /// Save (add or update) a workflow, stamping timestamps.
    ///
    /// On update the original `created_at` is preserved; `updated_at` is always
    /// set to now. The stored workflow (with authoritative timestamps) is returned.
    pub fn save_workflow(&self, mut workflow: Workflow) -> Result<Workflow, TerminalError> {
        let now = now_rfc3339();

        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))?;

        workflow.updated_at = now.clone();

        if let Some(existing) = store.workflows.iter_mut().find(|w| w.id == workflow.id) {
            // Preserve the original creation timestamp on update.
            workflow.created_at = existing.created_at.clone();
            *existing = workflow.clone();
        } else {
            if workflow.created_at.is_empty() {
                workflow.created_at = now;
            }
            store.workflows.push(workflow.clone());
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))?;

        Ok(workflow)
    }

    /// Delete a workflow by ID.
    pub fn delete_workflow(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))?;

        let len_before = store.workflows.len();
        store.workflows.retain(|w| w.id != id);

        if store.workflows.len() == len_before {
            return Err(TerminalError::WorkflowError(format!(
                "Workflow not found: {id}"
            )));
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkflowError(e.to_string()))
    }
}

/// Current time as an RFC 3339 string.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflows::config::{WorkflowStep, WorkflowTrigger};
    use tempfile::TempDir;

    fn create_test_manager(dir: &TempDir) -> WorkflowManager {
        WorkflowManager {
            store: Mutex::new(WorkflowStore::default()),
            storage: WorkflowStorage::new_test(dir.path()),
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn sample_workflow(id: &str, name: &str) -> Workflow {
        Workflow {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            tags: vec![],
            steps: vec![WorkflowStep::SendCommand {
                command: "echo hi".to_string(),
            }],
            triggers: vec![WorkflowTrigger::Manual],
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn list_workflows_empty() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        assert!(mgr.list_workflows().unwrap().is_empty());
    }

    #[test]
    fn save_and_list_workflows() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workflow(sample_workflow("wf-1", "First")).unwrap();
        mgr.save_workflow(sample_workflow("wf-2", "Second"))
            .unwrap();

        let workflows = mgr.list_workflows().unwrap();
        assert_eq!(workflows.len(), 2);
        assert_eq!(workflows[0].name, "First");
        assert_eq!(workflows[1].name, "Second");
    }

    #[test]
    fn save_stamps_created_and_updated() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let saved = mgr.save_workflow(sample_workflow("wf-1", "First")).unwrap();
        assert!(!saved.created_at.is_empty());
        assert!(!saved.updated_at.is_empty());
    }

    #[test]
    fn save_update_preserves_created_at() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let first = mgr
            .save_workflow(sample_workflow("wf-1", "Original"))
            .unwrap();

        let mut updated = sample_workflow("wf-1", "Renamed");
        // A client may send a bogus created_at on update; the manager must ignore it.
        updated.created_at = "1999-01-01T00:00:00Z".to_string();
        let second = mgr.save_workflow(updated).unwrap();

        assert_eq!(second.created_at, first.created_at);

        let workflows = mgr.list_workflows().unwrap();
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].name, "Renamed");
    }

    #[test]
    fn get_workflow_found_and_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workflow(sample_workflow("wf-1", "First")).unwrap();

        let got = mgr.get_workflow("wf-1").unwrap();
        assert_eq!(got.name, "First");
        assert_eq!(
            got.steps[0],
            WorkflowStep::SendCommand {
                command: "echo hi".to_string()
            }
        );

        assert!(mgr.get_workflow("nope").is_err());
    }

    #[test]
    fn delete_workflow_removes_it() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workflow(sample_workflow("wf-1", "First")).unwrap();
        mgr.delete_workflow("wf-1").unwrap();

        assert!(mgr.list_workflows().unwrap().is_empty());
    }

    #[test]
    fn delete_workflow_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        assert!(mgr.delete_workflow("nope").is_err());
    }

    #[test]
    fn workflows_persist_across_manager_reload() {
        let dir = TempDir::new().unwrap();
        {
            let mgr = create_test_manager(&dir);
            mgr.save_workflow(sample_workflow("wf-1", "Persisted"))
                .unwrap();
        }

        // A fresh manager reading the same file sees the saved workflow.
        let storage = WorkflowStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        let mgr = WorkflowManager {
            store: Mutex::new(loaded.data),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
        };

        let workflows = mgr.list_workflows().unwrap();
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].name, "Persisted");
    }
}
