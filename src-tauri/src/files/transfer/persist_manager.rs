//! The persisted transfer-queue manager (PROD-0011).
//!
//! Owns the in-memory [`PersistedTransferStore`] and a **single background
//! writer** so persistence is fire-and-forget: no queue mutation ever blocks a
//! transfer on disk I/O. Writes are coalesced (only the latest snapshot is
//! flushed), and the store is written **only on a status change or a coarse byte
//! checkpoint** — never per-chunk — so a hot progress stream costs nothing.
//!
//! Mirrors [`crate::workflows::history_manager::WorkflowRunHistoryManager`] in
//! construction and recovery-warning handling.

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::persist::{PersistedTransfer, PersistedTransferStatus, PersistedTransferStore};
use super::persist_storage::TransferPersistenceStorage;
use super::TransferDirection;
use crate::connection::recovery::RecoveryWarning;

/// Minimum byte advance between two disk checkpoints of an in-flight transfer.
/// Progress arrives ~10 Hz; persisting only every this-many bytes keeps the queue
/// durable without turning a large transfer into a write storm. A resume
/// byte-verifies the destination anyway (PROD-0012), so a coarse checkpoint is
/// safe.
const CHECKPOINT_BYTES: u64 = 8 * 1024 * 1024;

/// Current wall-clock milliseconds.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Persists the transfer queue to `transfers.json` and rehydrates it on startup
/// (PROD-0011). Managed as Tauri state; every mutation is non-blocking.
pub struct TransferPersistenceManager {
    store: Mutex<PersistedTransferStore>,
    /// Sends the latest store snapshot to the background writer. A send is
    /// non-blocking; the writer coalesces bursts into a single atomic write.
    writer: Sender<PersistedTransferStore>,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl TransferPersistenceManager {
    /// Initialize from disk, with recovery on corruption, and start the
    /// background writer.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = TransferPersistenceStorage::new(app_handle)
            .context("Failed to initialize transfer-queue persistence storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load persisted transfer queue")?;
        Ok(Self::from_parts(storage, result.data, result.warnings))
    }

    /// Wire up the store, warnings, and the coalescing single-writer thread.
    fn from_parts(
        storage: TransferPersistenceStorage,
        data: PersistedTransferStore,
        warnings: Vec<RecoveryWarning>,
    ) -> Self {
        let (writer, rx) = mpsc::channel::<PersistedTransferStore>();
        // Single background writer: fire-and-forget, coalescing. It drains every
        // queued snapshot and writes only the most recent, so a burst of
        // checkpoints costs one atomic write. Exits when the manager (and thus
        // the sender) is dropped.
        let spawned = std::thread::Builder::new()
            .name("transfer-persist".to_string())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut latest = first;
                    while let Ok(next) = rx.try_recv() {
                        latest = next;
                    }
                    if let Err(e) = storage.save(&latest) {
                        tracing::warn!(error = %e, "failed to persist transfer queue (PROD-0011)");
                    }
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "could not start transfer-persist writer; queue persistence disabled");
        }

        Self {
            store: Mutex::new(data),
            writer,
            recovery_warnings: Mutex::new(warnings),
        }
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// Record a freshly-registered transfer (status `Queued`, zero progress).
    /// Called at enqueue time, when the full source/destination paths are known.
    #[allow(clippy::too_many_arguments)]
    pub fn record_registration(
        &self,
        transfer_id: &str,
        session_id: &str,
        direction: TransferDirection,
        file_name: &str,
        remote_path: &str,
        local_path: Option<String>,
        total: u64,
    ) {
        let now = now_ms();
        let entry = PersistedTransfer {
            transfer_id: transfer_id.to_string(),
            session_id: session_id.to_string(),
            direction,
            file_name: file_name.to_string(),
            remote_path: remote_path.to_string(),
            local_path,
            status: PersistedTransferStatus::Queued,
            transferred: 0,
            total,
            resume_offset: 0,
            created_at_ms: now,
            updated_at_ms: now,
        };
        let mut store = self.lock();
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Fold a lifecycle/progress update for a transfer into the persisted queue.
    ///
    /// Debounced: writes only on a **status change** or a coarse **byte
    /// checkpoint** ([`CHECKPOINT_BYTES`]), so per-chunk progress is free. A
    /// genuine terminal outcome (completed / user-cancel / failure) prunes the
    /// record. `is_teardown` marks the app-quit cancel-all sweep: the terminal
    /// transitions it induces must NOT erase in-flight records, so they can
    /// rehydrate as paused on the next launch (PROD-0011 requirement 4).
    pub fn note_progress(
        &self,
        transfer_id: &str,
        status: PersistedTransferStatus,
        transferred: u64,
        total: u64,
        is_teardown: bool,
    ) {
        let mut store = self.lock();
        let Some(existing) = store.get(transfer_id).cloned() else {
            // No registration record (persistence disabled, or already pruned).
            // Never fabricate a path-less record from a bare progress event.
            return;
        };

        if status.is_terminal() {
            // Completed always prunes — it genuinely finished, even at quit.
            // Cancelled/Failed prune too, EXCEPT when they were induced by the
            // quit teardown's cancel-all: those in-flight transfers must survive
            // as paused (requirement 4).
            let teardown_induced = is_teardown
                && matches!(
                    status,
                    PersistedTransferStatus::Cancelled | PersistedTransferStatus::Failed
                );
            if teardown_induced {
                return;
            }
            if store.remove(transfer_id) {
                self.schedule_write(&store);
            }
            return;
        }

        // Incomplete: coalesce hot progress; persist on a state change or a
        // coarse offset checkpoint only.
        let status_changed = existing.status != status;
        let offset_jump = transferred >= existing.transferred.saturating_add(CHECKPOINT_BYTES);
        if !status_changed && !offset_jump {
            return;
        }

        let mut updated = existing;
        updated.status = status;
        updated.transferred = transferred;
        if total > 0 {
            updated.total = total;
        }
        updated.resume_offset = transferred;
        updated.updated_at_ms = now_ms();
        store.upsert(updated);
        self.schedule_write(&store);
    }

    /// Remove a transfer's persisted record (e.g. the user removed a rehydrated
    /// row). Idempotent; a no-op for an unknown id.
    pub fn remove(&self, transfer_id: &str) {
        let mut store = self.lock();
        if store.remove(transfer_id) {
            self.schedule_write(&store);
        }
    }

    /// The incomplete persisted transfers, each mapped to a paused copy — the
    /// startup rehydration list (never auto-resume — PROD-0011 decision).
    pub fn load_incomplete_as_paused(&self) -> Vec<PersistedTransfer> {
        self.lock().incomplete_as_paused()
    }

    /// The current persisted record for a transfer id, if any (a clone).
    ///
    /// Used by the resume-relaunch path (#3199) to recover a rehydrated transfer's
    /// **metadata** — the session reference, source/destination paths, direction,
    /// resume offset and totals — so a relaunch can re-attach the session and
    /// re-spawn the executor from the checkpoint. The record carries **no**
    /// credential material (PROD-0011 invariant), so credentials are always
    /// re-sourced from the live session / credential store at resume time, never
    /// from here.
    pub fn get_record(&self, transfer_id: &str) -> Option<PersistedTransfer> {
        self.lock().get(transfer_id).cloned()
    }

    /// Queue the current store snapshot for the background writer (non-blocking,
    /// fire-and-forget). A dropped writer (spawn failed / shutting down) is
    /// silently ignored — persistence degrades, it never blocks a transfer.
    fn schedule_write(&self, store: &PersistedTransferStore) {
        let _ = self.writer.send(store.clone());
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PersistedTransferStore> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The current in-memory store (test/diagnostics).
    #[cfg(test)]
    fn snapshot(&self) -> PersistedTransferStore {
        self.lock().clone()
    }

    /// Create a manager backed by a temp directory (test only).
    #[cfg(test)]
    pub(crate) fn new_test(dir: &std::path::Path) -> Self {
        let storage = TransferPersistenceStorage::new_test(dir);
        let data = storage
            .load_with_recovery()
            .map(|r| r.data)
            .unwrap_or_default();
        Self::from_parts(storage, data, Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mgr() -> (TempDir, TransferPersistenceManager) {
        let dir = TempDir::new().unwrap();
        let m = TransferPersistenceManager::new_test(dir.path());
        (dir, m)
    }

    fn register(m: &TransferPersistenceManager, id: &str) {
        m.record_registration(
            id,
            "sess-a",
            TransferDirection::Download,
            "data.csv",
            "/remote/data.csv",
            Some("/home/user/data.csv".to_string()),
            2048,
        );
    }

    #[test]
    fn registration_is_rehydrated_as_paused() {
        let (_d, m) = mgr();
        register(&m, "t1");
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1);
        assert_eq!(rehydrated[0].transfer_id, "t1");
        assert_eq!(rehydrated[0].status, PersistedTransferStatus::Paused);
        assert_eq!(
            rehydrated[0].local_path.as_deref(),
            Some("/home/user/data.csv"),
            "the destination path is persisted (not a credential)"
        );
    }

    #[test]
    fn progress_advances_status_and_offset_is_preserved_through_rehydration() {
        let (_d, m) = mgr();
        register(&m, "t1");
        // Active with a large offset (past the checkpoint) → persisted.
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            CHECKPOINT_BYTES + 1,
            2048,
            false,
        );
        let snap = m.snapshot();
        let rec = snap.get("t1").unwrap();
        assert_eq!(rec.status, PersistedTransferStatus::Active);
        assert_eq!(rec.transferred, CHECKPOINT_BYTES + 1);
        assert_eq!(rec.resume_offset, CHECKPOINT_BYTES + 1);

        // Rehydrates as paused, keeping the resume offset.
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1);
        assert_eq!(rehydrated[0].status, PersistedTransferStatus::Paused);
        assert_eq!(rehydrated[0].resume_offset, CHECKPOINT_BYTES + 1);
    }

    #[test]
    fn small_progress_does_not_checkpoint() {
        let (_d, m) = mgr();
        register(&m, "t1");
        m.note_progress("t1", PersistedTransferStatus::Active, 1024, 2048, false);
        // Status changed (Queued→Active) so this one persists at 1024.
        assert_eq!(m.snapshot().get("t1").unwrap().transferred, 1024);
        // A tiny further advance (same status, below the checkpoint) is coalesced.
        m.note_progress("t1", PersistedTransferStatus::Active, 1500, 2048, false);
        assert_eq!(
            m.snapshot().get("t1").unwrap().transferred,
            1024,
            "sub-checkpoint progress is not written"
        );
    }

    #[test]
    fn genuine_terminal_prunes_the_record() {
        for terminal in [
            PersistedTransferStatus::Completed,
            PersistedTransferStatus::Cancelled,
            PersistedTransferStatus::Failed,
        ] {
            let (_d, m) = mgr();
            register(&m, "t1");
            m.note_progress("t1", terminal, 2048, 2048, false);
            assert!(
                m.snapshot().get("t1").is_none(),
                "{terminal:?} during the session prunes the record"
            );
            assert!(m.load_incomplete_as_paused().is_empty());
        }
    }

    #[test]
    fn teardown_cancel_keeps_record_for_rehydration() {
        let (_d, m) = mgr();
        register(&m, "t1");
        m.note_progress("t1", PersistedTransferStatus::Active, 1024, 2048, false);
        // App-quit teardown cancels every in-flight transfer — must NOT erase it.
        m.note_progress("t1", PersistedTransferStatus::Cancelled, 1024, 2048, true);
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "teardown cancel is not pruned (req 4)");
        assert_eq!(rehydrated[0].status, PersistedTransferStatus::Paused);
    }

    #[test]
    fn teardown_completed_still_prunes() {
        let (_d, m) = mgr();
        register(&m, "t1");
        // A transfer that genuinely finished at quit is done, not paused.
        m.note_progress("t1", PersistedTransferStatus::Completed, 2048, 2048, true);
        assert!(m.snapshot().get("t1").is_none());
    }

    #[test]
    fn progress_for_unknown_id_is_ignored() {
        let (_d, m) = mgr();
        m.note_progress("ghost", PersistedTransferStatus::Active, 10, 20, false);
        assert!(m.snapshot().transfers.is_empty());
    }

    #[test]
    fn get_record_returns_metadata_for_relaunch_and_none_when_absent() {
        // The relaunch path (#3199) recovers a rehydrated transfer's metadata by
        // id. It carries the session reference, paths and resume offset — never a
        // credential.
        let (_d, m) = mgr();
        register(&m, "t1");
        m.note_progress("t1", PersistedTransferStatus::Active, 4096, 2048, false);

        let rec = m.get_record("t1").expect("a registered record is returned");
        assert_eq!(rec.session_id, "sess-a");
        assert_eq!(rec.remote_path, "/remote/data.csv");
        assert_eq!(rec.local_path.as_deref(), Some("/home/user/data.csv"));
        assert_eq!(
            rec.resume_offset, 4096,
            "the checkpoint offset is recovered"
        );

        assert!(m.get_record("ghost").is_none(), "unknown id yields None");
    }

    #[test]
    fn remove_prunes_a_rehydrated_row() {
        let (_d, m) = mgr();
        register(&m, "t1");
        m.remove("t1");
        assert!(m.snapshot().get("t1").is_none());
        assert!(m.load_incomplete_as_paused().is_empty());
    }
}
