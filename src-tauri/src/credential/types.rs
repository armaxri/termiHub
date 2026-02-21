use std::fmt;

/// Identifies a specific credential for a connection.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CredentialKey {
    pub connection_id: String,
    pub credential_type: CredentialType,
}

impl fmt::Display for CredentialKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.connection_id, self.credential_type)
    }
}

/// The kind of credential stored.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CredentialType {
    Password,
    KeyPassphrase,
}

impl fmt::Display for CredentialType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CredentialType::Password => write!(f, "password"),
            CredentialType::KeyPassphrase => write!(f, "key-passphrase"),
        }
    }
}

/// Current status of a credential store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialStoreStatus {
    /// Store is ready for read/write operations.
    Unlocked,
    /// Store exists but requires unlocking (e.g., master password entry).
    Locked,
    /// No credential store is configured or available.
    Unavailable,
}

/// How credentials should be persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageMode {
    /// Use the OS keychain (macOS Keychain, Windows Credential Manager, etc.).
    Keychain,
    /// Encrypt credentials with a user-provided master password.
    MasterPassword,
    /// Do not store credentials at all.
    None,
}
