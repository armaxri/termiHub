use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::WorkflowStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "workflows.json";

/// Handles reading/writing the workflows JSON file. Mirrors
/// [`crate::macros::storage::MacroStorage`].
pub struct WorkflowStorage {
    file_path: PathBuf,
}

impl WorkflowStorage {
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

    /// Load with recovery via the shared schema-migration layer.
    ///
    /// A current/older file is used as-is (or migrated forward), a **newer** file
    /// is left untouched and reported as a warning (never reset — PER-004), and
    /// only a genuinely unparseable file is backed up to `.bak` and reset.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<WorkflowStore>> {
        load_store_with_recovery::<WorkflowStore>(&self.file_path, FILE_NAME)
    }

    /// Save the workflow store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file + rename) so an interrupted save cannot
    /// truncate user-authored automation into invalid JSON that the recovery
    /// path would discard (PER-003 torn-write class). Before writing,
    /// [`guard_not_newer`] refuses to overwrite a file written by a newer schema
    /// version (PER-004).
    pub fn save(&self, store: &WorkflowStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            WorkflowStore::STORE_NAME,
            WorkflowStore::CURRENT_VERSION,
        )?;

        let data = serde_json::to_string_pretty(store).context("Failed to serialize workflows")?;

        write_atomic(&self.file_path, &data).context("Failed to write workflows file")?;

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
    use crate::workflows::config::{Workflow, WorkflowStep, WorkflowTrigger};
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> WorkflowStorage {
        WorkflowStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    fn sample_store() -> WorkflowStore {
        WorkflowStore {
            version: "1".to_string(),
            extra: Default::default(),
            workflows: vec![Workflow {
                id: "wf-1".to_string(),
                name: "Login".to_string(),
                description: Some("Login sequence".to_string()),
                tags: vec!["ops".to_string()],
                steps: vec![
                    WorkflowStep::SendCommand {
                        command: "sudo -v".to_string(),
                    },
                    WorkflowStep::Wait { delay_ms: 500 },
                ],
                triggers: vec![WorkflowTrigger::OnConnect {
                    connection_ids: vec!["prod-web-1".to_string()],
                }],
                created_at: "2026-07-24T00:00:00Z".to_string(),
                updated_at: "2026-07-24T00:00:00Z".to_string(),
            }],
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.workflows.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = sample_store();
        storage.save(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.workflows.len(), 1);
        assert_eq!(result.data.workflows[0].name, "Login");
        assert_eq!(result.data.workflows[0].steps.len(), 2);
        assert_eq!(
            result.data.workflows[0].steps[0],
            WorkflowStep::SendCommand {
                command: "sudo -v".to_string()
            }
        );
        assert_eq!(result.data.workflows[0].triggers.len(), 1);
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt workflow data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.workflows.is_empty());

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }
}
