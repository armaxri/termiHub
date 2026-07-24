use std::sync::Mutex;

use anyhow::{Context, Result};
use serde_json::Value;
use tauri::AppHandle;

use super::config::{compute_dedup_key, SessionHistoryEntry, SessionHistoryStore};
use super::storage::SessionHistoryStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// Central session-history manager: records sessions (with deduplication and
/// LRU eviction) and persists them through storage.
pub struct SessionHistoryManager {
    store: Mutex<SessionHistoryStore>,
    storage: SessionHistoryStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl SessionHistoryManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = SessionHistoryStorage::new(app_handle)
            .context("Failed to initialize session-history storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load session history")?;

        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// List all history entries, ordered for display: pinned first, then most
    /// recently used first.
    pub fn list(&self) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
        let store = self.lock()?;
        Ok(sorted_for_display(&store))
    }

    /// Record a session open. Deduplicates by the computed key: an existing
    /// entry's `last_used`/`use_count` (and title/config) are updated, otherwise
    /// a new entry is created. After recording, the history is trimmed to
    /// `limit` by evicting the least-recently-used **unpinned** entries.
    ///
    /// Returns the full, display-ordered list.
    pub fn record(
        &self,
        connection_type: &str,
        config: Value,
        title: String,
        limit: u32,
    ) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
        let now = now_millis();
        let key = compute_dedup_key(connection_type, &config);

        let mut store = self.lock()?;

        if let Some(existing) = store.entries.iter_mut().find(|e| e.dedup_key == key) {
            existing.last_used = now;
            existing.use_count = existing.use_count.saturating_add(1);
            existing.title = title;
            existing.config = config;
            existing.connection_type = connection_type.to_string();
        } else {
            store.entries.push(SessionHistoryEntry {
                dedup_key: key,
                title,
                connection_type: connection_type.to_string(),
                config,
                first_used: now,
                last_used: now,
                use_count: 1,
                pinned: false,
                promoted: false,
            });
        }

        evict_to_limit(&mut store, limit);
        self.persist(&store)?;
        Ok(sorted_for_display(&store))
    }

    /// Pin or unpin an entry (pinned entries are exempt from eviction).
    pub fn set_pinned(
        &self,
        dedup_key: &str,
        pinned: bool,
    ) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
        let mut store = self.lock()?;
        let entry = store
            .entries
            .iter_mut()
            .find(|e| e.dedup_key == dedup_key)
            .ok_or_else(|| {
                TerminalError::SessionHistoryError(format!("History entry not found: {dedup_key}"))
            })?;
        entry.pinned = pinned;
        self.persist(&store)?;
        Ok(sorted_for_display(&store))
    }

    /// Mark an entry as promoted to a saved connection (retained in history).
    pub fn set_promoted(
        &self,
        dedup_key: &str,
    ) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
        let mut store = self.lock()?;
        let entry = store
            .entries
            .iter_mut()
            .find(|e| e.dedup_key == dedup_key)
            .ok_or_else(|| {
                TerminalError::SessionHistoryError(format!("History entry not found: {dedup_key}"))
            })?;
        entry.promoted = true;
        self.persist(&store)?;
        Ok(sorted_for_display(&store))
    }

    /// Remove a single entry from history.
    pub fn remove(&self, dedup_key: &str) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
        let mut store = self.lock()?;
        let before = store.entries.len();
        store.entries.retain(|e| e.dedup_key != dedup_key);
        if store.entries.len() == before {
            return Err(TerminalError::SessionHistoryError(format!(
                "History entry not found: {dedup_key}"
            )));
        }
        self.persist(&store)?;
        Ok(sorted_for_display(&store))
    }

    /// Clear all history entries.
    pub fn clear(&self) -> Result<Vec<SessionHistoryEntry>, TerminalError> {
        let mut store = self.lock()?;
        store.entries.clear();
        self.persist(&store)?;
        Ok(Vec::new())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, SessionHistoryStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::SessionHistoryError(e.to_string()))
    }

    fn persist(&self, store: &SessionHistoryStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::SessionHistoryError(e.to_string()))
    }
}

/// Current time as Unix milliseconds.
fn now_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Return a display-ordered copy of the entries: pinned first, then by
/// `last_used` descending (most recent first).
fn sorted_for_display(store: &SessionHistoryStore) -> Vec<SessionHistoryEntry> {
    let mut entries = store.entries.clone();
    entries.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.last_used.cmp(&a.last_used))
    });
    entries
}

/// Evict least-recently-used **unpinned** entries until the store holds at most
/// `limit` entries. Pinned entries are never evicted (so the stored count can
/// exceed `limit` if there are more pins than the limit). A `limit` of 0 is
/// treated as "unbounded".
fn evict_to_limit(store: &mut SessionHistoryStore, limit: u32) {
    if limit == 0 {
        return;
    }
    let limit = limit as usize;
    while store.entries.len() > limit {
        // Find the unpinned entry with the smallest `last_used`.
        let victim = store
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| !e.pinned)
            .min_by_key(|(_, e)| e.last_used)
            .map(|(i, _)| i);
        match victim {
            Some(i) => {
                store.entries.remove(i);
            }
            // Only pinned entries remain — nothing evictable.
            None => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn manager(dir: &TempDir) -> SessionHistoryManager {
        SessionHistoryManager {
            store: Mutex::new(SessionHistoryStore::default()),
            storage: SessionHistoryStorage::new_test(dir.path()),
            recovery_warnings: Mutex::new(Vec::new()),
        }
    }

    fn ssh(host: &str, user: &str) -> Value {
        json!({ "type": "ssh", "config": { "host": host, "username": user, "port": 22 } })
    }

    #[test]
    fn record_creates_new_entry() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        let list = mgr
            .record("ssh", ssh("prod", "admin"), "admin@prod".to_string(), 50)
            .unwrap();

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].dedup_key, "ssh:admin@prod:22");
        assert_eq!(list[0].use_count, 1);
        assert_eq!(list[0].first_used, list[0].last_used);
    }

    #[test]
    fn record_dedups_and_increments_use_count() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        mgr.record("ssh", ssh("prod", "admin"), "admin@prod".to_string(), 50)
            .unwrap();
        let list = mgr
            .record("ssh", ssh("prod", "admin"), "admin@prod".to_string(), 50)
            .unwrap();

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].use_count, 2);
    }

    #[test]
    fn list_orders_pinned_first_then_recent() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        mgr.record("ssh", ssh("a", "u"), "u@a".to_string(), 50)
            .unwrap();
        mgr.record("ssh", ssh("b", "u"), "u@b".to_string(), 50)
            .unwrap();
        // Pin the older ("a") entry — it should float to the top.
        mgr.set_pinned("ssh:u@a:22", true).unwrap();

        let list = mgr.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].dedup_key, "ssh:u@a:22");
        assert!(list[0].pinned);
        assert_eq!(list[1].dedup_key, "ssh:u@b:22");
    }

    #[test]
    fn eviction_removes_oldest_unpinned_beyond_limit() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        for i in 0..3 {
            mgr.record(
                "ssh",
                ssh(&format!("h{i}"), "u"),
                format!("u@h{i}"),
                2,
            )
            .unwrap();
        }

        let list = mgr.list().unwrap();
        // Limit 2 → the oldest ("h0") is evicted.
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|e| e.dedup_key != "ssh:u@h0:22"));
    }

    #[test]
    fn pinned_entries_survive_eviction() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        mgr.record("ssh", ssh("keep", "u"), "u@keep".to_string(), 1)
            .unwrap();
        mgr.set_pinned("ssh:u@keep:22", true).unwrap();
        mgr.record("ssh", ssh("new", "u"), "u@new".to_string(), 1)
            .unwrap();

        let list = mgr.list().unwrap();
        // Both survive: the pinned one is exempt even though limit is 1.
        assert!(list.iter().any(|e| e.dedup_key == "ssh:u@keep:22"));
    }

    #[test]
    fn remove_and_clear() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        mgr.record("ssh", ssh("a", "u"), "u@a".to_string(), 50)
            .unwrap();
        mgr.record("ssh", ssh("b", "u"), "u@b".to_string(), 50)
            .unwrap();

        let list = mgr.remove("ssh:u@a:22").unwrap();
        assert_eq!(list.len(), 1);
        assert!(mgr.remove("nope").is_err());

        let cleared = mgr.clear().unwrap();
        assert!(cleared.is_empty());
    }

    #[test]
    fn set_promoted_marks_entry() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);

        mgr.record("ssh", ssh("a", "u"), "u@a".to_string(), 50)
            .unwrap();
        let list = mgr.set_promoted("ssh:u@a:22").unwrap();
        assert!(list[0].promoted);
    }

    #[test]
    fn history_persists_across_reload() {
        let dir = TempDir::new().unwrap();
        {
            let mgr = manager(&dir);
            mgr.record("ssh", ssh("a", "u"), "u@a".to_string(), 50)
                .unwrap();
        }
        let storage = SessionHistoryStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        assert_eq!(loaded.data.entries.len(), 1);
        assert_eq!(loaded.data.entries[0].dedup_key, "ssh:u@a:22");
    }
}
