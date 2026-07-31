//! The authoritative, shared transfer-queue state behind the shadow `transfers`
//! projection region (#2229, Phase 5 of #2139 / #2153).
//!
//! Models the Transfer Queue panel slice the frontend currently drives in
//! `appStore` (`transferQueue: Record<transferId, TransferEntry>` plus the
//! `transferQueueMinimized` flag): the per-transfer queue-row lifecycle
//! (`queued → active → completed | failed | cancelled`, plus `paused`), byte
//! progress, derived percent + throughput, error message and retry
//! attempt/max-attempt counters. The [`TransferEntry`] record and the
//! `entry_from_*` folds mirror the frontend `TransferEntry` and the
//! `transferEntryFrom{Seed,Progress,Snapshot}` helpers one-to-one
//! (`src/types/transfer.ts`), so the eventual render cut is a pure parity swap.
//!
//! # Scope — the queue *view*, not the transfer engine
//!
//! This store owns only the **queue-panel view**: which transfers the panel shows
//! and each row's derived render state. It deliberately does **not** model the
//! backend transfer engine — the `sftp_download` / `sftp_upload` byte-pump
//! (`src-tauri/src/files/transfer`) that produces the `transfer-progress` events —
//! nor the per-window ownership scoping of a transfer (#1951 / #1964), which is
//! frontend presentation. The store learns of a transfer only through the
//! `seed` / `progress` / `reconcile` folds the frontend already drives.
//!
//! # Shared — Open Design Decision #4 / #6
//!
//! A transfer runs backend-side; its progress/state is a property of the
//! transfer, not of a viewing client, so two clients watching the same queue see
//! the same row (like SSH tunnels, session-lifecycle and system-monitors). The
//! store therefore keeps a single map and projects one shared `transfers` region.
//!
//! # Shadow only (#2229)
//!
//! Managed authoritative state that serves the `transfer.*` intents, but nothing
//! in the live UI subscribes to or renders the region yet: `appStore` stays
//! authoritative. Later steps cut rendering, then the mutations, over to it,
//! keeping the `appStore` reducers as the parity-safe fallback.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Direction of a transfer, mirroring the frontend `TransferDirection`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Download,
    Upload,
}

/// The connection-type-agnostic state space of a queued transfer, mirroring the
/// frontend `TransferQueueState` (#1336).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferQueueState {
    Queued,
    Active,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl TransferQueueState {
    /// The terminal states — a transfer in one of these will not move on its own
    /// (mirrors `isTerminalTransferState` / `TERMINAL_TRANSFER_STATES`).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TransferQueueState::Completed
                | TransferQueueState::Failed
                | TransferQueueState::Cancelled
        )
    }
}

/// The legacy `transfer-progress` lifecycle phase (#1245), mapped to a
/// [`TransferQueueState`] for events that predate the #1336 `state` field.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferPhase {
    Transferring,
    Done,
    Cancelled,
    Error,
}

impl TransferPhase {
    /// Mirror of the frontend `stateFromPhase`.
    fn to_state(self) -> TransferQueueState {
        match self {
            TransferPhase::Transferring => TransferQueueState::Active,
            TransferPhase::Done => TransferQueueState::Completed,
            TransferPhase::Cancelled => TransferQueueState::Cancelled,
            TransferPhase::Error => TransferQueueState::Failed,
        }
    }
}

/// A single row in the Transfer Queue panel — the render-ready projection of the
/// frontend `TransferEntry` (#1337). The optional (`?`) frontend fields
/// (`path`/`error`/`attempt`/`maxAttempts`) skip serialization when absent and
/// the always-present `number | null` fields (`totalBytes`/`percent`/
/// `speedBytesPerSec`) serialize as `null`, so the view model matches the
/// frontend JSON exactly and the render cut stays a parity swap.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferEntry {
    /// Stable per-transfer id (the backend `transferId`).
    pub id: String,
    /// Owning SFTP/FTP session id (grouping / cancel-all).
    pub session_id: String,
    /// Upload or download.
    pub direction: TransferDirection,
    /// Display name (file name).
    pub name: String,
    /// Remote path, when the backend supplies one (#1531).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Derived lifecycle state.
    pub state: TransferQueueState,
    /// Bytes transferred so far.
    pub transferred: u64,
    /// Total bytes, or `null` when the size is unknown (indeterminate).
    pub total_bytes: Option<u64>,
    /// Completion percentage (0–100), or `null` when indeterminate.
    pub percent: Option<u32>,
    /// Instantaneous throughput in bytes/sec, or `null` when not moving/unknown.
    pub speed_bytes_per_sec: Option<u64>,
    /// Human-readable error, only populated for the `failed` state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Current retry attempt (#1336), when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    /// Maximum retry attempts (#1336), when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    /// Wall-clock ms of the last update (throughput-delta seed).
    pub updated_at: u64,
}

/// The minimal description of a transfer known at registration time, before any
/// `transfer-progress` event — mirrors the frontend `TransferSeed` (#1632).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferSeed {
    pub id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
}

/// Payload of a `transfer-progress` event, mirroring the frontend
/// `TransferProgress`. The #1336 rich fields (`state`/`speed`/`totalBytes`/
/// `attempt`/`maxAttempts`) are preferred when present; otherwise the legacy
/// #1245 fields (`phase`/`total`) drive the fold.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    #[serde(default)]
    pub path: Option<String>,
    pub transferred: u64,
    #[serde(default)]
    pub total: u64,
    pub phase: TransferPhase,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub state: Option<TransferQueueState>,
    #[serde(default)]
    pub speed: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
}

/// A snapshot of one queued transfer from `transfer_list`, mirroring the frontend
/// `TransferSnapshot` — the reconcile backstop (#1645 / #1657).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    #[serde(default)]
    pub path: Option<String>,
    pub state: TransferQueueState,
    /// Whether this is a genuinely settled outcome the reconcile may fold into a
    /// stuck row (#1657) — stricter than [`TransferQueueState::is_terminal`].
    pub settled: bool,
    pub transferred: u64,
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub speed: u64,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub max_attempts: u32,
}

/// Normalize a raw total (`0` = indeterminate) to `Some(total)` / `None`.
fn total_or_none(total: u64) -> Option<u64> {
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

/// Derive the render percent (mirror of the frontend `percent` derivation):
/// `100` when completed, else the clamped ratio when the total is known, else
/// `None`.
fn derive_percent(
    state: TransferQueueState,
    transferred: u64,
    total_bytes: Option<u64>,
) -> Option<u32> {
    if state == TransferQueueState::Completed {
        return Some(100);
    }
    match total_bytes {
        Some(total) if total > 0 => {
            let ratio = (transferred as f64 / total as f64) * 100.0;
            Some(ratio.round().clamp(0.0, 100.0) as u32)
        }
        _ => None,
    }
}

impl TransferEntry {
    /// Build a `queued` entry from a [`TransferSeed`] — the pre-event
    /// registration seed (mirror of `transferEntryFromSeed`). Progress/throughput
    /// are unknown until the first event folds over the row.
    fn from_seed(seed: &TransferSeed, now: u64) -> Self {
        Self {
            id: seed.id.clone(),
            session_id: seed.session_id.clone(),
            direction: seed.direction,
            name: seed.name.clone(),
            path: seed.path.clone(),
            state: TransferQueueState::Queued,
            transferred: 0,
            total_bytes: seed.total_bytes.filter(|&t| t > 0),
            percent: None,
            speed_bytes_per_sec: None,
            error: None,
            attempt: None,
            max_attempts: None,
            updated_at: now,
        }
    }

    /// Fold a `transfer-progress` event into an entry, deriving state, percent and
    /// throughput (mirror of `transferEntryFromProgress`). `prev` seeds the
    /// throughput delta and preserves fields the event omits.
    fn from_progress(progress: &TransferProgress, prev: Option<&TransferEntry>, now: u64) -> Self {
        let state = progress.state.unwrap_or_else(|| progress.phase.to_state());
        let total_bytes = total_or_none(progress.total_bytes.unwrap_or(progress.total));
        let percent = derive_percent(state, progress.transferred, total_bytes);
        let speed_bytes_per_sec = Self::derive_speed(progress, prev, now, state);

        Self {
            id: progress.transfer_id.clone(),
            session_id: progress.session_id.clone(),
            direction: progress.direction,
            name: progress.file_name.clone(),
            path: progress
                .path
                .clone()
                .or_else(|| prev.and_then(|p| p.path.clone())),
            state,
            transferred: progress.transferred,
            total_bytes,
            percent,
            speed_bytes_per_sec,
            error: if state == TransferQueueState::Failed {
                Some(
                    progress
                        .message
                        .clone()
                        .unwrap_or_else(|| "Transfer failed".to_string()),
                )
            } else {
                None
            },
            attempt: progress.attempt.or_else(|| prev.and_then(|p| p.attempt)),
            max_attempts: progress
                .max_attempts
                .or_else(|| prev.and_then(|p| p.max_attempts)),
            updated_at: now,
        }
    }

    /// Throughput derivation for a progress fold: backend-measured speed when
    /// supplied, else the byte/time delta against an `active` `prev`, else `None`
    /// (mirror of the frontend `speedBytesPerSec` branch).
    fn derive_speed(
        progress: &TransferProgress,
        prev: Option<&TransferEntry>,
        now: u64,
        state: TransferQueueState,
    ) -> Option<u64> {
        if state != TransferQueueState::Active {
            return None;
        }
        if let Some(speed) = progress.speed {
            if speed > 0 {
                return Some(speed);
            }
        }
        let prev = prev?;
        if prev.state != TransferQueueState::Active {
            return None;
        }
        let delta_bytes = progress.transferred as i64 - prev.transferred as i64;
        let delta_ms = now as i64 - prev.updated_at as i64;
        if delta_bytes >= 0 && delta_ms > 0 {
            Some(((delta_bytes as f64 / delta_ms as f64) * 1000.0).round() as u64)
        } else {
            prev.speed_bytes_per_sec
        }
    }

    /// Fold a `transfer_list` snapshot into an entry, settling a stuck row to its
    /// true terminal state (mirror of `transferEntryFromSnapshot`). `prev` is the
    /// row being settled; its path / retry counters / error are preserved where
    /// the snapshot does not supply them.
    fn from_snapshot(snapshot: &TransferSnapshot, prev: Option<&TransferEntry>, now: u64) -> Self {
        let total_bytes =
            total_or_none(snapshot.total).or_else(|| prev.and_then(|p| p.total_bytes));
        let state = snapshot.state;
        let percent = derive_percent(state, snapshot.transferred, total_bytes);

        Self {
            id: snapshot.transfer_id.clone(),
            session_id: snapshot.session_id.clone(),
            direction: snapshot.direction,
            name: snapshot.file_name.clone(),
            path: snapshot
                .path
                .clone()
                .or_else(|| prev.and_then(|p| p.path.clone())),
            state,
            transferred: snapshot.transferred,
            total_bytes,
            percent,
            speed_bytes_per_sec: if snapshot.speed > 0 {
                Some(snapshot.speed)
            } else {
                None
            },
            error: if state == TransferQueueState::Failed {
                Some(
                    prev.and_then(|p| p.error.clone())
                        .unwrap_or_else(|| "Transfer failed".to_string()),
                )
            } else {
                None
            },
            attempt: (snapshot.attempt != 0)
                .then_some(snapshot.attempt)
                .or_else(|| prev.and_then(|p| p.attempt)),
            max_attempts: (snapshot.max_attempts != 0)
                .then_some(snapshot.max_attempts)
                .or_else(|| prev.and_then(|p| p.max_attempts)),
            updated_at: now,
        }
    }
}

/// The private mutable core: the per-transfer queue map plus the panel-minimized
/// flag. One mutex guards it so intents never interleave — the substrate's
/// single-writer contract also holds within the store.
#[derive(Default)]
struct Inner {
    queue: HashMap<String, TransferEntry>,
    minimized: bool,
}

/// The shadow transfer-queue authority. Owns one [`TransferEntry`] per transfer,
/// keyed by `transferId`, plus the panel-minimized flag. The single shared
/// `transfers` region projects this state.
#[derive(Default)]
pub struct TransferStore {
    inner: Mutex<Inner>,
}

impl TransferStore {
    /// A store with an empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// The render-ready view model for the whole region:
    /// `{ "queue": { "<id>": TransferEntry, ... }, "minimized": bool }`.
    ///
    /// Pure with respect to queue state (never mutates), so the projector can
    /// safely diff two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        let inner = self.lock();
        let mut queue = Map::with_capacity(inner.queue.len());
        for (id, entry) in &inner.queue {
            if let Ok(value) = serde_json::to_value(entry) {
                queue.insert(id.clone(), value);
            }
        }
        json!({ "queue": Value::Object(queue), "minimized": inner.minimized })
    }

    /// `transfer.seed` — enqueue a `queued` row from a registration snapshot
    /// (#1632). Idempotent: never overwrites a row an event already advanced
    /// (mirrors `seedTransferQueue`). The window-ownership `releasedTransferSessions`
    /// bookkeeping is frontend presentation and out of scope here.
    pub fn seed(&self, seed: &TransferSeed, now: u64) {
        let mut inner = self.lock();
        if inner.queue.contains_key(&seed.id) {
            return;
        }
        inner
            .queue
            .insert(seed.id.clone(), TransferEntry::from_seed(seed, now));
    }

    /// `transfer.progress` — fold a `transfer-progress` event into the queue,
    /// upserting the row and retaining terminal rows (mirrors
    /// `applyTransferProgressToQueue`). The window-ownership scoping (#1951 /
    /// #1964) is frontend presentation and out of scope.
    pub fn progress(&self, progress: &TransferProgress, now: u64) {
        let mut inner = self.lock();
        let prev = inner.queue.get(&progress.transfer_id).cloned();
        let entry = TransferEntry::from_progress(progress, prev.as_ref(), now);
        inner.queue.insert(entry.id.clone(), entry);
    }

    /// `transfer.reconcile` — settle stuck non-terminal rows against a
    /// `transfer_list` snapshot (mirrors `reconcileTransferQueue`). Only a
    /// genuinely settled terminal snapshot for an existing, still-live row folds;
    /// events own live progress, so this never regresses an event-advanced row.
    pub fn reconcile(&self, snapshots: &[TransferSnapshot], now: u64) {
        let mut inner = self.lock();
        for snap in snapshots {
            if !snap.settled || !snap.state.is_terminal() {
                continue;
            }
            let Some(prev) = inner.queue.get(&snap.transfer_id) else {
                continue;
            };
            if prev.state.is_terminal() {
                continue;
            }
            let settled = TransferEntry::from_snapshot(snap, Some(prev), now);
            inner.queue.insert(snap.transfer_id.clone(), settled);
        }
    }

    /// `transfer.remove` — drop one queue row (mirrors `removeTransfer`).
    /// Idempotent.
    pub fn remove(&self, id: &str) {
        self.lock().queue.remove(id);
    }

    /// `transfer.clearCompleted` — drop every `completed` row, retaining
    /// failed/cancelled ones (mirrors `clearCompleted`).
    pub fn clear_completed(&self) {
        self.lock()
            .queue
            .retain(|_, e| e.state != TransferQueueState::Completed);
    }

    /// `transfer.setMinimized` — collapse/expand the panel to its status-bar
    /// indicator (mirrors `setTransferQueueMinimized`).
    pub fn set_minimized(&self, minimized: bool) {
        self.lock().minimized = minimized;
    }

    /// `transfer.replace` — overwrite the whole queue map and minimized flag with
    /// a caller-supplied snapshot. Used by the frontend render-cut mirror (#2229)
    /// to keep the shared region a faithful copy of `appStore`'s transfer-queue
    /// slice while `appStore` remains authoritative (the mutation cut is a later
    /// step) — the analog of the system-monitor bridge's `monitor.replace` seed.
    /// Idempotent server-side: replacing with identical content yields no diff.
    pub fn replace(&self, queue: HashMap<String, TransferEntry>, minimized: bool) {
        let mut inner = self.lock();
        inner.queue = queue;
        inner.minimized = minimized;
    }

    /// Read one queue row (test / diagnostics helper).
    #[cfg(test)]
    pub fn get(&self, id: &str) -> Option<TransferEntry> {
        self.lock().queue.get(id).cloned()
    }

    /// Read the number of queue rows (test / diagnostics helper).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().queue.len()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
