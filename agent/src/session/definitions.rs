use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::store_version::{self, NewerVersionError};

/// A saved connection configuration that survives agent restarts.
///
/// Deserialization goes through [`RawConnection`] so the type-scoped legacy
/// settings keys (FTP's `timeoutSecs`, #2901) are rewritten with the
/// connection's `session_type` in hand; only the unified keys are persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "RawConnection")]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// Session type: "shell", "serial", "docker", or "ssh".
    pub session_type: String,
    /// Session-specific configuration (shell path, serial params, etc.).
    ///
    /// The legacy `resilientReconnect` key (written by older builds) is accepted
    /// on read and rewritten to the unified `autoReconnect` key (PARITY-008); only
    /// the new key is persisted.
    #[serde(
        default,
        with = "termihub_core::connection::auto_reconnect::settings_bag"
    )]
    pub config: serde_json::Value,
    /// Whether sessions created from this connection are persistent.
    #[serde(default)]
    pub persistent: bool,
    /// Parent folder ID, or `None` for root-level connections.
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Terminal appearance/behaviour overrides (font, color, cursor, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_options: Option<serde_json::Value>,
    /// Custom icon name (lucide-react PascalCase or "lab:camelCase").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Fields this agent does not know (e.g. written by a newer agent at the
    /// same schema version). Kept on disk verbatim across load and save, never
    /// sent on the wire (#3931).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// On-disk shape of [`Connection`], read before the type-scoped legacy-key
/// renames are applied (see [`Connection::normalize_settings`]).
#[derive(Deserialize)]
struct RawConnection {
    id: String,
    name: String,
    session_type: String,
    #[serde(
        default,
        with = "termihub_core::connection::auto_reconnect::settings_bag"
    )]
    config: serde_json::Value,
    #[serde(default)]
    persistent: bool,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    terminal_options: Option<serde_json::Value>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl From<RawConnection> for Connection {
    fn from(raw: RawConnection) -> Self {
        let mut conn = Self {
            id: raw.id,
            name: raw.name,
            session_type: raw.session_type,
            config: raw.config,
            persistent: raw.persistent,
            folder_id: raw.folder_id,
            terminal_options: raw.terminal_options,
            icon: raw.icon,
            extra: raw.extra,
        };
        conn.normalize_settings();
        conn
    }
}

/// Read-only snapshot returned by list/create/update operations.
///
/// This IS the shared wire DTO defined once in `termihub-core`
/// ([`ConnectionDefinition`]); it is re-exported here under the historical
/// `ConnectionSnapshot` name so the agent emits exactly the type the desktop
/// deserializes — one definition of the wire shape, no drift (DUP-001). The
/// serialized bytes are byte-identical to the pre-DUP-001 struct (same fields,
/// same order, same `skip_serializing_if`); pinned by
/// `core::protocol::methods` wire tests and the round-trip tests below.
pub use termihub_core::protocol::methods::{
    ConnectionDefinition as ConnectionSnapshot, FolderDefinition as FolderSnapshot,
};

impl Connection {
    /// Rewrite type-scoped legacy settings keys (FTP's `timeoutSecs` →
    /// `connectTimeoutSecs`, #2901) in place, keeping the user's value.
    fn normalize_settings(&mut self) {
        termihub_core::connection::normalize_connection_settings(
            &self.session_type,
            &mut self.config,
        );
    }

    fn snapshot(&self) -> ConnectionSnapshot {
        ConnectionSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            session_type: self.session_type.clone(),
            config: self.config.clone(),
            persistent: self.persistent,
            folder_id: self.folder_id.clone(),
            terminal_options: self.terminal_options.clone(),
            icon: self.icon.clone(),
            source_file: None,
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
    /// Unknown fields, preserved on disk across load and save (#3931).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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

// ── ConnectionStoreApi trait ───────────────────────────────────────

/// Abstract interface over the connection store.
///
/// Implemented by [`ConnectionStore`] in production and by mock structs in
/// tests. [`crate::handler::dispatch::Dispatcher`] depends on this trait so
/// it can be tested without touching the filesystem.
#[async_trait::async_trait]
pub trait ConnectionStoreApi: Send + Sync + 'static {
    /// Return a connection snapshot by ID.
    async fn get(&self, id: &str) -> Option<ConnectionSnapshot>;

    /// Create a new connection and return its snapshot.
    ///
    /// Every mutating method fails with [`NewerVersionError`] — without
    /// touching memory or disk — when the store file on disk was written by a
    /// newer agent (#3920).
    async fn create(&self, conn: Connection) -> Result<ConnectionSnapshot, NewerVersionError>;

    /// Update an existing connection's fields. Returns `None` if not found.
    #[allow(clippy::too_many_arguments)]
    async fn update(
        &self,
        id: &str,
        name: Option<String>,
        session_type: Option<String>,
        config: Option<serde_json::Value>,
        persistent: Option<bool>,
        folder_id: Option<Option<String>>,
        terminal_options: Option<Option<serde_json::Value>>,
        icon: Option<Option<String>>,
    ) -> Result<Option<ConnectionSnapshot>, NewerVersionError>;

    /// List all connections and folders.
    async fn list(&self) -> (Vec<ConnectionSnapshot>, Vec<FolderSnapshot>);

    /// Delete a connection by ID. Returns `true` if found and removed.
    async fn delete(&self, id: &str) -> Result<bool, NewerVersionError>;

    /// Create a new folder and return its snapshot.
    async fn create_folder(&self, folder: Folder) -> Result<FolderSnapshot, NewerVersionError>;

    /// Update an existing folder's fields. Returns `None` if not found.
    async fn update_folder(
        &self,
        id: &str,
        name: Option<String>,
        parent_id: Option<Option<String>>,
        is_expanded: Option<bool>,
    ) -> Result<Option<FolderSnapshot>, NewerVersionError>;

    /// Delete a folder by ID. Returns `true` if found and removed.
    async fn delete_folder(&self, id: &str) -> Result<bool, NewerVersionError>;

    /// Load connections from external files on the remote host.
    ///
    /// External connections are read-only: they appear in `list()` results
    /// tagged with their source path, but `create`/`update`/`delete` always
    /// operate on the primary store. Calling this again replaces the previous
    /// external set.
    async fn load_external_files(&self, _paths: &[String]) {}
}

/// Diagnostic name of the agent's definitions store.
const DEFINITIONS_STORE_NAME: &str = "connections.json";

/// Current schema version of the agent's `connections.json` (#3920).
///
/// A file with no `version` is the baseline, v1 — every file written before the
/// store was versioned. A file with a **newer** version is refused: it is never
/// reset, migrated or overwritten (see [`crate::store_version`]). When the
/// persisted shape changes — a settings-key rename, say — bump this and add the
/// numbered step to [`migrate_definitions`], so an older agent can no longer
/// overwrite a file that uses the new shape.
pub const DEFINITIONS_STORE_VERSION: u32 = 1;

/// Migrate a parsed store from `from_version` up to [`DEFINITIONS_STORE_VERSION`],
/// one numbered step at a time.
///
/// v1 is the first versioned schema, so there is no step yet: every earlier
/// file is already v1-shaped. The settings-key renames made before versioning
/// (`resilientReconnect` → `autoReconnect`, FTP `timeoutSecs` →
/// `connectTimeoutSecs`, #2901) stay in `Connection`'s rename-on-read, because
/// they also apply to external files and RPC requests. Add the next rename as
/// `if version < 2 { …; version = 2; }` and bump the constant.
fn migrate_definitions(
    value: serde_json::Value,
    from_version: u32,
) -> Result<serde_json::Value, String> {
    let version = from_version;
    debug_assert!(version <= DEFINITIONS_STORE_VERSION);
    Ok(value)
}

/// Persistent storage format for connections.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StorageFormat {
    /// Schema version, written as a string like the desktop stores. Only ever
    /// written: loading reads it from the raw JSON before the typed parse.
    #[serde(default, skip_deserializing)]
    version: String,
    #[serde(default)]
    connections: Vec<Connection>,
    #[serde(default)]
    folders: Vec<Folder>,
    /// Unknown top-level keys, preserved across load and save (#3931). On load
    /// this also catches `version`, which [`StorageFormat::into_definitions`]
    /// strips so it is never written twice.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

/// Keys [`StorageFormat`] owns itself; never carried in its `extra` map.
const STORAGE_KNOWN_KEYS: [&str; 3] = ["version", "connections", "folders"];

impl StorageFormat {
    fn into_definitions(self) -> Definitions {
        let mut extra = self.extra;
        for key in STORAGE_KNOWN_KEYS {
            extra.remove(key);
        }
        Definitions {
            connections: self
                .connections
                .into_iter()
                .map(|c| (c.id.clone(), c))
                .collect(),
            folders: self
                .folders
                .into_iter()
                .map(|f| (f.id.clone(), f))
                .collect(),
            extra,
        }
    }
}

/// A corrupt `connections.json` whose copy is not yet safely on disk (#3931).
///
/// While one is pending, nothing may overwrite the store file.
#[derive(Debug)]
enum PendingBackup {
    /// The corrupt file's bytes, as read at load; backing up failed so far.
    Bytes(Vec<u8>),
    /// The file existed but could not be read at all; re-read before a save.
    Unreadable,
}

/// Which cross-process lock [`ConnectionStore::lock_store_file`] takes.
#[derive(Debug, Clone, Copy)]
enum LockMode {
    /// Readers that only refresh the in-memory snapshot.
    Shared,
    /// Every read-modify-write of the store file.
    Exclusive,
}

/// Why [`ConnectionStore::refresh_from_disk`] re-reads the store file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshMode {
    /// Serving a read: never back up or rewrite anything.
    Read,
    /// About to save: a corrupt file is backed up and salvaged first.
    Mutation,
}

/// Result of [`ConnectionStore::load_from_disk`].
#[derive(Debug, Default)]
struct Loaded {
    definitions: Definitions,
    /// The file was corrupt: `definitions` hold whatever could be salvaged.
    recovered_from_corruption: bool,
    /// Set when the corrupt file's copy could not be written yet.
    pending_backup: Option<PendingBackup>,
}

/// In-memory definitions: connections and folders held together.
///
/// These two maps are almost always read/mutated as a pair (every mutation
/// persists both via `save_to_disk`), so they live behind a **single** mutex.
/// Keeping them under one lock removes the AB-BA lock-order-inversion deadlock
/// that existed when `connections` and `folders` were two independent mutexes
/// locked in opposite orders across methods (CONC-001).
#[derive(Debug, Default)]
struct Definitions {
    connections: HashMap<String, Connection>,
    folders: HashMap<String, Folder>,
    /// Unknown top-level store keys, written back verbatim (#3931).
    extra: serde_json::Map<String, serde_json::Value>,
}

/// Manages connections and folders with disk persistence.
pub struct ConnectionStore {
    /// Connections and folders under a single lock (see [`Definitions`]).
    definitions: Mutex<Definitions>,
    file_path: PathBuf,
    /// Set when the store file was written by a newer agent (#3920). The file
    /// is then left intact and every mutation is refused with this error.
    newer_on_disk: Option<NewerVersionError>,
    /// A corrupt store file that has not been backed up yet (#3931). Every save
    /// first retries the backup and is refused while it keeps failing.
    pending_backup: std::sync::Mutex<Option<PendingBackup>>,
    /// Read-only connections loaded from external files, tagged with their source path.
    external_snapshots: Mutex<Vec<ConnectionSnapshot>>,
}

impl ConnectionStore {
    /// Create a new store, loading existing data from disk.
    /// Migrates from legacy `sessions.json` if `connections.json` doesn't exist.
    pub fn new(file_path: PathBuf) -> Self {
        // Exclusive, not shared: a corrupt file is backed up and the salvage
        // persisted below, both of which must not race a peer worker's save.
        let _file_lock = Self::lock_store_file(&file_path, LockMode::Exclusive);
        let (loaded, newer_on_disk) = match Self::load_from_disk(&file_path) {
            Ok(loaded) => (loaded, None),
            Err(newer) => {
                error!(
                    "{} (at {}); the file is left untouched and the saved connections \
                     are read-only until the agent is updated",
                    newer,
                    file_path.display()
                );
                (Loaded::default(), Some(newer))
            }
        };
        let persist_salvage = loaded.recovered_from_corruption && loaded.pending_backup.is_none();
        let store = Self {
            definitions: Mutex::new(loaded.definitions),
            file_path,
            newer_on_disk,
            pending_backup: std::sync::Mutex::new(loaded.pending_backup),
            external_snapshots: Mutex::new(Vec::new()),
        };
        if persist_salvage {
            // The corrupt original is safely backed up: persist the salvaged
            // store so the file parses again and is not re-backed-up on every
            // start. Nothing else holds the in-memory lock yet, and the
            // cross-process lock is still held from the load above.
            if let Ok(defs) = store.definitions.try_lock() {
                store.save_to_disk(&defs);
            }
        }
        store
    }

    /// Create a store with a custom path (useful for testing).
    #[cfg(test)]
    pub fn new_temp(file_path: PathBuf) -> Self {
        Self {
            definitions: Mutex::new(Definitions::default()),
            file_path,
            newer_on_disk: None,
            pending_backup: std::sync::Mutex::new(None),
            external_snapshots: Mutex::new(Vec::new()),
        }
    }

    /// Get a connection by ID. Returns `None` if not found.
    pub async fn get(&self, id: &str) -> Option<ConnectionSnapshot> {
        let mut defs = self.definitions.lock().await;
        self.refresh_for_read(&mut defs);
        defs.connections.get(id).map(|c| c.snapshot())
    }

    /// Create a new connection. Returns the snapshot.
    pub async fn create(
        &self,
        mut conn: Connection,
    ) -> Result<ConnectionSnapshot, NewerVersionError> {
        conn.normalize_settings();
        let snapshot = conn.snapshot();
        self.mutate(|defs| {
            defs.connections.insert(conn.id.clone(), conn);
            (snapshot, true)
        })
        .await
    }

    /// Update an existing connection's fields. Returns `None` if not found.
    #[allow(clippy::too_many_arguments)]
    pub async fn update(
        &self,
        id: &str,
        name: Option<String>,
        session_type: Option<String>,
        config: Option<serde_json::Value>,
        persistent: Option<bool>,
        folder_id: Option<Option<String>>,
        terminal_options: Option<Option<serde_json::Value>>,
        icon: Option<Option<String>>,
    ) -> Result<Option<ConnectionSnapshot>, NewerVersionError> {
        self.mutate(|defs| {
            let Some(conn) = defs.connections.get_mut(id) else {
                return (None, false);
            };

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
            if let Some(terminal_options) = terminal_options {
                conn.terminal_options = terminal_options;
            }
            if let Some(icon) = icon {
                conn.icon = icon;
            }
            conn.normalize_settings();

            (Some(conn.snapshot()), true)
        })
        .await
    }

    /// List all connections and folders, including read-only external file connections.
    pub async fn list(&self) -> (Vec<ConnectionSnapshot>, Vec<FolderSnapshot>) {
        let mut defs = self.definitions.lock().await;
        self.refresh_for_read(&mut defs);
        let external = self.external_snapshots.lock().await;
        let mut conn_list: Vec<ConnectionSnapshot> =
            defs.connections.values().map(|c| c.snapshot()).collect();
        conn_list.extend(external.iter().cloned());
        let folder_list = defs.folders.values().map(|f| f.snapshot()).collect();
        (conn_list, folder_list)
    }

    /// Load connections from external files on the remote host.
    ///
    /// Replaces the current external connection set. Files that cannot be read
    /// or parsed are skipped with a warning.
    pub async fn load_external_files(&self, paths: &[String]) {
        let mut external = self.external_snapshots.lock().await;
        external.clear();
        for path in paths {
            match std::fs::read_to_string(path) {
                Ok(contents) => match serde_json::from_str::<StorageFormat>(&contents) {
                    Ok(storage) => {
                        info!(
                            "Loaded {} connections from external file {}",
                            storage.connections.len(),
                            path
                        );
                        for conn in storage.connections {
                            external.push(ConnectionSnapshot {
                                id: conn.id,
                                name: conn.name,
                                session_type: conn.session_type,
                                config: conn.config,
                                persistent: conn.persistent,
                                folder_id: conn.folder_id,
                                terminal_options: conn.terminal_options,
                                icon: conn.icon,
                                source_file: Some(path.clone()),
                            });
                        }
                    }
                    Err(e) => warn!("Failed to parse external connections from {}: {}", path, e),
                },
                Err(e) => warn!("Could not read external connection file {}: {}", path, e),
            }
        }
    }

    /// Delete a connection by ID. Returns `true` if found and deleted.
    pub async fn delete(&self, id: &str) -> Result<bool, NewerVersionError> {
        self.mutate(|defs| {
            let removed = defs.connections.remove(id).is_some();
            (removed, removed)
        })
        .await
    }

    /// Create a new folder. Returns the snapshot.
    pub async fn create_folder(&self, folder: Folder) -> Result<FolderSnapshot, NewerVersionError> {
        let snapshot = folder.snapshot();
        self.mutate(|defs| {
            defs.folders.insert(folder.id.clone(), folder);
            (snapshot, true)
        })
        .await
    }

    /// Update an existing folder's fields. Returns `None` if not found.
    pub async fn update_folder(
        &self,
        id: &str,
        name: Option<String>,
        parent_id: Option<Option<String>>,
        is_expanded: Option<bool>,
    ) -> Result<Option<FolderSnapshot>, NewerVersionError> {
        self.mutate(|defs| {
            let Some(folder) = defs.folders.get_mut(id) else {
                return (None, false);
            };

            if let Some(name) = name {
                folder.name = name;
            }
            if let Some(parent_id) = parent_id {
                folder.parent_id = parent_id;
            }
            if let Some(is_expanded) = is_expanded {
                folder.is_expanded = is_expanded;
            }

            (Some(folder.snapshot()), true)
        })
        .await
    }

    /// Delete a folder by ID. Moves children (connections and subfolders) to root.
    /// Returns `true` if found and deleted.
    pub async fn delete_folder(&self, id: &str) -> Result<bool, NewerVersionError> {
        self.mutate(|defs| {
            let removed = defs.folders.remove(id).is_some();
            if removed {
                // Move connections in this folder to root
                for conn in defs.connections.values_mut() {
                    if conn.folder_id.as_deref() == Some(id) {
                        conn.folder_id = None;
                    }
                }
                // Move subfolders to root
                for folder in defs.folders.values_mut() {
                    if folder.parent_id.as_deref() == Some(id) {
                        folder.parent_id = None;
                    }
                }
            }
            (removed, removed)
        })
        .await
    }

    /// Ensure a "Default Shell" connection exists if the store is empty.
    /// Call this after loading to auto-create the default on first run.
    ///
    /// On Windows it also repairs a previously auto-created "Default Shell"
    /// that still points at a Unix path such as `/bin/sh` (#3727).
    pub async fn ensure_default_shell(&self) {
        let result = self
            .mutate(|defs| {
                if !defs.connections.is_empty() {
                    let repaired =
                        cfg!(windows) && repair_unix_default_shell(defs, &detect_default_shell());
                    return ((), repaired);
                }

                let shell = detect_default_shell();
                let default_conn = Connection {
                    id: format!("conn-{}", uuid::Uuid::new_v4()),
                    name: DEFAULT_SHELL_NAME.to_string(),
                    session_type: "local".to_string(),
                    config: serde_json::json!({ "shell": shell }),
                    persistent: false,
                    folder_id: None,
                    terminal_options: None,
                    icon: None,
                    extra: serde_json::Map::new(),
                };

                info!("Creating default shell connection (shell: {})", shell);
                defs.connections
                    .insert(default_conn.id.clone(), default_conn);
                ((), true)
            })
            .await;
        if let Err(newer) = result {
            // The store looks empty only because a newer agent's file was not
            // loaded; creating a default here would overwrite it (#3920).
            warn!("Skipping default shell setup: {newer}");
        }
    }

    /// Get the default storage path: `~/.config/termihub-agent/connections.json`.
    pub fn default_path() -> PathBuf {
        let config_dir = dirs_config_dir().join("termihub-agent");
        config_dir.join("connections.json")
    }

    /// Load from disk, with migration from legacy `sessions.json`.
    ///
    /// Errors — without touching the file — when it was written by a newer
    /// agent (#3920). A corrupt file is backed up first, then every parseable
    /// entry is salvaged (#3931); see [`Loaded`].
    fn load_from_disk(path: &PathBuf) -> Result<Loaded, NewerVersionError> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let parsed = match std::str::from_utf8(&bytes) {
                    Ok(raw) => Self::parse_storage(raw)?,
                    Err(e) => Err(format!("not valid UTF-8: {e}")),
                };
                match parsed {
                    Ok(storage) => {
                        debug!(
                            "Loaded {} connections and {} folders from {}",
                            storage.connections.len(),
                            storage.folders.len(),
                            path.display()
                        );
                        return Ok(Loaded {
                            definitions: storage.into_definitions(),
                            ..Loaded::default()
                        });
                    }
                    Err(e) => return Ok(Self::recover_corrupt(path, bytes, &e)),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                // The file exists but cannot be read, so it cannot be backed up
                // either: never overwrite it until it can be (#3931).
                error!(
                    "Cannot read connections from {}: {}; saved connections are not \
                     loaded, and the file will not be overwritten until it can be \
                     backed up",
                    path.display(),
                    e
                );
                return Ok(Loaded {
                    recovered_from_corruption: true,
                    pending_backup: Some(PendingBackup::Unreadable),
                    ..Loaded::default()
                });
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
                    let connections: HashMap<String, Connection> = defs
                        .into_iter()
                        .map(|d| {
                            let mut conn = Connection {
                                id: d.id.clone(),
                                name: d.name,
                                session_type: d.session_type,
                                config: d.config,
                                persistent: d.persistent,
                                folder_id: None,
                                terminal_options: None,
                                icon: None,
                                extra: serde_json::Map::new(),
                            };
                            conn.normalize_settings();
                            (d.id, conn)
                        })
                        .collect();
                    return Ok(Loaded {
                        definitions: Definitions {
                            connections,
                            ..Definitions::default()
                        },
                        ..Loaded::default()
                    });
                }
            }
        }

        debug!("No connections file at {}", path.display());
        Ok(Loaded::default())
    }

    /// Handle a corrupt store file (#3931): back its exact bytes up, then
    /// salvage every entry that still parses.
    ///
    /// If the backup cannot be written, the salvaged data is still loaded but
    /// the backup stays pending and [`Self::save_to_disk`] refuses to overwrite
    /// the file until it succeeds.
    fn recover_corrupt(path: &Path, bytes: Vec<u8>, reason: &str) -> Loaded {
        let salvaged = std::str::from_utf8(&bytes)
            .ok()
            .and_then(Self::salvage_storage);
        let pending_backup = match store_version::backup_corrupt(path, &bytes) {
            Ok(backup) => {
                warn!(
                    "{} is corrupt ({}); the original was backed up to {}",
                    path.display(),
                    reason,
                    backup.display()
                );
                None
            }
            Err(e) => {
                error!(
                    "{} is corrupt ({}) and could not be backed up ({}); it will not \
                     be overwritten until a backup succeeds",
                    path.display(),
                    reason,
                    e
                );
                Some(PendingBackup::Bytes(bytes))
            }
        };
        let definitions = match salvaged {
            Some(defs) => {
                warn!(
                    "Salvaged {} connections and {} folders from corrupt {}",
                    defs.connections.len(),
                    defs.folders.len(),
                    path.display()
                );
                defs
            }
            None => {
                warn!(
                    "Nothing could be salvaged from corrupt {}; starting empty",
                    path.display()
                );
                Definitions::default()
            }
        };
        Loaded {
            definitions,
            recovered_from_corruption: true,
            pending_backup,
        }
    }

    /// Per-entry salvage of a store that failed a whole-file parse, mirroring
    /// the desktop's `salvage_list_store` (`src-tauri/src/utils/migrate.rs`):
    /// keep every connection and folder that parses on its own, drop (and log)
    /// the rest, and carry every other top-level key through.
    ///
    /// `None` when the file is not a JSON object at all. Only called once the
    /// version gate has passed (a newer file never reaches here).
    fn salvage_storage(raw: &str) -> Option<Definitions> {
        let value: serde_json::Value = serde_json::from_str(raw).ok()?;
        let version = store_version::read_version(&value).unwrap_or(store_version::ASSUMED_VERSION);
        let value = if version < DEFINITIONS_STORE_VERSION {
            migrate_definitions(value, version).ok()?
        } else {
            value
        };
        let serde_json::Value::Object(mut top) = value else {
            return None;
        };
        let connections =
            Self::salvage_entries::<Connection>(top.remove("connections"), "connection");
        let folders = Self::salvage_entries::<Folder>(top.remove("folders"), "folder");
        Some(
            StorageFormat {
                version: String::new(),
                connections,
                folders,
                extra: top,
            }
            .into_definitions(),
        )
    }

    /// Parse each element of a store list individually, dropping (and
    /// logging) the ones that do not parse.
    fn salvage_entries<T: serde::de::DeserializeOwned>(
        list: Option<serde_json::Value>,
        kind: &str,
    ) -> Vec<T> {
        let entries = match list {
            None | Some(serde_json::Value::Null) => return Vec::new(),
            Some(serde_json::Value::Array(entries)) => entries,
            Some(other) => {
                warn!("Dropped corrupt {kind} list (not an array): {other}");
                return Vec::new();
            }
        };
        entries
            .into_iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let label = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| entry.get("id").and_then(serde_json::Value::as_str))
                    .unwrap_or("unknown")
                    .to_string();
                match serde_json::from_value::<T>(entry) {
                    Ok(parsed) => Some(parsed),
                    Err(e) => {
                        warn!("Dropped corrupt {kind} at index {index} (\"{label}\"): {e}");
                        None
                    }
                }
            })
            .collect()
    }

    /// Make sure a corrupt store file has a copy on disk before it may be
    /// overwritten (#3931). Returns `false` — refusing the save — while the
    /// backup keeps failing.
    fn secure_pending_backup(&self) -> bool {
        let mut pending = self
            .pending_backup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let bytes = match pending.as_ref() {
            None => return true,
            Some(PendingBackup::Bytes(bytes)) => bytes.clone(),
            Some(PendingBackup::Unreadable) => match std::fs::read(&self.file_path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    *pending = None;
                    return true;
                }
                Err(e) => {
                    error!(
                        "Not saving connections: {} is still unreadable ({}) and cannot \
                         be backed up",
                        self.file_path.display(),
                        e
                    );
                    return false;
                }
            },
        };
        match store_version::backup_corrupt(&self.file_path, &bytes) {
            Ok(backup) => {
                warn!(
                    "Backed up the previous {} to {} before overwriting it",
                    self.file_path.display(),
                    backup.display()
                );
                *pending = None;
                true
            }
            Err(e) => {
                error!(
                    "Not saving connections: could not back up the corrupt {} ({})",
                    self.file_path.display(),
                    e
                );
                false
            }
        }
    }

    /// Parse the raw store: gate on its schema version, migrate an older file
    /// forward, then deserialize.
    ///
    /// The outer error is a newer-version refusal; the inner one a genuinely
    /// unreadable file.
    fn parse_storage(raw: &str) -> Result<Result<StorageFormat, String>, NewerVersionError> {
        let value: serde_json::Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(e) => return Ok(Err(e.to_string())),
        };
        let version = store_version::check_version(
            &value,
            DEFINITIONS_STORE_NAME,
            DEFINITIONS_STORE_VERSION,
        )?;
        let value = if version < DEFINITIONS_STORE_VERSION {
            match migrate_definitions(value, version) {
                Ok(value) => value,
                Err(e) => return Ok(Err(format!("migration from v{version} failed: {e}"))),
            }
        } else {
            value
        };
        Ok(serde_json::from_value(value).map_err(|e| e.to_string()))
    }

    /// Take the cross-process lock on the store file's sidecar (PER2-001).
    ///
    /// Several agent processes (`--stdio` workers, `--listen` connections)
    /// share one per-user `connections.json`; the lock serialises their
    /// read-modify-write cycles. It is an OS file lock, so a crashed holder
    /// never leaves it stale. If it cannot be taken (an unwritable config dir,
    /// say) this degrades to the unlocked behaviour with a warning rather than
    /// refusing to save.
    fn lock_store_file(path: &Path, mode: LockMode) -> Option<crate::fs::FileLock> {
        let acquired = match mode {
            LockMode::Shared => crate::fs::FileLock::acquire_shared(path),
            LockMode::Exclusive => crate::fs::FileLock::acquire(path),
        };
        match acquired {
            Ok(lock) => Some(lock),
            Err(e) => {
                warn!(
                    "Could not acquire cross-process lock for {}: {:#}; proceeding without \
                     it (a concurrent agent process could lose a saved connection)",
                    path.display(),
                    e
                );
                None
            }
        }
    }

    /// Cross-process-safe read-modify-write of the store (PER2-001).
    ///
    /// Under the in-memory lock and an exclusive file lock: re-read the file
    /// (so a peer process's saves since this store loaded are merged, not
    /// clobbered by a stale whole-store save), apply the single `delta`, and
    /// write the result atomically. `delta` returns its result and whether it
    /// changed anything; an unchanged store is not rewritten.
    ///
    /// The file lock is held only for one small file read and write, so the
    /// brief blocking wait for a peer is acceptable on the async worker.
    async fn mutate<R>(
        &self,
        delta: impl FnOnce(&mut Definitions) -> (R, bool),
    ) -> Result<R, NewerVersionError> {
        let mut defs = self.definitions.lock().await;
        // Every read of the store file happens under the file lock, so no
        // reader holds it open while a peer renames over it (windows refuses
        // to replace a file another process has open).
        let _file_lock = Self::lock_store_file(&self.file_path, LockMode::Exclusive);
        self.ensure_writable()?;
        self.refresh_from_disk(&mut defs, RefreshMode::Mutation)?;
        let (result, changed) = delta(&mut defs);
        if changed {
            self.save_to_disk(&defs);
        }
        Ok(result)
    }

    /// Bring the in-memory snapshot up to date with peer processes' saves
    /// before serving a read, under a shared file lock.
    ///
    /// Best-effort: an unreadable, corrupt or newer file leaves the in-memory
    /// snapshot as it is (the read path never backs up or rewrites anything).
    fn refresh_for_read(&self, defs: &mut Definitions) {
        if self.newer_on_disk.is_some() {
            return;
        }
        let _file_lock = Self::lock_store_file(&self.file_path, LockMode::Shared);
        if let Err(newer) = self.refresh_from_disk(defs, RefreshMode::Read) {
            debug!("Serving cached connections: {newer}");
        }
    }

    /// Replace `defs` with the store file's current contents. Call with the
    /// cross-process lock held.
    ///
    /// A missing file keeps `defs` (data migrated from a legacy file, or not
    /// yet saved, is not discarded). An unreadable file keeps `defs` too. A
    /// corrupt file is, on the mutation path only, backed up and salvaged
    /// exactly like at load (#3931). A newer agent's file is an error and
    /// leaves `defs` untouched (#3920).
    fn refresh_from_disk(
        &self,
        defs: &mut Definitions,
        mode: RefreshMode,
    ) -> Result<(), NewerVersionError> {
        let bytes = match std::fs::read(&self.file_path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                warn!(
                    "Could not re-read {}: {}; using the connections already loaded",
                    self.file_path.display(),
                    e
                );
                return Ok(());
            }
        };
        let parsed = match std::str::from_utf8(&bytes) {
            Ok(raw) => Self::parse_storage(raw)?,
            Err(e) => Err(format!("not valid UTF-8: {e}")),
        };
        match parsed {
            Ok(storage) => *defs = storage.into_definitions(),
            Err(reason) => {
                if mode == RefreshMode::Read {
                    return Ok(());
                }
                let loaded = Self::recover_corrupt(&self.file_path, bytes, &reason);
                *defs = loaded.definitions;
                if loaded.pending_backup.is_some() {
                    *self
                        .pending_backup
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = loaded.pending_backup;
                }
            }
        }
        Ok(())
    }

    /// Refuse a mutation when the store file was written by a newer agent —
    /// at load, or since (the file is re-read, so a newer agent writing it
    /// while this one runs is caught too). Called under the definitions lock
    /// **before** memory is touched, so a refused mutation changes nothing.
    fn ensure_writable(&self) -> Result<(), NewerVersionError> {
        if let Some(newer) = &self.newer_on_disk {
            return Err(newer.clone());
        }
        store_version::guard_not_newer(
            &self.file_path,
            DEFINITIONS_STORE_NAME,
            DEFINITIONS_STORE_VERSION,
        )
    }

    /// The refusal recorded when the store file was written by a newer agent.
    #[cfg(test)]
    pub fn newer_on_disk(&self) -> Option<&NewerVersionError> {
        self.newer_on_disk.as_ref()
    }

    /// Derive the legacy sessions.json path from the connections.json path.
    fn legacy_path(connections_path: &Path) -> Option<PathBuf> {
        connections_path
            .parent()
            .map(|dir| dir.join("sessions.json"))
    }

    fn save_to_disk(&self, defs: &Definitions) {
        // Last line of defence: never overwrite a newer agent's file (#3920).
        if let Err(newer) = self.ensure_writable() {
            error!("Not saving connections: {newer}");
            return;
        }
        // Never overwrite a corrupt file without a copy on disk (#3931).
        if !self.secure_pending_backup() {
            return;
        }
        let mut extra = defs.extra.clone();
        for key in STORAGE_KNOWN_KEYS {
            extra.remove(key);
        }
        let storage = StorageFormat {
            version: DEFINITIONS_STORE_VERSION.to_string(),
            connections: defs.connections.values().cloned().collect(),
            folders: defs.folders.values().cloned().collect(),
            extra,
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
                // Atomic write (temp + rename) so a crash mid-write can never
                // truncate connections.json and lose saved connections (#2366).
                if let Err(e) = crate::fs::write_atomic(&self.file_path, &json) {
                    warn!(
                        "Failed to write connections to {}: {:#}",
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

// ── ConnectionStoreApi impl ────────────────────────────────────────

#[async_trait::async_trait]
impl ConnectionStoreApi for ConnectionStore {
    async fn get(&self, id: &str) -> Option<ConnectionSnapshot> {
        ConnectionStore::get(self, id).await
    }

    async fn create(&self, conn: Connection) -> Result<ConnectionSnapshot, NewerVersionError> {
        ConnectionStore::create(self, conn).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn update(
        &self,
        id: &str,
        name: Option<String>,
        session_type: Option<String>,
        config: Option<serde_json::Value>,
        persistent: Option<bool>,
        folder_id: Option<Option<String>>,
        terminal_options: Option<Option<serde_json::Value>>,
        icon: Option<Option<String>>,
    ) -> Result<Option<ConnectionSnapshot>, NewerVersionError> {
        ConnectionStore::update(
            self,
            id,
            name,
            session_type,
            config,
            persistent,
            folder_id,
            terminal_options,
            icon,
        )
        .await
    }

    async fn list(&self) -> (Vec<ConnectionSnapshot>, Vec<FolderSnapshot>) {
        ConnectionStore::list(self).await
    }

    async fn delete(&self, id: &str) -> Result<bool, NewerVersionError> {
        ConnectionStore::delete(self, id).await
    }

    async fn create_folder(&self, folder: Folder) -> Result<FolderSnapshot, NewerVersionError> {
        ConnectionStore::create_folder(self, folder).await
    }

    async fn update_folder(
        &self,
        id: &str,
        name: Option<String>,
        parent_id: Option<Option<String>>,
        is_expanded: Option<bool>,
    ) -> Result<Option<FolderSnapshot>, NewerVersionError> {
        ConnectionStore::update_folder(self, id, name, parent_id, is_expanded).await
    }

    async fn delete_folder(&self, id: &str) -> Result<bool, NewerVersionError> {
        ConnectionStore::delete_folder(self, id).await
    }

    async fn load_external_files(&self, paths: &[String]) {
        ConnectionStore::load_external_files(self, paths).await
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

/// Detect the system's default shell as an executable path.
///
/// On Windows: PowerShell 7 (`pwsh.exe`) on `PATH`, then Windows PowerShell,
/// then `cmd.exe` via `%COMSPEC%` — the shared selection in
/// [`termihub_core::session::shell::detect_windows_default_shell`] (#3727).
/// Elsewhere: `$SHELL`, then `/bin/bash`, `/bin/sh`, `/bin/zsh`.
fn detect_default_shell() -> String {
    #[cfg(windows)]
    {
        termihub_core::session::shell::detect_windows_default_shell()
    }
    #[cfg(not(windows))]
    {
        select_unix_default_shell(std::env::var("SHELL").ok().as_deref(), |p| {
            Path::new(p).exists()
        })
    }
}

/// Unix default-shell selection with an injectable existence probe:
/// `$SHELL` if it exists, then the first existing well-known path, else
/// `/bin/sh`.
#[cfg_attr(windows, allow(dead_code))]
fn select_unix_default_shell(shell_env: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(shell) = shell_env.filter(|s| exists(s)) {
        return shell.to_string();
    }
    ["/bin/bash", "/bin/sh", "/bin/zsh"]
        .into_iter()
        .find(|c| exists(c))
        .unwrap_or("/bin/sh")
        .to_string()
}

/// Name of the connection [`ConnectionStore::ensure_default_shell`] creates.
const DEFAULT_SHELL_NAME: &str = "Default Shell";

/// Repair an auto-created "Default Shell" whose shell is a Unix path on a host
/// that cannot run it (#3727: Windows agents used to persist `/bin/sh`).
///
/// Only the auto-created entry is touched — a local connection named
/// [`DEFAULT_SHELL_NAME`] whose `config.shell` is a string starting with `/` —
/// and it is rewritten to `detected`. Returns whether anything changed. The
/// caller decides when the host is one where Unix paths are invalid (Windows).
fn repair_unix_default_shell(defs: &mut Definitions, detected: &str) -> bool {
    let mut changed = false;
    for conn in defs.connections.values_mut() {
        let is_local = matches!(conn.session_type.as_str(), "local" | "shell");
        if !is_local || conn.name != DEFAULT_SHELL_NAME {
            continue;
        }
        let stale = conn
            .config
            .get("shell")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.starts_with('/'));
        if !stale {
            continue;
        }
        if let Some(obj) = conn.config.as_object_mut() {
            info!(
                "Repairing default shell connection {} ({:?} -> {})",
                conn.id,
                obj.get("shell"),
                detected
            );
            obj.insert("shell".to_string(), serde_json::json!(detected));
            changed = true;
        }
    }
    changed
}

/// Platform user-config directory used as the parent for `termihub-agent/`.
///
/// Honors `XDG_CONFIG_HOME` first on every platform (used by integration
/// tests and portable setups to redirect the agent's state to a sandbox).
/// Otherwise delegates to the `dirs` crate: `$HOME/.config` on Linux,
/// `~/Library/Application Support` on macOS, and `%APPDATA%` (Roaming) on
/// Windows. Falls back to relative `.config` only if the platform has no
/// resolvable user-config directory.
fn dirs_config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg);
        }
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".config"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn dirs_config_dir_returns_absolute_path() {
        // Regression test for #764: the agent's connection-storage config
        // directory must resolve to an absolute path on every platform
        // (including Windows), not the relative ".config" fallback.
        let dir = dirs_config_dir();
        assert!(
            dir.is_absolute(),
            "dirs_config_dir must be absolute, got {}",
            dir.display()
        );
    }

    #[test]
    fn default_path_is_absolute_and_ends_in_connections_json() {
        let path = ConnectionStore::default_path();
        assert!(
            path.is_absolute(),
            "default_path must be absolute, got {}",
            path.display()
        );
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some("connections.json")
        );
    }

    fn make_connection(id: &str, name: &str, persistent: bool) -> Connection {
        Connection {
            id: id.to_string(),
            name: name.to_string(),
            session_type: "shell".to_string(),
            config: json!({"shell": "/bin/bash"}),
            persistent,
            folder_id: None,
            terminal_options: None,
            icon: None,
            extra: Default::default(),
        }
    }

    fn make_folder(id: &str, name: &str, parent_id: Option<&str>) -> Folder {
        Folder {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: parent_id.map(|s| s.to_string()),
            is_expanded: false,
            extra: Default::default(),
        }
    }

    // ── Legacy reconnect key (PARITY-008) ───────────────────────────

    /// A definition persisted by an older agent with the legacy
    /// `resilientReconnect` key loads under the unified `autoReconnect` key with
    /// the explicit value preserved, and the next save writes only the new key.
    #[tokio::test]
    async fn legacy_resilient_reconnect_key_is_read_and_rewritten() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        fs::write(
            &path,
            json!({
                "connections": [{
                    "id": "c1", "name": "ssh", "session_type": "ssh",
                    "config": { "host": "h", "resilientReconnect": false }
                }],
                "folders": []
            })
            .to_string(),
        )
        .unwrap();

        let store = ConnectionStore::new(path.clone());
        let snap = store.get("c1").await.unwrap();
        assert_eq!(snap.config, json!({ "host": "h", "autoReconnect": false }));

        store
            .update(
                "c1",
                Some("renamed".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("\"autoReconnect\": false") || raw.contains("\"autoReconnect\":false")
        );
        assert!(!raw.contains("resilientReconnect"));
    }

    // ── Legacy FTP connect-timeout key (#2901) ──────────────────────

    /// An FTP definition persisted with the legacy `timeoutSecs` key loads under
    /// the unified `connectTimeoutSecs` key with the user's value intact (so the
    /// agent's schema-keyed form pre-populates it), and the next save writes only
    /// the new key. A non-FTP type's own `timeoutSecs` is never touched.
    #[tokio::test]
    async fn legacy_ftp_timeout_key_is_read_and_rewritten() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        fs::write(
            &path,
            json!({
                "connections": [
                    {
                        "id": "f1", "name": "ftp", "session_type": "ftp",
                        "config": { "host": "h", "timeoutSecs": 45 }
                    },
                    {
                        "id": "p1", "name": "plugin", "session_type": "plugin:acme:thing",
                        "config": { "timeoutSecs": 7 }
                    }
                ],
                "folders": []
            })
            .to_string(),
        )
        .unwrap();

        let store = ConnectionStore::new(path.clone());
        let snap = store.get("f1").await.unwrap();
        assert_eq!(
            snap.config,
            json!({ "host": "h", "connectTimeoutSecs": 45 })
        );
        let plugin = store.get("p1").await.unwrap();
        assert_eq!(plugin.config, json!({ "timeoutSecs": 7 }));

        store
            .update(
                "f1",
                Some("renamed".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).expect("valid json on disk");
        let conns = raw["connections"].as_array().unwrap();
        let ftp = conns.iter().find(|c| c["id"] == "f1").unwrap();
        assert_eq!(
            ftp["config"],
            json!({ "host": "h", "connectTimeoutSecs": 45 })
        );
        let plugin = conns.iter().find(|c| c["id"] == "p1").unwrap();
        assert_eq!(plugin["config"], json!({ "timeoutSecs": 7 }));
    }

    /// Create/update requests carrying the legacy FTP key (e.g. from a desktop
    /// using an older agent schema) are stored under the unified key.
    #[tokio::test]
    async fn create_and_update_normalize_legacy_ftp_timeout_key() {
        let tmp = TempDir::new().unwrap();
        let store = ConnectionStore::new_temp(tmp.path().join("connections.json"));

        let created = store
            .create(Connection {
                id: "f1".into(),
                name: "ftp".into(),
                session_type: "ftp".into(),
                config: json!({ "host": "h", "timeoutSecs": 45 }),
                persistent: false,
                folder_id: None,
                terminal_options: None,
                icon: None,
                extra: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(
            created.config,
            json!({ "host": "h", "connectTimeoutSecs": 45 })
        );

        let updated = store
            .update(
                "f1",
                None,
                None,
                Some(json!({ "host": "h", "timeoutSecs": 60 })),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            updated.config,
            json!({ "host": "h", "connectTimeoutSecs": 60 })
        );
        assert_eq!(
            store.get("f1").await.unwrap().config,
            json!({ "host": "h", "connectTimeoutSecs": 60 })
        );
    }

    /// External connection files on the agent host are normalized the same way.
    #[tokio::test]
    async fn external_file_legacy_ftp_timeout_key_is_normalized() {
        let tmp = TempDir::new().unwrap();
        let store = ConnectionStore::new_temp(tmp.path().join("connections.json"));
        let ext = tmp.path().join("external.json");
        fs::write(
            &ext,
            json!({
                "connections": [{
                    "id": "x1", "name": "ftp", "session_type": "ftp",
                    "config": { "timeoutSecs": 45 }
                }],
                "folders": []
            })
            .to_string(),
        )
        .unwrap();
        store
            .load_external_files(&[ext.to_string_lossy().into_owned()])
            .await;
        let (conns, _) = store.list().await;
        let x = conns.iter().find(|c| c.id == "x1").unwrap();
        assert_eq!(x.config, json!({ "connectTimeoutSecs": 45 }));
    }

    // ── Connection CRUD ─────────────────────────────────────────────

    #[tokio::test]
    async fn get_connection() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create(make_connection("conn-1", "Shell", true))
            .await
            .unwrap();

        let snap = store.get("conn-1").await;
        assert!(snap.is_some());
        let snap = snap.unwrap();
        assert_eq!(snap.id, "conn-1");
        assert_eq!(snap.name, "Shell");
        assert!(snap.persistent);

        assert!(store.get("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn create_and_list() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        let conn = make_connection("conn-1", "Build Shell", true);
        let snapshot = store.create(conn).await.unwrap();
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

        store
            .create(make_connection("conn-1", "Old", false))
            .await
            .unwrap();

        let updated = store
            .update(
                "conn-1",
                Some("New".to_string()),
                None,
                None,
                Some(true),
                None,
                None,
                None,
            )
            .await
            .unwrap();
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
                None,
                None,
            )
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn update_connection_folder_id() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create(make_connection("conn-1", "Shell", false))
            .await
            .unwrap();
        store
            .create_folder(make_folder("folder-1", "My Folder", None))
            .await
            .unwrap();

        // Move to folder
        let snap = store
            .update(
                "conn-1",
                None,
                None,
                None,
                None,
                Some(Some("folder-1".to_string())),
                None,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snap.folder_id, Some("folder-1".to_string()));

        // Move back to root
        let snap = store
            .update("conn-1", None, None, None, None, Some(None), None, None)
            .await
            .unwrap()
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
            .await
            .unwrap();
        assert!(store.delete("conn-1").await.unwrap());

        let (conns, _) = store.list().await;
        assert!(conns.is_empty());
    }

    #[tokio::test]
    async fn delete_connection_not_found() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        assert!(!store.delete("nonexistent").await.unwrap());
    }

    // ── Folder CRUD ─────────────────────────────────────────────────

    #[tokio::test]
    async fn create_and_list_folders() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        let folder = make_folder("folder-1", "Project A", None);
        let snapshot = store.create_folder(folder).await.unwrap();
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
            .await
            .unwrap();

        let updated = store
            .update_folder("folder-1", Some("New Name".to_string()), None, Some(true))
            .await
            .unwrap();
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
            .await
            .unwrap();
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
            .await
            .unwrap();
        store
            .create_folder(make_folder("folder-2", "Child", Some("folder-1")))
            .await
            .unwrap();

        let mut conn = make_connection("conn-1", "Shell", false);
        conn.folder_id = Some("folder-1".to_string());
        store.create(conn).await.unwrap();

        // Delete parent folder
        assert!(store.delete_folder("folder-1").await.unwrap());

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

        assert!(!store.delete_folder("nonexistent").await.unwrap());
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
                .await
                .unwrap();
            store
                .create(make_connection("conn-2", "Shell 2", false))
                .await
                .unwrap();
            store
                .create_folder(make_folder("folder-1", "Folder", None))
                .await
                .unwrap();
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

    // ── Corrupt-file backup + salvage, unknown-field round-trip (#3931) ──

    /// Every `connections.json.bak*` backup next to `path`, sorted.
    fn corrupt_backups(path: &Path) -> Vec<PathBuf> {
        let dir = path.parent().unwrap();
        let prefix = format!("{}.bak", path.file_name().unwrap().to_str().unwrap());
        let mut found: Vec<PathBuf> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&prefix))
            })
            .collect();
        found.sort();
        found
    }

    /// Read the store file back as untyped JSON.
    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    /// A store entry by id from the raw file.
    fn raw_entry<'a>(file: &'a serde_json::Value, list: &str, id: &str) -> &'a serde_json::Value {
        file[list]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == json!(id))
            .unwrap_or_else(|| panic!("{list} entry {id} missing from {file}"))
    }

    /// A corrupt file is copied aside, byte-for-byte, before startup's
    /// `ensure_default_shell` rewrites it — previously the saved connections
    /// were silently wiped with no copy kept.
    #[tokio::test]
    async fn corrupt_file_is_backed_up_before_default_shell_overwrites_it() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let original = "{\"connections\": [{\"id\": \"conn-1\", \"name\": \"Prod\"";
        fs::write(&path, original).unwrap();

        let store = ConnectionStore::new(path.clone());
        store.ensure_default_shell().await;

        let backups = corrupt_backups(&path);
        assert_eq!(backups.len(), 1, "expected exactly one backup");
        assert_eq!(fs::read_to_string(&backups[0]).unwrap(), original);
        // The live file is valid again (default shell seeded after the backup).
        let file = read_json(&path);
        assert_eq!(file["connections"].as_array().unwrap().len(), 1);
    }

    /// A file that is not even UTF-8 is still backed up rather than treated
    /// as missing and overwritten.
    #[tokio::test]
    async fn non_utf8_file_is_backed_up_before_overwrite() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let original: &[u8] = &[0xff, 0xfe, b'{', 0x00, 0x9f];
        fs::write(&path, original).unwrap();

        let store = ConnectionStore::new(path.clone());
        store.ensure_default_shell().await;

        let backups = corrupt_backups(&path);
        assert_eq!(backups.len(), 1, "expected exactly one backup");
        assert_eq!(fs::read(&backups[0]).unwrap(), original);
    }

    /// A second corruption never overwrites the first backup.
    #[tokio::test]
    async fn repeated_corruption_keeps_every_backup() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");

        fs::write(&path, "first corrupt").unwrap();
        ConnectionStore::new(path.clone())
            .ensure_default_shell()
            .await;
        fs::write(&path, "second corrupt").unwrap();
        ConnectionStore::new(path.clone())
            .ensure_default_shell()
            .await;

        let contents: Vec<String> = corrupt_backups(&path)
            .iter()
            .map(|p| fs::read_to_string(p).unwrap())
            .collect();
        assert_eq!(contents.len(), 2, "{contents:?}");
        assert!(contents.contains(&"first corrupt".to_string()));
        assert!(contents.contains(&"second corrupt".to_string()));
    }

    /// A readable file with one bad entry keeps every parseable connection and
    /// folder (mirroring the desktop's per-entry salvage), and backs the
    /// original up so the dropped entry is not lost either.
    #[tokio::test]
    async fn corrupt_entry_is_dropped_and_the_rest_salvaged() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let original = json!({
            "version": "1",
            "connections": [
                {"id": "conn-good", "name": "Good", "session_type": "shell"},
                {"id": "conn-bad", "name": 42, "session_type": "shell"},
                {"id": "conn-good-2", "name": "Good 2", "session_type": "ssh"}
            ],
            "folders": [
                {"id": "folder-good", "name": "Work"},
                {"id": "folder-bad"}
            ]
        })
        .to_string();
        fs::write(&path, &original).unwrap();

        let store = ConnectionStore::new(path.clone());
        store.ensure_default_shell().await;

        let (conns, folders) = store.list().await;
        let mut ids: Vec<&str> = conns.iter().map(|c| c.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["conn-good", "conn-good-2"]);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, "folder-good");

        let backups = corrupt_backups(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(&backups[0]).unwrap(), original);
    }

    /// A store file that exists but cannot be read is never overwritten while
    /// it stays unreadable; once readable it is backed up before the save.
    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_file_is_not_overwritten_until_backed_up() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let original = r#"{"connections":[{"id":"c","name":"Kept","session_type":"shell"}]}"#;
        fs::write(&path, original).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&path).is_ok() {
            // Running as root: permissions do not block reads, nothing to test.
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            return;
        }

        let store = ConnectionStore::new(path.clone());
        store.ensure_default_shell().await;
        store
            .create(make_connection("conn-new", "New", false))
            .await
            .unwrap();

        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(corrupt_backups(&path).is_empty());

        // Readable again: the next save backs the original up first.
        store
            .create(make_connection("conn-new-2", "New 2", false))
            .await
            .unwrap();
        let backups = corrupt_backups(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(&backups[0]).unwrap(), original);
    }

    /// Unknown top-level and per-entry fields survive a load + save, and are
    /// not leaked onto the wire snapshot.
    #[tokio::test]
    async fn unknown_fields_survive_a_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        fs::write(
            &path,
            json!({
                "version": "1",
                "futureTopLevel": {"keep": true},
                "connections": [{
                    "id": "conn-1",
                    "name": "Prod",
                    "session_type": "shell",
                    "config": {"shell": "/bin/bash"},
                    "futureConnField": [1, 2, 3]
                }],
                "folders": [{
                    "id": "folder-1",
                    "name": "Work",
                    "futureFolderField": "x"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let store = ConnectionStore::new(path.clone());
        // Mutate both entries so both are re-serialized from memory.
        store
            .update(
                "conn-1",
                Some("Prod renamed".to_string()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap()
            .unwrap();
        store
            .update_folder("folder-1", Some("Work renamed".to_string()), None, None)
            .await
            .unwrap()
            .unwrap();

        let file = read_json(&path);
        assert_eq!(file["futureTopLevel"], json!({"keep": true}));
        assert_eq!(file["version"], json!("1"));
        let conn = raw_entry(&file, "connections", "conn-1");
        assert_eq!(conn["name"], json!("Prod renamed"));
        assert_eq!(conn["futureConnField"], json!([1, 2, 3]));
        let folder = raw_entry(&file, "folders", "folder-1");
        assert_eq!(folder["name"], json!("Work renamed"));
        assert_eq!(folder["futureFolderField"], json!("x"));

        // Wire shape unchanged: unknown fields stay on disk only.
        let (conns, folders) = store.list().await;
        let wire_conn = serde_json::to_value(&conns[0]).unwrap();
        assert!(wire_conn.get("futureConnField").is_none(), "{wire_conn}");
        let wire_folder = serde_json::to_value(&folders[0]).unwrap();
        assert!(
            wire_folder.get("futureFolderField").is_none(),
            "{wire_folder}"
        );

        // And a reload + save keeps them too (no duplicate `version` key).
        let reloaded = ConnectionStore::new(path.clone());
        reloaded
            .create(make_connection("conn-2", "Other", false))
            .await
            .unwrap();
        let file = read_json(&path);
        assert_eq!(file["futureTopLevel"], json!({"keep": true}));
        assert_eq!(
            raw_entry(&file, "connections", "conn-1")["futureConnField"],
            json!([1, 2, 3])
        );
        assert_eq!(file["version"], json!("1"));
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
        assert_eq!(conns[0].session_type, "local");
        assert!(conns[0].id.starts_with("conn-"));
    }

    #[tokio::test]
    async fn ensure_default_shell_skips_when_not_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);

        store
            .create(make_connection("conn-1", "Existing", false))
            .await
            .unwrap();
        store.ensure_default_shell().await;

        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].name, "Existing");
    }

    // ── Default shell selection / repair (#3727) ───────────────────

    #[test]
    fn unix_default_prefers_existing_shell_env() {
        let pick = select_unix_default_shell(Some("/usr/bin/fish"), |_| true);
        assert_eq!(pick, "/usr/bin/fish");
    }

    #[test]
    fn unix_default_skips_missing_shell_env() {
        let pick = select_unix_default_shell(Some("/nope/zsh"), |p| p == "/bin/sh");
        assert_eq!(pick, "/bin/sh");
        let pick = select_unix_default_shell(None, |p| p == "/bin/bash" || p == "/bin/sh");
        assert_eq!(pick, "/bin/bash");
    }

    #[test]
    fn unix_default_last_resort_is_bin_sh() {
        assert_eq!(select_unix_default_shell(None, |_| false), "/bin/sh");
    }

    #[test]
    fn detect_default_shell_matches_host_platform() {
        let shell = detect_default_shell();
        if cfg!(windows) {
            let lower = shell.to_ascii_lowercase();
            assert!(!shell.starts_with('/'), "unix shell on Windows: {shell}");
            assert!(
                lower.ends_with("pwsh.exe")
                    || lower.ends_with("powershell.exe")
                    || lower.ends_with("cmd.exe"),
                "unexpected Windows default shell: {shell}"
            );
        } else {
            assert!(shell.starts_with('/'), "expected a unix path, got {shell}");
        }
    }

    fn defs_with(conns: Vec<Connection>) -> Definitions {
        Definitions {
            connections: conns.into_iter().map(|c| (c.id.clone(), c)).collect(),
            folders: HashMap::new(),
            extra: Default::default(),
        }
    }

    fn default_shell_conn(id: &str, session_type: &str, shell: &str) -> Connection {
        Connection {
            session_type: session_type.to_string(),
            config: json!({ "shell": shell, "persistent": false }),
            ..make_connection(id, DEFAULT_SHELL_NAME, false)
        }
    }

    const PWSH: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";

    #[test]
    fn repair_rewrites_stale_unix_default_shell() {
        let mut defs = defs_with(vec![
            default_shell_conn("conn-a", "local", "/bin/sh"),
            default_shell_conn("conn-b", "shell", "/bin/bash"),
        ]);
        assert!(repair_unix_default_shell(&mut defs, PWSH));
        for id in ["conn-a", "conn-b"] {
            let conn = &defs.connections[id];
            assert_eq!(conn.config["shell"], json!(PWSH));
            // Other config keys survive.
            assert_eq!(conn.config["persistent"], json!(false));
        }
    }

    #[test]
    fn repair_leaves_windows_default_and_user_connections_alone() {
        let mut user = make_connection("conn-user", "My Bash", false);
        user.config = json!({ "shell": "/bin/sh" });
        let mut defs = defs_with(vec![
            default_shell_conn("conn-ok", "local", PWSH),
            user,
            default_shell_conn("conn-ssh", "ssh", "/bin/sh"),
        ]);
        assert!(!repair_unix_default_shell(&mut defs, PWSH));
        assert_eq!(defs.connections["conn-ok"].config["shell"], json!(PWSH));
        assert_eq!(
            defs.connections["conn-user"].config["shell"],
            json!("/bin/sh")
        );
        assert_eq!(
            defs.connections["conn-ssh"].config["shell"],
            json!("/bin/sh")
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ensure_default_shell_repairs_stale_entry_on_windows() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);
        store
            .create(default_shell_conn("conn-1", "local", "/bin/sh"))
            .await
            .unwrap();

        store.ensure_default_shell().await;

        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        let shell = conns[0].config["shell"].as_str().unwrap().to_string();
        assert!(!shell.starts_with('/'), "still a unix shell: {shell}");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn ensure_default_shell_keeps_unix_entry_off_windows() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);
        store
            .create(default_shell_conn("conn-1", "local", "/bin/sh"))
            .await
            .unwrap();

        store.ensure_default_shell().await;

        let (conns, _) = store.list().await;
        assert_eq!(conns[0].config["shell"], json!("/bin/sh"));
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
            terminal_options: None,
            icon: None,
            extra: Default::default(),
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
            extra: Default::default(),
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

    // ── Wire snapshot bytes (DUP-001) ────────────────────────────────
    //
    // `ConnectionSnapshot`/`FolderSnapshot` are now the shared core wire DTOs
    // (`ConnectionDefinition`/`FolderDefinition`) re-exported under their old
    // names. These pin that `Connection::snapshot()`/`Folder::snapshot()` still
    // emit byte-identical wire — the desktop parses these exact bytes, so a
    // change here is a WIRE BREAK.

    #[test]
    fn connection_snapshot_emits_stable_wire_bytes() {
        let conn = Connection {
            id: "conn-1".to_string(),
            name: "Build Shell".to_string(),
            session_type: "shell".to_string(),
            config: json!({ "shell": "/bin/bash" }),
            persistent: true,
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
            icon: None,
            extra: Default::default(),
        };
        assert_eq!(
            serde_json::to_string(&conn.snapshot()).unwrap(),
            r#"{"id":"conn-1","name":"Build Shell","session_type":"shell","config":{"shell":"/bin/bash"},"persistent":true,"folder_id":"folder-1"}"#
        );
    }

    #[test]
    fn folder_snapshot_emits_stable_wire_bytes() {
        let folder = Folder {
            id: "folder-abc".to_string(),
            name: "Production".to_string(),
            parent_id: Some("folder-root".to_string()),
            is_expanded: true,
            extra: Default::default(),
        };
        assert_eq!(
            serde_json::to_string(&folder.snapshot()).unwrap(),
            r#"{"id":"folder-abc","name":"Production","parent_id":"folder-root","is_expanded":true}"#
        );
    }

    // ── External files ──────────────────────────────────────────────

    #[tokio::test]
    async fn load_external_files_merges_connections_with_source_tag() {
        let tmp = TempDir::new().unwrap();
        let primary_path = tmp.path().join("connections.json");
        let external_path = tmp.path().join("external.json");

        let external_data = json!({
            "connections": [
                {
                    "id": "ext-1",
                    "name": "External Shell",
                    "session_type": "local",
                    "config": {},
                    "persistent": false
                }
            ],
            "folders": []
        });
        fs::write(
            &external_path,
            serde_json::to_string(&external_data).unwrap(),
        )
        .unwrap();

        let store = ConnectionStore::new_temp(primary_path);
        store
            .create(make_connection("primary-1", "Primary Shell", false))
            .await
            .unwrap();

        // Before loading, only primary connection is listed
        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].source_file, None);

        // Load external file
        let ext_path_str = external_path.to_string_lossy().to_string();
        store
            .load_external_files(std::slice::from_ref(&ext_path_str))
            .await;

        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 2);

        let ext = conns.iter().find(|c| c.id == "ext-1").unwrap();
        assert_eq!(ext.name, "External Shell");
        assert_eq!(ext.source_file, Some(ext_path_str));

        let primary = conns.iter().find(|c| c.id == "primary-1").unwrap();
        assert_eq!(primary.source_file, None);
    }

    #[tokio::test]
    async fn load_external_files_replaces_previous_set() {
        let tmp = TempDir::new().unwrap();
        let primary_path = tmp.path().join("connections.json");
        let file_a = tmp.path().join("a.json");
        let file_b = tmp.path().join("b.json");

        let make_ext = |id: &str, name: &str| {
            json!({
                "connections": [{"id": id, "name": name, "session_type": "local", "config": {}, "persistent": false}],
                "folders": []
            })
        };
        fs::write(
            &file_a,
            serde_json::to_string(&make_ext("a-1", "A")).unwrap(),
        )
        .unwrap();
        fs::write(
            &file_b,
            serde_json::to_string(&make_ext("b-1", "B")).unwrap(),
        )
        .unwrap();

        let store = ConnectionStore::new_temp(primary_path);

        store
            .load_external_files(&[file_a.to_string_lossy().to_string()])
            .await;
        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].id, "a-1");

        // Loading again replaces the previous external set
        store
            .load_external_files(&[file_b.to_string_lossy().to_string()])
            .await;
        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].id, "b-1");
    }

    #[tokio::test]
    async fn load_external_files_skips_missing_file() {
        let tmp = TempDir::new().unwrap();
        let primary_path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(primary_path);

        store
            .load_external_files(&["/nonexistent/path.json".to_string()])
            .await;

        let (conns, _) = store.list().await;
        assert!(conns.is_empty());
    }

    // ── Concurrency (AB-BA deadlock regression, CONC-001 / TBE-008) ──

    /// Regression test for CONC-001: the store used to hold two independent
    /// mutexes locked in opposite orders across methods
    /// (`create`: connections→folders; `create_folder`: folders→connections),
    /// each holding the first guard across the second `.lock().await`. Two
    /// concurrent client RPCs — one of each group — could park forever in a
    /// classic AB-BA deadlock. This is invisible to single-client tests
    /// (TBE-008); it needs ≥2 tasks contending on one shared store on a
    /// multi-thread runtime.
    ///
    /// The test drives the previously-opposite-order operations concurrently
    /// many times under a watchdog timeout: against the OLD two-mutex code it
    /// hangs (→ timeout failure); with the single-lock fix all operations
    /// complete. `flavor = "multi_thread"` ensures the tasks run in parallel so
    /// the lock interleaving can actually occur.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_mixed_ops_do_not_deadlock() {
        use std::sync::Arc;
        use tokio::time::{timeout, Duration};

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = Arc::new(ConnectionStore::new_temp(path));

        // Number of concurrent contenders per operation group. A handful of
        // interleaved connections→folders vs folders→connections acquisitions
        // is enough to hit the AB-BA window with high probability.
        const N: usize = 64;

        let run = async {
            let mut handles = Vec::new();

            for i in 0..N {
                // Group A: create (locks connections, then folders).
                let store_a = Arc::clone(&store);
                handles.push(tokio::spawn(async move {
                    store_a
                        .create(make_connection(&format!("conn-{i}"), "Shell", false))
                        .await
                        .unwrap();
                }));

                // Group B: create_folder (locked folders, then connections).
                let store_b = Arc::clone(&store);
                handles.push(tokio::spawn(async move {
                    store_b
                        .create_folder(make_folder(&format!("folder-{i}"), "Folder", None))
                        .await
                        .unwrap();
                }));

                // Group B: delete_folder (also folders→connections, and mutates
                // both maps) contending against the group-A creates.
                let store_c = Arc::clone(&store);
                handles.push(tokio::spawn(async move {
                    store_c.delete_folder(&format!("folder-{i}")).await.unwrap();
                }));

                // Group A: list (locks connections then folders) — read side.
                let store_d = Arc::clone(&store);
                handles.push(tokio::spawn(async move {
                    let _ = store_d.list().await;
                }));
            }

            for h in handles {
                h.await.expect("task panicked");
            }
        };

        // If the store deadlocks, these tasks never finish and the timeout
        // fires — turning a hang into a deterministic test failure.
        timeout(Duration::from_secs(30), run)
            .await
            .expect("connection-store operations deadlocked (AB-BA lock-order inversion)");

        // Sanity: all connections were created and no lock was left poisoned.
        let (conns, _) = store.list().await;
        assert_eq!(conns.len(), N);
    }

    #[tokio::test]
    async fn primary_connections_have_no_source_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new_temp(path);
        store
            .create(make_connection("conn-1", "Shell", false))
            .await
            .unwrap();

        let (conns, _) = store.list().await;
        assert_eq!(conns[0].source_file, None);
    }

    // ── Schema version + downgrade safety (#3920) ───────────────────

    /// A `connections.json` written by a newer agent: a future schema version,
    /// a connection, a folder, and a key this agent does not know.
    fn newer_version_file() -> String {
        serde_json::to_string_pretty(&json!({
            "version": "99",
            "connections": [{
                "id": "conn-future",
                "name": "Future",
                "session_type": "ftp",
                "config": {"host": "h", "futureKey": 42},
                "persistent": false
            }],
            "folders": [{"id": "folder-future", "name": "F", "parent_id": null}],
            "futureTopLevel": {"keep": true}
        }))
        .unwrap()
    }

    /// Load of a newer file never touches it — not on load, not when the
    /// default shell would be auto-created on an "empty" store.
    #[tokio::test]
    async fn newer_version_file_is_left_intact_on_load() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let original = newer_version_file();
        fs::write(&path, &original).unwrap();

        let store = ConnectionStore::new(path.clone());
        store.ensure_default_shell().await;

        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let refusal = store.newer_on_disk().expect("newer file must be flagged");
        assert_eq!(refusal.found, 99);
        assert_eq!(refusal.supported, DEFINITIONS_STORE_VERSION);
    }

    /// Every mutation over a newer file is refused with a clear error and
    /// leaves both the file and the in-memory store untouched.
    #[tokio::test]
    async fn newer_version_file_refuses_every_mutation() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let original = newer_version_file();
        fs::write(&path, &original).unwrap();
        let store = ConnectionStore::new(path.clone());

        let err = store
            .create(make_connection("conn-1", "Shell", false))
            .await
            .unwrap_err();
        assert_eq!(err.found, 99);
        assert!(err.to_string().contains("newer version"), "{err}");

        assert!(store
            .update(
                "conn-future",
                Some("x".into()),
                None,
                None,
                None,
                None,
                None,
                None
            )
            .await
            .is_err());
        assert!(store.delete("conn-future").await.is_err());
        assert!(store
            .create_folder(make_folder("folder-1", "F", None))
            .await
            .is_err());
        assert!(store
            .update_folder("folder-future", Some("x".into()), None, None)
            .await
            .is_err());
        assert!(store.delete_folder("folder-future").await.is_err());

        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(store.get("conn-1").await.is_none());
    }

    /// A newer agent writing the file *after* this store loaded is still
    /// protected: the save re-reads the file's version before overwriting.
    #[tokio::test]
    async fn save_refuses_to_overwrite_a_file_that_became_newer() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let store = ConnectionStore::new(path.clone());
        store
            .create(make_connection("conn-1", "Shell", false))
            .await
            .unwrap();

        let newer = newer_version_file();
        fs::write(&path, &newer).unwrap();

        assert!(store
            .create(make_connection("conn-2", "Shell 2", false))
            .await
            .is_err());
        assert!(store.delete("conn-1").await.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), newer);
        assert!(
            store.get("conn-2").await.is_none(),
            "memory must not diverge"
        );
        assert!(
            store.get("conn-1").await.is_some(),
            "memory must not diverge"
        );
    }

    /// A legacy, unversioned file loads as the baseline version, and the next
    /// save stamps the current version.
    #[tokio::test]
    async fn unversioned_file_loads_as_baseline_and_save_writes_version() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        fs::write(
            &path,
            serde_json::to_string(&json!({
                "connections": [{
                    "id": "conn-old",
                    "name": "Old",
                    "session_type": "shell",
                    "config": {"shell": "/bin/sh"},
                    "persistent": false
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let store = ConnectionStore::new(path.clone());
        assert!(store.newer_on_disk().is_none());
        assert!(store.get("conn-old").await.is_some());

        store
            .create(make_connection("conn-new", "New", false))
            .await
            .unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk["version"],
            json!(DEFINITIONS_STORE_VERSION.to_string())
        );
        assert_eq!(on_disk["connections"].as_array().unwrap().len(), 2);
    }

    /// A current-version file (version as string or number) round-trips.
    #[tokio::test]
    async fn current_version_file_loads_as_string_or_number() {
        for version in [
            json!(DEFINITIONS_STORE_VERSION.to_string()),
            json!(DEFINITIONS_STORE_VERSION),
        ] {
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join("connections.json");
            fs::write(
                &path,
                serde_json::to_string(&json!({
                    "version": version,
                    "connections": [{
                        "id": "conn-1",
                        "name": "One",
                        "session_type": "shell",
                        "config": {},
                        "persistent": false
                    }]
                }))
                .unwrap(),
            )
            .unwrap();
            let store = ConnectionStore::new(path);
            assert!(store.newer_on_disk().is_none());
            assert!(store.get("conn-1").await.is_some(), "{version}");
        }
    }

    /// An older-version file runs through the numbered migrate chain.
    #[test]
    fn migrate_from_older_version_reaches_current_shape() {
        let value = json!({"version": "0", "connections": [], "folders": []});
        let migrated = migrate_definitions(value.clone(), 0).unwrap();
        let parsed: StorageFormat = serde_json::from_value(migrated).unwrap();
        assert!(parsed.connections.is_empty());
    }

    // ── Cross-process lock (PER2-001, #4285) ────────────────────────

    /// Two stores on one file, as two `--stdio`/`--listen` workers would hold
    /// it: each loaded the file before the other saved. A save from the stale
    /// store must merge the peer's connection in, never overwrite it.
    #[tokio::test]
    async fn stale_store_save_keeps_a_peer_workers_connection() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let worker_a = ConnectionStore::new(path.clone());
        let worker_b = ConnectionStore::new(path.clone());

        worker_a
            .create(make_connection("conn-a", "A", false))
            .await
            .unwrap();
        worker_b
            .create(make_connection("conn-b", "B", false))
            .await
            .unwrap();

        let reloaded = ConnectionStore::new(path);
        assert!(reloaded.get("conn-a").await.is_some(), "A's save was lost");
        assert!(reloaded.get("conn-b").await.is_some(), "B's save was lost");
        // The stale store refreshed from disk while saving.
        assert!(worker_b.get("conn-a").await.is_some());
    }

    /// A delete in one worker must not be undone by a stale save in another,
    /// and an update to a connection a peer deleted reports "not found".
    #[tokio::test]
    async fn stale_store_does_not_resurrect_a_peer_delete() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let seed = ConnectionStore::new(path.clone());
        seed.create(make_connection("conn-1", "One", false))
            .await
            .unwrap();
        let worker_a = ConnectionStore::new(path.clone());
        let worker_b = ConnectionStore::new(path.clone());

        assert!(worker_a.delete("conn-1").await.unwrap());
        worker_b
            .create_folder(make_folder("folder-1", "F", None))
            .await
            .unwrap();
        let updated = worker_b
            .update(
                "conn-1",
                Some("Renamed".into()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(updated.is_none(), "update must see the peer's delete");

        let reloaded = ConnectionStore::new(path);
        assert!(reloaded.get("conn-1").await.is_none(), "delete was undone");
        assert_eq!(reloaded.list().await.1.len(), 1);
    }

    /// Several threads, each with its own store (so its own file handles and
    /// OS-level lock), create connections concurrently. None may be lost.
    #[test]
    fn concurrent_stores_in_threads_lose_no_connections() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let workers = 4;
        let per_worker = 15;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(workers));
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .build()
                        .unwrap();
                    let store = ConnectionStore::new(path);
                    barrier.wait();
                    rt.block_on(async {
                        for i in 0..per_worker {
                            let id = format!("conn-{w}-{i}");
                            store
                                .create(make_connection(&id, &id, false))
                                .await
                                .unwrap();
                        }
                    });
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            connections_on_disk(&path),
            workers * per_worker,
            "concurrent workers lost saved connections"
        );
    }

    /// Number of connections persisted in the store file at `path`.
    fn connections_on_disk(path: &Path) -> usize {
        read_json(path)["connections"].as_array().unwrap().len()
    }

    /// Env vars that turn [`concurrent_writer_process_helper`] into a writer.
    const WRITER_PATH_ENV: &str = "TERMIHUB_TEST_CONNSTORE_PATH";
    const WRITER_PREFIX_ENV: &str = "TERMIHUB_TEST_CONNSTORE_PREFIX";
    const WRITER_COUNT: usize = 15;

    /// Child half of [`concurrent_processes_lose_no_connections`]: a no-op in a
    /// normal test run, a connection writer when re-executed with the env set.
    #[tokio::test]
    async fn concurrent_writer_process_helper() {
        let (Ok(path), Ok(prefix)) = (
            std::env::var(WRITER_PATH_ENV),
            std::env::var(WRITER_PREFIX_ENV),
        ) else {
            return;
        };
        let store = ConnectionStore::new(PathBuf::from(path));
        for i in 0..WRITER_COUNT {
            let id = format!("{prefix}-{i}");
            store
                .create(make_connection(&id, &id, false))
                .await
                .unwrap();
        }
    }

    /// Real multi-process regression test: several agent processes save to one
    /// `connections.json` at once. Every connection each one saved must survive.
    #[test]
    fn concurrent_processes_lose_no_connections() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("connections.json");
        let exe = std::env::current_exe().expect("current test exe");
        let processes = 4;
        let children: Vec<_> = (0..processes)
            .map(|p| {
                std::process::Command::new(&exe)
                    .args([
                        "--exact",
                        "--test-threads=1",
                        "-q",
                        "session::definitions::tests::concurrent_writer_process_helper",
                    ])
                    .env(WRITER_PATH_ENV, &path)
                    .env(WRITER_PREFIX_ENV, format!("proc{p}"))
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .expect("spawn writer process")
            })
            .collect();
        for child in children {
            let out = child.wait_with_output().expect("wait for writer");
            assert!(
                out.status.success(),
                "writer failed: {}\nstdout: {}\nstderr: {}",
                out.status,
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr),
            );
        }

        assert_eq!(
            connections_on_disk(&path),
            processes * WRITER_COUNT,
            "concurrent agent processes lost saved connections"
        );
    }
}
