//! A recording in-memory [`CredentialStore`] for tests.

use std::collections::BTreeMap;
use std::sync::Mutex;

use anyhow::Result;

use crate::credential::{CredentialKey, CredentialStore, CredentialStoreStatus, CredentialType};

/// An in-memory store that records every call and can be made to fail.
#[derive(Default)]
pub(crate) struct RecordingStore {
    pub(crate) values: Mutex<BTreeMap<String, String>>,
    pub(crate) calls: Mutex<Vec<String>>,
    pub(crate) fail_gets: bool,
    pub(crate) fail_sets: bool,
}

impl RecordingStore {
    pub(crate) fn with(entries: &[(&str, CredentialType, &str)]) -> Self {
        let store = Self::default();
        for (id, t, v) in entries {
            store
                .values
                .lock()
                .unwrap()
                .insert(CredentialKey::new(id, t.clone()).to_string(), v.to_string());
        }
        store
    }

    pub(crate) fn value(&self, id: &str, t: CredentialType) -> Option<String> {
        self.values
            .lock()
            .unwrap()
            .get(&CredentialKey::new(id, t).to_string())
            .cloned()
    }

    pub(crate) fn snapshot(&self) -> BTreeMap<String, String> {
        self.values.lock().unwrap().clone()
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn log(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

impl CredentialStore for RecordingStore {
    fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
        self.log(format!("get {key}"));
        if self.fail_gets {
            anyhow::bail!("store is locked");
        }
        Ok(self.values.lock().unwrap().get(&key.to_string()).cloned())
    }

    fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
        self.log(format!("set {key}"));
        if self.fail_sets {
            anyhow::bail!("write failed");
        }
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn remove(&self, key: &CredentialKey) -> Result<()> {
        self.log(format!("remove {key}"));
        self.values.lock().unwrap().remove(&key.to_string());
        Ok(())
    }

    fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
        self.log(format!("remove_all {connection_id}"));
        let prefix = format!("{connection_id}:");
        self.values
            .lock()
            .unwrap()
            .retain(|k, _| !k.starts_with(&prefix));
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .keys()
            .filter_map(|k| CredentialKey::from_map_key(k))
            .collect())
    }

    fn status(&self) -> CredentialStoreStatus {
        CredentialStoreStatus::Unlocked
    }
}
