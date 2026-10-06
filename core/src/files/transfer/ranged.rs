//! Ranged transfer executor — drives the queue state machine over
//! offset-addressed slices ([`RangedFileAccess`], #3587).
//!
//! The executor for a backend the desktop cannot stream through directly: an
//! agent-hosted session, whose SFTP channel, `docker exec` or WSL share lives
//! on the agent host and is reachable only one `connection.files.*` request at
//! a time. Each chunk is one self-contained request — read [`CHUNK_SIZE`]
//! bytes at an offset, or write a chunk at an offset that must equal the bytes
//! already there — so the transfer needs no long-lived stream on the far side.
//!
//! It runs the same shared orchestration (`super::attempt`) as the SFTP and
//! Docker executors: per-session slot, throttled progress + ETA, pause/resume,
//! cancel, auto-retry with backoff and the stall watchdog. Memory is bounded to
//! one chunk.
//!
//! **Resume.** A paused or retried transfer continues from the bytes actually
//! at the destination, re-verified before **every** attempt by the shared
//! resume gate: the source must still match its size + mtime fingerprint and
//! the destination must hold a prefix we wrote. On top of that, every remote
//! write states the offset it expects, and the far side refuses it when the
//! file does not hold exactly that many bytes, so a chunk can never be spliced
//! at the wrong place.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::debug;

use crate::errors::FileError;
use crate::files::{FileEntry, RangedFileAccess};

use super::attempt::{
    apply_resume_gate, drive_transfer, emit, guard_stall, local_fingerprint, local_size,
    open_local_dest, open_local_read, rehydrate_start_offset, settle_attempt, stop_reason,
    AttemptOutcome, AttemptsResult, ProgressReporter, ResumeCursor, StopReason, STALL_TIMEOUT,
};
use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{ProgressSink, SourceFingerprint, TransferDirection, TransferPhase, CHUNK_SIZE};

/// Log label for the shared attempt orchestration.
const BACKEND: &str = "Ranged";

/// The far side of a ranged transfer: offset-addressed slices plus the two
/// metadata operations the resume gate and cancel cleanup need.
#[async_trait::async_trait]
pub trait RangedTransferTarget: RangedFileAccess {
    /// Metadata of `path` (its size and modification time fingerprint the
    /// source; its size measures a partial destination).
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError>;

    /// Remove `path` — the partial upload of a cancelled transfer.
    async fn remove_file(&self, path: &str) -> Result<(), FileError>;
}

/// Core-internal error type for the ranged executor. It never escapes (the
/// public executor returns `()`); its `Display` becomes the progress message.
#[derive(Debug, thiserror::Error)]
enum RangedTransferError {
    #[error("{0}")]
    Remote(String),
}

impl RangedTransferError {
    fn remote(what: &str, e: impl std::fmt::Display) -> Self {
        Self::Remote(format!("{what}: {e}"))
    }
}

/// Fold a `modified` timestamp string into a stable `u64` (FNV-1a), so a
/// backend reporting its mtime only as text still yields a fingerprint that
/// changes when the file is rewritten. Pure.
fn mtime_token(modified: &str) -> Option<u64> {
    if modified.is_empty() {
        return None;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in modified.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    Some(hash)
}

/// Size + mtime of a remote file, or `None` when absent / un-stattable.
async fn remote_fingerprint(
    target: &dyn RangedTransferTarget,
    path: &str,
) -> Option<SourceFingerprint> {
    let entry = target.stat(path).await.ok()?;
    Some(SourceFingerprint {
        size: entry.size,
        mtime: mtime_token(&entry.modified),
    })
}

/// Source fingerprint for `direction`: the remote file for a download, the
/// local one for an upload.
async fn source_fingerprint(
    target: &dyn RangedTransferTarget,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
) -> Option<SourceFingerprint> {
    match direction {
        TransferDirection::Download => remote_fingerprint(target, remote_path).await,
        TransferDirection::Upload => local_fingerprint(local_path).await,
    }
}

/// Run one download attempt from `offset`, one remote slice per chunk.
async fn download_attempt<P, S>(
    target: &dyn RangedTransferTarget,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    mut on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, RangedTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut local = open_local_dest(local_path, offset)
        .await
        .map_err(|e| RangedTransferError::remote("open local file", e))?;
    let mut transferred = offset;
    let outcome = loop {
        if let Some(reason) = should_stop() {
            break AttemptOutcome::Stopped {
                transferred,
                reason,
            };
        }
        let chunk = target
            .read_range(remote_path, transferred, CHUNK_SIZE as u32)
            .await
            .map_err(|e| RangedTransferError::remote("read remote file", e))?;
        local
            .write_all(&chunk)
            .await
            .map_err(|e| RangedTransferError::remote("write local file", e))?;
        transferred += chunk.len() as u64;
        on_progress(transferred);
        if chunk.len() < CHUNK_SIZE {
            break AttemptOutcome::Completed { transferred };
        }
    };
    local
        .flush()
        .await
        .map_err(|e| RangedTransferError::remote("flush local file", e))?;
    Ok(outcome)
}

/// Fill `buf` from `reader` until it is full or the reader hits EOF; returns
/// the number of bytes read.
async fn fill(reader: &mut tokio::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]).await? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

/// Run one upload attempt from `offset`, one remote slice per chunk.
async fn upload_attempt<P, S>(
    target: &dyn RangedTransferTarget,
    local_path: &str,
    remote_path: &str,
    offset: u64,
    mut on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, RangedTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut local = open_local_read(local_path, offset)
        .await
        .map_err(|e| RangedTransferError::remote("open local file", e))?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut transferred = offset;
    loop {
        if let Some(reason) = should_stop() {
            return Ok(AttemptOutcome::Stopped {
                transferred,
                reason,
            });
        }
        let n = fill(&mut local, &mut buf)
            .await
            .map_err(|e| RangedTransferError::remote("read local file", e))?;
        // An empty source still has to exist at the destination; any other
        // EOF on a chunk boundary has nothing left to send.
        if n > 0 || transferred == 0 {
            target
                .write_range(remote_path, transferred, &buf[..n])
                .await
                .map_err(|e| RangedTransferError::remote("write remote file", e))?;
        }
        transferred += n as u64;
        on_progress(transferred);
        if n < CHUNK_SIZE {
            return Ok(AttemptOutcome::Completed { transferred });
        }
    }
}

/// Re-verify the resume point before an attempt via the shared gate, over a
/// freshly-read source fingerprint and destination size.
#[allow(clippy::too_many_arguments)]
async fn gate_resume(
    target: &dyn RangedTransferTarget,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
    cursor: &mut ResumeCursor,
    handle: &TransferHandle,
    sink: &ProgressSink,
) {
    let current = source_fingerprint(target, direction, remote_path, local_path).await;
    let present = if cursor.offset == 0 {
        None
    } else {
        match direction {
            TransferDirection::Download => local_size(local_path).await,
            TransferDirection::Upload => remote_fingerprint(target, remote_path)
                .await
                .map(|fp| fp.size),
        }
    };
    apply_resume_gate(cursor, handle, sink, current, present, BACKEND);
}

/// Run attempts (with auto-retry/backoff) for one Active stint.
async fn run_attempts(
    target: &dyn RangedTransferTarget,
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
        gate_resume(
            target,
            direction,
            remote_path,
            local_path,
            cursor,
            handle,
            sink,
        )
        .await;
        let result = run_one(
            target,
            direction,
            remote_path,
            local_path,
            cursor,
            handle,
            sink,
        )
        .await;
        if let Some(outcome) = settle_attempt(
            result,
            cursor,
            &mut attempt,
            handle,
            sink,
            BACKEND,
            "remote",
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
    target: &dyn RangedTransferTarget,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
    cursor: &mut ResumeCursor,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
) -> Result<AttemptOutcome, RangedTransferError> {
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
        RangedTransferError::Remote,
    )
    .await;
    cursor.offset = progress.load(Ordering::Relaxed);
    result
}

/// Best-effort cleanup of a partial destination on cancel.
async fn cleanup_partial(
    target: &dyn RangedTransferTarget,
    direction: TransferDirection,
    remote_path: &str,
    local_path: &str,
) {
    match direction {
        TransferDirection::Download => {
            if let Err(e) = tokio::fs::remove_file(local_path).await {
                debug!(error = %e, "could not remove partial ranged download (best-effort)");
            }
        }
        TransferDirection::Upload => {
            if let Err(e) = target.remove_file(remote_path).await {
                debug!(error = %e, "could not remove partial ranged upload (best-effort)");
            }
        }
    }
}

/// Drive a queued ranged transfer to a terminal state on the rich queue model,
/// emitting `transfer-progress` throughout (#3587).
///
/// Consumes the handle registered via [`TransferRegistry::enqueue`]; drops the
/// registry entry on completion, so the generic `transfer_pause` / `resume` /
/// `retry` / `cancel` commands work exactly as for SFTP, FTP and Docker.
///
/// `start_offset` seeds the first stint's resume offset (`0` for a fresh
/// transfer). It is still verified against the destination before any append.
#[allow(clippy::too_many_arguments)]
pub async fn run_ranged_transfer(
    target: Arc<dyn RangedTransferTarget>,
    direction: TransferDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    start_offset: u64,
) {
    let target = target.as_ref();
    let baseline = source_fingerprint(target, direction, &remote_path, &local_path).await;
    let total = baseline.map(|fp| fp.size).unwrap_or_default();
    let offset = rehydrate_start_offset(start_offset, &handle, baseline, BACKEND);
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    let (remote_path, local_path, handle, sink) = (&remote_path, &local_path, &handle, &sink);
    drive_transfer(
        handle,
        &registry,
        sink,
        BACKEND,
        cursor,
        |mut cursor| async move {
            let result = run_attempts(
                target,
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
#[path = "ranged_tests.rs"]
mod tests;
