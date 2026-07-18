use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{Macro, MacroStore};
use super::storage::MacroStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// Central macro manager: CRUD for stored macros, persisting through storage.
pub struct MacroManager {
    store: Mutex<MacroStore>,
    storage: MacroStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl MacroManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            MacroStorage::new(app_handle).context("Failed to initialize macro storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load macros")?;

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

    /// List all stored macros.
    pub fn list_macros(&self) -> Result<Vec<Macro>, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::MacroError(e.to_string()))?;
        Ok(store.macros.clone())
    }

    /// Get a single macro by ID.
    pub fn get_macro(&self, id: &str) -> Result<Macro, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::MacroError(e.to_string()))?;
        store
            .macros
            .iter()
            .find(|m| m.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::MacroError(format!("Macro not found: {id}")))
    }

    /// Save (add or update) a macro, stamping timestamps.
    ///
    /// On update the original `created_at` is preserved; `updated_at` is always
    /// set to now. The stored macro (with authoritative timestamps) is returned.
    pub fn save_macro(&self, mut macro_def: Macro) -> Result<Macro, TerminalError> {
        let now = now_rfc3339();

        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::MacroError(e.to_string()))?;

        macro_def.updated_at = now.clone();

        if let Some(existing) = store.macros.iter_mut().find(|m| m.id == macro_def.id) {
            // Preserve the original creation timestamp on update.
            macro_def.created_at = existing.created_at.clone();
            *existing = macro_def.clone();
        } else {
            if macro_def.created_at.is_empty() {
                macro_def.created_at = now;
            }
            store.macros.push(macro_def.clone());
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::MacroError(e.to_string()))?;

        Ok(macro_def)
    }

    /// Delete a macro by ID.
    pub fn delete_macro(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::MacroError(e.to_string()))?;

        let len_before = store.macros.len();
        store.macros.retain(|m| m.id != id);

        if store.macros.len() == len_before {
            return Err(TerminalError::MacroError(format!("Macro not found: {id}")));
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::MacroError(e.to_string()))
    }
}

/// Current time as an RFC 3339 string.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::macros::config::MacroStep;
    use tempfile::TempDir;

    fn create_test_manager(dir: &TempDir) -> MacroManager {
        MacroManager {
            store: Mutex::new(MacroStore::default()),
            storage: MacroStorage::new_test(dir.path()),
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn sample_macro(id: &str, name: &str) -> Macro {
        Macro {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            tags: vec![],
            steps: vec![MacroStep {
                data: "echo hi\r".to_string(),
                delay_ms: 50,
            }],
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn list_macros_empty() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        assert!(mgr.list_macros().unwrap().is_empty());
    }

    #[test]
    fn save_and_list_macros() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_macro(sample_macro("m-1", "First")).unwrap();
        mgr.save_macro(sample_macro("m-2", "Second")).unwrap();

        let macros = mgr.list_macros().unwrap();
        assert_eq!(macros.len(), 2);
        assert_eq!(macros[0].name, "First");
        assert_eq!(macros[1].name, "Second");
    }

    #[test]
    fn save_stamps_created_and_updated() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let saved = mgr.save_macro(sample_macro("m-1", "First")).unwrap();
        assert!(!saved.created_at.is_empty());
        assert!(!saved.updated_at.is_empty());
    }

    #[test]
    fn save_update_preserves_created_at() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let first = mgr.save_macro(sample_macro("m-1", "Original")).unwrap();

        let mut updated = sample_macro("m-1", "Renamed");
        // A client may send a bogus created_at on update; the manager must ignore it.
        updated.created_at = "1999-01-01T00:00:00Z".to_string();
        let second = mgr.save_macro(updated).unwrap();

        assert_eq!(second.created_at, first.created_at);

        let macros = mgr.list_macros().unwrap();
        assert_eq!(macros.len(), 1);
        assert_eq!(macros[0].name, "Renamed");
    }

    #[test]
    fn get_macro_found_and_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_macro(sample_macro("m-1", "First")).unwrap();

        let got = mgr.get_macro("m-1").unwrap();
        assert_eq!(got.name, "First");
        assert_eq!(got.steps[0].data, "echo hi\r");

        assert!(mgr.get_macro("nope").is_err());
    }

    #[test]
    fn delete_macro_removes_it() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_macro(sample_macro("m-1", "First")).unwrap();
        mgr.delete_macro("m-1").unwrap();

        assert!(mgr.list_macros().unwrap().is_empty());
    }

    #[test]
    fn delete_macro_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        assert!(mgr.delete_macro("nope").is_err());
    }

    #[test]
    fn macros_persist_across_manager_reload() {
        let dir = TempDir::new().unwrap();
        {
            let mgr = create_test_manager(&dir);
            mgr.save_macro(sample_macro("m-1", "Persisted")).unwrap();
        }

        // A fresh manager reading the same file sees the saved macro.
        let storage = MacroStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        let mgr = MacroManager {
            store: Mutex::new(loaded.data),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
        };

        let macros = mgr.list_macros().unwrap();
        assert_eq!(macros.len(), 1);
        assert_eq!(macros[0].name, "Persisted");
    }
}
