//! Tauri commands for OS user verification and biometric unlock
//! (#3433, PROD-064).
//!
//! OS prompts block until the user answers, so the prompting commands are
//! async (they run off the main thread). No secret crosses the IPC boundary:
//! the master password sent to opt in is zeroized once used, and the vault
//! key never leaves the backend.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tracing::{info, warn};
use zeroize::Zeroizing;

use crate::commands::credential::{
    auto_lock_permits_unlock, emit_status_changed, EVENT_STORE_UNLOCKED,
};
use crate::credential::biometric_unlock::{BiometricUnlockError, BiometricUnlockStatus};
use crate::credential::os_auth::{OsAuthCapability, OsAuthPurpose};
use crate::credential::CredentialManager;

/// What OS user verification can do on this machine, for the UI.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OsAuthInfo {
    /// Re-authentication before exporting from the OS keychain.
    pub export_reauth: OsAuthCapability,
    /// Biometric unlock of the master-password store.
    pub biometric_unlock: BiometricUnlockStatus,
}

/// Build the [`OsAuthInfo`] for `manager`. Never prompts.
pub(crate) fn os_auth_info(manager: &CredentialManager) -> OsAuthInfo {
    OsAuthInfo {
        export_reauth: manager.os_auth_capability(OsAuthPurpose::ReauthExport),
        biometric_unlock: manager.biometric_unlock_status(),
    }
}

/// Report OS-verification capabilities and the biometric-unlock state.
#[tauri::command]
pub fn get_os_auth_info(manager: State<'_, Arc<CredentialManager>>) -> OsAuthInfo {
    os_auth_info(&manager)
}

/// Turn on biometric unlock. Requires the unlocked master-password store,
/// the correct `master_password`, and a successful OS verification.
#[tauri::command]
pub async fn enable_biometric_unlock(
    master_password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<BiometricUnlockStatus, BiometricUnlockError> {
    let master_password = Zeroizing::new(master_password);
    info!("Enabling biometric unlock");
    manager.enable_biometric_unlock(&master_password)?;
    emit_status_changed(&app_handle, &manager);
    Ok(manager.biometric_unlock_status())
}

/// Turn off biometric unlock (deletes the stored key). Idempotent.
#[tauri::command]
pub fn disable_biometric_unlock(
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<BiometricUnlockStatus, BiometricUnlockError> {
    info!("Disabling biometric unlock");
    manager
        .disable_biometric_unlock()
        .map_err(|e| BiometricUnlockError::other(format!("{e:#}")))?;
    emit_status_changed(&app_handle, &manager);
    Ok(manager.biometric_unlock_status())
}

/// Unlock the master-password store with Touch ID / Windows Hello.
///
/// Subject to the same auto-lock fail-safe gate as a password unlock
/// (WA-RS-004): refused when no auto-lock timer is installed.
#[tauri::command]
pub async fn unlock_credential_store_biometric(
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), BiometricUnlockError> {
    info!("Unlocking credential store with biometrics");
    guarded_biometric_unlock(&manager)?;
    if let Err(e) = app_handle.emit(EVENT_STORE_UNLOCKED, ()) {
        warn!("Failed to emit {}: {}", EVENT_STORE_UNLOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Biometric unlock behind the auto-lock gate; notifies the timer on success.
pub(crate) fn guarded_biometric_unlock(
    manager: &CredentialManager,
) -> Result<(), BiometricUnlockError> {
    auto_lock_permits_unlock(manager.has_auto_lock_timer())
        .map_err(BiometricUnlockError::store_unavailable)?;
    manager.unlock_with_biometrics()?;
    manager.notify_auto_lock_unlocked();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::biometric_unlock::MemorySlot;
    use crate::credential::os_auth::mock::MockVerifier;
    use crate::credential::{CredentialStore, StorageMode};

    fn manager(verifier: MockVerifier) -> (tempfile::TempDir, CredentialManager) {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf())
            .with_os_auth(Box::new(verifier))
            .with_biometric_slot(Box::new(MemorySlot::default()));
        mgr.with_master_password_store(|s| s.setup("pw"))
            .unwrap()
            .unwrap();
        (dir, mgr)
    }

    #[test]
    fn biometric_unlock_refused_without_auto_lock_timer() {
        // WA-RS-004 applies to biometric unlock too: without a live auto-lock
        // timer the store must stay locked, and no prompt is shown.
        let verifier = std::sync::Arc::new(MockVerifier::succeeding(2, None));
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf())
            .with_os_auth(Box::new(verifier.clone()))
            .with_biometric_slot(Box::new(MemorySlot::default()));
        mgr.with_master_password_store(|s| s.setup("pw"))
            .unwrap()
            .unwrap();
        mgr.enable_biometric_unlock("pw").unwrap();
        mgr.with_master_password_store(|s| s.lock()).unwrap();

        assert!(matches!(
            guarded_biometric_unlock(&mgr),
            Err(BiometricUnlockError::StoreUnavailable { .. })
        ));
        assert_eq!(verifier.calls().len(), 1, "only the enable prompt");
        assert_eq!(
            mgr.status(),
            crate::credential::CredentialStoreStatus::Locked
        );
    }

    #[test]
    fn info_reports_capabilities() {
        let (_dir, mgr) = manager(MockVerifier::succeeding(1, None));
        let info = os_auth_info(&mgr);
        assert!(info.export_reauth.available);
        assert!(info.biometric_unlock.supported);
        assert!(!info.biometric_unlock.enabled);

        let (_dir, mgr) = manager(MockVerifier::unavailable());
        let info = os_auth_info(&mgr);
        assert!(!info.export_reauth.available);
        assert!(info.export_reauth.reason.is_some());
        assert!(!info.biometric_unlock.supported);
    }

    #[test]
    fn info_serializes_camel_case() {
        let (_dir, mgr) = manager(MockVerifier::unavailable());
        let value = serde_json::to_value(os_auth_info(&mgr)).unwrap();
        assert!(value["exportReauth"]["available"].is_boolean());
        assert!(value["biometricUnlock"]["methodLabel"].is_string());
    }
}
