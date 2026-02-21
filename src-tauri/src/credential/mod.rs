pub mod null;
pub mod types;

use anyhow::Result;

use types::{CredentialKey, CredentialStoreStatus, StorageMode};

/// Trait for credential storage backends.
///
/// Each implementation handles a different persistence strategy
/// (OS keychain, master-password-encrypted file, or no storage).
pub trait CredentialStore: Send + Sync {
    /// Retrieve a stored credential, or `None` if not found.
    fn get(&self, key: &CredentialKey) -> Result<Option<String>>;

    /// Store a credential value.
    fn set(&self, key: &CredentialKey, value: &str) -> Result<()>;

    /// Remove a single credential.
    fn remove(&self, key: &CredentialKey) -> Result<()>;

    /// Remove all credentials associated with a connection.
    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()>;

    /// List all stored credential keys.
    fn list_keys(&self) -> Result<Vec<CredentialKey>>;

    /// Return the current status of the credential store.
    fn status(&self) -> CredentialStoreStatus;
}

/// Create a credential store for the given storage mode.
pub fn create_credential_store(mode: StorageMode) -> Box<dyn CredentialStore> {
    match mode {
        StorageMode::None => Box::new(null::NullStore),
        // Future implementations will handle Keychain and MasterPassword modes.
        // For now, fall back to NullStore.
        StorageMode::Keychain | StorageMode::MasterPassword => Box::new(null::NullStore),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use types::CredentialType;

    #[test]
    fn credential_key_display_password() {
        let key = CredentialKey {
            connection_id: "conn-abc123".to_string(),
            credential_type: CredentialType::Password,
        };
        assert_eq!(key.to_string(), "conn-abc123:password");
    }

    #[test]
    fn credential_key_display_key_passphrase() {
        let key = CredentialKey {
            connection_id: "conn-xyz789".to_string(),
            credential_type: CredentialType::KeyPassphrase,
        };
        assert_eq!(key.to_string(), "conn-xyz789:key-passphrase");
    }

    #[test]
    fn null_store_get_returns_none() {
        let store = null::NullStore;
        let key = CredentialKey {
            connection_id: "test".to_string(),
            credential_type: CredentialType::Password,
        };
        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn null_store_set_succeeds() {
        let store = null::NullStore;
        let key = CredentialKey {
            connection_id: "test".to_string(),
            credential_type: CredentialType::Password,
        };
        assert!(store.set(&key, "secret").is_ok());
    }

    #[test]
    fn null_store_remove_succeeds() {
        let store = null::NullStore;
        let key = CredentialKey {
            connection_id: "test".to_string(),
            credential_type: CredentialType::Password,
        };
        assert!(store.remove(&key).is_ok());
    }

    #[test]
    fn null_store_remove_all_for_connection_succeeds() {
        let store = null::NullStore;
        assert!(store.remove_all_for_connection("test").is_ok());
    }

    #[test]
    fn null_store_list_keys_returns_empty() {
        let store = null::NullStore;
        let keys = store.list_keys().unwrap();
        assert!(keys.is_empty());
    }

    #[test]
    fn null_store_status_is_unavailable() {
        let store = null::NullStore;
        assert_eq!(store.status(), CredentialStoreStatus::Unavailable);
    }

    #[test]
    fn null_store_get_after_set_still_returns_none() {
        let store = null::NullStore;
        let key = CredentialKey {
            connection_id: "test".to_string(),
            credential_type: CredentialType::Password,
        };
        store.set(&key, "secret").unwrap();
        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn create_credential_store_none_mode() {
        let store = create_credential_store(StorageMode::None);
        assert_eq!(store.status(), CredentialStoreStatus::Unavailable);
    }

    #[test]
    fn create_credential_store_keychain_fallback() {
        let store = create_credential_store(StorageMode::Keychain);
        assert_eq!(store.status(), CredentialStoreStatus::Unavailable);
    }

    #[test]
    fn create_credential_store_master_password_fallback() {
        let store = create_credential_store(StorageMode::MasterPassword);
        assert_eq!(store.status(), CredentialStoreStatus::Unavailable);
    }
}
