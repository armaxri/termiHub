//! Docker transfer executor — drives the queue state machine around a
//! streaming `docker exec` copy (PARITY-004, #3567).
//!
//! The Docker counterpart of [`run_sftp_transfer`](super::sftp::run_sftp_transfer):
//! the same shared orchestration ([`super::attempt`]) — per-session slot,
//! throttled progress + ETA, pause/resume, cancel, auto-retry with backoff, the
//! stall watchdog — around the container streaming primitives in
//! [`crate::backends::docker::DockerTransferTarget`]. Each attempt runs its own
//! exec, so browsing stays live and a killed/dropped exec is simply retried.
//! Memory is bounded to one copy chunk: the file is never loaded whole (unlike
//! the browsing path's base64 `read_file` / `write_file`).
//!
//! **Resume.** A paused or retried transfer continues from the bytes actually
//! at the destination — `tail -c +N` for a download, `cat >>` for an upload —
//! re-verified before **every** attempt by the shared resume gate: the source
//! must still match its size + mtime fingerprint and the destination must hold
//! a prefix we wrote. The container is probed once per transfer for the tools
//! this needs; when it lacks one (a minimal image without `tail`, `stat` or
//! `wc`), resume is **refused** and the transfer restarts from byte zero rather
//! than risk a corrupt splice.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::OnceCell;
use tracing::{debug, info, warn};

use crate::backends::docker::{ContainerCaps, DockerTransferTarget};
use crate::files::copy::{run_chunked_copy, ChunkedCopyOutcome, CopyPhase};

use super::attempt::{
    apply_resume_gate, drive_transfer, emit, guard_stall, local_fingerprint, local_size,
    map_copy_outcome, open_local_dest, open_local_read, rehydrate_start_offset, settle_attempt,
    settle_writer, stop_reason, AttemptOutcome, AttemptsResult, ProgressReporter, ResumeCursor,
    StopReason, STALL_TIMEOUT,
};
use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{ProgressSink, SourceFingerprint, TransferDirection, TransferPhase, CHUNK_SIZE};

/// Log label for the shared attempt orchestration.
const BACKEND: &str = "Docker";

/// Core-internal error type for the Docker executor. It never escapes (the
/// public executor returns `()`); its `Display` becomes the progress message.
#[derive(Debug, thiserror::Error)]
enum DockerTransferError {
    #[error("Docker error: {0}")]
    Exec(String),
}

/// Map a chunked-copy phase error, preserving the text.
fn copy_error(phase: CopyPhase, e: std::io::Error) -> DockerTransferError {
    let what = match phase {
        CopyPhase::Read => "read",
        CopyPhase::Write => "write",
        CopyPhase::Flush => "flush",
    };
    DockerTransferError::Exec(format!("transfer {what} failed: {e}"))
}

/// Whether the container's tools allow verifying and continuing a partial
/// copy in `direction`. Pure.
///
/// - download: `tail -c +N` to read from the offset **and** `stat` to prove
///   the container-side source is unchanged;
/// - upload: `wc -c` to measure the container-side partial (the local source
///   is fingerprinted locally).
fn resume_supported(caps: ContainerCaps, direction: TransferDirection) -> bool {
    match direction {
        TransferDirection::Download => caps.offset_read && caps.stat,
        TransferDirection::Upload => caps.size,
    }
}

/// Source fingerprint for `direction`: `stat` in the container for a
/// download, local metadata for an upload.
async fn source_fingerprint(
    target: &DockerTransferTarget,
    caps: ContainerCaps,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
) -> Option<SourceFingerprint> {
    match direction {
        TransferDirection::Download if caps.stat => target.fingerprint(remote_path).await,
        TransferDirection::Download => None,
        TransferDirection::Upload => local_fingerprint(local_path).await,
    }
}

/// Run one download attempt on its own exec, from `offset`.
async fn download_attempt<P, S>(
    target: &DockerTransferTarget,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, DockerTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut reader = target
        .open_read(remote_path, offset)
        .await
        .map_err(|e| DockerTransferError::Exec(format!("open container file: {e}")))?;
    let mut local = open_local_dest(local_path, offset)
        .await
        .map_err(|e| DockerTransferError::Exec(format!("open local file: {e}")))?;
    let outcome = run_chunked_copy(
        &mut reader,
        &mut local,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        copy_error,
    )
    .await?;
    settle_writer(&mut local, &outcome).await;
    if matches!(outcome, ChunkedCopyOutcome::Completed { .. }) {
        // EOF alone proves nothing: a killed `cat`/`tail` also ends stdout.
        // Only a clean exit means the whole file arrived.
        reader
            .finish()
            .await
            .map_err(|e| DockerTransferError::Exec(format!("container read failed: {e}")))?;
    }
    // A stopped attempt drops the reader, closing the exec stream.
    Ok(map_copy_outcome(outcome))
}

/// Run one upload attempt on its own exec, appending from `offset`.
async fn upload_attempt<P, S>(
    target: &DockerTransferTarget,
    local_path: &str,
    remote_path: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, DockerTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut local = open_local_read(local_path, offset)
        .await
        .map_err(|e| DockerTransferError::Exec(format!("open local file: {e}")))?;
    let mut writer = target
        .open_write(remote_path, offset > 0)
        .await
        .map_err(|e| DockerTransferError::Exec(format!("open container file: {e}")))?;
    let outcome = run_chunked_copy(
        &mut local,
        &mut writer,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        copy_error,
    )
    .await?;
    match outcome {
        ChunkedCopyOutcome::Completed { .. } => {
            // Close stdin and wait for `cat` to exit 0: only then is the file
            // complete in the container.
            writer
                .finish()
                .await
                .map_err(|e| DockerTransferError::Exec(format!("container write failed: {e}")))?;
        }
        ChunkedCopyOutcome::Stopped { .. } => {
            // Best-effort settle so the bytes counted as sent have landed; the
            // next attempt measures the destination anyway.
            if let Err(e) = writer.finish().await {
                debug!(error = %e, "could not settle container writer after stop (best-effort)");
            }
        }
    }
    Ok(map_copy_outcome(outcome))
}

/// Probe the container once per transfer (cached across attempts and stints).
async fn ensure_caps(
    target: &DockerTransferTarget,
    caps: &OnceCell<ContainerCaps>,
) -> Result<ContainerCaps, DockerTransferError> {
    caps.get_or_try_init(|| probe_caps(target)).await.copied()
}

/// Probe the container's streaming tools; a container without `cat` cannot
/// stream at all.
async fn probe_caps(target: &DockerTransferTarget) -> Result<ContainerCaps, DockerTransferError> {
    let probed = target
        .probe()
        .await
        .map_err(|e| DockerTransferError::Exec(format!("probe container tools: {e}")))?;
    if !probed.cat {
        return Err(DockerTransferError::Exec(
            "container has no `cat`; streaming transfer unavailable".to_string(),
        ));
    }
    info!(
        container = target.container_id(),
        ?probed,
        "Docker transfer tools probed"
    );
    Ok(probed)
}

/// Re-verify the resume point before an attempt via the shared gate, over a
/// freshly-read source fingerprint and destination size.
#[allow(clippy::too_many_arguments)]
async fn gate_resume(
    target: &DockerTransferTarget,
    caps: ContainerCaps,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
    cursor: &mut ResumeCursor,
    handle: &TransferHandle,
    sink: &ProgressSink,
) {
    let current = source_fingerprint(target, caps, direction, remote_path, local_path).await;
    let present = if cursor.offset == 0 {
        None
    } else {
        match direction {
            TransferDirection::Download => local_size(local_path).await,
            TransferDirection::Upload => target.file_size(remote_path).await,
        }
    };
    apply_resume_gate(cursor, handle, sink, current, present, BACKEND);
}

/// Run attempts (with auto-retry/backoff) for one Active stint.
#[allow(clippy::too_many_arguments)]
async fn run_attempts(
    target: &DockerTransferTarget,
    caps: &OnceCell<ContainerCaps>,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
    cursor: &mut ResumeCursor,
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

        let result = match ensure_caps(target, caps).await {
            Ok(probed) if cursor.offset > 0 && !resume_supported(probed, direction) => {
                // Refuse rather than guess: the shared settle restarts the
                // stint from zero (without consuming a retry) and says why.
                warn!(transfer_id = %handle.transfer_id, offset = cursor.offset, ?probed, "container cannot verify a resume; restarting from zero");
                Ok(AttemptOutcome::ResumeRejected)
            }
            Ok(probed) => {
                gate_resume(
                    target,
                    probed,
                    direction,
                    remote_path,
                    local_path,
                    cursor,
                    handle,
                    sink,
                )
                .await;
                run_one(
                    target,
                    direction,
                    remote_path,
                    local_path,
                    cursor,
                    handle,
                    sink,
                )
                .await
            }
            Err(e) => Err(e),
        };

        if let Some(outcome) = settle_attempt(
            result,
            cursor,
            &mut attempt,
            handle,
            sink,
            BACKEND,
            "container",
        )
        .await
        {
            return outcome;
        }
    }
}

/// Run a single attempt from `cursor.offset` under the stall watchdog,
/// advancing the cursor to the bytes it reached.
async fn run_one(
    target: &DockerTransferTarget,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
    cursor: &mut ResumeCursor,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
) -> Result<AttemptOutcome, DockerTransferError> {
    let progress = Arc::new(AtomicU64::new(cursor.offset));
    let mut reporter = ProgressReporter::new(
        handle.clone(),
        sink.clone(),
        cursor.total,
        progress.clone(),
        cursor.offset,
    );
    let stop_handle = handle.clone();
    let offset = cursor.offset;
    let attempt_fut = async {
        match direction {
            TransferDirection::Download => {
                download_attempt(
                    target,
                    remote_path,
                    local_path,
                    offset,
                    |t| reporter.report(t),
                    move || stop_reason(&stop_handle),
                )
                .await
            }
            TransferDirection::Upload => {
                upload_attempt(
                    target,
                    local_path,
                    remote_path,
                    offset,
                    |t| reporter.report(t),
                    move || stop_reason(&stop_handle),
                )
                .await
            }
        }
    };
    let result = guard_stall(
        attempt_fut,
        &progress,
        handle,
        STALL_TIMEOUT,
        DockerTransferError::Exec,
    )
    .await;
    cursor.offset = progress.load(Ordering::Relaxed);
    result
}

/// Best-effort cleanup of a partial destination on cancel.
async fn cleanup_partial(
    target: &DockerTransferTarget,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
) {
    match direction {
        TransferDirection::Download => {
            if let Err(e) = tokio::fs::remove_file(local_path).await {
                debug!(error = %e, "could not remove partial Docker download (best-effort)");
            }
        }
        TransferDirection::Upload => {
            if let Err(e) = target.remove_file(remote_path).await {
                debug!(error = %e, "could not remove partial Docker upload (best-effort)");
            }
        }
    }
}

/// Drive a queued Docker transfer to a terminal state on the rich queue
/// model, emitting `transfer-progress` throughout (PARITY-004, #3567).
///
/// Consumes the handle registered via [`TransferRegistry::enqueue`]; drops the
/// registry entry on completion, so the generic `transfer_pause` / `resume` /
/// `retry` / `cancel` commands work exactly as for SFTP and FTP.
///
/// `start_offset` seeds the first stint's resume offset (`0` for a fresh
/// transfer; a relaunched checkpoint passes its persisted offset). It is still
/// verified against the destination before any append.
#[allow(clippy::too_many_arguments)]
pub async fn run_docker_transfer(
    target: DockerTransferTarget,
    direction: TransferDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    start_offset: u64,
) {
    // Probe up front so the baseline fingerprint and total are meaningful; a
    // failed probe is retried by the first attempt.
    let caps = OnceCell::new();
    let probed = ensure_caps(&target, &caps).await.ok();
    let baseline = match probed {
        Some(c) => source_fingerprint(&target, c, direction, &remote_path, &local_path).await,
        None if direction == TransferDirection::Upload => local_fingerprint(&local_path).await,
        None => None,
    };
    let total = match (baseline, direction) {
        (Some(fp), _) => fp.size,
        (None, TransferDirection::Download) => {
            target.file_size(&remote_path).await.unwrap_or_default()
        }
        (None, TransferDirection::Upload) => 0,
    };
    let offset = rehydrate_start_offset(start_offset, handle.snapshot().total, baseline);
    if offset != start_offset {
        info!(transfer_id = %handle.transfer_id, start_offset, "Docker source changed since the checkpoint; restarting from zero");
    }
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    let (target, caps, remote_path, local_path, handle, sink) =
        (&target, &caps, &remote_path, &local_path, &handle, &sink);
    drive_transfer(
        handle,
        &registry,
        sink,
        BACKEND,
        cursor,
        |mut cursor| async move {
            let result = run_attempts(
                target,
                caps,
                direction,
                remote_path,
                local_path,
                &mut cursor,
                handle,
                sink,
            )
            .await;
            (result, cursor)
        },
        || cleanup_partial(target, direction, remote_path, local_path),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(offset_read: bool, stat: bool, size: bool) -> ContainerCaps {
        ContainerCaps {
            cat: true,
            offset_read,
            stat,
            size,
        }
    }

    #[test]
    fn download_resume_needs_offset_read_and_stat() {
        let d = TransferDirection::Download;
        assert!(resume_supported(caps(true, true, false), d));
        assert!(!resume_supported(caps(false, true, true), d));
        assert!(!resume_supported(caps(true, false, true), d));
    }

    #[test]
    fn upload_resume_needs_size() {
        let u = TransferDirection::Upload;
        assert!(resume_supported(caps(false, false, true), u));
        assert!(!resume_supported(caps(true, true, false), u));
    }

    #[test]
    fn copy_error_names_the_phase() {
        let e = copy_error(CopyPhase::Write, std::io::Error::other("broken pipe"));
        assert_eq!(
            e.to_string(),
            "Docker error: transfer write failed: broken pipe"
        );
    }
}
