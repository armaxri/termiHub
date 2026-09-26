//! Vault import: parse, decrypt, preview and apply an export (PROD-063).

use std::collections::{HashMap, HashSet};

use tracing::info;
use zeroize::{Zeroize, Zeroizing};

use super::{
    ConflictStrategy, OpenedVault, VaultConflict, VaultError, VaultExportFile, VaultImportPreview,
    VaultImportResult, VaultPayload, MAX_VAULT_FILE_BYTES, MIN_SUPPORTED_VAULT_FORMAT_VERSION,
    VAULT_FORMAT_ID, VAULT_FORMAT_VERSION,
};
use crate::credential::crypto::{
    classify_envelope_version, decrypt_with_password, DecryptError, VersionSupport,
};
use crate::credential::types::{CredentialKey, CredentialType, StorageMode};
use crate::credential::CredentialStore;

/// Check a format version against what this build reads.
pub(super) fn check_format_version(version: u32) -> Result<(), VaultError> {
    if version > VAULT_FORMAT_VERSION {
        return Err(VaultError::UnsupportedVersion {
            message: format!(
                "This vault export was created by a newer version of termiHub (format version \
                 {version}; this build reads up to {VAULT_FORMAT_VERSION}). Update termiHub to \
                 import it."
            ),
        });
    }
    if version < MIN_SUPPORTED_VAULT_FORMAT_VERSION {
        return Err(VaultError::UnsupportedVersion {
            message: format!(
                "This vault export uses format version {version}, which is no longer supported."
            ),
        });
    }
    Ok(())
}

/// Parse and structurally validate an export file without decrypting it.
pub fn parse(json: &str) -> Result<VaultExportFile, VaultError> {
    if json.len() > MAX_VAULT_FILE_BYTES {
        return Err(VaultError::invalid(
            "The file is too large to be a termiHub credential vault export.",
        ));
    }
    let file: VaultExportFile = serde_json::from_str(json)
        .map_err(|_| VaultError::invalid("The file is not a termiHub credential vault export."))?;
    if file.format != VAULT_FORMAT_ID {
        return Err(VaultError::invalid(
            "The file is not a termiHub credential vault export.",
        ));
    }
    check_format_version(file.format_version)?;
    Ok(file)
}

/// Decrypt a parsed export with `passphrase`.
///
/// Fails with [`VaultError::WrongPassphrase`] when authentication fails (wrong
/// passphrase or modified ciphertext) and with [`VaultError::InvalidFile`] when
/// the decrypted contents do not match the header or are malformed. The
/// decrypted plaintext buffer is zeroized on every path.
pub fn open(file: &VaultExportFile, passphrase: &str) -> Result<OpenedVault, VaultError> {
    if file.format != VAULT_FORMAT_ID {
        return Err(VaultError::invalid(
            "The file is not a termiHub credential vault export.",
        ));
    }
    check_format_version(file.format_version)?;
    match classify_envelope_version(file.envelope.version) {
        VersionSupport::Supported => {}
        VersionSupport::Newer => {
            return Err(VaultError::UnsupportedVersion {
                message: format!(
                    "This vault export was encrypted by a newer version of termiHub (envelope \
                     version {}). Update termiHub to import it.",
                    file.envelope.version
                ),
            })
        }
        VersionSupport::TooOld => {
            return Err(VaultError::UnsupportedVersion {
                message: format!(
                    "This vault export uses envelope version {}, which is no longer supported.",
                    file.envelope.version
                ),
            })
        }
    }

    let plaintext = Zeroizing::new(decrypt_with_password(passphrase, &file.envelope).map_err(
        |e| match e {
            DecryptError::WrongPassword => VaultError::WrongPassphrase {
                message:
                    "Wrong passphrase, or the file has been modified or corrupted.".to_string(),
            },
            DecryptError::Other(inner) => {
                VaultError::invalid(format!("The vault export is damaged: {inner}"))
            }
        },
    )?);

    let payload: VaultPayload = serde_json::from_slice(&plaintext)
        .map_err(|_| VaultError::invalid("The decrypted vault contents are malformed."))?;
    drop(plaintext);

    if payload.format != file.format || payload.format_version != file.format_version {
        return Err(VaultError::invalid(
            "The file header does not match its encrypted contents — the file has been modified.",
        ));
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(payload.entries.len());
    for entry in &payload.entries {
        if entry.connection_id.is_empty() {
            return Err(VaultError::invalid(
                "The vault export contains a credential without a connection id.",
            ));
        }
        let credential_type =
            CredentialType::from_type_str(&entry.credential_type).ok_or_else(|| {
                VaultError::UnsupportedVersion {
                    message: format!(
                        "The vault export contains a credential type this version of termiHub \
                         does not support (\"{}\"). Update termiHub to import it.",
                        entry.credential_type
                    ),
                }
            })?;
        let key = CredentialKey::new(&entry.connection_id, credential_type);
        if !seen.insert(key.to_string()) {
            return Err(VaultError::invalid(format!(
                "The vault export lists credential {key} more than once."
            )));
        }
        entries.push((key, Zeroizing::new(entry.value.clone())));
    }

    Ok(OpenedVault {
        created_at: file.created_at.clone(),
        entries,
    })
}

/// Parse and decrypt an export file in one step.
pub fn open_json(json: &str, passphrase: &str) -> Result<OpenedVault, VaultError> {
    let file = parse(json)?;
    open(&file, passphrase)
}

/// How one imported credential relates to the current store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryState {
    New,
    Unchanged,
    Conflict,
}

/// Classify every entry of `vault` against `store`.
fn classify(
    vault: &OpenedVault,
    store: &dyn CredentialStore,
) -> Result<Vec<EntryState>, VaultError> {
    vault
        .entries
        .iter()
        .map(|(key, value)| {
            let existing = store
                .get(key)
                .map_err(|e| {
                    VaultError::other(format!("Could not read the current credential store: {e}"))
                })?
                .map(Zeroizing::new);
            Ok(match existing {
                None => EntryState::New,
                Some(ref current) if current.as_str() == value.as_str() => EntryState::Unchanged,
                Some(_) => EntryState::Conflict,
            })
        })
        .collect()
}

/// Build the import preview for `vault` against the current `store`.
///
/// `owners` maps the ids of saved connections and agents on this machine to
/// their display names; it drives the conflict labels and the unknown-owner
/// count. Nothing is written.
pub fn plan_import(
    vault: &OpenedVault,
    store: &dyn CredentialStore,
    target_mode: &StorageMode,
    owners: &HashMap<String, String>,
) -> Result<VaultImportPreview, VaultError> {
    let states = classify(vault, store)?;
    let mut preview = VaultImportPreview {
        created_at: vault.created_at.clone(),
        target_mode: target_mode.to_settings_str().to_string(),
        total_count: vault.entries.len(),
        new_count: 0,
        unchanged_count: 0,
        conflict_count: 0,
        conflicts: Vec::new(),
        unknown_owner_count: 0,
    };
    for ((key, _), state) in vault.entries.iter().zip(states) {
        if !owners.contains_key(&key.connection_id) {
            preview.unknown_owner_count += 1;
        }
        match state {
            EntryState::New => preview.new_count += 1,
            EntryState::Unchanged => preview.unchanged_count += 1,
            EntryState::Conflict => {
                preview.conflict_count += 1;
                preview.conflicts.push(VaultConflict {
                    connection_id: key.connection_id.clone(),
                    credential_type: key.credential_type.to_string(),
                    owner_name: owners.get(&key.connection_id).cloned(),
                });
            }
        }
    }
    Ok(preview)
}

/// Import `vault` into `store` using `strategy` for conflicts.
///
/// All selected entries are written through [`CredentialStore::set_many`] as
/// one all-or-nothing batch: on failure nothing is changed.
pub fn apply_import(
    vault: &OpenedVault,
    store: &dyn CredentialStore,
    strategy: ConflictStrategy,
) -> Result<VaultImportResult, VaultError> {
    let states = classify(vault, store)?;
    let mut result = VaultImportResult {
        imported_count: 0,
        overwritten_count: 0,
        skipped_count: 0,
        unchanged_count: 0,
    };

    let mut batch: Vec<(CredentialKey, String)> = Vec::new();
    for ((key, value), state) in vault.entries.iter().zip(states) {
        match (state, strategy) {
            (EntryState::New, _) => {
                result.imported_count += 1;
                batch.push((key.clone(), value.to_string()));
            }
            (EntryState::Unchanged, _) => result.unchanged_count += 1,
            (EntryState::Conflict, ConflictStrategy::Overwrite) => {
                result.overwritten_count += 1;
                batch.push((key.clone(), value.to_string()));
            }
            (EntryState::Conflict, ConflictStrategy::Skip) => result.skipped_count += 1,
        }
    }

    let outcome = if batch.is_empty() {
        Ok(())
    } else {
        store.set_many(&batch)
    };
    for (_, value) in batch.iter_mut() {
        value.zeroize();
    }
    outcome.map_err(|e| {
        VaultError::other(format!(
            "The import failed and no credentials were changed: {e:#}"
        ))
    })?;

    info!(
        imported = result.imported_count,
        overwritten = result.overwritten_count,
        skipped = result.skipped_count,
        unchanged = result.unchanged_count,
        "credential vault imported"
    );
    Ok(result)
}
