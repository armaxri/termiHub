use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use keyring::{Entry, Error as KeyringError};

use super::types::{CredentialKey, CredentialStoreStatus, CredentialType};
use super::CredentialStore;

/// Service name under which all termiHub credentials are stored in the native
/// OS credential store. Combined with the per-credential account name it forms
/// a unique keychain entry.
const SERVICE_NAME: &str = "termiHub";

/// All credential types termiHub stores. Used by
/// [`OsKeychainStore::remove_all_for_connection`] because OS credential stores
/// cannot be portably enumerated through the `keyring` crate.
const ALL_CREDENTIAL_TYPES: [CredentialType; 2] =
    [CredentialType::Password, CredentialType::KeyPassphrase];

/// Credential store backed by the native OS credential store via the
/// [`keyring`](https://crates.io/crates/keyring) crate.
///
/// Maps to the macOS Keychain, the Windows Credential Manager, and the Linux
/// Secret Service depending on the platform. Each credential is stored as a
/// keychain entry keyed by a fixed service name ([`SERVICE_NAME`]) and an
/// account name derived from the [`CredentialKey`] (`"<connection-id>:<type>"`).
///
/// Unlike [`MasterPasswordStore`](super::MasterPasswordStore), there is no
/// in-app lock state: the OS store manages access (and may prompt the user),
/// so this store always reports [`CredentialStoreStatus::Unlocked`].
///
/// Resolved [`keyring::Entry`] handles are cached per account name. A single
/// `Entry` is reused across `get`/`set`/`remove` for the same credential, which
/// is required for the `keyring` `mock` backend (it keeps state per `Entry`
/// rather than globally by service/account) and is harmless for the real
/// platform backends, where an `Entry` is just a lightweight handle.
#[derive(Default)]
pub struct OsKeychainStore {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
}

impl OsKeychainStore {
    /// Create a new OS keychain store.
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Return a cached [`keyring::Entry`] for the given credential key,
    /// creating and caching it on first use.
    ///
    /// The account name is the canonical `"<connection-id>:<type>"` rendering of
    /// the key, so it round-trips through [`CredentialKey::from_map_key`].
    fn entry(&self, key: &CredentialKey) -> Result<Arc<Entry>> {
        let account = key.to_string();
        let mut entries = self
            .entries
            .lock()
            .expect("OS keychain entry cache lock poisoned");
        if let Some(entry) = entries.get(&account) {
            return Ok(entry.clone());
        }
        let entry = Arc::new(
            Entry::new(SERVICE_NAME, &account)
                .with_context(|| format!("Failed to open OS keychain entry for {key}"))?,
        );
        entries.insert(account, entry.clone());
        Ok(entry)
    }
}

impl CredentialStore for OsKeychainStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        let entry = self.entry(key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(e).with_context(|| format!("Failed to read OS keychain entry for {key}")),
        }
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        let entry = self.entry(key)?;
        entry
            .set_password(value)
            .with_context(|| format!("Failed to write OS keychain entry for {key}"))
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        let entry = self.entry(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => {
                Err(e).with_context(|| format!("Failed to delete OS keychain entry for {key}"))
            }
        }
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        // OS credential stores cannot be enumerated portably through `keyring`,
        // so we delete every known credential type for the connection instead.
        for credential_type in ALL_CREDENTIAL_TYPES {
            let key = CredentialKey::new(connection_id, credential_type);
            self.remove(&key)?;
        }
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        // The native OS credential stores do not expose a portable enumeration
        // API through the `keyring` crate, so listing is unsupported. Callers
        // that need migration *out of* this store must know the keys already.
        // See the deferred-migration note in the issue/PR for #956.
        Ok(Vec::new())
    }

    fn status(&self) -> CredentialStoreStatus {
        // The OS store manages access itself; there is no in-app lock state.
        CredentialStoreStatus::Unlocked
    }
}

/// Test-only support for exercising the OS keychain store against the
/// process-global `keyring` mock backend.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard};

    /// The `keyring` mock backend is process-global, so tests that install it
    /// must not run concurrently. This mutex serializes them across modules.
    static MOCK_LOCK: Mutex<()> = Mutex::new(());

    /// Install the process-global `keyring` mock backend for the duration of a
    /// test. The returned guard must be held for the whole test body so the
    /// mock is not swapped out from under a concurrently running test.
    pub(crate) fn install_mock() -> MutexGuard<'static, ()> {
        let guard = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        guard
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::install_mock as with_mock;
    use super::*;

    #[test]
    fn set_then_get_returns_value() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-set-get", CredentialType::Password);

        store.set(&key, "secret123").unwrap();
        assert_eq!(store.get(&key).unwrap(), Some("secret123".to_string()));
    }

    #[test]
    fn get_nonexistent_returns_none() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-missing", CredentialType::Password);

        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn set_overwrites_existing_value() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-overwrite", CredentialType::KeyPassphrase);

        store.set(&key, "first").unwrap();
        store.set(&key, "second").unwrap();
        assert_eq!(store.get(&key).unwrap(), Some("second".to_string()));
    }

    #[test]
    fn remove_then_get_returns_none() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-remove", CredentialType::Password);

        store.set(&key, "secret").unwrap();
        store.remove(&key).unwrap();
        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn remove_nonexistent_is_ok() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-never", CredentialType::Password);

        assert!(store.remove(&key).is_ok());
    }

    #[test]
    fn remove_all_for_connection_removes_both_types() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let pw = CredentialKey::new("conn-all", CredentialType::Password);
        let kp = CredentialKey::new("conn-all", CredentialType::KeyPassphrase);

        store.set(&pw, "pass").unwrap();
        store.set(&kp, "phrase").unwrap();

        store.remove_all_for_connection("conn-all").unwrap();

        assert_eq!(store.get(&pw).unwrap(), None);
        assert_eq!(store.get(&kp).unwrap(), None);
    }

    #[test]
    fn remove_all_for_connection_removes_sudo_password() {
        // Regression (#2305): deleting a connection must also delete its stored
        // sudo password. The OS store cannot be enumerated, so it deletes a
        // fixed list of credential types — that list previously omitted
        // SudoPassword, leaving the secret orphaned in the OS keychain forever.
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let pw = CredentialKey::new("conn-sudo", CredentialType::Password);
        let kp = CredentialKey::new("conn-sudo", CredentialType::KeyPassphrase);
        let sudo = CredentialKey::new("conn-sudo", CredentialType::SudoPassword);

        store.set(&pw, "pass").unwrap();
        store.set(&kp, "phrase").unwrap();
        store.set(&sudo, "elevated-secret").unwrap();

        store.remove_all_for_connection("conn-sudo").unwrap();

        assert_eq!(store.get(&pw).unwrap(), None);
        assert_eq!(store.get(&kp).unwrap(), None);
        assert_eq!(store.get(&sudo).unwrap(), None);
    }

    #[test]
    fn status_is_always_unlocked() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        assert_eq!(store.status(), CredentialStoreStatus::Unlocked);
    }

    #[test]
    fn list_keys_returns_empty() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-list", CredentialType::Password);
        store.set(&key, "secret").unwrap();

        // Enumeration is unsupported on OS stores; always empty.
        assert!(store.list_keys().unwrap().is_empty());
    }

    #[test]
    fn distinct_keys_do_not_collide() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let a = CredentialKey::new("conn-a", CredentialType::Password);
        let b = CredentialKey::new("conn-b", CredentialType::Password);
        let c = CredentialKey::new("conn-a", CredentialType::KeyPassphrase);

        store.set(&a, "value-a").unwrap();
        store.set(&b, "value-b").unwrap();
        store.set(&c, "value-c").unwrap();

        assert_eq!(store.get(&a).unwrap(), Some("value-a".to_string()));
        assert_eq!(store.get(&b).unwrap(), Some("value-b".to_string()));
        assert_eq!(store.get(&c).unwrap(), Some("value-c".to_string()));
    }
}
