use anyhow::Result;
use keyring::Entry;

use super::types::{CredentialKey, CredentialStoreStatus, CredentialType};
use super::CredentialStore;

/// Credential store backed by the OS-native keychain.
///
/// Uses the `keyring` crate to interface with Windows Credential Manager,
/// macOS Keychain, or Linux Secret Service (via D-Bus).
pub struct KeychainStore;

impl KeychainStore {
    const SERVICE: &'static str = "termihub";

    /// Create a keyring [`Entry`] for the given credential key.
    ///
    /// The entry uses `"termihub"` as the service name and
    /// `"{connection_id}:{credential_type}"` as the username.
    fn entry_for(key: &CredentialKey) -> Result<Entry> {
        let username = key.to_string();
        Entry::new(Self::SERVICE, &username)
            .map_err(|e| anyhow::anyhow!("Keychain entry error: {e}"))
    }

    /// Check if the OS keychain is accessible.
    ///
    /// Performs a probe read against a sentinel entry. Returns `true` if the
    /// keychain responds (even with "no entry"), `false` on any other error
    /// (e.g. no D-Bus secret service on Linux).
    pub fn is_available() -> bool {
        Entry::new("termihub", "_probe")
            .and_then(|e| match e.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e),
            })
            .is_ok()
    }
}

impl CredentialStore for KeychainStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        let entry = Self::entry_for(key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Keychain get error: {e}")),
        }
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        let entry = Self::entry_for(key)?;
        entry
            .set_password(value)
            .map_err(|e| anyhow::anyhow!("Keychain set error: {e}"))
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        let entry = Self::entry_for(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow::anyhow!("Keychain remove error: {e}")),
        }
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        for credential_type in [CredentialType::Password, CredentialType::KeyPassphrase] {
            let key = CredentialKey::new(connection_id, credential_type);
            self.remove(&key)?;
        }
        Ok(())
    }

    /// List all stored credential keys.
    ///
    /// The `keyring` crate does not support enumerating stored entries.
    /// Returns an empty list. Callers that need to know which connections
    /// have stored credentials should use `ConnectionManager` to discover
    /// connection IDs and probe them individually.
    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        Ok(Vec::new())
    }

    fn status(&self) -> CredentialStoreStatus {
        if Self::is_available() {
            CredentialStoreStatus::Unlocked
        } else {
            CredentialStoreStatus::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Integration tests that hit the real OS keychain.
    ///
    /// These are `#[ignore]` by default because they:
    /// - modify the real keychain
    /// - may prompt the user on macOS/Linux
    /// - are environment-dependent
    ///
    /// Run with: `cargo test -p termihub -- --ignored keychain`
    mod integration {
        use super::*;

        fn test_key(suffix: &str) -> CredentialKey {
            CredentialKey::new(&format!("test-keychain-{suffix}"), CredentialType::Password)
        }

        #[test]
        #[ignore]
        fn set_then_get_returns_value() {
            let store = KeychainStore;
            let key = test_key("set-get");
            let value = "s3cret-test-value";

            // Clean up from any previous failed run.
            let _ = store.remove(&key);

            store.set(&key, value).expect("set should succeed");
            let result = store.get(&key).expect("get should succeed");
            assert_eq!(result, Some(value.to_string()));

            // Clean up.
            store.remove(&key).expect("cleanup remove should succeed");
        }

        #[test]
        #[ignore]
        fn remove_then_get_returns_none() {
            let store = KeychainStore;
            let key = test_key("remove-get");

            store.set(&key, "temporary").expect("set should succeed");
            store.remove(&key).expect("remove should succeed");
            let result = store.get(&key).expect("get should succeed");
            assert_eq!(result, None);
        }

        #[test]
        #[ignore]
        fn remove_all_for_connection_removes_both_types() {
            let store = KeychainStore;
            let conn_id = "test-keychain-remove-all";
            let pw_key = CredentialKey::new(conn_id, CredentialType::Password);
            let kp_key = CredentialKey::new(conn_id, CredentialType::KeyPassphrase);

            store
                .set(&pw_key, "password-val")
                .expect("set password should succeed");
            store
                .set(&kp_key, "passphrase-val")
                .expect("set passphrase should succeed");

            store
                .remove_all_for_connection(conn_id)
                .expect("remove_all should succeed");

            assert_eq!(store.get(&pw_key).unwrap(), None);
            assert_eq!(store.get(&kp_key).unwrap(), None);
        }

        #[test]
        #[ignore]
        fn get_nonexistent_returns_none() {
            let store = KeychainStore;
            let key = test_key("nonexistent");

            // Make sure it doesn't exist.
            let _ = store.remove(&key);

            let result = store.get(&key).expect("get should succeed");
            assert_eq!(result, None);
        }

        #[test]
        #[ignore]
        fn remove_nonexistent_is_noop() {
            let store = KeychainStore;
            let key = test_key("remove-noop");

            // Make sure it doesn't exist.
            let _ = store.remove(&key);

            // Removing again should not error.
            store.remove(&key).expect("remove should succeed");
        }

        #[test]
        #[ignore]
        fn is_available_returns_bool() {
            // Just verify it doesn't panic.
            let _available = KeychainStore::is_available();
        }
    }

    #[test]
    fn list_keys_returns_empty() {
        let store = KeychainStore;
        let keys = store.list_keys().expect("list_keys should succeed");
        assert!(keys.is_empty());
    }
}
