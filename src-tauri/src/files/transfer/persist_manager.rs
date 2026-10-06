//! The persisted transfer-queue manager (PROD-0011).
//!
//! Owns the in-memory [`PersistedTransferStore`] and a **single background
//! writer** so persistence is fire-and-forget: no queue mutation ever blocks a
//! transfer on disk I/O. Writes are coalesced (only the latest snapshot is
//! flushed), and the store is written **only on a status change or a coarse byte
//! checkpoint** — never per-chunk — so a hot progress stream costs nothing.
//!
//! Mirrors `crate::workflows::history_manager::WorkflowRunHistoryManager` in
//! construction and recovery-warning handling.

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::persist::{
    FolderPasteEndpoint, FolderPasteOperation, PersistedAgentTarget, PersistedDockerTarget,
    PersistedFolderPaste, PersistedGraphicalTarget, PersistedRemoteSource, PersistedTransfer,
    PersistedTransferStatus, PersistedTransferStore,
};
use super::persist_storage::TransferPersistenceStorage;
use super::relaunch_auto::CredentialWaits;
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

/// A message to the background writer thread.
enum WriterMsg {
    /// Persist this store snapshot (coalesced with any later queued ones).
    Save(PersistedTransferStore),
    /// Acknowledge once every snapshot queued before this message is on disk.
    /// Lets a test wait for the writer deterministically instead of polling
    /// the file against a wall-clock deadline (#3923).
    #[cfg(test)]
    Flush(Sender<()>),
}

/// Persists the transfer queue to `transfers.json` and rehydrates it on startup
/// (PROD-0011). Managed as Tauri state; every mutation is non-blocking.
pub struct TransferPersistenceManager {
    store: Mutex<PersistedTransferStore>,
    /// Sends the latest store snapshot to the background writer. A send is
    /// non-blocking; the writer coalesces bursts into a single atomic write.
    writer: Sender<WriterMsg>,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
    /// Ids of the folder pastes that were still recorded when this process
    /// started (#3630): each is a paste a previous run never finished.
    interrupted_pastes: Mutex<Vec<String>>,
    /// The rehydrated transfers paused for credentials (#3883), in memory only.
    credential_waits: CredentialWaits,
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
        let (writer, rx) = mpsc::channel::<WriterMsg>();
        // Single background writer: fire-and-forget, coalescing. It drains every
        // queued snapshot and writes only the most recent, so a burst of
        // checkpoints costs one atomic write. Exits when the manager (and thus
        // the sender) is dropped.
        let spawned = std::thread::Builder::new()
            .name("transfer-persist".to_string())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut latest = None;
                    #[cfg(test)]
                    let mut acks = Vec::new();
                    let mut msg = Some(first);
                    while let Some(m) = msg {
                        match m {
                            WriterMsg::Save(store) => latest = Some(store),
                            #[cfg(test)]
                            WriterMsg::Flush(ack) => acks.push(ack),
                        }
                        msg = rx.try_recv().ok();
                    }
                    if let Some(latest) = latest {
                        if let Err(e) = storage.save(&latest) {
                            tracing::warn!(error = %e, "failed to persist transfer queue (PROD-0011)");
                        }
                    }
                    // The channel is FIFO, so every snapshot sent before a flush
                    // request was drained in this batch and is now written.
                    #[cfg(test)]
                    for ack in acks {
                        let _ = ack.send(());
                    }
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "could not start transfer-persist writer; queue persistence disabled");
        }

        let mut data = data;
        let interrupted = data.folder_pastes.iter().map(|p| p.id.clone()).collect();
        // The file a session folder paste had in flight belongs to that paste's
        // interrupted-paste notice (#3643): its Retry re-copies the file (the
        // partial destination never matches the source size), and the file's
        // session id does not survive the restart, so a paused row of its own
        // could never resume. Drop those records before anything rehydrates
        // them, so the folder is reported as ONE unit.
        let dropped = data.remove_folder_paste_transfers();
        let manager = Self {
            store: Mutex::new(data),
            writer,
            recovery_warnings: Mutex::new(warnings),
            interrupted_pastes: Mutex::new(interrupted),
            credential_waits: CredentialWaits::default(),
        };
        if dropped > 0 {
            tracing::debug!(
                dropped,
                "Dropped transfers owned by interrupted folder pastes"
            );
            manager.schedule_write(&manager.lock());
        }
        manager
    }

    /// The rehydrated transfers paused for credentials, waiting to resume on
    /// their own (#3883).
    pub(crate) fn credential_waits(&self) -> &CredentialWaits {
        &self.credential_waits
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
            folder_paste_id: None,
            source_mtime: None,
            remote_source: None,
            saved_connection_id: None,
            agent: None,
            graphical: None,
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

    /// Attach the source endpoint of a remote-to-remote copy to a registered
    /// transfer (#3206), so a relaunch after a restart can re-attach both
    /// sessions — with the saved connection the source session was opened for
    /// (#3876), when known. References and paths only — never credentials. A
    /// no-op for an unknown id (never fabricates a record).
    pub fn record_remote_source(
        &self,
        transfer_id: &str,
        session_id: &str,
        path: &str,
        saved_connection_id: Option<&str>,
    ) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.remote_source = Some(PersistedRemoteSource {
            session_id: session_id.to_string(),
            path: path.to_string(),
            saved_connection_id: saved_connection_id.map(str::to_string),
            container_id: None,
            agent: None,
        });
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach the source container of a remote-to-remote copy whose source is
    /// a Docker session (#3586), so a relaunch re-attaches to that exact
    /// container by id. A no-op for an unknown id or one without a recorded
    /// source (never fabricates a record).
    pub fn record_remote_source_container(&self, transfer_id: &str, container_id: &str) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        let Some(source) = entry.remote_source.as_mut() else {
            return;
        };
        source.container_id = Some(container_id.to_string());
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach the agent-hosted session a remote-to-remote copy reads from
    /// (#4115), so a relaunch finds that session once its agent is
    /// reconnected. Ids only — never a secret. A no-op for an unknown id or
    /// one without a recorded source (never fabricates a record).
    pub fn record_remote_source_agent(&self, transfer_id: &str, agent: PersistedAgentTarget) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        let Some(source) = entry.remote_source.as_mut() else {
            return;
        };
        source.agent = Some(agent);
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach the saved connection a registered transfer's session was opened
    /// for (#3876), so a relaunch after a restart can re-source its secret from
    /// the credential store. The id only — never a secret. A no-op for an
    /// unknown id (never fabricates a record).
    pub fn record_saved_connection(&self, transfer_id: &str, connection_id: &str) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.saved_connection_id = Some(connection_id.to_string());
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach the agent-hosted session identity to a registered ranged
    /// transfer (#4114), so a relaunch after a restart can find the session
    /// once the user reconnects the agent. Ids only — never a secret. A no-op
    /// for an unknown id (never fabricates a record).
    pub fn record_agent_target(&self, transfer_id: &str, agent: PersistedAgentTarget) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.agent = Some(agent);
        store.upsert(entry);
        self.schedule_write(&store);
    }

    /// Attach a graphical session's side-channel identity to a registered
    /// transfer (#4205): the saved VNC connection and the route to the file
    /// host, so a relaunch after a restart resumes it once a session of that
    /// connection is back. Ids and host names only — never a secret. A no-op
    /// for an unknown id (never fabricates a record).
    pub fn record_graphical_target(&self, transfer_id: &str, target: PersistedGraphicalTarget) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.graphical = Some(target);
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

    /// Link a registered transfer to the session folder paste it copies a file
    /// for (#3643), so a restart mid-paste reports the file through the paste's
    /// notice instead of as an orphan paused row. A no-op for an unknown id
    /// (never fabricates a record).
    pub fn record_folder_paste(&self, transfer_id: &str, paste_id: &str) {
        let mut store = self.lock();
        let Some(mut entry) = store.get(transfer_id).cloned() else {
            return;
        };
        entry.folder_paste_id = Some(paste_id.to_string());
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
        self.credential_waits.forget(transfer_id);
        let mut store = self.lock();
        let record = store.get(transfer_id).cloned()?;
        store.remove(transfer_id);
        self.schedule_write(&store);
        Some(record)
    }

    /// Fold a lifecycle/progress update for a transfer into the persisted queue.
    ///
    /// Debounced: writes only on a **status change** or a coarse **byte
    /// checkpoint** (`CHECKPOINT_BYTES`), so per-chunk progress is free. A
    /// genuine terminal outcome (completed / user-cancel / failure) prunes the
    /// record. `is_teardown` marks the app-quit cancel-all sweep: the terminal
    /// transitions it induces must NOT erase in-flight records, so they can
    /// rehydrate as paused on the next launch (PROD-0011 requirement 4).
    ///
    /// `source_mtime` is the source mtime the executor fingerprinted for the
    /// bytes counted in `transferred` (#3572). A change forces a write, so the
    /// persisted mtime and resume offset always describe the same source.
    pub fn note_progress(
        &self,
        transfer_id: &str,
        status: PersistedTransferStatus,
        transferred: u64,
        total: u64,
        is_teardown: bool,
        source_mtime: Option<u64>,
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
        let mtime_changed = existing.source_mtime != source_mtime;
        if !status_changed && !offset_jump && !mtime_changed {
            return;
        }

        let mut updated = existing;
        updated.status = status;
        updated.transferred = transferred;
        if total > 0 {
            updated.total = total;
        }
        updated.resume_offset = transferred;
        updated.source_mtime = source_mtime;
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
        let _ = self.writer.send(WriterMsg::Save(store.clone()));
    }

    /// Block until every write queued so far has reached disk (test only).
    ///
    /// Deterministic: no deadline, so a loaded runner can only make it slower,
    /// never make it fail (#3923).
    #[cfg(test)]
    fn flush(&self) {
        let (ack, done) = mpsc::channel();
        self.writer
            .send(WriterMsg::Flush(ack))
            .expect("transfer-persist writer is running");
        done.recv()
            .expect("transfer-persist writer acknowledged the flush");
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
            None,
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

    /// The source container of a Docker-sourced remote-to-remote copy (#3586)
    /// is kept with its source endpoint and survives rehydration, next to the
    /// destination container; it is never attached to a record without a
    /// recorded source.
    #[test]
    fn remote_source_container_survives_rehydration() {
        let (_d, m) = mgr();
        for id in ["r2r", "plain"] {
            m.record_registration(
                id,
                "sess-dst",
                TransferDirection::Upload,
                "data.csv",
                "/dst/data.csv",
                None,
                0,
            );
        }
        m.record_remote_source("r2r", "sess-src", "/src/data.csv", None);
        m.record_remote_source_container("r2r", "src-c0ffee");
        m.record_docker_target("r2r", "dst-c0ffee");
        m.record_remote_source_container("plain", "src-c0ffee");
        m.record_remote_source_container("ghost", "src-c0ffee");
        for id in ["r2r", "plain"] {
            m.note_progress(
                id,
                PersistedTransferStatus::Active,
                CHECKPOINT_BYTES + 1,
                2048,
                false,
                None,
            );
        }
        let rehydrated = m.load_incomplete_as_paused();
        let r2r = rehydrated.iter().find(|r| r.transfer_id == "r2r").unwrap();
        let source = r2r.remote_source.as_ref().unwrap();
        assert_eq!(source.container_id.as_deref(), Some("src-c0ffee"));
        assert_eq!(
            r2r.docker.as_ref().map(|d| d.container_id.as_str()),
            Some("dst-c0ffee")
        );
        let plain = rehydrated
            .iter()
            .find(|r| r.transfer_id == "plain")
            .unwrap();
        assert_eq!(plain.remote_source, None, "no source fabricated");
        assert_eq!(rehydrated.len(), 2, "no record fabricated for `ghost`");
    }

    /// A remote-to-remote copy's source endpoint (#3206) survives progress
    /// checkpoints and rehydration; attaching it to an unknown id never
    /// fabricates a record.
    #[test]
    fn remote_source_survives_progress_and_rehydration() {
        let (_d, m) = mgr();
        m.record_registration(
            "r2r",
            "sess-dst",
            TransferDirection::Upload,
            "data.csv",
            "/dst/data.csv",
            None,
            0,
        );
        m.record_remote_source("r2r", "sess-src", "/src/data.csv", Some("conn-src"));
        m.record_remote_source("ghost", "sess-src", "/src/data.csv", None);
        m.note_progress(
            "r2r",
            PersistedTransferStatus::Active,
            CHECKPOINT_BYTES + 1,
            2048,
            false,
            Some(7),
        );
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "no record fabricated for `ghost`");
        assert_eq!(
            rehydrated[0].remote_source,
            Some(PersistedRemoteSource {
                session_id: "sess-src".to_string(),
                path: "/src/data.csv".to_string(),
                saved_connection_id: Some("conn-src".to_string()),
                container_id: None,
                agent: None,
            })
        );
        assert_eq!(rehydrated[0].resume_offset, CHECKPOINT_BYTES + 1);
        assert_eq!(rehydrated[0].source_mtime, Some(7));
    }

    /// The agent session a remote-to-remote copy reads from (#4115) is kept
    /// with its source endpoint and survives rehydration, next to the
    /// destination's agent identity; it is never attached to a record without
    /// a recorded source.
    #[test]
    fn remote_source_agent_survives_rehydration() {
        let (_d, m) = mgr();
        for id in ["r2r", "plain"] {
            m.record_registration(
                id,
                "sess-dst",
                TransferDirection::Upload,
                "data.csv",
                "/dst/data.csv",
                None,
                0,
            );
        }
        let agent = |id: &str| PersistedAgentTarget {
            agent_id: id.to_string(),
            remote_session_id: "remote-1".to_string(),
            definition_id: None,
        };
        m.record_remote_source("r2r", "sess-src", "/src/data.csv", None);
        m.record_remote_source_agent("r2r", agent("src-agent"));
        m.record_agent_target("r2r", agent("dst-agent"));
        m.record_remote_source_agent("plain", agent("src-agent"));
        m.record_remote_source_agent("ghost", agent("src-agent"));
        for id in ["r2r", "plain"] {
            m.note_progress(
                id,
                PersistedTransferStatus::Active,
                CHECKPOINT_BYTES + 1,
                2048,
                false,
                None,
            );
        }
        let rehydrated = m.load_incomplete_as_paused();
        let r2r = rehydrated.iter().find(|r| r.transfer_id == "r2r").unwrap();
        let source = r2r.remote_source.as_ref().unwrap();
        assert_eq!(source.agent, Some(agent("src-agent")));
        assert_eq!(r2r.agent, Some(agent("dst-agent")));
        let plain = rehydrated
            .iter()
            .find(|r| r.transfer_id == "plain")
            .unwrap();
        assert_eq!(plain.remote_source, None, "no source fabricated");
        assert_eq!(rehydrated.len(), 2, "no record fabricated for `ghost`");
    }

    /// The saved connection a session transfer was started on (#3876) survives
    /// progress checkpoints and rehydration, so a relaunch after a restart can
    /// re-source its secret; attaching it to an unknown id never fabricates a
    /// record.
    #[test]
    fn saved_connection_survives_progress_and_rehydration() {
        let (_d, m) = mgr();
        register(&m, "t1");
        m.record_saved_connection("t1", "Work/files");
        m.record_saved_connection("ghost", "Work/files");
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            CHECKPOINT_BYTES + 1,
            2048,
            false,
            None,
        );
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "no record fabricated for `ghost`");
        assert_eq!(
            rehydrated[0].saved_connection_id.as_deref(),
            Some("Work/files")
        );
    }

    /// The agent session identity of an agent-hosted transfer (#4114) survives
    /// progress checkpoints and rehydration; attaching it to an unknown id
    /// never fabricates a record.
    #[test]
    fn agent_target_survives_progress_and_rehydration() {
        let (_d, m) = mgr();
        register(&m, "t1");
        let agent = PersistedAgentTarget {
            agent_id: "agent-1".to_string(),
            remote_session_id: "remote-1".to_string(),
            definition_id: Some("def-a".to_string()),
        };
        m.record_agent_target("t1", agent.clone());
        m.record_agent_target("ghost", agent.clone());
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            CHECKPOINT_BYTES + 1,
            2048,
            false,
            None,
        );
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "no record fabricated for `ghost`");
        assert_eq!(rehydrated[0].agent, Some(agent));
        assert_eq!(rehydrated[0].resume_offset, CHECKPOINT_BYTES + 1);
    }

    /// A graphical side-channel upload (#4205) keeps its VNC identity and its
    /// checkpoint through the quit teardown and a restart (a fresh manager on
    /// the same file), so the next launch can resume it from the offset;
    /// attaching it to an unknown id never fabricates a record.
    #[test]
    fn graphical_target_survives_quit_and_restart() {
        let dir = TempDir::new().unwrap();
        let target = PersistedGraphicalTarget {
            connection_id: "Lab/pi-desktop".to_string(),
            route: termihub_core::connection::FileSideChannelKind::Ssh,
            host: "lab-pi".to_string(),
            user: "pi".to_string(),
            agent_id: None,
        };
        {
            let m = TransferPersistenceManager::new_test(dir.path());
            m.record_registration(
                "up-1",
                "rd-1",
                TransferDirection::Upload,
                "big.bin",
                "/home/pi/Desktop/big.bin",
                Some("/local/big.bin".to_string()),
                0,
            );
            m.record_graphical_target("up-1", target.clone());
            m.record_graphical_target("ghost", target.clone());
            m.note_progress(
                "up-1",
                PersistedTransferStatus::Active,
                CHECKPOINT_BYTES + 7,
                3 * CHECKPOINT_BYTES,
                false,
                Some(42),
            );
            // The quit teardown's cancel-all keeps the record.
            m.note_progress(
                "up-1",
                PersistedTransferStatus::Cancelled,
                CHECKPOINT_BYTES + 9,
                3 * CHECKPOINT_BYTES,
                true,
                Some(42),
            );
            m.flush();
        }
        let m = TransferPersistenceManager::new_test(dir.path());
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "no record fabricated for `ghost`");
        let record = &rehydrated[0];
        assert_eq!(record.graphical, Some(target));
        assert_eq!(record.status, PersistedTransferStatus::Paused);
        assert_eq!(record.resume_offset, CHECKPOINT_BYTES + 7);
        assert_eq!(record.source_mtime, Some(42));
        assert_eq!(record.direction, TransferDirection::Upload);
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
            None,
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

    /// The source mtime the executor fingerprinted (#3572) is persisted with
    /// the checkpoint, so a relaunch can detect a same-size rewrite. A change
    /// of mtime forces a write (even below the byte checkpoint) that stores the
    /// new mtime together with the offset reached against that source.
    #[test]
    fn source_mtime_is_persisted_with_its_offset() {
        let (_d, m) = mgr();
        register(&m, "t1");
        assert_eq!(m.snapshot().get("t1").unwrap().source_mtime, None);

        m.note_progress(
            "t1",
            PersistedTransferStatus::Queued,
            0,
            2048,
            false,
            Some(7),
        );
        let rec = m.snapshot().get("t1").cloned().unwrap();
        assert_eq!(rec.source_mtime, Some(7), "an mtime change is written");

        m.note_progress(
            "t1",
            PersistedTransferStatus::Queued,
            100,
            2048,
            false,
            Some(9),
        );
        let rec = m.snapshot().get("t1").cloned().unwrap();
        assert_eq!(rec.source_mtime, Some(9));
        assert_eq!(rec.resume_offset, 100, "offset is written with its mtime");

        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated[0].source_mtime, Some(9));
    }

    #[test]
    fn small_progress_does_not_checkpoint() {
        let (_d, m) = mgr();
        register(&m, "t1");
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            1024,
            2048,
            false,
            None,
        );
        // Status changed (Queued→Active) so this one persists at 1024.
        assert_eq!(m.snapshot().get("t1").unwrap().transferred, 1024);
        // A tiny further advance (same status, below the checkpoint) is coalesced.
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            1500,
            2048,
            false,
            None,
        );
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
            m.note_progress("t1", terminal, 2048, 2048, false, None);
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
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            1024,
            2048,
            false,
            None,
        );
        // App-quit teardown cancels every in-flight transfer — must NOT erase it.
        m.note_progress(
            "t1",
            PersistedTransferStatus::Cancelled,
            1024,
            2048,
            true,
            None,
        );
        let rehydrated = m.load_incomplete_as_paused();
        assert_eq!(rehydrated.len(), 1, "teardown cancel is not pruned (req 4)");
        assert_eq!(rehydrated[0].status, PersistedTransferStatus::Paused);
    }

    #[test]
    fn teardown_completed_still_prunes() {
        let (_d, m) = mgr();
        register(&m, "t1");
        // A transfer that genuinely finished at quit is done, not paused.
        m.note_progress(
            "t1",
            PersistedTransferStatus::Completed,
            2048,
            2048,
            true,
            None,
        );
        assert!(m.snapshot().get("t1").is_none());
    }

    #[test]
    fn progress_for_unknown_id_is_ignored() {
        let (_d, m) = mgr();
        m.note_progress(
            "ghost",
            PersistedTransferStatus::Active,
            10,
            20,
            false,
            None,
        );
        assert!(m.snapshot().transfers.is_empty());
    }

    #[test]
    fn get_record_returns_metadata_for_relaunch_and_none_when_absent() {
        // The relaunch path (#3199) recovers a rehydrated transfer's metadata by
        // id. It carries the session reference, paths and resume offset — never a
        // credential.
        let (_d, m) = mgr();
        register(&m, "t1");
        m.note_progress(
            "t1",
            PersistedTransferStatus::Active,
            4096,
            2048,
            false,
            None,
        );

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
            None,
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

    /// Assert whether `transfers.json` contains `needle`. Call only after
    /// [`TransferPersistenceManager::flush`], so the asynchronous writer has
    /// already landed every queued snapshot (#3923).
    fn assert_file(dir: &std::path::Path, needle: &str, present: bool) {
        let has = std::fs::read_to_string(dir.join("transfers.json"))
            .map(|s| s.contains(needle))
            .unwrap_or(false);
        assert_eq!(
            has,
            present,
            "transfers.json should {}contain {needle}",
            if present { "" } else { "not " }
        );
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
            m.flush();
            (unfinished, finished)
        };
        assert_file(dir.path(), &unfinished, true);
        assert_file(dir.path(), &finished, false);

        let relaunched = TransferPersistenceManager::new_test(dir.path());
        let taken = relaunched.take_interrupted_folder_pastes();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].id, unfinished);
        assert_eq!(taken[0].operation, FolderPasteOperation::Copy);
        assert_eq!(taken[0].destination.path, "/srv/photos");
        assert!(relaunched.take_interrupted_folder_pastes().is_empty());
        assert!(relaunched.snapshot().folder_pastes.is_empty());
    }

    /// A remote → local folder paste (#3912) is recorded in the same manifest:
    /// its source is the session it was copied from (with the saved connection
    /// a Retry reconnects through) and its destination is the local disk (no
    /// session). Left unfinished, it is listed as interrupted after a restart
    /// exactly like a paste into a session, and its in-flight download is
    /// reported through the paste instead of as its own paused row.
    #[test]
    fn interrupted_remote_to_local_folder_paste_is_listed_after_a_restart() {
        let dir = TempDir::new().unwrap();
        let paste = {
            let m = TransferPersistenceManager::new_test(dir.path());
            let source = FolderPasteEndpoint {
                connection_id: Some("conn-web".to_string()),
                label: Some("web".to_string()),
                ..endpoint(Some("sess-web"), "/srv/logs")
            };
            let paste = m.begin_folder_paste(
                FolderPasteOperation::Copy,
                source,
                endpoint(None, "/home/u/logs"),
            );
            register(&m, "download");
            m.record_folder_paste("download", &paste);
            m.flush();
            paste
        };

        let relaunched = TransferPersistenceManager::new_test(dir.path());
        let taken = relaunched.take_interrupted_folder_pastes();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].id, paste);
        assert_eq!(taken[0].source.session_id.as_deref(), Some("sess-web"));
        assert_eq!(taken[0].source.connection_id.as_deref(), Some("conn-web"));
        assert_eq!(taken[0].destination.session_id, None);
        assert_eq!(taken[0].destination.connection_id, None);
        assert_eq!(taken[0].destination.path, "/home/u/logs");
        assert!(
            relaunched.snapshot().get("download").is_none(),
            "the in-flight download is reported through the paste"
        );
    }

    /// The file a session folder paste had in flight at quit comes back only
    /// through the paste's notice, never as its own paused row (#3643).
    /// Unlinked records, and records of a paste that finished, rehydrate as
    /// before.
    #[test]
    fn in_flight_file_of_an_interrupted_folder_paste_is_not_rehydrated() {
        let dir = TempDir::new().unwrap();
        let paste = {
            let m = TransferPersistenceManager::new_test(dir.path());
            let paste = m.begin_folder_paste(
                FolderPasteOperation::Copy,
                endpoint(None, "/home/u/photos"),
                endpoint(Some("sess-b"), "/srv/photos"),
            );
            let finished = m.begin_folder_paste(
                FolderPasteOperation::Copy,
                endpoint(None, "/home/u/docs"),
                endpoint(Some("sess-b"), "/srv/docs"),
            );
            m.end_folder_paste(&finished);
            register(&m, "in-flight");
            m.record_folder_paste("in-flight", &paste);
            m.note_progress(
                "in-flight",
                PersistedTransferStatus::Active,
                1024,
                2048,
                false,
                None,
            );
            register(&m, "unlinked");
            register(&m, "of-finished");
            m.record_folder_paste("of-finished", &finished);
            m.record_folder_paste("unknown-transfer", &paste);
            assert!(m.snapshot().get("unknown-transfer").is_none());
            // Quit teardown: the in-flight file survives on disk as before.
            m.note_progress(
                "in-flight",
                PersistedTransferStatus::Cancelled,
                1024,
                2048,
                true,
                None,
            );
            m.flush();
            paste
        };
        assert_file(dir.path(), "of-finished", true);
        assert_file(dir.path(), "folderPasteId", true);

        let relaunched = TransferPersistenceManager::new_test(dir.path());
        let mut ids: Vec<String> = relaunched
            .load_incomplete_as_paused()
            .into_iter()
            .map(|t| t.transfer_id)
            .collect();
        ids.sort();
        assert_eq!(ids, ["of-finished", "unlinked"]);
        let taken = relaunched.take_interrupted_folder_pastes();
        assert_eq!(taken.len(), 1, "the folder is reported as one notice");
        assert_eq!(taken[0].id, paste);
        // The drop is persisted, so a later launch never resurrects the row.
        relaunched.flush();
        assert_file(dir.path(), "in-flight", false);
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
