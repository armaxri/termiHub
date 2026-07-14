//! Cancellable, chunked SFTP transfer subsystem (issue #1245).
//!
//! The legacy transfer path buffered a whole file *under the session `Mutex`*,
//! which froze browsing on that session for the duration of the copy and could
//! not be cancelled. This module replaces it with:
//!
//! - a [`TransferRegistry`] that maps a per-transfer `transfer_id` to a
//!   [`CancellationToken`] (managed as Tauri state);
//! - a chunked copy loop that runs on a **dedicated** SFTP channel opened off
//!   the same authenticated SSH session, so the copy does *not* hold the session
//!   `Mutex` and directory listing / navigation stays live during a transfer;
//! - throttled `transfer-progress` events and a terminal event on completion,
//!   cancellation, or error.
//!
//! `tokio_util::sync::CancellationToken` provides the cancellation primitive
//! (libraries-first — no hand-rolled channels).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession as RusshSftp;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::utils::errors::TerminalError;

pub mod retry;
pub mod scheduler;
pub mod state;

/// Chunk size for the copy loop. Large enough to keep SFTP round-trips
/// amortised, small enough that cancel latency stays sub-second.
const CHUNK_SIZE: usize = 256 * 1024;

/// Minimum interval between two `transfer-progress` emits, to avoid flooding
/// the event bus (~10 Hz).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

/// The Tauri event name every transfer lifecycle update is emitted on.
pub const TRANSFER_PROGRESS_EVENT: &str = "transfer-progress";

/// Direction of a transfer, driving the icon / verb in the UI.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Download,
    Upload,
}

/// Lifecycle phase of a transfer. `Transferring` is intermediate; the other
/// three are terminal and clear the UI row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferPhase {
    Transferring,
    Done,
    Cancelled,
    Error,
}

/// A single `transfer-progress` event payload (concept Decision 2).
///
/// `total == 0` means indeterminate (stat unavailable); the UI shows a spinner.
/// `message` is only populated for the [`TransferPhase::Error`] phase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    pub phase: TransferPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Tracks in-flight transfers by `transfer_id`, each with a cancellation token.
///
/// `Clone` (the map is behind an `Arc`) so a handle can be moved into the copy
/// task and into Tauri commands. Managed as Tauri state.
#[derive(Clone, Default)]
pub struct TransferRegistry {
    transfers: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl TransferRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Lock the inner map, recovering the guard even if the mutex is poisoned.
    ///
    /// A poisoned lock here is always cleanup-adjacent (register/cancel/drop),
    /// so recovering the guard and continuing is correct — mirrors the
    /// poison-safe draining in `SftpManager` (audit GAP C1, #1143/#1244).
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.transfers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a fresh transfer, returning its cancellation token.
    ///
    /// The returned token is checked by the copy loop at each chunk boundary.
    pub fn register(&self, transfer_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.lock().insert(transfer_id.to_string(), token.clone());
        token
    }

    /// Cancel a transfer by id. Unknown / already-finished ids are a no-op
    /// (returns `false`); a live transfer is cancelled (returns `true`).
    pub fn cancel(&self, transfer_id: &str) -> bool {
        match self.lock().get(transfer_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Cancel every in-flight transfer. Used on app quit *before* SFTP sessions
    /// are closed, so no half-written file keeps a channel open during teardown.
    /// Returns the number of transfers signalled.
    pub fn cancel_all(&self) -> usize {
        let guard = self.lock();
        for token in guard.values() {
            token.cancel();
        }
        guard.len()
    }

    /// Drop a transfer's registry entry once its copy loop has finished.
    pub fn drop_entry(&self, transfer_id: &str) {
        self.lock().remove(transfer_id);
    }

    /// Number of currently-registered transfers (for tests / diagnostics).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether no transfers are currently registered (for tests / diagnostics).
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Whether a transfer id is currently registered (for tests / diagnostics).
    #[cfg(test)]
    pub fn contains(&self, transfer_id: &str) -> bool {
        self.lock().contains_key(transfer_id)
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

/// Shared context for a running transfer, so the chunk loop and the terminal
/// emit share one description of the transfer.
pub struct TransferContext {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
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
            transferred,
            total: self.total,
            phase,
            message,
        }
    }
}

/// Copy `reader` to `writer` in [`CHUNK_SIZE`] chunks, checking `token` at each
/// boundary and emitting throttled progress. Returns the number of bytes copied
/// on success, or `Err(bytes_written)` shaped errors via [`TerminalError`].
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
/// `sftp` is a freshly-opened SFTP session bound to its own channel, so this
/// copy never touches the browsing session's `Mutex`. On cancel the partial
/// local file is removed; on error a terminal `error` event is emitted. In all
/// terminal cases the registry entry is dropped.
#[allow(clippy::too_many_arguments)]
pub async fn run_download(
    sftp: RusshSftp,
    remote_path: String,
    local_path: String,
    ctx: TransferContext,
    token: CancellationToken,
    registry: TransferRegistry,
    sink: ProgressSink,
) {
    let outcome = download_inner(&sftp, &remote_path, &local_path, &ctx, &token, &sink).await;
    finish_transfer(outcome, &ctx, &registry, &sink, || {
        // Cleanup: remove the partial local file (best-effort).
        let _ = std::fs::remove_file(&local_path);
    });
}

async fn download_inner(
    sftp: &RusshSftp,
    remote_path: &str,
    local_path: &str,
    ctx: &TransferContext,
    token: &CancellationToken,
    sink: &ProgressSink,
) -> Result<CopyOutcome, TerminalError> {
    let mut remote = sftp
        .open(remote_path)
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
    sftp: RusshSftp,
    local_path: String,
    remote_path: String,
    ctx: TransferContext,
    token: CancellationToken,
    registry: TransferRegistry,
    sink: ProgressSink,
) {
    let outcome = upload_inner(&sftp, &local_path, &remote_path, &ctx, &token, &sink).await;
    let sftp_for_cleanup = sftp;
    let remote_for_cleanup = remote_path.clone();
    // Remove the partial remote file on cancel/error (best-effort).
    let cleanup_needed = matches!(outcome, Ok(CopyOutcome::Cancelled { .. }) | Err(_));
    finish_transfer(outcome, &ctx, &registry, &sink, || {});
    if cleanup_needed {
        if let Err(e) = sftp_for_cleanup.remove_file(&remote_for_cleanup).await {
            debug!(error = %e, "could not remove partial remote upload (best-effort)");
        }
    }
}

async fn upload_inner(
    sftp: &RusshSftp,
    local_path: &str,
    remote_path: &str,
    ctx: &TransferContext,
    token: &CancellationToken,
    sink: &ProgressSink,
) -> Result<CopyOutcome, TerminalError> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| TerminalError::SshError(format!("open local file: {e}")))?;
    let mut remote = sftp
        .create(remote_path)
        .await
        .map_err(|e| TerminalError::SshError(format!("create remote file: {e}")))?;
    copy_chunked(&mut local, &mut remote, ctx, token, sink).await
}

/// Emit the terminal event, run cleanup on cancel/error, and drop the registry
/// entry. Shared by download and upload.
fn finish_transfer<F: FnOnce()>(
    outcome: Result<CopyOutcome, TerminalError>,
    ctx: &TransferContext,
    registry: &TransferRegistry,
    sink: &ProgressSink,
    cleanup: F,
) {
    match outcome {
        Ok(CopyOutcome::Completed { transferred }) => {
            info!(transfer_id = %ctx.transfer_id, transferred, "transfer complete");
            sink(&ctx.progress(transferred, TransferPhase::Done, None));
        }
        Ok(CopyOutcome::Cancelled { transferred }) => {
            info!(transfer_id = %ctx.transfer_id, transferred, "transfer cancelled");
            cleanup();
            sink(&ctx.progress(transferred, TransferPhase::Cancelled, None));
        }
        Err(e) => {
            warn!(transfer_id = %ctx.transfer_id, error = %e, "transfer failed");
            cleanup();
            sink(&ctx.progress(0, TransferPhase::Error, Some(e.to_string())));
        }
    }
    registry.drop_entry(&ctx.transfer_id);
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // Models an already-finished transfer: the copy loop ended and dropped
        // the entry; a late cancel from the UI must be a harmless no-op.
        let reg = TransferRegistry::new();
        reg.register("t1");
        reg.drop_entry("t1");
        assert!(!reg.cancel("t1"));
    }
}
