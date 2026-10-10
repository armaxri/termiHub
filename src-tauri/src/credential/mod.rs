pub mod auto_lock;
pub mod biometric_slot;
pub mod biometric_types;
pub mod biometric_unlock;
pub mod crypto;
pub mod hw_key;
pub mod keychain_index;
mod keyring_thread;
pub mod manager;
pub mod master_password;
pub mod named;
pub mod null;
pub mod os_auth;
pub mod os_keychain;
pub mod types;
pub mod vault;

use anyhow::Result;

pub use auto_lock::{AutoLockTimer, LockedEventPayload};
pub use manager::CredentialManager;
pub use master_password::{MasterPasswordStore, UnlockFailure};
pub use null::NullStore;
pub use os_keychain::OsKeychainStore;
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

    /// Record which of `candidates` (plus any recorded with
    /// [`Self::note_key_candidates`]) exist, for backends that cannot enumerate
    /// their contents and keep their own key index (the OS keychain, #3434).
    ///
    /// **Reads the store**, so it runs only on demand, right before the
    /// user-initiated operations that need every key — vault export and store
    /// switch — never at startup (an OS keychain may prompt for access). Best
    /// effort: failures are logged, never returned. The default is a no-op for
    /// backends that can list their keys themselves.
    fn seed_key_index(&self, _candidates: &[CredentialKey]) {}

    /// Remember `keys` as derived candidates for the next
    /// [`Self::seed_key_index`], **without** reading the store (e.g. agent
    /// graphical secrets, derivable only from an agent's listing). The default
    /// is a no-op.
    fn note_key_candidates(&self, _keys: &[CredentialKey]) {}

    /// Return the current status of the credential store.
    fn status(&self) -> CredentialStoreStatus;

    /// The single on-disk file that holds every credential, for backends that
    /// keep one (the master-password vault). A backup restore copies it before
    /// importing, so a restore that is rolled back at the next start can put
    /// the credentials back too (#4295). The default is `None`: the backend
    /// has no such file and its imported credentials cannot be reverted then.
    fn vault_file(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// A slot in the OS credential store, named by `id`, for the key that
    /// seals a backup restore's deferred credential import (#4414).
    ///
    /// A backend with no [`Self::vault_file`] cannot revert an import, so a
    /// restore that is applied at the next start seals its credentials with a
    /// random key kept in this slot and imports them only after the stores
    /// were swapped in successfully. The slot is not a credential: it is never
    /// listed, exported or migrated. The default is `None`: the backend keeps
    /// no such slot, and a restore imports its credentials right away.
    fn restore_seal_slot(&self, _id: &str) -> Option<Box<dyn biometric_slot::SecretSlot>> {
        None
    }

    /// Store several credentials as one all-or-nothing operation.
    ///
    /// Either every entry is written, or — when any write fails — the entries
    /// already written are rolled back to their previous values (restored, or
    /// removed when they did not exist before) and the error is returned. Used
    /// by the credential-vault import (PROD-063) so a failed import never leaves
    /// a half-imported store.
    ///
    /// The default implementation snapshots the previous values and applies the
    /// entries one by one with best-effort rollback; backends that can commit a
    /// batch atomically (the master-password store writes a single file)
    /// override it. Snapshotted secrets are zeroized before returning.
    fn set_many(&self, entries: &[(CredentialKey, String)]) -> Result<()> {
        let mut previous: Vec<(CredentialKey, Option<String>)> = Vec::with_capacity(entries.len());
        for (key, _) in entries {
            let old = self.get(key)?;
            previous.push((key.clone(), old));
        }

        let mut outcome = Ok(());
        for (index, (key, value)) in entries.iter().enumerate() {
            if let Err(e) = self.set(key, value) {
                // Roll back everything attempted so far (including the failed
                // entry, whose write may have partially landed), newest first.
                for (prev_key, old) in previous[..=index].iter().rev() {
                    let restored = match old {
                        Some(old_value) => self.set(prev_key, old_value),
                        None => self.remove(prev_key),
                    };
                    if let Err(rollback_err) = restored {
                        tracing::warn!(
                            key = %prev_key,
                            error = %rollback_err,
                            "failed to roll back credential after a failed batch write"
                        );
                    }
                }
                outcome = Err(e.context("Batch credential write failed and was rolled back"));
                break;
            }
        }

        for (_, old) in previous.iter_mut() {
            if let Some(ref mut old_value) = old {
                zeroize::Zeroize::zeroize(old_value);
            }
        }
        outcome
    }
}
