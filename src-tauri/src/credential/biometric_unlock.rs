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
//! Windows Hello verification) a 256-bit **wrapping key** seals the vault key
//! with AES-256-GCM into `biometric-unlock.json` in the config directory. The
//! AAD binds the ciphertext to the vault's salt fingerprint, the
//! biometric-enrollment fingerprint and the protection kind, so editing the
//! metadata file cannot re-bind it. The wrapping key itself is held in one of
//! two ways ([`KeyProtection`]), selected at runtime:
//!
//! - **OS-enforced** (#3534) — a [`HardwareKeyProtector`]: the macOS
//!   data-protection keychain behind `SecAccessControl(.biometryCurrentSet)`
//!   (signed builds with the `keychain-access-groups` entitlement), or a key
//!   derived from a Windows Hello key-credential signature. The OS itself
//!   prompts before the key can be used.
//! - **App-enforced** (fallback, and every enrollment made before #3534) — a
//!   random key in the OS credential store ([`SecretSlot`]), read only after
//!   termiHub's own OS verification.
//!
//! ## Migration
//!
//! App-enforced enrollments keep working. After the next successful
//! biometric unlock, if OS-enforced protection is available, the vault key is
//! transparently **re-wrapped** under a fresh OS-enforced key and the
//! app-enforced key is deleted. A failed or cancelled upgrade keeps the old
//! enrollment and is retried at most once per app run.
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
use std::sync::atomic::{AtomicBool, Ordering};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use zeroize::Zeroizing;

#[cfg(test)]
pub use super::biometric_slot::MemorySlot;
pub use super::biometric_slot::SecretSlot;
pub use super::biometric_types::{BiometricUnlockError, BiometricUnlockStatus, KeyProtection};
use super::hw_key::{HardwareKeyProtector, HwKeyError, WrappingKey};
use super::master_password::{MasterPasswordStore, UnlockFailure};
use super::os_auth::{OsAuthError, OsAuthSuccess};

/// File (in the config directory) holding the wrapped vault key + bindings.
pub const METADATA_FILE_NAME: &str = "biometric-unlock.json";
/// Metadata format version written by this build (2 adds `protection`).
const METADATA_VERSION: u32 = 2;
/// Domain-separation prefix of the AEAD associated data (app-enforced; kept
/// byte-identical so pre-#3534 enrollments still open).
const AAD_PREFIX: &[u8] = b"termihub-biometric-unlock/v1";
/// AAD prefix of OS-enforced enrollments.
const AAD_PREFIX_OS_ENFORCED: &[u8] = b"termihub-biometric-unlock/v2/os-enforced";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// The on-disk metadata: non-secret bindings plus the wrapped key.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    version: u32,
    /// Who protects the wrapping key. Absent in version-1 files (= app).
    #[serde(default)]
    protection: KeyProtection,
    /// Hex SHA-256 of the vault salt the key was derived with.
    salt_fingerprint: String,
    /// Hex SHA-256 of the biometric enrollment state at opt-in, if the OS
    /// exposes one (app-enforced only; the OS binds OS-enforced keys).
    enrollment_fingerprint: Option<String>,
    nonce: String,
    wrapped_key: String,
    created_at: String,
}

/// A wrapping key ready to be enrolled.
pub enum NewKey {
    /// App-enforced: a random key will be generated into the [`SecretSlot`].
    App {
        /// From the OS verification that authorised the enrollment.
        verified: OsAuthSuccess,
    },
    /// OS-enforced: the key was just created by the [`HardwareKeyProtector`].
    OsEnforced(WrappingKey),
}

/// What an OS prompt released for an unlock.
pub enum Released {
    /// App-enforced: termiHub's OS verification succeeded; the key is read
    /// from the [`SecretSlot`] next.
    App(OsAuthSuccess),
    /// OS-enforced: the OS released / derived the wrapping key.
    OsEnforced(WrappingKey),
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn aad(
    protection: KeyProtection,
    salt_fingerprint: &str,
    enrollment_fingerprint: Option<&str>,
) -> Vec<u8> {
    let mut aad = match protection {
        KeyProtection::App => AAD_PREFIX.to_vec(),
        KeyProtection::OsEnforced => AAD_PREFIX_OS_ENFORCED.to_vec(),
    };
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
    hw: Box<dyn HardwareKeyProtector>,
    /// Set once an app→OS-enforced upgrade was attempted in this run.
    upgrade_attempted: AtomicBool,
}

impl BiometricUnlock {
    /// Enrollment stored in `config_dir`, with the app-enforced wrapping key
    /// in `slot` and OS-enforced keys in `hw`.
    pub fn new(
        config_dir: &std::path::Path,
        slot: Box<dyn SecretSlot>,
        hw: Box<dyn HardwareKeyProtector>,
    ) -> Self {
        Self {
            metadata_path: config_dir.join(METADATA_FILE_NAME),
            slot,
            hw,
            upgrade_attempted: AtomicBool::new(false),
        }
    }

    /// Whether biometric unlock is turned on (an enrollment exists).
    pub fn is_enabled(&self) -> bool {
        self.metadata_path.exists()
    }

    /// How the current enrollment is protected; `None` when there is none or
    /// it is unreadable (never prompts, never invalidates).
    pub fn protection(&self) -> Option<KeyProtection> {
        let raw = fs::read_to_string(&self.metadata_path).ok()?;
        serde_json::from_str::<Metadata>(&raw)
            .ok()
            .map(|metadata| metadata.protection)
    }

    /// Whether a new enrollment would be OS-enforced. Never prompts.
    pub fn os_enforced_available(&self) -> bool {
        self.hw.probe().is_ok()
    }

    /// Delete the enrollment (both halves). Idempotent; attempts every delete
    /// even when one fails, and reports the first slot/file failure. A
    /// leftover OS-enforced key is only logged: it is useless without the
    /// wrapped vault key, and the next enrollment replaces it.
    pub fn disable(&self) -> anyhow::Result<()> {
        use anyhow::Context;
        let slot_result = self.slot.delete();
        if let Err(e) = self.hw.delete() {
            warn!(error = %e, "failed to delete the OS-enforced biometric unlock key");
        }
        let file_result = match fs::remove_file(&self.metadata_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context("Failed to delete the biometric unlock file"),
        };
        slot_result.and(file_result)
    }

    /// Obtain the key for a new enrollment. Prefers OS-enforced protection and
    /// falls back to app-enforced when it is unavailable. `verify` runs
    /// termiHub's own OS verification; it is skipped when creating the
    /// OS-enforced key already prompts (Windows Hello). Call without holding
    /// the store lock — this may show prompts.
    pub fn prepare_enrollment(
        &self,
        reason: &str,
        owner_window: Option<isize>,
        verify: impl FnOnce() -> Result<OsAuthSuccess, OsAuthError>,
    ) -> Result<NewKey, BiometricUnlockError> {
        let hw_available = match self.hw.probe() {
            Ok(()) => true,
            Err(e) => {
                info!(reason = %e, "biometric unlock uses app-enforced key protection");
                false
            }
        };
        // Windows Hello: creating the key prompts, so it replaces termiHub's
        // own verification. macOS: creating the item does not prompt, so the
        // user is verified first.
        let create_prompts = hw_available && self.hw.create_prompts();
        if create_prompts {
            if let Some(key) = self.try_create_os_enforced(reason, owner_window)? {
                return Ok(NewKey::OsEnforced(key));
            }
        }
        let verified = verify()?;
        if hw_available && !create_prompts {
            if let Some(key) = self.try_create_os_enforced(reason, owner_window)? {
                return Ok(NewKey::OsEnforced(key));
            }
        }
        Ok(NewKey::App { verified })
    }

    /// Create an OS-enforced key; `Ok(None)` when it turns out to be
    /// unavailable (the caller falls back to app-enforced).
    fn try_create_os_enforced(
        &self,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<Option<WrappingKey>, BiometricUnlockError> {
        match self.hw.create(reason, owner_window) {
            Ok(key) => Ok(Some(key)),
            Err(HwKeyError::Unavailable(why)) => {
                warn!(reason = %why, "OS-enforced key unavailable; using app-enforced");
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Opt in with a key from [`prepare_enrollment`](Self::prepare_enrollment).
    /// The caller has already verified the master password against the
    /// unlocked `store`.
    pub fn enable(
        &self,
        store: &MasterPasswordStore,
        new_key: NewKey,
    ) -> Result<(), BiometricUnlockError> {
        let os_enforced = matches!(new_key, NewKey::OsEnforced(_));
        let result = self.enable_inner(store, new_key);
        if result.is_err() && os_enforced {
            // Never leave a lone OS-enforced key behind.
            if let Err(cleanup) = self.hw.delete() {
                warn!(error = %cleanup, "failed to remove the OS-enforced key after a failed enable");
            }
        }
        result
    }

    fn enable_inner(
        &self,
        store: &MasterPasswordStore,
        new_key: NewKey,
    ) -> Result<(), BiometricUnlockError> {
        let (key, salt) = store.key_material().ok_or_else(|| {
            BiometricUnlockError::store_unavailable("Unlock the credential store first.")
        })?;
        let salt_fingerprint = hex_sha256(&salt);
        match new_key {
            NewKey::OsEnforced(wrapping_key) => {
                let json = seal(
                    &wrapping_key,
                    key.as_slice(),
                    KeyProtection::OsEnforced,
                    salt_fingerprint,
                    None,
                )?;
                self.write_metadata(&json)?;
                // The app-enforced key (if any, e.g. after an upgrade) is now
                // superseded.
                if let Err(e) = self.slot.delete() {
                    warn!(error = %e, "failed to delete the superseded app-enforced key");
                }
                info!("biometric unlock enabled (OS-enforced key)");
            }
            NewKey::App { verified } => {
                let mut wrapping_key = Zeroizing::new([0u8; KEY_LEN]);
                OsRng.fill_bytes(wrapping_key.as_mut());
                let json = seal(
                    &wrapping_key,
                    key.as_slice(),
                    KeyProtection::App,
                    salt_fingerprint,
                    verified.enrollment_fingerprint.map(hex::encode),
                )?;
                let encoded_key = Zeroizing::new(BASE64.encode(wrapping_key.as_ref()));
                self.slot
                    .write(&encoded_key)
                    .map_err(|e| BiometricUnlockError::other(format!("{e:#}")))?;
                if let Err(e) = self.write_metadata(&json) {
                    // Never leave a lone wrapping key behind.
                    if let Err(cleanup) = self.slot.delete() {
                        warn!(error = %cleanup, "failed to remove biometric unlock key after a failed enable");
                    }
                    return Err(e);
                }
                if let Err(e) = self.hw.delete() {
                    warn!(error = %e, "failed to delete a stale OS-enforced key");
                }
                info!("biometric unlock enabled (app-enforced key)");
            }
        }
        Ok(())
    }

    fn write_metadata(&self, json: &str) -> Result<(), BiometricUnlockError> {
        crate::utils::fs::write_atomic(&self.metadata_path, json).map_err(|e| {
            BiometricUnlockError::other(format!("Failed to save the biometric unlock file: {e:#}"))
        })
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
            // Version 1 (pre-#3534) has no `protection` field: app-enforced.
            Ok(metadata)
                if metadata.version == METADATA_VERSION
                    || (metadata.version == 1 && metadata.protection == KeyProtection::App) =>
            {
                Ok(metadata)
            }
            _ => Err(self.invalidate("The biometric unlock data is unreadable.")),
        }
    }

    /// Check that the enrollment still belongs to the vault's current key and
    /// report how it is protected. Never prompts, so a stale enrollment is
    /// dropped before asking for a fingerprint.
    pub fn precheck(
        &self,
        store: &MasterPasswordStore,
    ) -> Result<KeyProtection, BiometricUnlockError> {
        let metadata = self.load_metadata()?;
        self.check_salt(store, &metadata)?;
        Ok(metadata.protection)
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

    /// Ask the OS to release an OS-enforced key (prompts). Call without
    /// holding the store lock, after [`precheck`](Self::precheck).
    pub fn release_os_enforced(
        &self,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<Released, BiometricUnlockError> {
        match self.hw.release(reason, owner_window) {
            Ok(key) => Ok(Released::OsEnforced(key)),
            Err(HwKeyError::Missing) => Err(self.invalidate(
                "The biometric unlock key no longer exists (your fingerprints or face data may \
                 have changed).",
            )),
            Err(HwKeyError::Unavailable(_)) => Err(self.invalidate(
                "This build or device can no longer use the OS-protected biometric unlock key.",
            )),
            Err(e) => Err(e.into()),
        }
    }

    /// Unlock `store` with what the OS released. For the app-enforced path
    /// the caller ran a successful OS verification for
    /// [`OsAuthPurpose::BiometricUnlock`](super::os_auth::OsAuthPurpose::BiometricUnlock)
    /// after [`precheck`](Self::precheck), so the wrapping key is only read
    /// from the OS store after the user was verified.
    pub fn unlock(
        &self,
        store: &MasterPasswordStore,
        released: Released,
    ) -> Result<(), BiometricUnlockError> {
        let metadata = self.load_metadata()?;
        self.check_salt(store, &metadata)?;

        let wrapping_key = match (released, metadata.protection) {
            (Released::OsEnforced(key), KeyProtection::OsEnforced) => key,
            (Released::App(verified), KeyProtection::App) => {
                self.read_app_key(&metadata, &verified)?
            }
            _ => {
                return Err(BiometricUnlockError::other(
                    "Biometric unlock changed while unlocking. Try again.",
                ))
            }
        };
        let key = self.unwrap_vault_key(&metadata, &wrapping_key)?;

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

    fn read_app_key(
        &self,
        metadata: &Metadata,
        verified: &OsAuthSuccess,
    ) -> Result<WrappingKey, BiometricUnlockError> {
        let presented = verified.enrollment_fingerprint.map(hex::encode);
        if presented != metadata.enrollment_fingerprint {
            return Err(self.invalidate("Your fingerprints or face data have changed."));
        }
        let encoded_key = match self.slot.read() {
            Ok(Some(value)) => value,
            Ok(None) => return Err(self.invalidate("The biometric unlock key is missing.")),
            Err(e) => return Err(BiometricUnlockError::other(format!("{e:#}"))),
        };
        match BASE64.decode(encoded_key.as_bytes()) {
            Ok(bytes) if bytes.len() == KEY_LEN => {
                let bytes = Zeroizing::new(bytes);
                let mut key = Zeroizing::new([0u8; KEY_LEN]);
                key.copy_from_slice(&bytes);
                Ok(key)
            }
            _ => Err(self.invalidate("The biometric unlock key is invalid.")),
        }
    }

    fn unwrap_vault_key(
        &self,
        metadata: &Metadata,
        wrapping_key: &WrappingKey,
    ) -> Result<Zeroizing<Vec<u8>>, BiometricUnlockError> {
        let nonce = match BASE64.decode(&metadata.nonce) {
            Ok(bytes) if bytes.len() == NONCE_LEN => bytes,
            _ => return Err(self.invalidate("The biometric unlock data is unreadable.")),
        };
        let Ok(wrapped) = BASE64.decode(&metadata.wrapped_key) else {
            return Err(self.invalidate("The biometric unlock data is unreadable."));
        };
        let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
            .map_err(|e| BiometricUnlockError::other(format!("cipher init failed: {e}")))?;
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &wrapped,
                    aad: &aad(
                        metadata.protection,
                        &metadata.salt_fingerprint,
                        metadata.enrollment_fingerprint.as_deref(),
                    ),
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| self.invalidate("The biometric unlock data does not match."))
    }

    /// Whether an app-enforced enrollment should be upgraded to OS-enforced
    /// now: it is app-enforced, OS-enforced protection is available, and no
    /// upgrade was attempted yet in this run (marks the attempt).
    pub fn take_upgrade_opportunity(&self) -> bool {
        self.protection() == Some(KeyProtection::App)
            && !self.upgrade_attempted.load(Ordering::SeqCst)
            && self.os_enforced_available()
            && !self.upgrade_attempted.swap(true, Ordering::SeqCst)
    }

    /// Create a fresh OS-enforced key for an upgrade (may prompt; call
    /// without holding the store lock).
    pub fn create_os_enforced_key(
        &self,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<WrappingKey, HwKeyError> {
        self.hw.create(reason, owner_window)
    }
}

/// Seal `vault_key` under `wrapping_key` and serialize the metadata.
fn seal(
    wrapping_key: &WrappingKey,
    vault_key: &[u8],
    protection: KeyProtection,
    salt_fingerprint: String,
    enrollment_fingerprint: Option<String>,
) -> Result<String, BiometricUnlockError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
        .map_err(|e| BiometricUnlockError::other(format!("cipher init failed: {e}")))?;
    let wrapped = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: vault_key,
                aad: &aad(
                    protection,
                    &salt_fingerprint,
                    enrollment_fingerprint.as_deref(),
                ),
            },
        )
        .map_err(|e| BiometricUnlockError::other(format!("key wrapping failed: {e}")))?;
    let metadata = Metadata {
        version: METADATA_VERSION,
        protection,
        salt_fingerprint,
        enrollment_fingerprint,
        nonce: BASE64.encode(nonce),
        wrapped_key: BASE64.encode(wrapped),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    serde_json::to_string_pretty(&metadata)
        .map_err(|e| BiometricUnlockError::other(format!("serialization failed: {e}")))
}

/// The purpose-specific prompt reasons (complete "termiHub is trying to …").
pub const ENABLE_REASON: &str = "turn on biometric unlock for your saved credentials";
/// Prompt reason for a biometric unlock.
pub const UNLOCK_REASON: &str = "unlock your saved credentials";

#[cfg(test)]
#[path = "biometric_unlock_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "biometric_unlock_hw_tests.rs"]
mod hw_tests;
