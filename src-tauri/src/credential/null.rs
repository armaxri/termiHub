use anyhow::Result;

use super::types::{CredentialKey, CredentialStoreStatus};
use super::CredentialStore;

/// A no-op credential store that never persists anything.
///
/// This preserves the current behavior where credentials are not saved
/// between sessions. All read operations return empty results and all
/// write operations silently succeed.
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
