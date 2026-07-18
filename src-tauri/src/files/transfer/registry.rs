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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::scheduler::{Admission, SessionScheduler, DEFAULT_MAX_CONCURRENT};
use super::state::{TransferEvent, TransferState, TransferStateTag, MAX_RETRIES};
use super::TransferDirection;

/// How long a recently-terminal transfer is retained in the registry so a
/// frontend reconcile can still observe its final state after its live entry is
/// gone (#1645).
///
/// The frontend polls `transfer_list` on a few-second tick while it holds any
/// non-terminal row, so a window an order of magnitude larger than that tick
/// comfortably catches a transfer whose terminal `transfer-progress` event was
/// dropped, without holding completed transfers indefinitely.
const TERMINAL_RETENTION: Duration = Duration::from_secs(60);

/// Hard cap on the number of retained terminal transfers, so a burst of
/// completions cannot grow the history without bound between TTL sweeps. Each
/// retained entry is a small [`TransferSnapshot`]; 64 bounds the memory while
/// still covering a realistic backlog.
const TERMINAL_RETENTION_MAX: usize = 64;

/// A point-in-time, serialisable view of one rich transfer, returned by
/// `transfer_list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    /// Remote path of the transferred file (#1531), for the Transfer Queue row.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    pub state: TransferStateTag,
    /// Whether this snapshot is a *genuinely* settled outcome the frontend
    /// reconcile may fold into a stuck row (#1657).
    ///
    /// This is stricter than [`TransferStateTag::is_terminal`]. A **live** rich
    /// (FTP) handle in a `failed` state is not settled: it may still auto-retry
    /// after backoff, or sit awaiting a manual retry — so it reports
    /// `state: failed` with `settled: false`. Only [`TransferState::is_terminal`]
    /// states from a live handle (`completed`/`cancelled`) and
    /// [retained-terminal](Self) snapshots (a completed/cancelled rich transfer,
    /// or a genuinely-final legacy SFTP transfer) are `settled`. This stops a
    /// transient mid-retry failure from being reconciled into a terminal
    /// `failed` row (which the reconcile guard would then never re-settle).
    pub settled: bool,
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
            path: self.path.clone(),
            state: c.state.tag(),
            // A live rich handle is settled only when genuinely terminal
            // (completed/cancelled). A live `failed` handle may still auto-retry
            // or await a manual retry, so it is *not* settled (#1657).
            settled: c.state.is_terminal(),
            transferred: c.transferred,
            total: c.total,
            speed: c.speed,
            attempt: c.attempt,
            max_attempts: self.max_attempts,
        }
    }
}

/// A live legacy (SFTP) transfer: its cancellation token plus the minimal
/// identity needed to surface it in `transfer_list` (#1645).
///
/// The legacy SFTP copy path reports live progress only via best-effort
/// `transfer-progress` events (it does not update the registry mid-flight), so
/// the registry holds just the transfer's identity and total. That is enough
/// for a reconcile: a listed legacy transfer shows as `active` while live, and
/// [`TransferRegistry::finish_legacy`] records its true terminal state when the
/// copy loop ends.
#[derive(Debug)]
struct LegacyEntry {
    token: CancellationToken,
    session_id: String,
    direction: TransferDirection,
    file_name: String,
    path: String,
    total: u64,
}

impl LegacyEntry {
    /// A live (`active`) snapshot of this legacy transfer. `transferred` is not
    /// tracked in the registry for the legacy path, so it reports `0`; the
    /// reconcile only ever *settles* a stuck row to a terminal state and never
    /// moves a live row backward, so this cannot regress an event-advanced row.
    fn snapshot(&self, transfer_id: &str) -> TransferSnapshot {
        TransferSnapshot {
            transfer_id: transfer_id.to_string(),
            session_id: self.session_id.clone(),
            direction: self.direction,
            file_name: self.file_name.clone(),
            path: self.path.clone(),
            state: TransferStateTag::Active,
            // A live legacy transfer is always in-flight, never settled (#1657).
            settled: false,
            transferred: 0,
            total: self.total,
            speed: 0,
            attempt: 0,
            max_attempts: MAX_RETRIES,
        }
    }
}

/// A recently-terminal transfer retained for a bounded window so a reconcile
/// can still observe its final state after its live entry is dropped (#1645).
#[derive(Debug)]
struct RetainedTerminal {
    snapshot: TransferSnapshot,
    at: Instant,
}

/// Inner, lock-guarded registry state.
#[derive(Default)]
struct RegistryState {
    /// Legacy SFTP transfers (#1245): id → live entry (token + identity, #1645).
    legacy: HashMap<String, LegacyEntry>,
    /// Rich queued transfers (#1336): id → handle.
    rich: HashMap<String, Arc<TransferHandle>>,
    /// Per-session slot accounting for the rich model.
    schedulers: HashMap<String, SessionScheduler>,
    /// Recently-terminal transfers, retained briefly so a reconcile can settle a
    /// stuck row whose terminal event was dropped (#1645). Ordered oldest-first
    /// (push_back), bounded by [`TERMINAL_RETENTION`] and [`TERMINAL_RETENTION_MAX`].
    terminal: VecDeque<RetainedTerminal>,
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

    /// Register a fresh legacy (SFTP) transfer, returning its cancellation
    /// token.
    ///
    /// The returned token is checked by the SFTP copy loop at each chunk
    /// boundary. The identity (`session_id`, `direction`, `file_name`, `path`,
    /// `total`) is retained so the transfer appears in `transfer_list` and can
    /// be settled to its terminal state by a reconcile (#1645).
    pub fn register(
        &self,
        transfer_id: &str,
        session_id: &str,
        direction: TransferDirection,
        file_name: &str,
        path: &str,
        total: u64,
    ) -> CancellationToken {
        let token = CancellationToken::new();
        self.lock().legacy.insert(
            transfer_id.to_string(),
            LegacyEntry {
                token: token.clone(),
                session_id: session_id.to_string(),
                direction,
                file_name: file_name.to_string(),
                path: path.to_string(),
                total,
            },
        );
        token
    }

    /// Cancel a transfer by id (legacy *or* rich). Unknown / already-finished
    /// ids are a no-op (returns `false`); a live transfer is cancelled
    /// (returns `true`).
    pub fn cancel(&self, transfer_id: &str) -> bool {
        let handle = {
            let state = self.lock();
            if let Some(entry) = state.legacy.get(transfer_id) {
                entry.token.cancel();
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
        for entry in state.legacy.values() {
            entry.token.cancel();
        }
        for handle in state.rich.values() {
            handle.token.cancel();
            handle.notify.notify_one();
        }
        state.legacy.len() + state.rich.len()
    }

    /// Drop a transfer's registry entry once its copy loop has finished
    /// (legacy or rich). For a rich transfer this also releases any slot it
    /// still holds so a queued peer can be promoted, and — when the transfer
    /// reached a terminal state — retains a snapshot briefly so a reconcile can
    /// still settle a stuck row whose terminal event was dropped (#1645).
    ///
    /// The legacy SFTP path records its terminal state via [`Self::finish_legacy`]
    /// instead (it knows the final phase and byte count); a bare `drop_entry`
    /// for a legacy id therefore just removes the live entry.
    pub fn drop_entry(&self, transfer_id: &str) {
        let mut state = self.lock();
        state.legacy.remove(transfer_id);
        if let Some(handle) = state.rich.remove(transfer_id) {
            let snapshot = handle.snapshot();
            Self::release_slot_locked(&mut state, &handle);
            if snapshot.state.is_terminal() {
                Self::record_terminal_locked(&mut state, snapshot);
            }
        }
    }

    /// Record a legacy (SFTP) transfer's terminal outcome and remove its live
    /// entry (#1645). Called by the SFTP copy path when the transfer settles, so
    /// the transfer stays snapshot-able for the retention window even if its
    /// terminal `transfer-progress` event was dropped. A no-op for an id with no
    /// live legacy entry (e.g. already dropped).
    pub fn finish_legacy(&self, transfer_id: &str, state_tag: TransferStateTag, transferred: u64) {
        let mut state = self.lock();
        if let Some(entry) = state.legacy.remove(transfer_id) {
            let mut snapshot = entry.snapshot(transfer_id);
            snapshot.state = state_tag;
            snapshot.transferred = transferred;
            if state_tag.is_terminal() {
                Self::record_terminal_locked(&mut state, snapshot);
            }
        }
    }

    /// Push a terminal snapshot into the retention history, then evict anything
    /// past the capacity or TTL bound. Callers hold the state lock.
    fn record_terminal_locked(state: &mut RegistryState, mut snapshot: TransferSnapshot) {
        // A retained terminal is, by definition, a genuinely-final outcome the
        // reconcile may settle a stuck row to — including a legacy SFTP failure
        // (which, unlike a live rich `failed` handle, never retries) (#1657).
        snapshot.settled = true;
        let now = Instant::now();
        state
            .terminal
            .push_back(RetainedTerminal { snapshot, at: now });
        Self::evict_terminal_locked(state, now);
    }

    /// Drop retained terminal entries beyond the capacity cap (oldest first) or
    /// older than the TTL. The deque is oldest-first, so both bounds evict from
    /// the front.
    fn evict_terminal_locked(state: &mut RegistryState, now: Instant) {
        while state.terminal.len() > TERMINAL_RETENTION_MAX {
            state.terminal.pop_front();
        }
        while let Some(front) = state.terminal.front() {
            if now.duration_since(front.at) > TERMINAL_RETENTION {
                state.terminal.pop_front();
            } else {
                break;
            }
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

    /// Snapshot every transfer for `transfer_list` (optionally filtered by
    /// session): live rich transfers, live legacy SFTP transfers (#1645), and
    /// recently-terminal transfers retained for the reconcile window (#1645).
    ///
    /// A live entry always shadows a retained snapshot for the same id, so an id
    /// that (impossibly, given UUIDs) reappeared live would never be reported as
    /// both live and terminal.
    pub fn list(&self, session_id: Option<&str>) -> Vec<TransferSnapshot> {
        let mut state = self.lock();
        Self::evict_terminal_locked(&mut state, Instant::now());

        let matches = |s: &str| session_id.is_none_or(|f| s == f);
        let mut live_ids: HashSet<String> = HashSet::new();
        let mut out = Vec::new();

        for handle in state.rich.values() {
            if matches(&handle.session_id) {
                let snap = handle.snapshot();
                live_ids.insert(snap.transfer_id.clone());
                out.push(snap);
            }
        }
        for (id, entry) in &state.legacy {
            if matches(&entry.session_id) {
                live_ids.insert(id.clone());
                out.push(entry.snapshot(id));
            }
        }
        for retained in &state.terminal {
            if matches(&retained.snapshot.session_id)
                && !live_ids.contains(&retained.snapshot.transfer_id)
            {
                out.push(retained.snapshot.clone());
            }
        }
        out
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

    /// Number of retained terminal snapshots (#1645 tests).
    #[cfg(test)]
    fn retained_len(&self) -> usize {
        self.lock().terminal.len()
    }

    /// Force a TTL eviction pass as if the clock were `now` (#1645 tests). Using
    /// a future `now` avoids backdating an `Instant` into the past (which can
    /// underflow on a freshly-booted monotonic clock).
    #[cfg(test)]
    fn evict_at(&self, now: Instant) {
        let mut state = self.lock();
        Self::evict_terminal_locked(&mut state, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Legacy API (unchanged #1245 behaviour) ---

    /// Register a legacy transfer with placeholder identity, for tests that only
    /// exercise the token/cancel/drop semantics.
    fn reg_legacy(reg: &TransferRegistry, id: &str) -> CancellationToken {
        reg.register(
            id,
            "sess",
            TransferDirection::Download,
            id,
            &format!("/remote/{id}"),
            100,
        )
    }

    #[test]
    fn register_adds_a_live_token() {
        let reg = TransferRegistry::new();
        let token = reg_legacy(&reg, "t1");
        assert!(reg.contains("t1"));
        assert_eq!(reg.len(), 1);
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancel_trips_the_token_and_reports_true() {
        let reg = TransferRegistry::new();
        let token = reg_legacy(&reg, "t1");
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
        let a = reg_legacy(&reg, "a");
        let b = reg_legacy(&reg, "b");
        let c = reg_legacy(&reg, "c");
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
        reg_legacy(&reg, "t1");
        reg.drop_entry("t1");
        assert!(!reg.contains("t1"));
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn drop_entry_for_unknown_id_is_a_noop() {
        let reg = TransferRegistry::new();
        reg_legacy(&reg, "t1");
        reg.drop_entry("other");
        assert!(reg.contains("t1"), "unrelated entry must survive");
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn cancel_after_drop_is_a_noop() {
        let reg = TransferRegistry::new();
        reg_legacy(&reg, "t1");
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
    fn pause_unknown_id_is_false() {
        let reg = TransferRegistry::new();
        assert!(!reg.pause("nope"));
        assert!(!reg.resume("nope"));
        assert!(!reg.retry("nope"));
    }

    // --- Legacy SFTP in transfer_list + terminal retention (#1645) ---

    #[test]
    fn legacy_transfer_is_listed_as_active_while_live() {
        // Before #1645 an SFTP transfer registered only in the legacy token map
        // and never appeared in `transfer_list`. It must now show up as active,
        // carrying its identity, so a reconcile has a snapshot to match.
        let reg = TransferRegistry::new();
        reg.register(
            "s1",
            "sess-a",
            TransferDirection::Upload,
            "file.txt",
            "/remote/file.txt",
            2048,
        );

        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].transfer_id, "s1");
        assert_eq!(list[0].session_id, "sess-a");
        assert_eq!(list[0].direction, TransferDirection::Upload);
        assert_eq!(list[0].file_name, "file.txt");
        assert_eq!(list[0].path, "/remote/file.txt");
        assert_eq!(list[0].state, TransferStateTag::Active);
        assert_eq!(list[0].total, 2048);
    }

    #[test]
    fn finish_legacy_retains_a_terminal_snapshot_after_the_live_entry_is_gone() {
        // The crux of #1645: an SFTP transfer whose terminal event was dropped
        // is still observable as *completed* for the retention window, so the
        // reconcile can settle the stuck row.
        let reg = TransferRegistry::new();
        reg.register(
            "s1",
            "sess-a",
            TransferDirection::Download,
            "file.txt",
            "/remote/file.txt",
            100,
        );
        reg.finish_legacy("s1", TransferStateTag::Completed, 100);

        assert!(!reg.contains("s1"), "the live legacy entry is removed");
        let list = reg.list(None);
        assert_eq!(list.len(), 1, "the terminal snapshot is retained");
        assert_eq!(list[0].transfer_id, "s1");
        assert_eq!(list[0].state, TransferStateTag::Completed);
        assert_eq!(list[0].transferred, 100);
        assert_eq!(list[0].file_name, "file.txt");
    }

    #[test]
    fn finish_legacy_records_a_cancelled_terminal_state() {
        let reg = TransferRegistry::new();
        reg.register(
            "s1",
            "sess-a",
            TransferDirection::Download,
            "f",
            "/remote/f",
            100,
        );
        reg.finish_legacy("s1", TransferStateTag::Cancelled, 42);
        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, TransferStateTag::Cancelled);
        assert_eq!(list[0].transferred, 42);
    }

    #[test]
    fn finish_legacy_for_an_unknown_id_is_a_noop() {
        let reg = TransferRegistry::new();
        reg.finish_legacy("nope", TransferStateTag::Completed, 0);
        assert_eq!(reg.list(None).len(), 0);
        assert_eq!(reg.retained_len(), 0);
    }

    #[test]
    fn dropping_a_completed_rich_transfer_retains_its_terminal_snapshot() {
        let reg = TransferRegistry::new();
        let h = enq(&reg, "r1", "sess-a");
        reg.request_slot(&h); // Active
        h.transition(TransferEvent::Complete); // Active → Completed
        reg.drop_entry("r1");

        assert!(reg.get("r1").is_none(), "the live rich entry is dropped");
        let list = reg.list(None);
        assert_eq!(list.len(), 1, "the completed transfer is retained");
        assert_eq!(list[0].transfer_id, "r1");
        assert_eq!(list[0].state, TransferStateTag::Completed);
        assert!(list[0].settled, "a retained completed transfer is settled");
    }

    // --- Genuinely-settled vs transient rich `failed` (#1657) ---

    #[test]
    fn a_live_rich_failed_handle_is_listed_failed_but_not_settled() {
        // A rich (FTP) transfer that failed an attempt but may still auto-retry
        // (retryable) — or has exhausted retries and sits awaiting a manual
        // retry (non-retryable) — is a *live* handle. It must surface its
        // `failed` state for display, but must NOT be `settled`, so a reconcile
        // never folds a still-recoverable transfer into a terminal `failed` row
        // (#1657).
        for attempt in [1, MAX_RETRIES] {
            let reg = TransferRegistry::new();
            let h = enq(&reg, "r1", "sess-a");
            reg.request_slot(&h); // Queued → Active
            h.transition(TransferEvent::Fail { attempt }); // Active → Failed
            assert!(
                matches!(h.state(), TransferState::Failed { .. }),
                "the handle is in a failed state"
            );

            let list = reg.list(None);
            assert_eq!(list.len(), 1, "the live failed handle is still listed");
            assert_eq!(list[0].state, TransferStateTag::Failed);
            assert!(
                !list[0].settled,
                "a live rich `failed` handle (attempt {attempt}) is not settled — it may still retry"
            );
        }
    }

    #[test]
    fn a_retained_legacy_failure_is_settled() {
        // Unlike a live rich `failed` handle, a legacy SFTP transfer that failed
        // is genuinely final (it does not retry through the registry), so its
        // retained snapshot is settled and a reconcile may fold it in (#1657).
        let reg = TransferRegistry::new();
        reg.register("s1", "sess-a", TransferDirection::Download, "f", "/f", 100);
        reg.finish_legacy("s1", TransferStateTag::Failed, 30);

        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, TransferStateTag::Failed);
        assert!(
            list[0].settled,
            "a retained legacy failure is genuinely settled"
        );
    }

    #[test]
    fn a_live_active_rich_handle_is_not_settled() {
        let reg = TransferRegistry::new();
        let h = enq(&reg, "r1", "sess-a");
        reg.request_slot(&h); // Active
        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, TransferStateTag::Active);
        assert!(!list[0].settled, "a live active transfer is not settled");
    }

    #[test]
    fn a_live_entry_shadows_a_retained_snapshot_for_the_same_id() {
        // Retain a terminal snapshot, then register a *live* transfer reusing the
        // id: the live entry must win (no duplicate, no stale terminal row).
        let reg = TransferRegistry::new();
        reg.register("s1", "sess-a", TransferDirection::Download, "f", "/f", 100);
        reg.finish_legacy("s1", TransferStateTag::Completed, 100);
        assert_eq!(reg.retained_len(), 1);

        reg.register("s1", "sess-a", TransferDirection::Download, "f", "/f", 100);
        let list = reg.list(None);
        assert_eq!(list.len(), 1, "no duplicate for the reused id");
        assert_eq!(
            list[0].state,
            TransferStateTag::Active,
            "the live entry shadows the retained terminal snapshot"
        );
    }

    #[test]
    fn retained_terminals_are_evicted_past_the_capacity_cap() {
        let reg = TransferRegistry::new();
        for i in 0..(TERMINAL_RETENTION_MAX + 10) {
            let id = format!("s{i}");
            reg.register(&id, "sess-a", TransferDirection::Download, "f", "/f", 1);
            reg.finish_legacy(&id, TransferStateTag::Completed, 1);
        }
        assert_eq!(
            reg.retained_len(),
            TERMINAL_RETENTION_MAX,
            "history is bounded by the capacity cap"
        );
    }

    #[test]
    fn retained_terminals_are_evicted_after_the_ttl() {
        let reg = TransferRegistry::new();
        reg.register("s1", "sess-a", TransferDirection::Download, "f", "/f", 1);
        reg.finish_legacy("s1", TransferStateTag::Completed, 1);
        assert_eq!(reg.retained_len(), 1);

        // As if the clock advanced well past the retention window.
        reg.evict_at(Instant::now() + TERMINAL_RETENTION + Duration::from_secs(5));
        assert_eq!(reg.retained_len(), 0, "expired terminals are dropped");
        assert_eq!(reg.list(None).len(), 0);
    }

    #[test]
    fn retained_terminals_respect_the_session_filter() {
        let reg = TransferRegistry::new();
        reg.register("s1", "sess-a", TransferDirection::Download, "f", "/f", 1);
        reg.finish_legacy("s1", TransferStateTag::Completed, 1);
        reg.register("s2", "sess-b", TransferDirection::Download, "f", "/f", 1);
        reg.finish_legacy("s2", TransferStateTag::Completed, 1);

        assert_eq!(reg.list(Some("sess-a")).len(), 1);
        assert_eq!(reg.list(Some("sess-b")).len(), 1);
        assert_eq!(reg.list(None).len(), 2);
    }
}
