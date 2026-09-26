//! Vault export: collect credentials from a store and seal them (PROD-063).

use std::collections::HashSet;

use zeroize::Zeroizing;

use super::{
    VaultError, VaultExportFile, VaultPayload, VaultPayloadEntry, VaultSecret, VAULT_FORMAT_ID,
    VAULT_FORMAT_VERSION,
};
use crate::credential::crypto::encrypt_with_password;
use crate::credential::types::{CredentialKey, CredentialType};
use crate::credential::CredentialStore;

/// Read every credential the export should carry from `store`.
///
/// Keys come from [`CredentialStore::list_keys`] plus every credential type
/// for each id in `known_owner_ids` — the OS keychain cannot enumerate its
/// items, so the saved connections and agents are probed explicitly. Any read
/// error aborts the export rather than silently producing an incomplete
/// backup.
pub fn collect_entries(
    store: &dyn CredentialStore,
    known_owner_ids: &[String],
) -> Result<Vec<VaultSecret>, VaultError> {
    let mut keys: Vec<CredentialKey> = store
        .list_keys()
        .map_err(|e| VaultError::other(format!("Could not read the credential store: {e}")))?;
    for id in known_owner_ids {
        for credential_type in CredentialType::ALL {
            keys.push(CredentialKey::new(id, credential_type));
        }
    }

    let mut seen = HashSet::new();
    keys.retain(|k| seen.insert(k.to_string()));
    keys.sort_by_key(|k| k.to_string());

    let mut entries = Vec::new();
    for key in keys {
        match store.get(&key) {
            Ok(Some(value)) => entries.push((key, Zeroizing::new(value))),
            Ok(None) => {}
            Err(e) => {
                return Err(VaultError::other(format!(
                    "Could not read credential {key} from the store: {e}"
                )))
            }
        }
    }
    Ok(entries)
}

/// Seal `entries` into a [`VaultExportFile`] with `passphrase`.
///
/// The plaintext payload only ever exists in memory and is zeroized as soon as
/// it has been encrypted.
pub fn seal(
    entries: &[VaultSecret],
    passphrase: &str,
    created_at: String,
) -> Result<VaultExportFile, VaultError> {
    let payload = VaultPayload {
        format: VAULT_FORMAT_ID.to_string(),
        format_version: VAULT_FORMAT_VERSION,
        entries: entries
            .iter()
            .map(|(key, value)| VaultPayloadEntry {
                connection_id: key.connection_id.clone(),
                credential_type: key.credential_type.to_string(),
                value: value.to_string(),
            })
            .collect(),
    };
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&payload)
            .map_err(|e| VaultError::other(format!("Failed to serialize the vault: {e}")))?,
    );
    drop(payload);

    let envelope = encrypt_with_password(passphrase, &plaintext)
        .map_err(|e| VaultError::other(format!("Failed to encrypt the vault: {e}")))?;

    Ok(VaultExportFile {
        format: VAULT_FORMAT_ID.to_string(),
        format_version: VAULT_FORMAT_VERSION,
        created_at,
        envelope,
    })
}

/// Serialize a sealed export to the JSON text written to the export file.
pub fn to_json(file: &VaultExportFile) -> Result<String, VaultError> {
    serde_json::to_string_pretty(file)
        .map_err(|e| VaultError::other(format!("Failed to serialize the export: {e}")))
}
