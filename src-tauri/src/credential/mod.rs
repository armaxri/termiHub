pub mod keychain;
pub mod null;
pub mod types;

use anyhow::Result;

pub use keychain::KeychainStore;
pub use null::NullStore;
pub use types::{CredentialKey, CredentialStoreStatus, CredentialType, StorageMode};

/// Abstraction over credential storage backends.
///
/// Implementations handle persisting sensitive credentials (passwords,
/// key passphrases) for saved connections. Each backend determines how
/// and where credentials are stored.
pub trait CredentialStore: Send + Sync {
    /// Retrieve a credential by key. Returns `None` if not found.
    fn get(&self, key: &CredentialKey) -> Result<Option<String>>;

    /// Store a credential. Overwrites any existing value for the key.
    fn set(&self, key: &CredentialKey, value: &str) -> Result<()>;

    /// Remove a single credential. No-op if the key does not exist.
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
        StorageMode::Keychain => Box::new(KeychainStore),
        StorageMode::None => Box::new(NullStore),
        // Future: StorageMode::MasterPassword => Box::new(MasterPasswordStore::new(...)),
        _ => Box::new(NullStore),
    }
}
