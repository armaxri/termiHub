//! Transfer registry — Tauri state tracking every in-flight transfer (#1336).
//!
//! A `transfer_id → `[`TransferHandle`]` map plus a per-session
//! [`SessionScheduler`], implementing the queue/concurrency/pause/resume/retry
//! model driven by the SFTP and FTP executors and the generic `transfer_*`
//! commands. A transfer's entry is dropped once its copy loop finishes; the
//! transfers projection region (fed by `transfer-progress`) is the authoritative
//! record of finished transfers, so the registry keeps no terminal history.
//!
//! The legacy cancel-only SFTP token map (#1245) was removed in #3188 once no
//! production path registered legacy transfers any more.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::scheduler::{Admission, SessionScheduler, DEFAULT_MAX_CONCURRENT};
use super::state::{TransferEvent, TransferState, TransferStateTag};
use super::TransferDirection;

/// A point-in-time view of one rich transfer: the source of a
/// `transfer-progress` payload ([`TransferProgress::from_snapshot`]) and of
/// [`TransferRegistry::list`].
///
/// [`TransferProgress::from_snapshot`]: super::TransferProgress::from_snapshot
#[derive(Debug, Clone)]
pub struct TransferSnapshot {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    /// Remote path of the transferred file (#1531), for the Transfer Queue row.
    pub path: String,
    pub state: TransferStateTag,
    pub transferred: u64,
    pub total: u64,
    pub speed: u64,
    pub attempt: u32,
    pub max_attempts: u32,
}

/// Mutable, lock-guarded control block of a rich transfer.
#[derive(Debug)]
struct HandleControl {
    state: TransferState,
    /// Whether this transfer currently occupies a session concurrency slot.
    holds_slot: bool,
    /// A pause has been requested; the executor applies it at the next boundary.
    pause_requested: bool,
    /// A resume/retry has been requested; the executor proceeds on wake.
    resume_requested: bool,
    transferred: u64,
    total: u64,
    speed: u64,
    attempt: u32,
    /// Modification time of the source when the bytes now at the destination
    /// were read (#3572), in the backend's own unit. Seeded from the persisted
    /// checkpoint on a relaunch and refreshed by the executor whenever it
    /// (re)fingerprints the source; persisted with the resume offset so a
    /// relaunch can detect a same-size rewrite. `None` when unknown.
    source_mtime: Option<u64>,
}

/// Shared control handle for one rich (queued) transfer.
///
/// The FTP executor owns an `Arc<TransferHandle>` and drives it; the generic
/// `transfer_*` commands look it up in the registry and signal it. All control
/// signalling goes through [`Notify`] so a queued/paused/failed-waiting task
/// wakes on any state change.
#[derive(Debug)]
pub struct TransferHandle {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    /// Remote path of the transferred file (#1531), surfaced in snapshots and
    /// `transfer-progress` events.
    pub path: String,
    /// Hard-cancel primitive checked by the copy loop at each boundary.
    pub token: CancellationToken,
    control: Mutex<HandleControl>,
    notify: Notify,
    max_attempts: u32,
}

impl TransferHandle {
    fn lock(&self) -> std::sync::MutexGuard<'_, HandleControl> {
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The current queue state.
    pub fn state(&self) -> TransferState {
        self.lock().state
    }

    /// Apply a state-machine transition, logging (but not panicking on) an
    /// illegal one — the executor only ever issues legal transitions.
    pub fn transition(&self, event: TransferEvent) -> TransferState {
        let mut c = self.lock();
        match c.state.apply(event) {
            Ok(next) => {
                c.state = next;
                next
            }
            Err(e) => {
                // Diagnostic only; logged when the consumer opts into the core
                // `tracing` feature (the desktop does), compiled out otherwise so
                // always-compiled core stays tracing-free (DUP-026 slice 2a).
                #[cfg(feature = "tracing")]
                tracing::warn!(transfer_id = %self.transfer_id, %e, "ignored illegal transition");
                #[cfg(not(feature = "tracing"))]
                let _ = &e;
                c.state
            }
        }
    }

    /// Settle a transfer whose executor task crashed (panicked) before it
    /// reached a terminal state (#4671), returning the resulting tag.
    ///
    /// A state the executor already settled (`completed`/`cancelled`, e.g. a
    /// panic in the partial-file cleanup after the cancel transition) is kept.
    /// Anything else is forced to a non-retryable `failed`: the state machine
    /// only allows `Fail` from `Active`, but a crash can strike while queued,
    /// paused or backing off, and the task that would retry is gone.
    #[cfg(any(
        feature = "ssh",
        feature = "docker",
        feature = "local-transfer",
        feature = "ftp"
    ))]
    pub(super) fn settle_crashed(&self) -> TransferStateTag {
        let mut c = self.lock();
        if !c.state.is_terminal() {
            c.state = TransferState::Failed {
                attempt: c.attempt.max(1),
                retryable: false,
            };
        }
        c.state.tag()
    }

    /// Whether hard cancellation has been signalled.
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Whether a pause has been requested but not yet applied.
    pub fn take_pause_request(&self) -> bool {
        let mut c = self.lock();
        std::mem::take(&mut c.pause_requested)
    }

    /// Consume a pending resume/retry request, returning whether one was set.
    pub fn take_resume_request(&self) -> bool {
        let mut c = self.lock();
        std::mem::take(&mut c.resume_requested)
    }

    /// Record live progress metrics for the next `transfer-progress` emit.
    pub fn set_metrics(&self, transferred: u64, total: u64, speed: u64) {
        let mut c = self.lock();
        c.transferred = transferred;
        c.total = total;
        c.speed = speed;
    }

    /// Record the current attempt number (for `failed (n/max)` display).
    pub fn set_attempt(&self, attempt: u32) {
        self.lock().attempt = attempt;
    }

    /// The configured maximum number of attempts.
    pub fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    /// Await any control signal (promotion, resume/retry, or cancel).
    pub async fn wait_for_signal(&self) {
        self.notify.notified().await;
    }

    /// Record the source's modification time at the current baseline (#3572).
    pub fn set_source_mtime(&self, mtime: Option<u64>) {
        self.lock().source_mtime = mtime;
    }

    /// The source's modification time at the current baseline, when known
    /// (#3572). Not part of the wire snapshot: it only feeds the persisted
    /// checkpoint.
    pub fn source_mtime(&self) -> Option<u64> {
        self.lock().source_mtime
    }

    /// A point-in-time view of this transfer.
    pub fn snapshot(&self) -> TransferSnapshot {
        let c = self.lock();
        TransferSnapshot {
            transfer_id: self.transfer_id.clone(),
            session_id: self.session_id.clone(),
            direction: self.direction,
            file_name: self.file_name.clone(),
            path: self.path.clone(),
            state: c.state.tag(),
            transferred: c.transferred,
            total: c.total,
            speed: c.speed,
            attempt: c.attempt,
            max_attempts: self.max_attempts,
        }
    }
}

/// Inner, lock-guarded registry state.
#[derive(Default)]
struct RegistryState {
    /// Rich queued transfers (#1336): id → handle.
    rich: HashMap<String, Arc<TransferHandle>>,
    /// Per-session slot accounting for the rich model.
    schedulers: HashMap<String, SessionScheduler>,
}

/// Tracks in-flight transfers by `transfer_id`.
///
/// `Clone` (state is behind an `Arc`) so a handle can be moved into copy tasks
/// and Tauri commands. Managed as Tauri state.
#[derive(Clone)]
pub struct TransferRegistry {
    state: Arc<Mutex<RegistryState>>,
    max_concurrent: usize,
    /// Set while the app-quit teardown's cancel-all sweep is running
    /// (PROD-0011); see [`Self::is_queue_teardown`].
    ///
    /// Held per registry (shared by its clones) rather than as a process-wide
    /// static, so a [`Self::cancel_all`] on one registry can never leak into
    /// another — in production there is exactly one managed registry, so the
    /// quit behaviour is unchanged, while independent test registries no longer
    /// inherit each other's teardown (#4675).
    teardown: Arc<AtomicBool>,
}

impl Default for TransferRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TransferRegistry {
    /// Create an empty registry with the default per-session concurrency cap.
    pub fn new() -> Self {
        Self::with_max_concurrent(DEFAULT_MAX_CONCURRENT)
    }

    /// Create a registry with a custom per-session concurrency cap.
    pub fn with_max_concurrent(max_concurrent: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            max_concurrent: max_concurrent.max(1),
            teardown: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Lock the inner state, recovering the guard even if the mutex is poisoned.
    ///
    /// A poisoned lock here is always cleanup-adjacent (register/cancel/drop),
    /// so recovering the guard and continuing is correct — mirrors the
    /// poison-safe draining in `SftpManager` (audit GAP C1, #1143/#1244).
    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Cancel a transfer by id. Unknown / already-finished ids are a no-op
    /// (returns `false`); a live transfer is cancelled (returns `true`).
    pub fn cancel(&self, transfer_id: &str) -> bool {
        let handle = self.lock().rich.get(transfer_id).cloned();
        match handle {
            Some(h) => {
                h.token.cancel();
                h.notify.notify_one();
                true
            }
            None => false,
        }
    }

    /// Cancel every in-flight transfer. Used on app quit
    /// *before* sessions are closed, so no half-written file keeps a channel
    /// open during teardown. Returns the number of transfers signalled.
    pub fn cancel_all(&self) -> usize {
        // Mark the teardown sweep so the persistence layer (PROD-0011) keeps the
        // in-flight records it is about to cancel, rather than pruning them — they
        // rehydrate as paused on the next launch.
        self.teardown.store(true, Ordering::SeqCst);
        let state = self.lock();
        for handle in state.rich.values() {
            handle.token.cancel();
            handle.notify.notify_one();
        }
        state.rich.len()
    }

    /// Whether this registry's app-quit teardown cancel-all sweep has begun
    /// (PROD-0011).
    ///
    /// [`Self::cancel_all`] flips this on entry so the persistence layer can
    /// tell a *teardown-induced* cancellation (which must leave in-flight
    /// records intact, to rehydrate as paused next launch) from a *genuine user
    /// cancel* (which prunes the record). It is only ever set — the process is
    /// exiting.
    pub fn is_queue_teardown(&self) -> bool {
        self.teardown.load(Ordering::SeqCst)
    }

    /// Drop a transfer's registry entry once its copy loop has finished. This
    /// also releases any slot it still holds so a queued peer can be promoted.
    /// Nothing of the transfer is retained: its final state has already reached
    /// the transfers projection through its terminal `transfer-progress` emit.
    pub fn drop_entry(&self, transfer_id: &str) {
        let mut state = self.lock();
        if let Some(handle) = state.rich.remove(transfer_id) {
            Self::release_slot_locked(&mut state, &handle);
        }
    }

    // --- Rich queue model (#1336) ---

    /// Register a rich, queued transfer and return its handle (state `Queued`).
    pub fn enqueue(
        &self,
        transfer_id: &str,
        session_id: &str,
        direction: TransferDirection,
        file_name: &str,
        path: &str,
        total: u64,
    ) -> Arc<TransferHandle> {
        let handle = Arc::new(TransferHandle {
            transfer_id: transfer_id.to_string(),
            session_id: session_id.to_string(),
            direction,
            file_name: file_name.to_string(),
            path: path.to_string(),
            token: CancellationToken::new(),
            control: Mutex::new(HandleControl {
                state: TransferState::Queued,
                holds_slot: false,
                pause_requested: false,
                resume_requested: false,
                transferred: 0,
                total,
                speed: 0,
                attempt: 0,
                source_mtime: None,
            }),
            notify: Notify::new(),
            max_attempts: super::state::MAX_RETRIES,
        });
        self.lock()
            .rich
            .insert(transfer_id.to_string(), handle.clone());
        handle
    }

    /// Register a rich, queued transfer **only if no transfer with this id is
    /// already tracked**, returning its handle. Returns `None`
    /// when the id is already present.
    ///
    /// This closes the resume-relaunch race (#3199): a rehydrated transfer has no
    /// live handle, so a resume must re-enqueue one and spawn a fresh executor —
    /// but two concurrent resume clicks must never spawn two executors writing the
    /// same file. The check-and-insert is atomic under the registry lock, so at
    /// most one caller receives a handle; a losing caller gets `None` and signals
    /// the (now-present) handle instead of double-spawning.
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_if_absent(
        &self,
        transfer_id: &str,
        session_id: &str,
        direction: TransferDirection,
        file_name: &str,
        path: &str,
        total: u64,
    ) -> Option<Arc<TransferHandle>> {
        let mut state = self.lock();
        if state.rich.contains_key(transfer_id) {
            return None;
        }
        let handle = Arc::new(TransferHandle {
            transfer_id: transfer_id.to_string(),
            session_id: session_id.to_string(),
            direction,
            file_name: file_name.to_string(),
            path: path.to_string(),
            token: CancellationToken::new(),
            control: Mutex::new(HandleControl {
                state: TransferState::Queued,
                holds_slot: false,
                pause_requested: false,
                resume_requested: false,
                transferred: 0,
                total,
                speed: 0,
                attempt: 0,
                source_mtime: None,
            }),
            notify: Notify::new(),
            max_attempts: super::state::MAX_RETRIES,
        });
        state.rich.insert(transfer_id.to_string(), handle.clone());
        Some(handle)
    }

    /// Request a concurrency slot for a rich transfer. Grants it (transition to
    /// `Active`, returns [`Admission::Run`]) when under the session cap, else
    /// leaves the transfer `Queued` and returns [`Admission::Queue`]; the
    /// executor then awaits [`TransferHandle::wait_for_signal`] for promotion.
    pub fn request_slot(&self, handle: &Arc<TransferHandle>) -> Admission {
        let mut state = self.lock();
        let max = self.max_concurrent;
        let sched = state
            .schedulers
            .entry(handle.session_id.clone())
            .or_insert_with(|| SessionScheduler::new(max));
        let admission = sched.request(&handle.transfer_id);
        if admission == Admission::Run {
            let mut c = handle.lock();
            c.holds_slot = true;
            if c.state == TransferState::Queued {
                c.state = TransferState::Active;
            }
        }
        admission
    }

    /// Release the slot a rich transfer holds (if any) and promote the next
    /// queued transfer on that session, waking its task. Safe to call for a
    /// transfer that holds no slot (a no-op).
    pub fn release_slot(&self, handle: &Arc<TransferHandle>) {
        let mut state = self.lock();
        Self::release_slot_locked(&mut state, handle);
    }

    fn release_slot_locked(state: &mut RegistryState, handle: &Arc<TransferHandle>) {
        {
            let mut c = handle.lock();
            if !c.holds_slot {
                // Not holding a slot (was queued/paused): just leave the queue.
                if let Some(sched) = state.schedulers.get_mut(&handle.session_id) {
                    sched.remove_waiting(&handle.transfer_id);
                }
                return;
            }
            c.holds_slot = false;
        }
        let promoted = state
            .schedulers
            .get_mut(&handle.session_id)
            .and_then(|s| s.release());
        if let Some(next_id) = promoted {
            if let Some(next) = state.rich.get(&next_id) {
                {
                    let mut c = next.lock();
                    c.holds_slot = true;
                    if c.state == TransferState::Queued {
                        c.state = TransferState::Active;
                    }
                }
                next.notify.notify_one();
            }
        }
    }

    /// Request a pause of a rich transfer (executor applies it at the next
    /// chunk boundary). Returns `false` for an unknown id.
    pub fn pause(&self, transfer_id: &str) -> bool {
        match self.get(transfer_id) {
            Some(h) => {
                h.lock().pause_requested = true;
                h.notify.notify_one();
                true
            }
            None => false,
        }
    }

    /// Request a resume of a paused rich transfer. Returns `false` for an
    /// unknown id.
    pub fn resume(&self, transfer_id: &str) -> bool {
        self.signal_resume(transfer_id)
    }

    /// Request a (manual) retry of a failed rich transfer — same wake path as
    /// resume; the executor resets the attempt counter. Returns `false` for an
    /// unknown id.
    pub fn retry(&self, transfer_id: &str) -> bool {
        self.signal_resume(transfer_id)
    }

    fn signal_resume(&self, transfer_id: &str) -> bool {
        match self.get(transfer_id) {
            Some(h) => {
                h.lock().resume_requested = true;
                h.notify.notify_one();
                true
            }
            None => false,
        }
    }

    /// Look up a rich transfer handle by id.
    pub fn get(&self, transfer_id: &str) -> Option<Arc<TransferHandle>> {
        self.lock().rich.get(transfer_id).cloned()
    }

    /// Snapshot every live transfer, optionally filtered by session. A
    /// transfer whose entry was dropped ([`Self::drop_entry`]) is not listed.
    pub fn list(&self, session_id: Option<&str>) -> Vec<TransferSnapshot> {
        self.lock()
            .rich
            .values()
            .filter(|handle| session_id.is_none_or(|f| handle.session_id == f))
            .map(|handle| handle.snapshot())
            .collect()
    }

    /// Whether the given session currently has any active or queued rich
    /// transfers (diagnostics).
    #[cfg(test)]
    pub fn active_count(&self, session_id: &str) -> usize {
        self.lock()
            .schedulers
            .get(session_id)
            .map(|s| s.active())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::transfer::state::MAX_RETRIES;

    // --- Source mtime (#3572) ---

    #[test]
    fn source_mtime_defaults_to_none_and_is_settable() {
        let reg = TransferRegistry::new();
        let h = enq(&reg, "t1", "s1");
        assert_eq!(h.source_mtime(), None);
        h.set_source_mtime(Some(1_700_000_000));
        assert_eq!(h.source_mtime(), Some(1_700_000_000));
        let fresh = reg
            .enqueue_if_absent("t2", "s1", TransferDirection::Upload, "f", "/f", 0)
            .expect("new id");
        assert_eq!(fresh.source_mtime(), None);
    }

    // --- Cancel / drop semantics ---

    #[test]
    fn cancel_unknown_id_is_a_noop() {
        let reg = TransferRegistry::new();
        assert!(
            !reg.cancel("does-not-exist"),
            "cancelling an unknown id is a no-op (returns false), not an error"
        );
    }

    #[test]
    fn cancel_all_trips_every_token() {
        let reg = TransferRegistry::new();
        let a = enq(&reg, "a", "s1");
        let b = enq(&reg, "b", "s1");
        let c = enq(&reg, "c", "s2");
        assert_eq!(
            reg.cancel_all(),
            3,
            "cancel_all reports the count signalled"
        );
        assert!(a.is_cancelled());
        assert!(b.is_cancelled());
        assert!(c.is_cancelled());
    }

    #[test]
    fn cancel_all_on_empty_registry_is_zero() {
        let reg = TransferRegistry::new();
        assert_eq!(reg.cancel_all(), 0);
    }

    #[test]
    fn cancel_all_marks_teardown_on_its_own_registry_only() {
        let reg = TransferRegistry::new();
        let clone = reg.clone();
        let other = TransferRegistry::new();
        assert!(!reg.is_queue_teardown());
        reg.cancel_all();
        assert!(
            reg.is_queue_teardown(),
            "the sweeping registry is in teardown"
        );
        assert!(clone.is_queue_teardown(), "clones share the teardown flag");
        assert!(
            !other.is_queue_teardown(),
            "an independent registry never inherits another's teardown (#4675)"
        );
    }

    #[test]
    fn drop_entry_removes_the_transfer() {
        let reg = TransferRegistry::new();
        enq(&reg, "t1", "s1");
        reg.drop_entry("t1");
        assert!(reg.get("t1").is_none());
    }

    #[test]
    fn drop_entry_for_unknown_id_is_a_noop() {
        let reg = TransferRegistry::new();
        enq(&reg, "t1", "s1");
        reg.drop_entry("other");
        assert!(reg.get("t1").is_some(), "unrelated entry must survive");
        assert_eq!(reg.list(None).len(), 1);
    }

    #[test]
    fn cancel_after_drop_is_a_noop() {
        let reg = TransferRegistry::new();
        enq(&reg, "t1", "s1");
        reg.drop_entry("t1");
        assert!(!reg.cancel("t1"));
    }

    // --- Rich queue model (#1336) ---

    fn enq(reg: &TransferRegistry, id: &str, session: &str) -> Arc<TransferHandle> {
        reg.enqueue(
            id,
            session,
            TransferDirection::Download,
            id,
            &format!("/remote/{id}"),
            100,
        )
    }

    #[test]
    fn enqueue_starts_queued_and_is_listed() {
        let reg = TransferRegistry::new();
        let h = enq(&reg, "a", "s1");
        assert_eq!(h.state(), TransferState::Queued);
        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].transfer_id, "a");
        assert_eq!(list[0].state, TransferStateTag::Queued);
        assert_eq!(
            list[0].path, "/remote/a",
            "the remote path is carried into the snapshot (#1531)"
        );
    }

    #[test]
    fn two_run_third_queues_then_promotes_on_release() {
        let reg = TransferRegistry::with_max_concurrent(2);
        let a = enq(&reg, "a", "s1");
        let b = enq(&reg, "b", "s1");
        let c = enq(&reg, "c", "s1");

        assert_eq!(reg.request_slot(&a), Admission::Run);
        assert_eq!(reg.request_slot(&b), Admission::Run);
        assert_eq!(reg.request_slot(&c), Admission::Queue);
        assert_eq!(a.state(), TransferState::Active);
        assert_eq!(c.state(), TransferState::Queued);
        assert_eq!(reg.active_count("s1"), 2);

        // 'a' finishes → 'c' is promoted to Active automatically.
        reg.release_slot(&a);
        assert_eq!(c.state(), TransferState::Active, "queued peer is promoted");
        assert_eq!(reg.active_count("s1"), 2);
    }

    #[test]
    fn sessions_have_independent_caps() {
        let reg = TransferRegistry::with_max_concurrent(1);
        let a = enq(&reg, "a", "s1");
        let b = enq(&reg, "b", "s2");
        // One per session runs immediately; separate sessions don't contend.
        assert_eq!(reg.request_slot(&a), Admission::Run);
        assert_eq!(reg.request_slot(&b), Admission::Run);
    }

    #[test]
    fn releasing_a_queued_transfer_frees_no_slot() {
        let reg = TransferRegistry::with_max_concurrent(1);
        let a = enq(&reg, "a", "s1");
        let b = enq(&reg, "b", "s1");
        reg.request_slot(&a); // Run
        reg.request_slot(&b); // Queue
                              // Cancelling 'b' while queued must not free 'a's slot.
        reg.release_slot(&b);
        assert_eq!(reg.active_count("s1"), 1);
    }

    #[test]
    fn pause_and_resume_set_flags() {
        let reg = TransferRegistry::new();
        let h = enq(&reg, "a", "s1");
        reg.request_slot(&h);
        assert!(reg.pause("a"));
        assert!(h.take_pause_request(), "pause request is observable");
        assert!(!h.take_pause_request(), "and consumed once");
        assert!(reg.resume("a"));
        assert!(h.take_resume_request());
        assert!(!h.take_resume_request());
    }

    #[test]
    fn cancel_rich_trips_token_and_wakes() {
        let reg = TransferRegistry::new();
        let h = enq(&reg, "a", "s1");
        reg.request_slot(&h);
        assert!(reg.cancel("a"));
        assert!(h.is_cancelled());
    }

    #[test]
    fn list_filters_by_session() {
        let reg = TransferRegistry::new();
        enq(&reg, "a", "s1");
        enq(&reg, "b", "s2");
        assert_eq!(reg.list(Some("s1")).len(), 1);
        assert_eq!(reg.list(Some("s2")).len(), 1);
        assert_eq!(reg.list(None).len(), 2);
    }

    #[test]
    fn drop_entry_releases_rich_slot_and_promotes() {
        let reg = TransferRegistry::with_max_concurrent(1);
        let a = enq(&reg, "a", "s1");
        let b = enq(&reg, "b", "s1");
        reg.request_slot(&a); // Run
        reg.request_slot(&b); // Queue
        reg.drop_entry("a"); // finished → promote b
        assert_eq!(b.state(), TransferState::Active);
        assert!(reg.get("a").is_none(), "dropped entry is gone");
    }

    #[test]
    fn enqueue_if_absent_registers_when_id_is_new() {
        let reg = TransferRegistry::new();
        let handle = reg
            .enqueue_if_absent(
                "r1",
                "s1",
                TransferDirection::Download,
                "r1",
                "/remote/r1",
                100,
            )
            .expect("a new id is enqueued");
        assert_eq!(handle.state(), TransferState::Queued);
        assert!(reg.get("r1").is_some(), "the handle is tracked");
    }

    #[test]
    fn enqueue_if_absent_is_none_for_an_already_tracked_id() {
        // The resume-relaunch race guard (#3199): a second concurrent relaunch of
        // the same id must NOT create a second handle/executor.
        let reg = TransferRegistry::new();
        let first = enq(&reg, "r1", "s1");
        assert!(
            reg.enqueue_if_absent(
                "r1",
                "s1",
                TransferDirection::Download,
                "r1",
                "/remote/r1",
                100,
            )
            .is_none(),
            "an id already registered (rich) is not re-enqueued"
        );
        // The original handle is untouched.
        assert_eq!(first.state(), TransferState::Queued);
    }

    #[test]
    fn pause_unknown_id_is_false() {
        let reg = TransferRegistry::new();
        assert!(!reg.pause("nope"));
        assert!(!reg.resume("nope"));
        assert!(!reg.retry("nope"));
    }

    // --- No terminal history (#4798) ---

    #[test]
    fn dropping_a_terminal_transfer_leaves_nothing_listed() {
        // The registry keeps no history of finished transfers: once its entry
        // is dropped, a completed, cancelled or failed transfer is gone. Its
        // final state lives in the transfers projection, not here.
        for event in [
            TransferEvent::Complete,
            TransferEvent::Cancel,
            TransferEvent::Fail {
                attempt: MAX_RETRIES,
            },
        ] {
            let reg = TransferRegistry::new();
            let h = enq(&reg, "r1", "sess-a");
            reg.request_slot(&h); // Active
            h.transition(event);
            reg.drop_entry("r1");

            assert!(reg.get("r1").is_none(), "the entry is dropped");
            assert!(
                reg.list(None).is_empty(),
                "no terminal snapshot is retained"
            );
            assert!(reg.list(Some("sess-a")).is_empty());
        }
    }

    #[test]
    fn a_live_rich_failed_handle_is_still_listed_as_failed() {
        // A rich (FTP) transfer that failed an attempt but may still auto-retry
        // (or awaits a manual retry) keeps its live entry and reports `failed`.
        for attempt in [1, MAX_RETRIES] {
            let reg = TransferRegistry::new();
            let h = enq(&reg, "r1", "sess-a");
            reg.request_slot(&h); // Queued → Active
            h.transition(TransferEvent::Fail { attempt }); // Active → Failed

            let list = reg.list(None);
            assert_eq!(list.len(), 1, "the live failed handle is still listed");
            assert_eq!(list[0].state, TransferStateTag::Failed);
        }
    }
}
