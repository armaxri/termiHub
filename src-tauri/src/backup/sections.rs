//! The backup section registry and the pure per-section logic: validate +
//! migrate a section's data, count and classify its items, merge it into the
//! current store (PROD-068).
//!
//! Every section is one persisted JSON store in the config directory. Section
//! data is always passed through the store's own typed model (and, for a
//! [`VersionedStore`], its `load_versioned` version gate + forward migration),
//! so a restore can only ever write a file the store itself would load.

use std::collections::HashMap;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::connection::config::{ConnectionStore, SavedRemoteAgent};
use crate::connection::settings::AppSettings;
use crate::connection::tree::{build_tree, flatten_tree};
use crate::credential::vault::ConflictStrategy;
use crate::embedded_servers::config::EmbeddedServerStore;
use crate::macros::config::MacroStore;
use crate::network::http_monitor_storage::HttpMonitorsFile;
use crate::network::tool_history::NetworkToolHistoryStore;
use crate::network::wol_storage::WolDevicesFile;
use crate::schedules::config::ScheduleStore;
use crate::tunnel::config::TunnelStore;
use crate::utils::migrate::{load_versioned, read_version, LoadOutcome, VersionedStore};
use crate::workflows::config::WorkflowStore;
use crate::workspace::config::WorkspaceStore;

/// How a section's items are laid out, which drives counting and merging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// `{ …, "<field>": [ { "id": …, … }, … ] }` — merged by item `id`.
    List { field: &'static str },
    /// `connections.json`: a folder/connection tree plus saved agents, merged
    /// by the path-based folder / connection id and the agent id.
    Connections,
    /// `settings.json`: one object; replace only. The machine's own
    /// credential-storage keys are always preserved (see [`LOCAL_SETTINGS_KEYS`]).
    Settings,
}

/// Why a section's data cannot be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    /// Written by a newer termiHub than this build.
    Newer { found: u32, supported: u32 },
    /// Not a valid store of this kind.
    Invalid(String),
}

impl NormalizeError {
    /// User-facing message, naming the section.
    pub fn message(&self, label: &str) -> String {
        match self {
            NormalizeError::Newer { found, supported } => format!(
                "{label} was backed up by a newer version of termiHub (schema version {found}; \
                 this build reads up to {supported}). Update termiHub to restore it."
            ),
            NormalizeError::Invalid(detail) => {
                format!("{label} in the backup is not valid: {detail}")
            }
        }
    }
}

/// One backupable store.
pub struct SectionSpec {
    /// Stable id written into the backup file.
    pub id: &'static str,
    /// Display name.
    pub label: &'static str,
    /// One-line description for the export dialog.
    pub description: &'static str,
    /// The store's file name in the config directory.
    pub file_name: &'static str,
    /// The schema version this build reads and writes.
    pub current_version: u32,
    pub shape: Shape,
    /// The store holds secrets in its own file (e.g. embedded-server
    /// passwords), so it is only exported inside an encrypted backup.
    pub contains_secrets: bool,
    /// Validate + migrate a document to the current schema.
    normalize: fn(Value) -> Result<Value, NormalizeError>,
    /// The store's empty default document.
    default_doc: fn() -> Value,
}

impl SectionSpec {
    /// Validate `data` (a document of schema `schema_version`) and migrate it
    /// to this build's schema.
    pub fn normalize(&self, data: Value) -> Result<Value, NormalizeError> {
        (self.normalize)(data)
    }

    /// The empty store document.
    pub fn default_doc(&self) -> Value {
        (self.default_doc)()
    }

    /// Whether [`RestoreMode::Merge`](super::RestoreMode::Merge) is available.
    pub fn supports_merge(&self) -> bool {
        !matches!(self.shape, Shape::Settings)
    }
}

/// Settings keys that describe **this machine's** credential store. They are
/// never taken from a backup: restoring another machine's storage mode would
/// point the app at a credential store that does not exist here.
pub const LOCAL_SETTINGS_KEYS: &[&str] = &["credentialStorageMode", "credentialAutoLockMinutes"];

fn to_doc<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or_default()
}

/// Normalize through a [`VersionedStore`]'s own version gate + migration.
fn normalize_versioned<T: VersionedStore + Serialize>(
    data: Value,
) -> Result<Value, NormalizeError> {
    if !data.is_object() {
        return Err(NormalizeError::Invalid(
            "expected a JSON object".to_string(),
        ));
    }
    match load_versioned::<T>(&data.to_string()) {
        LoadOutcome::Loaded { data, .. } => {
            let mut doc =
                serde_json::to_value(&data).map_err(|e| NormalizeError::Invalid(e.to_string()))?;
            // A migrated document is written back at the current version.
            if let Some(obj) = doc.as_object_mut() {
                if obj.contains_key("version") {
                    obj.insert(
                        "version".to_string(),
                        Value::String(T::CURRENT_VERSION.to_string()),
                    );
                }
            }
            Ok(doc)
        }
        LoadOutcome::Newer(e) => Err(NormalizeError::Newer {
            found: e.found,
            supported: e.supported,
        }),
        LoadOutcome::Corrupt(detail) => Err(NormalizeError::Invalid(detail)),
    }
}

/// Normalize a store that has no migration layer (schema version 1): refuse a
/// newer `version`, otherwise validate through the typed model.
fn normalize_plain<T: DeserializeOwned + Serialize>(data: Value) -> Result<Value, NormalizeError> {
    if !data.is_object() {
        return Err(NormalizeError::Invalid(
            "expected a JSON object".to_string(),
        ));
    }
    if let Some(found) = read_version(&data) {
        if found > 1 {
            return Err(NormalizeError::Newer {
                found,
                supported: 1,
            });
        }
    }
    let typed: T =
        serde_json::from_value(data).map_err(|e| NormalizeError::Invalid(e.to_string()))?;
    serde_json::to_value(&typed).map_err(|e| NormalizeError::Invalid(e.to_string()))
}

/// Remove any password from a `connections.json` document. The store never
/// writes one (passwords live in the credential store), so this is defence in
/// depth: a backup never carries — and a restore never writes — a connection or
/// agent password in the clear.
pub fn strip_connection_passwords(doc: &mut Value) {
    fn strip_nodes(nodes: &mut Value) {
        let Some(nodes) = nodes.as_array_mut() else {
            return;
        };
        for node in nodes {
            if let Some(settings) = node
                .get_mut("config")
                .and_then(|c| c.get_mut("config"))
                .and_then(Value::as_object_mut)
            {
                settings.remove("password");
            }
            if let Some(children) = node.get_mut("children") {
                strip_nodes(children);
            }
        }
    }
    if let Some(children) = doc.get_mut("children") {
        strip_nodes(children);
    }
    if let Some(agents) = doc.get_mut("agents").and_then(Value::as_array_mut) {
        for agent in agents {
            if let Some(config) = agent.get_mut("config").and_then(Value::as_object_mut) {
                config.remove("password");
            }
        }
    }
}

fn normalize_connections(data: Value) -> Result<Value, NormalizeError> {
    let mut doc = normalize_versioned::<ConnectionStore>(data)?;
    strip_connection_passwords(&mut doc);
    Ok(doc)
}

/// Every section a backup can carry, in display order.
pub static SECTIONS: &[SectionSpec] = &[
    SectionSpec {
        id: "connections",
        label: "Connections",
        description: "Saved connections, folders and remote agents (no passwords).",
        file_name: "connections.json",
        current_version: <ConnectionStore as VersionedStore>::CURRENT_VERSION,
        shape: Shape::Connections,
        contains_secrets: false,
        normalize: normalize_connections,
        default_doc: || to_doc(&ConnectionStore::default()),
    },
    SectionSpec {
        id: "settings",
        label: "Settings",
        description: "App settings, including custom themes and keyboard shortcuts.",
        file_name: "settings.json",
        current_version: <AppSettings as VersionedStore>::CURRENT_VERSION,
        shape: Shape::Settings,
        contains_secrets: false,
        normalize: normalize_versioned::<AppSettings>,
        default_doc: || to_doc(&AppSettings::default()),
    },
    SectionSpec {
        id: "workspaces",
        label: "Workspaces",
        description: "Saved workspace layouts.",
        file_name: "workspaces.json",
        current_version: <WorkspaceStore as VersionedStore>::CURRENT_VERSION,
        shape: Shape::List {
            field: "workspaces",
        },
        contains_secrets: false,
        normalize: normalize_versioned::<WorkspaceStore>,
        default_doc: || to_doc(&WorkspaceStore::default()),
    },
    SectionSpec {
        id: "macros",
        label: "Macros",
        description: "Terminal macros.",
        file_name: "macros.json",
        current_version: 1,
        shape: Shape::List { field: "macros" },
        contains_secrets: false,
        normalize: normalize_plain::<MacroStore>,
        default_doc: || to_doc(&MacroStore::default()),
    },
    SectionSpec {
        id: "workflows",
        label: "Workflows",
        description: "Automation workflows.",
        file_name: "workflows.json",
        current_version: <WorkflowStore as VersionedStore>::CURRENT_VERSION,
        shape: Shape::List { field: "workflows" },
        contains_secrets: false,
        normalize: normalize_versioned::<WorkflowStore>,
        default_doc: || to_doc(&WorkflowStore::default()),
    },
    SectionSpec {
        id: "schedules",
        label: "Schedules",
        description: "Scheduled workflow and macro runs.",
        file_name: "schedules.json",
        current_version: <ScheduleStore as VersionedStore>::CURRENT_VERSION,
        shape: Shape::List { field: "schedules" },
        contains_secrets: false,
        normalize: normalize_versioned::<ScheduleStore>,
        default_doc: || to_doc(&ScheduleStore::default()),
    },
    SectionSpec {
        id: "tunnels",
        label: "Tunnels",
        description: "SSH tunnel definitions.",
        file_name: "tunnels.json",
        current_version: 1,
        shape: Shape::List { field: "tunnels" },
        contains_secrets: false,
        normalize: normalize_plain::<TunnelStore>,
        default_doc: || to_doc(&TunnelStore::default()),
    },
    SectionSpec {
        id: "embeddedServers",
        label: "Embedded servers",
        description: "Embedded HTTP/FTP/TFTP server definitions (includes their passwords).",
        file_name: "embedded_servers.json",
        current_version: 1,
        shape: Shape::List { field: "servers" },
        contains_secrets: true,
        normalize: normalize_plain::<EmbeddedServerStore>,
        default_doc: || to_doc(&EmbeddedServerStore::default()),
    },
    SectionSpec {
        id: "wolDevices",
        label: "Wake-on-LAN devices",
        description: "Saved Wake-on-LAN devices.",
        file_name: "wol-devices.json",
        current_version: 1,
        shape: Shape::List { field: "devices" },
        contains_secrets: false,
        normalize: normalize_plain::<WolDevicesFile>,
        default_doc: || to_doc(&WolDevicesFile::default()),
    },
    SectionSpec {
        id: "httpMonitors",
        label: "HTTP monitors",
        description: "HTTP monitor definitions.",
        file_name: "http-monitors.json",
        current_version: 1,
        shape: Shape::List { field: "monitors" },
        contains_secrets: false,
        normalize: normalize_plain::<HttpMonitorsFile>,
        default_doc: || to_doc(&HttpMonitorsFile::default()),
    },
    SectionSpec {
        id: "networkToolHistory",
        label: "Network tool history",
        description: "Recorded ping, traceroute and port-scan runs.",
        file_name: "network-tool-history.json",
        current_version: <NetworkToolHistoryStore as VersionedStore>::CURRENT_VERSION,
        shape: Shape::List { field: "runs" },
        contains_secrets: false,
        normalize: normalize_versioned::<NetworkToolHistoryStore>,
        default_doc: || to_doc(&NetworkToolHistoryStore::default()),
    },
];

/// Look up a section by id.
pub fn spec(id: &str) -> Option<&'static SectionSpec> {
    SECTIONS.iter().find(|s| s.id == id)
}

/// Look up a section by its store file name. Used to validate a staged
/// restore's manifest, so only known store files can ever be written.
pub fn spec_for_file(file_name: &str) -> Option<&'static SectionSpec> {
    SECTIONS.iter().find(|s| s.file_name == file_name)
}

/// The items of a (normalized) document, keyed by a unique id. Settings have
/// no items.
pub fn keyed_items(spec: &SectionSpec, doc: &Value) -> Result<Vec<(String, Value)>, String> {
    match spec.shape {
        Shape::Settings => Ok(Vec::new()),
        Shape::List { field } => {
            let items = match doc.get(field) {
                Some(Value::Array(items)) => items,
                Some(_) => return Err(format!("\"{field}\" is not a list")),
                None => return Ok(Vec::new()),
            };
            items
                .iter()
                .enumerate()
                .map(|(i, item)| match item.get("id").and_then(Value::as_str) {
                    Some(id) => Ok((id.to_string(), item.clone())),
                    None => Err(format!("item {i} of \"{field}\" has no id")),
                })
                .collect()
        }
        Shape::Connections => {
            let store: ConnectionStore =
                serde_json::from_value(doc.clone()).map_err(|e| e.to_string())?;
            let (connections, folders) = flatten_tree(&store.children, None);
            let mut out = Vec::new();
            for f in &folders {
                out.push((format!("folder:{}", f.id), to_doc(f)));
            }
            for c in &connections {
                out.push((format!("connection:{}", c.id), to_doc(c)));
            }
            for a in &store.agents {
                out.push((format!("agent:{}", a.id), to_doc(a)));
            }
            Ok(out)
        }
    }
}

/// Item counts of a backup section compared with the current store.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Comparison {
    pub item_count: u32,
    pub current_count: u32,
    pub new_count: u32,
    pub conflict_count: u32,
    pub unchanged_count: u32,
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Compare a normalized backup document against the normalized current one.
pub fn compare(spec: &SectionSpec, backup: &Value, current: &Value) -> Result<Comparison, String> {
    let backup_items = keyed_items(spec, backup)?;
    let current_items: HashMap<String, Value> = keyed_items(spec, current)?.into_iter().collect();
    let mut cmp = Comparison {
        item_count: count(backup_items.len()),
        current_count: count(current_items.len()),
        ..Comparison::default()
    };
    for (id, item) in &backup_items {
        match current_items.get(id) {
            None => cmp.new_count += 1,
            Some(existing) if existing == item => cmp.unchanged_count += 1,
            Some(_) => cmp.conflict_count += 1,
        }
    }
    Ok(cmp)
}

/// Merge `incoming` items into `current` by id: new ids are appended, shared
/// ids follow `strategy`. Order of the current items is preserved.
fn merge_by_id<T: Clone>(
    current: &mut Vec<T>,
    incoming: &[T],
    id_of: impl Fn(&T) -> &str,
    strategy: ConflictStrategy,
) {
    for item in incoming {
        match current.iter().position(|c| id_of(c) == id_of(item)) {
            Some(i) => {
                if strategy == ConflictStrategy::Overwrite {
                    current[i] = item.clone();
                }
            }
            None => current.push(item.clone()),
        }
    }
}

/// Merge a normalized backup document into the normalized current one.
pub fn merge(
    spec: &SectionSpec,
    current: Value,
    backup: &Value,
    strategy: ConflictStrategy,
) -> Result<Value, String> {
    match spec.shape {
        Shape::Settings => Err(format!("{} can only be replaced, not merged", spec.label)),
        Shape::List { field } => {
            let mut doc = current;
            let current_list = match doc.get(field) {
                Some(Value::Array(items)) => items.clone(),
                Some(_) => return Err(format!("\"{field}\" is not a list")),
                None => Vec::new(),
            };
            let backup_list = match backup.get(field) {
                Some(Value::Array(items)) => items.clone(),
                Some(_) => return Err(format!("\"{field}\" is not a list")),
                None => Vec::new(),
            };
            let mut merged = current_list;
            merge_by_id(
                &mut merged,
                &backup_list,
                |v| v.get("id").and_then(Value::as_str).unwrap_or_default(),
                strategy,
            );
            let obj = doc
                .as_object_mut()
                .ok_or_else(|| "expected a JSON object".to_string())?;
            obj.insert(field.to_string(), Value::Array(merged));
            Ok(doc)
        }
        Shape::Connections => {
            let current: ConnectionStore =
                serde_json::from_value(current).map_err(|e| e.to_string())?;
            let backup: ConnectionStore =
                serde_json::from_value(backup.clone()).map_err(|e| e.to_string())?;
            let (mut connections, mut folders) = flatten_tree(&current.children, None);
            let (backup_connections, backup_folders) = flatten_tree(&backup.children, None);
            merge_by_id(&mut folders, &backup_folders, |f| &f.id, strategy);
            merge_by_id(&mut connections, &backup_connections, |c| &c.id, strategy);
            let mut agents: Vec<SavedRemoteAgent> = current.agents;
            merge_by_id(&mut agents, &backup.agents, |a| &a.id, strategy);
            let merged = ConnectionStore {
                version: <ConnectionStore as VersionedStore>::CURRENT_VERSION.to_string(),
                children: build_tree(&connections, &folders),
                agents,
            };
            serde_json::to_value(&merged).map_err(|e| e.to_string())
        }
    }
}

/// For a settings replace: keep this machine's credential-storage keys.
pub fn preserve_local_settings(backup: &mut Value, current: Option<&Value>) {
    let Some(obj) = backup.as_object_mut() else {
        return;
    };
    for key in LOCAL_SETTINGS_KEYS {
        match current.and_then(|c| c.get(*key)) {
            Some(value) => {
                obj.insert((*key).to_string(), value.clone());
            }
            None => {
                obj.remove(*key);
            }
        }
    }
}

/// The current store's state on disk.
pub enum CurrentDoc {
    /// The file does not exist yet — the store is empty.
    Missing,
    /// The normalized current document.
    Present(Value),
    /// The file is unreadable or invalid (the app has reset / backed it up).
    Unreadable(String),
    /// The file was written by a newer termiHub; it must not be overwritten.
    Newer { found: u32, supported: u32 },
}

/// Read and normalize a section's current store file from `config_dir`.
pub fn read_current(spec: &SectionSpec, config_dir: &Path) -> CurrentDoc {
    let path = config_dir.join(spec.file_name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return CurrentDoc::Missing,
        Err(e) => return CurrentDoc::Unreadable(e.to_string()),
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return CurrentDoc::Unreadable(e.to_string()),
    };
    match spec.normalize(value) {
        Ok(doc) => CurrentDoc::Present(doc),
        Err(NormalizeError::Newer { found, supported }) => CurrentDoc::Newer { found, supported },
        Err(NormalizeError::Invalid(detail)) => CurrentDoc::Unreadable(detail),
    }
}
