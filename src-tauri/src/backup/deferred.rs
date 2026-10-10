//! Deferred credential import of a backup restore (#4414).
//!
//! A restore that is applied at the next start (PROD-068) imports its
//! credentials right away when the store keeps a single vault file (the
//! master-password vault): a failed swap puts that file back (#4295). A store
//! without such a file (the OS keychain) cannot be reverted, so its import is
//! **deferred** instead and never needs a revert:
//!
//! 1. **Restore** ([`seal`]): the credentials the import would write are sealed
//!    with AES-256-GCM under a fresh random key and written into the staging
//!    directory ([`SEALED_IMPORT_FILE`]), committed together with the stores.
//!    The key lives only in the OS credential store
//!    ([`CredentialStore::restore_seal_slot`]); no secret is ever written to
//!    disk in plaintext.
//! 2. **Next start, before any store loads** ([`promote`] / [`discard`]): a
//!    successful swap moves the sealed import out of the pending directory to
//!    [`DEFERRED_IMPORT_FILE`]; a failed swap deletes it, so the credentials
//!    stay exactly as before the restore.
//! 3. **Once the credential store is available** ([`apply_deferred_import`]):
//!    the import is unsealed and written as one batch, then the sealed file and
//!    its key are deleted.
//!
//! Every step is idempotent. Each sealed entry carries a hash of the value it
//! replaces, so an entry is written only while the store still holds that
//! value: an entry already written (a start that crashed mid-apply) is not
//! written twice, and a credential changed after the restore is never
//! overwritten. Keys that are no longer needed are queued in
//! [`SEAL_KEY_CLEANUP_FILE`] (key ids only, no secrets) and deleted once the
//! store is available, so a crash never leaves one behind for good.

use std::path::Path;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};
use zeroize::{Zeroize, Zeroizing};

use super::commit::sha256_hex;
use crate::connection::recovery::RecoveryWarning;
use crate::credential::biometric_slot::SecretSlot;
use crate::credential::types::CredentialKey;
use crate::credential::vault::VaultError;
use crate::credential::CredentialStore;
use crate::utils::fs::write_atomic;

/// The sealed import inside a committed restore's pending directory.
pub const SEALED_IMPORT_FILE: &str = "credentials-deferred.json";
/// The sealed import of a restore whose swap succeeded, in the config dir,
/// waiting for the credential store.
pub const DEFERRED_IMPORT_FILE: &str = ".backup-restore-credentials.json";
/// Ids of seal keys still to delete from the OS credential store.
pub const SEAL_KEY_CLEANUP_FILE: &str = ".backup-restore-seal-keys.json";

const SEALED_FORMAT: u32 = 1;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Associated data prefix; the key id is appended, binding the ciphertext to
/// the key that sealed it.
const AAD_PREFIX: &[u8] = b"termihub-backup-restore-credentials:";

/// The on-disk sealed import. Only the key id is readable without the key.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedImport {
    format: u32,
    key_id: String,
    nonce: String,
    data: String,
}

/// One credential the import writes. The value is zeroized on drop.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeferredEntry {
    key: String,
    value: String,
    /// SHA-256 (hex) of the value this entry replaces; `None` when the key
    /// did not exist when the restore was made.
    previous_sha256: Option<String>,
}

impl Drop for DeferredEntry {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct DeferredPayload {
    entries: Vec<DeferredEntry>,
}

fn other(message: impl Into<String>) -> VaultError {
    VaultError::Other {
        message: message.into(),
    }
}

fn aad(key_id: &str) -> Vec<u8> {
    let mut aad = AAD_PREFIX.to_vec();
    aad.extend_from_slice(key_id.as_bytes());
    aad
}

/// A key id is a UUID; anything else is rejected before it names a keychain
/// entry.
fn valid_key_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

/// A fresh seal-key id.
pub(super) fn new_key_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Seal `entries` into `staging` under a new random key stored in `slot`.
///
/// Reads the current value of every entry from `store` to record what it
/// replaces. On error nothing is left behind: neither the key nor the file.
pub(super) fn seal(
    store: &dyn CredentialStore,
    slot: &dyn SecretSlot,
    key_id: &str,
    staging: &Path,
    entries: &[(CredentialKey, String)],
) -> Result<(), VaultError> {
    let mut payload = DeferredPayload {
        entries: Vec::with_capacity(entries.len()),
    };
    for (key, value) in entries {
        let previous = store
            .get(key)
            .map_err(|e| {
                other(format!(
                    "Could not read the current credential store: {e:#}"
                ))
            })?
            .map(Zeroizing::new);
        payload.entries.push(DeferredEntry {
            key: key.to_string(),
            value: value.clone(),
            previous_sha256: previous.map(|v| sha256_hex(v.as_bytes())),
        });
    }
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&payload)
            .map_err(|e| other(format!("Could not seal the credentials: {e}")))?,
    );
    drop(payload);

    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(key.as_mut());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|e| other(format!("Could not seal the credentials: {e}")))?;
    let aad = aad(key_id);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_slice(),
                aad: &aad,
            },
        )
        .map_err(|e| other(format!("Could not seal the credentials: {e}")))?;
    let sealed = SealedImport {
        format: SEALED_FORMAT,
        key_id: key_id.to_string(),
        nonce: BASE64.encode(nonce),
        data: BASE64.encode(ciphertext),
    };
    let text = serde_json::to_string_pretty(&sealed)
        .map_err(|e| other(format!("Could not seal the credentials: {e}")))?;

    let encoded_key = Zeroizing::new(BASE64.encode(key.as_ref()));
    slot.write(&encoded_key).map_err(|e| {
        other(format!(
            "Could not store the key that seals the restored credentials: {e:#}"
        ))
    })?;
    if let Err(e) = write_atomic(&staging.join(SEALED_IMPORT_FILE), &text) {
        delete_key(slot, key_id);
        return Err(other(format!("Could not stage the credentials: {e:#}")));
    }
    Ok(())
}

/// Best-effort: delete a seal key, logging a failure.
pub(super) fn delete_key(slot: &dyn SecretSlot, key_id: &str) {
    if let Err(e) = slot.delete() {
        warn!(key_id, "Could not delete a backup-restore seal key: {e:#}");
    }
}

/// The key id of a sealed import file.
fn read_key_id(path: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let sealed: SealedImport = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !valid_key_id(&sealed.key_id) {
        return Err("it names an invalid key".to_string());
    }
    Ok(sealed.key_id)
}

/// Delete the seal key of the sealed import in `pending`, if any, through
/// `store` (an earlier pending restore superseded by a new one).
pub(super) fn discard_with_store(pending: &Path, store: &dyn CredentialStore) {
    let path = pending.join(SEALED_IMPORT_FILE);
    if !path.is_file() {
        return;
    }
    match read_key_id(&path) {
        Ok(id) => match store.restore_seal_slot(&id) {
            Some(slot) => delete_key(slot.as_ref(), &id),
            None => queue_key_cleanup_logged(pending.parent(), &id),
        },
        Err(e) => warn!("Could not read a superseded sealed credential import: {e}"),
    }
}

fn read_cleanup_list(config_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(config_dir.join(SEAL_KEY_CLEANUP_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| valid_key_id(id))
        .collect()
}

/// Queue a seal key for deletion once the credential store is available.
fn queue_key_cleanup(config_dir: &Path, key_id: &str) -> anyhow::Result<()> {
    let mut ids = read_cleanup_list(config_dir);
    if !ids.iter().any(|id| id == key_id) {
        ids.push(key_id.to_string());
    }
    write_atomic(
        &config_dir.join(SEAL_KEY_CLEANUP_FILE),
        serde_json::to_string_pretty(&ids)?,
    )
}

fn queue_key_cleanup_logged(config_dir: Option<&Path>, key_id: &str) {
    let Some(config_dir) = config_dir else { return };
    if let Err(e) = queue_key_cleanup(config_dir, key_id) {
        warn!(
            key_id,
            "Could not queue a backup-restore seal key for deletion: {e:#}"
        );
    }
}

/// Failed swap: drop the sealed import of `pending` (nothing was imported)
/// and queue its key for deletion. Must run before the pending directory is
/// removed.
pub(super) fn discard(config_dir: &Path, pending: &Path) {
    let path = pending.join(SEALED_IMPORT_FILE);
    if !path.is_file() {
        return;
    }
    match read_key_id(&path) {
        Ok(id) => queue_key_cleanup_logged(Some(config_dir), &id),
        Err(e) => warn!("Could not read the sealed credential import of a failed restore: {e}"),
    }
    if let Err(e) = std::fs::remove_file(&path) {
        warn!("Could not remove the sealed credential import of a failed restore: {e}");
    }
    info!("Discarded the deferred credential import of the failed backup restore");
}

fn warning(message: &str, details: String) -> RecoveryWarning {
    RecoveryWarning {
        file_name: "backup restore".to_string(),
        message: message.to_string(),
        details: Some(details),
    }
}

/// Successful swap: move the sealed import of `pending` to the config dir,
/// where [`apply_deferred_import`] picks it up. Must run before the pending
/// directory is removed. Returns a warning when the import cannot be kept.
pub(super) fn promote(config_dir: &Path, pending: &Path) -> Option<RecoveryWarning> {
    let sealed = pending.join(SEALED_IMPORT_FILE);
    if !sealed.is_file() {
        return None;
    }
    let target = config_dir.join(DEFERRED_IMPORT_FILE);
    if target.exists() {
        // An older import that could never be applied is superseded.
        warn!("Replacing an older deferred credential import that was never applied");
        if let Ok(id) = read_key_id(&target) {
            queue_key_cleanup_logged(Some(config_dir), &id);
        }
    }
    match std::fs::rename(&sealed, &target) {
        Ok(()) => None,
        Err(e) => {
            error!("Could not keep the deferred credential import: {e}");
            discard(config_dir, pending);
            Some(warning(
                "The backup was restored, but its credentials could not be imported. Your \
                 credentials were left unchanged.",
                format!("Could not move the sealed credential import into place: {e}"),
            ))
        }
    }
}

/// Whether a deferred import or a seal-key cleanup is waiting for the
/// credential store. Reads no keychain.
pub fn has_deferred_work(config_dir: &Path) -> bool {
    config_dir.join(DEFERRED_IMPORT_FILE).exists()
        || config_dir.join(SEAL_KEY_CLEANUP_FILE).exists()
}

/// Apply the deferred credential import of a restore whose swap succeeded,
/// then delete every seal key that is no longer needed. Call once the
/// credential store is available. Idempotent; a step that fails for a
/// transient reason (the keychain is unreachable) is retried at the next
/// start. Returns a warning to surface when something was not imported.
pub fn apply_deferred_import(
    config_dir: &Path,
    store: &dyn CredentialStore,
) -> Option<RecoveryWarning> {
    let path = config_dir.join(DEFERRED_IMPORT_FILE);
    let warning = if path.exists() {
        apply_sealed(config_dir, &path, store)
    } else {
        None
    };
    run_key_cleanup(config_dir, store);
    warning
}

/// Why a deferred import was not applied.
enum ApplyError {
    /// Try again at the next start; the sealed file is kept.
    Retry(String),
    /// The import can never be applied; the sealed file is dropped.
    Lost(String),
}

fn apply_sealed(
    config_dir: &Path,
    path: &Path,
    store: &dyn CredentialStore,
) -> Option<RecoveryWarning> {
    match unseal_and_write(config_dir, path, store) {
        Ok(0) => None,
        Ok(changed) => Some(warning(
            "Some credentials from the restored backup were not imported because they changed \
             after the restore; your current values were kept.",
            format!("{changed} credential(s) changed after the restore and were left as they are"),
        )),
        Err(ApplyError::Retry(reason)) => {
            error!("Could not import the credentials of the restored backup yet: {reason}");
            Some(warning(
                "The credentials from the restored backup could not be imported yet. termiHub \
                 tries again at the next start; your credentials were left unchanged.",
                reason,
            ))
        }
        Err(ApplyError::Lost(reason)) => {
            error!("Dropping the credential import of the restored backup: {reason}");
            if let Err(e) = std::fs::remove_file(path) {
                warn!("Could not remove the sealed credential import: {e}");
            }
            Some(warning(
                "The credentials from the restored backup could not be imported. Your \
                 credentials were left unchanged.",
                reason,
            ))
        }
    }
}

/// Unseal the import and write it. Returns how many entries were left alone
/// because the credential changed after the restore.
fn unseal_and_write(
    config_dir: &Path,
    path: &Path,
    store: &dyn CredentialStore,
) -> Result<usize, ApplyError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| ApplyError::Retry(format!("the sealed import could not be read: {e}")))?;
    let sealed: SealedImport = serde_json::from_str(&text)
        .map_err(|e| ApplyError::Lost(format!("the sealed import is malformed: {e}")))?;
    if sealed.format != SEALED_FORMAT || !valid_key_id(&sealed.key_id) {
        return Err(ApplyError::Lost(
            "the sealed import has an unsupported format".to_string(),
        ));
    }
    let id = sealed.key_id.as_str();
    let slot = store.restore_seal_slot(id).ok_or_else(|| {
        ApplyError::Retry("the credential store cannot hold the import's key".to_string())
    })?;
    let lost = |reason: String| {
        queue_key_cleanup_logged(Some(config_dir), id);
        ApplyError::Lost(reason)
    };
    let encoded_key = slot
        .read()
        .map_err(|e| ApplyError::Retry(format!("the import's key could not be read: {e:#}")))?
        .ok_or_else(|| lost("the key that seals the import is missing".to_string()))?;
    let key = Zeroizing::new(
        BASE64
            .decode(encoded_key.as_bytes())
            .map_err(|_| lost("the import's key is malformed".to_string()))?,
    );
    let nonce = BASE64
        .decode(&sealed.nonce)
        .ok()
        .filter(|n| n.len() == NONCE_LEN)
        .ok_or_else(|| lost("the sealed import is malformed".to_string()))?;
    let ciphertext = BASE64
        .decode(&sealed.data)
        .map_err(|_| lost("the sealed import is malformed".to_string()))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| lost("the import's key is malformed".to_string()))?;
    let aad = aad(id);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| lost("the sealed import could not be unsealed".to_string()))?,
    );
    let payload: DeferredPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| lost(format!("the unsealed import is malformed: {e}")))?;

    let mut batch: Vec<(CredentialKey, String)> = Vec::new();
    let mut changed = 0usize;
    let mut outcome = Ok(());
    for entry in &payload.entries {
        let Some(key) = CredentialKey::from_map_key(&entry.key) else {
            warn!(key = %entry.key, "Skipping an invalid credential key in the deferred import");
            continue;
        };
        let current = match store.get(&key) {
            Ok(current) => current.map(Zeroizing::new),
            Err(e) => {
                outcome = Err(ApplyError::Retry(format!(
                    "the credential store could not be read: {e:#}"
                )));
                break;
            }
        };
        if current.as_deref().map(String::as_str) == Some(entry.value.as_str()) {
            // Already written (an earlier start stopped mid-apply).
            continue;
        }
        let current_sha256 = current.as_ref().map(|v| sha256_hex(v.as_bytes()));
        if current_sha256 != entry.previous_sha256 {
            changed += 1;
            continue;
        }
        batch.push((key, entry.value.clone()));
    }
    if outcome.is_ok() && !batch.is_empty() {
        if let Err(e) = store.set_many(&batch) {
            outcome = Err(ApplyError::Retry(format!(
                "the credentials could not be written: {e:#}"
            )));
        }
    }
    let written = batch.len();
    for (_, value) in batch.iter_mut() {
        value.zeroize();
    }
    outcome?;

    info!(
        written,
        changed, "Imported the deferred credentials of the restored backup"
    );
    // Queue the key before the sealed file goes, so a crash in between never
    // leaves the key behind; the file is applied idempotently until removed.
    queue_key_cleanup_logged(Some(config_dir), id);
    if let Err(e) = std::fs::remove_file(path) {
        warn!("Could not remove the applied sealed credential import: {e}");
    }
    Ok(changed)
}

/// Delete every queued seal key the store can reach; keep the rest queued.
fn run_key_cleanup(config_dir: &Path, store: &dyn CredentialStore) {
    let list = config_dir.join(SEAL_KEY_CLEANUP_FILE);
    if !list.exists() {
        return;
    }
    let remaining: Vec<String> = read_cleanup_list(config_dir)
        .into_iter()
        .filter(|id| match store.restore_seal_slot(id) {
            Some(slot) => match slot.delete() {
                Ok(()) => false,
                Err(e) => {
                    warn!(key_id = %id, "Could not delete a backup-restore seal key: {e:#}");
                    true
                }
            },
            None => true,
        })
        .collect();
    let outcome = if remaining.is_empty() {
        std::fs::remove_file(&list).map_err(anyhow::Error::from)
    } else {
        serde_json::to_string_pretty(&remaining)
            .map_err(anyhow::Error::from)
            .and_then(|text| write_atomic(&list, text))
    };
    if let Err(e) = outcome {
        warn!("Could not update the backup-restore seal-key cleanup list: {e:#}");
    }
}
