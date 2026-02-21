use anyhow::Result;

use super::types::{CredentialKey, CredentialStoreStatus};
use super::CredentialStore;

/// A no-op credential store that never persists credentials.
///
/// This preserves the current default behavior where credentials are not saved
/// between sessions. All read operations return empty results, and all write
/// operations silently succeed without storing anything.
pub struct NullStore;

impl CredentialStore for NullStore {
    fn get(&self, _key: &CredentialKey) -> Result<Option<String>> {
        Ok(None)
    }

    fn set(&self, _key: &CredentialKey, _value: &str) -> Result<()> {
        Ok(())
    }

    fn remove(&self, _key: &CredentialKey) -> Result<()> {
        Ok(())
    }

    fn remove_all_for_connection(&self, _connection_id: &str) -> Result<()> {
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        Ok(Vec::new())
    }

    fn status(&self) -> CredentialStoreStatus {
        CredentialStoreStatus::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::types::CredentialType;

    #[test]
    fn get_returns_none() {
        let store = NullStore;
        let key = CredentialKey::new("conn-1", CredentialType::Password);
        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn set_succeeds() {
        let store = NullStore;
        let key = CredentialKey::new("conn-1", CredentialType::Password);
        assert!(store.set(&key, "secret").is_ok());
    }

    #[test]
    fn remove_succeeds() {
        let store = NullStore;
        let key = CredentialKey::new("conn-1", CredentialType::KeyPassphrase);
        assert!(store.remove(&key).is_ok());
    }

    #[test]
    fn remove_all_for_connection_succeeds() {
        let store = NullStore;
        assert!(store.remove_all_for_connection("conn-1").is_ok());
    }

    #[test]
    fn list_keys_returns_empty() {
        let store = NullStore;
        assert!(store.list_keys().unwrap().is_empty());
    }

    #[test]
    fn status_is_unavailable() {
        let store = NullStore;
        assert_eq!(store.status(), CredentialStoreStatus::Unavailable);
    }
}
