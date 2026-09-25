//! Cancellable, queued file-transfer subsystem (issues #1245, #1336).
//!
//! Hosts the backend-agnostic **transfer queue model** (#1336): per-session
//! bounded concurrency, pause/resume, auto-retry with exponential backoff, and
//! offset-based resume, driving both SFTP (PROD-0012) and FTP uploads and
//! downloads. The original cancel-only SFTP copy path (#1245) was retired in
//! #3188 once every SFTP transfer ran through `run_sftp_transfer`.
//!
//! Structure:
//!
//! - [`state`] — the pure `Queued/Active/Paused/Completed/Failed/Cancelled`
//!   state machine (no I/O, fully unit-tested). Now lives in
//!   [`termihub_core::files::transfer::state`] (DUP-026) and is re-exported here
//!   so the desktop paths keep their `super::state` / `transfer::state` imports.
//! - [`scheduler`] — pure per-session slot accounting (`max_concurrent`), moved
//!   to [`termihub_core::files::transfer::scheduler`] (DUP-026) and re-exported.
//! - [`retry`] — pure backoff schedule, `REST` resume-offset math, and a
//!   throughput/ETA meter, moved to [`termihub_core::files::transfer::retry`]
//!   (DUP-026) and re-exported.
//! - [`registry`] — the [`TransferRegistry`] Tauri state: the queue model's
//!   per-transfer handles and per-session schedulers.
//! - [`sftp`] / [`ftp`] — the SFTP and FTP (feature-gated behind `ftp`)
//!   upload/download executors.
//!
//! `tokio_util::sync::CancellationToken` provides the cancellation primitive
//! (libraries-first — no hand-rolled channels).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

pub mod persist;
pub mod persist_manager;
pub mod persist_storage;
pub(crate) mod relaunch;

// The FTP/SFTP transfer executors moved to `termihub-core` (DUP-026 slice 2b):
// `run_ftp_transfer`, `run_sftp_transfer`, `run_sftp_remote_copy`, plus SFTP's
// `ResumeMode` / `DEFAULT_RESUME_MODE`. Re-export them under their original
// `transfer::sftp::*` / `transfer::ftp::*` submodule paths so every desktop call
// site (`commands::session`, `commands::transfer`, `relaunch`, the
// `sftp_transfer` integration test) resolves unchanged.
pub mod sftp {
    pub use termihub_core::files::transfer::sftp::*;
}

#[cfg(feature = "ftp")]
pub mod ftp {
    pub use termihub_core::files::transfer::ftp::*;
}

// The pure, backend-agnostic transfer machinery moved to `termihub-core`
// (DUP-026): the state machine / scheduler / retry math (slice 1), and the
// in-flight registry + progress model (slice 2a). Re-export them under their
// original names so every desktop path — `super::registry`, `super::state`,
// `super::{ProgressSink, TransferProgress, CHUNK_SIZE, …}`, and the external
// `crate::files::transfer::*` — resolves unchanged.
pub use termihub_core::files::transfer::{
    is_queue_teardown, registry, retry, scheduler, state, ProgressSink, TransferDirection,
    TransferPhase, TransferProgress, CHUNK_SIZE, PROGRESS_THROTTLE, QUEUE_TEARDOWN,
};

pub use persist::{PersistedTransfer, PersistedTransferStatus, PersistedTransferStore};
pub use persist_manager::TransferPersistenceManager;
pub use registry::{TransferRegistry, TransferSnapshot};
pub use retry::{backoff_delay, resume_offset, ThroughputMeter, BASE_BACKOFF};
pub use scheduler::{Admission, SessionScheduler, DEFAULT_MAX_CONCURRENT};
pub use state::{InvalidTransition, TransferEvent, TransferState, TransferStateTag, MAX_RETRIES};

/// The Tauri event name every transfer lifecycle update is emitted on.
pub const TRANSFER_PROGRESS_EVENT: &str = "transfer-progress";

/// Build a [`ProgressSink`] that emits each update as a Tauri
/// `transfer-progress` event, best-effort (a failed emit must not abort the
/// copy).
pub fn app_progress_sink(app: AppHandle) -> ProgressSink {
    Arc::new(move |progress: &TransferProgress| {
        // Server-authority fold (#2387, prerequisite for #2229): reflect every
        // backend-produced transfer transition / progress sample into the shared
        // `TransferStore` at the source — the instant the copy loop / FTP
        // scheduler produces it — and fan the `transfers` region diff out.
        // `app_progress_sink` is the single choke point every `transfer-progress`
        // event flows through for both the SFTP and FTP executors, so
        // folding here feeds the store the whole register → queue → progress →
        // pause → resume → finish → cancel lifecycle. Additive: the Tauri event
        // below still fires and the frontend mirror is untouched, so no
        // user-facing behavior changes; the fold serializes the event to the same
        // camelCase JSON the frontend receives, so the store transition matches
        // the client `transfer.progress` route exactly. Best-effort: skipped when
        // the store/projection is unmanaged (e.g. a collector-sink integration
        // test) or the event does not serialize.
        if let Ok(value) = serde_json::to_value(progress) {
            crate::transfers_projection::projection::fold_transfer_progress(&app, &value);
        }
        // Durable queue (PROD-0011): fold every lifecycle/progress transition
        // into the persisted queue at the same choke point. Fire-and-forget and
        // debounced inside the manager (status change / coarse checkpoint only),
        // so it never slows the copy. Best-effort: skipped when persistence is
        // unavailable (e.g. a headless test app). The teardown flag lets a quit
        // cancel-all leave in-flight records intact instead of erasing them.
        if let Some(pm) = app.try_state::<TransferPersistenceManager>() {
            pm.note_progress(
                &progress.transfer_id,
                PersistedTransferStatus::from(progress.state),
                progress.transferred,
                progress.total,
                is_queue_teardown(),
            );
        }
        if let Err(e) = app.emit(TRANSFER_PROGRESS_EVENT, progress) {
            warn!(error = %e, "failed to emit transfer-progress");
        }
    })
}
