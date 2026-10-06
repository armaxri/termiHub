//! Remote→remote copy executor — streams a file from one session straight into
//! another **through the desktop**, with no local staging file, as ONE tracked
//! transfer (product feature PROD-0013, generalised by #3586).
//!
//! Either end can be an SFTP session (a dedicated channel per attempt), a
//! Docker session (a streaming `docker exec` per attempt) or a ranged session
//! (an agent-hosted session moved in 256 KiB offset-addressed slices, #4115),
//! so any pairing of them — including agent→agent — runs the same way. The copy
//! rides the shared attempt orchestration of the other offset-resuming
//! executors (`super::attempt`): a per-session slot, throttled progress + ETA,
//! pause/resume, cancel (which removes the partial destination), auto-retry
//! with backoff, and the stall watchdog. Memory stays bounded to one copy
//! chunk; the file is never loaded whole.
//!
//! **Resume.** Before **every** attempt the resume point is re-verified over
//! that attempt's own access to each end (`apply_resume_gate`): the source must
//! still match the size + mtime fingerprint captured when its bytes were read,
//! and the destination must hold a prefix we wrote. An end that cannot verify
//! or continue a partial (a container without `tail`/`stat` or `wc`, a server
//! refusing the seek/append open) restarts the copy from byte zero and says
//! why. A copy **relaunched** after an app restart keeps its checkpoint only
//! while the source still has the persisted size and mtime (#3572, #3847).
//!
//! FTP endpoints are not supported here: the FTP executor pairs a remote file
//! with a local one inside one attempt and exposes no standalone streaming
//! reader/writer, so a copy involving FTP keeps the byte-based fallback.

use std::io;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};
use tracing::{debug, warn};

use crate::files::copy::{run_chunked_copy, ChunkedCopyOutcome, CopyPhase};

use super::attempt::{
    apply_resume_gate, drive_transfer, emit, guard_stall, handle_attempt_error, map_copy_outcome,
    rehydrate_start_offset, settle_attempt, stop_reason, AttemptOutcome, AttemptsResult,
    ProgressReporter, ResumeCursor, StopReason, STALL_TIMEOUT,
};
#[cfg(feature = "local-transfer")]
use super::ranged::RangedTransferTarget;
use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{ProgressSink, SourceFingerprint, TransferPhase, CHUNK_SIZE};

#[path = "remote_copy_endpoints.rs"]
mod endpoints;

#[cfg(feature = "docker")]
use crate::backends::docker::DockerTransferTarget;
#[cfg(feature = "ssh")]
use crate::backends::ssh::SftpFileBrowser;

/// Log label for the shared attempt orchestration.
const BACKEND: &str = "remote-to-remote";

/// Resume protocol for streaming transfers (PROD-0012).
///
/// **Maintainer default: [`DEFAULT_RESUME_MODE`] = [`ResumeMode::Resume`].**
/// A resumed transfer byte-verifies the destination and continues from the
/// offset; if an end rejects the seek/append open it transparently restarts
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

/// One end of a remote→remote copy.
pub enum RemoteCopyEndpoint {
    /// An SFTP-backed session: each attempt opens its own dedicated channel.
    #[cfg(feature = "ssh")]
    Sftp(Arc<SftpFileBrowser>),
    /// A Docker-backed session: each attempt streams through its own exec.
    #[cfg(feature = "docker")]
    Docker(DockerTransferTarget),
    /// A session reached through offset-addressed slices — an agent-hosted
    /// session whose agent serves `fileRanges` (#4115): one 256 KiB
    /// `read_range` / `write_range` request per chunk.
    #[cfg(feature = "local-transfer")]
    Ranged(Arc<dyn RangedTransferTarget>),
}

impl RemoteCopyEndpoint {
    fn into_endpoint(self) -> Arc<dyn CopyEndpoint> {
        match self {
            #[cfg(feature = "ssh")]
            RemoteCopyEndpoint::Sftp(browser) => Arc::new(endpoints::SftpEndpoint::new(browser)),
            #[cfg(feature = "docker")]
            RemoteCopyEndpoint::Docker(target) => Arc::new(endpoints::DockerEndpoint::new(target)),
            #[cfg(feature = "local-transfer")]
            RemoteCopyEndpoint::Ranged(target) => Arc::new(endpoints::RangedEndpoint::new(target)),
        }
    }
}

impl std::fmt::Debug for RemoteCopyEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(feature = "ssh")]
            RemoteCopyEndpoint::Sftp(_) => f.write_str("Sftp"),
            #[cfg(feature = "docker")]
            RemoteCopyEndpoint::Docker(target) => f.debug_tuple("Docker").field(target).finish(),
            #[cfg(feature = "local-transfer")]
            RemoteCopyEndpoint::Ranged(_) => f.write_str("Ranged"),
        }
    }
}

/// Error of one attempt; its `Display` becomes the progress message, prefixed
/// by the end that failed ("SSH error: …", "Docker error: …").
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct RemoteCopyError(String);

impl RemoteCopyError {
    fn at(prefix: &str, what: impl std::fmt::Display) -> Self {
        Self(format!("{prefix}: {what}"))
    }
}

/// Why opening a stream failed.
#[derive(Debug)]
pub(crate) enum OpenError {
    /// The end refused to continue from a non-zero offset; restart from zero.
    /// Only an SFTP server refuses an offset open (a container is probed for
    /// its tools up front instead).
    #[cfg_attr(
        not(any(test, feature = "ssh")),
        expect(dead_code, reason = "only the SFTP end refuses an offset open")
    )]
    ResumeRejected(String),
    /// Any other failure (retried with backoff).
    Failed(String),
}

/// One end of a copy, as the engine drives it.
#[async_trait]
pub(crate) trait CopyEndpoint: Send + Sync {
    /// Names this end in the restart message ("server", "container").
    fn peer(&self) -> &'static str;
    /// Prefix of this end's error messages ("SSH error", "Docker error").
    fn error_prefix(&self) -> &'static str;
    /// Open this end for one attempt (a fresh channel / a probed container).
    async fn link(&self) -> Result<Box<dyn EndpointLink>, String>;
    /// Best-effort removal of a partial destination.
    async fn remove_partial(&self, path: &str);
}

/// One attempt's access to an end.
#[async_trait]
pub(crate) trait EndpointLink: Send + Sync {
    /// Size + mtime of `path`, or `None` when absent / un-stattable.
    async fn fingerprint(&self, path: &str) -> Option<SourceFingerprint>;
    /// Size of `path`, or `None` when absent / unmeasurable.
    async fn file_size(&self, path: &str) -> Option<u64>;
    /// Whether this end can verify an unchanged source and read from an offset.
    fn can_resume_read(&self) -> bool;
    /// Whether this end can measure a partial destination to append to it.
    fn can_resume_write(&self) -> bool;
    /// Stream `path` from byte `offset`.
    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn CopyReader>, OpenError>;
    /// Write `path` from byte `offset` (a truncating create at `0`).
    async fn open_write(&self, path: &str, offset: u64) -> Result<Box<dyn CopyWriter>, OpenError>;
}

/// A source stream.
#[async_trait]
pub(crate) trait CopyReader: AsyncRead + Unpin + Send {
    /// After EOF: confirm the whole file was read (a killed `cat` also ends
    /// its stdout).
    async fn finish(self: Box<Self>) -> io::Result<()>;
}

/// A destination stream.
#[async_trait]
pub(crate) trait CopyWriter: AsyncWrite + Unpin + Send {
    /// Close the stream and confirm the bytes landed.
    async fn finish(self: Box<Self>) -> io::Result<()>;
}

/// Map a chunked-copy phase error to the end it happened on.
fn copy_error(phase: CopyPhase, e: io::Error, src: &str, dst: &str) -> RemoteCopyError {
    let (prefix, what) = match phase {
        CopyPhase::Read => (src, "read"),
        CopyPhase::Write => (dst, "write"),
        CopyPhase::Flush => (dst, "flush"),
    };
    RemoteCopyError::at(prefix, format!("transfer {what} failed: {e}"))
}

/// Which end refused an offset open, recorded by the attempt for the restart
/// message.
const REJECTED_NONE: u8 = 0;
const REJECTED_SRC: u8 = 1;
const REJECTED_DST: u8 = 2;

/// Both ends of one attempt.
#[derive(Clone, Copy)]
struct AttemptEnds<'a> {
    src: &'a dyn EndpointLink,
    dst: &'a dyn EndpointLink,
    src_prefix: &'static str,
    dst_prefix: &'static str,
    src_path: &'a str,
    dst_path: &'a str,
}

/// Run one copy attempt from `offset`: open both streams and move the bytes.
async fn copy_attempt<P, S>(
    ends: AttemptEnds<'_>,
    offset: u64,
    rejected_by: &AtomicU8,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, RemoteCopyError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut reader = match ends.src.open_read(ends.src_path, offset).await {
        Ok(r) => r,
        Err(OpenError::ResumeRejected(e)) => {
            warn!(offset, error = %e, "source rejected the resume read; restarting from zero");
            rejected_by.store(REJECTED_SRC, Ordering::Relaxed);
            return Ok(AttemptOutcome::ResumeRejected);
        }
        Err(OpenError::Failed(e)) => return Err(RemoteCopyError::at(ends.src_prefix, e)),
    };
    let mut writer = match ends.dst.open_write(ends.dst_path, offset).await {
        Ok(w) => w,
        Err(OpenError::ResumeRejected(e)) => {
            warn!(offset, error = %e, "destination rejected the resume append; restarting from zero");
            rejected_by.store(REJECTED_DST, Ordering::Relaxed);
            return Ok(AttemptOutcome::ResumeRejected);
        }
        Err(OpenError::Failed(e)) => return Err(RemoteCopyError::at(ends.dst_prefix, e)),
    };

    let outcome = run_chunked_copy(
        &mut reader,
        &mut writer,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        |phase, e| copy_error(phase, e, ends.src_prefix, ends.dst_prefix),
    )
    .await?;
    match outcome {
        ChunkedCopyOutcome::Completed { .. } => {
            // Settle both ends even when the source failed, so the bytes that
            // were counted have landed before the next attempt measures them.
            let read = reader.finish().await;
            let write = writer.finish().await;
            read.map_err(|e| RemoteCopyError::at(ends.src_prefix, format!("read failed: {e}")))?;
            write
                .map_err(|e| RemoteCopyError::at(ends.dst_prefix, format!("write failed: {e}")))?;
        }
        ChunkedCopyOutcome::Stopped { .. } => {
            // Close the source, then best-effort settle the destination so the
            // bytes counted as sent have landed; the next attempt measures the
            // destination anyway.
            drop(reader);
            match tokio::time::timeout(STALL_TIMEOUT, writer.finish()).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => debug!(error = %e, "could not settle destination after stop"),
                Err(_) => debug!("settling destination after stop timed out"),
            }
        }
    }
    Ok(map_copy_outcome(outcome))
}

/// Both endpoints and paths of a copy.
#[derive(Clone, Copy)]
struct Ends<'a> {
    src: &'a dyn CopyEndpoint,
    dst: &'a dyn CopyEndpoint,
    src_path: &'a str,
    dst_path: &'a str,
}

/// Open both ends for one attempt.
async fn open_links(
    ends: Ends<'_>,
) -> Result<(Box<dyn EndpointLink>, Box<dyn EndpointLink>), RemoteCopyError> {
    let src =
        ends.src.link().await.map_err(|e| {
            RemoteCopyError::at(ends.src.error_prefix(), format!("open source: {e}"))
        })?;
    let dst = ends.dst.link().await.map_err(|e| {
        RemoteCopyError::at(ends.dst.error_prefix(), format!("open destination: {e}"))
    })?;
    Ok((src, dst))
}

/// Run a single attempt from `cursor.offset` under the stall watchdog,
/// advancing the cursor to the bytes it reached. Returns the attempt's result
/// and the peer that refused an offset open, if one did.
async fn run_one(
    ends: Ends<'_>,
    src: &dyn EndpointLink,
    dst: &dyn EndpointLink,
    cursor: &mut ResumeCursor,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
) -> (Result<AttemptOutcome, RemoteCopyError>, &'static str) {
    let progress = Arc::new(AtomicU64::new(cursor.offset));
    let mut reporter = ProgressReporter::new(
        handle.clone(),
        sink.clone(),
        cursor.total,
        progress.clone(),
        cursor.offset,
    );
    let stop_handle = handle.clone();
    let rejected_by = AtomicU8::new(REJECTED_NONE);
    let attempt_fut = copy_attempt(
        AttemptEnds {
            src,
            dst,
            src_prefix: ends.src.error_prefix(),
            dst_prefix: ends.dst.error_prefix(),
            src_path: ends.src_path,
            dst_path: ends.dst_path,
        },
        cursor.offset,
        &rejected_by,
        |t| reporter.report(t),
        move || stop_reason(&stop_handle),
    );
    let result = guard_stall(
        attempt_fut,
        &progress,
        handle,
        STALL_TIMEOUT,
        RemoteCopyError,
    )
    .await;
    cursor.offset = progress.load(Ordering::Relaxed);
    let peer = match rejected_by.load(Ordering::Relaxed) {
        REJECTED_SRC => ends.src.peer(),
        _ => ends.dst.peer(),
    };
    (result, peer)
}

/// Run attempts (with auto-retry/backoff) for one Active stint. Keeps the slot
/// across transient retries; returns once the copy completes, is cancelled, is
/// paused, or exhausts its retry budget.
async fn run_attempts(
    ends: Ends<'_>,
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

        // Fresh access to both ends per attempt, so a broken channel or exec
        // is re-established on retry and browsing stays live meanwhile. A
        // failed open keeps the requested offset: nothing was written, and
        // the next attempt re-verifies it.
        let (src, dst) = match open_links(ends).await {
            Ok(links) => links,
            Err(e) => {
                if let Some(outcome) =
                    handle_attempt_error(handle, sink, attempt, &e, BACKEND).await
                {
                    return outcome;
                }
                continue;
            }
        };

        if resume_mode == ResumeMode::RestartOnly {
            cursor.offset = 0;
        }
        let (result, peer) = if cursor.offset > 0 && !src.can_resume_read() {
            // Refuse rather than guess: the shared settle restarts the stint
            // from zero (without consuming a retry) and says why.
            warn!(transfer_id = %handle.transfer_id, offset = cursor.offset, "source cannot verify a resume; restarting from zero");
            (Ok(AttemptOutcome::ResumeRejected), ends.src.peer())
        } else if cursor.offset > 0 && !dst.can_resume_write() {
            warn!(transfer_id = %handle.transfer_id, offset = cursor.offset, "destination cannot verify a resume; restarting from zero");
            (Ok(AttemptOutcome::ResumeRejected), ends.dst.peer())
        } else {
            // Re-verify the resume point on this attempt's access (PARITY-004).
            let current = src.fingerprint(ends.src_path).await;
            let present = if cursor.offset > 0 {
                dst.file_size(ends.dst_path).await
            } else {
                None
            };
            apply_resume_gate(cursor, handle, sink, current, present, BACKEND);
            run_one(ends, src.as_ref(), dst.as_ref(), cursor, handle, sink).await
        };

        if let Some(outcome) =
            settle_attempt(result, cursor, &mut attempt, handle, sink, BACKEND, peer).await
        {
            return outcome;
        }
    }
}

/// Drive a queued remote→remote copy between `src` and `dst` to a terminal
/// state (the engine behind [`run_remote_copy`]).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_copy(
    src: Arc<dyn CopyEndpoint>,
    dst: Arc<dyn CopyEndpoint>,
    src_path: String,
    dst_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    resume_mode: ResumeMode,
    start_offset: u64,
) {
    // Establish the source identity + total up front so progress/ETA are
    // meaningful and a later resume can detect a changed source (PARITY-004).
    // A failed open is retried by the first attempt.
    let (baseline, total) = match src.link().await {
        Ok(link) => {
            let baseline = link.fingerprint(&src_path).await;
            let total = match baseline {
                Some(fp) => fp.size,
                None => link.file_size(&src_path).await.unwrap_or_default(),
            };
            (baseline, total)
        }
        Err(e) => {
            debug!(error = %e, "could not stat the copy source up front");
            (None, 0)
        }
    };
    // A relaunched copy's handle was registered with its persisted total.
    let offset = rehydrate_start_offset(start_offset, &handle, baseline, BACKEND);
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    let ends = Ends {
        src: src.as_ref(),
        dst: dst.as_ref(),
        src_path: &src_path,
        dst_path: &dst_path,
    };
    let (handle, sink) = (&handle, &sink);
    drive_transfer(
        handle,
        &registry,
        sink,
        BACKEND,
        cursor,
        |mut cursor| async move {
            let result = run_attempts(ends, &mut cursor, handle, sink, resume_mode).await;
            (result, cursor)
        },
        || ends.dst.remove_partial(ends.dst_path),
    )
    .await;
}

/// Drive a queued **remote→remote** copy to a terminal state on the rich queue
/// model, emitting `transfer-progress` throughout (PROD-0013, #3586).
///
/// Streams `src_path` on `src` directly into `dst_path` on `dst` **through the
/// desktop** — no local staging file — as ONE tracked transfer. Either end may
/// be SFTP, Docker or ranged (an agent-hosted session, #4115). It shares the
/// slot orchestration, throttled progress + ETA, pause/resume, auto-retry with backoff, and byte-verified offset resume
/// of the other executors, so the generic `transfer_pause` / `resume` /
/// `retry` / `cancel` commands work for it too. Progress is measured on the
/// write (destination) side; cancel removes the partial destination.
///
/// `start_offset` is `0` for a fresh copy and the persisted `resume_offset`
/// for a copy **relaunched** after an app restart (#3206): the checkpoint is
/// kept only while the source still matches the persisted size and mtime, and
/// the destination is byte-verified before the first append.
#[allow(clippy::too_many_arguments)]
pub async fn run_remote_copy(
    src: RemoteCopyEndpoint,
    dst: RemoteCopyEndpoint,
    src_path: String,
    dst_path: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    resume_mode: ResumeMode,
    start_offset: u64,
) {
    run_copy(
        src.into_endpoint(),
        dst.into_endpoint(),
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

#[cfg(test)]
#[path = "remote_copy_tests.rs"]
mod tests;
