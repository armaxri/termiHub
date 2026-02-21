use std::collections::HashSet;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{
    ConnectionFolder, ConnectionStore, ExternalConnectionStore, SavedConnection, SavedRemoteAgent,
};
use super::settings::{AppSettings, SettingsStorage};
use super::storage::ConnectionStorage;
use crate::terminal::backend::ConnectionConfig;

/// Strip the password field from SSH connection configs.
pub(crate) fn strip_ssh_password(mut connection: SavedConnection) -> SavedConnection {
    if let ConnectionConfig::Ssh(ref mut ssh_cfg) = connection.config {
        ssh_cfg.password = None;
    }
    connection
}

/// Strip the password field from agent configs before persisting.
pub(crate) fn strip_agent_password(mut agent: SavedRemoteAgent) -> SavedRemoteAgent {
    agent.config.password = None;
    agent
}

/// Result of loading a single external connection file (flattened).
pub struct ExternalSource {
    pub file_path: String,
    pub connections: Vec<SavedConnection>,
    pub error: Option<String>,
}

/// Manages saved connections and folders with file persistence.
pub struct ConnectionManager {
    store: Mutex<ConnectionStore>,
    storage: ConnectionStorage,
    settings: Mutex<AppSettings>,
    settings_storage: SettingsStorage,
}

impl ConnectionManager {
    /// Create a new connection manager, loading existing data from disk.
    /// On first load, strips any stored SSH passwords (migration).
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = ConnectionStorage::new(app_handle)?;
        let mut store = storage.load()?;

        // Migrate: strip any existing stored passwords
        let mut needs_save = false;
        for conn in &mut store.connections {
            if let ConnectionConfig::Ssh(ref mut ssh_cfg) = conn.config {
                if ssh_cfg.password.is_some() {
                    ssh_cfg.password = None;
                    needs_save = true;
                }
            }
        }
        for agent in &mut store.agents {
            if agent.config.password.is_some() {
                agent.config.password = None;
                needs_save = true;
            }
        }
        if needs_save {
            storage
                .save(&store)
                .context("Failed to strip stored passwords on migration")?;
        }

        let settings_storage = SettingsStorage::new(app_handle)?;
        let settings = settings_storage.load()?;

        Ok(Self {
            store: Mutex::new(store),
            storage,
            settings: Mutex::new(settings),
            settings_storage,
        })
    }

    /// Get all connections and folders.
    pub fn get_all(&self) -> Result<ConnectionStore> {
        let store = self.store.lock().unwrap();
        Ok(store.clone())
    }

    /// Save (add or update) a remote agent. Passwords are stripped before persisting.
    pub fn save_agent(&self, agent: SavedRemoteAgent) -> Result<()> {
        let agent = strip_agent_password(agent);
        let mut store = self.store.lock().unwrap();

        if let Some(existing) = store.agents.iter_mut().find(|a| a.id == agent.id) {
            *existing = agent;
        } else {
            store.agents.push(agent);
        }

        self.storage.save(&store).context("Failed to persist agent")
    }

    /// Delete a remote agent by ID.
    pub fn delete_agent(&self, id: &str) -> Result<()> {
        let mut store = self.store.lock().unwrap();
        store.agents.retain(|a| a.id != id);
        self.storage
            .save(&store)
            .context("Failed to persist after agent delete")
    }

    /// Save (add or update) a connection. Passwords are stripped before persisting.
    pub fn save_connection(&self, connection: SavedConnection) -> Result<()> {
        let connection = strip_ssh_password(connection);
        let mut store = self.store.lock().unwrap();

        if let Some(existing) = store.connections.iter_mut().find(|c| c.id == connection.id) {
            *existing = connection;
        } else {
            store.connections.push(connection);
        }

        self.storage
            .save(&store)
            .context("Failed to persist connection")
    }

    /// Delete a connection by ID.
    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let mut store = self.store.lock().unwrap();
        store.connections.retain(|c| c.id != id);
        self.storage
            .save(&store)
            .context("Failed to persist after delete")
    }

    /// Save (add or update) a folder.
    pub fn save_folder(&self, folder: ConnectionFolder) -> Result<()> {
        let mut store = self.store.lock().unwrap();

        if let Some(existing) = store.folders.iter_mut().find(|f| f.id == folder.id) {
            *existing = folder;
        } else {
            store.folders.push(folder);
        }

        self.storage
            .save(&store)
            .context("Failed to persist folder")
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
        self.storage
            .save(&store)
            .context("Failed to persist after folder delete")
    }

    /// Export all connections and folders as a JSON string. Passwords are stripped.
    pub fn export_json(&self) -> Result<String> {
        let store = self.store.lock().unwrap();
        let mut export_store = store.clone();
        export_store.connections = export_store
            .connections
            .into_iter()
            .map(strip_ssh_password)
            .collect();
        serde_json::to_string_pretty(&export_store)
            .context("Failed to serialize connections for export")
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

        // Merge: add imported connections that don't already exist (strip passwords)
        for conn in imported.connections {
            if !store.connections.iter().any(|c| c.id == conn.id) {
                store.connections.push(strip_ssh_password(conn));
            }
        }

        self.storage
            .save(&store)
            .context("Failed to persist after import")?;
        Ok(count)
    }

    /// Get the current application settings.
    pub fn get_settings(&self) -> AppSettings {
        self.settings.lock().unwrap().clone()
    }

    /// Update and persist application settings.
    pub fn save_settings(&self, new_settings: AppSettings) -> Result<()> {
        self.settings_storage
            .save(&new_settings)
            .context("Failed to persist settings")?;
        *self.settings.lock().unwrap() = new_settings;
        Ok(())
    }

    /// Load all enabled external connection files and return flattened connections.
    pub fn load_external_sources(&self) -> Vec<ExternalSource> {
        let settings = self.settings.lock().unwrap().clone();
        let main_folder_ids: HashSet<String> = {
            let store = self.store.lock().unwrap();
            store.folders.iter().map(|f| f.id.clone()).collect()
        };
        let ids_ref: HashSet<&str> = main_folder_ids.iter().map(|s| s.as_str()).collect();

        let mut sources = Vec::new();

        for file_cfg in &settings.external_connection_files {
            if !file_cfg.enabled {
                continue;
            }

            sources.push(load_single_external_file(&file_cfg.path, &ids_ref));
        }

        sources
    }

    /// Save a connection to its appropriate file based on `source_file`.
    /// If `source_file` is `None`, saves to main connections.json.
    /// If `source_file` is `Some(path)`, saves to that external file.
    pub fn save_connection_routed(&self, connection: SavedConnection) -> Result<()> {
        match &connection.source_file {
            None => self.save_connection(connection),
            Some(file_path) => {
                let file_path = file_path.clone();
                let mut conn = strip_ssh_password(connection);
                conn.source_file = None; // Strip before writing to disk
                save_or_update_in_external_file(&file_path, conn)
            }
        }
    }

    /// Delete a connection from its appropriate file based on `source_file`.
    pub fn delete_connection_routed(&self, id: &str, source_file: Option<&str>) -> Result<()> {
        match source_file {
            None => self.delete_connection(id),
            Some(file_path) => remove_from_external_file(file_path, id),
        }
    }

    /// Move a connection between files. Removes from source, adds to target.
    pub fn move_connection_to_file(
        &self,
        connection_id: &str,
        current_source: Option<&str>,
        target_source: Option<String>,
    ) -> Result<SavedConnection> {
        // 1. Find and remove the connection from its current location
        let mut connection = match current_source {
            None => {
                let mut store = self.store.lock().unwrap();
                let idx = store
                    .connections
                    .iter()
                    .position(|c| c.id == connection_id)
                    .context("Connection not found in main store")?;
                let conn = store.connections.remove(idx);
                self.storage
                    .save(&store)
                    .context("Failed to persist removal from main store")?;
                conn
            }
            Some(file_path) => remove_and_return_from_external_file(file_path, connection_id)?,
        };

        // 2. Add to the target location
        connection.source_file = target_source.clone();
        match &target_source {
            None => {
                let mut disk_conn = strip_ssh_password(connection.clone());
                disk_conn.source_file = None;
                let mut store = self.store.lock().unwrap();
                store.connections.push(disk_conn);
                self.storage
                    .save(&store)
                    .context("Failed to persist addition to main store")?;
            }
            Some(file_path) => {
                let mut disk_conn = strip_ssh_password(connection.clone());
                disk_conn.source_file = None;
                save_or_update_in_external_file(file_path, disk_conn)?;
            }
        }

        Ok(connection)
    }
}

/// Load a single external connection file, flattening connections.
fn load_single_external_file(
    file_path: &str,
    main_folder_ids: &std::collections::HashSet<&str>,
) -> ExternalSource {
    match try_load_external_file(file_path, main_folder_ids) {
        Ok(source) => source,
        Err(err) => ExternalSource {
            file_path: file_path.to_string(),
            connections: Vec::new(),
            error: Some(err.to_string()),
        },
    }
}

/// Try to load and parse an external connection file.
/// Connections get `source_file` set and `folder_id` validated against the main folder tree.
pub(crate) fn try_load_external_file(
    file_path: &str,
    main_folder_ids: &std::collections::HashSet<&str>,
) -> Result<ExternalSource> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    // Flatten connections: set source_file, validate folder_id
    let mut connections = Vec::new();
    for mut conn in ext_store.connections {
        conn.source_file = Some(file_path.to_string());

        // If the connection's folder_id doesn't match any main folder, put it at root
        if let Some(ref fid) = conn.folder_id {
            if !main_folder_ids.contains(fid.as_str()) {
                conn.folder_id = None;
            }
        }

        connections.push(strip_ssh_password(conn));
    }

    Ok(ExternalSource {
        file_path: file_path.to_string(),
        connections,
        error: None,
    })
}

/// Save or update a single connection in an external file (by ID).
fn save_or_update_in_external_file(file_path: &str, connection: SavedConnection) -> Result<()> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let mut ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    if let Some(existing) = ext_store
        .connections
        .iter_mut()
        .find(|c| c.id == connection.id)
    {
        *existing = connection;
    } else {
        ext_store.connections.push(connection);
    }

    let data = serde_json::to_string_pretty(&ext_store)
        .context("Failed to serialize external connection file")?;
    std::fs::write(file_path, data)
        .with_context(|| format!("Failed to write external file: {}", file_path))?;
    Ok(())
}

/// Remove a connection from an external file by ID.
fn remove_from_external_file(file_path: &str, connection_id: &str) -> Result<()> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let mut ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    ext_store.connections.retain(|c| c.id != connection_id);

    let data = serde_json::to_string_pretty(&ext_store)
        .context("Failed to serialize external connection file")?;
    std::fs::write(file_path, data)
        .with_context(|| format!("Failed to write external file: {}", file_path))?;
    Ok(())
}

/// Remove a connection from an external file and return it.
fn remove_and_return_from_external_file(
    file_path: &str,
    connection_id: &str,
) -> Result<SavedConnection> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let mut ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    let idx = ext_store
        .connections
        .iter()
        .position(|c| c.id == connection_id)
        .with_context(|| format!("Connection {} not found in {}", connection_id, file_path))?;

    let conn = ext_store.connections.remove(idx);

    let data = serde_json::to_string_pretty(&ext_store)
        .context("Failed to serialize external connection file")?;
    std::fs::write(file_path, data)
        .with_context(|| format!("Failed to write external file: {}", file_path))?;

    Ok(conn)
}

/// Write an `ExternalConnectionStore` to a given file path.
pub fn save_external_file(
    file_path: &str,
    name: &str,
    folders: Vec<ConnectionFolder>,
    connections: Vec<SavedConnection>,
) -> Result<()> {
    let store = ExternalConnectionStore {
        name: Some(name.to_string()),
        version: "1".to_string(),
        folders,
        connections: connections.into_iter().map(strip_ssh_password).collect(),
    };
    let data = serde_json::to_string_pretty(&store)
        .context("Failed to serialize external connection file")?;
    std::fs::write(file_path, data)
        .with_context(|| format!("Failed to write external file: {}", file_path))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::{LocalShellConfig, SshConfig};

    #[test]
    fn strip_ssh_password_removes_password() {
        let conn = SavedConnection {
            id: "test".to_string(),
            name: "SSH".to_string(),
            config: ConnectionConfig::Ssh(SshConfig {
                host: "host".to_string(),
                port: 22,
                username: "user".to_string(),
                auth_method: "password".to_string(),
                password: Some("secret".to_string()),
                key_path: None,
                enable_x11_forwarding: false,
                enable_monitoring: None,
                enable_file_browser: None,
                save_password: None,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        };
        let stripped = strip_ssh_password(conn);
        if let ConnectionConfig::Ssh(ssh) = &stripped.config {
            assert!(ssh.password.is_none());
        } else {
            panic!("Expected SSH config");
        }
    }

    #[test]
    fn strip_ssh_password_leaves_non_ssh_unchanged() {
        let conn = SavedConnection {
            id: "test".to_string(),
            name: "Local".to_string(),
            config: ConnectionConfig::Local(LocalShellConfig {
                shell_type: "bash".to_string(),
                initial_command: None,
                starting_directory: None,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        };
        let result = strip_ssh_password(conn.clone());
        // Should be unchanged
        if let ConnectionConfig::Local(local) = &result.config {
            assert_eq!(local.shell_type, "bash");
        } else {
            panic!("Expected Local config");
        }
    }

    #[test]
    fn external_file_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test_connections.json");
        let path_str = file_path.to_str().unwrap();

        let folders = vec![ConnectionFolder {
            id: "folder-1".to_string(),
            name: "My Folder".to_string(),
            parent_id: None,
            is_expanded: true,
        }];

        let connections = vec![SavedConnection {
            id: "conn-1".to_string(),
            name: "Test SSH".to_string(),
            config: ConnectionConfig::Ssh(SshConfig {
                host: "example.com".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth_method: "password".to_string(),
                password: Some("secret".to_string()),
                key_path: None,
                enable_x11_forwarding: false,
                enable_monitoring: None,
                enable_file_browser: None,
                save_password: None,
            }),
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
            source_file: None,
        }];

        // Save
        save_external_file(path_str, "Test File", folders, connections).unwrap();

        // Load with "folder-1" in the main folder set so it's recognized
        let main_folders: std::collections::HashSet<&str> = vec!["folder-1"].into_iter().collect();
        let source = try_load_external_file(path_str, &main_folders).unwrap();
        assert!(source.error.is_none());

        // Connections should keep original IDs (no namespace) and have source_file set
        assert_eq!(source.connections.len(), 1);
        let conn = &source.connections[0];
        assert_eq!(conn.id, "conn-1");
        assert_eq!(conn.source_file.as_deref(), Some(path_str));
        assert_eq!(conn.folder_id.as_deref(), Some("folder-1"));
        if let ConnectionConfig::Ssh(ssh) = &conn.config {
            assert!(ssh.password.is_none(), "Password should be stripped");
        } else {
            panic!("Expected SSH config");
        }
    }

    #[test]
    fn external_file_folder_id_falls_to_root_when_not_in_main() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test_fallback.json");
        let path_str = file_path.to_str().unwrap();

        let connections = vec![SavedConnection {
            id: "conn-1".to_string(),
            name: "Test".to_string(),
            config: ConnectionConfig::Local(LocalShellConfig {
                shell_type: "bash".to_string(),
                initial_command: None,
                starting_directory: None,
            }),
            folder_id: Some("unknown-folder".to_string()),
            terminal_options: None,
            source_file: None,
        }];

        save_external_file(path_str, "Test", Vec::new(), connections).unwrap();

        // Load with empty main folders — folder_id should fall to None
        let main_folders: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let source = try_load_external_file(path_str, &main_folders).unwrap();
        assert_eq!(source.connections[0].folder_id, None);
    }

    #[test]
    fn external_file_password_stripped_on_save() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("pass_test.json");
        let path_str = file_path.to_str().unwrap();

        let connections = vec![SavedConnection {
            id: "c1".to_string(),
            name: "SSH".to_string(),
            config: ConnectionConfig::Ssh(SshConfig {
                host: "h".to_string(),
                port: 22,
                username: "u".to_string(),
                auth_method: "password".to_string(),
                password: Some("should_be_removed".to_string()),
                key_path: None,
                enable_x11_forwarding: false,
                enable_monitoring: None,
                enable_file_browser: None,
                save_password: None,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }];

        save_external_file(path_str, "Test", Vec::new(), connections).unwrap();

        // Read raw JSON and verify password is not stored
        let raw = std::fs::read_to_string(path_str).unwrap();
        assert!(
            !raw.contains("should_be_removed"),
            "Password should not be in saved file"
        );
    }
}
