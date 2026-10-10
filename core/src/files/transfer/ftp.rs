//! FTP transfer executor — drives the queue state machine around the core
//! streaming primitive (issue #1336).
//!
//! `core`'s [`run_attempt`] moves the
//! bytes for one attempt on its own connection; this module wraps it with the
//! desktop's orchestration: acquire a per-session concurrency slot, stream with
//! throttled progress + ETA, auto-retry with exponential backoff on error,
//! honour pause/resume and cancel, and drive the [`TransferHandle`] through its
//! `Queued → Active → …` states. It never holds a browsing connection, so
//! listing stays live while transfers run.
//!
//! **Resume (#3206).** The executor runs on the shared attempt orchestration of
//! the other offset-resuming backends (`super::attempt`), so FTP resumes the
//! same way SFTP, Docker and local copies do:
//!
//! - Before every attempt it probes the server ([`probe_remote_file`]): `FEAT`
//!   says whether `REST STREAM` and `MDTM` are supported, `SIZE` + `MDTM` give
//!   the remote file's fingerprint. The source must still match the fingerprint
//!   captured when its bytes were read, and the destination must hold a prefix
//!   we wrote — otherwise the attempt restarts from zero.
//! - A server that does not advertise `REST STREAM` never gets a `REST`: the
//!   transfer restarts from zero and says why. A server that does not answer
//!   `FEAT` at all is tried, and a refused `REST` restarts from zero too.
//! - Without `MDTM` only the size can be compared, so a resume is size-only.
//! - A **rehydrated** transfer (relaunched after an app restart) starts from its
//!   persisted checkpoint when the source still matches the persisted size and
//!   mtime (#3572) — see `rehydrate_start_offset`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::backends::ftp::{
    self, probe_remote_file, run_attempt, FtpDirection, FtpRemoteFile, FtpServerCaps,
};
use crate::config::FtpConfig;
use crate::errors::SessionError;
use tracing::{debug, info};

use super::attempt::{
    apply_resume_gate, drive_transfer, emit, guard_probe, guard_stall, handle_attempt_error,
    local_fingerprint, local_size, probe_timed_out, rehydrate_start_offset, settle_attempt,
    stop_reason, AttemptOutcome, AttemptsResult, Probed, ProgressReporter, ResumeCursor,
    StopReason, STALL_TIMEOUT,
};
use super::registry::{TransferHandle, TransferRegistry};
use super::retry::SourceFingerprint;
use super::state::TransferEvent;
use super::{ProgressSink, TransferPhase};

/// Log label for the shared attempt orchestration.
const BACKEND: &str = "FTP";

/// Error of one FTP attempt; its `Display` becomes the progress message.
#[derive(Debug, thiserror::Error)]
enum FtpTransferError {
    /// The connection or the protocol failed.
    #[error(transparent)]
    Session(#[from] SessionError),
    /// The stall watchdog gave up on an attempt that moved no data.
    #[error("{0}")]
    Stalled(String),
}

/// What one probe learnt about both ends of the transfer.
struct Endpoints {
    /// What the server advertised in `FEAT`.
    caps: FtpServerCaps,
    /// Fingerprint of the source (remote for a download, local for an upload).
    source: Option<SourceFingerprint>,
    /// Bytes present at the destination (local for a download, remote for an
    /// upload).
    present: Option<u64>,
}

/// Probe both ends of the transfer: the server (capabilities, remote size and
/// mtime) over a throwaway connection, and the local file. Fails only when the
/// server cannot be reached.
async fn probe_endpoints(
    config: &FtpConfig,
    direction: FtpDirection,
    remote_path: &str,
    local_path: &str,
) -> Result<Endpoints, SessionError> {
    let FtpRemoteFile { caps, size, mtime } = probe_remote_file(config, remote_path).await?;
    Ok(match direction {
        FtpDirection::Download => Endpoints {
            caps,
            source: size.map(|size| SourceFingerprint { size, mtime }),
            present: local_size(local_path).await,
        },
        FtpDirection::Upload => Endpoints {
            caps,
            source: local_fingerprint(local_path).await,
            present: size,
        },
    })
}

/// Map the queue's stop decision onto the FTP primitive's.
fn ftp_stop(reason: StopReason) -> ftp::StopReason {
    match reason {
        StopReason::Pause => ftp::StopReason::Pause,
        StopReason::Cancel => ftp::StopReason::Cancel,
    }
}

/// Map the FTP primitive's outcome onto the shared attempt vocabulary.
fn attempt_outcome(outcome: ftp::AttemptOutcome) -> AttemptOutcome {
    match outcome {
        ftp::AttemptOutcome::Completed { transferred } => AttemptOutcome::Completed { transferred },
        ftp::AttemptOutcome::Stopped {
            transferred,
            reason,
        } => AttemptOutcome::Stopped {
            transferred,
            reason: match reason {
                ftp::StopReason::Pause => StopReason::Pause,
                ftp::StopReason::Cancel => StopReason::Cancel,
            },
        },
        ftp::AttemptOutcome::ResumeRejected => AttemptOutcome::ResumeRejected,
    }
}

/// Drop a non-zero resume offset the server cannot honour: it answered `FEAT`
/// without `REST STREAM`, so the attempt restarts from zero instead of sending a
/// `REST` it would refuse. Surfaced in the log and on the row.
fn drop_unsupported_resume(
    cursor: &mut ResumeCursor,
    caps: FtpServerCaps,
    handle: &TransferHandle,
    sink: &ProgressSink,
) {
    if cursor.offset == 0 || caps.may_resume() {
        return;
    }
    info!(
        backend = BACKEND,
        transfer_id = %handle.transfer_id,
        requested = cursor.offset,
        "server does not advertise REST STREAM in FEAT; restarting from zero"
    );
    cursor.offset = 0;
    emit(
        handle,
        sink,
        TransferPhase::Transferring,
        None,
        Some("resume not supported by server; restarting from start".to_string()),
    );
}

/// Run attempts (with auto-retry/backoff) for one Active stint. Keeps the slot
/// across transient retries; returns once the transfer completes, is cancelled,
/// is paused, or exhausts its retry budget. Before every attempt the server is
/// probed and the resume point re-verified.
async fn run_attempts(
    config: &FtpConfig,
    direction: FtpDirection,
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

        // The probe is cancel-aware and bounded (#4672): a dead server cannot
        // park the attempt outside the stall watchdog.
        let probe = probe_endpoints(config, direction, remote_path, local_path);
        let probed = match guard_probe(probe, handle, STALL_TIMEOUT).await {
            Probed::Done(probed) => probed.map_err(FtpTransferError::Session),
            Probed::Cancelled => {
                handle.transition(TransferEvent::Cancel);
                return AttemptsResult::Cancelled;
            }
            Probed::TimedOut => Err(FtpTransferError::Stalled(probe_timed_out(
                "probe FTP server",
                STALL_TIMEOUT,
            ))),
        };
        let endpoints = match probed {
            Ok(endpoints) => endpoints,
            Err(e) => {
                if let Some(outcome) =
                    handle_attempt_error(handle, sink, attempt, &e, BACKEND).await
                {
                    return outcome;
                }
                continue;
            }
        };
        drop_unsupported_resume(cursor, endpoints.caps, handle, sink);
        apply_resume_gate(
            cursor,
            handle,
            sink,
            endpoints.source,
            endpoints.present,
            BACKEND,
        );

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
            run_attempt(
                config,
                direction,
                remote_path,
                local_path,
                offset,
                |t| reporter.report(t),
                move || stop_reason(&stop_handle).map(ftp_stop),
            )
            .await
            .map(attempt_outcome)
            .map_err(FtpTransferError::Session)
        };
        let result = guard_stall(
            attempt_fut,
            &progress,
            handle,
            STALL_TIMEOUT,
            FtpTransferError::Stalled,
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
///
/// `start_offset` seeds the first Active stint's resume offset: `0` for a fresh
/// transfer, the persisted `resume_offset` for a **rehydrated** transfer
/// relaunched after an app restart (#3206). The checkpoint is kept only when the
/// source still matches the persisted size and mtime (see
/// `rehydrate_start_offset`) and the server supports `REST STREAM`; the
/// destination is still byte-verified before the first append.
#[allow(clippy::too_many_arguments)]
pub async fn run_ftp_transfer(
    config: FtpConfig,
    direction: FtpDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    start_offset: u64,
) {
    // Establish the source identity + total up front so progress/ETA are
    // meaningful and a later resume can detect a changed source.
    // The probe is cancel-aware and bounded (#4672): a cancel or a dead server
    // leaves the source unknown and falls through to `drive_transfer`, which
    // settles a cancel exactly once.
    let probe = probe_endpoints(&config, direction, &remote_path, &local_path);
    let baseline = match guard_probe(probe, &handle, STALL_TIMEOUT).await {
        Probed::Done(Ok(endpoints)) => endpoints.source,
        Probed::Done(Err(e)) => {
            debug!(error = %e, "FTP probe failed before the transfer; source unknown");
            None
        }
        Probed::Cancelled => None,
        Probed::TimedOut => {
            debug!("FTP probe timed out before the transfer; source unknown");
            None
        }
    };
    let total = baseline.map(|fp| fp.size).unwrap_or(0);
    // A rehydrated transfer's handle was registered with its persisted total.
    let offset = rehydrate_start_offset(start_offset, &handle, baseline, BACKEND);
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    let (config, remote_path, local_path, handle, sink) =
        (&config, &remote_path, &local_path, &handle, &sink);
    drive_transfer(
        handle,
        &registry,
        sink,
        BACKEND,
        cursor,
        |mut cursor| async move {
            let result = run_attempts(
                config,
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
        || cleanup_partial(direction, local_path),
    )
    .await;
}

#[cfg(test)]
#[path = "ftp_tests.rs"]
mod tests;
