use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tracing::{debug, info, warn};

use crate::credential::{
    CredentialKey, CredentialManager, CredentialStore, CredentialStoreStatus, CredentialType,
    KeychainStore, StorageMode,
};

/// Event emitted when the credential store is locked.
const EVENT_STORE_LOCKED: &str = "credential-store-locked";
/// Event emitted when the credential store is unlocked.
const EVENT_STORE_UNLOCKED: &str = "credential-store-unlocked";
/// Event emitted when the credential store status changes (mode switch, setup, etc.).
const EVENT_STORE_STATUS_CHANGED: &str = "credential-store-status-changed";

/// Status information about the credential store, returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStoreStatusInfo {
    /// Current storage mode: `"keychain"`, `"master_password"`, or `"none"`.
    pub mode: String,
    /// Current status: `"unlocked"`, `"locked"`, or `"unavailable"`.
    pub status: String,
    /// Whether the OS keychain is accessible on this system.
    pub keychain_available: bool,
}

/// Result of switching credential stores, returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    /// Number of credentials successfully migrated.
    pub migrated_count: u32,
    /// Warnings for credentials that failed to migrate.
    pub warnings: Vec<String>,
}

fn status_to_string(status: &CredentialStoreStatus) -> &'static str {
    match status {
        CredentialStoreStatus::Unlocked => "unlocked",
        CredentialStoreStatus::Locked => "locked",
        CredentialStoreStatus::Unavailable => "unavailable",
    }
}

fn emit_status_changed(app_handle: &AppHandle, manager: &CredentialManager) {
    let info = build_status_info(manager);
    if let Err(e) = app_handle.emit(EVENT_STORE_STATUS_CHANGED, &info) {
        warn!("Failed to emit {}: {}", EVENT_STORE_STATUS_CHANGED, e);
    }
}

fn build_status_info(manager: &CredentialManager) -> CredentialStoreStatusInfo {
    CredentialStoreStatusInfo {
        mode: manager.get_mode().to_settings_str().to_string(),
        status: status_to_string(&manager.status()).to_string(),
        keychain_available: KeychainStore::is_available(),
    }
}

/// Get the current credential store status.
#[tauri::command]
pub fn get_credential_store_status(
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<CredentialStoreStatusInfo, String> {
    debug!("Getting credential store status");
    Ok(build_status_info(&manager))
}

/// Unlock the master password credential store.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn unlock_credential_store(
    password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Unlocking credential store");

    let result = manager
        .with_master_password_store(|store| {
            if store.is_unlocked() {
                return Err("Store is already unlocked".to_string());
            }
            store.unlock(&password).map_err(|e| e.to_string())
        })
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

    if let Err(e) = app_handle.emit(EVENT_STORE_UNLOCKED, ()) {
        warn!("Failed to emit {}: {}", EVENT_STORE_UNLOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Lock the master password credential store.
#[tauri::command]
pub fn lock_credential_store(
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Locking credential store");

    manager
        .with_master_password_store(|store| {
            store.lock();
        })
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    if let Err(e) = app_handle.emit(EVENT_STORE_LOCKED, ()) {
        warn!("Failed to emit {}: {}", EVENT_STORE_LOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Set up a new master password for the credential store.
///
/// This creates the initial encrypted credentials file. The store must
/// be in master password mode and not already set up.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn setup_master_password(
    password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Setting up master password");

    let result = manager
        .with_master_password_store(|store| store.setup(&password).map_err(|e| e.to_string()))
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

    if let Err(e) = app_handle.emit(EVENT_STORE_UNLOCKED, ()) {
        warn!("Failed to emit {}: {}", EVENT_STORE_UNLOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Change the master password for the credential store.
///
/// Verifies the current password, then re-encrypts all credentials
/// with the new password. The store must be unlocked.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn change_master_password(
    current_password: String,
    new_password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Changing master password");

    let result = manager
        .with_master_password_store(|store| {
            store
                .change_password(&current_password, &new_password)
                .map_err(|e| e.to_string())
        })
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Switch the credential storage backend.
///
/// Optionally migrates existing credentials to the new store.
/// When switching to master password mode, a `master_password` must be provided
/// to set up the new encrypted store.
#[tauri::command]
pub async fn switch_credential_store(
    new_mode: String,
    master_password: Option<String>,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<SwitchResult, String> {
    let target_mode = StorageMode::from_settings_str(Some(&new_mode));
    let current_mode = manager.get_mode();

    info!(
        from = current_mode.to_settings_str(),
        to = target_mode.to_settings_str(),
        "Switching credential store"
    );

    if current_mode == target_mode {
        return Ok(SwitchResult {
            migrated_count: 0,
            warnings: vec!["Already using this storage mode".to_string()],
        });
    }

    // Collect credentials from the current store for migration
    let keys_to_migrate = manager.list_keys().unwrap_or_default();
    let mut credentials_to_migrate = Vec::new();
    for key in &keys_to_migrate {
        if let Ok(Some(value)) = manager.get(key) {
            credentials_to_migrate.push((key.clone(), value));
        }
    }

    // Switch to the new backend
    manager
        .switch_store(target_mode.clone())
        .map_err(|e| e.to_string())?;

    // If switching to master password mode, set up the new store
    if target_mode == StorageMode::MasterPassword {
        let password = master_password
            .ok_or("Master password is required when switching to master password mode")?;

        let setup_result = manager
            .with_master_password_store(|store| {
                if store.has_credentials_file() {
                    // File exists — unlock instead of setup
                    store.unlock(&password).map_err(|e| e.to_string())
                } else {
                    store.setup(&password).map_err(|e| e.to_string())
                }
            })
            .ok_or_else(|| "Failed to access master password store after switch".to_string())?;

        setup_result?;
    }

    // Migrate credentials to the new store
    let mut migrated_count = 0u32;
    let mut warnings = Vec::new();

    for (key, value) in &credentials_to_migrate {
        match manager.set(key, value) {
            Ok(()) => {
                migrated_count += 1;
            }
            Err(e) => {
                warnings.push(format!("Failed to migrate {}: {}", key, e));
            }
        }
    }

    if migrated_count > 0 {
        debug!(
            migrated_count,
            warning_count = warnings.len(),
            "Credential migration complete"
        );
    }

    emit_status_changed(&app_handle, &manager);
    Ok(SwitchResult {
        migrated_count,
        warnings,
    })
}

/// Check whether the OS keychain is accessible.
#[tauri::command]
pub fn check_keychain_available() -> bool {
    KeychainStore::is_available()
}

/// Parse a credential type string from the frontend into a `CredentialType`.
fn parse_credential_type(s: &str) -> Result<CredentialType, String> {
    match s {
        "password" => Ok(CredentialType::Password),
        "key_passphrase" => Ok(CredentialType::KeyPassphrase),
        _ => Err(format!("Unknown credential type: {s}")),
    }
}

/// Resolve a stored credential for a connection.
///
/// Returns the stored password/passphrase, or `null` if none is found.
/// Gracefully returns `None` when the store is locked or unavailable.
#[tauri::command]
pub fn resolve_credential(
    connection_id: String,
    credential_type: String,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<Option<String>, String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = CredentialKey::new(&connection_id, cred_type);
    debug!(
        connection_id = %connection_id,
        credential_type = %credential_type,
        "Resolving credential"
    );
    match manager.get(&key) {
        Ok(value) => Ok(value),
        Err(e) => {
            warn!("Failed to resolve credential for {}: {}", connection_id, e);
            Ok(None)
        }
    }
}

/// Remove a stored credential for a connection.
///
/// Used to clear stale credentials after an authentication failure.
#[tauri::command]
pub fn remove_credential(
    connection_id: String,
    credential_type: String,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = CredentialKey::new(&connection_id, cred_type);
    debug!(
        connection_id = %connection_id,
        credential_type = %credential_type,
        "Removing credential"
    );
    manager.remove(&key).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_credential_type_password() {
        assert_eq!(
            parse_credential_type("password").unwrap(),
            CredentialType::Password
        );
    }

    #[test]
    fn parse_credential_type_key_passphrase() {
        assert_eq!(
            parse_credential_type("key_passphrase").unwrap(),
            CredentialType::KeyPassphrase
        );
    }

    #[test]
    fn parse_credential_type_unknown() {
        let err = parse_credential_type("invalid").unwrap_err();
        assert!(err.contains("Unknown credential type"));
    }
}
