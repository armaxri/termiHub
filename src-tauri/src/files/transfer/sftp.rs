//! SFTP transfer executor — drives the queue state machine around a dedicated
//! [`SftpTransferChannel`] copy (product feature PROD-0012).
//!
//! This is the SFTP counterpart to [`super::ftp`]. Where the legacy SFTP path
//! ([`super::run_download`] / [`super::run_upload`]) was a single-shot,
//! cancel-only chunked copy, this executor wraps the same core streaming
//! primitive with the desktop's full **queue orchestration**: acquire a
//! per-session concurrency slot, stream with throttled progress + ETA,
//! auto-retry with exponential backoff on error, honour pause/resume and
//! cancel, and drive the [`TransferHandle`] through its `Queued → Active → …`
//! states. Each attempt opens its **own** dedicated SFTP channel off the shared
//! [`SftpFileBrowser`], so the browsing session stays live during a transfer
//! and a broken channel is re-established transparently on retry.
//!
//! **Resume (PROD-0012).** A paused or retried transfer resumes from the byte
//! offset already at the destination. Before appending, the offset is
//! *byte-verified* — the destination must already hold exactly `offset` bytes
//! (re-`stat`'d each stint) — mirroring [`super::retry::resume_offset`]; on any
//! mismatch, or when the server rejects the seek/append open, the transfer
//! restarts from zero and surfaces which path it took. The resume protocol is
//! selectable via [`ResumeMode`] (maintainer default: [`DEFAULT_RESUME_MODE`]).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use termihub_core::backends::ssh::{SftpFileBrowser, SftpTransferChannel};
use termihub_core::files::copy::{run_chunked_copy, ChunkedCopyOutcome, CopyPhase};
use tracing::{debug, info, warn};

use super::registry::{TransferHandle, TransferRegistry};
use super::retry::resume_offset;
use super::state::TransferEvent;
use super::{
    ProgressSink, ThroughputMeter, TransferDirection, TransferPhase, TransferProgress, CHUNK_SIZE,
    PROGRESS_THROTTLE,
};
use crate::utils::errors::TerminalError;

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

/// The byte offset a resume may safely start from, given the offset requested,
/// the bytes actually present at the destination, and the (optional) total size.
///
/// This is the byte-verification gate (PROD-0012): the destination must already
/// hold *exactly* `requested` bytes, otherwise a stale/divergent partial cannot
/// be trusted and the transfer restarts from zero. When the count matches, the
/// value is passed through [`resume_offset`] so a resume never seeks past a
/// known EOF. Pure function — unit-tested directly.
fn verified_offset(requested: u64, present: Option<u64>, total: u64) -> u64 {
    if requested == 0 {
        return 0;
    }
    // Byte-verify: the destination must already hold exactly `requested` bytes.
    // An un-stattable destination (`None`) is treated as untrustworthy.
    if present != Some(requested) {
        return 0;
    }
    resume_offset(requested, (total > 0).then_some(total))
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

/// Map a chunked-copy phase error to a [`TerminalError`], preserving the text.
fn copy_error(phase: CopyPhase, e: std::io::Error) -> TerminalError {
    let what = match phase {
        CopyPhase::Read => "read",
        CopyPhase::Write => "write",
        CopyPhase::Flush => "flush",
    };
    TerminalError::SshError(format!("transfer {what} failed: {e}"))
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
) -> Result<AttemptOutcome, TerminalError>
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
        Err(e) => return Err(TerminalError::SshError(format!("open remote file: {e}"))),
    };

    // Local destination: append to the verified partial, or truncate for a
    // fresh transfer. The partial was written by us and byte-verified by the
    // caller, so a local open/seek failure here is a genuine error.
    let mut local = if offset > 0 {
        open_local_append(local_path, offset)
            .await
            .map_err(|e| TerminalError::SshError(format!("open local file for append: {e}")))?
    } else {
        tokio::fs::File::create(local_path)
            .await
            .map_err(|e| TerminalError::SshError(format!("create local file: {e}")))?
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
) -> Result<AttemptOutcome, TerminalError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    // Local source: seek to the offset already sent (byte-verified by caller).
    let mut local = open_local_read(local_path, offset)
        .await
        .map_err(|e| TerminalError::SshError(format!("open local file: {e}")))?;

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
            .map_err(|e| TerminalError::SshError(format!("create remote file: {e}")))?
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

/// Bytes currently present at the transfer's destination, for byte-verifying a
/// resume offset. Download → the local file; Upload → the remote file.
async fn destination_present(
    browser: &Arc<SftpFileBrowser>,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
) -> Option<u64> {
    match direction {
        TransferDirection::Download => tokio::fs::metadata(local_path).await.map(|m| m.len()).ok(),
        TransferDirection::Upload => match browser.open_dedicated_channel().await {
            Ok(ch) => ch.remote_file_size(remote_path).await,
            Err(_) => None,
        },
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
    offset: &mut u64,
    total: u64,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
    resume_mode: ResumeMode,
) -> AttemptsResult {
    // Byte-verify the resume offset once per Active stint, before the first
    // attempt of the stint appends to the destination (PROD-0012).
    if resume_mode == ResumeMode::RestartOnly {
        *offset = 0;
    } else if *offset > 0 {
        let present = destination_present(browser, direction, remote_path, local_path).await;
        let verified = verified_offset(*offset, present, total);
        if verified != *offset {
            info!(
                transfer_id = %handle.transfer_id,
                requested = *offset, ?present, verified,
                "SFTP resume offset failed byte-verify; restarting from zero"
            );
        } else {
            info!(transfer_id = %handle.transfer_id, offset = verified, "SFTP resuming from offset");
        }
        *offset = verified;
    }

    let mut attempt = 0u32;
    loop {
        if handle.is_cancelled() {
            handle.transition(TransferEvent::Cancel);
            return AttemptsResult::Cancelled;
        }
        attempt += 1;
        handle.set_attempt(attempt);

        // Open a fresh dedicated channel per attempt, so a broken channel is
        // re-established on retry and browsing stays live meanwhile.
        let channel = match browser.open_dedicated_channel().await {
            Ok(c) => c,
            Err(e) => {
                let e = TerminalError::SshError(format!("open SFTP transfer channel: {e}"));
                if let Some(outcome) = handle_attempt_error(handle, sink, attempt, &e).await {
                    return outcome;
                }
                continue;
            }
        };

        let progress = Arc::new(AtomicU64::new(*offset));
        let mut reporter = ProgressReporter::new(
            handle.clone(),
            sink.clone(),
            total,
            progress.clone(),
            *offset,
        );
        let stop_handle = handle.clone();
        let result = match direction {
            TransferDirection::Download => {
                download_attempt(
                    &channel,
                    remote_path,
                    local_path,
                    *offset,
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
                    *offset,
                    |t| reporter.report(t),
                    move || stop_reason(&stop_handle),
                )
                .await
            }
        };
        *offset = progress.load(Ordering::Relaxed);

        match result {
            Ok(AttemptOutcome::Completed { transferred }) => {
                *offset = transferred;
                handle.set_metrics(transferred, total.max(transferred), 0);
                handle.transition(TransferEvent::Complete);
                return AttemptsResult::Completed;
            }
            Ok(AttemptOutcome::Stopped {
                transferred,
                reason: StopReason::Cancel,
            }) => {
                *offset = transferred;
                handle.transition(TransferEvent::Cancel);
                return AttemptsResult::Cancelled;
            }
            Ok(AttemptOutcome::Stopped {
                transferred,
                reason: StopReason::Pause,
            }) => {
                *offset = transferred;
                handle.transition(TransferEvent::Pause);
                return AttemptsResult::Paused;
            }
            Ok(AttemptOutcome::ResumeRejected) => {
                // The server refused the offset open. Restart this stint from
                // zero (surfaced above via `warn!`); do not consume a retry.
                *offset = 0;
                attempt -= 1;
                emit(
                    handle,
                    sink,
                    TransferPhase::Transferring,
                    None,
                    Some("resume not supported by server; restarting from start".to_string()),
                );
                continue;
            }
            Err(e) => {
                if let Some(outcome) = handle_attempt_error(handle, sink, attempt, &e).await {
                    return outcome;
                }
            }
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
    e: &TerminalError,
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
/// registry entry on completion. Mirrors [`super::ftp::run_ftp_transfer`], so
/// the generic `transfer_pause`/`resume`/`retry` commands work for SFTP.
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
) {
    // Establish the total up front so progress/ETA are meaningful.
    let total = match direction {
        TransferDirection::Download => browser.remote_size(&remote_path).await,
        TransferDirection::Upload => tokio::fs::metadata(&local_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0),
    };
    handle.set_metrics(0, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let mut offset = 0u64;
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
            &mut offset,
            total,
            &handle,
            &sink,
            resume_mode,
        )
        .await
        {
            AttemptsResult::Completed => {
                info!(transfer_id = %handle.transfer_id, transferred = offset, "SFTP transfer complete");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_offset_zero_request_never_resumes() {
        assert_eq!(verified_offset(0, Some(0), 100), 0);
        assert_eq!(verified_offset(0, None, 100), 0);
    }

    #[test]
    fn verified_offset_matching_partial_resumes() {
        // Destination holds exactly the requested bytes, below the total.
        assert_eq!(verified_offset(300, Some(300), 1000), 300);
    }

    #[test]
    fn verified_offset_mismatch_restarts_from_zero() {
        // Destination diverged from the requested offset — can't be trusted.
        assert_eq!(verified_offset(300, Some(250), 1000), 0);
        assert_eq!(verified_offset(300, Some(400), 1000), 0);
    }

    #[test]
    fn verified_offset_unstattable_destination_restarts() {
        // No size available → treat the partial as untrustworthy.
        assert_eq!(verified_offset(300, None, 1000), 0);
    }

    #[test]
    fn verified_offset_complete_or_oversized_restarts() {
        // present == requested == total → already complete; don't seek past EOF.
        assert_eq!(verified_offset(1000, Some(1000), 1000), 0);
        // present == requested but beyond a (smaller) known total → restart.
        assert_eq!(verified_offset(1200, Some(1200), 1000), 0);
    }

    #[test]
    fn verified_offset_unknown_total_resumes_from_verified_partial() {
        // total == 0 (indeterminate) but the partial byte-verifies → resume.
        assert_eq!(verified_offset(500, Some(500), 0), 500);
    }

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
