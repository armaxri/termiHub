use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{bail, Context, Result};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::types::{CredentialKey, CredentialStoreStatus, CredentialType};
use super::CredentialStore;

/// Argon2id memory cost in KiB (64 MiB).
const ARGON2_MEMORY_COST: u32 = 65536;
/// Argon2id iteration count.
const ARGON2_TIME_COST: u32 = 3;
/// Argon2id parallelism degree.
const ARGON2_PARALLELISM: u32 = 1;
/// Length of the random salt in bytes.
const SALT_LEN: usize = 32;
/// Length of the AES-256-GCM nonce in bytes.
const NONCE_LEN: usize = 12;
/// Current envelope format version.
const ENVELOPE_VERSION: u32 = 1;
/// Additional authenticated data: single version byte.
const AAD: &[u8] = &[1];

/// On-disk encrypted envelope format.
#[derive(Serialize, Deserialize)]
struct EncryptedEnvelope {
    version: u32,
    kdf: KdfParams,
    nonce: String,
    data: String,
}

/// Key derivation function parameters stored alongside the ciphertext.
#[derive(Serialize, Deserialize)]
struct KdfParams {
    algorithm: String,
    salt: String,
    memory_cost: u32,
    time_cost: u32,
    parallelism: u32,
}

/// Credential store that encrypts all credentials into a single file
/// using Argon2id key derivation and AES-256-GCM authenticated encryption.
///
/// The store has three states:
/// - **No file**: `setup()` must be called to create the initial encrypted file.
/// - **Locked**: the file exists but the master password has not been provided.
/// - **Unlocked**: credentials are decrypted in memory and available for use.
pub struct MasterPasswordStore {
    file_path: PathBuf,
    salt: RwLock<Option<Vec<u8>>>,
    credentials: RwLock<Option<HashMap<String, String>>>,
    derived_key: RwLock<Option<Vec<u8>>>,
}

impl MasterPasswordStore {
    /// Create a new store that will read/write the given file path.
    ///
    /// The store starts in a locked state. Call [`setup`](Self::setup) to
    /// create a new credentials file, or [`unlock`](Self::unlock) to open
    /// an existing one.
    pub fn new(file_path: PathBuf) -> Self {
        Self {
            file_path,
            salt: RwLock::new(None),
            credentials: RwLock::new(None),
            derived_key: RwLock::new(None),
        }
    }

    /// Create the initial encrypted credentials file with an empty credential
    /// map. Leaves the store in the unlocked state.
    ///
    /// Returns an error if a credentials file already exists.
    pub fn setup(&self, password: &str) -> Result<()> {
        if self.has_credentials_file() {
            bail!("Credentials file already exists at {:?}", self.file_path);
        }

        let mut salt = vec![0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);

        let key = derive_key(password, &salt)?;

        {
            let mut salt_guard = self.salt.write().expect("salt lock poisoned");
            *salt_guard = Some(salt);
        }
        {
            let mut key_guard = self
                .derived_key
                .write()
                .expect("derived_key lock poisoned");
            *key_guard = Some(key.to_vec());
        }
        {
            let mut creds_guard = self
                .credentials
                .write()
                .expect("credentials lock poisoned");
            *creds_guard = Some(HashMap::new());
        }

        self.save_to_disk()
            .context("Failed to write initial credentials file")
    }

    /// Decrypt the credentials file with the given master password and
    /// load credentials into memory.
    pub fn unlock(&self, password: &str) -> Result<()> {
        let raw = fs::read_to_string(&self.file_path)
            .context("Failed to read credentials file")?;
        let envelope: EncryptedEnvelope =
            serde_json::from_str(&raw).context("Invalid credentials file format")?;

        if envelope.version != ENVELOPE_VERSION {
            bail!(
                "Unsupported credentials file version: {}",
                envelope.version
            );
        }

        let salt = BASE64
            .decode(&envelope.kdf.salt)
            .context("Invalid salt encoding")?;
        let nonce_bytes = BASE64
            .decode(&envelope.nonce)
            .context("Invalid nonce encoding")?;
        let ciphertext = BASE64
            .decode(&envelope.data)
            .context("Invalid ciphertext encoding")?;

        let key = derive_key(password, &salt)?;

        let cipher = Aes256Gcm::new_from_slice(&key)
            .context("Failed to create cipher")?;
        let nonce = Nonce::from_slice(&nonce_bytes);

        let payload = aes_gcm::aead::Payload {
            msg: &ciphertext,
            aad: AAD,
        };
        let mut plaintext = cipher
            .decrypt(nonce, payload)
            .map_err(|_| anyhow::anyhow!("Decryption failed — wrong password or corrupted file"))?;

        let credentials: HashMap<String, String> =
            serde_json::from_slice(&plaintext).context("Invalid decrypted data format")?;
        plaintext.zeroize();

        {
            let mut salt_guard = self.salt.write().expect("salt lock poisoned");
            *salt_guard = Some(salt);
        }
        {
            let mut key_guard = self
                .derived_key
                .write()
                .expect("derived_key lock poisoned");
            *key_guard = Some(key.to_vec());
        }
        {
            let mut creds_guard = self
                .credentials
                .write()
                .expect("credentials lock poisoned");
            *creds_guard = Some(credentials);
        }

        Ok(())
    }

    /// Zeroize all secrets and clear the in-memory credential map.
    pub fn lock(&self) {
        if let Ok(mut key_guard) = self.derived_key.write() {
            if let Some(ref mut key) = *key_guard {
                key.zeroize();
            }
            *key_guard = None;
        }
        if let Ok(mut creds_guard) = self.credentials.write() {
            if let Some(ref mut map) = *creds_guard {
                for value in map.values_mut() {
                    value.zeroize();
                }
            }
            *creds_guard = None;
        }
        if let Ok(mut salt_guard) = self.salt.write() {
            *salt_guard = None;
        }
    }

    /// Returns `true` if the store is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.derived_key
            .read()
            .expect("derived_key lock poisoned")
            .is_some()
    }

    /// Change the master password. Verifies the current password, then
    /// re-encrypts all credentials with a fresh salt and the new password.
    pub fn change_password(&self, current_password: &str, new_password: &str) -> Result<()> {
        // Verify the current password by re-deriving the key and comparing.
        let current_salt = {
            let salt_guard = self.salt.read().expect("salt lock poisoned");
            salt_guard
                .clone()
                .context("Store is locked — cannot change password")?
        };
        let current_key = derive_key(current_password, &current_salt)?;
        {
            let key_guard = self
                .derived_key
                .read()
                .expect("derived_key lock poisoned");
            let stored_key = key_guard
                .as_ref()
                .context("Store is locked — cannot change password")?;
            if current_key.as_slice() != stored_key.as_slice() {
                bail!("Current password is incorrect");
            }
        }

        // Generate a new salt and derive a new key.
        let mut new_salt = vec![0u8; SALT_LEN];
        OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(new_password, &new_salt)?;

        {
            let mut salt_guard = self.salt.write().expect("salt lock poisoned");
            *salt_guard = Some(new_salt);
        }
        {
            let mut key_guard = self
                .derived_key
                .write()
                .expect("derived_key lock poisoned");
            if let Some(ref mut old_key) = *key_guard {
                old_key.zeroize();
            }
            *key_guard = Some(new_key.to_vec());
        }

        self.save_to_disk()
            .context("Failed to re-encrypt credentials with new password")
    }

    /// Returns `true` if the credentials file exists on disk.
    pub fn has_credentials_file(&self) -> bool {
        self.file_path.exists()
    }

    /// Encrypt the in-memory credential map and write it to disk atomically.
    fn save_to_disk(&self) -> Result<()> {
        let salt = {
            let salt_guard = self.salt.read().expect("salt lock poisoned");
            salt_guard
                .clone()
                .context("Cannot save — store is locked")?
        };
        let key = {
            let key_guard = self
                .derived_key
                .read()
                .expect("derived_key lock poisoned");
            key_guard
                .clone()
                .context("Cannot save — store is locked")?
        };
        let creds = {
            let creds_guard = self
                .credentials
                .read()
                .expect("credentials lock poisoned");
            creds_guard
                .clone()
                .context("Cannot save — store is locked")?
        };

        let mut plaintext =
            serde_json::to_vec(&creds).context("Failed to serialize credentials")?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);

        let cipher =
            Aes256Gcm::new_from_slice(&key).context("Failed to create cipher")?;
        let nonce = Nonce::from_slice(&nonce_bytes);

        let payload = aes_gcm::aead::Payload {
            msg: plaintext.as_slice(),
            aad: AAD,
        };
        let ciphertext = cipher
            .encrypt(nonce, payload)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {e}"))?;
        plaintext.zeroize();

        let envelope = EncryptedEnvelope {
            version: ENVELOPE_VERSION,
            kdf: KdfParams {
                algorithm: "argon2id".to_string(),
                salt: BASE64.encode(&salt),
                memory_cost: ARGON2_MEMORY_COST,
                time_cost: ARGON2_TIME_COST,
                parallelism: ARGON2_PARALLELISM,
            },
            nonce: BASE64.encode(nonce_bytes),
            data: BASE64.encode(&ciphertext),
        };

        let json =
            serde_json::to_string_pretty(&envelope).context("Failed to serialize envelope")?;

        // Atomic write: write to a temp file, then rename.
        let tmp_path = self.file_path.with_extension("enc.tmp");
        fs::write(&tmp_path, json.as_bytes())
            .context("Failed to write temporary credentials file")?;
        fs::rename(&tmp_path, &self.file_path)
            .context("Failed to rename temporary credentials file")?;

        Ok(())
    }
}

impl CredentialStore for MasterPasswordStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        let creds_guard = self
            .credentials
            .read()
            .expect("credentials lock poisoned");
        let map = creds_guard
            .as_ref()
            .context("Store is locked — unlock before accessing credentials")?;
        let map_key = key.to_string();
        Ok(map.get(&map_key).cloned())
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        {
            let mut creds_guard = self
                .credentials
                .write()
                .expect("credentials lock poisoned");
            let map = creds_guard
                .as_mut()
                .context("Store is locked — unlock before accessing credentials")?;
            map.insert(key.to_string(), value.to_string());
        }
        self.save_to_disk()
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        let changed = {
            let mut creds_guard = self
                .credentials
                .write()
                .expect("credentials lock poisoned");
            let map = creds_guard
                .as_mut()
                .context("Store is locked — unlock before accessing credentials")?;
            map.remove(&key.to_string()).is_some()
        };
        if changed {
            self.save_to_disk()?;
        }
        Ok(())
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        let changed = {
            let mut creds_guard = self
                .credentials
                .write()
                .expect("credentials lock poisoned");
            let map = creds_guard
                .as_mut()
                .context("Store is locked — unlock before accessing credentials")?;
            let prefix = format!("{connection_id}:");
            let keys_to_remove: Vec<String> = map
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect();
            let had_keys = !keys_to_remove.is_empty();
            for k in keys_to_remove {
                map.remove(&k);
            }
            had_keys
        };
        if changed {
            self.save_to_disk()?;
        }
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        let creds_guard = self
            .credentials
            .read()
            .expect("credentials lock poisoned");
        let map = creds_guard
            .as_ref()
            .context("Store is locked — unlock before accessing credentials")?;
        let mut keys = Vec::new();
        for map_key in map.keys() {
            if let Some(ck) = parse_map_key(map_key) {
                keys.push(ck);
            }
        }
        Ok(keys)
    }

    fn status(&self) -> CredentialStoreStatus {
        if self.is_unlocked() {
            CredentialStoreStatus::Unlocked
        } else if self.has_credentials_file() {
            CredentialStoreStatus::Locked
        } else {
            CredentialStoreStatus::Unavailable
        }
    }
}

impl Drop for MasterPasswordStore {
    fn drop(&mut self) {
        self.lock();
    }
}

/// Derive a 256-bit key from a password and salt using Argon2id.
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = argon2::Params::new(
        ARGON2_MEMORY_COST,
        ARGON2_TIME_COST,
        ARGON2_PARALLELISM,
        Some(32),
    )
    .map_err(|e| anyhow::anyhow!("Invalid Argon2 parameters: {e}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("Argon2 key derivation failed: {e}"))?;
    Ok(key)
}

/// Parse a map key like `"conn-id:password"` back into a [`CredentialKey`].
fn parse_map_key(s: &str) -> Option<CredentialKey> {
    let (conn_id, type_str) = s.rsplit_once(':')?;
    let credential_type = match type_str {
        "password" => CredentialType::Password,
        "key_passphrase" => CredentialType::KeyPassphrase,
        _ => return None,
    };
    Some(CredentialKey::new(conn_id, credential_type))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn make_store(dir: &Path) -> MasterPasswordStore {
        MasterPasswordStore::new(dir.join("credentials.enc"))
    }

    #[test]
    fn setup_creates_valid_encrypted_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());

        store.setup("test-password").unwrap();

        assert!(store.file_path.exists());
        let raw = fs::read_to_string(&store.file_path).unwrap();
        let envelope: EncryptedEnvelope = serde_json::from_str(&raw).unwrap();
        assert_eq!(envelope.version, 1);
        assert_eq!(envelope.kdf.algorithm, "argon2id");
    }

    #[test]
    fn unlock_with_correct_password_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("my-password").unwrap();
        store.lock();

        assert!(!store.is_unlocked());
        store.unlock("my-password").unwrap();
        assert!(store.is_unlocked());
    }

    #[test]
    fn unlock_with_wrong_password_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("correct").unwrap();
        store.lock();

        let result = store.unlock("wrong");
        assert!(result.is_err());
        assert!(!store.is_unlocked());
    }

    #[test]
    fn set_then_get_returns_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "secret123").unwrap();

        let val = store.get(&key).unwrap();
        assert_eq!(val, Some("secret123".to_string()));
    }

    #[test]
    fn get_nonexistent_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("no-such-conn", CredentialType::Password);
        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn lock_clears_memory_get_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "secret").unwrap();

        store.lock();

        let result = store.get(&key);
        assert!(result.is_err());
    }

    #[test]
    fn remove_then_get_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "secret").unwrap();
        store.remove(&key).unwrap();

        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn remove_all_for_connection_removes_both_types() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let pw_key = CredentialKey::new("conn-1", CredentialType::Password);
        let kp_key = CredentialKey::new("conn-1", CredentialType::KeyPassphrase);
        store.set(&pw_key, "pass").unwrap();
        store.set(&kp_key, "phrase").unwrap();

        store.remove_all_for_connection("conn-1").unwrap();

        assert_eq!(store.get(&pw_key).unwrap(), None);
        assert_eq!(store.get(&kp_key).unwrap(), None);
    }

    #[test]
    fn change_password_re_encrypts() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("old-pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "my-secret").unwrap();

        store.change_password("old-pw", "new-pw").unwrap();
        store.lock();

        // Old password should no longer work.
        let result = store.unlock("old-pw");
        assert!(result.is_err());

        // New password should work and credentials should be preserved.
        store.unlock("new-pw").unwrap();
        assert_eq!(store.get(&key).unwrap(), Some("my-secret".to_string()));
    }

    #[test]
    fn file_is_valid_json_after_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "val1").unwrap();
        let raw = fs::read_to_string(&store.file_path).unwrap();
        assert!(serde_json::from_str::<EncryptedEnvelope>(&raw).is_ok());

        store.remove(&key).unwrap();
        let raw = fs::read_to_string(&store.file_path).unwrap();
        assert!(serde_json::from_str::<EncryptedEnvelope>(&raw).is_ok());
    }

    #[test]
    fn concurrent_reads_dont_block() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "concurrent-val").unwrap();

        std::thread::scope(|s| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    s.spawn(|| {
                        let k = CredentialKey::new("conn-1", CredentialType::Password);
                        store.get(&k).unwrap()
                    })
                })
                .collect();

            for h in handles {
                assert_eq!(h.join().unwrap(), Some("concurrent-val".to_string()));
            }
        });
    }

    #[test]
    fn list_keys_returns_stored_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let pw_key = CredentialKey::new("conn-1", CredentialType::Password);
        let kp_key = CredentialKey::new("conn-2", CredentialType::KeyPassphrase);
        store.set(&pw_key, "a").unwrap();
        store.set(&kp_key, "b").unwrap();

        let mut keys = store.list_keys().unwrap();
        keys.sort_by(|a, b| a.to_string().cmp(&b.to_string()));

        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0], pw_key);
        assert_eq!(keys[1], kp_key);
    }

    #[test]
    fn status_reflects_lock_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());

        // No file yet.
        assert_eq!(store.status(), CredentialStoreStatus::Unavailable);

        store.setup("pw").unwrap();
        assert_eq!(store.status(), CredentialStoreStatus::Unlocked);

        store.lock();
        assert_eq!(store.status(), CredentialStoreStatus::Locked);
    }

    #[test]
    fn has_credentials_file_reflects_existence() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());

        assert!(!store.has_credentials_file());
        store.setup("pw").unwrap();
        assert!(store.has_credentials_file());
    }

    #[test]
    fn is_unlocked_reflects_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());

        assert!(!store.is_unlocked());
        store.setup("pw").unwrap();
        assert!(store.is_unlocked());
        store.lock();
        assert!(!store.is_unlocked());
    }

    #[test]
    fn setup_fails_if_file_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let result = store.setup("pw2");
        assert!(result.is_err());
    }

    #[test]
    fn set_persists_across_unlock_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let store = make_store(dir.path());
        store.setup("pw").unwrap();

        let key = CredentialKey::new("conn-1", CredentialType::Password);
        store.set(&key, "persistent-val").unwrap();
        store.lock();

        store.unlock("pw").unwrap();
        assert_eq!(
            store.get(&key).unwrap(),
            Some("persistent-val".to_string())
        );
    }

    #[test]
    fn parse_map_key_roundtrip() {
        let key = CredentialKey::new("my-conn-id", CredentialType::Password);
        let map_key = key.to_string();
        let parsed = parse_map_key(&map_key).unwrap();
        assert_eq!(parsed, key);

        let key2 = CredentialKey::new("other-conn", CredentialType::KeyPassphrase);
        let map_key2 = key2.to_string();
        let parsed2 = parse_map_key(&map_key2).unwrap();
        assert_eq!(parsed2, key2);

        // Invalid type string.
        assert!(parse_map_key("conn:unknown_type").is_none());
        // No colon.
        assert!(parse_map_key("nodelimiter").is_none());
    }
}
