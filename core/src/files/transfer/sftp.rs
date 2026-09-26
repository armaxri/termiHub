//! SFTP transfer executor — drives the queue state machine around a dedicated
//! [`SftpTransferChannel`] copy (product feature PROD-0012).
//!
//! This is the SFTP counterpart to the FTP executor (`run_ftp_transfer`). It
//! replaced the desktop's original single-shot, cancel-only chunked copy
//! (removed in #3188), wrapping the core streaming primitive with the desktop's
//! full **queue orchestration**: acquire a
//! per-session concurrency slot, stream with throttled progress + ETA,
//! auto-retry with exponential backoff on error, honour pause/resume and
//! cancel, and drive the [`TransferHandle`] through its `Queued → Active → …`
//! states. Each attempt opens its **own** dedicated SFTP channel off the shared
//! [`SftpFileBrowser`], so the browsing session stays live during a transfer
//! and a broken channel is re-established transparently on retry.
//!
//! **Resume (PROD-0012, hardened by PARITY-004 / #3567).** A paused or retried
//! transfer resumes from the byte offset already at the destination. Before
//! **every** attempt the resume point is re-verified on that attempt's own
//! channel ([`apply_resume_gate`] over the pure
//! [`decide_resume`](super::retry::decide_resume)): the source must still match
//! the size + mtime fingerprint captured when its bytes were read, and the
//! destination must hold a prefix we wrote — the resume starts from the bytes
//! actually present, so pipelined writes lost on a dropped connection never
//! leave a hole. On any doubt, or when the server rejects the seek/append open,
//! the transfer restarts from zero and surfaces which path it took. The resume
//! protocol is selectable via [`ResumeMode`] (maintainer default: [`DEFAULT_RESUME_MODE`]).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::backends::ssh::{SftpFileBrowser, SftpTransferChannel};
use crate::files::copy::{run_chunked_copy, ChunkedCopyOutcome, CopyPhase};
use tracing::{debug, info, warn};

mod resume;

pub use resume::STALL_TIMEOUT;
use resume::{
    apply_resume_gate, guard_stall, local_fingerprint, local_size, rehydrate_start_offset,
    ResumeCursor,
};

use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{
    ProgressSink, ThroughputMeter, TransferDirection, TransferPhase, TransferProgress, CHUNK_SIZE,
    PROGRESS_THROTTLE,
};

/// Core-internal error type for the SFTP transfer executor (DUP-026 slice 2b).
///
/// It never escapes: all three public executors return `()`, and this type only
/// carries phase/context text into the throttled `transfer-progress` message via
/// its `Display`. It replaces the desktop `TerminalError::SshError` the executor
/// used before the move to core, and its `Display` is **byte-identical** to that
/// variant's (`"SSH error: {0}"`), so progress-message text is unchanged.
#[derive(Debug, thiserror::Error)]
enum SftpTransferError {
    #[error("SSH error: {0}")]
    Ssh(String),
}

/// Resume protocol for SFTP transfers (PROD-0012).
///
/// **Maintainer default: [`DEFAULT_RESUME_MODE`] = [`ResumeMode::Resume`].**
/// A resumed transfer byte-verifies the destination and continues from the
/// offset; if the server rejects the seek/append open it transparently restarts
/// from zero and surfaces which path was taken. Flip [`DEFAULT_RESUME_MODE`] to
/// [`ResumeMode::RestartOnly`] to always restart from zero (never attempt an
/// offset-resume) — e.g. against a server known to mishandle random-access I/O.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResumeMode {
    /// Byte-verified offset-resume with automatic restart-from-zero fallback.
    #[default]
    Resume,
    /// Always restart from byte zero on resume/retry.
    RestartOnly,
}

/// The maintainer-selectable default resume protocol (PROD-0012). See
/// [`ResumeMode`].
pub const DEFAULT_RESUME_MODE: ResumeMode = ResumeMode::Resume;

/// Why an in-flight attempt stopped short of completion (partial bytes kept).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    /// The user requested a pause; the transfer can resume from the offset.
    Pause,
    /// The user requested cancellation; the caller cleans up the partial file.
    Cancel,
}

/// Outcome of running one SFTP transfer attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptOutcome {
    /// The file was transferred to EOF. `transferred` is the total byte count.
    Completed { transferred: u64 },
    /// The `should_stop` probe asked to stop. `transferred` is the byte count
    /// reached so far (usable as a resume offset on the next attempt).
    Stopped {
        transferred: u64,
        reason: StopReason,
    },
    /// Opening the destination/source at a non-zero offset was rejected by the
    /// server; the caller restarts this stint from byte zero.
    ResumeRejected,
}

/// Result of the retry loop for one Active stint.
enum AttemptsResult {
    Completed,
    Cancelled,
    Paused,
    FailedPermanent,
}

/// Best-effort: settle a writer after an attempt stopped short (pause/cancel)
/// so the bytes counted as transferred have actually landed — pipelined SFTP
/// writes are acknowledged asynchronously. A failure is harmless: the next
/// attempt byte-verifies the destination anyway.
async fn settle_writer<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    outcome: &ChunkedCopyOutcome<StopReason>,
) {
    use tokio::io::AsyncWriteExt;
    if matches!(outcome, ChunkedCopyOutcome::Stopped { .. }) {
        match tokio::time::timeout(STALL_TIMEOUT, writer.shutdown()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => debug!(error = %e, "could not settle writer after stop (best-effort)"),
            Err(_) => debug!("settling writer after stop timed out (best-effort)"),
        }
    }
}

/// Map a live handle's control flags to a stop decision for the copy loop.
fn stop_reason(handle: &TransferHandle) -> Option<StopReason> {
    if handle.is_cancelled() {
        Some(StopReason::Cancel)
    } else if handle.take_pause_request() {
        Some(StopReason::Pause)
    } else {
        None
    }
}

/// Emit a `transfer-progress` event for `handle`'s current snapshot.
fn emit(
    handle: &TransferHandle,
    sink: &ProgressSink,
    phase: TransferPhase,
    eta_secs: Option<u64>,
    message: Option<String>,
) {
    let snap = handle.snapshot();
    sink(&TransferProgress::from_snapshot(
        &snap, phase, eta_secs, message,
    ));
}

/// Throttled progress reporter shared across chunks of one attempt.
struct ProgressReporter {
    handle: Arc<TransferHandle>,
    sink: ProgressSink,
    total: u64,
    progress: Arc<AtomicU64>,
    meter: ThroughputMeter,
    last_emit: Instant,
    last_sample: Instant,
    last_bytes: u64,
}

impl ProgressReporter {
    fn new(
        handle: Arc<TransferHandle>,
        sink: ProgressSink,
        total: u64,
        progress: Arc<AtomicU64>,
        start_bytes: u64,
    ) -> Self {
        let now = Instant::now();
        Self {
            handle,
            sink,
            total,
            progress,
            meter: ThroughputMeter::default(),
            last_emit: now,
            last_sample: now,
            last_bytes: start_bytes,
        }
    }

    fn report(&mut self, transferred: u64) {
        self.progress.store(transferred, Ordering::Relaxed);
        let now = Instant::now();
        let dt = now.saturating_duration_since(self.last_sample);
        let delta = transferred.saturating_sub(self.last_bytes);
        self.meter.record(delta, dt);
        self.last_sample = now;
        self.last_bytes = transferred;

        let speed = self.meter.speed_bps();
        self.handle.set_metrics(transferred, self.total, speed);

        if now.saturating_duration_since(self.last_emit) >= PROGRESS_THROTTLE {
            let eta = self.meter.eta_secs(self.total.saturating_sub(transferred));
            emit(
                &self.handle,
                &self.sink,
                TransferPhase::Transferring,
                eta,
                None,
            );
            self.last_emit = now;
        }
    }
}

/// Wait until a queued transfer is promoted to Active (returns `true`) or is
/// cancelled while waiting (returns `false`).
async fn wait_for_active(handle: &Arc<TransferHandle>, registry: &TransferRegistry) -> bool {
    use super::scheduler::Admission;
    if registry.request_slot(handle) == Admission::Run {
        return true;
    }
    loop {
        if handle.is_cancelled() {
            return false;
        }
        if handle.state().is_active() {
            return true;
        }
        handle.wait_for_signal().await;
    }
}

/// Wait for a resume/retry request (returns `true`) or a cancel (returns
/// `false`) on a paused/failed transfer.
async fn wait_for_resume(handle: &Arc<TransferHandle>) -> bool {
    loop {
        if handle.is_cancelled() {
            return false;
        }
        if handle.take_resume_request() {
            return true;
        }
        handle.wait_for_signal().await;
    }
}

/// Sleep for `delay`, returning `true` if the transfer was cancelled meanwhile.
async fn cancellable_backoff(handle: &Arc<TransferHandle>, delay: std::time::Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => handle.is_cancelled(),
        _ = handle.wait_for_signal() => handle.is_cancelled(),
    }
}

/// Map a chunked-copy phase error to a [`SftpTransferError`], preserving the text.
fn copy_error(phase: CopyPhase, e: std::io::Error) -> SftpTransferError {
    let what = match phase {
        CopyPhase::Read => "read",
        CopyPhase::Write => "write",
        CopyPhase::Flush => "flush",
    };
    SftpTransferError::Ssh(format!("transfer {what} failed: {e}"))
}

/// Open the local destination for a resumed download: the existing partial is
/// opened for writing and the file pointer is seeked to `offset` so the copy
/// appends rather than truncates.
async fn open_local_append(local_path: &str, offset: u64) -> std::io::Result<tokio::fs::File> {
    use tokio::io::AsyncSeekExt;
    let mut f = tokio::fs::OpenOptions::new()
        .write(true)
        .open(local_path)
        .await?;
    f.seek(std::io::SeekFrom::Start(offset)).await?;
    Ok(f)
}

/// Open the local source for a resumed upload: the file is opened for reading
/// and seeked to `offset` so only the not-yet-sent tail is streamed.
async fn open_local_read(local_path: &str, offset: u64) -> std::io::Result<tokio::fs::File> {
    use tokio::io::AsyncSeekExt;
    let mut f = tokio::fs::File::open(local_path).await?;
    if offset > 0 {
        f.seek(std::io::SeekFrom::Start(offset)).await?;
    }
    Ok(f)
}

/// Run one download attempt on a fresh dedicated channel, resuming from
/// `offset`. A non-zero `offset` whose remote open is rejected yields
/// [`AttemptOutcome::ResumeRejected`] so the caller restarts from zero.
async fn download_attempt<P, S>(
    channel: &SftpTransferChannel,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, SftpTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    // Remote source (the server op that a hostile server could reject at
    // offset). At offset 0 this is a plain open.
    let mut remote = match channel.open_read_at(remote_path, offset).await {
        Ok(r) => r,
        Err(e) if offset > 0 => {
            warn!(offset, error = %e, "SFTP server rejected resume read; restarting from zero");
            return Ok(AttemptOutcome::ResumeRejected);
        }
        Err(e) => return Err(SftpTransferError::Ssh(format!("open remote file: {e}"))),
    };

    // Local destination: append to the verified partial, or truncate for a
    // fresh transfer. The partial was written by us and byte-verified by the
    // caller, so a local open/seek failure here is a genuine error.
    let mut local = if offset > 0 {
        open_local_append(local_path, offset)
            .await
            .map_err(|e| SftpTransferError::Ssh(format!("open local file for append: {e}")))?
    } else {
        tokio::fs::File::create(local_path)
            .await
            .map_err(|e| SftpTransferError::Ssh(format!("create local file: {e}")))?
    };

    let outcome = run_chunked_copy(
        &mut remote,
        &mut local,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        copy_error,
    )
    .await?;
    settle_writer(&mut local, &outcome).await;
    Ok(map_copy_outcome(outcome))
}

/// Run one upload attempt on a fresh dedicated channel, resuming from `offset`.
/// A non-zero `offset` whose remote open is rejected yields
/// [`AttemptOutcome::ResumeRejected`] so the caller restarts from zero.
async fn upload_attempt<P, S>(
    channel: &SftpTransferChannel,
    local_path: &str,
    remote_path: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, SftpTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    // Local source: seek to the offset already sent (byte-verified by caller).
    let mut local = open_local_read(local_path, offset)
        .await
        .map_err(|e| SftpTransferError::Ssh(format!("open local file: {e}")))?;

    // Remote destination (the server op). Append (no truncate) at offset, or a
    // truncating create for a fresh transfer.
    let mut remote = if offset > 0 {
        match channel.open_write_at(remote_path, offset).await {
            Ok(w) => w,
            Err(e) => {
                warn!(offset, error = %e, "SFTP server rejected resume append; restarting from zero");
                return Ok(AttemptOutcome::ResumeRejected);
            }
        }
    } else {
        channel
            .create_write(remote_path)
            .await
            .map_err(|e| SftpTransferError::Ssh(format!("create remote file: {e}")))?
    };

    let outcome = run_chunked_copy(
        &mut local,
        &mut remote,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        copy_error,
    )
    .await?;
    settle_writer(&mut remote, &outcome).await;
    Ok(map_copy_outcome(outcome))
}

/// Translate a [`ChunkedCopyOutcome`] into an [`AttemptOutcome`].
fn map_copy_outcome(outcome: ChunkedCopyOutcome<StopReason>) -> AttemptOutcome {
    match outcome {
        ChunkedCopyOutcome::Completed { transferred } => AttemptOutcome::Completed { transferred },
        ChunkedCopyOutcome::Stopped {
            transferred,
            reason,
        } => AttemptOutcome::Stopped {
            transferred,
            reason,
        },
    }
}

/// Settle one attempt's result into the cursor and the handle's state.
/// Returns `Some(..)` when the stint ends, or `None` to run another attempt
/// (a rejected offset-resume, or a transient failure that is being retried).
async fn settle_attempt(
    result: Result<AttemptOutcome, SftpTransferError>,
    cursor: &mut ResumeCursor,
    attempt: &mut u32,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
) -> Option<AttemptsResult> {
    match result {
        Ok(AttemptOutcome::Completed { transferred }) => {
            cursor.offset = transferred;
            handle.set_metrics(transferred, cursor.total.max(transferred), 0);
            handle.transition(TransferEvent::Complete);
            Some(AttemptsResult::Completed)
        }
        Ok(AttemptOutcome::Stopped {
            transferred,
            reason: StopReason::Cancel,
        }) => {
            cursor.offset = transferred;
            handle.transition(TransferEvent::Cancel);
            Some(AttemptsResult::Cancelled)
        }
        Ok(AttemptOutcome::Stopped {
            transferred,
            reason: StopReason::Pause,
        }) => {
            cursor.offset = transferred;
            handle.transition(TransferEvent::Pause);
            Some(AttemptsResult::Paused)
        }
        Ok(AttemptOutcome::ResumeRejected) => {
            // The server refused the offset open. Restart this stint from
            // zero (surfaced above via `warn!`); do not consume a retry.
            cursor.offset = 0;
            *attempt -= 1;
            emit(
                handle,
                sink,
                TransferPhase::Transferring,
                None,
                Some("resume not supported by server; restarting from start".to_string()),
            );
            None
        }
        Err(e) => handle_attempt_error(handle, sink, *attempt, &e).await,
    }
}

/// Run attempts (with auto-retry/backoff) for one Active stint. Keeps the slot
/// across transient retries; returns once the transfer completes, is cancelled,
/// is paused, or exhausts its retry budget.
#[allow(clippy::too_many_arguments)]
async fn run_attempts(
    browser: &Arc<SftpFileBrowser>,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
    cursor: &mut ResumeCursor,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
    resume_mode: ResumeMode,
) -> AttemptsResult {
    let mut attempt = 0u32;
    loop {
        if handle.is_cancelled() {
            handle.transition(TransferEvent::Cancel);
            return AttemptsResult::Cancelled;
        }
        attempt += 1;
        handle.set_attempt(attempt);

        // Open a fresh dedicated channel per attempt, so a broken channel is
        // re-established on retry and browsing stays live meanwhile. A failed
        // open keeps the requested offset: nothing is written, and the next
        // attempt re-verifies it.
        let channel = match browser.open_dedicated_channel().await {
            Ok(c) => c,
            Err(e) => {
                let e = SftpTransferError::Ssh(format!("open SFTP transfer channel: {e}"));
                if let Some(outcome) = handle_attempt_error(handle, sink, attempt, &e).await {
                    return outcome;
                }
                continue;
            }
        };

        // Re-verify the resume point on this attempt's channel (PARITY-004).
        if resume_mode == ResumeMode::RestartOnly {
            cursor.offset = 0;
        } else {
            let resuming = cursor.offset > 0;
            let (current, present) = match direction {
                TransferDirection::Download => (
                    channel.remote_fingerprint(remote_path).await,
                    if resuming {
                        local_size(local_path).await
                    } else {
                        None
                    },
                ),
                TransferDirection::Upload => (
                    local_fingerprint(local_path).await,
                    if resuming {
                        channel.remote_file_size(remote_path).await
                    } else {
                        None
                    },
                ),
            };
            apply_resume_gate(cursor, handle, sink, current, present);
        }

        let progress = Arc::new(AtomicU64::new(cursor.offset));
        let mut reporter = ProgressReporter::new(
            handle.clone(),
            sink.clone(),
            cursor.total,
            progress.clone(),
            cursor.offset,
        );
        let stop_handle = handle.clone();
        let attempt_fut = async {
            match direction {
                TransferDirection::Download => {
                    download_attempt(
                        &channel,
                        remote_path,
                        local_path,
                        cursor.offset,
                        |t| reporter.report(t),
                        move || stop_reason(&stop_handle),
                    )
                    .await
                }
                TransferDirection::Upload => {
                    upload_attempt(
                        &channel,
                        local_path,
                        remote_path,
                        cursor.offset,
                        |t| reporter.report(t),
                        move || stop_reason(&stop_handle),
                    )
                    .await
                }
            }
        };
        let result = guard_stall(attempt_fut, &progress, handle, STALL_TIMEOUT).await;
        cursor.offset = progress.load(Ordering::Relaxed);

        if let Some(outcome) = settle_attempt(result, cursor, &mut attempt, handle, sink).await {
            return outcome;
        }
    }
}

/// Apply the retry/backoff policy after a failed attempt. Returns `Some(...)`
/// when the stint should end (cancelled while backing off, or the retry budget
/// is exhausted), or `None` to loop and retry from the current offset.
async fn handle_attempt_error(
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
    attempt: u32,
    e: &SftpTransferError,
) -> Option<AttemptsResult> {
    match super::backoff_delay(attempt) {
        Some(delay) => {
            handle.transition(TransferEvent::Fail { attempt });
            warn!(transfer_id = %handle.transfer_id, attempt, error = %e, "SFTP transfer attempt failed; retrying");
            emit(
                handle,
                sink,
                TransferPhase::Transferring,
                None,
                Some(e.to_string()),
            );
            if cancellable_backoff(handle, delay).await {
                handle.transition(TransferEvent::Cancel);
                return Some(AttemptsResult::Cancelled);
            }
            handle.transition(TransferEvent::Retry);
            handle.transition(TransferEvent::Activate);
            None
        }
        None => {
            handle.transition(TransferEvent::Fail { attempt });
            warn!(transfer_id = %handle.transfer_id, attempt, error = %e, "SFTP transfer failed permanently");
            emit(
                handle,
                sink,
                TransferPhase::Error,
                None,
                Some(e.to_string()),
            );
            Some(AttemptsResult::FailedPermanent)
        }
    }
}

/// Best-effort cleanup of a partial destination on cancel.
async fn cleanup_partial(
    browser: &Arc<SftpFileBrowser>,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
) {
    match direction {
        TransferDirection::Download => {
            if let Err(e) = tokio::fs::remove_file(local_path).await {
                debug!(error = %e, "could not remove partial SFTP download (best-effort)");
            }
        }
        TransferDirection::Upload => match browser.open_dedicated_channel().await {
            Ok(ch) => {
                if let Err(e) = ch.remove_file(remote_path).await {
                    debug!(error = %e, "could not remove partial SFTP upload (best-effort)");
                }
            }
            Err(e) => debug!(error = %e, "could not open channel to clean partial SFTP upload"),
        },
    }
}

/// Drive a queued SFTP transfer to a terminal state on the rich queue model,
/// emitting `transfer-progress` throughout (PROD-0012).
///
/// Consumes the handle registered via [`TransferRegistry::enqueue`]; drops the
/// registry entry on completion. Mirrors the FTP executor `run_ftp_transfer`, so
/// the generic `transfer_pause`/`resume`/`retry` commands work for SFTP.
///
/// `start_offset` seeds the first Active stint's resume offset. It is `0` for a
/// fresh transfer; a **rehydrated** transfer relaunched from its persisted
/// checkpoint (#3199) passes its stored `resume_offset` so the first stint
/// resumes from where the previous run left off. The offset is still
/// byte-verified against the destination before any append (via
/// [`run_attempts`]), so a stale/divergent partial transparently restarts from
/// zero — the resume path is unchanged, only its starting point differs.
#[allow(clippy::too_many_arguments)]
pub async fn run_sftp_transfer(
    browser: Arc<SftpFileBrowser>,
    direction: TransferDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    resume_mode: ResumeMode,
    start_offset: u64,
) {
    // Establish the source identity + total up front so progress/ETA are
    // meaningful and a later resume can detect a changed source (PARITY-004).
    let baseline = match direction {
        TransferDirection::Download => match browser.open_dedicated_channel().await {
            Ok(ch) => ch.remote_fingerprint(&remote_path).await,
            Err(_) => None,
        },
        TransferDirection::Upload => local_fingerprint(&local_path).await,
    };
    let total = match (baseline, direction) {
        (Some(fp), _) => fp.size,
        (None, TransferDirection::Download) => browser.remote_size(&remote_path).await,
        (None, TransferDirection::Upload) => 0,
    };
    // A rehydrated transfer's handle was registered with its persisted total.
    let offset = rehydrate_start_offset(start_offset, handle.snapshot().total, baseline);
    if offset != start_offset {
        info!(transfer_id = %handle.transfer_id, start_offset, "SFTP source changed since the checkpoint; restarting from zero");
    }
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let mut cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    loop {
        // Acquire (or re-acquire) a concurrency slot; the handle becomes Active.
        if !wait_for_active(&handle, &registry).await {
            handle.transition(TransferEvent::Cancel);
            cleanup_partial(&browser, direction, &remote_path, &local_path).await;
            emit(&handle, &sink, TransferPhase::Cancelled, None, None);
            registry.drop_entry(&handle.transfer_id);
            return;
        }
        emit(&handle, &sink, TransferPhase::Transferring, None, None);

        match run_attempts(
            &browser,
            direction,
            &remote_path,
            &local_path,
            &mut cursor,
            &handle,
            &sink,
            resume_mode,
        )
        .await
        {
            AttemptsResult::Completed => {
                info!(transfer_id = %handle.transfer_id, transferred = cursor.offset, "SFTP transfer complete");
                emit(&handle, &sink, TransferPhase::Done, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Cancelled => {
                info!(transfer_id = %handle.transfer_id, "SFTP transfer cancelled");
                cleanup_partial(&browser, direction, &remote_path, &local_path).await;
                emit(&handle, &sink, TransferPhase::Cancelled, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Paused => {
                // Release the slot so a queued peer can run while paused.
                registry.release_slot(&handle);
                emit(&handle, &sink, TransferPhase::Transferring, None, None);
                if !wait_for_resume(&handle).await {
                    handle.transition(TransferEvent::Cancel);
                    cleanup_partial(&browser, direction, &remote_path, &local_path).await;
                    emit(&handle, &sink, TransferPhase::Cancelled, None, None);
                    registry.drop_entry(&handle.transfer_id);
                    return;
                }
                handle.transition(TransferEvent::Resume); // Paused → Queued
            }
            AttemptsResult::FailedPermanent => {
                // Release the slot; keep the handle for a manual retry.
                registry.release_slot(&handle);
                if !wait_for_resume(&handle).await {
                    handle.transition(TransferEvent::Cancel);
                    cleanup_partial(&browser, direction, &remote_path, &local_path).await;
                    emit(&handle, &sink, TransferPhase::Cancelled, None, None);
                    registry.drop_entry(&handle.transfer_id);
                    return;
                }
                handle.set_attempt(0);
                handle.transition(TransferEvent::Retry); // Failed → Queued
            }
        }
    }
}

/// Best-effort removal of a partial destination on cancel/failure of a
/// remote→remote copy (PROD-0013). Mirrors the Upload arm of [`cleanup_partial`]
/// but resolves the destination through its own browser.
async fn cleanup_remote_partial(dst_browser: &Arc<SftpFileBrowser>, dst_path: &str) {
    match dst_browser.open_dedicated_channel().await {
        Ok(ch) => {
            if let Err(e) = ch.remove_file(dst_path).await {
                debug!(error = %e, "could not remove partial remote-to-remote copy (best-effort)");
            }
        }
        Err(e) => {
            debug!(error = %e, "could not open channel to clean partial remote-to-remote copy")
        }
    }
}

/// Run one remote→remote copy attempt on fresh dedicated channels, resuming from
/// `offset`: read the source remote file (seeked to `offset`) and stream it
/// straight to the destination remote file — no local staging file (PROD-0013).
///
/// A non-zero `offset` whose source read or destination append is rejected by
/// the server yields [`AttemptOutcome::ResumeRejected`] so the caller restarts
/// from zero, exactly like [`download_attempt`] / [`upload_attempt`].
async fn remote_copy_attempt<P, S>(
    src_channel: &SftpTransferChannel,
    dst_channel: &SftpTransferChannel,
    src_path: &str,
    dst_path: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, SftpTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    // Source read (seeked). A rejected non-zero offset → restart from zero.
    let mut src = match src_channel.open_read_at(src_path, offset).await {
        Ok(r) => r,
        Err(e) if offset > 0 => {
            warn!(offset, error = %e, "SFTP server rejected resume read; restarting from zero");
            return Ok(AttemptOutcome::ResumeRejected);
        }
        Err(e) => return Err(SftpTransferError::Ssh(format!("open source file: {e}"))),
    };

    // Destination write: append (no truncate) at the byte-verified offset, or a
    // truncating create for a fresh transfer.
    let mut dst = if offset > 0 {
        match dst_channel.open_write_at(dst_path, offset).await {
            Ok(w) => w,
            Err(e) => {
                warn!(offset, error = %e, "SFTP server rejected resume append; restarting from zero");
                return Ok(AttemptOutcome::ResumeRejected);
            }
        }
    } else {
        dst_channel
            .create_write(dst_path)
            .await
            .map_err(|e| SftpTransferError::Ssh(format!("create destination file: {e}")))?
    };

    let outcome = run_chunked_copy(
        &mut src,
        &mut dst,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        copy_error,
    )
    .await?;
    settle_writer(&mut dst, &outcome).await;
    Ok(map_copy_outcome(outcome))
}

/// Run attempts (with auto-retry/backoff) for one Active stint of a remote→remote
/// copy. The remote→remote counterpart of [`run_attempts`]: it opens a fresh
/// dedicated channel on **both** the source and destination browsers per attempt
/// and re-verifies the resume point (source fingerprint + destination size) on
/// those channels before every attempt.
#[allow(clippy::too_many_arguments)]
async fn run_remote_attempts(
    src_browser: &Arc<SftpFileBrowser>,
    dst_browser: &Arc<SftpFileBrowser>,
    src_path: &str,
    dst_path: &str,
    cursor: &mut ResumeCursor,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
    resume_mode: ResumeMode,
) -> AttemptsResult {
    let mut attempt = 0u32;
    loop {
        if handle.is_cancelled() {
            handle.transition(TransferEvent::Cancel);
            return AttemptsResult::Cancelled;
        }
        attempt += 1;
        handle.set_attempt(attempt);

        // Open a fresh dedicated channel per attempt on each end, so a broken
        // channel is re-established on retry and browsing stays live meanwhile.
        let src_channel = match src_browser.open_dedicated_channel().await {
            Ok(c) => c,
            Err(e) => {
                let e = SftpTransferError::Ssh(format!("open source SFTP transfer channel: {e}"));
                if let Some(outcome) = handle_attempt_error(handle, sink, attempt, &e).await {
                    return outcome;
                }
                continue;
            }
        };
        let dst_channel = match dst_browser.open_dedicated_channel().await {
            Ok(c) => c,
            Err(e) => {
                let e =
                    SftpTransferError::Ssh(format!("open destination SFTP transfer channel: {e}"));
                if let Some(outcome) = handle_attempt_error(handle, sink, attempt, &e).await {
                    return outcome;
                }
                continue;
            }
        };

        // Re-verify the resume point on this attempt's channels (PARITY-004).
        if resume_mode == ResumeMode::RestartOnly {
            cursor.offset = 0;
        } else {
            let current = src_channel.remote_fingerprint(src_path).await;
            let present = if cursor.offset > 0 {
                dst_channel.remote_file_size(dst_path).await
            } else {
                None
            };
            apply_resume_gate(cursor, handle, sink, current, present);
        }

        let progress = Arc::new(AtomicU64::new(cursor.offset));
        let mut reporter = ProgressReporter::new(
            handle.clone(),
            sink.clone(),
            cursor.total,
            progress.clone(),
            cursor.offset,
        );
        let stop_handle = handle.clone();
        let attempt_fut = remote_copy_attempt(
            &src_channel,
            &dst_channel,
            src_path,
            dst_path,
            cursor.offset,
            |t| reporter.report(t),
            move || stop_reason(&stop_handle),
        );
        let result = guard_stall(attempt_fut, &progress, handle, STALL_TIMEOUT).await;
        cursor.offset = progress.load(Ordering::Relaxed);

        if let Some(outcome) = settle_attempt(result, cursor, &mut attempt, handle, sink).await {
            return outcome;
        }
    }
}

/// Drive a queued **remote→remote** SFTP copy to a terminal state on the rich
/// queue model, emitting `transfer-progress` throughout (product feature
/// PROD-0013).
///
/// Streams the source session's file directly into the destination session's
/// file **through the desktop** — no local staging file — as ONE tracked
/// transfer. The counterpart of [`run_sftp_transfer`]: it shares the same slot
/// orchestration, throttled progress + ETA, pause/resume, auto-retry with
/// backoff, and byte-verified offset resume, so the generic
/// `transfer_pause`/`resume`/`retry`/`cancel` commands work for it too. Progress
/// is measured on the write (destination) side; cancel removes the partial
/// destination. A server-side host-to-host copy (SCP/rsync) is a deferred
/// alternative — this default reaches everywhere both hosts are reachable from
/// the desktop.
#[allow(clippy::too_many_arguments)]
pub async fn run_sftp_remote_copy(
    src_browser: Arc<SftpFileBrowser>,
    dst_browser: Arc<SftpFileBrowser>,
    src_path: String,
    dst_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    resume_mode: ResumeMode,
) {
    // Establish the source identity + total up front so progress/ETA are
    // meaningful and a later resume can detect a changed source (PARITY-004).
    let baseline = match src_browser.open_dedicated_channel().await {
        Ok(ch) => ch.remote_fingerprint(&src_path).await,
        Err(_) => None,
    };
    let total = match baseline {
        Some(fp) => fp.size,
        None => src_browser.remote_size(&src_path).await,
    };
    handle.set_metrics(0, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let mut cursor = ResumeCursor {
        offset: 0,
        total,
        baseline,
    };
    loop {
        // Acquire (or re-acquire) a concurrency slot; the handle becomes Active.
        if !wait_for_active(&handle, &registry).await {
            handle.transition(TransferEvent::Cancel);
            cleanup_remote_partial(&dst_browser, &dst_path).await;
            emit(&handle, &sink, TransferPhase::Cancelled, None, None);
            registry.drop_entry(&handle.transfer_id);
            return;
        }
        emit(&handle, &sink, TransferPhase::Transferring, None, None);

        match run_remote_attempts(
            &src_browser,
            &dst_browser,
            &src_path,
            &dst_path,
            &mut cursor,
            &handle,
            &sink,
            resume_mode,
        )
        .await
        {
            AttemptsResult::Completed => {
                info!(transfer_id = %handle.transfer_id, transferred = cursor.offset, "SFTP remote-to-remote copy complete");
                emit(&handle, &sink, TransferPhase::Done, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Cancelled => {
                info!(transfer_id = %handle.transfer_id, "SFTP remote-to-remote copy cancelled");
                cleanup_remote_partial(&dst_browser, &dst_path).await;
                emit(&handle, &sink, TransferPhase::Cancelled, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Paused => {
                // Release the slot so a queued peer can run while paused.
                registry.release_slot(&handle);
                emit(&handle, &sink, TransferPhase::Transferring, None, None);
                if !wait_for_resume(&handle).await {
                    handle.transition(TransferEvent::Cancel);
                    cleanup_remote_partial(&dst_browser, &dst_path).await;
                    emit(&handle, &sink, TransferPhase::Cancelled, None, None);
                    registry.drop_entry(&handle.transfer_id);
                    return;
                }
                handle.transition(TransferEvent::Resume); // Paused → Queued
            }
            AttemptsResult::FailedPermanent => {
                // Release the slot; keep the handle for a manual retry.
                registry.release_slot(&handle);
                if !wait_for_resume(&handle).await {
                    handle.transition(TransferEvent::Cancel);
                    cleanup_remote_partial(&dst_browser, &dst_path).await;
                    emit(&handle, &sink, TransferPhase::Cancelled, None, None);
                    registry.drop_entry(&handle.transfer_id);
                    return;
                }
                handle.set_attempt(0);
                handle.transition(TransferEvent::Retry); // Failed → Queued
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_mode_default_is_resume() {
        assert_eq!(ResumeMode::default(), ResumeMode::Resume);
        assert_eq!(DEFAULT_RESUME_MODE, ResumeMode::Resume);
    }

    #[test]
    fn map_copy_outcome_preserves_bytes_and_reason() {
        assert_eq!(
            map_copy_outcome(ChunkedCopyOutcome::Completed { transferred: 42 }),
            AttemptOutcome::Completed { transferred: 42 }
        );
        assert_eq!(
            map_copy_outcome(ChunkedCopyOutcome::Stopped {
                transferred: 10,
                reason: StopReason::Pause,
            }),
            AttemptOutcome::Stopped {
                transferred: 10,
                reason: StopReason::Pause,
            }
        );
    }
}
