//! Tauri commands for the encrypted credential-vault export / import (PROD-063).
//!
//! The export returns the sealed file **text** (ciphertext + non-secret format
//! metadata); the frontend writes it to the path the user picked. The import
//! takes that text back. Plaintext secrets never cross the IPC boundary, and
//! the passphrases received here are zeroized once used.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tracing::{info, warn};
use zeroize::Zeroizing;

use crate::connection::manager::ConnectionManager;
use crate::credential::named::NamedCredentialRegistry;
use crate::credential::vault::{
    self, ConflictStrategy, VaultError, VaultImportPreview, VaultImportResult,
};
use crate::credential::{CredentialKey, CredentialManager, CredentialType};
use crate::embedded_servers::server_manager::EmbeddedServerManager;

/// Map every saved connection and agent id to its display name.
///
/// Used to probe the OS keychain (which cannot enumerate its items) during an
/// export and to label conflicts in the import preview.
///
/// Embedded-server passwords (#3514) are owned by their server, labelled
/// "<server name> (FTP login | HTTP Basic auth)". Shared named credentials
/// (#3557) are owned by `named-credential:<id>`, labelled
/// "<name> (shared credential)".
pub(crate) fn known_owners(
    connection_manager: &ConnectionManager,
    app_handle: &AppHandle,
) -> Result<HashMap<String, String>, String> {
    // Saved connections of the main store and of every enabled external file
    // (the latter under their file-scoped owner ids, #3591), and agents.
    let mut owners = connection_manager
        .credential_owner_names()
        .map_err(|e| e.to_string())?;
    if let Some(servers) = app_handle.try_state::<Arc<EmbeddedServerManager>>() {
        owners.extend(servers.vault_owners());
    }
    // Shared named credentials (#3557), labelled "<name> (shared credential)".
    if let Some(named) = app_handle.try_state::<Arc<NamedCredentialRegistry>>() {
        owners.extend(named.owner_labels());
    }
    Ok(owners)
}

/// Every credential owner id termiHub can derive from its own state: saved
/// connections (scoped and legacy bare ids) and agents, embedded servers and
/// shared named credentials. Fails when the saved connections cannot be read,
/// so callers never act on an incomplete key set.
///
/// Used to probe the OS keychain, which cannot enumerate its items: the vault
/// export and the store switch, which seed the key index on demand (#3434,
/// #3844). Agent
/// graphical secrets (`agent-graphical:*`) live under definitions held on the
/// agent host; their names are recorded as index candidates (without reading
/// the keychain) when an agent's definitions are listed.
pub(crate) fn derivable_owner_ids(
    connection_manager: &ConnectionManager,
    app_handle: &AppHandle,
) -> Result<Vec<String>, String> {
    let mut ids = connection_manager
        .credential_seed_owner_ids()
        .map_err(|e| e.to_string())?;
    if let Some(servers) = app_handle.try_state::<Arc<EmbeddedServerManager>>() {
        ids.extend(servers.vault_owners().into_iter().map(|(id, _)| id));
    }
    if let Some(named) = app_handle.try_state::<Arc<NamedCredentialRegistry>>() {
        ids.extend(named.owner_labels().into_iter().map(|(id, _)| id));
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// Every credential key of every [`derivable_owner_ids`] owner (all types).
pub(crate) fn derivable_credential_keys(
    connection_manager: &ConnectionManager,
    app_handle: &AppHandle,
) -> Result<Vec<CredentialKey>, String> {
    derivable_owner_ids(connection_manager, app_handle).map(|ids| keys_for_owners(&ids))
}

/// Every credential type of every owner in `owner_ids`.
pub(crate) fn keys_for_owners(owner_ids: &[String]) -> Vec<CredentialKey> {
    owner_ids
        .iter()
        .flat_map(|id| {
            CredentialType::ALL
                .into_iter()
                .map(move |t| CredentialKey::new(id, t))
        })
        .collect()
}

/// Decrypt a vault file and preview what importing it would do. Writes nothing.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn preview_credential_vault_import(
    json: String,
    passphrase: String,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
    app_handle: AppHandle,
) -> Result<VaultImportPreview, VaultError> {
    let passphrase = Zeroizing::new(passphrase);
    vault::authorize_import(&manager)?;

    let opened = vault::open_json(&json, &passphrase)?;
    let owners = known_owners(&connection_manager, &app_handle).unwrap_or_else(|e| {
        warn!("Could not read saved connections for the vault import preview: {e}");
        HashMap::new()
    });
    vault::plan_import(&opened, &**manager, &manager.get_mode(), &owners)
}

/// Import a vault file into the **current** credential store.
///
/// `strategy` is `"skip"` (keep existing values) or `"overwrite"`. The write is
/// all-or-nothing: a wrong passphrase, a tampered file or a failed write leaves
/// the store unchanged.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn import_credential_vault(
    json: String,
    passphrase: String,
    strategy: ConflictStrategy,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<VaultImportResult, VaultError> {
    let passphrase = Zeroizing::new(passphrase);
    info!(
        mode = manager.get_mode().to_settings_str(),
        strategy = ?strategy,
        "Importing credential vault"
    );
    vault::authorize_import(&manager)?;

    let opened = vault::open_json(&json, &passphrase)?;
    vault::apply_import(&opened, &**manager, strategy)
}
