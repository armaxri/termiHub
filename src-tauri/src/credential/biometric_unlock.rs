//! Biometric unlock of the master-password store (PROD-064).
//!
//! The master password is **not** weakened or replaced: it stays the only way
//! to set up the store, change it, or enable biometric unlock, and the
//! credentials file stays sealed with the Argon2id-derived key exactly as
//! before. Biometric unlock is an opt-in shortcut that releases a copy of the
//! already-derived vault key after a successful OS verification.
//!
//! ## Key protection
//!
//! On opt-in (master password re-entered **and** a successful Touch ID /
//! Windows Hello verification):
//!
//! 1. A fresh random 256-bit **wrapping key** is generated and stored in the
//!    OS credential store (macOS Keychain / Windows Credential Manager, which
//!    DPAPI-protects it) under its own service name.
//! 2. The vault key is sealed with AES-256-GCM under the wrapping key. The
//!    ciphertext lives in `biometric-unlock.json` in the config directory,
//!    next to `credentials.enc`. The AAD binds the ciphertext to the vault's
//!    salt fingerprint and the biometric-enrollment fingerprint, so editing
//!    the metadata file cannot re-bind it.
//!
//! Neither half alone reveals the key. Unlocking requires, in order: the
//! enrollment still matching the vault's current salt (a master-password
//! change regenerates the salt), a successful OS verification, an unchanged
//! biometric enrollment (macOS), the wrapping key from the OS store, and the
//! AEAD-authenticated unwrap; the vault file then authenticates the key again.
//!
//! ## Invalidation
//!
//! Any mismatch **deletes** the enrollment (both halves) and reports
//! [`BiometricUnlockError::Invalidated`], so the user falls back to the master
//! password and can re-enable it. The enrollment is also deleted when the
//! master password changes, the store is reset, the store mode is switched
//! away from master password, or the user opts out. A cancelled or failed OS
//! prompt does **not** delete it.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use zeroize::Zeroizing;

use super::master_password::{MasterPasswordStore, UnlockFailure};
use super::os_auth::{OsAuthError, OsAuthSuccess};

/// File (in the config directory) holding the wrapped vault key + bindings.
pub const METADATA_FILE_NAME: &str = "biometric-unlock.json";
// The keyring slot is only constructed by production builds (tests use
// `MemorySlot`), hence the test-only dead-code allowances below.
/// OS credential-store service name for the wrapping key. Distinct from the
/// `termiHub` service used by OS-keychain credential storage.
#[cfg_attr(test, allow(dead_code))]
const KEYRING_SERVICE: &str = "termiHub-biometric-unlock";
/// OS credential-store account name for the wrapping key.
#[cfg_attr(test, allow(dead_code))]
const KEYRING_ACCOUNT: &str = "master-password-store";
/// Metadata format version written by this build.
const METADATA_VERSION: u32 = 1;
/// Domain-separation prefix of the AEAD associated data.
const AAD_PREFIX: &[u8] = b"termihub-biometric-unlock/v1";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// Where the wrapping key is kept. Abstracted so tests never touch the real
/// OS credential store.
pub trait SecretSlot: Send + Sync {
    /// Read the stored secret, `None` when there is none.
    fn read(&self) -> Result<Option<Zeroizing<String>>>;
    /// Store (or replace) the secret.
    fn write(&self, value: &str) -> Result<()>;
    /// Delete the secret. Deleting a missing secret is not an error.
    fn delete(&self) -> Result<()>;
}

impl<T: SecretSlot + ?Sized> SecretSlot for Arc<T> {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        (**self).read()
    }

    fn write(&self, value: &str) -> Result<()> {
        (**self).write(value)
    }

    fn delete(&self) -> Result<()> {
        (**self).delete()
    }
}

/// [`SecretSlot`] in the native OS credential store via `keyring`.
#[derive(Default)]
#[cfg_attr(test, allow(dead_code))]
pub struct KeyringSlot {
    entry: Mutex<Option<Arc<keyring::Entry>>>,
}

impl KeyringSlot {
    #[cfg_attr(test, allow(dead_code))]
    fn entry(&self) -> Result<Arc<keyring::Entry>> {
        let mut guard = self.entry.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.as_ref() {
            return Ok(entry.clone());
        }
        let entry = Arc::new(
            keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .context("Failed to open the OS credential store entry for biometric unlock")?,
        );
        *guard = Some(entry.clone());
        Ok(entry)
    }
}

impl SecretSlot for KeyringSlot {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("Failed to read the biometric unlock key"),
        }
    }

    fn write(&self, value: &str) -> Result<()> {
        self.entry()?
            .set_password(value)
            .context("Failed to store the biometric unlock key")
    }

    fn delete(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("Failed to delete the biometric unlock key"),
        }
    }
}

/// In-memory [`SecretSlot`] for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemorySlot {
    value: Mutex<Option<String>>,
    /// When set, `write` fails (to exercise rollback).
    pub fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MemorySlot {
    /// Whether a secret is currently stored.
    pub fn has_value(&self) -> bool {
        self.value.lock().unwrap().is_some()
    }

    /// Replace the stored secret directly (simulates tampering / loss).
    pub fn overwrite(&self, value: Option<&str>) {
        *self.value.lock().unwrap() = value.map(str::to_string);
    }
}

#[cfg(test)]
impl SecretSlot for MemorySlot {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        Ok(self.value.lock().unwrap().clone().map(Zeroizing::new))
    }

    fn write(&self, value: &str) -> Result<()> {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            anyhow::bail!("simulated write failure");
        }
        *self.value.lock().unwrap() = Some(value.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<()> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

/// The on-disk metadata: non-secret bindings plus the wrapped key.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    version: u32,
    /// Hex SHA-256 of the vault salt the key was derived with.
    salt_fingerprint: String,
    /// Hex SHA-256 of the biometric enrollment state at opt-in, if the OS
    /// exposes one.
    enrollment_fingerprint: Option<String>,
    nonce: String,
    wrapped_key: String,
    created_at: String,
}

/// Why a biometric-unlock operation failed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BiometricUnlockError {
    /// Biometric unlock has not been turned on.
    #[error("{message}")]
    NotEnabled { message: String },
    /// The enrollment no longer matches (master password or biometric
    /// enrollment changed, key missing or tampered). It has been deleted.
    #[error("{message}")]
    Invalidated { message: String },
    /// The OS prompt was cancelled (including the "use master password"
    /// fallback button).
    #[error("{message}")]
    Cancelled { message: String },
    /// The OS rejected the user or verification is unavailable.
    #[error("{message}")]
    AuthFailed { message: String },
    /// The master password given to opt in was wrong.
    #[error("{message}")]
    WrongMasterPassword { message: String },
    /// The store must be unlocked (to opt in) / in master-password mode.
    #[error("{message}")]
    StoreUnavailable { message: String },
    /// The credentials file itself cannot be read (not an enrollment issue).
    #[error("{message}")]
    StoreCorrupted { message: String },
    /// Any other failure.
    #[error("{message}")]
    Other { message: String },
}

impl BiometricUnlockError {
    pub(crate) fn other(message: impl Into<String>) -> Self {
        Self::Other {
            message: message.into(),
        }
    }

    pub(crate) fn store_unavailable(message: impl Into<String>) -> Self {
        Self::StoreUnavailable {
            message: message.into(),
        }
    }
}

impl From<OsAuthError> for BiometricUnlockError {
    fn from(error: OsAuthError) -> Self {
        match error {
            OsAuthError::Cancelled => Self::Cancelled {
                message: error.to_string(),
            },
            other => Self::AuthFailed {
                message: other.to_string(),
            },
        }
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn aad(salt_fingerprint: &str, enrollment_fingerprint: Option<&str>) -> Vec<u8> {
    let mut aad = AAD_PREFIX.to_vec();
    aad.push(0);
    aad.extend_from_slice(salt_fingerprint.as_bytes());
    aad.push(0);
    aad.extend_from_slice(enrollment_fingerprint.unwrap_or("-").as_bytes());
    aad
}

/// Biometric-unlock enrollment for one master-password store.
pub struct BiometricUnlock {
    metadata_path: PathBuf,
    slot: Box<dyn SecretSlot>,
}

impl BiometricUnlock {
    /// Enrollment stored in `config_dir` with the wrapping key in `slot`.
    pub fn new(config_dir: &std::path::Path, slot: Box<dyn SecretSlot>) -> Self {
        Self {
            metadata_path: config_dir.join(METADATA_FILE_NAME),
            slot,
        }
    }

    /// Whether biometric unlock is turned on (an enrollment exists).
    pub fn is_enabled(&self) -> bool {
        self.metadata_path.exists()
    }

    /// Delete the enrollment (both halves). Idempotent; attempts both deletes
    /// even when one fails, and reports the first failure.
    pub fn disable(&self) -> Result<()> {
        let slot_result = self.slot.delete();
        let file_result = match fs::remove_file(&self.metadata_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context("Failed to delete the biometric unlock file"),
        };
        slot_result.and(file_result)
    }

    /// Opt in. The caller has already verified the master password against
    /// the unlocked `store` and obtained `verified` from a successful OS
    /// verification for
    /// [`OsAuthPurpose::EnableBiometricUnlock`](super::os_auth::OsAuthPurpose::EnableBiometricUnlock).
    pub fn enable(
        &self,
        store: &MasterPasswordStore,
        verified: &OsAuthSuccess,
    ) -> Result<(), BiometricUnlockError> {
        let (key, salt) = store.key_material().ok_or_else(|| {
            BiometricUnlockError::store_unavailable("Unlock the credential store first.")
        })?;
        let salt_fingerprint = hex_sha256(&salt);
        let enrollment_fingerprint = verified.enrollment_fingerprint.map(hex::encode);

        let mut wrapping_key = Zeroizing::new([0u8; KEY_LEN]);
        OsRng.fill_bytes(wrapping_key.as_mut());
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
            .map_err(|e| BiometricUnlockError::other(format!("cipher init failed: {e}")))?;
        let wrapped = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: key.as_slice(),
                    aad: &aad(&salt_fingerprint, enrollment_fingerprint.as_deref()),
                },
            )
            .map_err(|e| BiometricUnlockError::other(format!("key wrapping failed: {e}")))?;

        let metadata = Metadata {
            version: METADATA_VERSION,
            salt_fingerprint,
            enrollment_fingerprint,
            nonce: BASE64.encode(nonce),
            wrapped_key: BASE64.encode(wrapped),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let json = serde_json::to_string_pretty(&metadata)
            .map_err(|e| BiometricUnlockError::other(format!("serialization failed: {e}")))?;

        let encoded_key = Zeroizing::new(BASE64.encode(wrapping_key.as_ref()));
        self.slot
            .write(&encoded_key)
            .map_err(|e| BiometricUnlockError::other(format!("{e:#}")))?;
        if let Err(e) = crate::utils::fs::write_atomic(&self.metadata_path, &json) {
            // Never leave a lone wrapping key behind.
            if let Err(cleanup) = self.slot.delete() {
                warn!(error = %cleanup, "failed to remove biometric unlock key after a failed enable");
            }
            return Err(BiometricUnlockError::other(format!(
                "Failed to save the biometric unlock file: {e:#}"
            )));
        }
        info!("biometric unlock enabled");
        Ok(())
    }

    /// Delete the enrollment and build the [`BiometricUnlockError::Invalidated`]
    /// error explaining why.
    fn invalidate(&self, why: &str) -> BiometricUnlockError {
        warn!(reason = why, "biometric unlock invalidated");
        if let Err(e) = self.disable() {
            warn!(error = %e, "failed to delete an invalidated biometric unlock enrollment");
        }
        BiometricUnlockError::Invalidated {
            message: format!(
                "{why} Biometric unlock has been turned off — unlock with your master password, \
                 then turn it on again in Settings → Security."
            ),
        }
    }

    fn load_metadata(&self) -> Result<Metadata, BiometricUnlockError> {
        let raw = match fs::read_to_string(&self.metadata_path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(BiometricUnlockError::NotEnabled {
                    message: "Biometric unlock is not turned on.".to_string(),
                })
            }
            Err(e) => {
                return Err(BiometricUnlockError::other(format!(
                    "Failed to read the biometric unlock file: {e}"
                )))
            }
        };
        match serde_json::from_str::<Metadata>(&raw) {
            Ok(metadata) if metadata.version == METADATA_VERSION => Ok(metadata),
            _ => Err(self.invalidate("The biometric unlock data is unreadable.")),
        }
    }

    /// Check that the enrollment still belongs to the vault's current key.
    /// Never prompts, so a stale enrollment is dropped before asking for a
    /// fingerprint.
    pub fn precheck(&self, store: &MasterPasswordStore) -> Result<(), BiometricUnlockError> {
        let metadata = self.load_metadata()?;
        self.check_salt(store, &metadata)
    }

    fn check_salt(
        &self,
        store: &MasterPasswordStore,
        metadata: &Metadata,
    ) -> Result<(), BiometricUnlockError> {
        let salt = store.file_salt().map_err(|failure| match failure {
            UnlockFailure::WrongPassword => BiometricUnlockError::other(failure.to_string()),
            other => BiometricUnlockError::StoreCorrupted {
                message: other.to_string(),
            },
        })?;
        if hex_sha256(&salt) != metadata.salt_fingerprint {
            return Err(self.invalidate("The master password has changed."));
        }
        Ok(())
    }

    /// Unlock `store` with the enrolled key. The caller has already run a
    /// successful OS verification for
    /// [`OsAuthPurpose::BiometricUnlock`](super::os_auth::OsAuthPurpose::BiometricUnlock)
    /// (`verified`) — after [`precheck`](Self::precheck) — so the wrapping
    /// key is only read from the OS store after the user was verified.
    pub fn unlock(
        &self,
        store: &MasterPasswordStore,
        verified: &OsAuthSuccess,
    ) -> Result<(), BiometricUnlockError> {
        let metadata = self.load_metadata()?;
        self.check_salt(store, &metadata)?;

        let presented = verified.enrollment_fingerprint.map(hex::encode);
        if presented != metadata.enrollment_fingerprint {
            return Err(self.invalidate("Your fingerprints or face data have changed."));
        }

        let encoded_key = match self.slot.read() {
            Ok(Some(value)) => value,
            Ok(None) => {
                return Err(self.invalidate("The biometric unlock key is missing."));
            }
            Err(e) => return Err(BiometricUnlockError::other(format!("{e:#}"))),
        };
        let wrapping_key = match BASE64.decode(encoded_key.as_bytes()) {
            Ok(bytes) if bytes.len() == KEY_LEN => Zeroizing::new(bytes),
            _ => return Err(self.invalidate("The biometric unlock key is invalid.")),
        };
        let nonce = match BASE64.decode(&metadata.nonce) {
            Ok(bytes) if bytes.len() == NONCE_LEN => bytes,
            _ => return Err(self.invalidate("The biometric unlock data is unreadable.")),
        };
        let Ok(wrapped) = BASE64.decode(&metadata.wrapped_key) else {
            return Err(self.invalidate("The biometric unlock data is unreadable."));
        };
        let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_slice())
            .map_err(|e| BiometricUnlockError::other(format!("cipher init failed: {e}")))?;
        let key = match cipher.decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &wrapped,
                aad: &aad(
                    &metadata.salt_fingerprint,
                    metadata.enrollment_fingerprint.as_deref(),
                ),
            },
        ) {
            Ok(key) => Zeroizing::new(key),
            Err(_) => return Err(self.invalidate("The biometric unlock data does not match.")),
        };

        match store.unlock_with_key(&key) {
            Ok(()) => {
                info!("credential store unlocked with biometrics");
                Ok(())
            }
            Err(UnlockFailure::WrongPassword) => {
                Err(self.invalidate("The stored key no longer opens the credential store."))
            }
            Err(other) => Err(BiometricUnlockError::StoreCorrupted {
                message: other.to_string(),
            }),
        }
    }
}

/// Biometric-unlock state reported to the UI.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BiometricUnlockStatus {
    /// The OS can verify the user biometrically here (the option is shown).
    pub supported: bool,
    /// Biometric unlock is turned on for the current master-password store.
    pub enabled: bool,
    /// User-facing mechanism name, e.g. "Touch ID" or "Windows Hello".
    pub method_label: String,
    /// Why it is not supported, when `supported` is `false`.
    pub reason: Option<String>,
}

/// The purpose-specific prompt reasons (complete "termiHub is trying to …").
pub const ENABLE_REASON: &str = "turn on biometric unlock for your saved credentials";
/// Prompt reason for a biometric unlock.
pub const UNLOCK_REASON: &str = "unlock your saved credentials";

#[cfg(test)]
#[path = "biometric_unlock_tests.rs"]
mod tests;
