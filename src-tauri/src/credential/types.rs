use std::fmt;

use serde::{Deserialize, Serialize};

/// The type of credential stored for a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CredentialType {
    /// A plain password (e.g., SSH password authentication).
    Password,
    /// A passphrase protecting an SSH private key.
    KeyPassphrase,
}

impl fmt::Display for CredentialType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CredentialType::Password => write!(f, "password"),
            CredentialType::KeyPassphrase => write!(f, "key_passphrase"),
        }
    }
}

/// Identifies a specific credential by connection and type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialKey {
    pub connection_id: String,
    pub credential_type: CredentialType,
}

impl CredentialKey {
    pub fn new(connection_id: &str, credential_type: CredentialType) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            credential_type,
        }
    }
}

impl fmt::Display for CredentialKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.connection_id, self.credential_type)
    }
}

/// The current status of a credential store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CredentialStoreStatus {
    /// The store is unlocked and ready to read/write credentials.
    Unlocked,
    /// The store is locked and requires authentication to access.
    Locked,
    /// No credential store is configured or available.
    Unavailable,
}

/// How credentials are persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StorageMode {
    /// Use the OS keychain (e.g., macOS Keychain, Windows Credential Manager).
    Keychain,
    /// Encrypt credentials with a user-provided master password.
    MasterPassword,
    /// Do not persist credentials (current default behavior).
    None,
}

impl StorageMode {
    /// Parse the `credential_storage_mode` setting string into a [`StorageMode`].
    ///
    /// Accepts `"keychain"`, `"master_password"`, `"none"`, or `None` (which
    /// maps to [`StorageMode::None`]).
    pub fn from_settings_str(s: Option<&str>) -> Self {
        match s {
            Some("keychain") => StorageMode::Keychain,
            Some("master_password") => StorageMode::MasterPassword,
            _ => StorageMode::None,
        }
    }

    /// Return the settings string representation of this storage mode.
    pub fn to_settings_str(&self) -> &str {
        match self {
            StorageMode::Keychain => "keychain",
            StorageMode::MasterPassword => "master_password",
            StorageMode::None => "none",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_type_display_password() {
        assert_eq!(CredentialType::Password.to_string(), "password");
    }

    #[test]
    fn credential_type_display_key_passphrase() {
        assert_eq!(CredentialType::KeyPassphrase.to_string(), "key_passphrase");
    }

    #[test]
    fn credential_key_new_constructs_correctly() {
        let key = CredentialKey::new("conn-abc123", CredentialType::Password);
        assert_eq!(key.connection_id, "conn-abc123");
        assert_eq!(key.credential_type, CredentialType::Password);
    }

    #[test]
    fn credential_key_display_password() {
        let key = CredentialKey::new("conn-abc123", CredentialType::Password);
        assert_eq!(key.to_string(), "conn-abc123:password");
    }

    #[test]
    fn credential_key_display_key_passphrase() {
        let key = CredentialKey::new("conn-abc123", CredentialType::KeyPassphrase);
        assert_eq!(key.to_string(), "conn-abc123:key_passphrase");
    }

    #[test]
    fn storage_mode_from_settings_str_keychain() {
        assert_eq!(
            StorageMode::from_settings_str(Some("keychain")),
            StorageMode::Keychain
        );
    }

    #[test]
    fn storage_mode_from_settings_str_master_password() {
        assert_eq!(
            StorageMode::from_settings_str(Some("master_password")),
            StorageMode::MasterPassword
        );
    }

    #[test]
    fn storage_mode_from_settings_str_none_string() {
        assert_eq!(
            StorageMode::from_settings_str(Some("none")),
            StorageMode::None
        );
    }

    #[test]
    fn storage_mode_from_settings_str_none_option() {
        assert_eq!(StorageMode::from_settings_str(None), StorageMode::None);
    }

    #[test]
    fn storage_mode_from_settings_str_unknown() {
        assert_eq!(
            StorageMode::from_settings_str(Some("unknown")),
            StorageMode::None
        );
    }

    #[test]
    fn storage_mode_to_settings_str_round_trip() {
        for mode in &[
            StorageMode::Keychain,
            StorageMode::MasterPassword,
            StorageMode::None,
        ] {
            let s = mode.to_settings_str();
            let parsed = StorageMode::from_settings_str(Some(s));
            assert_eq!(&parsed, mode);
        }
    }
}
