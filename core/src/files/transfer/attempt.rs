//! Backend-neutral attempt orchestration shared by the offset-resuming transfer
//! executors — SFTP (`super::sftp`), Docker (`super::docker`) and the local disk
//! (`super::local`) (PARITY-004, #3567).
//!
//! Lifted out of the SFTP executor so every streaming backend drives the queue
//! state machine the same way:
//!
//! - the per-attempt vocabulary ([`StopReason`], [`AttemptOutcome`],
//!   [`AttemptsResult`]) and the throttled [`ProgressReporter`];
//! - the slot / pause / resume / cancel waits and the retry/backoff policy
//!   ([`handle_attempt_error`], [`settle_attempt`]);
//! - the per-transfer [`ResumeCursor`] and the before-every-attempt resume gate
//!   over the pure [`decide_resume`];
//! - the stall watchdog ([`guard_stall`]) that turns a wedged attempt into a
//!   retryable failure;
//! - the outer stint loop ([`drive_transfer`]) that acquires a slot, runs one
//!   Active stint, and settles pause / cancel / permanent failure.
//!
//! Every backend keeps only its own streaming primitive and its error type.

use std::fmt::Display;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{debug, info, warn};

use super::registry::{TransferHandle, TransferRegistry};
use super::retry::{decide_resume, ResumeDecision, SourceFingerprint};
use super::state::TransferEvent;
use super::{ProgressSink, ThroughputMeter, TransferPhase, TransferProgress, PROGRESS_THROTTLE};
use crate::files::copy::ChunkedCopyOutcome;

/// Why an in-flight attempt stopped short of completion (partial bytes kept).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StopReason {
    /// The user requested a pause; the transfer can resume from the offset.
    Pause,
    /// The user requested cancellation; the caller cleans up the partial file.
    Cancel,
}

/// Outcome of running one transfer attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AttemptOutcome {
    /// The file was transferred to EOF. `transferred` is the total byte count.
    Completed { transferred: u64 },
    /// The `should_stop` probe asked to stop. `transferred` is the byte count
    /// reached so far (usable as a resume offset on the next attempt).
    Stopped {
        transferred: u64,
        reason: StopReason,
    },
    /// The peer cannot continue from a non-zero offset (a server rejecting the
    /// seek/append open, a container lacking the offset-read tool); the caller
    /// restarts this stint from byte zero. Never produced by the local
    /// executor (a local file can always be seeked), so it is unused when
    /// `local-transfer` is the only executor compiled in.
    #[cfg_attr(
        not(any(test, feature = "ssh", feature = "docker")),
        expect(dead_code, reason = "only the ssh/docker executors produce it")
    )]
    ResumeRejected,
}

/// Result of the retry loop for one Active stint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AttemptsResult {
    Completed,
    Cancelled,
    Paused,
    FailedPermanent,
}

/// Map a live handle's control flags to a stop decision for the copy loop.
pub(super) fn stop_reason(handle: &TransferHandle) -> Option<StopReason> {
    if handle.is_cancelled() {
        Some(StopReason::Cancel)
    } else if handle.take_pause_request() {
        Some(StopReason::Pause)
    } else {
        None
    }
}

/// Emit a `transfer-progress` event for `handle`'s current snapshot.
pub(super) fn emit(
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
pub(super) struct ProgressReporter {
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
    pub(super) fn new(
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

    pub(super) fn report(&mut self, transferred: u64) {
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
async fn cancellable_backoff(handle: &Arc<TransferHandle>, delay: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => handle.is_cancelled(),
        _ = handle.wait_for_signal() => handle.is_cancelled(),
    }
}

/// Translate a [`ChunkedCopyOutcome`] into an [`AttemptOutcome`].
pub(super) fn map_copy_outcome(outcome: ChunkedCopyOutcome<StopReason>) -> AttemptOutcome {
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

/// Best-effort: settle a writer after an attempt stopped short (pause/cancel)
/// so the bytes counted as transferred have actually landed — pipelined writes
/// are acknowledged asynchronously. A failure is harmless: the next attempt
/// byte-verifies the destination anyway.
pub(super) async fn settle_writer<W: tokio::io::AsyncWrite + Unpin>(
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

/// Resume bookkeeping carried across the attempts and Active stints of one
/// transfer (PARITY-004, #3567).
#[derive(Debug, Clone, Copy)]
pub(super) struct ResumeCursor {
    /// Bytes the previous attempt reached — the *requested* resume offset,
    /// re-verified by [`apply_resume_gate`] before the next attempt appends.
    pub(super) offset: u64,
    /// Source size (`0` = unknown).
    pub(super) total: u64,
    /// Source identity when the bytes now at the destination were read.
    pub(super) baseline: Option<SourceFingerprint>,
}

/// The offset a **rehydrated** transfer (relaunched from its persisted
/// checkpoint, #3199) may start from. Pure.
///
/// Only size survives a relaunch (the persisted record carries `total`, not an
/// mtime), so a source whose size no longer matches the persisted total has
/// changed while the app was closed → restart from zero. The destination is
/// still byte-verified before the first append.
pub(super) fn rehydrate_start_offset(
    start_offset: u64,
    persisted_total: u64,
    current: Option<SourceFingerprint>,
) -> u64 {
    if start_offset == 0 {
        return 0;
    }
    if persisted_total > 0 && current.map(|fp| fp.size) != Some(persisted_total) {
        return 0;
    }
    start_offset
}

/// Adopt `current` as the source baseline for a copy (re)starting from byte
/// zero, refreshing the known total.
pub(super) fn rebase_cursor(
    cursor: &mut ResumeCursor,
    handle: &TransferHandle,
    current: Option<SourceFingerprint>,
) {
    cursor.baseline = current;
    if let Some(fp) = current {
        cursor.total = fp.size;
    }
    handle.set_metrics(cursor.offset, cursor.total, 0);
}

/// Re-verify the resume point immediately before an attempt appends
/// (PARITY-004, #3567), using the source fingerprint and destination size just
/// read over the attempt's own channel.
///
/// Runs before **every** attempt, not once per stint: a retry after a dropped
/// connection must not trust the optimistic byte counter (pipelined writes can
/// be lost in flight — seeking past them would leave a hole), and the source
/// may have changed while the transfer was paused or backing off. Any doubt
/// restarts from byte zero, which is always correct. `backend` labels the logs.
pub(super) fn apply_resume_gate(
    cursor: &mut ResumeCursor,
    handle: &TransferHandle,
    sink: &ProgressSink,
    current: Option<SourceFingerprint>,
    present: Option<u64>,
    backend: &'static str,
) {
    if cursor.offset == 0 {
        rebase_cursor(cursor, handle, current);
        return;
    }
    let requested = cursor.offset;
    let decision = decide_resume(requested, cursor.baseline, current, present, cursor.total);
    cursor.offset = decision.offset();
    if cursor.offset == 0 {
        rebase_cursor(cursor, handle, current);
    }
    let id = &handle.transfer_id;
    match decision {
        ResumeDecision::Resume(offset) => {
            info!(backend, transfer_id = %id, requested, offset, "resuming from verified offset");
        }
        ResumeDecision::Fresh => {}
        ResumeDecision::RestartSourceChanged => {
            info!(backend, transfer_id = %id, requested, ?current, "source changed; restarting from zero");
            // Emitted after the rebase, so the event already shows the restart.
            emit(
                handle,
                sink,
                TransferPhase::Transferring,
                None,
                Some("source file changed; restarting from start".to_string()),
            );
        }
        ResumeDecision::RestartUnverified => {
            info!(backend, transfer_id = %id, requested, ?present, "partial failed byte-verify; restarting from zero");
        }
    }
}

/// Identity (size + mtime) of a local file, for the source-change gate.
pub(super) async fn local_fingerprint(path: &str) -> Option<SourceFingerprint> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_nanos()).ok());
    Some(SourceFingerprint {
        size: meta.len(),
        mtime,
    })
}

/// Size of a local file, or `None` when absent / un-stattable.
pub(super) async fn local_size(path: &str) -> Option<u64> {
    tokio::fs::metadata(path).await.map(|m| m.len()).ok()
}

/// Open the local destination for a resumed download: the existing partial is
/// opened for writing and the file pointer is seeked to `offset` so the copy
/// appends rather than truncates. A zero offset creates/truncates the file.
pub(super) async fn open_local_dest(
    local_path: &str,
    offset: u64,
) -> std::io::Result<tokio::fs::File> {
    use tokio::io::AsyncSeekExt;
    if offset == 0 {
        return tokio::fs::File::create(local_path).await;
    }
    let mut f = tokio::fs::OpenOptions::new()
        .write(true)
        .open(local_path)
        .await?;
    f.seek(std::io::SeekFrom::Start(offset)).await?;
    Ok(f)
}

/// Open the local source for a resumed upload: the file is opened for reading
/// and seeked to `offset` so only the not-yet-sent tail is streamed.
pub(super) async fn open_local_read(
    local_path: &str,
    offset: u64,
) -> std::io::Result<tokio::fs::File> {
    use tokio::io::AsyncSeekExt;
    let mut f = tokio::fs::File::open(local_path).await?;
    if offset > 0 {
        f.seek(std::io::SeekFrom::Start(offset)).await?;
    }
    Ok(f)
}

/// How long an attempt may go without moving a single byte before it is
/// abandoned as stalled and retried (PARITY-004, #3567).
///
/// Pipelined SFTP writes wait for their acknowledgements with **no** timeout
/// in `russh-sftp`, and a channel that dies mid-upload never resolves them, so
/// without this guard a dropped connection hangs the upload forever (and its
/// pause/cancel with it); a `docker exec` stream whose daemon connection wedges
/// behaves the same. Progress advances once per 256 KiB chunk, so 60 s only
/// trips below ~4 KiB/s — a link that slow is indistinguishable from a dead
/// one, and a false trip merely retries from the verified offset.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// How often [`guard_stall`] samples progress and the cancel flag.
const STALL_TICK: Duration = Duration::from_millis(250);

/// Drive one attempt under a stall watchdog: resolves with the attempt's own
/// result, with [`AttemptOutcome::Stopped`]/`Cancel` as soon as the transfer is
/// cancelled (even while an I/O call is wedged — the attempt future is dropped,
/// which tears down its channel / exec stream), or with `stalled(..)` once
/// `progress` has not moved for `stall_timeout` — which the retry loop treats
/// like any other failed attempt (backoff, fresh channel, verified resume).
pub(super) async fn guard_stall<F, E>(
    attempt: F,
    progress: &AtomicU64,
    handle: &TransferHandle,
    stall_timeout: Duration,
    stalled: fn(String) -> E,
) -> Result<AttemptOutcome, E>
where
    F: std::future::Future<Output = Result<AttemptOutcome, E>>,
{
    tokio::pin!(attempt);
    let mut last = progress.load(Ordering::Relaxed);
    let mut last_change = Instant::now();
    let mut tick = tokio::time::interval(STALL_TICK);
    loop {
        tokio::select! {
            result = &mut attempt => return result,
            _ = tick.tick() => {
                let now = progress.load(Ordering::Relaxed);
                if handle.is_cancelled() {
                    return Ok(AttemptOutcome::Stopped {
                        transferred: now,
                        reason: StopReason::Cancel,
                    });
                }
                if now != last {
                    last = now;
                    last_change = Instant::now();
                } else if last_change.elapsed() >= stall_timeout {
                    return Err(stalled(format!(
                        "transfer stalled: no data moved for {}s",
                        stall_timeout.as_secs()
                    )));
                }
            }
        }
    }
}

/// Apply the retry/backoff policy after a failed attempt. Returns `Some(...)`
/// when the stint should end (cancelled while backing off, or the retry budget
/// is exhausted), or `None` to loop and retry from the current offset.
pub(super) async fn handle_attempt_error<E: Display>(
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
    attempt: u32,
    e: &E,
    backend: &'static str,
) -> Option<AttemptsResult> {
    match super::backoff_delay(attempt) {
        Some(delay) => {
            handle.transition(TransferEvent::Fail { attempt });
            warn!(backend, transfer_id = %handle.transfer_id, attempt, error = %e, "transfer attempt failed; retrying");
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
            warn!(backend, transfer_id = %handle.transfer_id, attempt, error = %e, "transfer failed permanently");
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

/// Settle one attempt's result into the cursor and the handle's state.
/// Returns `Some(..)` when the stint ends, or `None` to run another attempt
/// (a rejected offset-resume, or a transient failure that is being retried).
///
/// `peer` names the far end in the restart message ("server", "container").
pub(super) async fn settle_attempt<E: Display>(
    result: Result<AttemptOutcome, E>,
    cursor: &mut ResumeCursor,
    attempt: &mut u32,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
    backend: &'static str,
    peer: &'static str,
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
            // The peer refused the offset open. Restart this stint from zero
            // (surfaced via `warn!` at the rejection); do not consume a retry.
            cursor.offset = 0;
            *attempt -= 1;
            emit(
                handle,
                sink,
                TransferPhase::Transferring,
                None,
                Some(format!(
                    "resume not supported by {peer}; restarting from start"
                )),
            );
            None
        }
        Err(e) => handle_attempt_error(handle, sink, *attempt, &e, backend).await,
    }
}

/// Settle a transfer that ends as cancelled: clean up the partial, emit the
/// terminal event, and drop the registry entry.
async fn finish_cancelled<C, CFut>(
    handle: &Arc<TransferHandle>,
    registry: &TransferRegistry,
    sink: &ProgressSink,
    cleanup: &C,
) where
    C: Fn() -> CFut,
    CFut: Future<Output = ()>,
{
    handle.transition(TransferEvent::Cancel);
    cleanup().await;
    emit(handle, sink, TransferPhase::Cancelled, None, None);
    registry.drop_entry(&handle.transfer_id);
}

/// Drive a queued transfer to a terminal state: acquire (or re-acquire) a
/// concurrency slot, run one Active stint via `stint`, and settle the result —
/// done, cancelled (with `cleanup` of the partial destination), paused (slot
/// released until a resume), or permanently failed (slot released, handle kept
/// for a manual retry). Consumes the handle's registry entry on exit.
///
/// The cursor is threaded through `stint` by value (it is `Copy`), which keeps
/// the stint future free of higher-ranked borrows so the whole transfer future
/// stays `Send` for `tokio::spawn`.
pub(super) async fn drive_transfer<S, SFut, C, CFut>(
    handle: &Arc<TransferHandle>,
    registry: &TransferRegistry,
    sink: &ProgressSink,
    backend: &'static str,
    mut cursor: ResumeCursor,
    mut stint: S,
    cleanup: C,
) where
    S: FnMut(ResumeCursor) -> SFut,
    SFut: Future<Output = (AttemptsResult, ResumeCursor)>,
    C: Fn() -> CFut,
    CFut: Future<Output = ()>,
{
    loop {
        if !wait_for_active(handle, registry).await {
            finish_cancelled(handle, registry, sink, &cleanup).await;
            return;
        }
        emit(handle, sink, TransferPhase::Transferring, None, None);

        let (result, next) = stint(cursor).await;
        cursor = next;
        match result {
            AttemptsResult::Completed => {
                info!(backend, transfer_id = %handle.transfer_id, transferred = cursor.offset, "transfer complete");
                emit(handle, sink, TransferPhase::Done, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Cancelled => {
                info!(backend, transfer_id = %handle.transfer_id, "transfer cancelled");
                cleanup().await;
                emit(handle, sink, TransferPhase::Cancelled, None, None);
                registry.drop_entry(&handle.transfer_id);
                return;
            }
            AttemptsResult::Paused => {
                // Release the slot so a queued peer can run while paused.
                registry.release_slot(handle);
                emit(handle, sink, TransferPhase::Transferring, None, None);
                if !wait_for_resume(handle).await {
                    finish_cancelled(handle, registry, sink, &cleanup).await;
                    return;
                }
                handle.transition(TransferEvent::Resume); // Paused → Queued
            }
            AttemptsResult::FailedPermanent => {
                // Release the slot; keep the handle for a manual retry.
                registry.release_slot(handle);
                if !wait_for_resume(handle).await {
                    finish_cancelled(handle, registry, sink, &cleanup).await;
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
    use crate::files::transfer::registry::TransferRegistry;
    use crate::files::transfer::{TransferDirection, TransferProgress};
    use std::sync::Mutex;

    fn fp(size: u64, mtime: u64) -> Option<SourceFingerprint> {
        Some(SourceFingerprint {
            size,
            mtime: Some(mtime),
        })
    }

    /// A handle plus a sink that records every emitted progress message.
    fn harness() -> (Arc<TransferHandle>, ProgressSink, Arc<Mutex<Vec<String>>>) {
        let reg = TransferRegistry::new();
        let handle = reg.enqueue("t1", "s1", TransferDirection::Upload, "f", "/f", 0);
        let messages = Arc::new(Mutex::new(Vec::new()));
        let sink_messages = messages.clone();
        let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
            if let Some(m) = &p.message {
                sink_messages.lock().expect("lock").push(m.clone());
            }
        });
        (handle, sink, messages)
    }

    #[derive(Debug)]
    struct TestErr(String);
    impl Display for TestErr {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
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

    #[test]
    fn rehydrate_fresh_transfer_starts_at_zero() {
        assert_eq!(rehydrate_start_offset(0, 1000, fp(1000, 1)), 0);
    }

    #[test]
    fn rehydrate_unchanged_source_keeps_checkpoint() {
        assert_eq!(rehydrate_start_offset(400, 1000, fp(1000, 1)), 400);
        // Unknown persisted total → nothing to compare; the destination is
        // still byte-verified before the first append.
        assert_eq!(rehydrate_start_offset(400, 0, fp(1200, 1)), 400);
    }

    #[test]
    fn rehydrate_changed_or_missing_source_restarts() {
        assert_eq!(rehydrate_start_offset(400, 1000, fp(1200, 1)), 0);
        assert_eq!(rehydrate_start_offset(400, 1000, None), 0);
    }

    #[test]
    fn gate_resumes_exact_partial_without_message() {
        let (handle, sink, messages) = harness();
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), Some(300), "T");
        assert_eq!(cursor.offset, 300);
        assert_eq!(cursor.baseline, fp(1000, 7));
        assert!(messages.lock().expect("lock").is_empty());
    }

    #[test]
    fn gate_never_seeks_past_bytes_that_landed() {
        // The optimistic counter says 300, but only 250 bytes reached the
        // destination before the drop → resume from 250 (no hole).
        let (handle, sink, _) = harness();
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), Some(250), "T");
        assert_eq!(cursor.offset, 250);
    }

    #[test]
    fn gate_restarts_and_rebases_when_source_changed() {
        let (handle, sink, messages) = harness();
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1500, 9), Some(300), "T");
        assert_eq!(cursor.offset, 0);
        assert_eq!(cursor.total, 1500);
        assert_eq!(cursor.baseline, fp(1500, 9));
        assert_eq!(handle.snapshot().total, 1500);
        assert_eq!(handle.snapshot().transferred, 0);
        assert_eq!(
            messages.lock().expect("lock").as_slice(),
            ["source file changed; restarting from start"]
        );
    }

    #[test]
    fn gate_restarts_when_destination_is_unverifiable() {
        let (handle, sink, _) = harness();
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), Some(400), "T");
        assert_eq!(cursor.offset, 0);
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), None, "T");
        assert_eq!(cursor.offset, 0);
    }

    #[test]
    fn gate_fresh_attempt_adopts_current_source_as_baseline() {
        let (handle, sink, _) = harness();
        let mut cursor = ResumeCursor {
            offset: 0,
            total: 0,
            baseline: None,
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(800, 3), None, "T");
        assert_eq!(cursor.offset, 0);
        assert_eq!(cursor.baseline, fp(800, 3));
        assert_eq!(cursor.total, 800);
    }

    #[tokio::test]
    async fn resume_rejected_restarts_without_consuming_a_retry() {
        let (handle, sink, messages) = harness();
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        let mut attempt = 2;
        let settled = settle_attempt::<TestErr>(
            Ok(AttemptOutcome::ResumeRejected),
            &mut cursor,
            &mut attempt,
            &handle,
            &sink,
            "T",
            "container",
        )
        .await;
        assert_eq!(settled, None);
        assert_eq!(cursor.offset, 0);
        assert_eq!(attempt, 1);
        assert_eq!(
            messages.lock().expect("lock").as_slice(),
            ["resume not supported by container; restarting from start"]
        );
    }

    #[tokio::test]
    async fn local_fingerprint_tracks_size_and_rewrites() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("src.bin");
        let path_str = path.to_str().expect("utf8");
        assert_eq!(local_fingerprint(path_str).await, None);
        std::fs::write(&path, b"hello").expect("write");
        let first = local_fingerprint(path_str).await.expect("fingerprint");
        assert_eq!(first.size, 5);
        assert!(first.mtime.is_some());
        std::fs::write(&path, b"hello world").expect("rewrite");
        let second = local_fingerprint(path_str).await.expect("fingerprint");
        assert!(!first.same_source(&second));
        assert_eq!(local_size(path_str).await, Some(11));
    }

    #[tokio::test]
    async fn open_local_dest_truncates_fresh_and_appends_at_offset() {
        use tokio::io::AsyncWriteExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dst.bin");
        let path_str = path.to_str().expect("utf8");
        std::fs::write(&path, b"stale-content").expect("write");
        let mut f = open_local_dest(path_str, 0).await.expect("create");
        f.write_all(b"abc").await.expect("write");
        f.flush().await.expect("flush");
        drop(f);
        assert_eq!(std::fs::read(&path).expect("read"), b"abc");
        let mut f = open_local_dest(path_str, 3).await.expect("append");
        f.write_all(b"def").await.expect("write");
        f.flush().await.expect("flush");
        drop(f);
        assert_eq!(std::fs::read(&path).expect("read"), b"abcdef");
    }

    #[tokio::test]
    async fn guard_stall_passes_through_a_finished_attempt() {
        let (handle, _, _) = harness();
        let progress = AtomicU64::new(0);
        let result = guard_stall(
            async { Ok(AttemptOutcome::Completed { transferred: 9 }) },
            &progress,
            &handle,
            Duration::from_secs(5),
            TestErr,
        )
        .await;
        assert!(matches!(
            result,
            Ok(AttemptOutcome::Completed { transferred: 9 })
        ));
    }

    #[tokio::test]
    async fn guard_stall_fails_a_wedged_attempt() {
        let (handle, _, _) = harness();
        let progress = AtomicU64::new(42);
        let result = guard_stall(
            std::future::pending(),
            &progress,
            &handle,
            Duration::from_millis(300),
            TestErr,
        )
        .await;
        let err = result.expect_err("a wedged attempt must fail as stalled");
        assert!(err.to_string().contains("stalled"), "{err}");
    }

    #[tokio::test]
    async fn guard_stall_tolerates_slow_but_moving_progress() {
        let (handle, _, _) = harness();
        let progress = Arc::new(AtomicU64::new(0));
        let mover = progress.clone();
        let attempt = async move {
            // Moves a byte every 200 ms for ~1.2 s: longer than the stall
            // timeout overall, but never idle for that long.
            for i in 1..=6u64 {
                tokio::time::sleep(Duration::from_millis(200)).await;
                mover.store(i, Ordering::Relaxed);
            }
            Ok(AttemptOutcome::Completed { transferred: 6 })
        };
        let result = guard_stall(
            attempt,
            &progress,
            &handle,
            Duration::from_millis(700),
            TestErr,
        )
        .await;
        assert!(matches!(
            result,
            Ok(AttemptOutcome::Completed { transferred: 6 })
        ));
    }

    #[tokio::test]
    async fn guard_stall_cancels_a_wedged_attempt_promptly() {
        let reg = TransferRegistry::new();
        let handle = reg.enqueue("c1", "s1", TransferDirection::Upload, "f", "/f", 0);
        assert!(reg.cancel("c1"));
        let progress = AtomicU64::new(7);
        let result = guard_stall(
            std::future::pending(),
            &progress,
            &handle,
            Duration::from_secs(60),
            TestErr,
        )
        .await;
        assert!(matches!(
            result,
            Ok(AttemptOutcome::Stopped {
                transferred: 7,
                reason: StopReason::Cancel,
            })
        ));
    }
}
