use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use keyring::{Entry, Error as KeyringError};
use tracing::{debug, info, warn};
use zeroize::Zeroize;

use super::keychain_index::KeychainKeyIndex;
use super::types::{CredentialKey, CredentialStoreStatus, CredentialType};
use super::CredentialStore;

/// Service name under which all termiHub credentials are stored in the native
/// OS credential store. Combined with the per-credential account name it forms
/// a unique keychain entry.
const SERVICE_NAME: &str = "termiHub";

/// Credential store backed by the native OS credential store via the
/// [`keyring`](https://crates.io/crates/keyring) crate.
///
/// Maps to the macOS Keychain, the Windows Credential Manager, and the Linux
/// Secret Service depending on the platform. Each credential is stored as a
/// keychain entry keyed by a fixed service name ([`SERVICE_NAME`]) and an
/// account name derived from the [`CredentialKey`] (`"<connection-id>:<type>"`).
///
/// Unlike [`MasterPasswordStore`](super::MasterPasswordStore), there is no
/// in-app lock state: the OS store manages access (and may prompt the user),
/// so this store always reports [`CredentialStoreStatus::Unlocked`].
///
/// Resolved [`keyring::Entry`] handles are cached per account name. A single
/// `Entry` is reused across `get`/`set`/`remove` for the same credential, which
/// is required for the `keyring` `mock` backend (it keeps state per `Entry`
/// rather than globally by service/account) and is harmless for the real
/// platform backends, where an `Entry` is just a lightweight handle.
///
/// The native stores cannot be enumerated, so the store keeps a
/// [`KeychainKeyIndex`] of the key **names** it has written (never values):
/// a key is added once its keychain write succeeded and removed only once its
/// keychain delete succeeded. [`list_keys`](CredentialStore::list_keys) reads
/// the index without reading the keychain (a read that finds an item gone
/// prunes it), and an on-demand seed before an export or store switch
/// records older items; that is what lets a vault
/// export and a store switch find every stored credential (#3434, #3844).
pub struct OsKeychainStore {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    index: KeychainKeyIndex,
}

impl Default for OsKeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl OsKeychainStore {
    /// Create a new OS keychain store whose key index lives in memory only.
    pub fn new() -> Self {
        Self::with_index(KeychainKeyIndex::in_memory())
    }

    /// Create a new OS keychain store whose key index is persisted at
    /// `index_path` (see [`KeychainKeyIndex`]).
    pub fn with_index_file(index_path: PathBuf) -> Self {
        Self::with_index(KeychainKeyIndex::load(index_path))
    }

    fn with_index(index: KeychainKeyIndex) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            index,
        }
    }

    /// Drop every key from the index without touching the keychain, to
    /// simulate items written before the index existed.
    #[cfg(test)]
    pub(crate) fn forget_index_for_test(&self) {
        self.index.remove_many(&self.index.keys()).unwrap();
    }

    /// Whether the keychain holds an item for `key`: `Ok(true)`/`Ok(false)`,
    /// or the read error. The value read is zeroized immediately.
    fn exists(&self, key: &CredentialKey) -> Result<bool> {
        match self.get(key)? {
            Some(mut value) => {
                value.zeroize();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Return a cached [`keyring::Entry`] for the given credential key,
    /// creating and caching it on first use.
    ///
    /// The account name is the canonical `"<connection-id>:<type>"` rendering of
    /// the key, so it round-trips through [`CredentialKey::from_map_key`].
    fn entry(&self, key: &CredentialKey) -> Result<Arc<Entry>> {
        let account = key.to_string();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(&account) {
            return Ok(entry.clone());
        }
        let entry = Arc::new(
            Entry::new(SERVICE_NAME, &account)
                .with_context(|| format!("Failed to open OS keychain entry for {key}"))?,
        );
        entries.insert(account, entry.clone());
        Ok(entry)
    }
}

impl CredentialStore for OsKeychainStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        let entry = self.entry(key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => {
                // Drift: the item was deleted outside termiHub. Prune it, so
                // the index converges without any extra keychain read.
                if self.index.contains(key) {
                    info!(key = %key, "Pruned an OS keychain index entry whose item is gone");
                    if let Err(e) = self.index.remove(key) {
                        warn!(key = %key, error = %e, "Failed to persist the pruned OS keychain key index");
                    }
                }
                Ok(None)
            }
            Err(e) => Err(e).with_context(|| format!("Failed to read OS keychain entry for {key}")),
        }
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        let entry = self.entry(key)?;
        entry
            .set_password(value)
            .with_context(|| format!("Failed to write OS keychain entry for {key}"))?;
        // The secret is stored; failing to record its name must not fail the
        // write. The in-memory index keeps it for the next successful persist.
        if let Err(e) = self.index.insert(key) {
            warn!(key = %key, error = %e, "Failed to record an OS keychain key in the index");
        }
        Ok(())
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        let entry = self.entry(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(e) => {
                // The item may still be there: keep it indexed.
                return Err(e)
                    .with_context(|| format!("Failed to delete OS keychain entry for {key}"));
            }
        }
        if let Err(e) = self.index.remove(key) {
            warn!(key = %key, error = %e, "Failed to drop a deleted OS keychain key from the index");
        }
        Ok(())
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        // OS credential stores cannot be enumerated portably through `keyring`,
        // so we delete every known credential type for the connection instead.
        // The list is `CredentialType::ALL` so it cannot drift out of date when
        // a new variant is added and leave a secret orphaned here (#2305).
        for credential_type in CredentialType::ALL {
            let key = CredentialKey::new(connection_id, credential_type);
            self.remove(&key)?;
        }
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        // The native OS credential stores cannot be enumerated through the
        // `keyring` crate, so the keys come from termiHub's own index — without
        // reading the keychain. A listed key whose item has gone reads back as
        // `None` (and is pruned by that read). Items never recorded in the
        // index (written by an older version or outside termiHub) are found
        // only through `seed_key_index`, which export and store switch call.
        Ok(self.index.keys())
    }

    fn note_key_candidates(&self, keys: &[CredentialKey]) {
        if let Err(e) = self.index.add_candidates(keys) {
            warn!(error = %e, "Failed to record OS keychain key candidates in the index");
        }
    }

    fn seed_key_index(&self, candidates: &[CredentialKey]) {
        // Probe the given keys plus every recorded candidate that is not yet
        // indexed. This reads the keychain, so it only runs on demand, right
        // before a user-initiated export or store switch — never at startup —
        // so any OS access prompt appears in that context.
        let mut to_probe: Vec<CredentialKey> = Vec::new();
        for key in candidates.iter().cloned().chain(self.index.candidates()) {
            if !self.index.contains(&key) && !to_probe.contains(&key) {
                to_probe.push(key);
            }
        }
        let mut found = Vec::new();
        let mut absent = Vec::new();
        for key in to_probe {
            match self.exists(&key) {
                Ok(true) => found.push(key),
                Ok(false) => absent.push(key),
                Err(e) => {
                    // Unresolved: a recorded candidate stays for the next seed.
                    debug!(key = %key, error = %e, "Could not probe an OS keychain key for the index")
                }
            }
        }
        if !found.is_empty() {
            info!(
                seeded = found.len(),
                "Recorded existing OS keychain credentials in the key index"
            );
            if let Err(e) = self.index.insert_many(&found) {
                warn!(error = %e, "Failed to persist the seeded OS keychain key index");
            }
        }
        if let Err(e) = self.index.remove_candidates(&absent) {
            warn!(error = %e, "Failed to persist the resolved OS keychain key candidates");
        }
    }

    fn status(&self) -> CredentialStoreStatus {
        // The OS store manages access itself; there is no in-app lock state.
        CredentialStoreStatus::Unlocked
    }
}

/// Test-only support for exercising the OS keychain store against the
/// process-global `keyring` mock backend.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard};

    /// The `keyring` mock backend is process-global, so tests that install it
    /// must not run concurrently. This mutex serializes them across modules.
    static MOCK_LOCK: Mutex<()> = Mutex::new(());

    /// Install the process-global `keyring` mock backend for the duration of a
    /// test. The returned guard must be held for the whole test body so the
    /// mock is not swapped out from under a concurrently running test.
    pub(crate) fn install_mock() -> MutexGuard<'static, ()> {
        let guard = MOCK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        guard
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::install_mock as with_mock;
    use super::*;

    #[test]
    fn set_then_get_returns_value() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-set-get", CredentialType::Password);

        store.set(&key, "secret123").unwrap();
        assert_eq!(store.get(&key).unwrap(), Some("secret123".to_string()));
    }

    #[test]
    fn get_nonexistent_returns_none() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-missing", CredentialType::Password);

        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn set_overwrites_existing_value() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-overwrite", CredentialType::KeyPassphrase);

        store.set(&key, "first").unwrap();
        store.set(&key, "second").unwrap();
        assert_eq!(store.get(&key).unwrap(), Some("second".to_string()));
    }

    #[test]
    fn remove_then_get_returns_none() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-remove", CredentialType::Password);

        store.set(&key, "secret").unwrap();
        store.remove(&key).unwrap();
        assert_eq!(store.get(&key).unwrap(), None);
    }

    #[test]
    fn remove_nonexistent_is_ok() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let key = CredentialKey::new("conn-never", CredentialType::Password);

        assert!(store.remove(&key).is_ok());
    }

    #[test]
    fn remove_all_for_connection_removes_both_types() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let pw = CredentialKey::new("conn-all", CredentialType::Password);
        let kp = CredentialKey::new("conn-all", CredentialType::KeyPassphrase);

        store.set(&pw, "pass").unwrap();
        store.set(&kp, "phrase").unwrap();

        store.remove_all_for_connection("conn-all").unwrap();

        assert_eq!(store.get(&pw).unwrap(), None);
        assert_eq!(store.get(&kp).unwrap(), None);
    }

    #[test]
    fn remove_all_for_connection_removes_sudo_password() {
        // Regression (#2305): deleting a connection must also delete its stored
        // sudo password. The OS store cannot be enumerated, so it deletes a
        // fixed list of credential types — that list previously omitted
        // SudoPassword, leaving the secret orphaned in the OS keychain forever.
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let pw = CredentialKey::new("conn-sudo", CredentialType::Password);
        let kp = CredentialKey::new("conn-sudo", CredentialType::KeyPassphrase);
        let sudo = CredentialKey::new("conn-sudo", CredentialType::SudoPassword);

        store.set(&pw, "pass").unwrap();
        store.set(&kp, "phrase").unwrap();
        store.set(&sudo, "elevated-secret").unwrap();

        store.remove_all_for_connection("conn-sudo").unwrap();

        assert_eq!(store.get(&pw).unwrap(), None);
        assert_eq!(store.get(&kp).unwrap(), None);
        assert_eq!(store.get(&sudo).unwrap(), None);
    }

    #[test]
    fn status_is_always_unlocked() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        assert_eq!(store.status(), CredentialStoreStatus::Unlocked);
    }

    /// A store whose index is persisted in `dir`.
    fn indexed_store(dir: &std::path::Path) -> OsKeychainStore {
        OsKeychainStore::with_index_file(dir.join(super::super::keychain_index::FILE_NAME))
    }

    fn index_file_text(dir: &std::path::Path) -> String {
        std::fs::read_to_string(dir.join(super::super::keychain_index::FILE_NAME))
            .unwrap_or_default()
    }

    #[test]
    fn list_keys_returns_every_stored_key_including_non_connection_ones() {
        // #3434: the file editor stores `sudo_password` under a host label that
        // is no saved connection id; listing must still find it.
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let conn = CredentialKey::new("conn-list", CredentialType::Password);
        let host = CredentialKey::new("db.example.com", CredentialType::SudoPassword);
        store.set(&conn, "secret").unwrap();
        store.set(&host, "sudo-secret").unwrap();

        let mut keys = store.list_keys().unwrap();
        keys.sort_by_key(|k| k.to_string());
        assert_eq!(keys, vec![conn, host]);
    }

    #[test]
    fn remove_drops_the_key_from_the_index() {
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let key = CredentialKey::new("conn-rm-index", CredentialType::Password);
        store.set(&key, "secret").unwrap();
        store.remove(&key).unwrap();

        assert!(store.list_keys().unwrap().is_empty());
        assert!(!index_file_text(dir.path()).contains("conn-rm-index"));
    }

    #[test]
    fn remove_all_for_connection_drops_every_type_from_the_index() {
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        for t in CredentialType::ALL {
            store
                .set(&CredentialKey::new("conn-rm-all", t), "v")
                .unwrap();
        }
        store.remove_all_for_connection("conn-rm-all").unwrap();
        assert!(store.list_keys().unwrap().is_empty());
    }

    #[test]
    fn failed_keychain_delete_keeps_the_key_indexed() {
        // A key leaves the index only after its keychain item is really gone.
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let key = CredentialKey::new("conn-delete-fails", CredentialType::Password);
        store.set(&key, "secret").unwrap();

        let entry = store.entry(&key).unwrap();
        let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
        mock.set_error(KeyringError::PlatformFailure("denied".into()));
        assert!(store.remove(&key).is_err());

        assert!(store.index.contains(&key));
        assert!(index_file_text(dir.path()).contains("conn-delete-fails:password"));
    }

    #[test]
    fn index_persists_across_store_instances() {
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let key = CredentialKey::new("conn-persist", CredentialType::KeyPassphrase);
        indexed_store(dir.path()).set(&key, "phrase").unwrap();

        let reopened = indexed_store(dir.path());
        assert_eq!(reopened.index.keys(), vec![key]);
    }

    #[test]
    fn a_read_prunes_indexed_keys_whose_item_is_gone() {
        // Drift: an item deleted outside termiHub is dropped from the index by
        // the read that finds it missing — no extra keychain read.
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(super::super::keychain_index::FILE_NAME),
            r#"{"version":1,"keys":["conn-gone:password"]}"#,
        )
        .unwrap();
        let store = indexed_store(dir.path());
        let gone = CredentialKey::new("conn-gone", CredentialType::Password);
        let live = CredentialKey::new("conn-live", CredentialType::Password);
        store.set(&live, "secret").unwrap();
        assert_eq!(store.list_keys().unwrap(), vec![gone.clone(), live.clone()]);

        assert_eq!(store.get(&gone).unwrap(), None);

        assert_eq!(store.list_keys().unwrap(), vec![live]);
        let text = index_file_text(dir.path());
        assert!(!text.contains("conn-gone"));
        assert!(text.contains("conn-live:password"));
    }

    /// Arm the mock entry of `key` to fail its next keychain operation, so a
    /// test can tell whether anything touched the keychain.
    fn arm_failure(store: &OsKeychainStore, key: &CredentialKey) {
        let entry = store.entry(key).unwrap();
        let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
        mock.set_error(KeyringError::PlatformFailure("touched".into()));
    }

    #[test]
    fn listing_and_noting_candidates_never_read_the_keychain() {
        // Nothing but export / store switch may read the keychain (a read can
        // raise an OS access prompt on an updated unsigned build).
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let indexed = CredentialKey::new("conn-idx", CredentialType::Password);
        let graphical = CredentialKey::new("agent-graphical:a1:vnc-1", CredentialType::Password);
        store.set(&indexed, "secret").unwrap();
        arm_failure(&store, &indexed);
        arm_failure(&store, &graphical);

        store.list_keys().unwrap();
        store.note_key_candidates(std::slice::from_ref(&graphical));

        // The armed failures are still pending: neither call read an item.
        assert!(store.get(&indexed).is_err());
        assert!(store.get(&graphical).is_err());
        assert!(index_file_text(dir.path()).contains("agent-graphical:a1:vnc-1:password"));
    }

    #[test]
    fn opening_the_store_reads_nothing() {
        // Startup opens the store (loading the index) but never probes it.
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(super::super::keychain_index::FILE_NAME),
            r#"{"version":1,"keys":["conn-a:password"],"candidates":["agent-graphical:a:d:password"]}"#,
        )
        .unwrap();
        let store = indexed_store(dir.path());
        let candidate = CredentialKey::new("agent-graphical:a:d", CredentialType::Password);
        assert_eq!(store.index.candidates(), vec![candidate]);
        assert_eq!(
            store.list_keys().unwrap(),
            vec![CredentialKey::new("conn-a", CredentialType::Password)]
        );
    }

    #[test]
    fn seed_resolves_recorded_candidates() {
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let present = CredentialKey::new("agent-graphical:a1:vnc-1", CredentialType::Password);
        let absent = CredentialKey::new("agent-graphical:a1:rdp-2", CredentialType::Password);
        store.set(&present, "vnc-secret").unwrap();
        store.forget_index_for_test();
        store.note_key_candidates(&[present.clone(), absent]);
        assert!(store.list_keys().unwrap().is_empty());

        store.seed_key_index(&[]);

        assert_eq!(store.list_keys().unwrap(), vec![present]);
        assert!(store.index.candidates().is_empty());
    }

    #[test]
    fn seed_indexes_candidates_present_in_the_keychain_only() {
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let present = CredentialKey::new("conn-seed", CredentialType::Password);
        let absent = CredentialKey::new("conn-seed", CredentialType::KeyPassphrase);
        store.set(&present, "secret").unwrap();
        // Simulate an item written before the index existed.
        store.index.remove(&present).unwrap();
        assert!(store.list_keys().unwrap().is_empty());

        store.seed_key_index(&[present.clone(), absent]);

        assert_eq!(store.list_keys().unwrap(), vec![present]);
    }

    #[test]
    fn index_file_never_contains_secret_values() {
        let _guard = with_mock();
        let dir = tempfile::tempdir().unwrap();
        let store = indexed_store(dir.path());
        let secrets = [
            ("conn-v", CredentialType::Password, "pw-SECRET-1"),
            ("conn-v", CredentialType::KeyPassphrase, "kp-SECRET-2"),
            (
                "host.example",
                CredentialType::SudoPassword,
                "sudo-SECRET-3",
            ),
            (
                "agent-graphical:a1:d1",
                CredentialType::Password,
                "vnc-SECRET-4",
            ),
        ];
        for (id, t, v) in &secrets {
            store.set(&CredentialKey::new(id, t.clone()), v).unwrap();
        }
        store.note_key_candidates(&[CredentialKey::new(
            "agent-graphical:a1:d2",
            CredentialType::Password,
        )]);
        store.seed_key_index(&[CredentialKey::new("conn-v", CredentialType::Password)]);
        store.list_keys().unwrap();

        let text = index_file_text(dir.path());
        assert!(!text.is_empty());
        for (_, _, v) in &secrets {
            assert!(!text.contains(v), "index file leaked a secret value");
        }
        assert!(!text.contains("SECRET"));
    }

    #[test]
    fn distinct_keys_do_not_collide() {
        let _guard = with_mock();
        let store = OsKeychainStore::new();
        let a = CredentialKey::new("conn-a", CredentialType::Password);
        let b = CredentialKey::new("conn-b", CredentialType::Password);
        let c = CredentialKey::new("conn-a", CredentialType::KeyPassphrase);

        store.set(&a, "value-a").unwrap();
        store.set(&b, "value-b").unwrap();
        store.set(&c, "value-c").unwrap();

        assert_eq!(store.get(&a).unwrap(), Some("value-a".to_string()));
        assert_eq!(store.get(&b).unwrap(), Some("value-b".to_string()));
        assert_eq!(store.get(&c).unwrap(), Some("value-c".to_string()));
    }
}
