pub mod null;
pub mod types;

use anyhow::Result;

pub use null::NullStore;
// Re-exports consumed by connection::manager; remaining items are API surface
// for future credential store backends (#246).
#[allow(unused_imports)]
pub use types::{CredentialKey, CredentialStoreStatus, CredentialType, StorageMode};

/// Abstraction over credential storage backends.
///
/// Implementations handle persisting sensitive credentials (passwords,
/// key passphrases) for saved connections. Each backend determines how
/// and where credentials are stored.
// Not all trait methods are consumed yet — `get`, `remove`, `list_keys`,
// and `status` will be called once real backends (keychain, master
// password) are wired in (#246).
#[allow(dead_code)]
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
#[allow(dead_code)]
pub fn create_credential_store(mode: StorageMode) -> Box<dyn CredentialStore> {
    match mode {
        StorageMode::None => Box::new(NullStore),
        // Future: StorageMode::Keychain => Box::new(KeychainStore::new()),
        // Future: StorageMode::MasterPassword => Box::new(MasterPasswordStore::new(...)),
        _ => Box::new(NullStore),
    }
}
