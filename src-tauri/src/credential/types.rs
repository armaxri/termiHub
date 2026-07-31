use std::fmt;

use serde::{Deserialize, Serialize};

/// The type of credential stored for a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CredentialType {
    /// A plain password (e.g., SSH password authentication).
    Password,
    /// A passphrase protecting an SSH private key.
    KeyPassphrase,
    /// A password used to elevate a save (e.g., `sudo` for an elevated write).
    SudoPassword,
}

impl fmt::Display for CredentialType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CredentialType::Password => write!(f, "password"),
            CredentialType::KeyPassphrase => write!(f, "key_passphrase"),
            CredentialType::SudoPassword => write!(f, "sudo_password"),
        }
    }
}

impl CredentialType {
    /// Every credential type termiHub can store, in a single authoritative list.
    ///
    /// Backends that cannot enumerate their contents (the OS keychain — the
    /// native stores expose no portable listing API) must iterate this list to
    /// act on *all* of a connection's secrets, e.g. deleting them when the
    /// connection is removed. Keeping the list here — rather than duplicated at
    /// each such call site — stops it from silently drifting out of date when a
    /// new variant is added; the `all_lists_every_credential_type` guard test
    /// forces every new variant to be added here.
    pub const ALL: [CredentialType; 3] = [
        CredentialType::Password,
        CredentialType::KeyPassphrase,
        CredentialType::SudoPassword,
    ];
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

    /// Parse a map key like `"conn-id:password"` back into a [`CredentialKey`].
    ///
    /// Returns `None` if the string format is invalid or the credential type
    /// is unrecognized.
    pub fn from_map_key(s: &str) -> Option<Self> {
        let (conn_id, type_str) = s.rsplit_once(':')?;
        let credential_type = match type_str {
            "password" => CredentialType::Password,
            "key_passphrase" => CredentialType::KeyPassphrase,
            "sudo_password" => CredentialType::SudoPassword,
            _ => return None,
        };
        Some(Self::new(conn_id, credential_type))
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
    /// Encrypt credentials with a user-provided master password.
    MasterPassword,
    /// Store credentials in the native OS credential store (macOS Keychain,
    /// Windows Credential Manager, or Linux Secret Service).
    OsKeychain,
    /// Do not persist credentials (current default behavior).
    None,
}

impl StorageMode {
    /// Parse the `credential_storage_mode` setting string into a [`StorageMode`].
    ///
    /// Accepts `"master_password"`, `"os_keychain"`, `"none"`, or `None`
    /// (which maps to [`StorageMode::None`]).
    pub fn from_settings_str(s: Option<&str>) -> Self {
        match s {
            Some("master_password") => StorageMode::MasterPassword,
            Some("os_keychain") => StorageMode::OsKeychain,
            _ => StorageMode::None,
        }
    }

    /// Return the settings string representation of this storage mode.
    pub fn to_settings_str(&self) -> &str {
        match self {
            StorageMode::MasterPassword => "master_password",
            StorageMode::OsKeychain => "os_keychain",
            StorageMode::None => "none",
        }
    }
}

/// Status information about the credential store, returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStoreStatusInfo {
    /// Current storage mode: `"master_password"` or `"none"`.
    pub mode: String,
    /// Current status: `"unlocked"`, `"locked"`, or `"unavailable"`.
    pub status: String,
}

/// Convert a [`CredentialStoreStatus`] to its string representation.
pub fn status_to_string(status: &CredentialStoreStatus) -> &'static str {
    match status {
        CredentialStoreStatus::Unlocked => "unlocked",
        CredentialStoreStatus::Locked => "locked",
        CredentialStoreStatus::Unavailable => "unavailable",
    }
}

/// Build a [`CredentialStoreStatusInfo`] from a credential manager.
pub fn build_status_info(manager: &super::CredentialManager) -> CredentialStoreStatusInfo {
    use super::CredentialStore;
    CredentialStoreStatusInfo {
        mode: manager.get_mode().to_settings_str().to_string(),
        status: status_to_string(&manager.status()).to_string(),
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
    fn all_lists_every_credential_type() {
        // Compile guard: this exhaustive match fails to compile when a new
        // `CredentialType` variant is added, forcing it to be listed in
        // `CredentialType::ALL` too. Stores that cannot enumerate their contents
        // (the OS keychain) rely on ALL being complete to delete every secret
        // for a connection (#2305).
        for ct in CredentialType::ALL {
            match ct {
                CredentialType::Password
                | CredentialType::KeyPassphrase
                | CredentialType::SudoPassword => {}
            }
        }
        assert_eq!(CredentialType::ALL.len(), 3);
        // No duplicates.
        for (i, a) in CredentialType::ALL.iter().enumerate() {
            for b in &CredentialType::ALL[i + 1..] {
                assert_ne!(a, b, "duplicate credential type in ALL");
            }
        }
    }

    #[test]
    fn credential_type_display_key_passphrase() {
        assert_eq!(CredentialType::KeyPassphrase.to_string(), "key_passphrase");
    }

    #[test]
    fn credential_type_display_sudo_password() {
        assert_eq!(CredentialType::SudoPassword.to_string(), "sudo_password");
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
    fn credential_key_from_map_key_password() {
        let key = CredentialKey::from_map_key("conn-abc123:password").unwrap();
        assert_eq!(key.connection_id, "conn-abc123");
        assert_eq!(key.credential_type, CredentialType::Password);
    }

    #[test]
    fn credential_key_from_map_key_key_passphrase() {
        let key = CredentialKey::from_map_key("conn-abc123:key_passphrase").unwrap();
        assert_eq!(key.connection_id, "conn-abc123");
        assert_eq!(key.credential_type, CredentialType::KeyPassphrase);
    }

    #[test]
    fn credential_key_display_sudo_password() {
        let key = CredentialKey::new("conn-abc123", CredentialType::SudoPassword);
        assert_eq!(key.to_string(), "conn-abc123:sudo_password");
    }

    #[test]
    fn credential_key_from_map_key_sudo_password() {
        let key = CredentialKey::from_map_key("conn-abc123:sudo_password").unwrap();
        assert_eq!(key.connection_id, "conn-abc123");
        assert_eq!(key.credential_type, CredentialType::SudoPassword);
    }

    #[test]
    fn credential_key_sudo_password_round_trip() {
        let key = CredentialKey::new("my-conn", CredentialType::SudoPassword);
        let map_key = key.to_string();
        let parsed = CredentialKey::from_map_key(&map_key).unwrap();
        assert_eq!(parsed, key);
    }

    #[test]
    fn credential_key_from_map_key_invalid_type() {
        assert!(CredentialKey::from_map_key("conn:unknown_type").is_none());
    }

    #[test]
    fn credential_key_from_map_key_no_colon() {
        assert!(CredentialKey::from_map_key("nodelimiter").is_none());
    }

    #[test]
    fn credential_key_from_map_key_round_trip() {
        let key = CredentialKey::new("my-conn", CredentialType::Password);
        let map_key = key.to_string();
        let parsed = CredentialKey::from_map_key(&map_key).unwrap();
        assert_eq!(parsed, key);
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
            StorageMode::MasterPassword,
            StorageMode::None,
            StorageMode::OsKeychain,
        ] {
            let s = mode.to_settings_str();
            let parsed = StorageMode::from_settings_str(Some(s));
            assert_eq!(&parsed, mode);
        }
    }

    #[test]
    fn storage_mode_from_settings_str_os_keychain() {
        assert_eq!(
            StorageMode::from_settings_str(Some("os_keychain")),
            StorageMode::OsKeychain
        );
    }

    #[test]
    fn storage_mode_to_settings_str_os_keychain() {
        assert_eq!(StorageMode::OsKeychain.to_settings_str(), "os_keychain");
    }
}
