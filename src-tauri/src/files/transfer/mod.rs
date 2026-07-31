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
//!   state machine (no I/O, fully unit-tested).
//! - [`scheduler`] — pure per-session slot accounting (`max_concurrent`).
//! - [`retry`] — pure backoff schedule, `REST` resume-offset math, and a
//!   throughput/ETA meter.
//! - [`registry`] — the [`TransferRegistry`] Tauri state: the legacy
//!   `transfer_id → CancellationToken` map *plus* the rich queue model.
//! - [`ftp`] — FTP upload/download executor (feature-gated behind `ftp`).
//!
//! `tokio_util::sync::CancellationToken` provides the cancellation primitive
//! (libraries-first — no hand-rolled channels).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use termihub_core::backends::ssh::SftpTransferChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::utils::errors::TerminalError;

pub mod registry;
pub mod retry;
pub mod scheduler;
pub mod state;

#[cfg(feature = "ftp")]
pub mod ftp;

pub use registry::{TransferRegistry, TransferSnapshot};
pub use retry::{backoff_delay, resume_offset, ThroughputMeter, BASE_BACKOFF};
pub use scheduler::{Admission, SessionScheduler, DEFAULT_MAX_CONCURRENT};
pub use state::{InvalidTransition, TransferEvent, TransferState, TransferStateTag, MAX_RETRIES};

/// Chunk size for the copy loop. Large enough to keep round-trips amortised,
/// small enough that cancel latency stays sub-second.
const CHUNK_SIZE: usize = 256 * 1024;

/// Minimum interval between two `transfer-progress` emits, to avoid flooding
/// the event bus (~10 Hz).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

/// The Tauri event name every transfer lifecycle update is emitted on.
pub const TRANSFER_PROGRESS_EVENT: &str = "transfer-progress";

/// Direction of a transfer, driving the icon / verb in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
    fn state_tag(self) -> TransferStateTag {
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

/// A sink for `transfer-progress` updates. Decouples the copy loop from Tauri
/// so it can be driven by a real [`AppHandle`] in production and by a plain
/// collector in integration tests.
pub type ProgressSink = Arc<dyn Fn(&TransferProgress) + Send + Sync>;

/// Build a [`ProgressSink`] that emits each update as a Tauri
/// `transfer-progress` event, best-effort (a failed emit must not abort the
/// copy).
pub fn app_progress_sink(app: AppHandle) -> ProgressSink {
    Arc::new(move |progress: &TransferProgress| {
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
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    // Emit a starting event so even zero-byte / tiny files render a row.
    sink(&ctx.progress(0, TransferPhase::Transferring, None));

    loop {
        if token.is_cancelled() {
            return Ok(CopyOutcome::Cancelled { transferred });
        }

        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| TerminalError::SshError(format!("transfer read failed: {e}")))?;
        if n == 0 {
            break;
        }

        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| TerminalError::SshError(format!("transfer write failed: {e}")))?;
        transferred += n as u64;

        if last_emit.elapsed() >= PROGRESS_THROTTLE {
            sink(&ctx.progress(transferred, TransferPhase::Transferring, None));
            last_emit = Instant::now();
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| TerminalError::SshError(format!("transfer flush failed: {e}")))?;

    Ok(CopyOutcome::Completed { transferred })
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
