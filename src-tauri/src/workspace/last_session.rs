use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::config::{WorkspaceTabGroupDef, WorkspaceWindowDef};
use crate::utils::config_paths::resolve_config_dir;

const FILE_NAME: &str = "last-session.json";

/// The automatically persisted "last session": the open tab groups and their
/// panel layout at the time the app last had its state mutated.
///
/// This reuses the same [`WorkspaceTabGroupDef`] serialization format as named
/// workspaces, so the existing capture/restore utilities apply unchanged. Unlike
/// a workspace it has no name/id and is never shown in the workspace list — it is
/// silently saved on every layout change and silently restored on startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastSession {
    /// Schema version for forward compatibility.
    pub version: String,
    /// The captured tab groups (panel trees) of the session.
    pub tab_groups: Vec<WorkspaceTabGroupDef>,
    /// Index into `tab_groups` of the group that was active.
    #[serde(default)]
    pub active_group_index: usize,
    /// The set of windows the session spanned, in restore order (multi-window
    /// persistence, #1905). Absent/empty for a legacy single-window session,
    /// which restores entirely into the main window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<WorkspaceWindowDef>>,
}

impl LastSession {
    /// True when the session holds no tab groups and therefore nothing to restore.
    pub fn is_empty(&self) -> bool {
        self.tab_groups.is_empty()
    }
}

/// Handles reading/writing the last-session JSON file.
pub struct LastSessionStorage {
    file_path: PathBuf,
}

impl LastSessionStorage {
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

    /// Load the persisted last session, if any.
    ///
    /// Returns `Ok(None)` when the file is missing or cannot be parsed — a corrupt
    /// or stale last-session file should never block startup, so it is treated as
    /// "no session to restore" rather than an error.
    pub fn load(&self) -> Result<Option<LastSession>> {
        if !self.file_path.exists() {
            return Ok(None);
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read last-session file")?;

        match serde_json::from_str::<LastSession>(&data) {
            Ok(session) => Ok(Some(session)),
            Err(e) => {
                tracing::warn!("Last-session file is corrupt, ignoring it: {e}");
                Ok(None)
            }
        }
    }

    /// Save the last session to disk (pretty-printed JSON).
    pub fn save(&self, session: &LastSession) -> Result<()> {
        let data =
            serde_json::to_string_pretty(session).context("Failed to serialize last session")?;

        fs::write(&self.file_path, data).context("Failed to write last-session file")?;

        Ok(())
    }

    /// Remove the persisted last session, if it exists.
    pub fn clear(&self) -> Result<()> {
        if self.file_path.exists() {
            fs::remove_file(&self.file_path).context("Failed to remove last-session file")?;
        }
        Ok(())
    }
}

/// Manages the last-session lifecycle: load on startup, save on change, clear on demand.
pub struct LastSessionManager {
    storage: LastSessionStorage,
}

impl LastSessionManager {
    /// Create a manager backed by on-disk storage.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        Ok(Self {
            storage: LastSessionStorage::new(app_handle)?,
        })
    }

    /// Load the persisted last session, if any (never errors on corrupt data).
    pub fn load(&self) -> Result<Option<LastSession>> {
        self.storage.load()
    }

    /// Persist the given session, or clear the file when the session is empty.
    pub fn save(&self, session: LastSession) -> Result<()> {
        if session.is_empty() {
            self.storage.clear()
        } else {
            self.storage.save(&session)
        }
    }

    /// Remove the persisted last session.
    pub fn clear(&self) -> Result<()> {
        self.storage.clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config::WorkspaceLayoutNode;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> LastSessionStorage {
        LastSessionStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    fn sample_session() -> LastSession {
        LastSession {
            version: "1".to_string(),
            tab_groups: vec![WorkspaceTabGroupDef {
                name: "Group 1".to_string(),
                color: None,
                window_id: None,
                layout: WorkspaceLayoutNode::Leaf { tabs: vec![] },
            }],
            active_group_index: 0,
            windows: None,
        }
    }

    #[test]
    fn load_missing_file_returns_none() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        assert!(storage.load().unwrap().is_none());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let session = sample_session();

        storage.save(&session).unwrap();
        let loaded = storage.load().unwrap().unwrap();

        assert_eq!(loaded, session);
        assert_eq!(loaded.tab_groups.len(), 1);
        assert_eq!(loaded.tab_groups[0].name, "Group 1");
    }

    #[test]
    fn corrupt_file_is_ignored_returns_none() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "this is not valid json {{{").unwrap();

        // Must never error — a corrupt last session should not block startup.
        assert!(storage.load().unwrap().is_none());
    }

    #[test]
    fn clear_removes_file() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        storage.save(&sample_session()).unwrap();
        assert!(storage.file_path.exists());

        storage.clear().unwrap();
        assert!(!storage.file_path.exists());
        assert!(storage.load().unwrap().is_none());
    }

    #[test]
    fn clear_on_missing_file_is_ok() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Clearing a non-existent file must succeed silently.
        assert!(storage.clear().is_ok());
    }

    #[test]
    fn deserialize_without_active_group_index_defaults_to_zero() {
        let json = r#"{"version":"1","tabGroups":[]}"#;
        let session: LastSession = serde_json::from_str(json).unwrap();
        assert_eq!(session.active_group_index, 0);
        assert!(session.is_empty());
    }

    #[test]
    fn manager_save_empty_session_clears_file() {
        let dir = TempDir::new().unwrap();
        let storage = LastSessionStorage {
            file_path: dir.path().join(FILE_NAME),
        };
        storage.save(&sample_session()).unwrap();
        assert!(storage.file_path.exists());

        // Saving an empty session through the manager should clear the file
        // rather than persist an empty session.
        let manager = LastSessionManager { storage };
        manager
            .save(LastSession {
                version: "1".to_string(),
                tab_groups: vec![],
                active_group_index: 0,
                windows: None,
            })
            .unwrap();

        assert!(manager.load().unwrap().is_none());
    }
}
