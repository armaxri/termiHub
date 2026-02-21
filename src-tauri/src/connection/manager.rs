use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{
    ConnectionFolder, ConnectionStore, ExternalConnectionStore, SavedConnection, SavedRemoteAgent,
};
use super::settings::{AppSettings, SettingsStorage};
use super::storage::ConnectionStorage;
use crate::credential::{CredentialKey, CredentialStore, CredentialType};
use crate::terminal::backend::ConnectionConfig;

/// Route credentials to the active store (if `save_password` is set),
/// then strip the password field so it is never written to disk.
pub(crate) fn prepare_for_storage(
    mut connection: SavedConnection,
    store: &dyn CredentialStore,
) -> Result<SavedConnection> {
    if let ConnectionConfig::Ssh(ref mut ssh_cfg) = connection.config {
        if let Some(ref password) = ssh_cfg.password {
            if ssh_cfg.save_password == Some(true) {
                let cred_type = if ssh_cfg.auth_method == "key" {
                    CredentialType::KeyPassphrase
                } else {
                    CredentialType::Password
                };
                store.set(&CredentialKey::new(&connection.id, cred_type), password)?;
            }
            ssh_cfg.password = None;
        }
    }
    Ok(connection)
}

/// Route agent credentials to the active store, then strip the password.
pub(crate) fn prepare_agent_for_storage(
    mut agent: SavedRemoteAgent,
    store: &dyn CredentialStore,
) -> Result<SavedRemoteAgent> {
    if let Some(ref password) = agent.config.password {
        if agent.config.save_password == Some(true) {
            let cred_type = if agent.config.auth_method == "key" {
                CredentialType::KeyPassphrase
            } else {
                CredentialType::Password
            };
            store.set(&CredentialKey::new(&agent.id, cred_type), password)?;
        }
        agent.config.password = None;
    }
    Ok(agent)
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
    credential_store: Arc<dyn CredentialStore>,
}

impl ConnectionManager {
    /// Create a new connection manager, loading existing data from disk.
    /// On first load, strips any stored SSH passwords (migration).
    pub fn new(app_handle: &AppHandle, credential_store: Arc<dyn CredentialStore>) -> Result<Self> {
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
            credential_store,
        })
    }

    /// Get all connections and folders.
    pub fn get_all(&self) -> Result<ConnectionStore> {
        let store = self.store.lock().unwrap();
        Ok(store.clone())
    }

    /// Save (add or update) a remote agent. Passwords are stripped before persisting.
    pub fn save_agent(&self, agent: SavedRemoteAgent) -> Result<()> {
        let agent = prepare_agent_for_storage(agent, &*self.credential_store)?;
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
        self.credential_store.remove_all_for_connection(id)?;
        let mut store = self.store.lock().unwrap();
        store.agents.retain(|a| a.id != id);
        self.storage
            .save(&store)
            .context("Failed to persist after agent delete")
    }

    /// Save (add or update) a connection. Passwords are stripped before persisting.
    pub fn save_connection(&self, connection: SavedConnection) -> Result<()> {
        let connection = prepare_for_storage(connection, &*self.credential_store)?;
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
        self.credential_store.remove_all_for_connection(id)?;
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
            .map(|c| prepare_for_storage(c, &*self.credential_store))
            .collect::<Result<Vec<_>>>()?;
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
                store
                    .connections
                    .push(prepare_for_storage(conn, &*self.credential_store)?);
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

            sources.push(load_single_external_file(
                &file_cfg.path,
                &ids_ref,
                &*self.credential_store,
            ));
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
                let mut conn = prepare_for_storage(connection, &*self.credential_store)?;
                conn.source_file = None; // Strip before writing to disk
                save_or_update_in_external_file(&file_path, conn)
            }
        }
    }

    /// Delete a connection from its appropriate file based on `source_file`.
    pub fn delete_connection_routed(&self, id: &str, source_file: Option<&str>) -> Result<()> {
        match source_file {
            None => self.delete_connection(id),
            Some(file_path) => {
                self.credential_store.remove_all_for_connection(id)?;
                remove_from_external_file(file_path, id)
            }
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
                let mut disk_conn =
                    prepare_for_storage(connection.clone(), &*self.credential_store)?;
                disk_conn.source_file = None;
                let mut store = self.store.lock().unwrap();
                store.connections.push(disk_conn);
                self.storage
                    .save(&store)
                    .context("Failed to persist addition to main store")?;
            }
            Some(file_path) => {
                let mut disk_conn =
                    prepare_for_storage(connection.clone(), &*self.credential_store)?;
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
    store: &dyn CredentialStore,
) -> ExternalSource {
    match try_load_external_file(file_path, main_folder_ids, store) {
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
    store: &dyn CredentialStore,
) -> Result<ExternalSource> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let mut ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    // Migrate: strip plaintext passwords from external file and route to credential store.
    // This mirrors the migration in `ConnectionManager::new()` for the main connections.json.
    let has_plaintext_passwords = ext_store.connections.iter().any(|conn| {
        matches!(
            &conn.config,
            ConnectionConfig::Ssh(ssh) if ssh.password.is_some()
        )
    });
    if has_plaintext_passwords {
        ext_store.connections = ext_store
            .connections
            .into_iter()
            .map(|c| prepare_for_storage(c, store))
            .collect::<Result<Vec<_>>>()?;

        let cleaned_data = serde_json::to_string_pretty(&ext_store)
            .context("Failed to serialize external file during migration")?;
        std::fs::write(file_path, cleaned_data)
            .with_context(|| format!("Failed to rewrite external file: {}", file_path))?;
    }

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

        connections.push(prepare_for_storage(conn, store)?);
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
    credential_store: &dyn CredentialStore,
) -> Result<()> {
    let store = ExternalConnectionStore {
        name: Some(name.to_string()),
        version: "1".to_string(),
        folders,
        connections: connections
            .into_iter()
            .map(|c| prepare_for_storage(c, credential_store))
            .collect::<Result<Vec<_>>>()?,
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
    use crate::credential::{CredentialKey, CredentialStoreStatus, CredentialType};
    use crate::terminal::backend::{LocalShellConfig, RemoteAgentConfig, SshConfig};
    use std::sync::Mutex;

    /// Simple mock credential store that records `set` and `remove_all_for_connection` calls.
    struct MockStore {
        stored: Mutex<Vec<(CredentialKey, String)>>,
        removed_connections: Mutex<Vec<String>>,
    }

    impl MockStore {
        fn new() -> Self {
            Self {
                stored: Mutex::new(Vec::new()),
                removed_connections: Mutex::new(Vec::new()),
            }
        }
    }

    impl CredentialStore for MockStore {
        fn get(&self, _key: &CredentialKey) -> Result<Option<String>> {
            Ok(None)
        }
        fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
            self.stored
                .lock()
                .unwrap()
                .push((key.clone(), value.to_string()));
            Ok(())
        }
        fn remove(&self, _key: &CredentialKey) -> Result<()> {
            Ok(())
        }
        fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
            self.removed_connections
                .lock()
                .unwrap()
                .push(connection_id.to_string());
            Ok(())
        }
        fn list_keys(&self) -> Result<Vec<CredentialKey>> {
            Ok(Vec::new())
        }
        fn status(&self) -> CredentialStoreStatus {
            CredentialStoreStatus::Unlocked
        }
    }

    fn make_ssh_conn(
        id: &str,
        auth_method: &str,
        password: Option<&str>,
        save_password: Option<bool>,
    ) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: "SSH".to_string(),
            config: ConnectionConfig::Ssh(SshConfig {
                host: "host".to_string(),
                port: 22,
                username: "user".to_string(),
                auth_method: auth_method.to_string(),
                password: password.map(|s| s.to_string()),
                key_path: None,
                enable_x11_forwarding: false,
                enable_monitoring: None,
                enable_file_browser: None,
                save_password,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }
    }

    fn make_local_conn(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: "Local".to_string(),
            config: ConnectionConfig::Local(LocalShellConfig {
                shell_type: "bash".to_string(),
                initial_command: None,
                starting_directory: None,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }
    }

    fn make_agent(
        id: &str,
        auth_method: &str,
        password: Option<&str>,
        save_password: Option<bool>,
    ) -> SavedRemoteAgent {
        SavedRemoteAgent {
            id: id.to_string(),
            name: "Agent".to_string(),
            config: RemoteAgentConfig {
                host: "host".to_string(),
                port: 22,
                username: "user".to_string(),
                auth_method: auth_method.to_string(),
                password: password.map(|s| s.to_string()),
                key_path: None,
                save_password,
            },
        }
    }

    #[test]
    fn prepare_for_storage_strips_password_when_save_false() {
        let store = MockStore::new();
        let conn = make_ssh_conn("c1", "password", Some("secret"), None);
        let result = prepare_for_storage(conn, &store).unwrap();
        if let ConnectionConfig::Ssh(ssh) = &result.config {
            assert!(ssh.password.is_none());
        } else {
            panic!("Expected SSH config");
        }
        assert!(store.stored.lock().unwrap().is_empty());
    }

    #[test]
    fn prepare_for_storage_stores_and_strips_when_save_true() {
        let store = MockStore::new();
        let conn = make_ssh_conn("c1", "password", Some("secret"), Some(true));
        let result = prepare_for_storage(conn, &store).unwrap();
        if let ConnectionConfig::Ssh(ssh) = &result.config {
            assert!(ssh.password.is_none(), "Password should be stripped");
        } else {
            panic!("Expected SSH config");
        }
        let stored = store.stored.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0.connection_id, "c1");
        assert_eq!(stored[0].0.credential_type, CredentialType::Password);
        assert_eq!(stored[0].1, "secret");
    }

    #[test]
    fn prepare_for_storage_uses_key_passphrase_type_for_key_auth() {
        let store = MockStore::new();
        let conn = make_ssh_conn("c2", "key", Some("my-passphrase"), Some(true));
        prepare_for_storage(conn, &store).unwrap();
        let stored = store.stored.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0.credential_type, CredentialType::KeyPassphrase);
        assert_eq!(stored[0].1, "my-passphrase");
    }

    #[test]
    fn prepare_for_storage_leaves_non_ssh_unchanged() {
        let store = MockStore::new();
        let conn = make_local_conn("c3");
        let result = prepare_for_storage(conn, &store).unwrap();
        if let ConnectionConfig::Local(local) = &result.config {
            assert_eq!(local.shell_type, "bash");
        } else {
            panic!("Expected Local config");
        }
        assert!(store.stored.lock().unwrap().is_empty());
    }

    #[test]
    fn prepare_agent_for_storage_stores_and_strips() {
        let store = MockStore::new();
        let agent = make_agent("a1", "password", Some("agent-pw"), Some(true));
        let result = prepare_agent_for_storage(agent, &store).unwrap();
        assert!(result.config.password.is_none());
        let stored = store.stored.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0.connection_id, "a1");
        assert_eq!(stored[0].0.credential_type, CredentialType::Password);
        assert_eq!(stored[0].1, "agent-pw");
    }

    #[test]
    fn prepare_agent_for_storage_strips_without_saving_when_save_false() {
        let store = MockStore::new();
        let agent = make_agent("a2", "password", Some("pw"), None);
        let result = prepare_agent_for_storage(agent, &store).unwrap();
        assert!(result.config.password.is_none());
        assert!(store.stored.lock().unwrap().is_empty());
    }

    #[test]
    fn external_file_round_trip() {
        let store = crate::credential::NullStore;
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test_connections.json");
        let path_str = file_path.to_str().unwrap();

        let folders = vec![ConnectionFolder {
            id: "folder-1".to_string(),
            name: "My Folder".to_string(),
            parent_id: None,
            is_expanded: true,
        }];

        let connections = vec![make_ssh_conn("conn-1", "password", Some("secret"), None)];
        let mut connections_with_folder = connections;
        connections_with_folder[0].folder_id = Some("folder-1".to_string());

        // Save
        save_external_file(
            path_str,
            "Test File",
            folders,
            connections_with_folder,
            &store,
        )
        .unwrap();

        // Load with "folder-1" in the main folder set so it's recognized
        let main_folders: std::collections::HashSet<&str> = vec!["folder-1"].into_iter().collect();
        let source = try_load_external_file(path_str, &main_folders, &store).unwrap();
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
        let store = crate::credential::NullStore;
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test_fallback.json");
        let path_str = file_path.to_str().unwrap();

        let mut conn = make_local_conn("conn-1");
        conn.folder_id = Some("unknown-folder".to_string());

        save_external_file(path_str, "Test", Vec::new(), vec![conn], &store).unwrap();

        // Load with empty main folders — folder_id should fall to None
        let main_folders: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let source = try_load_external_file(path_str, &main_folders, &store).unwrap();
        assert_eq!(source.connections[0].folder_id, None);
    }

    /// Write an external file with raw connections (passwords NOT stripped).
    /// Used by migration tests to simulate a pre-migration file on disk.
    fn write_raw_external_file(
        path: &str,
        name: &str,
        folders: Vec<ConnectionFolder>,
        connections: Vec<SavedConnection>,
    ) {
        let store = ExternalConnectionStore {
            name: Some(name.to_string()),
            version: "1".to_string(),
            folders,
            connections,
        };
        let data = serde_json::to_string_pretty(&store).unwrap();
        std::fs::write(path, data).unwrap();
    }

    #[test]
    fn external_file_migration_strips_passwords_from_disk() {
        let mock = MockStore::new();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("migrate_strip.json");
        let path_str = file_path.to_str().unwrap();

        // Write a file with a plaintext password (save_password = true)
        let conn = make_ssh_conn("c1", "password", Some("secret123"), Some(true));
        write_raw_external_file(path_str, "Test", Vec::new(), vec![conn]);

        // Load — should trigger migration
        let main_folders: HashSet<&str> = HashSet::new();
        let source = try_load_external_file(path_str, &main_folders, &mock).unwrap();

        // In-memory password should be stripped
        assert_eq!(source.connections.len(), 1);
        if let ConnectionConfig::Ssh(ssh) = &source.connections[0].config {
            assert!(ssh.password.is_none(), "In-memory password should be None");
        } else {
            panic!("Expected SSH config");
        }

        // Credential store should have the password
        let stored = mock.stored.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0.connection_id, "c1");
        assert_eq!(stored[0].0.credential_type, CredentialType::Password);
        assert_eq!(stored[0].1, "secret123");

        // Re-read the file — password should be gone from disk
        let raw = std::fs::read_to_string(path_str).unwrap();
        assert!(
            !raw.contains("secret123"),
            "Password should be stripped from disk"
        );
    }

    #[test]
    fn external_file_migration_skips_when_no_passwords() {
        let mock = MockStore::new();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("no_pw.json");
        let path_str = file_path.to_str().unwrap();

        // Write a file with no password
        let conn = make_ssh_conn("c1", "key", None, None);
        write_raw_external_file(path_str, "Test", Vec::new(), vec![conn]);

        // Snapshot original file content
        let original = std::fs::read_to_string(path_str).unwrap();

        // Load
        let main_folders: HashSet<&str> = HashSet::new();
        let _source = try_load_external_file(path_str, &main_folders, &mock).unwrap();

        // File content should be unchanged (no rewrite)
        let after = std::fs::read_to_string(path_str).unwrap();
        assert_eq!(original, after, "File should not have been rewritten");

        // Credential store should be empty
        assert!(mock.stored.lock().unwrap().is_empty());
    }

    #[test]
    fn external_file_migration_preserves_folder_structure() {
        let mock = MockStore::new();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("folders.json");
        let path_str = file_path.to_str().unwrap();

        let folders = vec![ConnectionFolder {
            id: "f1".to_string(),
            name: "My Folder".to_string(),
            parent_id: None,
            is_expanded: true,
        }];

        let mut conn = make_ssh_conn("c1", "password", Some("pw"), Some(true));
        conn.folder_id = Some("f1".to_string());
        write_raw_external_file(path_str, "Named File", folders, vec![conn]);

        // Load with empty main_folder_ids
        let main_folders: HashSet<&str> = HashSet::new();
        let _source = try_load_external_file(path_str, &main_folders, &mock).unwrap();

        // Re-read the file and verify structure is preserved on disk
        let raw = std::fs::read_to_string(path_str).unwrap();
        let on_disk: ExternalConnectionStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(on_disk.name, Some("Named File".to_string()));
        assert_eq!(on_disk.folders.len(), 1);
        assert_eq!(on_disk.folders[0].id, "f1");
        assert_eq!(on_disk.folders[0].name, "My Folder");
        assert_eq!(on_disk.connections.len(), 1);
        // folder_id should still be on disk (only modified in-memory for display)
        assert_eq!(
            on_disk.connections[0].folder_id,
            Some("f1".to_string()),
            "folder_id should be preserved on disk"
        );
        // Password should be gone
        if let ConnectionConfig::Ssh(ssh) = &on_disk.connections[0].config {
            assert!(ssh.password.is_none(), "Password stripped on disk");
        } else {
            panic!("Expected SSH config on disk");
        }
    }

    #[test]
    fn external_file_migration_no_store_when_save_false() {
        let mock = MockStore::new();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("no_save.json");
        let path_str = file_path.to_str().unwrap();

        // save_password is None (not true), so password should NOT be stored in credential store
        let conn = make_ssh_conn("c1", "password", Some("ephemeral"), None);
        write_raw_external_file(path_str, "Test", Vec::new(), vec![conn]);

        let main_folders: HashSet<&str> = HashSet::new();
        let _source = try_load_external_file(path_str, &main_folders, &mock).unwrap();

        // Credential store should be empty — password was discarded, not stored
        assert!(
            mock.stored.lock().unwrap().is_empty(),
            "Should not store when save_password is not true"
        );

        // File should no longer contain the password
        let raw = std::fs::read_to_string(path_str).unwrap();
        assert!(
            !raw.contains("ephemeral"),
            "Password should be stripped from disk even without save"
        );
    }

    #[test]
    fn external_file_migration_handles_mixed_connections() {
        let mock = MockStore::new();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("mixed.json");
        let path_str = file_path.to_str().unwrap();

        let connections = vec![
            // SSH with password + save_password=true → should store
            make_ssh_conn("c1", "password", Some("pw1"), Some(true)),
            // Local shell → no password to handle
            make_local_conn("c2"),
            // SSH key auth with passphrase + save_password=true → should store
            make_ssh_conn("c3", "key", Some("passphrase3"), Some(true)),
            // SSH with no password → nothing to do
            make_ssh_conn("c4", "password", None, Some(true)),
        ];
        write_raw_external_file(path_str, "Mixed", Vec::new(), connections);

        let main_folders: HashSet<&str> = HashSet::new();
        let source = try_load_external_file(path_str, &main_folders, &mock).unwrap();

        // All 4 connections should be returned
        assert_eq!(source.connections.len(), 4);

        // Exactly 2 credentials stored (c1 password + c3 key passphrase)
        let stored = mock.stored.lock().unwrap();
        assert_eq!(stored.len(), 2, "Should store exactly 2 credentials");

        let c1_entry = stored.iter().find(|(k, _)| k.connection_id == "c1").unwrap();
        assert_eq!(c1_entry.0.credential_type, CredentialType::Password);
        assert_eq!(c1_entry.1, "pw1");

        let c3_entry = stored.iter().find(|(k, _)| k.connection_id == "c3").unwrap();
        assert_eq!(c3_entry.0.credential_type, CredentialType::KeyPassphrase);
        assert_eq!(c3_entry.1, "passphrase3");

        // File on disk should be clean
        let raw = std::fs::read_to_string(path_str).unwrap();
        assert!(!raw.contains("pw1"), "pw1 should be stripped from disk");
        assert!(
            !raw.contains("passphrase3"),
            "passphrase3 should be stripped from disk"
        );
    }

    #[test]
    fn external_file_password_stripped_on_save() {
        let store = crate::credential::NullStore;
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("pass_test.json");
        let path_str = file_path.to_str().unwrap();

        let connections = vec![make_ssh_conn(
            "c1",
            "password",
            Some("should_be_removed"),
            None,
        )];

        save_external_file(path_str, "Test", Vec::new(), connections, &store).unwrap();

        // Read raw JSON and verify password is not stored
        let raw = std::fs::read_to_string(path_str).unwrap();
        assert!(
            !raw.contains("should_be_removed"),
            "Password should not be in saved file"
        );
    }
}
