//! termiHub-owned index of the credential keys stored in the OS keychain
//! (#3434, #3844).
//!
//! The native OS credential stores cannot be enumerated portably through the
//! `keyring` crate, so [`OsKeychainStore`](super::OsKeychainStore) keeps its own
//! record of which keys it has written. The index lets a vault export and a
//! store switch find **every** stored credential — including ones whose owner
//! id cannot be derived from saved connections (e.g. the file editor's
//! host-label `sudo_password`).
//!
//! # What the index holds
//!
//! Only key **names** — the canonical `"<owner-id>:<type>"` rendering of a
//! [`CredentialKey`]. Never a secret value: the API accepts keys only, so there
//! is no way to put a value into it.
//!
//! # Persistence
//!
//! `keychain-index.json` in the config directory, written atomically on every
//! change. A missing file is an empty index; a corrupt one is logged and
//! treated as empty (startup seeding rebuilds what can be derived).
//!
//! # Drift
//!
//! - An indexed key whose keychain item has gone (deleted outside termiHub) is
//!   pruned when the store lists its keys.
//! - A keychain item that is **not** indexed (written by an older termiHub or
//!   outside the app) cannot be discovered. Seeding from every derivable key
//!   namespace at startup keeps that gap small; it is a documented limitation.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::types::CredentialKey;
use crate::utils::fs::write_atomic;

/// File name of the index, next to the other config files.
pub const FILE_NAME: &str = "keychain-index.json";

/// Current on-disk format version.
const FORMAT_VERSION: u32 = 1;

/// On-disk shape: a version and the sorted key names.
#[derive(Debug, Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    keys: Vec<String>,
}

/// The set of credential key names known to be stored in the OS keychain.
pub struct KeychainKeyIndex {
    /// Where the index is persisted; `None` keeps it in memory only.
    path: Option<PathBuf>,
    keys: Mutex<BTreeSet<String>>,
}

impl KeychainKeyIndex {
    /// An index that is never persisted (unit tests, and stores created
    /// without a config directory).
    pub fn in_memory() -> Self {
        Self {
            path: None,
            keys: Mutex::new(BTreeSet::new()),
        }
    }

    /// Load the index persisted at `path`. A missing file is an empty index;
    /// an unreadable or corrupt one is logged and treated as empty. Entries
    /// that do not parse as a [`CredentialKey`] are dropped.
    pub fn load(path: PathBuf) -> Self {
        let keys = match read_keys(&path) {
            Ok(keys) => keys,
            Err(e) => {
                warn!(
                    path = %path.display(),
                    error = %e,
                    "Could not read the OS keychain key index; starting from an empty index"
                );
                BTreeSet::new()
            }
        };
        Self {
            path: Some(path),
            keys: Mutex::new(keys),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeSet<String>> {
        self.keys.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether `key` is indexed.
    pub fn contains(&self, key: &CredentialKey) -> bool {
        self.lock().contains(&key.to_string())
    }

    /// Every indexed key, sorted by name.
    pub fn keys(&self) -> Vec<CredentialKey> {
        self.lock()
            .iter()
            .filter_map(|k| CredentialKey::from_map_key(k))
            .collect()
    }

    /// Add `keys` to the index and persist it when anything changed.
    ///
    /// The in-memory index keeps the keys even when persisting fails, so the
    /// next successful write records them.
    pub fn insert_many(&self, keys: &[CredentialKey]) -> Result<()> {
        let mut guard = self.lock();
        let mut changed = false;
        for key in keys {
            changed |= guard.insert(key.to_string());
        }
        if changed {
            self.persist(&guard)?;
        }
        Ok(())
    }

    /// Add one key (see [`Self::insert_many`]).
    pub fn insert(&self, key: &CredentialKey) -> Result<()> {
        self.insert_many(std::slice::from_ref(key))
    }

    /// Remove `keys` from the index and persist it when anything changed.
    ///
    /// Callers must only remove a key once its keychain item is gone.
    pub fn remove_many(&self, keys: &[CredentialKey]) -> Result<()> {
        let mut guard = self.lock();
        let mut changed = false;
        for key in keys {
            changed |= guard.remove(&key.to_string());
        }
        if changed {
            self.persist(&guard)?;
        }
        Ok(())
    }

    /// Remove one key (see [`Self::remove_many`]).
    pub fn remove(&self, key: &CredentialKey) -> Result<()> {
        self.remove_many(std::slice::from_ref(key))
    }

    fn persist(&self, keys: &BTreeSet<String>) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let file = IndexFile {
            version: FORMAT_VERSION,
            keys: keys.iter().cloned().collect(),
        };
        let json = serde_json::to_string_pretty(&file)
            .context("Failed to serialize the OS keychain key index")?;
        write_atomic(path, &json).with_context(|| {
            format!(
                "Failed to write the OS keychain key index to {}",
                path.display()
            )
        })
    }
}

/// Read and validate the key names in the index file at `path`.
fn read_keys(path: &Path) -> Result<BTreeSet<String>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(e) => return Err(e).context("Failed to read the index file"),
    };
    let file: IndexFile = serde_json::from_str(&text).context("The index file is not valid")?;
    Ok(file
        .keys
        .into_iter()
        .filter(|k| CredentialKey::from_map_key(k).is_some())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::types::CredentialType;

    fn key(id: &str, t: CredentialType) -> CredentialKey {
        CredentialKey::new(id, t)
    }

    #[test]
    fn missing_file_is_an_empty_index() {
        let dir = tempfile::tempdir().unwrap();
        let index = KeychainKeyIndex::load(dir.path().join(FILE_NAME));
        assert!(index.keys().is_empty());
    }

    #[test]
    fn insert_and_remove_persist_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let index = KeychainKeyIndex::load(path.clone());
        let a = key("conn-a", CredentialType::Password);
        let b = key("host.example", CredentialType::SudoPassword);
        index.insert(&a).unwrap();
        index.insert(&b).unwrap();

        let reloaded = KeychainKeyIndex::load(path.clone());
        assert_eq!(reloaded.keys(), vec![a.clone(), b.clone()]);

        reloaded.remove(&a).unwrap();
        let again = KeychainKeyIndex::load(path);
        assert_eq!(again.keys(), vec![b]);
    }

    #[test]
    fn corrupt_file_is_treated_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "{ not json").unwrap();
        let index = KeychainKeyIndex::load(path);
        assert!(index.keys().is_empty());
    }

    #[test]
    fn unparsable_entries_are_dropped_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(
            &path,
            r#"{"version":1,"keys":["conn-a:password","garbage","conn-b:nope"]}"#,
        )
        .unwrap();
        let index = KeychainKeyIndex::load(path);
        assert_eq!(index.keys(), vec![key("conn-a", CredentialType::Password)]);
    }

    #[test]
    fn owner_ids_with_colons_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let graphical = key("agent-graphical:agent-1:def-9", CredentialType::Password);
        KeychainKeyIndex::load(path.clone())
            .insert(&graphical)
            .unwrap();
        assert_eq!(KeychainKeyIndex::load(path).keys(), vec![graphical]);
    }

    #[test]
    fn file_holds_only_key_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let index = KeychainKeyIndex::load(path.clone());
        index
            .insert(&key("conn-a", CredentialType::Password))
            .unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let obj = value.as_object().unwrap();
        let mut fields: Vec<&str> = obj.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, vec!["keys", "version"]);
        assert_eq!(obj["keys"], serde_json::json!(["conn-a:password"]));
    }

    #[test]
    fn in_memory_index_writes_nothing() {
        let index = KeychainKeyIndex::in_memory();
        index
            .insert(&key("conn-a", CredentialType::Password))
            .unwrap();
        assert_eq!(index.keys().len(), 1);
    }
}
