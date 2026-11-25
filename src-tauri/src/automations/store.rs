//! The persisted `automations.json` document (#5818, slice 2).
//!
//! The file holds the automation list plus two bookkeeping blocks written by
//! the boot migration (`super::migrate`):
//!
//! - `migratedFrom`: one [`LegacyFileRecord`] per legacy file (`macros.json`,
//!   `workflows.json`) with the file's hash and a fingerprint per entry, so
//!   the reconcile pass can tell what an older build changed since.
//! - `idRemaps`: every legacy id the conversion had to change. Schedules still
//!   resolve macros and workflows by their legacy id, so the schedule rewrite
//!   follows this list when schedules move to v3 (slice 10).
//! - `legacyFrozenAt`: when the UI switched to this store (slice 4).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::config::{Automation, LegacySource};

/// Fingerprint of one legacy entry as it was when the migration last synced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEntryRecord {
    /// The entry's id in the legacy file.
    pub legacy_id: String,
    /// 1 for the first entry with this id in the file, 2 for the second, ….
    /// Omitted while 1.
    #[serde(default = "first_occurrence", skip_serializing_if = "is_first")]
    pub occurrence: u32,
    /// SHA-256 (hex) of the entry's canonical JSON.
    pub sha256: String,
    /// The entry's `updatedAt` at sync time. The automation it became carried
    /// the same value, so a different `updatedAt` on the automation means the
    /// new build edited it since.
    #[serde(default)]
    pub updated_at: String,
    /// The id of the automation this entry became.
    pub automation_id: String,
}

/// What the migration last saw of one legacy file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFileRecord {
    /// The file's schema version (0 when the file was absent or unreadable).
    #[serde(default)]
    pub version: u32,
    /// SHA-256 (hex) of the file's bytes; empty when the file was absent.
    #[serde(default)]
    pub sha256: String,
    /// One fingerprint per entry. Empty when the file was absent or could not
    /// be read, so every entry counts as new once it can be.
    #[serde(default)]
    pub entries: Vec<LegacyEntryRecord>,
}

/// The provenance block: one record per legacy file name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LegacyProvenance {
    /// `macros.json`.
    #[serde(
        rename = "macros.json",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub macros: Option<LegacyFileRecord>,
    /// `workflows.json`.
    #[serde(
        rename = "workflows.json",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workflows: Option<LegacyFileRecord>,
}

/// One id the conversion changed (see `convert::IdRemap`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedIdRemap {
    /// The legacy store the entry came from.
    pub source: LegacySource,
    /// The id in the legacy store.
    pub old_id: String,
    /// The id the automation carries.
    pub new_id: String,
}

/// An automation this build cannot read: it has a value (not just a key or a
/// step kind) this build does not know. It is kept verbatim, at its place in the
/// file, and is neither shown nor run (#6009).
#[derive(Debug, Clone, PartialEq)]
pub struct UnreadableAutomation {
    /// Position in the stored list.
    pub index: usize,
    /// The automation's id, so nothing else takes it.
    pub id: String,
    /// The stored JSON.
    pub value: Value,
    /// Why it could not be read.
    pub error: String,
}

impl UnreadableAutomation {
    /// The stored name, or the id.
    pub fn name(&self) -> &str {
        self.value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&self.id)
    }
}

/// Top-level schema for `automations.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "StoreDocument", into = "StoreDocument")]
pub struct AutomationStore {
    /// Schema version, read on load and gated by the migration layer.
    pub version: String,
    /// All stored automations this build can read.
    pub automations: Vec<Automation>,
    /// The ones it cannot read, kept for the next write.
    pub unreadable: Vec<UnreadableAutomation>,
    /// What the boot migration last synced from the legacy files. Absent on a
    /// store that was never migrated or that was restored from a backup.
    pub migrated_from: Option<LegacyProvenance>,
    /// Legacy ids the conversion changed, for the schedules v3 rewrite.
    pub id_remaps: Vec<RecordedIdRemap>,
    /// When the UI switched to this store and the legacy files froze
    /// (RFC 3339; #5818 slice 4). Absent on a store written by a build from
    /// before the switch: the next boot then follows, once, the deletions
    /// made in the legacy files meanwhile (`super::migrate`).
    pub legacy_frozen_at: Option<String>,
    /// Unknown top-level keys, preserved verbatim for forward compatibility
    /// (PER-010).
    pub extra: serde_json::Map<String, Value>,
}

/// The stored shape of [`AutomationStore`]: one list, in file order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreDocument {
    /// Schema version, read on load and gated by the migration layer.
    version: String,
    /// All stored automations.
    automations: Vec<Value>,
    /// What the boot migration last synced from the legacy files. Absent on a
    /// store that was never migrated or that was restored from a backup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    migrated_from: Option<LegacyProvenance>,
    /// Legacy ids the conversion changed, for the schedules v3 rewrite.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    id_remaps: Vec<RecordedIdRemap>,
    /// When the UI switched to this store and the legacy files froze
    /// (RFC 3339; #5818 slice 4). Absent on a store written by a build from
    /// before the switch: the next boot then follows, once, the deletions
    /// made in the legacy files meanwhile (`super::migrate`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_frozen_at: Option<String>,
    /// Unknown top-level keys, preserved verbatim for forward compatibility
    /// (PER-010).
    #[serde(flatten, default)]
    extra: serde_json::Map<String, Value>,
}

/// One entry of the stored list: an automation, or an unreadable one.
enum StoredEntry {
    Readable(Box<Automation>),
    Unreadable { id: String, error: String },
}

impl StoredEntry {
    /// Read one entry; an error when it is no automation at all (no object
    /// with an id), which the salvage then removes.
    fn read(value: &Value) -> Result<Self, String> {
        match serde_json::from_value::<Automation>(value.clone()) {
            Ok(automation) => Ok(Self::Readable(Box::new(automation))),
            Err(e) => match value.get("id").and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => Ok(Self::Unreadable {
                    id: id.to_string(),
                    error: e.to_string(),
                }),
                _ => Err(e.to_string()),
            },
        }
    }
}

impl<'de> Deserialize<'de> for StoredEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::read(&Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl TryFrom<StoreDocument> for AutomationStore {
    type Error = String;

    fn try_from(doc: StoreDocument) -> Result<Self, String> {
        let mut automations = Vec::with_capacity(doc.automations.len());
        let mut unreadable = Vec::new();
        for (index, value) in doc.automations.into_iter().enumerate() {
            match StoredEntry::read(&value)? {
                StoredEntry::Readable(automation) => automations.push(*automation),
                StoredEntry::Unreadable { id, error } => unreadable.push(UnreadableAutomation {
                    index,
                    id,
                    value,
                    error,
                }),
            }
        }
        Ok(Self {
            version: doc.version,
            automations,
            unreadable,
            migrated_from: doc.migrated_from,
            id_remaps: doc.id_remaps,
            legacy_frozen_at: doc.legacy_frozen_at,
            extra: doc.extra,
        })
    }
}

impl From<AutomationStore> for StoreDocument {
    fn from(store: AutomationStore) -> Self {
        let mut automations: Vec<Value> = store
            .automations
            .into_iter()
            // A serialized automation is always an object: it has string keys
            // and no value that JSON cannot hold.
            .map(|a| serde_json::to_value(a).unwrap_or_default())
            .collect();
        for entry in store.unreadable {
            automations.insert(entry.index.min(automations.len()), entry.value);
        }
        Self {
            version: store.version,
            automations,
            migrated_from: store.migrated_from,
            id_remaps: store.id_remaps,
            legacy_frozen_at: store.legacy_frozen_at,
            extra: store.extra,
        }
    }
}

impl AutomationStore {
    /// The schema version this build reads and writes.
    pub const CURRENT_VERSION: u32 = 1;
    /// The store's file name in the config directory.
    pub const FILE_NAME: &'static str = "automations.json";
}

impl Default for AutomationStore {
    fn default() -> Self {
        Self {
            version: Self::CURRENT_VERSION.to_string(),
            automations: Vec::new(),
            unreadable: Vec::new(),
            migrated_from: None,
            id_remaps: Vec::new(),
            legacy_frozen_at: None,
            extra: serde_json::Map::new(),
        }
    }
}

/// `automations.json` joins the shared schema-version gate: a newer file is
/// refused instead of reset, and a corrupt one is salvaged per automation.
impl crate::utils::migrate::VersionedStore for AutomationStore {
    const STORE_NAME: &'static str = AutomationStore::FILE_NAME;
    const CURRENT_VERSION: u32 = AutomationStore::CURRENT_VERSION;

    fn salvage(value: Value, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, StoredEntry>(
            value,
            file_name,
            "automations",
        )
    }
}

/// Serde default for [`LegacyEntryRecord::occurrence`].
fn first_occurrence() -> u32 {
    1
}

/// Serde skip predicate for [`LegacyEntryRecord::occurrence`].
fn is_first(occurrence: &u32) -> bool {
    *occurrence == 1
}
