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
use zeroize::Zeroizing;

use crate::connection::config::{ConnectionStore, SavedRemoteAgent};
use crate::connection::settings::AppSettings;
use crate::connection::tree::{build_tree, flatten_tree};
use crate::credential::types::CredentialKey;
use crate::credential::vault::ConflictStrategy;
use crate::embedded_servers::config::EmbeddedServerStore;
use crate::embedded_servers::secrets::{credential_key, take_passwords};
use crate::embedded_servers::storage::remove_password_keys;
use crate::macros::config::MacroStore;
use crate::network::http_monitor_storage::HttpMonitorsFile;
use crate::network::monitor_history::HttpMonitorHistoryStore;
use crate::network::tool_history::NetworkToolHistoryStore;
use crate::network::wol_storage::WolDevicesFile;
use crate::tunnel::config::TunnelStore;
use crate::utils::migrate::{load_versioned, read_version, LoadOutcome, VersionedStore};
use crate::workflows::config::WorkflowStore;
use crate::workspace::config::WorkspaceStore;

use super::trust_map::{fingerprints_covered, normalize_trust_map};
pub use super::trust_map::{trust_conflicts, TRUST_STORE_SCHEMA_VERSION};

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
    /// A host-key trust store (`ssh_known_hosts.json`, `rdp_known_hosts.json`):
    /// one object mapping `host:port` to the list of trusted fingerprints,
    /// merged by host. A host that is already trusted here **always keeps its
    /// current fingerprints** on a merge — a backup can never add or swap a key
    /// for a known host (that would be exactly a man-in-the-middle injection);
    /// only Replace adopts the backup's keys wholesale.
    TrustMap,
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
    /// The schema version this build reads and writes. Always the owning
    /// store's own `CURRENT_VERSION` constant — never a literal here — so a
    /// store's version bump reaches the backup automatically.
    pub current_version: u32,
    pub shape: Shape,
    /// The store holds secrets in its own file, so it is only exported inside
    /// an encrypted backup. (No store does today: connection and — since #3514
    /// — embedded-server passwords live in the credential store and travel in
    /// the credentials section.)
    pub contains_secrets: bool,
    /// The store holds **trust decisions** (trusted host keys) whose integrity
    /// matters: an injected entry could enable a man-in-the-middle. It is only
    /// exported inside an encrypted backup and only restored from one (the
    /// AES-GCM envelope authenticates the whole contents).
    pub integrity_sensitive: bool,
    /// Validate + migrate a document to the current schema.
    normalize: fn(Value) -> Result<Value, NormalizeError>,
    /// Read the plaintext passwords an older schema of this store kept in its
    /// own file (see [`LegacySecret`]). [`Self::normalize`] strips them; a
    /// restore moves them into the credential store instead.
    pub legacy_secrets: Option<fn(&Value) -> Vec<LegacySecret>>,
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

    /// Whether the section may only be exported in (and restored from) an
    /// encrypted backup.
    pub fn requires_encryption(&self) -> bool {
        self.contains_secrets || self.integrity_sensitive
    }

    /// Whether a merge conflict always keeps the current item, ignoring the
    /// chosen conflict strategy (trust stores — see [`Shape::TrustMap`]).
    pub fn conflicts_keep_existing(&self) -> bool {
        self.shape == Shape::TrustMap
    }

    /// Validate and migrate one backup section. On top of the store's own
    /// version gate ([`Self::normalize`]), the section's recorded
    /// `schema_version` must not be newer than this build — this is the only
    /// version a store without an in-file `version` field (the trust stores)
    /// carries.
    pub fn normalize_section(
        &self,
        section: &super::BackupSection,
    ) -> Result<Value, NormalizeError> {
        if section.schema_version > self.current_version {
            return Err(NormalizeError::Newer {
                found: section.schema_version,
                supported: self.current_version,
            });
        }
        self.normalize(section.data.clone())
    }
}

/// A password an older store schema kept in plaintext in its own file (e.g.
/// `embedded_servers.json` v1, before #3514). It is never written back to a
/// file: a backup leaves it out and a restore moves it into the credential
/// store.
pub struct LegacySecret {
    /// The id of the store item (e.g. the embedded server) that owns it.
    pub item_id: String,
    /// Where the credential store keeps it.
    pub key: CredentialKey,
    pub value: Zeroizing<String>,
}

impl LegacySecret {
    /// The legacy secrets in a (raw, not yet normalized) section document.
    pub fn read(spec: &SectionSpec, doc: &Value) -> Vec<LegacySecret> {
        spec.legacy_secrets
            .map(|read| read(doc))
            .unwrap_or_default()
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

/// A store without a migration layer. Its schema version is the store's own
/// `CURRENT_VERSION` constant — the backup never repeats it as a literal.
trait PlainStore: DeserializeOwned + Serialize {
    const CURRENT_VERSION: u32;
}

macro_rules! plain_store {
    ($($store:ty),* $(,)?) => {
        $(impl PlainStore for $store {
            const CURRENT_VERSION: u32 = <$store>::CURRENT_VERSION;
        })*
    };
}

plain_store!(
    MacroStore,
    TunnelStore,
    EmbeddedServerStore,
    WolDevicesFile,
    HttpMonitorsFile,
);

/// Normalize a store that has no migration layer: refuse a `version` newer
/// than the store's `CURRENT_VERSION`, otherwise validate through the typed
/// model. The document's `version` is left as-is — such a store's own loader
/// owns any upgrade of an older file.
fn normalize_plain<T: PlainStore>(data: Value) -> Result<Value, NormalizeError> {
    if !data.is_object() {
        return Err(NormalizeError::Invalid(
            "expected a JSON object".to_string(),
        ));
    }
    if let Some(found) = read_version(&data) {
        if found > T::CURRENT_VERSION {
            return Err(NormalizeError::Newer {
                found,
                supported: T::CURRENT_VERSION,
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

/// `embedded_servers.json`: v1 files may carry plaintext FTP / HTTP Basic
/// passwords; v2 (#3514) keeps them in the credential store. Migrating a
/// document forward is exactly removing them — the same `password` keys the
/// store's own writer removes — so the result is always a v2 document. The
/// passwords themselves are read separately ([`embedded_server_secrets`]).
fn normalize_embedded_servers(data: Value) -> Result<Value, NormalizeError> {
    let mut doc = normalize_plain::<EmbeddedServerStore>(data)?;
    remove_password_keys(&mut doc);
    if let Some(obj) = doc.as_object_mut() {
        obj.insert(
            "version".to_string(),
            Value::String(EmbeddedServerStore::CURRENT_VERSION.to_string()),
        );
    }
    Ok(doc)
}

/// The plaintext passwords in a (v1) `embedded_servers.json` document, keyed
/// as the embedded-server manager keeps them in the credential store.
fn embedded_server_secrets(doc: &Value) -> Vec<LegacySecret> {
    let Ok(mut store) = serde_json::from_value::<EmbeddedServerStore>(doc.clone()) else {
        return Vec::new();
    };
    let mut secrets = Vec::new();
    for config in &mut store.servers {
        for (slot, value) in take_passwords(config) {
            secrets.push(LegacySecret {
                item_id: config.id.clone(),
                key: credential_key(&config.id, slot),
                value,
            });
        }
    }
    secrets
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
        integrity_sensitive: false,
        normalize: normalize_connections,
        legacy_secrets: None,
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
        integrity_sensitive: false,
        normalize: normalize_versioned::<AppSettings>,
        legacy_secrets: None,
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
        integrity_sensitive: false,
        normalize: normalize_versioned::<WorkspaceStore>,
        legacy_secrets: None,
        default_doc: || to_doc(&WorkspaceStore::default()),
    },
    SectionSpec {
        id: "macros",
        label: "Macros",
        description: "Terminal macros.",
        file_name: "macros.json",
        current_version: MacroStore::CURRENT_VERSION,
        shape: Shape::List { field: "macros" },
        contains_secrets: false,
        integrity_sensitive: false,
        normalize: normalize_plain::<MacroStore>,
        legacy_secrets: None,
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
        integrity_sensitive: false,
        normalize: normalize_versioned::<WorkflowStore>,
        legacy_secrets: None,
        default_doc: || to_doc(&WorkflowStore::default()),
    },
    SectionSpec {
        id: "tunnels",
        label: "Tunnels",
        description: "SSH tunnel definitions.",
        file_name: "tunnels.json",
        current_version: TunnelStore::CURRENT_VERSION,
        shape: Shape::List { field: "tunnels" },
        contains_secrets: false,
        integrity_sensitive: false,
        normalize: normalize_plain::<TunnelStore>,
        legacy_secrets: None,
        default_doc: || to_doc(&TunnelStore::default()),
    },
    SectionSpec {
        id: "embeddedServers",
        label: "Embedded servers",
        description:
            "Embedded HTTP/FTP/TFTP server definitions (passwords are in the credentials).",
        file_name: "embedded_servers.json",
        current_version: EmbeddedServerStore::CURRENT_VERSION,
        shape: Shape::List { field: "servers" },
        contains_secrets: false,
        integrity_sensitive: false,
        normalize: normalize_embedded_servers,
        legacy_secrets: Some(embedded_server_secrets),
        default_doc: || to_doc(&EmbeddedServerStore::default()),
    },
    SectionSpec {
        id: "wolDevices",
        label: "Wake-on-LAN devices",
        description: "Saved Wake-on-LAN devices.",
        file_name: "wol-devices.json",
        current_version: WolDevicesFile::CURRENT_VERSION,
        shape: Shape::List { field: "devices" },
        contains_secrets: false,
        integrity_sensitive: false,
        normalize: normalize_plain::<WolDevicesFile>,
        legacy_secrets: None,
        default_doc: || to_doc(&WolDevicesFile::default()),
    },
    SectionSpec {
        id: "httpMonitors",
        label: "HTTP monitors",
        description: "HTTP monitor definitions.",
        file_name: "http-monitors.json",
        current_version: HttpMonitorsFile::CURRENT_VERSION,
        shape: Shape::List { field: "monitors" },
        contains_secrets: false,
        integrity_sensitive: false,
        normalize: normalize_plain::<HttpMonitorsFile>,
        legacy_secrets: None,
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
        integrity_sensitive: false,
        normalize: normalize_versioned::<NetworkToolHistoryStore>,
        legacy_secrets: None,
        default_doc: || to_doc(&NetworkToolHistoryStore::default()),
    },
    SectionSpec {
        id: "httpMonitorHistory",
        label: "HTTP monitor history",
        description: "Recorded HTTP monitor checks (status, response time).",
        file_name: "http-monitor-history.json",
        current_version: <HttpMonitorHistoryStore as VersionedStore>::CURRENT_VERSION,
        shape: Shape::List { field: "monitors" },
        contains_secrets: false,
        integrity_sensitive: false,
        normalize: normalize_versioned::<HttpMonitorHistoryStore>,
        legacy_secrets: None,
        default_doc: || to_doc(&HttpMonitorHistoryStore::default()),
    },
    SectionSpec {
        id: "sshKnownHosts",
        label: "Trusted SSH host keys",
        description: "SSH host keys you chose to trust (only in an encrypted backup).",
        file_name: "ssh_known_hosts.json",
        current_version: TRUST_STORE_SCHEMA_VERSION,
        shape: Shape::TrustMap,
        contains_secrets: false,
        integrity_sensitive: true,
        normalize: normalize_trust_map,
        legacy_secrets: None,
        default_doc: || Value::Object(serde_json::Map::new()),
    },
    SectionSpec {
        id: "rdpKnownHosts",
        label: "Trusted RDP certificates",
        description: "RDP server certificates you chose to trust (only in an encrypted backup).",
        file_name: "rdp_known_hosts.json",
        current_version: TRUST_STORE_SCHEMA_VERSION,
        shape: Shape::TrustMap,
        contains_secrets: false,
        integrity_sensitive: true,
        normalize: normalize_trust_map,
        legacy_secrets: None,
        default_doc: || Value::Object(serde_json::Map::new()),
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
        Shape::TrustMap => match doc {
            Value::Object(map) => Ok(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            _ => Err("expected a JSON object".to_string()),
        },
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
            // A trust-store host whose backup keys are all trusted here already.
            Some(existing)
                if spec.shape == Shape::TrustMap && fingerprints_covered(item, existing) =>
            {
                cmp.unchanged_count += 1
            }
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
        Shape::TrustMap => {
            // Union by host; a host trusted here keeps exactly its current keys
            // whatever the strategy (see `Shape::TrustMap`).
            let Value::Object(mut merged) = current else {
                return Err("expected a JSON object".to_string());
            };
            let Value::Object(backup) = backup else {
                return Err("expected a JSON object".to_string());
            };
            for (host, fps) in backup {
                merged.entry(host.clone()).or_insert_with(|| fps.clone());
            }
            Ok(Value::Object(merged))
        }
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

/// The legacy plaintext passwords still in a section's current store file
/// (e.g. embedded-server passwords whose move into a locked credential store
/// is pending, #3514). Empty when the file is missing or unreadable.
pub fn read_current_legacy_secrets(spec: &SectionSpec, config_dir: &Path) -> Vec<LegacySecret> {
    if spec.legacy_secrets.is_none() {
        return Vec::new();
    }
    let Ok(raw) = std::fs::read_to_string(config_dir.join(spec.file_name)) else {
        return Vec::new();
    };
    let raw = Zeroizing::new(raw);
    serde_json::from_str::<Value>(&raw)
        .map(|doc| LegacySecret::read(spec, &doc))
        .unwrap_or_default()
}
