use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{ConnectionFolder, ConnectionStore, ExternalConnectionStore, SavedConnection};
use super::settings::{AppSettings, SettingsStorage};
use super::storage::ConnectionStorage;
use crate::terminal::backend::ConnectionConfig;

/// Strip the password field from SSH and Remote connection configs.
pub(crate) fn strip_ssh_password(mut connection: SavedConnection) -> SavedConnection {
    match connection.config {
        ConnectionConfig::Ssh(ref mut ssh_cfg) => {
            ssh_cfg.password = None;
        }
        ConnectionConfig::Remote(ref mut remote_cfg) => {
            remote_cfg.password = None;
        }
        _ => {}
    }
    connection
}

/// Result of loading a single external connection file.
pub struct ExternalSource {
    pub file_path: String,
    pub name: String,
    pub folders: Vec<ConnectionFolder>,
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
            match conn.config {
                ConnectionConfig::Ssh(ref mut ssh_cfg) => {
                    if ssh_cfg.password.is_some() {
                        ssh_cfg.password = None;
                        needs_save = true;
                    }
                }
                ConnectionConfig::Remote(ref mut remote_cfg) => {
                    if remote_cfg.password.is_some() {
                        remote_cfg.password = None;
                        needs_save = true;
                    }
                }
                _ => {}
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

    /// Load all enabled external connection files and return them as sources.
    pub fn load_external_sources(&self) -> Vec<ExternalSource> {
        let settings = self.settings.lock().unwrap().clone();
        let mut sources = Vec::new();

        for file_cfg in &settings.external_connection_files {
            if !file_cfg.enabled {
                continue;
            }

            sources.push(load_single_external_file(&file_cfg.path));
        }

        sources
    }
}

/// Load and namespace a single external connection file.
fn load_single_external_file(file_path: &str) -> ExternalSource {
    match try_load_external_file(file_path) {
        Ok(source) => source,
        Err(err) => ExternalSource {
            file_path: file_path.to_string(),
            name: filename_from_path(file_path),
            folders: Vec::new(),
            connections: Vec::new(),
            error: Some(err.to_string()),
        },
    }
}

/// Try to load and parse an external connection file, namespacing all IDs.
pub(crate) fn try_load_external_file(file_path: &str) -> Result<ExternalSource> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    let prefix = format!("ext:{}::", file_path);
    let root_id = format!("ext-root:{}", file_path);
    let display_name = ext_store
        .name
        .clone()
        .unwrap_or_else(|| filename_from_path(file_path));

    // Create synthetic root folder
    let mut folders = vec![ConnectionFolder {
        id: root_id.clone(),
        name: display_name.clone(),
        parent_id: None,
        is_expanded: true,
    }];

    // Namespace and remap folders
    for mut folder in ext_store.folders {
        let original_id = folder.id.clone();
        folder.id = format!("{}{}", prefix, original_id);
        folder.parent_id = Some(match folder.parent_id {
            Some(pid) => format!("{}{}", prefix, pid),
            None => root_id.clone(),
        });
        folders.push(folder);
    }

    // Namespace and remap connections, stripping SSH passwords
    let mut connections = Vec::new();
    for mut conn in ext_store.connections {
        conn.id = format!("{}{}", prefix, conn.id);
        conn.folder_id = Some(match conn.folder_id {
            Some(fid) => format!("{}{}", prefix, fid),
            None => root_id.clone(),
        });
        connections.push(strip_ssh_password(conn));
    }

    Ok(ExternalSource {
        file_path: file_path.to_string(),
        name: display_name,
        folders,
        connections,
        error: None,
    })
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

/// Extract a human-readable name from a file path.
pub(crate) fn filename_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::{LocalShellConfig, RemoteConfig, SshConfig};

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
            }),
            folder_id: None,
            terminal_options: None,
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
    fn strip_ssh_password_strips_remote_password() {
        let conn = SavedConnection {
            id: "test".to_string(),
            name: "Remote Pi".to_string(),
            config: ConnectionConfig::Remote(RemoteConfig {
                host: "pi.local".to_string(),
                port: 22,
                username: "pi".to_string(),
                auth_method: "password".to_string(),
                password: Some("secret".to_string()),
                key_path: None,
                session_type: "shell".to_string(),
                shell: None,
                serial_port: None,
                baud_rate: None,
                data_bits: None,
                stop_bits: None,
                parity: None,
                flow_control: None,
                title: None,
            }),
            folder_id: None,
            terminal_options: None,
        };
        let stripped = strip_ssh_password(conn);
        if let ConnectionConfig::Remote(remote) = &stripped.config {
            assert!(remote.password.is_none());
        } else {
            panic!("Expected Remote config");
        }
    }

    #[test]
    fn filename_from_path_with_extension() {
        assert_eq!(filename_from_path("/path/to/file.json"), "file");
    }

    #[test]
    fn filename_from_path_root_file() {
        assert_eq!(filename_from_path("/file.json"), "file");
    }

    #[test]
    fn filename_from_path_empty() {
        assert_eq!(filename_from_path(""), "Unknown");
    }

    #[test]
    fn filename_from_path_no_extension() {
        assert_eq!(filename_from_path("/path/to/file"), "file");
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
            }),
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
        }];

        // Save
        save_external_file(path_str, "Test File", folders, connections).unwrap();

        // Load
        let source = try_load_external_file(path_str).unwrap();
        assert_eq!(source.name, "Test File");
        assert!(source.error.is_none());

        // Connections should be namespaced and password-stripped
        assert_eq!(source.connections.len(), 1);
        let conn = &source.connections[0];
        assert!(conn.id.starts_with(&format!("ext:{}::", path_str)));
        if let ConnectionConfig::Ssh(ssh) = &conn.config {
            assert!(ssh.password.is_none(), "Password should be stripped");
        } else {
            panic!("Expected SSH config");
        }

        // Should have synthetic root folder + our folder
        assert_eq!(source.folders.len(), 2);
        let root = source
            .folders
            .iter()
            .find(|f| f.id == format!("ext-root:{}", path_str));
        assert!(root.is_some(), "Should have synthetic root folder");
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
            }),
            folder_id: None,
            terminal_options: None,
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
