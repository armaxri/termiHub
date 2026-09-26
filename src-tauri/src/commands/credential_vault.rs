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
use crate::credential::vault::{
    self, ConflictStrategy, VaultError, VaultImportPreview, VaultImportResult,
};
use crate::credential::CredentialManager;
use crate::embedded_servers::server_manager::EmbeddedServerManager;

/// Map every saved connection and agent id to its display name.
///
/// Used to probe the OS keychain (which cannot enumerate its items) during an
/// export and to label conflicts in the import preview.
///
/// Embedded-server passwords (#3514) are owned by their server, labelled
/// "<server name> (FTP login | HTTP Basic auth)".
pub(crate) fn known_owners(
    connection_manager: &ConnectionManager,
    app_handle: &AppHandle,
) -> Result<HashMap<String, String>, String> {
    let store = connection_manager.get_all().map_err(|e| e.to_string())?;
    let mut owners = HashMap::new();
    for conn in store.connections {
        owners.insert(conn.id, conn.name);
    }
    for agent in store.agents {
        owners.insert(agent.id, agent.name);
    }
    if let Some(servers) = app_handle.try_state::<EmbeddedServerManager>() {
        owners.extend(servers.vault_owners());
    }
    Ok(owners)
}

/// Export every saved credential as an encrypted vault file.
///
/// Requires re-authentication: in master-password mode the store must be
/// unlocked and `master_password` must verify. In OS-keychain mode the OS must
/// verify the user (Touch ID / Windows Hello) for this export (#3433) —
/// refused as `reauthFailed` when cancelled or failed and `reauthUnavailable`
/// where OS verification does not exist. `export_passphrase` (entered twice in
/// the UI) seals the file and must differ from the master password.
/// Returns the file's JSON text.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn export_credential_vault(
    master_password: Option<String>,
    export_passphrase: String,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
    app_handle: AppHandle,
) -> Result<String, VaultError> {
    let master_password = master_password.map(Zeroizing::new);
    let export_passphrase = Zeroizing::new(export_passphrase);
    let mode = manager.get_mode();
    info!(mode = mode.to_settings_str(), "Exporting credential vault");

    // Validate the passphrase first so a weak one is rejected before the
    // user is asked for Touch ID / Windows Hello.
    vault::validate_export_passphrase(
        &export_passphrase,
        master_password.as_deref().map(String::as_str),
    )?;
    vault::authorize_export(&manager, master_password.as_deref().map(String::as_str))?;

    let owner_ids: Vec<String> = known_owners(&connection_manager, &app_handle)
        .map_err(|e| VaultError::Other {
            message: format!("Could not read the saved connections: {e}"),
        })?
        .into_keys()
        .collect();

    let entries = vault::collect_entries(&**manager, &owner_ids)?;
    let file = vault::seal(
        &entries,
        &export_passphrase,
        chrono::Utc::now().to_rfc3339(),
    )?;
    let json = vault::to_json(&file)?;

    // Counts only — never keys' values.
    info!(
        count = entries.len(),
        mode = mode.to_settings_str(),
        "credential vault exported"
    );
    Ok(json)
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
