//! FTP transfer executor — drives the queue state machine around the core
//! streaming primitive (issue #1336).
//!
//! `core`'s [`run_attempt`](termihub_core::backends::ftp::run_attempt) moves the
//! bytes for one attempt on its own connection; this module wraps it with the
//! desktop's orchestration: acquire a per-session concurrency slot, stream with
//! throttled progress + ETA, auto-retry with exponential backoff on error,
//! honour pause/resume and cancel, and drive the [`TransferHandle`] through its
//! `Queued → Active → …` states. It never holds a browsing connection, so
//! listing stays live while transfers run.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use termihub_core::backends::ftp::{
    probe_remote_size, run_attempt, AttemptOutcome, FtpDirection, StopReason,
};
use termihub_core::config::FtpConfig;
use tracing::{debug, info, warn};

use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{ProgressSink, ThroughputMeter, TransferPhase, TransferProgress, PROGRESS_THROTTLE};

/// Result of running the retry loop for one Active stint.
enum AttemptsResult {
    Completed,
    Cancelled,
    Paused,
    FailedPermanent,
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

/// Run attempts (with auto-retry/backoff) for one Active stint. Keeps the slot
/// across transient retries; returns once the transfer completes, is cancelled,
/// is paused, or exhausts its retry budget.
#[allow(clippy::too_many_arguments)]
async fn run_attempts(
    config: &FtpConfig,
    direction: FtpDirection,
    remote_path: &str,
    local_path: &str,
    offset: &mut u64,
    total: u64,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
) -> AttemptsResult {
    let mut attempt = 0u32;
    loop {
        if handle.is_cancelled() {
            handle.transition(TransferEvent::Cancel);
            return AttemptsResult::Cancelled;
        }
        attempt += 1;
        handle.set_attempt(attempt);

        let progress = Arc::new(AtomicU64::new(*offset));
        let mut reporter = ProgressReporter::new(
            handle.clone(),
            sink.clone(),
            total,
            progress.clone(),
            *offset,
        );
        let stop_handle = handle.clone();
        let result = run_attempt(
            config,
            direction,
            remote_path,
            local_path,
            *offset,
            |t| reporter.report(t),
            move || stop_reason(&stop_handle),
        )
        .await;
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
            Err(e) => {
                match super::backoff_delay(attempt) {
                    Some(delay) => {
                        // Transient failure: report `failed (n/max)` but keep the
                        // row alive (legacy phase stays `transferring`), wait the
                        // backoff, then retry from `offset` on the same slot.
                        handle.transition(TransferEvent::Fail { attempt });
                        warn!(transfer_id = %handle.transfer_id, attempt, error = %e, "FTP transfer attempt failed; retrying");
                        emit(
                            handle,
                            sink,
                            TransferPhase::Transferring,
                            None,
                            Some(e.to_string()),
                        );
                        if cancellable_backoff(handle, delay).await {
                            handle.transition(TransferEvent::Cancel);
                            return AttemptsResult::Cancelled;
                        }
                        handle.transition(TransferEvent::Retry);
                        handle.transition(TransferEvent::Activate);
                    }
                    None => {
                        handle.transition(TransferEvent::Fail { attempt });
                        warn!(transfer_id = %handle.transfer_id, attempt, error = %e, "FTP transfer failed permanently");
                        emit(
                            handle,
                            sink,
                            TransferPhase::Error,
                            None,
                            Some(e.to_string()),
                        );
                        return AttemptsResult::FailedPermanent;
                    }
                }
            }
        }
    }
}

/// Best-effort cleanup of a partial local download on cancel.
async fn cleanup_partial(direction: FtpDirection, local_path: &str) {
    if direction == FtpDirection::Download {
        if let Err(e) = tokio::fs::remove_file(local_path).await {
            debug!(error = %e, "could not remove partial FTP download (best-effort)");
        }
    }
}

/// Drive a queued FTP transfer to a terminal state, emitting `transfer-progress`
/// throughout. Consumes the handle registered via
/// [`TransferRegistry::enqueue`]; drops the registry entry on completion.
pub async fn run_ftp_transfer(
    config: FtpConfig,
    direction: FtpDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
) {
    // Establish the total up front so progress/ETA are meaningful.
    let total = match direction {
        FtpDirection::Download => probe_remote_size(&config, &remote_path).await.unwrap_or(0),
        FtpDirection::Upload => tokio::fs::metadata(&local_path)
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
            cleanup_partial(direction, &local_path).await;
            emit(&handle, &sink, TransferPhase::Cancelled, None, None);
            registry.drop_entry(&handle.transfer_id);
            return;
        }
        emit(&handle, &sink, TransferPhase::Transferring, None, None);

        match run_attempts(
            &config,
            direction,
            &remote_path,
            &local_path,
            &mut offset,
            total,
            &handle,
            &sink,
        )
        .await
        {
            AttemptsResult::Completed => {
                info!(transfer_id = %handle.transfer_id, transferred = offset, "FTP transfer complete");
                emit(&handle, &sink, TransferPhase::Done, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Cancelled => {
                info!(transfer_id = %handle.transfer_id, "FTP transfer cancelled");
                cleanup_partial(direction, &local_path).await;
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
                    cleanup_partial(direction, &local_path).await;
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
                    cleanup_partial(direction, &local_path).await;
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
