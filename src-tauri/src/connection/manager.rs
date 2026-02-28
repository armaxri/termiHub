use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{
    ConnectionFolder, ConnectionStore, EncryptedConnectionExport, ExternalConnectionStore,
    FlatConnectionStore, ImportPreview, ImportResult, SavedConnection, SavedRemoteAgent,
};
use super::recovery::RecoveryWarning;
use super::settings::{AppSettings, SettingsStorage};
use super::storage::ConnectionStorage;
use super::tree::{
    build_tree, compute_connection_id, compute_folder_id, count_tree_items,
    deduplicate_sibling_names, flatten_tree,
};
use crate::credential::crypto::{decrypt_with_password, encrypt_with_password};
use crate::credential::{CredentialKey, CredentialStore, CredentialType};

/// Route credentials to the active store (if `savePassword` is set),
/// then strip the password field so it is never written to disk.
pub(crate) fn prepare_for_storage(
    mut connection: SavedConnection,
    store: &dyn CredentialStore,
) -> Result<SavedConnection> {
    let settings = &mut connection.config.settings;
    if let Some(password) = settings
        .get("password")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        if settings.get("savePassword").and_then(|v| v.as_bool()) == Some(true) {
            let auth_method = settings
                .get("authMethod")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cred_type = if auth_method == "key" {
                CredentialType::KeyPassphrase
            } else {
                CredentialType::Password
            };
            store.set(&CredentialKey::new(&connection.id, cred_type), &password)?;
        }
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("password");
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

/// Migrate credentials when a connection's path-based ID changes
/// (due to rename or move).
fn migrate_credential(old_id: &str, new_id: &str, store: &dyn CredentialStore) -> Result<()> {
    if old_id == new_id {
        return Ok(());
    }
    // Try migrating both credential types
    for cred_type in &[CredentialType::Password, CredentialType::KeyPassphrase] {
        let old_key = CredentialKey::new(old_id, cred_type.clone());
        if let Ok(Some(value)) = store.get(&old_key) {
            let new_key = CredentialKey::new(new_id, cred_type.clone());
            store.set(&new_key, &value)?;
            store.remove(&old_key)?;
        }
    }
    Ok(())
}

/// Result of loading a single external connection file (flattened).
pub struct ExternalSource {
    pub file_path: String,
    pub connections: Vec<SavedConnection>,
    pub error: Option<String>,
}

/// Manages saved connections and folders with file persistence.
pub struct ConnectionManager {
    store: Mutex<FlatConnectionStore>,
    storage: ConnectionStorage,
    settings: Mutex<AppSettings>,
    settings_storage: SettingsStorage,
    credential_store: Arc<dyn CredentialStore>,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl ConnectionManager {
    /// Create a new connection manager, loading existing data from disk.
    /// Uses recovery loading to handle corrupt files gracefully.
    pub fn new(app_handle: &AppHandle, credential_store: Arc<dyn CredentialStore>) -> Result<Self> {
        let storage = ConnectionStorage::new(app_handle)?;
        let conn_result = storage.load_with_recovery()?;
        let flat = conn_result.data;
        let mut warnings = conn_result.warnings;

        let settings_storage = SettingsStorage::new(app_handle)?;
        let settings_result = settings_storage.load_with_recovery()?;
        warnings.extend(settings_result.warnings);

        Ok(Self {
            store: Mutex::new(flat),
            storage,
            settings: Mutex::new(settings_result.data),
            settings_storage,
            credential_store,
            recovery_warnings: Mutex::new(warnings),
        })
    }

    /// Drain and return any recovery warnings collected during initialization.
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| w.drain(..).collect())
            .unwrap_or_default()
    }

    /// Get all connections, folders, and agents (flat in-memory view).
    pub fn get_all(&self) -> Result<FlatConnectionStore> {
        let store = self.store.lock().unwrap();
        Ok(FlatConnectionStore {
            connections: store.connections.clone(),
            folders: store.folders.clone(),
            agents: store.agents.clone(),
        })
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

        self.storage
            .save_flat(&store)
            .context("Failed to persist agent")
    }

    /// Delete a remote agent by ID.
    pub fn delete_agent(&self, id: &str) -> Result<()> {
        self.credential_store.remove_all_for_connection(id)?;
        let mut store = self.store.lock().unwrap();
        store.agents.retain(|a| a.id != id);
        self.storage
            .save_flat(&store)
            .context("Failed to persist after agent delete")
    }

    /// Save (add or update) a connection. Passwords are stripped before persisting.
    ///
    /// After saving, recomputes the path-based ID to match the connection's
    /// current `folder_id` + `name`, then runs deduplication to ensure unique
    /// names within the folder. If the ID changes (due to move or dedup rename),
    /// credentials are migrated to the new path-based ID.
    pub fn save_connection(&self, connection: SavedConnection) -> Result<()> {
        let connection = prepare_for_storage(connection, &*self.credential_store)?;
        let old_id = connection.id.clone();
        let mut store = self.store.lock().unwrap();
        let FlatConnectionStore {
            connections,
            folders,
            ..
        } = &mut *store;

        // Find and replace, or add new — track the index so we can read
        // the final ID after deduplication.
        let save_idx = if let Some(idx) = connections.iter().position(|c| c.id == connection.id) {
            connections[idx] = connection;
            idx
        } else {
            connections.push(connection);
            connections.len() - 1
        };

        // Recompute ID to match current folder_id + name.
        // This is needed when a connection is moved to a different folder
        // via drag-and-drop — the frontend only updates folder_id, not id.
        connections[save_idx].id = compute_connection_id(
            connections[save_idx].folder_id.as_deref(),
            &connections[save_idx].name,
        );

        // Deduplicate sibling names (may rename the connection and change its ID)
        deduplicate_sibling_names(connections, folders);

        // Migrate credentials from old path-ID to new path-ID (if changed)
        let new_id = &connections[save_idx].id;
        if *new_id != old_id {
            let _ = migrate_credential(&old_id, new_id, &*self.credential_store);
        }

        self.storage
            .save_flat(&store)
            .context("Failed to persist connection")
    }

    /// Delete a connection by ID.
    pub fn delete_connection(&self, id: &str) -> Result<()> {
        self.credential_store.remove_all_for_connection(id)?;
        let mut store = self.store.lock().unwrap();
        store.connections.retain(|c| c.id != id);
        self.storage
            .save_flat(&store)
            .context("Failed to persist after delete")
    }

    /// Save (add or update) a folder.
    ///
    /// If a folder is renamed, recomputes path-based IDs for all descendant
    /// connections and folders, migrating credentials as needed.
    pub fn save_folder(&self, folder: ConnectionFolder) -> Result<()> {
        let mut store = self.store.lock().unwrap();

        // Check if this is a rename (collect info before mutating)
        let rename_info: Option<(String, String)> = store
            .folders
            .iter()
            .find(|f| f.id == folder.id)
            .and_then(|existing| {
                if existing.name != folder.name {
                    let old_id = existing.id.clone();
                    let new_id = compute_folder_id(folder.parent_id.as_deref(), &folder.name);
                    Some((old_id, new_id))
                } else {
                    None
                }
            });

        // Apply the folder update
        if let Some(existing) = store.folders.iter_mut().find(|f| f.id == folder.id) {
            *existing = folder;
        } else {
            store.folders.push(folder);
        }

        // Recompute descendant IDs if renamed
        if let Some((old_id, new_id)) = rename_info {
            let FlatConnectionStore {
                connections,
                folders,
                ..
            } = &mut *store;
            recompute_descendant_ids(
                connections,
                folders,
                &old_id,
                &new_id,
                &*self.credential_store,
            )?;
        }

        // Ensure unique folder names within parent
        let FlatConnectionStore {
            connections,
            folders,
            ..
        } = &mut *store;
        deduplicate_sibling_names(connections, folders);

        self.storage
            .save_flat(&store)
            .context("Failed to persist folder")
    }

    /// Delete a folder by ID. Moves its connections to root (folder_id = None)
    /// and reparents child folders, recomputing path-based IDs and migrating
    /// credentials.
    pub fn delete_folder(&self, id: &str) -> Result<()> {
        let mut store = self.store.lock().unwrap();

        let parent_id = store
            .folders
            .iter()
            .find(|f| f.id == id)
            .and_then(|f| f.parent_id.clone());

        // Move child connections to parent (or root)
        for conn in store.connections.iter_mut() {
            if conn.folder_id.as_deref() == Some(id) {
                let old_id = conn.id.clone();
                conn.folder_id = parent_id.clone();
                conn.id = compute_connection_id(parent_id.as_deref(), &conn.name);
                let _ = migrate_credential(&old_id, &conn.id, &*self.credential_store);
            }
        }

        // Collect reparent operations needed
        let reparent_ops: Vec<(String, String)> = store
            .folders
            .iter()
            .filter(|f| f.parent_id.as_deref() == Some(id))
            .map(|f| {
                let old_id = f.id.clone();
                let new_id = compute_folder_id(parent_id.as_deref(), &f.name);
                (old_id, new_id)
            })
            .collect();

        // Update parent_id for child folders
        for folder in store.folders.iter_mut() {
            if folder.parent_id.as_deref() == Some(id) {
                folder.parent_id = parent_id.clone();
            }
        }

        // Recompute descendant IDs for reparented folders
        for (old_id, new_id) in reparent_ops {
            let FlatConnectionStore {
                connections,
                folders,
                ..
            } = &mut *store;
            let _ = recompute_descendant_ids(
                connections,
                folders,
                &old_id,
                &new_id,
                &*self.credential_store,
            );
        }

        store.folders.retain(|f| f.id != id);

        // Deduplicate names — reparented children may collide with existing
        // siblings in the parent folder
        {
            let FlatConnectionStore {
                connections,
                folders,
                ..
            } = &mut *store;
            deduplicate_sibling_names(connections, folders);
        }

        self.storage
            .save_flat(&store)
            .context("Failed to persist after folder delete")
    }

    /// Export all connections and folders as a JSON string. Passwords are stripped.
    pub fn export_json(&self) -> Result<String> {
        let store = self.store.lock().unwrap();
        let mut export_conns = store.connections.clone();
        export_conns = export_conns
            .into_iter()
            .map(|c| prepare_for_storage(c, &*self.credential_store))
            .collect::<Result<Vec<_>>>()?;

        let tree = build_tree(&export_conns, &store.folders);
        let export_store = ConnectionStore {
            version: "2".to_string(),
            children: tree,
            agents: store.agents.clone(),
        };
        serde_json::to_string_pretty(&export_store)
            .context("Failed to serialize connections for export")
    }

    /// Import connections and folders from a JSON string.
    /// Returns the number of connections imported.
    pub fn import_json(&self, json: &str) -> Result<usize> {
        let imported: ConnectionStore =
            serde_json::from_str(json).context("Failed to parse import data")?;

        let (imported_conns, imported_folders) = flatten_tree(&imported.children, None);
        let count = imported_conns.len();

        let mut store = self.store.lock().unwrap();

        // Merge: add imported folders that don't already exist (by name path)
        for folder in imported_folders {
            if !store.folders.iter().any(|f| f.id == folder.id) {
                store.folders.push(folder);
            }
        }

        // Merge: add imported connections that don't already exist (strip passwords)
        for conn in imported_conns {
            if !store.connections.iter().any(|c| c.id == conn.id) {
                store
                    .connections
                    .push(prepare_for_storage(conn, &*self.credential_store)?);
            }
        }

        // Deduplicate after merge
        {
            let FlatConnectionStore {
                connections,
                folders,
                ..
            } = &mut *store;
            deduplicate_sibling_names(connections, folders);
        }

        self.storage
            .save_flat(&store)
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

    /// Export connections with optional encrypted credentials.
    pub fn export_encrypted_json(
        &self,
        password: Option<&str>,
        connection_ids: Option<&[String]>,
    ) -> Result<String> {
        let store = self.store.lock().unwrap();

        // Select connections to export (all or filtered by IDs)
        let connections: Vec<SavedConnection> = match connection_ids {
            Some(ids) => store
                .connections
                .iter()
                .filter(|c| ids.contains(&c.id))
                .cloned()
                .collect(),
            None => store.connections.clone(),
        };

        let folders = store.folders.clone();
        let agents = store.agents.clone();
        drop(store);

        // Strip inline passwords
        let connections: Vec<SavedConnection> = connections
            .into_iter()
            .map(|c| prepare_for_storage(c, &*self.credential_store))
            .collect::<Result<Vec<_>>>()?;

        // Build the encrypted credentials section if a password is provided
        let encrypted = match password {
            Some(pw) => {
                let mut cred_map: HashMap<String, String> = HashMap::new();

                for conn in &connections {
                    let settings = &conn.config.settings;
                    if let Some(auth_method) = settings.get("authMethod").and_then(|v| v.as_str()) {
                        let cred_type = if auth_method == "key" {
                            CredentialType::KeyPassphrase
                        } else {
                            CredentialType::Password
                        };
                        let key = CredentialKey::new(&conn.id, cred_type);
                        if let Ok(Some(value)) = self.credential_store.get(&key) {
                            cred_map.insert(key.to_string(), value);
                        }
                    }
                }

                for agent in &agents {
                    let cred_type = if agent.config.auth_method == "key" {
                        CredentialType::KeyPassphrase
                    } else {
                        CredentialType::Password
                    };
                    let key = CredentialKey::new(&agent.id, cred_type);
                    if let Ok(Some(value)) = self.credential_store.get(&key) {
                        cred_map.insert(key.to_string(), value);
                    }
                }

                if cred_map.is_empty() {
                    None
                } else {
                    let plaintext = serde_json::to_vec(&cred_map)
                        .context("Failed to serialize credential map")?;
                    Some(
                        encrypt_with_password(pw, &plaintext)
                            .context("Failed to encrypt credentials")?,
                    )
                }
            }
            None => None,
        };

        let tree = build_tree(&connections, &folders);
        let export = EncryptedConnectionExport {
            version: "2".to_string(),
            children: tree,
            agents,
            encrypted,
        };

        serde_json::to_string_pretty(&export).context("Failed to serialize encrypted export")
    }

    /// Import connections from an encrypted export JSON string.
    pub fn import_encrypted_json(
        &self,
        json: &str,
        password: Option<&str>,
    ) -> Result<ImportResult> {
        let imported: EncryptedConnectionExport =
            serde_json::from_str(json).context("Failed to parse import data")?;

        let mut credentials_imported = 0;

        // Decrypt and store credentials if available
        if let (Some(ref envelope), Some(pw)) = (&imported.encrypted, password) {
            let plaintext = decrypt_with_password(pw, envelope)
                .context("Failed to decrypt credentials — wrong password?")?;
            let cred_map: HashMap<String, String> =
                serde_json::from_slice(&plaintext).context("Invalid credential data format")?;

            for (map_key, value) in &cred_map {
                if let Some(cred_key) = CredentialKey::from_map_key(map_key) {
                    self.credential_store.set(&cred_key, value)?;
                    credentials_imported += 1;
                }
            }
        }

        // Flatten the imported tree
        let (imported_conns, imported_folders) = flatten_tree(&imported.children, None);
        let connections_imported = imported_conns.len();

        // Merge connections, folders, and agents
        let mut store = self.store.lock().unwrap();

        for folder in imported_folders {
            if !store.folders.iter().any(|f| f.id == folder.id) {
                store.folders.push(folder);
            }
        }

        for conn in imported_conns {
            if !store.connections.iter().any(|c| c.id == conn.id) {
                store
                    .connections
                    .push(prepare_for_storage(conn, &*self.credential_store)?);
            }
        }

        for agent in imported.agents {
            if !store.agents.iter().any(|a| a.id == agent.id) {
                store.agents.push(agent);
            }
        }

        // Deduplicate after merge
        {
            let FlatConnectionStore {
                connections,
                folders,
                ..
            } = &mut *store;
            deduplicate_sibling_names(connections, folders);
        }

        self.storage
            .save_flat(&store)
            .context("Failed to persist after import")?;

        Ok(ImportResult {
            connections_imported,
            credentials_imported,
        })
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
                    .save_flat(&store)
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
                    .save_flat(&store)
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

/// Recompute path-based IDs for all descendants of a folder whose ID changed.
fn recompute_descendant_ids(
    connections: &mut [SavedConnection],
    folders: &mut [ConnectionFolder],
    old_folder_id: &str,
    new_folder_id: &str,
    credential_store: &dyn CredentialStore,
) -> Result<()> {
    if old_folder_id == new_folder_id {
        return Ok(());
    }

    // Update the folder itself
    if let Some(folder) = folders.iter_mut().find(|f| f.id == old_folder_id) {
        folder.id = new_folder_id.to_string();
    }

    // Update direct child connections
    for conn in connections.iter_mut() {
        if conn.folder_id.as_deref() == Some(old_folder_id) {
            let old_conn_id = conn.id.clone();
            conn.folder_id = Some(new_folder_id.to_string());
            conn.id = compute_connection_id(Some(new_folder_id), &conn.name);
            let _ = migrate_credential(&old_conn_id, &conn.id, credential_store);
        }
    }

    // Collect child folder IDs that need updating (to avoid borrow conflicts)
    let child_updates: Vec<(String, String)> = folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == Some(old_folder_id))
        .map(|f| {
            let old_child_id = f.id.clone();
            let new_child_id = compute_folder_id(Some(new_folder_id), &f.name);
            (old_child_id, new_child_id)
        })
        .collect();

    // Update child folders' parent_id
    for folder in folders.iter_mut() {
        if folder.parent_id.as_deref() == Some(old_folder_id) {
            folder.parent_id = Some(new_folder_id.to_string());
        }
    }

    // Recursively update grandchildren
    for (old_child_id, new_child_id) in child_updates {
        recompute_descendant_ids(
            connections,
            folders,
            &old_child_id,
            &new_child_id,
            credential_store,
        )?;
    }

    Ok(())
}

/// Parse an import JSON string and return a summary of its contents
/// without actually performing the import.
pub fn preview_import_json(json: &str) -> Result<ImportPreview> {
    let export: EncryptedConnectionExport =
        serde_json::from_str(json).context("Failed to parse import data")?;

    let (conn_count, folder_count) = count_tree_items(&export.children);

    Ok(ImportPreview {
        connection_count: conn_count,
        folder_count,
        agent_count: export.agents.len(),
        has_encrypted_credentials: export.encrypted.is_some(),
    })
}

/// Load a single external connection file, flattening connections.
fn load_single_external_file(
    file_path: &str,
    main_folder_ids: &HashSet<&str>,
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
    main_folder_ids: &HashSet<&str>,
    store: &dyn CredentialStore,
) -> Result<ExternalSource> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    // Flatten the nested tree
    let (mut connections, _folders) = flatten_tree(&ext_store.children, None);

    // Migrate: strip plaintext passwords and route to credential store
    let has_plaintext_passwords = connections.iter().any(|conn| {
        conn.config
            .settings
            .get("password")
            .and_then(|v| v.as_str())
            .is_some()
    });

    if has_plaintext_passwords {
        connections = connections
            .into_iter()
            .map(|c| prepare_for_storage(c, store))
            .collect::<Result<Vec<_>>>()?;

        // Rewrite the external file with passwords stripped
        let cleaned_tree = build_tree(&connections, &[]);
        let cleaned_store = ExternalConnectionStore {
            name: ext_store.name,
            version: "2".to_string(),
            children: cleaned_tree,
        };
        let cleaned_data = serde_json::to_string_pretty(&cleaned_store)
            .context("Failed to serialize external file during migration")?;
        std::fs::write(file_path, cleaned_data)
            .with_context(|| format!("Failed to rewrite external file: {}", file_path))?;
    }

    // Validate folder_id: if not in main folders, put at root
    for conn in &mut connections {
        conn.source_file = Some(file_path.to_string());
        if let Some(ref fid) = conn.folder_id {
            if !main_folder_ids.contains(fid.as_str()) {
                conn.folder_id = None;
            }
        }
    }

    // Strip passwords from in-memory connections
    connections = connections
        .into_iter()
        .map(|c| prepare_for_storage(c, store))
        .collect::<Result<Vec<_>>>()?;

    Ok(ExternalSource {
        file_path: file_path.to_string(),
        connections,
        error: None,
    })
}

/// Save or update a single connection in an external file (by name+folder path).
fn save_or_update_in_external_file(file_path: &str, connection: SavedConnection) -> Result<()> {
    let data = std::fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read external file: {}", file_path))?;

    let mut ext_store: ExternalConnectionStore = serde_json::from_str(&data)
        .with_context(|| format!("Failed to parse external file: {}", file_path))?;

    // Flatten, update, rebuild
    let (mut conns, folders) = flatten_tree(&ext_store.children, None);

    if let Some(existing) = conns.iter_mut().find(|c| c.id == connection.id) {
        *existing = connection;
    } else {
        conns.push(connection);
    }

    ext_store.children = build_tree(&conns, &folders);

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

    let (mut conns, folders) = flatten_tree(&ext_store.children, None);
    conns.retain(|c| c.id != connection_id);
    ext_store.children = build_tree(&conns, &folders);

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

    let (mut conns, folders) = flatten_tree(&ext_store.children, None);

    let idx = conns
        .iter()
        .position(|c| c.id == connection_id)
        .with_context(|| format!("Connection {} not found in {}", connection_id, file_path))?;

    let conn = conns.remove(idx);
    ext_store.children = build_tree(&conns, &folders);

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
    let connections: Vec<SavedConnection> = connections
        .into_iter()
        .map(|c| prepare_for_storage(c, credential_store))
        .collect::<Result<Vec<_>>>()?;

    let tree = build_tree(&connections, &folders);
    let store = ExternalConnectionStore {
        name: Some(name.to_string()),
        version: "2".to_string(),
        children: tree,
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
    use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};
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
        let mut settings = serde_json::json!({
            "host": "host",
            "port": 22,
            "username": "user",
            "authMethod": auth_method,
            "enableX11Forwarding": false
        });
        if let Some(pw) = password {
            settings["password"] = serde_json::Value::String(pw.to_string());
        }
        if let Some(sp) = save_password {
            settings["savePassword"] = serde_json::Value::Bool(sp);
        }
        SavedConnection {
            id: id.to_string(),
            name: "SSH".to_string(),
            config: ConnectionConfig {
                type_id: "ssh".to_string(),
                settings,
            },
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }
    }

    fn make_local_conn(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: "Local".to_string(),
            config: ConnectionConfig {
                type_id: "local".to_string(),
                settings: serde_json::json!({"shell": "bash"}),
            },
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
        assert!(result.config.settings.get("password").is_none());
        assert!(store.stored.lock().unwrap().is_empty());
    }

    #[test]
    fn prepare_for_storage_stores_and_strips_when_save_true() {
        let store = MockStore::new();
        let conn = make_ssh_conn("c1", "password", Some("secret"), Some(true));
        let result = prepare_for_storage(conn, &store).unwrap();
        assert!(
            result.config.settings.get("password").is_none(),
            "Password should be stripped"
        );
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
        assert_eq!(result.config.type_id, "local");
        assert_eq!(result.config.settings["shell"], "bash");
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
            id: "My Folder".to_string(),
            name: "My Folder".to_string(),
            parent_id: None,
            is_expanded: true,
        }];

        let mut conn = make_ssh_conn("My Folder/SSH", "password", Some("secret"), None);
        conn.name = "SSH".to_string();
        conn.folder_id = Some("My Folder".to_string());

        // Save
        save_external_file(path_str, "Test File", folders, vec![conn], &store).unwrap();

        // Load with "My Folder" in the main folder set so it's recognized
        let main_folders: HashSet<&str> = vec!["My Folder"].into_iter().collect();
        let source = try_load_external_file(path_str, &main_folders, &store).unwrap();
        assert!(source.error.is_none());

        assert_eq!(source.connections.len(), 1);
        let conn = &source.connections[0];
        assert_eq!(conn.name, "SSH");
        assert_eq!(conn.source_file.as_deref(), Some(path_str));
        assert_eq!(conn.folder_id.as_deref(), Some("My Folder"));
        assert!(
            conn.config.settings.get("password").is_none(),
            "Password should be stripped"
        );
    }

    #[test]
    fn external_file_folder_id_falls_to_root_when_not_in_main() {
        let store = crate::credential::NullStore;
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test_fallback.json");
        let path_str = file_path.to_str().unwrap();

        let mut conn = make_local_conn("Unknown/Local");
        conn.name = "Local".to_string();
        conn.folder_id = Some("Unknown".to_string());

        let folders = vec![ConnectionFolder {
            id: "Unknown".to_string(),
            name: "Unknown".to_string(),
            parent_id: None,
            is_expanded: true,
        }];

        save_external_file(path_str, "Test", folders, vec![conn], &store).unwrap();

        // Load with empty main folders — folder_id should fall to None
        let main_folders: HashSet<&str> = HashSet::new();
        let source = try_load_external_file(path_str, &main_folders, &store).unwrap();
        assert_eq!(source.connections[0].folder_id, None);
    }

    #[test]
    fn preview_import_detects_encrypted_section() {
        let json = r#"{
            "version": "2",
            "children": [
                {"type": "connection", "name": "SSH", "config": {"type": "ssh", "config": {"host": "h", "port": 22, "username": "u", "authMethod": "password"}}}
            ],
            "agents": [],
            "$encrypted": {"version": 1, "kdf": {"algorithm": "argon2id", "salt": "AAAA", "memoryCost": 65536, "timeCost": 3, "parallelism": 1}, "nonce": "AAAA", "data": "AAAA"}
        }"#;

        let preview = preview_import_json(json).unwrap();
        assert_eq!(preview.connection_count, 1);
        assert_eq!(preview.folder_count, 0);
        assert!(preview.has_encrypted_credentials);
    }

    #[test]
    fn preview_import_detects_no_encrypted_section() {
        let json = r#"{
            "version": "2",
            "children": [
                {"type": "folder", "name": "F", "isExpanded": true, "children": []}
            ],
            "agents": []
        }"#;

        let preview = preview_import_json(json).unwrap();
        assert_eq!(preview.connection_count, 0);
        assert_eq!(preview.folder_count, 1);
        assert!(!preview.has_encrypted_credentials);
    }

    #[test]
    fn preview_import_with_agents() {
        let json = r#"{"version": "2", "children": [], "agents": []}"#;
        let preview = preview_import_json(json).unwrap();
        assert_eq!(preview.connection_count, 0);
        assert!(!preview.has_encrypted_credentials);
    }
}
