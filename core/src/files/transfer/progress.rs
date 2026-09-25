//! Backend-agnostic transfer progress model (issues #1245, #1336; audit finding
//! DUP-026).
//!
//! These are the pure value types every transfer executor produces and every
//! consumer (the desktop's Tauri event/persistence/projection glue, and the
//! remote agent) folds: the direction/phase/state of a transfer, the
//! `transfer-progress` payload, the injected [`ProgressSink`] callback, and the
//! two tuning constants shared by the SFTP and FTP copy loops. They carry no
//! I/O and no dependency on the desktop app (Tauri, `AppHandle`, event
//! emission, on-disk persistence) — the side-effecting sink is injected by the
//! caller.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::registry::TransferSnapshot;
use super::state::TransferStateTag;

/// Chunk size for the copy loop. Sourced from the single canonical
/// [`crate::files::copy::CHUNK_SIZE`] so the SFTP and FTP transfer paths share
/// one 256 KiB tuning value (audit finding DUP-025) rather than each declaring
/// their own.
pub const CHUNK_SIZE: usize = crate::files::copy::CHUNK_SIZE;

/// Minimum interval between two `transfer-progress` emits, to avoid flooding
/// the event bus (~10 Hz).
pub const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

/// Set while the app-quit teardown's cancel-all sweep is running (PROD-0011).
///
/// [`crate::files::transfer::TransferRegistry::cancel_all`] flips this on entry
/// so the persistence layer can tell a *teardown-induced* cancellation (which
/// must leave in-flight records intact, to rehydrate as paused next launch) from
/// a *genuine user cancel* (which prunes the record). It is only ever set — the
/// process is exiting.
pub static QUEUE_TEARDOWN: AtomicBool = AtomicBool::new(false);

/// Whether the app-quit teardown cancel-all sweep has begun.
pub fn is_queue_teardown() -> bool {
    QUEUE_TEARDOWN.load(Ordering::SeqCst)
}

/// Direction of a transfer, driving the icon / verb in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Download,
    Upload,
}

/// Lifecycle phase of a transfer (legacy, #1245). `Transferring` is
/// intermediate; the other three are terminal and clear the UI row.
///
/// Retained for backward compatibility with the existing SFTP progress
/// consumers. The richer [`TransferStateTag`] (`state` field) is emitted
/// alongside it; both describe the same event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferPhase {
    Transferring,
    Done,
    Cancelled,
    Error,
}

impl TransferPhase {
    /// The equivalent rich state tag for this legacy phase, so the SFTP path
    /// populates the new `state` field consistently with the FTP path.
    pub fn state_tag(self) -> TransferStateTag {
        match self {
            TransferPhase::Transferring => TransferStateTag::Active,
            TransferPhase::Done => TransferStateTag::Completed,
            TransferPhase::Cancelled => TransferStateTag::Cancelled,
            TransferPhase::Error => TransferStateTag::Failed,
        }
    }
}

/// A single `transfer-progress` event payload.
///
/// **Backward compatibility (#1336):** the original #1245 fields (`phase`,
/// `total`, `transferred`, `message`, …) are unchanged, so existing SFTP
/// consumers keep working untouched. The queue model adds *additive* fields —
/// `state`, `speed`, `totalBytes`, `etaSecs`, `attempt`, `maxAttempts` — which
/// older consumers simply ignore.
///
/// `total == 0` means indeterminate (stat unavailable); the UI shows a spinner.
/// `message` is only populated for a failed/error update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    /// Remote path of the transferred file (e.g. `/uploads/data.csv`), so the
    /// Transfer Queue row can show it alongside the file name (#1531). Omitted
    /// from the payload when empty.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    pub transferred: u64,
    pub total: u64,
    /// Legacy phase (#1245) — kept for backward compatibility.
    pub phase: TransferPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    // --- Queue-model additive fields (#1336) ---
    /// Rich queue state (`queued/active/paused/completed/failed/cancelled`).
    pub state: TransferStateTag,
    /// Current throughput in bytes/sec (`0` = unknown / not yet measured).
    pub speed: u64,
    /// Total size in bytes (mirror of `total`; `0` = indeterminate).
    pub total_bytes: u64,
    /// Estimated seconds remaining, when a speed is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_secs: Option<u64>,
    /// Retry attempt number (0 when not in a retry cycle).
    pub attempt: u32,
    /// Maximum retry attempts before permanent failure.
    pub max_attempts: u32,
}

impl TransferProgress {
    /// Build a payload from a rich [`TransferSnapshot`] (the FTP queue path),
    /// pairing the precise `state` with a backward-compatible legacy `phase`.
    pub fn from_snapshot(
        snap: &TransferSnapshot,
        phase: TransferPhase,
        eta_secs: Option<u64>,
        message: Option<String>,
    ) -> Self {
        TransferProgress {
            transfer_id: snap.transfer_id.clone(),
            session_id: snap.session_id.clone(),
            direction: snap.direction,
            file_name: snap.file_name.clone(),
            path: snap.path.clone(),
            transferred: snap.transferred,
            total: snap.total,
            phase,
            message,
            state: snap.state,
            speed: snap.speed,
            total_bytes: snap.total,
            eta_secs,
            attempt: snap.attempt,
            max_attempts: snap.max_attempts,
        }
    }
}

/// A sink for `transfer-progress` updates. Decouples the copy loop from the
/// desktop's Tauri event bus so it can be driven by a real `AppHandle` in
/// production and by a plain collector in integration tests.
pub type ProgressSink = Arc<dyn Fn(&TransferProgress) + Send + Sync>;
