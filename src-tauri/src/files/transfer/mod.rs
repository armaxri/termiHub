//! Cancellable, queued file-transfer subsystem (issues #1245, #1336).
//!
//! Originally a single-phase, cancellable chunked *SFTP* copy path (#1245),
//! this module now also hosts the richer, backend-agnostic **transfer queue
//! model** (#1336): per-session bounded concurrency, pause/resume, auto-retry
//! with exponential backoff, and `REST`-based resume, driving FTP uploads and
//! downloads. The SFTP path is unchanged and remains fully backward-compatible.
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
//! - [`registry`] — the [`TransferRegistry`] Tauri state: the legacy
//!   `transfer_id → CancellationToken` map *plus* the rich queue model.
//! - [`ftp`] — FTP upload/download executor (feature-gated behind `ftp`).
//!
//! `tokio_util::sync::CancellationToken` provides the cancellation primitive
//! (libraries-first — no hand-rolled channels).

use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager};
use termihub_core::backends::ssh::SftpTransferChannel;
use termihub_core::files::copy::{run_chunked_copy, ChunkedCopyOutcome, CopyPhase};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::utils::errors::TerminalError;

pub mod persist;
pub mod persist_manager;
pub mod persist_storage;
pub(crate) mod relaunch;
pub mod sftp;

#[cfg(feature = "ftp")]
pub mod ftp;

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
        // event flows through for both the legacy SFTP and rich FTP paths, so
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

/// Shared context for a running SFTP transfer, so the chunk loop and the
/// terminal emit share one description of the transfer (#1245 path).
pub struct TransferContext {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    /// Remote path of the transferred file, surfaced in `transfer-progress`
    /// so the Transfer Queue row can show it alongside the file name (#1531).
    pub path: String,
    pub total: u64,
}

impl TransferContext {
    fn progress(
        &self,
        transferred: u64,
        phase: TransferPhase,
        message: Option<String>,
    ) -> TransferProgress {
        TransferProgress {
            transfer_id: self.transfer_id.clone(),
            session_id: self.session_id.clone(),
            direction: self.direction,
            file_name: self.file_name.clone(),
            path: self.path.clone(),
            transferred,
            total: self.total,
            phase,
            message,
            // Additive queue-model fields, derived from the legacy phase so the
            // SFTP path emits a consistent `state`/`totalBytes` (#1336).
            state: phase.state_tag(),
            speed: 0,
            total_bytes: self.total,
            eta_secs: None,
            attempt: 0,
            max_attempts: MAX_RETRIES,
        }
    }
}

/// Copy `reader` to `writer` in [`CHUNK_SIZE`] chunks, checking `token` at each
/// boundary and emitting throttled progress. Returns the outcome via
/// [`CopyOutcome`], or a [`TerminalError`] on I/O failure.
///
/// Cancellation stops the loop at the next chunk boundary and returns
/// [`CopyOutcome::Cancelled`] with the bytes written so far, so the caller can
/// clean up the partial destination.
async fn copy_chunked<R, W>(
    reader: &mut R,
    writer: &mut W,
    ctx: &TransferContext,
    token: &CancellationToken,
    sink: &ProgressSink,
) -> Result<CopyOutcome, TerminalError>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    // Emit a starting event so even zero-byte / tiny files render a row.
    sink(&ctx.progress(0, TransferPhase::Transferring, None));

    // Throttle progress emission to ~10 Hz, exactly as before: the shared loop
    // calls `on_progress` after every chunk, so the ≤`PROGRESS_THROTTLE` gate
    // lives in this callback rather than in the loop body.
    let mut last_emit = Instant::now();
    let outcome = run_chunked_copy(
        reader,
        writer,
        CHUNK_SIZE,
        0,
        || token.is_cancelled().then_some(()),
        |transferred| {
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                sink(&ctx.progress(transferred, TransferPhase::Transferring, None));
                last_emit = Instant::now();
            }
        },
        |phase, e| {
            let what = match phase {
                CopyPhase::Read => "read",
                CopyPhase::Write => "write",
                CopyPhase::Flush => "flush",
            };
            TerminalError::SshError(format!("transfer {what} failed: {e}"))
        },
    )
    .await?;

    Ok(match outcome {
        ChunkedCopyOutcome::Completed { transferred } => CopyOutcome::Completed { transferred },
        ChunkedCopyOutcome::Stopped { transferred, .. } => CopyOutcome::Cancelled { transferred },
    })
}

/// Result of a chunked copy: either it ran to EOF, or it was cancelled at a
/// chunk boundary (with the partial byte count for cleanup).
enum CopyOutcome {
    Completed { transferred: u64 },
    Cancelled { transferred: u64 },
}

/// Run a download (remote → local) on a dedicated SFTP channel.
///
/// `channel` is a freshly-opened dedicated [`SftpTransferChannel`] bound to its
/// own SSH channel, so this copy never touches the browsing session's `Mutex`.
/// On cancel the partial local file is removed; on error a terminal `error`
/// event is emitted. In all terminal cases the registry entry is dropped.
#[allow(clippy::too_many_arguments)]
pub async fn run_download(
    channel: SftpTransferChannel,
    remote_path: String,
    local_path: String,
    ctx: TransferContext,
    token: CancellationToken,
    registry: TransferRegistry,
    sink: ProgressSink,
) {
    let outcome = download_inner(&channel, &remote_path, &local_path, &ctx, &token, &sink).await;
    finish_transfer(outcome, &ctx, &registry, &sink, || {
        // Cleanup: remove the partial local file (best-effort).
        let _ = std::fs::remove_file(&local_path);
    });
}

async fn download_inner(
    channel: &SftpTransferChannel,
    remote_path: &str,
    local_path: &str,
    ctx: &TransferContext,
    token: &CancellationToken,
    sink: &ProgressSink,
) -> Result<CopyOutcome, TerminalError> {
    let mut remote = channel
        .open_read(remote_path)
        .await
        .map_err(|e| TerminalError::SshError(format!("open remote file: {e}")))?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| TerminalError::SshError(format!("create local file: {e}")))?;
    copy_chunked(&mut remote, &mut local, ctx, token, sink).await
}

/// Run an upload (local → remote) on a dedicated SFTP channel. On cancel the
/// partial remote file is removed; on error a terminal `error` event is emitted.
#[allow(clippy::too_many_arguments)]
pub async fn run_upload(
    channel: SftpTransferChannel,
    local_path: String,
    remote_path: String,
    ctx: TransferContext,
    token: CancellationToken,
    registry: TransferRegistry,
    sink: ProgressSink,
) {
    let outcome = upload_inner(&channel, &local_path, &remote_path, &ctx, &token, &sink).await;
    let channel_for_cleanup = channel;
    let remote_for_cleanup = remote_path.clone();
    // Remove the partial remote file on cancel/error (best-effort).
    let cleanup_needed = matches!(outcome, Ok(CopyOutcome::Cancelled { .. }) | Err(_));
    finish_transfer(outcome, &ctx, &registry, &sink, || {});
    if cleanup_needed {
        if let Err(e) = channel_for_cleanup.remove_file(&remote_for_cleanup).await {
            debug!(error = %e, "could not remove partial remote upload (best-effort)");
        }
    }
}

async fn upload_inner(
    channel: &SftpTransferChannel,
    local_path: &str,
    remote_path: &str,
    ctx: &TransferContext,
    token: &CancellationToken,
    sink: &ProgressSink,
) -> Result<CopyOutcome, TerminalError> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| TerminalError::SshError(format!("open local file: {e}")))?;
    let mut remote = channel
        .create_write(remote_path)
        .await
        .map_err(|e| TerminalError::SshError(format!("create remote file: {e}")))?;
    copy_chunked(&mut local, &mut remote, ctx, token, sink).await
}

/// Emit the terminal event, run cleanup on cancel/error, and record the
/// transfer's terminal state in the registry. Shared by download and upload.
///
/// The terminal state is *retained* in the registry for a bounded window
/// (`finish_legacy`, #1645) rather than immediately dropped, so a reconcile can
/// still settle a stuck Transfer Queue row if this terminal `transfer-progress`
/// event was dropped (e.g. under memory pressure).
fn finish_transfer<F: FnOnce()>(
    outcome: Result<CopyOutcome, TerminalError>,
    ctx: &TransferContext,
    registry: &TransferRegistry,
    sink: &ProgressSink,
    cleanup: F,
) {
    let (phase, transferred) = match outcome {
        Ok(CopyOutcome::Completed { transferred }) => {
            info!(transfer_id = %ctx.transfer_id, transferred, "transfer complete");
            sink(&ctx.progress(transferred, TransferPhase::Done, None));
            (TransferPhase::Done, transferred)
        }
        Ok(CopyOutcome::Cancelled { transferred }) => {
            info!(transfer_id = %ctx.transfer_id, transferred, "transfer cancelled");
            cleanup();
            sink(&ctx.progress(transferred, TransferPhase::Cancelled, None));
            (TransferPhase::Cancelled, transferred)
        }
        Err(e) => {
            warn!(transfer_id = %ctx.transfer_id, error = %e, "transfer failed");
            cleanup();
            sink(&ctx.progress(0, TransferPhase::Error, Some(e.to_string())));
            (TransferPhase::Error, 0)
        }
    };
    registry.finish_legacy(&ctx.transfer_id, phase.state_tag(), transferred);
}
