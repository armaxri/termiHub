use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{ConnectionFolder, ConnectionStore, SavedConnection};
use super::storage::ConnectionStorage;

/// Manages saved connections and folders with file persistence.
pub struct ConnectionManager {
    store: Mutex<ConnectionStore>,
    storage: ConnectionStorage,
}

impl ConnectionManager {
    /// Create a new connection manager, loading existing data from disk.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = ConnectionStorage::new(app_handle)?;
        let store = storage.load()?;

        Ok(Self {
            store: Mutex::new(store),
            storage,
        })
    }

    /// Get all connections and folders.
    pub fn get_all(&self) -> Result<ConnectionStore> {
        let store = self.store.lock().unwrap();
        Ok(store.clone())
    }

    /// Save (add or update) a connection.
    pub fn save_connection(&self, connection: SavedConnection) -> Result<()> {
        let mut store = self.store.lock().unwrap();

        if let Some(existing) = store.connections.iter_mut().find(|c| c.id == connection.id) {
            *existing = connection;
        } else {
            store.connections.push(connection);
        }

        self.storage.save(&store).context("Failed to persist connection")
    }

    /// Delete a connection by ID.
    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let mut store = self.store.lock().unwrap();
        store.connections.retain(|c| c.id != id);
        self.storage.save(&store).context("Failed to persist after delete")
    }

    /// Save (add or update) a folder.
    pub fn save_folder(&self, folder: ConnectionFolder) -> Result<()> {
        let mut store = self.store.lock().unwrap();

        if let Some(existing) = store.folders.iter_mut().find(|f| f.id == folder.id) {
            *existing = folder;
        } else {
            store.folders.push(folder);
        }

        self.storage.save(&store).context("Failed to persist folder")
    }

    /// Delete a folder by ID. Moves its connections to root (folder_id = None).
    pub fn delete_folder(&self, id: &str) -> Result<()> {
        let mut store = self.store.lock().unwrap();

        // Move child connections to root
        for conn in &mut store.connections {
            if conn.folder_id.as_deref() == Some(id) {
                conn.folder_id = None;
            }
        }

        // Reparent child folders to the deleted folder's parent
        let parent_id = store
            .folders
            .iter()
            .find(|f| f.id == id)
            .and_then(|f| f.parent_id.clone());

        for folder in &mut store.folders {
            if folder.parent_id.as_deref() == Some(id) {
                folder.parent_id = parent_id.clone();
            }
        }

        store.folders.retain(|f| f.id != id);
        self.storage.save(&store).context("Failed to persist after folder delete")
    }

    /// Export all connections and folders as a JSON string.
    pub fn export_json(&self) -> Result<String> {
        let store = self.store.lock().unwrap();
        serde_json::to_string_pretty(&*store).context("Failed to serialize connections for export")
    }

    /// Import connections and folders from a JSON string.
    /// Returns the number of connections imported.
    pub fn import_json(&self, json: &str) -> Result<usize> {
        let imported: ConnectionStore =
            serde_json::from_str(json).context("Failed to parse import data")?;

        let mut store = self.store.lock().unwrap();
        let count = imported.connections.len();

        // Merge: add imported folders that don't already exist
        for folder in imported.folders {
            if !store.folders.iter().any(|f| f.id == folder.id) {
                store.folders.push(folder);
            }
        }

        // Merge: add imported connections that don't already exist
        for conn in imported.connections {
            if !store.connections.iter().any(|c| c.id == conn.id) {
                store.connections.push(conn);
            }
        }

        self.storage.save(&store).context("Failed to persist after import")?;
        Ok(count)
    }
}
