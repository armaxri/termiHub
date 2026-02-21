pub mod keychain;
pub mod master_password;
pub mod null;
pub mod types;

use std::path::PathBuf;

use anyhow::Result;

pub use keychain::KeychainStore;
pub use master_password::MasterPasswordStore;
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
///
/// When `mode` is [`StorageMode::MasterPassword`], a `credentials_file` path
/// must be provided; it will be used as the encrypted credentials file location.
/// If `None` is passed, the store falls back to [`NullStore`].
pub fn create_credential_store(
    mode: StorageMode,
    credentials_file: Option<PathBuf>,
) -> Box<dyn CredentialStore> {
    match mode {
        StorageMode::Keychain => Box::new(KeychainStore),
        StorageMode::MasterPassword => match credentials_file {
            Some(path) => Box::new(MasterPasswordStore::new(path)),
            None => Box::new(NullStore),
        },
        StorageMode::None => Box::new(NullStore),
    }
}
