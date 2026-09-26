//! Resume-correctness helpers for the SFTP transfer executor (PARITY-004,
//! #3567): the per-transfer [`ResumeCursor`], the before-every-attempt resume
//! gate over the pure [`decide_resume`], the rehydrate check, and the stall
//! watchdog that turns a wedged attempt into a retryable failure.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use tracing::info;

use super::{emit, AttemptOutcome, SftpTransferError, StopReason};
use crate::files::transfer::registry::TransferHandle;
use crate::files::transfer::retry::{decide_resume, ResumeDecision, SourceFingerprint};
use crate::files::transfer::{ProgressSink, TransferPhase};

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
/// read over the attempt's own channels.
///
/// Runs before **every** attempt, not once per stint: a retry after a dropped
/// connection must not trust the optimistic byte counter (pipelined SFTP writes
/// can be lost in flight — seeking past them would leave a hole), and the
/// source may have changed while the transfer was paused or backing off. Any
/// doubt restarts from byte zero, which is always correct.
pub(super) fn apply_resume_gate(
    cursor: &mut ResumeCursor,
    handle: &TransferHandle,
    sink: &ProgressSink,
    current: Option<SourceFingerprint>,
    present: Option<u64>,
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
            info!(transfer_id = %id, requested, offset, "SFTP resuming from verified offset");
        }
        ResumeDecision::Fresh => {}
        ResumeDecision::RestartSourceChanged => {
            info!(transfer_id = %id, requested, ?current, "SFTP source changed; restarting from zero");
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
            info!(transfer_id = %id, requested, ?present, "SFTP partial failed byte-verify; restarting from zero");
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

/// How long an attempt may go without moving a single byte before it is
/// abandoned as stalled and retried (PARITY-004, #3567).
///
/// Pipelined SFTP writes wait for their acknowledgements with **no** timeout
/// in `russh-sftp`, and a channel that dies mid-upload never resolves them, so
/// without this guard a dropped connection hangs the upload forever (and its
/// pause/cancel with it). Every other SFTP request already times out after
/// `russh-sftp`'s 10 s default, so this sits comfortably above that.
pub const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How often [`guard_stall`] samples progress and the cancel flag.
const STALL_TICK: std::time::Duration = std::time::Duration::from_millis(250);

/// Drive one attempt under a stall watchdog: resolves with the attempt's own
/// result, with [`AttemptOutcome::Stopped`]/`Cancel` as soon as the transfer is
/// cancelled (even while an I/O call is wedged), or with an error once
/// `progress` has not moved for `stall_timeout` — which the retry loop treats
/// like any other failed attempt (backoff, fresh channel, verified resume).
pub(super) async fn guard_stall<F>(
    attempt: F,
    progress: &AtomicU64,
    handle: &TransferHandle,
    stall_timeout: std::time::Duration,
) -> Result<AttemptOutcome, SftpTransferError>
where
    F: std::future::Future<Output = Result<AttemptOutcome, SftpTransferError>>,
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
                    return Err(SftpTransferError::Ssh(format!(
                        "transfer stalled: no data moved for {}s",
                        stall_timeout.as_secs()
                    )));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::transfer::registry::TransferRegistry;
    use crate::files::transfer::{TransferDirection, TransferProgress};
    use std::sync::Arc;
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
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), Some(300));
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
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), Some(250));
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
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1500, 9), Some(300));
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
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), Some(400));
        assert_eq!(cursor.offset, 0);
        let mut cursor = ResumeCursor {
            offset: 300,
            total: 1000,
            baseline: fp(1000, 7),
        };
        apply_resume_gate(&mut cursor, &handle, &sink, fp(1000, 7), None);
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
        apply_resume_gate(&mut cursor, &handle, &sink, fp(800, 3), None);
        assert_eq!(cursor.offset, 0);
        assert_eq!(cursor.baseline, fp(800, 3));
        assert_eq!(cursor.total, 800);
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
    async fn guard_stall_passes_through_a_finished_attempt() {
        let (handle, _, _) = harness();
        let progress = AtomicU64::new(0);
        let result = guard_stall(
            async { Ok(AttemptOutcome::Completed { transferred: 9 }) },
            &progress,
            &handle,
            std::time::Duration::from_secs(5),
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
            std::time::Duration::from_millis(300),
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
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                mover.store(i, Ordering::Relaxed);
            }
            Ok(AttemptOutcome::Completed { transferred: 6 })
        };
        let result = guard_stall(
            attempt,
            &progress,
            &handle,
            std::time::Duration::from_millis(700),
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
            std::time::Duration::from_secs(60),
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
