use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// A saved connection configuration that survives agent restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// Session type: "shell", "serial", "docker", or "ssh".
    pub session_type: String,
    /// Session-specific configuration (shell path, serial params, etc.).
    #[serde(default)]
    pub config: serde_json::Value,
    /// Whether sessions created from this connection are persistent.
    #[serde(default)]
    pub persistent: bool,
    /// Parent folder ID, or `None` for root-level connections.
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// Read-only snapshot returned by list/create/update operations.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionSnapshot {
    pub id: String,
    pub name: String,
    pub session_type: String,
    pub config: serde_json::Value,
    pub persistent: bool,
    pub folder_id: Option<String>,
}

impl Connection {
    fn snapshot(&self) -> ConnectionSnapshot {
        ConnectionSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            session_type: self.session_type.clone(),
            config: self.config.clone(),
            persistent: self.persistent,
            folder_id: self.folder_id.clone(),
        }
    }
}

/// A folder for organizing connections in a hierarchy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// Parent folder ID, or `None` for root-level folders.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Whether this folder is expanded in the UI.
    #[serde(default)]
    pub is_expanded: bool,
}

/// Read-only snapshot returned by folder operations.
#[derive(Debug, Clone, Serialize)]
pub struct FolderSnapshot {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub is_expanded: bool,
}

impl Folder {
    fn snapshot(&self) -> FolderSnapshot {
        FolderSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            parent_id: self.parent_id.clone(),
            is_expanded: self.is_expanded,
        }
    }
}

/// Persistent storage format for connections.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StorageFormat {
    #[serde(default)]
    connections: Vec<Connection>,
    #[serde(default)]
    folders: Vec<Folder>,
}

/// Manages connections and folders with disk persistence.
pub struct ConnectionStore {
    connections: Mutex<HashMap<String, Connection>>,
    folders: Mutex<HashMap<String, Folder>>,
    file_path: PathBuf,
}

impl ConnectionStore {
    /// Create a new store, loading existing data from disk.
    /// Migrates from legacy `sessions.json` if `connections.json` doesn't exist.
    pub fn new(file_path: PathBuf) -> Self {
        let (connections, folders) = Self::load_from_disk(&file_path);
        Self {
            connections: Mutex::new(connections),
            folders: Mutex::new(folders),
            file_path,
        }
    }

    /// Create a store with a custom path (useful for testing).
    #[cfg(test)]
    pub fn new_temp(file_path: PathBuf) -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            folders: Mutex::new(HashMap::new()),
            file_path,
        }
    }

    /// Create a new connection. Returns the snapshot.
    pub async fn create(&self, conn: Connection) -> ConnectionSnapshot {
        let snapshot = conn.snapshot();
        let mut conns = self.connections.lock().await;
        let folders = self.folders.lock().await;
        conns.insert(conn.id.clone(), conn);
        self.save_to_disk(&conns, &folders);
        snapshot
    }

    /// Update an existing connection's fields. Returns `None` if not found.
    pub async fn update(
        &self,
        id: &str,
        name: Option<String>,
        session_type: Option<String>,
        config: Option<serde_json::Value>,
        persistent: Option<bool>,
        folder_id: Option<Option<String>>,
    ) -> Option<ConnectionSnapshot> {
        let mut conns = self.connections.lock().await;
        let conn = conns.get_mut(id)?;

        if let Some(name) = name {
            conn.name = name;
        }
        if let Some(session_type) = session_type {
            conn.session_type = session_type;
        }
        if let Some(config) = config {
            conn.config = config;
        }
        if let Some(persistent) = persistent {
            conn.persistent = persistent;
        }
        if let Some(folder_id) = folder_id {
            conn.folder_id = folder_id;
        }

        let snapshot = conn.snapshot();
        let folders = self.folders.lock().await;
        self.save_to_disk(&conns, &folders);
        Some(snapshot)
    }

    /// List all connections and folders.
    pub async fn list(&self) -> (Vec<ConnectionSnapshot>, Vec<FolderSnapshot>) {
        let conns = self.connections.lock().await;
        let folders = self.folders.lock().await;
        let conn_list = conns.values().map(|c| c.snapshot()).collect();
        let folder_list = folders.values().map(|f| f.snapshot()).collect();
        (conn_list, folder_list)
    }

    /// Delete a connection by ID. Returns `true` if found and deleted.
    pub async fn delete(&self, id: &str) -> bool {
        let mut conns = self.connections.lock().await;
        let removed = conns.remove(id).is_some();
        if removed {
            let folders = self.folders.lock().await;
            self.save_to_disk(&conns, &folders);
        }
        removed
    }

    /// Create a new folder. Returns the snapshot.
    pub async fn create_folder(&self, folder: Folder) -> FolderSnapshot {
        let snapshot = folder.snapshot();
        let mut folders = self.folders.lock().await;
        let conns = self.connections.lock().await;
        folders.insert(folder.id.clone(), folder);
        self.save_to_disk(&conns, &folders);
        snapshot
    }

    /// Update an existing folder's fields. Returns `None` if not found.
    pub async fn update_folder(
        &self,
        id: &str,
        name: Option<String>,
        parent_id: Option<Option<String>>,
        is_expanded: Option<bool>,
    ) -> Option<FolderSnapshot> {
        let mut folders = self.folders.lock().await;
        let folder = folders.get_mut(id)?;

        if let Some(name) = name {
            folder.name = name;
        }
        if let Some(parent_id) = parent_id {
            folder.parent_id = parent_id;
        }
        if let Some(is_expanded) = is_expanded {
            folder.is_expanded = is_expanded;
        }

        let snapshot = folder.snapshot();
        let conns = self.connections.lock().await;
        self.save_to_disk(&conns, &folders);
        Some(snapshot)
    }

    /// Delete a folder by ID. Moves children (connections and subfolders) to root.
    /// Returns `true` if found and deleted.
    pub async fn delete_folder(&self, id: &str) -> bool {
        let mut folders = self.folders.lock().await;
        let removed = folders.remove(id).is_some();
        if removed {
            let mut conns = self.connections.lock().await;
            // Move connections in this folder to root
            for conn in conns.values_mut() {
                if conn.folder_id.as_deref() == Some(id) {
                    conn.folder_id = None;
                }
            }
            // Move subfolders to root
            for folder in folders.values_mut() {
                if folder.parent_id.as_deref() == Some(id) {
                    folder.parent_id = None;
                }
            }
            self.save_to_disk(&conns, &folders);
        }
        removed
    }

    /// Ensure a "Default Shell" connection exists if the store is empty.
    /// Call this after loading to auto-create the default on first run.
    pub async fn ensure_default_shell(&self) {
        let mut conns = self.connections.lock().await;
        if !conns.is_empty() {
            return;
        }

        let shell = detect_default_shell();
        let default_conn = Connection {
            id: format!("conn-{}", uuid::Uuid::new_v4()),
            name: "Default Shell".to_string(),
            session_type: "shell".to_string(),
            config: serde_json::json!({ "shell": shell }),
            persistent: false,
            folder_id: None,
        };

        info!("Creating default shell connection (shell: {})", shell);
        conns.insert(default_conn.id.clone(), default_conn);
        let folders = self.folders.lock().await;
        self.save_to_disk(&conns, &folders);
    }

    /// Get the default storage path: `~/.config/termihub-agent/connections.json`.
    pub fn default_path() -> PathBuf {
        let config_dir = dirs_config_dir().join("termihub-agent");
        config_dir.join("connections.json")
    }

    /// Load from disk, with migration from legacy `sessions.json`.
    fn load_from_disk(path: &PathBuf) -> (HashMap<String, Connection>, HashMap<String, Folder>) {
        // Try loading the new format first
        if let Ok(contents) = std::fs::read_to_string(path) {
            match serde_json::from_str::<StorageFormat>(&contents) {
                Ok(storage) => {
                    debug!(
                        "Loaded {} connections and {} folders from {}",
                        storage.connections.len(),
                        storage.folders.len(),
                        path.display()
                    );
                    let conns = storage
                        .connections
                        .into_iter()
                        .map(|c| (c.id.clone(), c))
                        .collect();
                    let folders = storage
                        .folders
                        .into_iter()
                        .map(|f| (f.id.clone(), f))
                        .collect();
                    return (conns, folders);
                }
                Err(e) => {
                    warn!("Failed to parse connections from {}: {}", path.display(), e);
                    return (HashMap::new(), HashMap::new());
                }
            }
        }

        // Try migrating from legacy sessions.json
        let legacy_path = Self::legacy_path(path);
        if let Some(legacy) = legacy_path {
            if let Ok(contents) = std::fs::read_to_string(&legacy) {
                if let Ok(defs) = serde_json::from_str::<Vec<LegacySessionDefinition>>(&contents) {
                    info!(
                        "Migrating {} definitions from legacy {}",
                        defs.len(),
                        legacy.display()
                    );
                    let conns: HashMap<String, Connection> = defs
                        .into_iter()
                        .map(|d| {
                            let conn = Connection {
                                id: d.id.clone(),
                                name: d.name,
                                session_type: d.session_type,
                                config: d.config,
                                persistent: d.persistent,
                                folder_id: None,
                            };
                            (d.id, conn)
                        })
                        .collect();
                    return (conns, HashMap::new());
                }
            }
        }

        debug!("No connections file at {}", path.display());
        (HashMap::new(), HashMap::new())
    }

    /// Derive the legacy sessions.json path from the connections.json path.
    fn legacy_path(connections_path: &Path) -> Option<PathBuf> {
        connections_path
            .parent()
            .map(|dir| dir.join("sessions.json"))
    }

    fn save_to_disk(&self, conns: &HashMap<String, Connection>, folders: &HashMap<String, Folder>) {
        let storage = StorageFormat {
            connections: conns.values().cloned().collect(),
            folders: folders.values().cloned().collect(),
        };
        if let Some(parent) = self.file_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!(
                    "Failed to create config directory {}: {}",
                    parent.display(),
                    e
                );
                return;
            }
        }
        match serde_json::to_string_pretty(&storage) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&self.file_path, json) {
                    warn!(
                        "Failed to write connections to {}: {}",
                        self.file_path.display(),
                        e
                    );
                }
            }
            Err(e) => {
                warn!("Failed to serialize connections: {}", e);
            }
        }
    }
}

/// Legacy format for migration from sessions.json.
#[derive(Debug, Clone, Deserialize)]
struct LegacySessionDefinition {
    id: String,
    name: String,
    session_type: String,
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    persistent: bool,
}

/// Detect the system's default shell.
fn detect_default_shell() -> String {
    // Try $SHELL first
    if let Ok(shell) = std::env::var("SHELL") {
        if Path::new(&shell).exists() {
            return shell;
        }
    }

    // Fallback to well-known paths
    for candidate in &["/bin/bash", "/bin/sh", "/bin/zsh"] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }

    "/bin/sh".to_string()
}

/// Get the platform config directory (~/.config on Linux, ~/Library/Application Support on macOS).
fn dirs_config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg);
    }
    if let Ok(home) = std::env::var("HOME") {
        #[cfg(target_os = "macos")]
        return PathBuf::from(&home)
            .join("Library")
            .join("Application Support");
        #[cfg(not(target_os = "macos"))]
        return PathBuf::from(&home).join(".config");
    }
    PathBuf::from(".config")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn make_connection(id: &str, name: &str, persistent: bool) -> Connection {
        Connection {
            id: id.to_string(),
            name: name.to_string(),
            session_type: "shell".to_string(),
            config: json!({"shell": "/bin/bash"}),
            persistent,
            folder_id: None,
        }
    }

    fn make_folder(id: &str, name: &str, parent_id: Option<&str>) -> Folder {
        Folder {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: parent_id.map(|s| s.to_string()),
            is_expanded: false,
        }
    }

    // ── Connection CRUD ─────────────────────────────────────────────

    #[tokio::test]
    async fn create_and_list() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        let conn = make_connection("conn-1", "Build Shell", true);
        let snapshot = store.create(conn).await;
        assert_eq!(snapshot.id, "conn-1");
        assert_eq!(snapshot.name, "Build Shell");
        assert!(snapshot.persistent);

        let (conns, folders) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].id, "conn-1");
        assert!(folders.is_empty());
    }

    #[tokio::test]
    async fn update_connection() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store.create(make_connection("conn-1", "Old", false)).await;

        let updated = store
            .update(
                "conn-1",
                Some("New".to_string()),
                None,
                None,
                Some(true),
                None,
            )
            .await;
        assert!(updated.is_some());
        let snap = updated.unwrap();
        assert_eq!(snap.name, "New");
        assert!(snap.persistent);
    }

    #[tokio::test]
    async fn update_connection_not_found() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        let result = store
            .update(
                "nonexistent",
                Some("Name".to_string()),
                None,
                None,
                None,
                None,
            )
            .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn update_connection_folder_id() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create(make_connection("conn-1", "Shell", false))
            .await;
        store
            .create_folder(make_folder("folder-1", "My Folder", None))
            .await;

        // Move to folder
        let snap = store
            .update(
                "conn-1",
                None,
                None,
                None,
                None,
                Some(Some("folder-1".to_string())),
            )
            .await
            .unwrap();
        assert_eq!(snap.folder_id, Some("folder-1".to_string()));

        // Move back to root
        let snap = store
            .update("conn-1", None, None, None, None, Some(None))
            .await
            .unwrap();
        assert_eq!(snap.folder_id, None);
    }

    #[tokio::test]
    async fn delete_connection() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create(make_connection("conn-1", "Shell", false))
            .await;
        assert!(store.delete("conn-1").await);

        let (conns, _) = store.list().await;
        assert!(conns.is_empty());
    }

    #[tokio::test]
    async fn delete_connection_not_found() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        assert!(!store.delete("nonexistent").await);
    }

    // ── Folder CRUD ─────────────────────────────────────────────────

    #[tokio::test]
    async fn create_and_list_folders() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        let folder = make_folder("folder-1", "Project A", None);
        let snapshot = store.create_folder(folder).await;
        assert_eq!(snapshot.id, "folder-1");
        assert_eq!(snapshot.name, "Project A");
        assert_eq!(snapshot.parent_id, None);
        assert!(!snapshot.is_expanded);

        let (_, folders) = store.list().await;
        assert_eq!(folders.len(), 1);
    }

    #[tokio::test]
    async fn update_folder() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create_folder(make_folder("folder-1", "Old Name", None))
            .await;

        let updated = store
            .update_folder("folder-1", Some("New Name".to_string()), None, Some(true))
            .await;
        assert!(updated.is_some());
        let snap = updated.unwrap();
        assert_eq!(snap.name, "New Name");
        assert!(snap.is_expanded);
    }

    #[tokio::test]
    async fn update_folder_not_found() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        let result = store
            .update_folder("nonexistent", Some("Name".to_string()), None, None)
            .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn delete_folder_moves_children_to_root() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        // Create parent folder, subfolder, and connection in parent
        store
            .create_folder(make_folder("folder-1", "Parent", None))
            .await;
        store
            .create_folder(make_folder("folder-2", "Child", Some("folder-1")))
            .await;

        let mut conn = make_connection("conn-1", "Shell", false);
        conn.folder_id = Some("folder-1".to_string());
        store.create(conn).await;

        // Delete parent folder
        assert!(store.delete_folder("folder-1").await);

        let (conns, folders) = store.list().await;

        // Connection should be at root now
        assert_eq!(conns[0].folder_id, None);

        // Subfolder should be at root now
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, "folder-2");
        assert_eq!(folders[0].parent_id, None);
    }

    #[tokio::test]
    async fn delete_folder_not_found() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        assert!(!store.delete_folder("nonexistent").await);
    }

    // ── Persistence ─────────────────────────────────────────────────

    #[tokio::test]
    async fn persistence_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");

        {
            let store = ConnectionStore::new_temp(path.clone());
            store
                .create(make_connection("conn-1", "Shell 1", true))
                .await;
            store
                .create(make_connection("conn-2", "Shell 2", false))
                .await;
            store
                .create_folder(make_folder("folder-1", "Folder", None))
                .await;
        }

        let store2 = ConnectionStore::new(path);
        let (conns, folders) = store2.list().await;
        assert_eq!(conns.len(), 2);
        assert_eq!(folders.len(), 1);

        let ids: Vec<&str> = conns.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"conn-1"));
        assert!(ids.contains(&"conn-2"));
    }

    #[tokio::test]
    async fn handles_corrupt_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        fs::write(&path, "not valid json!!!").unwrap();

        let store = ConnectionStore::new(path);
        let (conns, folders) = store.list().await;
        assert!(conns.is_empty());
        assert!(folders.is_empty());
    }

    #[tokio::test]
    async fn handles_missing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.json");

        let store = ConnectionStore::new(path);
        let (conns, folders) = store.list().await;
        assert!(conns.is_empty());
        assert!(folders.is_empty());
    }

    // ── Migration from legacy sessions.json ─────────────────────────

    #[tokio::test]
    async fn migrates_from_legacy_sessions_json() {
        let tmp = TempDir::new().unwrap();
        let legacy_path = tmp.path().join("sessions.json");
        let new_path = tmp.path().join("connections.json");

        // Write legacy format
        let legacy_data = json!([
            {
                "id": "def-1",
                "name": "Build Shell",
                "session_type": "shell",
                "config": {"shell": "/bin/bash"},
                "persistent": true
            },
            {
                "id": "def-2",
                "name": "Serial Monitor",
                "session_type": "serial",
                "config": {"port": "/dev/ttyUSB0"},
                "persistent": false
            }
        ]);
        fs::write(&legacy_path, serde_json::to_string(&legacy_data).unwrap()).unwrap();

        let store = ConnectionStore::new(new_path);
        let (conns, folders) = store.list().await;
        assert_eq!(conns.len(), 2);
        assert!(folders.is_empty());

        let ids: Vec<&str> = conns.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"def-1"));
        assert!(ids.contains(&"def-2"));

        // All migrated connections should have folder_id = None
        for conn in &conns {
            assert_eq!(conn.folder_id, None);
        }
    }

    // ── Default shell ───────────────────────────────────────────────

    #[tokio::test]
    async fn ensure_default_shell_creates_on_empty_store() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store.ensure_default_shell().await;

        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].name, "Default Shell");
        assert_eq!(conns[0].session_type, "shell");
        assert!(conns[0].id.starts_with("conn-"));
    }

    #[tokio::test]
    async fn ensure_default_shell_skips_when_not_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create(make_connection("conn-1", "Existing", false))
            .await;
        store.ensure_default_shell().await;

        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].name, "Existing");
    }

    // ── Serde ───────────────────────────────────────────────────────

    #[test]
    fn connection_serde_round_trip() {
        let conn = Connection {
            id: "conn-1".to_string(),
            name: "Test".to_string(),
            session_type: "serial".to_string(),
            config: json!({"port": "/dev/ttyUSB0", "baud_rate": 115200}),
            persistent: true,
            folder_id: Some("folder-1".to_string()),
        };
        let json = serde_json::to_string(&conn).unwrap();
        let parsed: Connection = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "conn-1");
        assert_eq!(parsed.session_type, "serial");
        assert!(parsed.persistent);
        assert_eq!(parsed.folder_id, Some("folder-1".to_string()));
    }

    #[test]
    fn connection_defaults() {
        let json = r#"{"id":"conn-1","name":"Test","session_type":"shell"}"#;
        let conn: Connection = serde_json::from_str(json).unwrap();
        assert!(!conn.persistent);
        assert_eq!(conn.folder_id, None);
        assert_eq!(conn.config, json!(null));
    }

    #[test]
    fn folder_serde_round_trip() {
        let folder = Folder {
            id: "folder-1".to_string(),
            name: "Project".to_string(),
            parent_id: Some("folder-0".to_string()),
            is_expanded: true,
        };
        let json = serde_json::to_string(&folder).unwrap();
        let parsed: Folder = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "folder-1");
        assert_eq!(parsed.name, "Project");
        assert_eq!(parsed.parent_id, Some("folder-0".to_string()));
        assert!(parsed.is_expanded);
    }

    #[test]
    fn folder_defaults() {
        let json = r#"{"id":"folder-1","name":"Test"}"#;
        let folder: Folder = serde_json::from_str(json).unwrap();
        assert_eq!(folder.parent_id, None);
        assert!(!folder.is_expanded);
    }
}
