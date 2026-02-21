use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::Result;

use super::auto_lock::AutoLockTimer;
use super::types::{CredentialKey, CredentialStoreStatus, StorageMode};
use super::{CredentialStore, KeychainStore, MasterPasswordStore, NullStore};

/// Internal storage backend enum, allowing direct access to
/// backend-specific methods without trait-object downcasting.
enum StoreBackend {
    Null(NullStore),
    Keychain(KeychainStore),
    MasterPassword(MasterPasswordStore),
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
}

impl CredentialManager {
    /// Create a new credential manager with the given storage mode.
    ///
    /// The `config_dir` is used to locate the `credentials.enc` file
    /// for [`MasterPasswordStore`].
    pub fn new(mode: StorageMode, config_dir: PathBuf) -> Self {
        let backend = Self::create_backend(&mode, &config_dir);
        Self {
            inner: RwLock::new(backend),
            config_dir,
            auto_lock_timer: RwLock::new(None),
        }
    }

    /// Return the current storage mode.
    pub fn get_mode(&self) -> StorageMode {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        match *inner {
            StoreBackend::Null(_) => StorageMode::None,
            StoreBackend::Keychain(_) => StorageMode::Keychain,
            StoreBackend::MasterPassword(_) => StorageMode::MasterPassword,
        }
    }

    /// Switch to a new storage backend.
    ///
    /// Locks the current store (if master password), then replaces the backend.
    /// Callers are responsible for migrating credentials before switching.
    pub fn switch_store(&self, new_mode: StorageMode) -> Result<()> {
        let new_backend = Self::create_backend(&new_mode, &self.config_dir);
        let mut inner = self
            .inner
            .write()
            .expect("credential manager lock poisoned");

        // Lock the old master password store if applicable
        if let StoreBackend::MasterPassword(ref old_store) = *inner {
            old_store.lock();
        }

        *inner = new_backend;
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
        let inner = self.inner.read().expect("credential manager lock poisoned");
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
            .expect("auto_lock_timer lock poisoned");
        *guard = Some(timer);
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

    /// Record credential activity on the auto-lock timer.
    fn record_activity(&self) {
        if let Ok(guard) = self.auto_lock_timer.read() {
            if let Some(ref timer) = *guard {
                timer.record_activity();
            }
        }
    }

    /// Create the appropriate backend for the given mode.
    fn create_backend(mode: &StorageMode, config_dir: &Path) -> StoreBackend {
        match mode {
            StorageMode::Keychain => StoreBackend::Keychain(KeychainStore),
            StorageMode::MasterPassword => {
                let file_path = config_dir.join("credentials.enc");
                StoreBackend::MasterPassword(MasterPasswordStore::new(file_path))
            }
            StorageMode::None => StoreBackend::Null(NullStore),
        }
    }
}

impl CredentialStore for CredentialManager {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        let result = match *inner {
            StoreBackend::Null(ref s) => s.get(key),
            StoreBackend::Keychain(ref s) => s.get(key),
            StoreBackend::MasterPassword(ref s) => s.get(key),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        let result = match *inner {
            StoreBackend::Null(ref s) => s.set(key, value),
            StoreBackend::Keychain(ref s) => s.set(key, value),
            StoreBackend::MasterPassword(ref s) => s.set(key, value),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        let result = match *inner {
            StoreBackend::Null(ref s) => s.remove(key),
            StoreBackend::Keychain(ref s) => s.remove(key),
            StoreBackend::MasterPassword(ref s) => s.remove(key),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        let result = match *inner {
            StoreBackend::Null(ref s) => s.remove_all_for_connection(connection_id),
            StoreBackend::Keychain(ref s) => s.remove_all_for_connection(connection_id),
            StoreBackend::MasterPassword(ref s) => s.remove_all_for_connection(connection_id),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        let result = match *inner {
            StoreBackend::Null(ref s) => s.list_keys(),
            StoreBackend::Keychain(ref s) => s.list_keys(),
            StoreBackend::MasterPassword(ref s) => s.list_keys(),
        };
        drop(inner);
        self.record_activity();
        result
    }

    fn status(&self) -> CredentialStoreStatus {
        let inner = self.inner.read().expect("credential manager lock poisoned");
        match *inner {
            StoreBackend::Null(ref s) => s.status(),
            StoreBackend::Keychain(ref s) => s.status(),
            StoreBackend::MasterPassword(ref s) => s.status(),
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
    fn switch_store_changes_mode() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        assert_eq!(mgr.get_mode(), StorageMode::None);

        mgr.switch_store(StorageMode::MasterPassword).unwrap();
        assert_eq!(mgr.get_mode(), StorageMode::MasterPassword);

        mgr.switch_store(StorageMode::None).unwrap();
        assert_eq!(mgr.get_mode(), StorageMode::None);
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
