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

use super::persist::{
    FolderPasteEndpoint, FolderPasteOperation, PersistedDockerTarget, PersistedFolderPaste,
    PersistedTransfer, PersistedTransferStatus, PersistedTransferStore,
};
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
    /// Ids of the folder pastes that were still recorded when this process
    /// started (#3630): each is a paste a previous run never finished.
    interrupted_pastes: Mutex<Vec<String>>,
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

        let interrupted = data.folder_pastes.iter().map(|p| p.id.clone()).collect();
        Self {
            store: Mutex::new(data),
            writer,
            recovery_warnings: Mutex::new(warnings),
            interrupted_pastes: Mutex::new(interrupted),
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
            docker: None,
            group_id: None,
        };
        let mut store = self.lock();
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach the Docker container identity to a registered transfer (#3585),
    /// so a relaunch after a restart can re-attach to the same container by id.
    /// A no-op for an unknown id (never fabricates a record).
    pub fn record_docker_target(&self, transfer_id: &str, container_id: &str) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.docker = Some(PersistedDockerTarget {
            container_id: container_id.to_string(),
        });
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach a local folder copy's cancel group to a registered transfer
    /// (#3613), so a relaunch after a restart can rebuild the folder's group.
    /// A no-op for an unknown id (never fabricates a record).
    pub fn record_group(&self, transfer_id: &str, group_id: &str) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.group_id = Some(group_id.to_string());
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// The ids of every persisted transfer in the cancel group `group_id`
    /// (#3613), in persisted order. Settled files are already pruned, so this
    /// is the folder's still-unfinished rest.
    pub fn group_members(&self, group_id: &str) -> Vec<String> {
        self.lock()
            .transfers
            .iter()
            .filter(|t| t.group_id.as_deref() == Some(group_id))
            .map(|t| t.transfer_id.clone())
            .collect()
    }

    /// Remove and return a transfer's persisted record in one step (#3613).
    /// Used to cancel a rehydrated row with no live handle: exactly one caller
    /// wins the record, so two racing cancels never both report it.
    pub fn take_record(&self, transfer_id: &str) -> Option<PersistedTransfer> {
        let mut store = self.lock();
        let record = store.get(transfer_id).cloned()?;
        store.remove(transfer_id);
        self.schedule_write(&store);
        Some(record)
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

    /// Drop every persisted transfer whose local endpoint lies under `root`
    /// (#3629). Called at startup with the drag-out staging root: a staging
    /// download's directory is deleted at quit, so its record could only
    /// rehydrate as a paused row that can never be resumed. Covers records
    /// written before staging downloads stopped being persisted. Returns how
    /// many were dropped.
    pub fn prune_local_paths_under(&self, root: &std::path::Path) -> usize {
        let mut store = self.lock();
        let removed = store.remove_local_paths_under(root);
        if removed > 0 {
            self.schedule_write(&store);
        }
        removed
    }

    /// Record a folder paste that is about to be driven file by file (#3630)
    /// and return its manifest id. Removed by [`Self::end_folder_paste`] once
    /// the folder fully landed; still present at the next launch, it is
    /// reported by [`Self::take_interrupted_folder_pastes`].
    pub fn begin_folder_paste(
        &self,
        operation: FolderPasteOperation,
        source: FolderPasteEndpoint,
        destination: FolderPasteEndpoint,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut store = self.lock();
        store.add_folder_paste(PersistedFolderPaste {
            id: id.clone(),
            operation,
            source,
            destination,
            started_at_ms: now_ms(),
        });
        self.schedule_write(&store);
        id
    }

    /// Remove a folder-paste record (the folder fully landed, or the user
    /// dismissed it). Idempotent.
    pub fn end_folder_paste(&self, id: &str) {
        let mut store = self.lock();
        if store.remove_folder_paste(id) {
            self.schedule_write(&store);
        }
    }

    /// Take the folder pastes a previous run left unfinished (#3630): each is
    /// returned once and its record removed, so a notice is shown once and a
    /// Retry records a fresh paste of its own. Pastes started by this process
    /// are never reported here.
    pub fn take_interrupted_folder_pastes(&self) -> Vec<PersistedFolderPaste> {
        let ids: Vec<String> = self
            .interrupted_pastes
            .lock()
            .map(|mut ids| std::mem::take(&mut *ids))
            .unwrap_or_default();
        if ids.is_empty() {
            return Vec::new();
        }
        let mut store = self.lock();
        let taken: Vec<PersistedFolderPaste> = store
            .folder_pastes
            .iter()
            .filter(|p| ids.contains(&p.id))
            .cloned()
            .collect();
        for paste in &taken {
            store.remove_folder_paste(&paste.id);
        }
        if !taken.is_empty() {
            self.schedule_write(&store);
        }
        taken
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

    /// The Docker container identity (#3585) survives progress checkpoints and
    /// rehydration; attaching it to an unknown id never fabricates a record.
    #[test]
    fn docker_target_survives_progress_and_rehydration() {
        let (_d, m) = mgr();
        register(&m, "t1");
        m.record_docker_target("t1", "c0ffee");
        m.record_docker_target("ghost", "c0ffee");
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            CHECKPOINT_BYTES + 1,
            2048,
            false,
        );
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "no record fabricated for `ghost`");
        assert_eq!(
            rehydrated[0].docker,
            Some(PersistedDockerTarget {
                container_id: "c0ffee".to_string()
            })
        );
        assert_eq!(rehydrated[0].resume_offset, CHECKPOINT_BYTES + 1);
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

    /// A folder's cancel group (#3613) survives progress and rehydration, and
    /// only its own members are listed; attaching one to an unknown id never
    /// fabricates a record.
    #[test]
    fn group_survives_rehydration_and_lists_only_its_members() {
        let (_d, m) = mgr();
        for id in ["a", "b", "other"] {
            register(&m, id);
        }
        m.record_group("a", "g1");
        m.record_group("b", "g1");
        m.record_group("ghost", "g1");
        m.note_progress(
            "a",
            PersistedTransferStatus::Active,
            CHECKPOINT_BYTES + 1,
            2048,
            false,
        );

        assert_eq!(m.group_members("g1"), vec!["a", "b"]);
        assert!(m.group_members("g2").is_empty());
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 3, "no record fabricated for `ghost`");
        assert_eq!(rehydrated[0].group_id.as_deref(), Some("g1"));
        assert_eq!(rehydrated[2].group_id, None);
    }

    #[test]
    fn take_record_removes_it_exactly_once() {
        let (_d, m) = mgr();
        register(&m, "t1");
        assert_eq!(
            m.take_record("t1").map(|r| r.transfer_id).as_deref(),
            Some("t1")
        );
        assert!(m.take_record("t1").is_none(), "a second take gets nothing");
        assert!(m.load_incomplete_as_paused().is_empty());
    }

    /// A drag-out staging download recorded by an older build is pruned at
    /// startup (#3629); an ordinary download still rehydrates.
    #[test]
    fn prune_local_paths_under_drops_staging_records_only() {
        let (_d, m) = mgr();
        register(&m, "plain");
        m.record_registration(
            "staged",
            "sess-a",
            TransferDirection::Download,
            "data.csv",
            "/remote/data.csv",
            Some("/cache/drag-out/42-uuid/data.csv".to_string()),
            2048,
        );
        assert_eq!(
            m.prune_local_paths_under(std::path::Path::new("/cache/drag-out")),
            1
        );
        let ids: Vec<String> = m
            .load_incomplete_as_paused()
            .into_iter()
            .map(|t| t.transfer_id)
            .collect();
        assert_eq!(ids, ["plain"]);
        assert_eq!(
            m.prune_local_paths_under(std::path::Path::new("/cache/drag-out")),
            0
        );
    }

    fn endpoint(session: Option<&str>, path: &str) -> FolderPasteEndpoint {
        FolderPasteEndpoint {
            session_id: session.map(str::to_string),
            connection_id: None,
            label: None,
            path: path.to_string(),
        }
    }

    /// Wait until the background writer has flushed `transfers.json`
    /// containing `needle` (the writer is asynchronous).
    fn wait_for_file(dir: &std::path::Path, needle: &str, present: bool) {
        let path = dir.join("transfers.json");
        for _ in 0..200 {
            let has = std::fs::read_to_string(&path)
                .map(|s| s.contains(needle))
                .unwrap_or(false);
            if has == present {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("transfers.json never reached the expected state for {needle}");
    }

    /// A folder paste that never ended is reported once after a "restart"
    /// (#3630); one that ended is not, and a paste of this process never is.
    #[test]
    fn unfinished_folder_paste_is_reported_once_after_a_restart() {
        let dir = TempDir::new().unwrap();
        let (unfinished, finished) = {
            let m = TransferPersistenceManager::new_test(dir.path());
            let unfinished = m.begin_folder_paste(
                FolderPasteOperation::Copy,
                endpoint(None, "/home/u/photos"),
                endpoint(Some("sess-b"), "/srv/photos"),
            );
            let finished = m.begin_folder_paste(
                FolderPasteOperation::Cut,
                endpoint(Some("sess-a"), "/a"),
                endpoint(Some("sess-b"), "/b"),
            );
            m.end_folder_paste(&finished);
            assert!(
                m.take_interrupted_folder_pastes().is_empty(),
                "this process's own pastes are not interrupted"
            );
            (unfinished, finished)
        };
        wait_for_file(dir.path(), &unfinished, true);
        wait_for_file(dir.path(), &finished, false);

        let relaunched = TransferPersistenceManager::new_test(dir.path());
        let taken = relaunched.take_interrupted_folder_pastes();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].id, unfinished);
        assert_eq!(taken[0].operation, FolderPasteOperation::Copy);
        assert_eq!(taken[0].destination.path, "/srv/photos");
        assert!(relaunched.take_interrupted_folder_pastes().is_empty());
        assert!(relaunched.snapshot().folder_pastes.is_empty());
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
