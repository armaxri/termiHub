use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::Result;
use tauri::{AppHandle, Emitter};
use tracing::warn;

use super::auto_lock::AutoLockTimer;
use super::biometric_unlock::{
    BiometricUnlock, BiometricUnlockError, BiometricUnlockStatus, SecretSlot, ENABLE_REASON,
    UNLOCK_REASON,
};
use super::os_auth::{
    platform_verifier, OsAuthCapability, OsAuthError, OsAuthPurpose, OsAuthSuccess, OsUserVerifier,
};
use super::types::{CredentialKey, CredentialStoreStatus, StorageMode};
use super::{CredentialStore, MasterPasswordStore, NullStore, OsKeychainStore};

/// Event emitted when a credential is requested but the store is locked.
const EVENT_STORE_UNLOCK_NEEDED: &str = "credential-store-unlock-needed";

/// Internal storage backend enum, allowing direct access to
/// backend-specific methods without trait-object downcasting.
enum StoreBackend {
    Null(NullStore),
    MasterPassword(MasterPasswordStore),
    OsKeychain(OsKeychainStore),
}

/// Manages the active credential store backend and allows runtime switching.
///
/// Wraps the active [`CredentialStore`] implementation behind a [`RwLock`]
/// so the backend can be swapped at runtime (e.g., when the user changes
/// the credential storage mode in settings). Implements [`CredentialStore`]
/// itself so it can be passed to [`ConnectionManager`] transparently.
pub struct CredentialManager {
    inner: RwLock<StoreBackend>,
    config_dir: PathBuf,
    auto_lock_timer: RwLock<Option<Arc<AutoLockTimer>>>,
    app_handle: RwLock<Option<AppHandle>>,
    /// OS user verification (Touch ID / Windows Hello) — #3433, PROD-064.
    os_auth: Box<dyn OsUserVerifier>,
    /// Opt-in biometric unlock of the master-password store (PROD-064).
    biometric: BiometricUnlock,
}

impl CredentialManager {
    /// Create a new credential manager with the given storage mode.
    ///
    /// The `config_dir` is used to locate the `credentials.enc` file
    /// for [`MasterPasswordStore`].
    pub fn new(mode: StorageMode, config_dir: PathBuf) -> Self {
        let backend = Self::create_backend(&mode, &config_dir);
        let biometric = BiometricUnlock::new(&config_dir, default_biometric_slot());
        Self {
            inner: RwLock::new(backend),
            config_dir,
            auto_lock_timer: RwLock::new(None),
            app_handle: RwLock::new(None),
            os_auth: platform_verifier(),
            biometric,
        }
    }

    /// Replace the OS user verifier (tests inject a mock).
    #[cfg(test)]
    pub fn with_os_auth(mut self, verifier: Box<dyn OsUserVerifier>) -> Self {
        self.os_auth = verifier;
        self
    }

    /// Replace where the biometric-unlock wrapping key is stored (tests use
    /// an in-memory slot).
    #[cfg(test)]
    pub fn with_biometric_slot(mut self, slot: Box<dyn SecretSlot>) -> Self {
        self.biometric = BiometricUnlock::new(&self.config_dir, slot);
        self
    }

    /// Return the current storage mode.
    pub fn get_mode(&self) -> StorageMode {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        match *inner {
            StoreBackend::Null(_) => StorageMode::None,
            StoreBackend::MasterPassword(_) => StorageMode::MasterPassword,
            StoreBackend::OsKeychain(_) => StorageMode::OsKeychain,
        }
    }

    /// Switch to a new storage backend.
    ///
    /// Locks the current store (if master password), then replaces the backend.
    /// Callers are responsible for migrating credentials before switching.
    pub fn switch_store(&self, new_mode: StorageMode) -> Result<()> {
        let new_backend = Self::create_backend(&new_mode, &self.config_dir);
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());

        // Lock the old master password store if applicable
        if let StoreBackend::MasterPassword(ref old_store) = *inner {
            old_store.lock();
        }

        let leaving_master_password = matches!(*inner, StoreBackend::MasterPassword(_))
            && new_mode != StorageMode::MasterPassword;
        *inner = new_backend;
        drop(inner);

        // The biometric-unlock enrollment belongs to the master-password store
        // being left; it must not survive a store switch (PROD-064).
        if leaving_master_password {
            if let Err(e) = self.biometric.disable() {
                warn!(error = %e, "failed to remove biometric unlock after a store switch");
            }
        }
        Ok(())
    }

    /// Execute a closure with a reference to the inner [`MasterPasswordStore`],
    /// if the current backend is master password mode.
    ///
    /// Returns `None` if the current backend is not [`StorageMode::MasterPassword`].
    pub fn with_master_password_store<F, R>(&self, f: F) -> Option<R>
    where
        F: FnOnce(&MasterPasswordStore) -> R,
    {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        match *inner {
            StoreBackend::MasterPassword(ref store) => Some(f(store)),
            _ => None,
        }
    }

    /// Set the auto-lock timer for this credential manager.
    pub fn set_auto_lock_timer(&self, timer: Arc<AutoLockTimer>) {
        let mut guard = self
            .auto_lock_timer
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(timer);
    }

    /// Returns whether an auto-lock timer is installed for this manager.
    ///
    /// The timer is installed once at startup; a `false` result means its
    /// background thread failed to spawn (WA-RS-004). Callers use this to gate
    /// unlocking the master-password store: without a live timer the store
    /// cannot be auto-locked after inactivity, so it must stay locked rather
    /// than be left unlocked with no mechanism to re-lock it.
    pub fn has_auto_lock_timer(&self) -> bool {
        self.auto_lock_timer
            .read()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// Notify the auto-lock timer that the store was unlocked.
    pub fn notify_auto_lock_unlocked(&self) {
        if let Ok(guard) = self.auto_lock_timer.read() {
            if let Some(ref timer) = *guard {
                timer.notify_unlocked();
            }
        }
    }

    /// Notify the auto-lock timer that the store was locked.
    pub fn notify_auto_lock_locked(&self) {
        if let Ok(guard) = self.auto_lock_timer.read() {
            if let Some(ref timer) = *guard {
                timer.notify_locked();
            }
        }
    }

    /// Update the auto-lock timeout duration.
    pub fn set_auto_lock_timeout(&self, minutes: Option<u32>) {
        if let Ok(guard) = self.auto_lock_timer.read() {
            if let Some(ref timer) = *guard {
                timer.set_timeout(minutes);
            }
        }
    }

    /// Set the app handle used for emitting events.
    pub fn set_app_handle(&self, handle: AppHandle) {
        let mut guard = self.app_handle.write().unwrap_or_else(|e| e.into_inner());
        *guard = Some(handle);
    }

    /// Emit the unlock-needed event so the UI can prompt the user.
    fn emit_unlock_needed(&self) {
        if let Ok(guard) = self.app_handle.read() {
            if let Some(ref handle) = *guard {
                if let Err(e) = handle.emit(EVENT_STORE_UNLOCK_NEEDED, ()) {
                    warn!("Failed to emit {EVENT_STORE_UNLOCK_NEEDED}: {e}");
                }
            }
        }
    }

    /// Record credential activity on the auto-lock timer.
    fn record_activity(&self) {
        if let Ok(guard) = self.auto_lock_timer.read() {
            if let Some(ref timer) = *guard {
                timer.record_activity();
            }
        }
    }

    /// Whether the OS can verify the user for `purpose`. Never prompts.
    pub fn os_auth_capability(&self, purpose: OsAuthPurpose) -> OsAuthCapability {
        self.os_auth.capability(purpose)
    }

    /// Ask the OS to verify the logged-in user (blocks until answered).
    ///
    /// Fails closed: only an explicit OS confirmation is `Ok`. Nothing is
    /// cached — every call prompts (#3433).
    pub fn verify_user(
        &self,
        purpose: OsAuthPurpose,
        reason: &str,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        self.os_auth.verify(purpose, reason, self.owner_window())
    }

    /// The native handle of termiHub's focused (or first) window, used to
    /// parent the Windows Hello prompt. `None` elsewhere.
    fn owner_window(&self) -> Option<isize> {
        #[cfg(windows)]
        {
            use tauri::Manager;
            let guard = self.app_handle.read().ok()?;
            let handle = guard.as_ref()?;
            let windows = handle.webview_windows();
            let window = windows
                .values()
                .find(|w| w.is_focused().unwrap_or(false))
                .or_else(|| windows.values().next())?;
            window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// Biometric-unlock state for the UI.
    pub fn biometric_unlock_status(&self) -> BiometricUnlockStatus {
        let capability = self.os_auth.capability(OsAuthPurpose::BiometricUnlock);
        BiometricUnlockStatus {
            supported: capability.available,
            enabled: self.get_mode() == StorageMode::MasterPassword && self.biometric.is_enabled(),
            method_label: capability.method_label,
            reason: capability.reason,
        }
    }

    /// Opt in to biometric unlock: re-verify `master_password` against the
    /// unlocked store, confirm the biometric with the OS, then enroll.
    pub fn enable_biometric_unlock(
        &self,
        master_password: &str,
    ) -> Result<(), BiometricUnlockError> {
        // Check the store and password first (no OS prompt for a typo).
        self.with_master_password_store(|store| {
            if !store.is_unlocked() {
                return Err(BiometricUnlockError::store_unavailable(
                    "Unlock the credential store before turning on biometric unlock.",
                ));
            }
            match store.verify_password(master_password) {
                Ok(true) => Ok(()),
                Ok(false) => Err(BiometricUnlockError::WrongMasterPassword {
                    message: "The master password is incorrect.".to_string(),
                }),
                Err(e) => Err(BiometricUnlockError::other(format!(
                    "Could not verify the master password: {e}"
                ))),
            }
        })
        .unwrap_or_else(|| Err(not_master_password_mode()))?;

        let capability = self
            .os_auth
            .capability(OsAuthPurpose::EnableBiometricUnlock);
        if !capability.available {
            return Err(BiometricUnlockError::AuthFailed {
                message: capability
                    .reason
                    .unwrap_or_else(|| "Biometric unlock is not available.".to_string()),
            });
        }
        // Prompt without holding the backend lock.
        let verified = self.verify_user(OsAuthPurpose::EnableBiometricUnlock, ENABLE_REASON)?;

        self.with_master_password_store(|store| self.biometric.enable(store, &verified))
            .unwrap_or_else(|| Err(not_master_password_mode()))
    }

    /// Unlock the master-password store with biometrics. The caller applies
    /// the auto-lock gate and notifies the timer, exactly as for a password
    /// unlock. An already-unlocked store is a no-op (no prompt).
    pub fn unlock_with_biometrics(&self) -> Result<(), BiometricUnlockError> {
        let already_unlocked = self
            .with_master_password_store(|store| {
                if store.is_unlocked() {
                    return Ok(true);
                }
                self.biometric.precheck(store).map(|()| false)
            })
            .unwrap_or_else(|| Err(not_master_password_mode()))?;
        if already_unlocked {
            return Ok(());
        }

        // Prompt without holding the backend lock (a prompt can stay open for
        // minutes); the enrollment is re-checked under the lock afterwards.
        let verified = self.verify_user(OsAuthPurpose::BiometricUnlock, UNLOCK_REASON)?;

        self.with_master_password_store(|store| {
            if store.is_unlocked() {
                return Ok(());
            }
            self.biometric.unlock(store, &verified)
        })
        .unwrap_or_else(|| Err(not_master_password_mode()))
    }

    /// Opt out of biometric unlock (deletes the enrollment). Idempotent.
    pub fn disable_biometric_unlock(&self) -> Result<()> {
        self.biometric.disable()
    }

    /// Change the master password and drop the biometric-unlock enrollment,
    /// which was bound to the old key (PROD-064).
    pub fn change_master_password(&self, current: &str, new: &str) -> Result<()> {
        self.with_master_password_store(|store| store.change_password(current, new))
            .unwrap_or_else(|| {
                Err(anyhow::anyhow!(
                    "Credential store is not in master password mode"
                ))
            })?;
        if let Err(e) = self.biometric.disable() {
            warn!(error = %e, "failed to remove biometric unlock after a master-password change");
        }
        Ok(())
    }

    /// Delete a (corrupt) master-password store and its biometric-unlock
    /// enrollment.
    pub fn reset_master_password_store(&self) -> Result<()> {
        self.with_master_password_store(MasterPasswordStore::reset)
            .unwrap_or_else(|| {
                Err(anyhow::anyhow!(
                    "Credential store is not in master password mode"
                ))
            })?;
        if let Err(e) = self.biometric.disable() {
            warn!(error = %e, "failed to remove biometric unlock after a store reset");
        }
        Ok(())
    }

    /// Create the appropriate backend for the given mode.
    fn create_backend(mode: &StorageMode, config_dir: &Path) -> StoreBackend {
        match mode {
            StorageMode::MasterPassword => {
                let file_path = config_dir.join("credentials.enc");
                StoreBackend::MasterPassword(MasterPasswordStore::new(file_path))
            }
            StorageMode::OsKeychain => StoreBackend::OsKeychain(OsKeychainStore::new()),
            StorageMode::None => StoreBackend::Null(NullStore),
        }
    }
}

fn not_master_password_mode() -> BiometricUnlockError {
    BiometricUnlockError::store_unavailable(
        "Biometric unlock is only available for the master-password credential store.",
    )
}

/// Where the biometric-unlock wrapping key lives: the OS credential store,
/// or an in-memory slot in unit tests (never the real keychain).
fn default_biometric_slot() -> Box<dyn SecretSlot> {
    #[cfg(test)]
    {
        Box::new(super::biometric_unlock::MemorySlot::default())
    }
    #[cfg(not(test))]
    {
        Box::new(super::biometric_unlock::KeyringSlot::default())
    }
}

impl CredentialStore for CredentialManager {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let is_master_password_mode = matches!(*inner, StoreBackend::MasterPassword(_));
        let result = match *inner {
            StoreBackend::Null(ref s) => s.get(key),
            StoreBackend::MasterPassword(ref s) => s.get(key),
            StoreBackend::OsKeychain(ref s) => s.get(key),
        };
        drop(inner);
        if result.is_err() && is_master_password_mode {
            // Credential access failed — almost certainly because the store is locked.
            // Notify the UI so it can prompt the user to unlock on demand.
            self.emit_unlock_needed();
        } else {
            self.record_activity();
        }
        result
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let result = match *inner {
            StoreBackend::Null(ref s) => s.set(key, value),
            StoreBackend::MasterPassword(ref s) => s.set(key, value),
            StoreBackend::OsKeychain(ref s) => s.set(key, value),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let result = match *inner {
            StoreBackend::Null(ref s) => s.remove(key),
            StoreBackend::MasterPassword(ref s) => s.remove(key),
            StoreBackend::OsKeychain(ref s) => s.remove(key),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let result = match *inner {
            StoreBackend::Null(ref s) => s.remove_all_for_connection(connection_id),
            StoreBackend::MasterPassword(ref s) => s.remove_all_for_connection(connection_id),
            StoreBackend::OsKeychain(ref s) => s.remove_all_for_connection(connection_id),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let result = match *inner {
            StoreBackend::Null(ref s) => s.list_keys(),
            StoreBackend::MasterPassword(ref s) => s.list_keys(),
            StoreBackend::OsKeychain(ref s) => s.list_keys(),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn set_many(&self, entries: &[(CredentialKey, String)]) -> Result<()> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let result = match *inner {
            StoreBackend::Null(ref s) => s.set_many(entries),
            StoreBackend::MasterPassword(ref s) => s.set_many(entries),
            StoreBackend::OsKeychain(ref s) => s.set_many(entries),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn status(&self) -> CredentialStoreStatus {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        match *inner {
            StoreBackend::Null(ref s) => s.status(),
            StoreBackend::MasterPassword(ref s) => s.status(),
            StoreBackend::OsKeychain(ref s) => s.status(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::types::CredentialType;

    #[test]
    fn new_creates_null_store_for_none_mode() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        assert_eq!(mgr.get_mode(), StorageMode::None);
        assert_eq!(mgr.status(), CredentialStoreStatus::Unavailable);
    }

    #[test]
    fn new_creates_master_password_store() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());
        assert_eq!(mgr.get_mode(), StorageMode::MasterPassword);
        // Not set up yet, so unavailable
        assert_eq!(mgr.status(), CredentialStoreStatus::Unavailable);
    }

    #[test]
    fn new_creates_os_keychain_store() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf());
        assert_eq!(mgr.get_mode(), StorageMode::OsKeychain);
        // A native store has no in-app lock state — always unlocked.
        assert_eq!(mgr.status(), CredentialStoreStatus::Unlocked);
    }

    // Regression: a thread that panics while holding the backend lock must not
    // cascade that panic to every later credential access. The lock guards use
    // `.unwrap_or_else(|e| e.into_inner())`, so a poisoned lock degrades to its
    // inner value instead of re-panicking (ERR-001 / TAURI-004).
    #[test]
    fn poisoned_lock_recovers_instead_of_cascading() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = Arc::new(CredentialManager::new(
            StorageMode::None,
            dir.path().to_path_buf(),
        ));

        // Poison the backend RwLock by panicking while holding a write guard.
        let poisoner = Arc::clone(&mgr);
        let handle = std::thread::spawn(move || {
            let _guard = poisoner.inner.write().unwrap();
            panic!("intentional panic to poison the credential store lock");
        });
        assert!(handle.join().is_err(), "poisoning thread should panic");
        assert!(mgr.inner.is_poisoned(), "backend lock should be poisoned");

        // Reads must still succeed via the recovered guard, not re-panic.
        assert_eq!(mgr.get_mode(), StorageMode::None);
        // Writes through the poisoned lock must also recover.
        mgr.switch_store(StorageMode::MasterPassword).unwrap();
        assert_eq!(mgr.get_mode(), StorageMode::MasterPassword);
    }

    #[test]
    fn has_auto_lock_timer_false_before_install() {
        // WA-RS-004: when the auto-lock timer thread fails to spawn, no timer is
        // installed. `has_auto_lock_timer` must report `false` so callers can
        // refuse to unlock the store (fail-safe) rather than leave credentials
        // unlocked with nothing to auto-lock them.
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());
        assert!(!mgr.has_auto_lock_timer());
    }

    #[test]
    fn switch_store_changes_mode() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        assert_eq!(mgr.get_mode(), StorageMode::None);

        mgr.switch_store(StorageMode::MasterPassword).unwrap();
        assert_eq!(mgr.get_mode(), StorageMode::MasterPassword);

        mgr.switch_store(StorageMode::OsKeychain).unwrap();
        assert_eq!(mgr.get_mode(), StorageMode::OsKeychain);

        mgr.switch_store(StorageMode::None).unwrap();
        assert_eq!(mgr.get_mode(), StorageMode::None);
    }

    #[test]
    fn credential_store_trait_delegates_to_os_keychain() {
        // Install the process-global keyring mock backend (serialized so it is
        // not swapped out by a concurrently running keychain test).
        let _mock = crate::credential::os_keychain::test_support::install_mock();

        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf());

        let key = CredentialKey::new("conn-mgr-keychain", CredentialType::Password);
        mgr.set(&key, "keychain-secret").unwrap();
        assert_eq!(mgr.get(&key).unwrap(), Some("keychain-secret".to_string()));

        mgr.remove(&key).unwrap();
        assert_eq!(mgr.get(&key).unwrap(), None);
    }

    #[test]
    fn credential_store_trait_delegates_to_null() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        let key = CredentialKey::new("conn-1", CredentialType::Password);

        // NullStore always returns None/Ok
        assert_eq!(mgr.get(&key).unwrap(), None);
        assert!(mgr.set(&key, "secret").is_ok());
        assert_eq!(mgr.get(&key).unwrap(), None); // NullStore doesn't persist
    }

    #[test]
    fn credential_store_trait_delegates_to_master_password() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());

        // Set up the master password store
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        mgr.set(&key, "my-secret").unwrap();
        assert_eq!(mgr.get(&key).unwrap(), Some("my-secret".to_string()));
    }

    #[test]
    fn sudo_password_round_trip_and_removal() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());

        // Set up the master password store
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();

        // store -> get -> remove of a SudoPassword credential
        let sudo_key = CredentialKey::new("conn-sudo", CredentialType::SudoPassword);
        mgr.set(&sudo_key, "elevated-secret").unwrap();
        assert_eq!(
            mgr.get(&sudo_key).unwrap(),
            Some("elevated-secret".to_string())
        );
        mgr.remove(&sudo_key).unwrap();
        assert_eq!(mgr.get(&sudo_key).unwrap(), None);

        // remove_all_for_connection clears SudoPassword alongside Password/KeyPassphrase
        let pw_key = CredentialKey::new("conn-sudo", CredentialType::Password);
        let kp_key = CredentialKey::new("conn-sudo", CredentialType::KeyPassphrase);
        mgr.set(&pw_key, "pass").unwrap();
        mgr.set(&kp_key, "phrase").unwrap();
        mgr.set(&sudo_key, "elevated-secret").unwrap();

        mgr.remove_all_for_connection("conn-sudo").unwrap();

        assert_eq!(mgr.get(&pw_key).unwrap(), None);
        assert_eq!(mgr.get(&kp_key).unwrap(), None);
        assert_eq!(mgr.get(&sudo_key).unwrap(), None);
    }

    #[test]
    fn get_on_locked_store_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());

        // Set up and then lock the master password store
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();
        mgr.with_master_password_store(|s| s.lock()).unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        // get() must fail when locked; without an app_handle the emit is silently skipped
        assert!(mgr.get(&key).is_err());
    }

    #[test]
    fn with_master_password_store_returns_none_for_null() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        let result = mgr.with_master_password_store(|_| 42);
        assert!(result.is_none());
    }

    #[test]
    fn with_master_password_store_returns_some_for_master_password() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());
        let result = mgr.with_master_password_store(|_| 42);
        assert_eq!(result, Some(42));
    }
}
