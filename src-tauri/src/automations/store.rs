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

/// Top-level schema for `automations.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStore {
    /// Schema version, read on load and gated by the migration layer.
    pub version: String,
    /// All stored automations.
    pub automations: Vec<Automation>,
    /// What the boot migration last synced from the legacy files. Absent on a
    /// store that was never migrated or that was restored from a backup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<LegacyProvenance>,
    /// Legacy ids the conversion changed, for the schedules v3 rewrite.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub id_remaps: Vec<RecordedIdRemap>,
    /// When the UI switched to this store and the legacy files froze
    /// (RFC 3339; #5818 slice 4). Absent on a store written by a build from
    /// before the switch: the next boot then follows, once, the deletions
    /// made in the legacy files meanwhile (`super::migrate`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_frozen_at: Option<String>,
    /// Unknown top-level keys, preserved verbatim for forward compatibility
    /// (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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

    fn salvage(value: serde_json::Value, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, Automation>(
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
