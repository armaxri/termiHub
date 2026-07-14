//! Transfer registry — Tauri state tracking every in-flight transfer (#1336).
//!
//! Two coexisting stores, so the richer queue model is added *without touching*
//! the backward-compatible SFTP path (#1245):
//!
//! - **legacy** — a `transfer_id → CancellationToken` map driving the existing
//!   SFTP `run_download`/`run_upload` copy loops. Its API (`register`,
//!   `cancel`, `cancel_all`, `drop_entry`) is unchanged.
//! - **rich** — a `transfer_id → `[`TransferHandle`]` map plus a per-session
//!   [`SessionScheduler`], implementing the queue/concurrency/pause/resume/retry
//!   model used by FTP transfers and the generic `transfer_*` commands.
//!
//! Cross-cutting operations (`cancel`, `cancel_all`) act on both stores so a
//! caller (or app-quit teardown) need not know which kind a transfer is.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::scheduler::{Admission, SessionScheduler, DEFAULT_MAX_CONCURRENT};
use super::state::{TransferEvent, TransferState, TransferStateTag};
use super::TransferDirection;

/// A point-in-time, serialisable view of one rich transfer, returned by
/// `transfer_list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
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
                tracing::warn!(transfer_id = %self.transfer_id, %e, "ignored illegal transition");
                c.state
            }
        }
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

    /// A point-in-time serialisable view of this transfer.
    pub fn snapshot(&self) -> TransferSnapshot {
        let c = self.lock();
        TransferSnapshot {
            transfer_id: self.transfer_id.clone(),
            session_id: self.session_id.clone(),
            direction: self.direction,
            file_name: self.file_name.clone(),
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
    /// Legacy SFTP transfers (#1245): id → cancellation token.
    legacy: HashMap<String, CancellationToken>,
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

    // --- Legacy SFTP API (#1245), unchanged semantics ---

    /// Register a fresh legacy transfer, returning its cancellation token.
    ///
    /// The returned token is checked by the SFTP copy loop at each chunk
    /// boundary.
    pub fn register(&self, transfer_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.lock()
            .legacy
            .insert(transfer_id.to_string(), token.clone());
        token
    }

    /// Cancel a transfer by id (legacy *or* rich). Unknown / already-finished
    /// ids are a no-op (returns `false`); a live transfer is cancelled
    /// (returns `true`).
    pub fn cancel(&self, transfer_id: &str) -> bool {
        let handle = {
            let state = self.lock();
            if let Some(token) = state.legacy.get(transfer_id) {
                token.cancel();
                return true;
            }
            state.rich.get(transfer_id).cloned()
        };
        match handle {
            Some(h) => {
                h.token.cancel();
                h.notify.notify_one();
                true
            }
            None => false,
        }
    }

    /// Cancel every in-flight transfer (legacy and rich). Used on app quit
    /// *before* sessions are closed, so no half-written file keeps a channel
    /// open during teardown. Returns the number of transfers signalled.
    pub fn cancel_all(&self) -> usize {
        let state = self.lock();
        for token in state.legacy.values() {
            token.cancel();
        }
        for handle in state.rich.values() {
            handle.token.cancel();
            handle.notify.notify_one();
        }
        state.legacy.len() + state.rich.len()
    }

    /// Drop a transfer's registry entry once its copy loop has finished
    /// (legacy or rich). For a rich transfer this also releases any slot it
    /// still holds so a queued peer can be promoted.
    pub fn drop_entry(&self, transfer_id: &str) {
        let mut state = self.lock();
        state.legacy.remove(transfer_id);
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
        total: u64,
    ) -> Arc<TransferHandle> {
        let handle = Arc::new(TransferHandle {
            transfer_id: transfer_id.to_string(),
            session_id: session_id.to_string(),
            direction,
            file_name: file_name.to_string(),
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
            }),
            notify: Notify::new(),
            max_attempts: super::state::MAX_RETRIES,
        });
        self.lock()
            .rich
            .insert(transfer_id.to_string(), handle.clone());
        handle
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

    /// Snapshot every rich transfer for `transfer_list` (optionally filtered by
    /// session).
    pub fn list(&self, session_id: Option<&str>) -> Vec<TransferSnapshot> {
        self.lock()
            .rich
            .values()
            .filter(|h| session_id.is_none_or(|s| h.session_id == s))
            .map(|h| h.snapshot())
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

    // --- Test/diagnostic helpers (legacy map) ---

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().legacy.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.lock().legacy.is_empty()
    }

    #[cfg(test)]
    pub fn contains(&self, transfer_id: &str) -> bool {
        self.lock().legacy.contains_key(transfer_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Legacy API (unchanged #1245 behaviour) ---

    #[test]
    fn register_adds_a_live_token() {
        let reg = TransferRegistry::new();
        let token = reg.register("t1");
        assert!(reg.contains("t1"));
        assert_eq!(reg.len(), 1);
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancel_trips_the_token_and_reports_true() {
        let reg = TransferRegistry::new();
        let token = reg.register("t1");
        assert!(reg.cancel("t1"), "cancelling a live transfer returns true");
        assert!(
            token.is_cancelled(),
            "the copy loop's token must be tripped"
        );
    }

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
        let a = reg.register("a");
        let b = reg.register("b");
        let c = reg.register("c");
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
    fn drop_entry_removes_the_transfer() {
        let reg = TransferRegistry::new();
        reg.register("t1");
        reg.drop_entry("t1");
        assert!(!reg.contains("t1"));
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn drop_entry_for_unknown_id_is_a_noop() {
        let reg = TransferRegistry::new();
        reg.register("t1");
        reg.drop_entry("other");
        assert!(reg.contains("t1"), "unrelated entry must survive");
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn cancel_after_drop_is_a_noop() {
        let reg = TransferRegistry::new();
        reg.register("t1");
        reg.drop_entry("t1");
        assert!(!reg.cancel("t1"));
    }

    // --- Rich queue model (#1336) ---

    fn enq(reg: &TransferRegistry, id: &str, session: &str) -> Arc<TransferHandle> {
        reg.enqueue(id, session, TransferDirection::Download, id, 100)
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
    fn pause_unknown_id_is_false() {
        let reg = TransferRegistry::new();
        assert!(!reg.pause("nope"));
        assert!(!reg.resume("nope"));
        assert!(!reg.retry("nope"));
    }
}
