//! Encrypted credential-vault export and import (PROD-063).
//!
//! A vault export is a self-describing JSON file that carries every saved
//! credential, sealed with a user-chosen **export passphrase** that is
//! independent of the store's master password:
//!
//! ```json
//! {
//!   "format": "termihub-credential-vault",
//!   "formatVersion": 1,
//!   "createdAt": "2026-09-26T12:00:00+00:00",
//!   "envelope": { "version": 1, "kdf": { "algorithm": "argon2id", ... }, "nonce": "…", "data": "…" }
//! }
//! ```
//!
//! - The `envelope` is the project's standard [`EncryptedEnvelope`]
//!   (Argon2id + AES-256-GCM, versioned, KDF params + salt + nonce carried in the
//!   file). New exports are always sealed with [`Argon2Cost::current`], which the
//!   compile-time guard in [`crypto`](super::crypto) pins to the production cost
//!   outside this crate's unit-test binary (#3355/#3360).
//! - The header (`format`, `formatVersion`) is repeated **inside** the encrypted
//!   payload and must match on import, so a tampered header is detected even
//!   though it is stored in the clear.
//! - No count, connection id or other metadata about the secrets is stored in
//!   the clear.
//!
//! The [`VaultExportFile`] object is deliberately a standalone value so a later
//! unified backup (PROD-068) can embed it verbatim as its credentials section.
//!
//! Import is two-phase: [`plan_import`] decrypts nothing new — it classifies an
//! already-opened vault against the **current** store (new / unchanged /
//! conflicting) for a preview, and [`apply_import`] writes the selected entries
//! through [`CredentialStore::set_many`](crate::credential::CredentialStore::set_many) as a single all-or-nothing batch.
//! A wrong passphrase or a tampered file fails before any write.

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::crypto::EncryptedEnvelope;
use super::types::{CredentialKey, CredentialStoreStatus, StorageMode};
use super::{CredentialManager, CredentialStore};

mod export;
mod import;

pub use export::{collect_entries, seal, to_json};
pub use import::{apply_import, open as open_file, open_json, plan_import};

/// Format identifier stamped on every vault export file.
pub const VAULT_FORMAT_ID: &str = "termihub-credential-vault";
/// Vault export format version written by this build.
///
/// Reads accept `MIN_SUPPORTED_VAULT_FORMAT_VERSION..=VAULT_FORMAT_VERSION`,
/// mirroring the envelope migration contract in [`crypto`](super::crypto).
pub const VAULT_FORMAT_VERSION: u32 = 1;
/// Oldest vault export format version this build can still read.
pub const MIN_SUPPORTED_VAULT_FORMAT_VERSION: u32 = 1;
/// Minimum length (in characters) of an export passphrase.
///
/// Higher than the master-password minimum because an export file is meant to
/// be copied off the machine, where it is open to unlimited offline guessing.
pub const MIN_EXPORT_PASSPHRASE_LEN: usize = 12;
/// Why a vault export is refused in OS-keychain mode (until #3433 lands).
pub const KEYCHAIN_EXPORT_BLOCKED_MESSAGE: &str = "Export from the OS keychain requires system \
     authentication — not yet available (tracked in #3433).";
/// Upper bound on the size of an import file, so a huge or hostile file cannot
/// exhaust memory before it is even parsed.
pub const MAX_VAULT_FILE_BYTES: usize = 16 * 1024 * 1024;

/// A vault export failure, serialized to the frontend as
/// `{ "kind": "<variant>", "message": "…" }` so the UI can branch on a stable,
/// locale-invariant `kind` rather than on the English message.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Serialize, thiserror::Error, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VaultError {
    /// The export passphrase was wrong, or the file was tampered with or
    /// corrupted (indistinguishable under authenticated encryption).
    #[error("{message}")]
    WrongPassphrase { message: String },
    /// The file is not a readable termiHub credential vault export.
    #[error("{message}")]
    InvalidFile { message: String },
    /// The file's format version is not readable by this build.
    #[error("{message}")]
    UnsupportedVersion { message: String },
    /// The chosen export passphrase does not meet the requirements.
    #[error("{message}")]
    WeakPassphrase { message: String },
    /// Credential storage is off — there is no store to export from / into.
    #[error("{message}")]
    StoreUnavailable { message: String },
    /// The master-password store is locked.
    #[error("{message}")]
    StoreLocked { message: String },
    /// The master password given for re-authentication was wrong.
    #[error("{message}")]
    WrongMasterPassword { message: String },
    /// The current store cannot re-authenticate the user, so the export is
    /// refused (OS keychain mode until #3433 adds OS-level authentication).
    #[error("{message}")]
    ReauthUnavailable { message: String },
    /// Any other failure (store read/write error, serialization, …).
    #[error("{message}")]
    Other { message: String },
}

impl VaultError {
    fn other(message: impl Into<String>) -> Self {
        VaultError::Other {
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        VaultError::InvalidFile {
            message: message.into(),
        }
    }
}

/// The on-disk vault export file. Only ciphertext and non-secret format
/// metadata are stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportFile {
    /// Always [`VAULT_FORMAT_ID`].
    pub format: String,
    /// The vault format version the file was written with.
    pub format_version: u32,
    /// RFC 3339 timestamp of when the export was created.
    pub created_at: String,
    /// The sealed payload.
    pub envelope: EncryptedEnvelope,
}

/// The plaintext sealed inside [`VaultExportFile::envelope`]. Never written to
/// disk in this form.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultPayload {
    format: String,
    format_version: u32,
    entries: Vec<VaultPayloadEntry>,
}

/// One credential inside a [`VaultPayload`]. The value is zeroized on drop.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultPayloadEntry {
    connection_id: String,
    credential_type: String,
    value: String,
}

impl Drop for VaultPayloadEntry {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// A collected or decrypted credential; the value is zeroized on drop.
pub type VaultSecret = (CredentialKey, Zeroizing<String>);

/// A decrypted vault held in memory for preview / import. Every value is
/// zeroized when this is dropped.
pub struct OpenedVault {
    /// When the export was created (from the file header).
    pub created_at: String,
    /// The decrypted credentials, in file order.
    pub entries: Vec<VaultSecret>,
}

/// How to treat an imported credential whose key already exists in the
/// current store with a different value.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStrategy {
    /// Keep the existing value.
    Skip,
    /// Replace the existing value with the imported one.
    Overwrite,
}

/// A credential in the import file that collides with an existing one.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultConflict {
    pub connection_id: String,
    /// `"password"`, `"key_passphrase"` or `"sudo_password"`.
    pub credential_type: String,
    /// Display name of the owning connection/agent on this machine, if known.
    pub owner_name: Option<String>,
}

/// Preview of an import, shown before anything is written. Contains no secrets.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultImportPreview {
    /// When the export was created.
    pub created_at: String,
    /// The store mode the credentials will be imported into.
    pub target_mode: String,
    /// Credentials in the file.
    pub total_count: usize,
    /// Credentials that do not exist in the current store.
    pub new_count: usize,
    /// Credentials already present with the identical value.
    pub unchanged_count: usize,
    /// Credentials present with a different value.
    pub conflict_count: usize,
    /// The conflicting credentials (keys only).
    pub conflicts: Vec<VaultConflict>,
    /// Credentials whose connection/agent id is not a saved connection or agent
    /// on this machine (they are still imported, and apply once a connection
    /// with that id exists — e.g. after importing the connections file).
    pub unknown_owner_count: usize,
}

/// Outcome of an applied import. Contains no secrets.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultImportResult {
    /// New credentials written.
    pub imported_count: usize,
    /// Existing credentials replaced (overwrite strategy).
    pub overwritten_count: usize,
    /// Conflicting credentials left untouched (skip strategy).
    pub skipped_count: usize,
    /// Credentials already present with the identical value.
    pub unchanged_count: usize,
}

/// Gate an export behind re-authentication of the current store.
///
/// - `none` mode: refused — there is no vault.
/// - master password: the store must be **unlocked** and `master_password`
///   must verify against it (re-auth), so an unattended unlocked session cannot
///   be used to walk off with every secret.
/// - OS keychain: **refused**. termiHub can read its own keychain items without
///   an OS prompt, so there is no re-authentication step that stops someone at
///   an unattended, unlocked machine from exporting every secret. Export stays
///   blocked until OS-level user authentication exists (#3433).
pub fn authorize_export(
    manager: &CredentialManager,
    master_password: Option<&str>,
) -> Result<(), VaultError> {
    match manager.get_mode() {
        StorageMode::None => Err(VaultError::StoreUnavailable {
            message: "Credential storage is turned off — there are no saved credentials to export."
                .to_string(),
        }),
        StorageMode::OsKeychain => Err(VaultError::ReauthUnavailable {
            message: KEYCHAIN_EXPORT_BLOCKED_MESSAGE.to_string(),
        }),
        StorageMode::MasterPassword => manager
            .with_master_password_store(|store| {
                match store.status() {
                    CredentialStoreStatus::Unlocked => {}
                    CredentialStoreStatus::Locked => {
                        return Err(VaultError::StoreLocked {
                            message: "Unlock the credential store before exporting it.".to_string(),
                        })
                    }
                    CredentialStoreStatus::Unavailable => {
                        return Err(VaultError::StoreUnavailable {
                            message: "No master password has been set up yet — there is nothing \
                                      to export."
                                .to_string(),
                        })
                    }
                }
                let password = master_password.filter(|p| !p.is_empty()).ok_or_else(|| {
                    VaultError::WrongMasterPassword {
                        message: "Enter your master password to confirm the export.".to_string(),
                    }
                })?;
                match store.verify_password(password) {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(VaultError::WrongMasterPassword {
                        message: "The master password is incorrect.".to_string(),
                    }),
                    Err(e) => Err(VaultError::other(format!(
                        "Could not verify the master password: {e}"
                    ))),
                }
            })
            .unwrap_or_else(|| Err(VaultError::other("Credential store mode changed"))),
    }
}

/// Gate an import: the current store must be able to accept credentials.
pub fn authorize_import(manager: &CredentialManager) -> Result<(), VaultError> {
    match manager.get_mode() {
        StorageMode::None => Err(VaultError::StoreUnavailable {
            message: "Credential storage is turned off. Choose Master Password or OS Keychain \
                      first, then import the vault."
                .to_string(),
        }),
        StorageMode::OsKeychain => Ok(()),
        StorageMode::MasterPassword => match manager.status() {
            CredentialStoreStatus::Unlocked => Ok(()),
            CredentialStoreStatus::Locked => Err(VaultError::StoreLocked {
                message: "Unlock the credential store before importing into it.".to_string(),
            }),
            CredentialStoreStatus::Unavailable => Err(VaultError::StoreUnavailable {
                message: "Set up a master password before importing credentials.".to_string(),
            }),
        },
    }
}

/// Validate an export passphrase. `master_password`, when known, must differ
/// from it so the export stays independent of the store's own secret.
pub fn validate_export_passphrase(
    passphrase: &str,
    master_password: Option<&str>,
) -> Result<(), VaultError> {
    if passphrase.chars().count() < MIN_EXPORT_PASSPHRASE_LEN {
        return Err(VaultError::WeakPassphrase {
            message: format!(
                "The export passphrase must be at least {MIN_EXPORT_PASSPHRASE_LEN} characters."
            ),
        });
    }
    if master_password.is_some_and(|mp| mp == passphrase) {
        return Err(VaultError::WeakPassphrase {
            message: "The export passphrase must be different from your master password."
                .to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
