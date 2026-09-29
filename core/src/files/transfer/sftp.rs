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
//! channel (`apply_resume_gate` over the pure
//! [`decide_resume`](super::retry::decide_resume)): the source must still match
//! the size + mtime fingerprint captured when its bytes were read, and the
//! destination must hold a prefix we wrote — the resume starts from the bytes
//! actually present, so pipelined writes lost on a dropped connection never
//! leave a hole. On any doubt, or when the server rejects the seek/append open,
//! the transfer restarts from zero and surfaces which path it took. The resume
//! protocol is selectable via [`ResumeMode`] (maintainer default: [`DEFAULT_RESUME_MODE`]).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::backends::ssh::{SftpFileBrowser, SftpTransferChannel};
use crate::files::copy::run_chunked_copy;
use tracing::{debug, warn};

pub use super::attempt::STALL_TIMEOUT;
use super::attempt::{
    apply_resume_gate, drive_transfer, emit, guard_stall, handle_attempt_error, local_fingerprint,
    local_size, map_copy_outcome, open_local_dest, open_local_read, rehydrate_start_offset,
    settle_attempt, settle_writer, stop_reason, AttemptOutcome, AttemptsResult, ProgressReporter,
    ResumeCursor, StopReason,
};
use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{ProgressSink, TransferDirection, TransferPhase, CHUNK_SIZE};
use crate::files::copy::CopyPhase;

/// Log label for the shared attempt orchestration.
const BACKEND: &str = "SFTP";

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

/// The resume protocol (PROD-0012), shared with the remote→remote copy.
pub use super::remote_copy::{ResumeMode, DEFAULT_RESUME_MODE};

/// Map a chunked-copy phase error to a [`SftpTransferError`], preserving the text.
fn copy_error(phase: CopyPhase, e: std::io::Error) -> SftpTransferError {
    let what = match phase {
        CopyPhase::Read => "read",
        CopyPhase::Write => "write",
        CopyPhase::Flush => "flush",
    };
    SftpTransferError::Ssh(format!("transfer {what} failed: {e}"))
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
    let mut local = open_local_dest(local_path, offset).await.map_err(|e| {
        if offset > 0 {
            SftpTransferError::Ssh(format!("open local file for append: {e}"))
        } else {
            SftpTransferError::Ssh(format!("create local file: {e}"))
        }
    })?;

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
                if let Some(outcome) =
                    handle_attempt_error(handle, sink, attempt, &e, BACKEND).await
                {
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
            apply_resume_gate(cursor, handle, sink, current, present, BACKEND);
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
        let result = guard_stall(
            attempt_fut,
            &progress,
            handle,
            STALL_TIMEOUT,
            SftpTransferError::Ssh,
        )
        .await;
        cursor.offset = progress.load(Ordering::Relaxed);

        if let Some(outcome) = settle_attempt(
            result,
            cursor,
            &mut attempt,
            handle,
            sink,
            BACKEND,
            "server",
        )
        .await
        {
            return outcome;
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
/// `run_attempts`), so a stale/divergent partial transparently restarts from
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
    let offset = rehydrate_start_offset(start_offset, &handle, baseline, BACKEND);
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    let (browser, remote_path, local_path, handle, sink) =
        (&browser, &remote_path, &local_path, &handle, &sink);
    drive_transfer(
        handle,
        &registry,
        sink,
        BACKEND,
        cursor,
        |mut cursor| async move {
            let result = run_attempts(
                browser,
                direction,
                remote_path,
                local_path,
                &mut cursor,
                handle,
                sink,
                resume_mode,
            )
            .await;
            (result, cursor)
        },
        || cleanup_partial(browser, direction, remote_path, local_path),
    )
    .await;
}

/// Drive a queued **remote→remote** SFTP copy to a terminal state on the rich
/// queue model (product feature PROD-0013).
///
/// A thin wrapper over the generic
/// [`run_remote_copy`](super::remote_copy::run_remote_copy) with an SFTP session
/// at both ends (#3586) — the same executor that also streams to and from Docker
/// sessions. See there for pause/resume, cancel, retry and the resume checks.
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
    start_offset: u64,
) {
    use super::remote_copy::{run_remote_copy, RemoteCopyEndpoint};
    run_remote_copy(
        RemoteCopyEndpoint::Sftp(src_browser),
        RemoteCopyEndpoint::Sftp(dst_browser),
        src_path,
        dst_path,
        handle,
        registry,
        sink,
        resume_mode,
        start_offset,
    )
    .await;
}
