//! Unified backup and restore of all termiHub app data (PROD-068).
//!
//! One backup file carries every persisted configuration store as its own
//! **section** (each with the schema version of the store it came from), plus
//! an optional **credentials** section that is the encrypted credential-vault
//! object from PROD-063 ([`VaultExportFile`]) embedded verbatim:
//!
//! ```json
//! {
//!   "format": "termihub-backup",
//!   "formatVersion": 1,
//!   "createdAt": "2026-09-26T12:00:00+00:00",
//!   "appVersion": "0.1.0",
//!   "encrypted": true,
//!   "envelope": { "version": 1, "kdf": { "algorithm": "argon2id", ... }, "nonce": "…", "data": "…" }
//! }
//! ```
//!
//! - **Encrypted** (the default): the whole [`BackupContents`] is sealed in the
//!   project's standard [`EncryptedEnvelope`] (Argon2id + AES-256-GCM) with the
//!   backup passphrase. Nothing but the header above is readable without it.
//!   The header is repeated inside the sealed contents and must match on
//!   restore, so a tampered header is detected.
//! - **Unencrypted** (opt-out): the contents are stored in the clear under
//!   `contents`. Sections that hold secrets (embedded-server passwords) can
//!   only be exported encrypted, and credentials are always sealed in their own
//!   vault envelope — so no secret ever appears in plaintext on disk.
//!
//! One passphrase protects everything: when credentials are included, the
//! vault section is sealed with the same passphrase as the backup.
//!
//! Restore is two-phase ([`restore::plan`] previews without writing, then
//! [`restore::stage`] applies). Store files are **staged** next to the config
//! directory and committed atomically with a single rename; the staged set is
//! swapped into place by [`pending::apply_pending_restore`] on the next startup,
//! **before any store is loaded**, with a full rollback if any file fails. The
//! running app therefore never has its in-memory stores changed underneath it,
//! and a restore is all-or-nothing across every chosen section.

use serde::{Deserialize, Serialize};

use crate::credential::crypto::EncryptedEnvelope;
use crate::credential::vault::{VaultExportFile, VaultImportPreview, VaultImportResult};

pub mod commit;
pub mod export;
pub mod pending;
pub mod restore;
pub mod sections;

#[cfg(test)]
mod tests;

/// Format identifier stamped on every backup file.
pub const BACKUP_FORMAT_ID: &str = "termihub-backup";
/// Backup container format version written by this build.
pub const BACKUP_FORMAT_VERSION: u32 = 1;
/// Oldest backup container format version this build can still read.
pub const MIN_SUPPORTED_BACKUP_FORMAT_VERSION: u32 = 1;
/// Upper bound on the size of a backup file, so a huge or hostile file cannot
/// exhaust memory before it is even parsed.
pub const MAX_BACKUP_FILE_BYTES: usize = 64 * 1024 * 1024;

/// The on-disk backup file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    /// Always [`BACKUP_FORMAT_ID`].
    pub format: String,
    /// The container format version the file was written with.
    pub format_version: u32,
    /// RFC 3339 timestamp of when the backup was created.
    pub created_at: String,
    /// termiHub version that wrote the backup (informational).
    #[serde(default)]
    pub app_version: String,
    /// Whether [`Self::envelope`] (true) or [`Self::contents`] (false) holds the data.
    pub encrypted: bool,
    /// The sealed [`BackupContents`] (encrypted backups only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelope: Option<EncryptedEnvelope>,
    /// The plain [`BackupContents`] (unencrypted backups only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contents: Option<BackupContents>,
}

/// Everything a backup carries. Sealed inside [`BackupFile::envelope`] for an
/// encrypted backup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupContents {
    /// Repeats [`BackupFile::format`] so a tampered header is detected.
    pub format: String,
    /// Repeats [`BackupFile::format_version`].
    pub format_version: u32,
    /// Repeats [`BackupFile::created_at`].
    pub created_at: String,
    /// One entry per backed-up store.
    #[serde(default)]
    pub sections: Vec<BackupSection>,
    /// The encrypted credential vault (PROD-063), sealed with the backup
    /// passphrase. Absent when credentials were not included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<VaultExportFile>,
}

/// One backed-up store: its section id, the schema version of the store file
/// it was read from, and the file's JSON document verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSection {
    /// Stable section id (see [`sections::SECTIONS`]).
    pub id: String,
    /// The store's schema version (its `VersionedStore` version).
    pub schema_version: u32,
    /// The store file's JSON document.
    pub data: serde_json::Value,
}

/// What to put in a backup.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportOptions {
    /// Section ids to include (see [`list_backup_sections`](crate::commands::backup)).
    pub sections: Vec<String>,
    /// Include the encrypted credential vault.
    pub include_credentials: bool,
    /// Encrypt the whole backup with the passphrase.
    pub encrypt: bool,
}

/// Result of an export: the file text plus a summary. The text contains no
/// plaintext secret: secret-bearing sections are only exported encrypted and
/// credentials are always sealed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    /// The backup file's JSON text.
    pub json: String,
    /// Ids of the sections written (sections whose store file does not exist
    /// yet are skipped).
    pub sections: Vec<String>,
    /// Number of credentials in the vault section, when included.
    pub credential_count: Option<u32>,
}

/// A backupable section as shown in the export dialog.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSectionInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    /// The section holds secrets and is only exported in an encrypted backup.
    pub contains_secrets: bool,
    /// The store file exists on this machine (there is something to back up).
    pub present: bool,
    /// Number of items in the store (0 for single-object stores like settings).
    pub item_count: u32,
}

/// The cleartext header of a backup file, readable without the passphrase.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupHeader {
    pub created_at: String,
    pub app_version: String,
    pub encrypted: bool,
    /// Whether a passphrase is needed to preview the backup (encrypted, or an
    /// unencrypted backup that carries a credential vault).
    pub needs_passphrase: bool,
}

/// How a section's data relates to this build.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SectionStatus {
    /// Same schema version as this build.
    Ok,
    /// Older schema version; migrated forward on restore.
    Migrated,
    /// Written by a newer termiHub — refused.
    Newer,
    /// Unreadable or not a valid store of this kind — refused.
    Invalid,
    /// A section this build does not know (from a newer termiHub) — ignored.
    Unknown,
}

/// Merge the backup into the current store, or replace the store with it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// Add items from the backup; items with the same id follow the conflict
    /// strategy. Items only in the current store are kept.
    Merge,
    /// The store becomes exactly the backup's content — current items not in
    /// the backup are removed.
    Replace,
}

/// Preview of one section. Contains no secrets.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSectionPreview {
    pub id: String,
    pub label: String,
    pub status: SectionStatus,
    /// Why a section cannot be restored (newer / invalid / unknown).
    pub message: Option<String>,
    /// The section's schema version in the backup.
    pub schema_version: u32,
    /// The schema version this build reads and writes.
    pub supported_version: u32,
    /// Whether [`RestoreMode::Merge`] is available (list-shaped stores).
    pub supports_merge: bool,
    /// Items in the backup.
    pub item_count: u32,
    /// Items in the current store.
    pub current_count: u32,
    /// Backup items whose id is not in the current store.
    pub new_count: u32,
    /// Backup items whose id exists with different content.
    pub conflict_count: u32,
    /// Backup items identical to the current store.
    pub unchanged_count: u32,
}

/// Preview of the credentials section.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupCredentialsPreview {
    /// Whether the credentials can be restored into the current store.
    pub available: bool,
    /// Why not, when unavailable (storage off / locked / not set up).
    pub unavailable_reason: Option<String>,
    /// The vault import preview, when available.
    pub preview: Option<VaultImportPreview>,
}

/// Preview of a restore, shown before anything is written. Contains no secrets.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestorePreview {
    pub created_at: String,
    pub app_version: String,
    pub encrypted: bool,
    pub sections: Vec<BackupSectionPreview>,
    /// Present when the backup carries a credential vault.
    pub credentials: Option<BackupCredentialsPreview>,
}

/// How to restore one section.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectionRestoreChoice {
    pub id: String,
    pub mode: RestoreMode,
    /// For [`RestoreMode::Merge`]: keep (`skip`) or replace (`overwrite`)
    /// current items that share an id with a backup item.
    pub conflicts: crate::credential::vault::ConflictStrategy,
}

/// What to restore.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreRequest {
    pub sections: Vec<SectionRestoreChoice>,
    /// Restore the credentials with this conflict strategy; `None` skips them.
    pub credentials: Option<crate::credential::vault::ConflictStrategy>,
}

/// Outcome of one restored section. Contains no secrets.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectionRestoreOutcome {
    pub id: String,
    pub label: String,
    pub mode: RestoreMode,
    /// Items in the store after the restore.
    pub resulting_count: u32,
}

/// Outcome of a restore. Contains no secrets.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreResult {
    pub sections: Vec<SectionRestoreOutcome>,
    pub credentials: Option<VaultImportResult>,
    /// Store sections were staged; termiHub must restart to apply them.
    pub restart_required: bool,
}
