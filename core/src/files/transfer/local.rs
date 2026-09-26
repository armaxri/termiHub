//! Local transfer executor — drives the queue state machine around a chunked
//! host-filesystem copy (PARITY-004, #3567).
//!
//! The local counterpart of [`run_docker_transfer`](super::docker) and
//! `run_sftp_transfer`: the same shared orchestration ([`super::attempt`]) —
//! per-session slot, throttled progress + ETA, pause/resume, cancel, auto-retry
//! with backoff, the stall watchdog — around a plain `tokio::fs` copy. It backs
//! every user-visible **file** copy on the local disk: copy/paste between local
//! folders, a Save-as of a local file, and an OS drop onto the local pane.
//!
//! **WSL.** A WSL tab browses its distribution through the host's
//! `\\wsl.localhost\<distro>` / `\\wsl$\<distro>` UNC share (the frontend maps
//! the Linux path onto it), so a local ↔ WSL copy is a host-path copy like any
//! other and runs through this executor unchanged — there is no WSL-specific
//! (and so no `cfg(windows)`) code here.
//!
//! **Bounded memory.** The file streams through one [`CHUNK_SIZE`] buffer; it is
//! never loaded whole.
//!
//! **Atomic destination.** Bytes land in a hidden sibling temp file
//! ([`partial_path`]) that is renamed over the destination only once the copy
//! completed and was synced, so a cancelled, paused or failed copy never leaves
//! a half-written file under the destination name — and an existing file at the
//! destination survives a cancel untouched. (SFTP and Docker write in place and
//! delete the partial on cancel, because a remote rename is not guaranteed to be
//! atomic or even available; locally it is, so the stronger guarantee is free.)
//! A cancel removes the temp file; a pause or a permanent failure keeps it so a
//! resume / manual retry can continue from it.
//!
//! **Resume.** A paused or retried copy continues from the bytes already in the
//! temp file, re-verified before **every** attempt by the shared resume gate:
//! the source must still match its size + mtime fingerprint and the temp file
//! must hold a prefix we wrote; any doubt restarts from byte zero.
//!
//! **Metadata.** The source's permission bits are applied to the temp file
//! before the rename, matching `std::fs::copy` (which the direct path uses);
//! like `std::fs::copy`, the modification time is not preserved.
//!
//! **Direct-copy threshold.** A file at or below [`DIRECT_COPY_MAX_BYTES`] is
//! copied directly (see [`should_queue_local_copy`]): it finishes faster than a
//! queue row could render, so tracking it would only add noise. Directories are
//! copied directly and recursively by the caller (`files::local::copy_sync`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tracing::{debug, info};

use crate::files::copy::{run_chunked_copy, ChunkedCopyOutcome, CopyPhase};

use super::attempt::{
    apply_resume_gate, drive_transfer, emit, guard_stall, local_fingerprint, local_size,
    map_copy_outcome, open_local_dest, open_local_read, rehydrate_start_offset, settle_attempt,
    settle_writer, stop_reason, AttemptOutcome, AttemptsResult, ProgressReporter, ResumeCursor,
    StopReason, STALL_TIMEOUT,
};
use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferEvent;
use super::{ProgressSink, TransferPhase, CHUNK_SIZE};

/// Log label for the shared attempt orchestration.
const BACKEND: &str = "Local";

/// The reserved session id local copies are queued under: they have no live
/// session, but the registry schedules concurrency per session id and the
/// persisted queue records one, so every local copy shares this one.
pub const LOCAL_TRANSFER_SESSION: &str = "local";

/// Largest file (in bytes) that is copied directly rather than through the
/// transfer queue: 8 MiB — 32 copy chunks, well under a second on any local
/// disk (and typically well under one on a WSL share), so a queue row would
/// flash and vanish. Anything bigger gets progress, pause/resume, cancel and
/// retry.
pub const DIRECT_COPY_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Whether a local file copy of `size` bytes should run through the transfer
/// queue (`true`) or be copied directly (`false`). Pure.
pub fn should_queue_local_copy(size: u64) -> bool {
    size > DIRECT_COPY_MAX_BYTES
}

/// Core-internal error type for the local executor. It never escapes (the
/// public executor returns `()`); its `Display` becomes the progress message.
#[derive(Debug, thiserror::Error)]
enum LocalTransferError {
    #[error("Local copy error: {0}")]
    Io(String),
}

/// Map a chunked-copy phase error, preserving the text.
fn copy_error(phase: CopyPhase, e: std::io::Error) -> LocalTransferError {
    let what = match phase {
        CopyPhase::Read => "read",
        CopyPhase::Write => "write",
        CopyPhase::Flush => "flush",
    };
    LocalTransferError::Io(format!("{what} failed: {e}"))
}

/// The hidden sibling temp file a copy to `dest` writes into before the final
/// rename. Pure.
///
/// Lives in the destination's own directory (so the rename never crosses a
/// filesystem) and carries a tag from `transfer_id`, so two copies to the same
/// name never share a temp file while a relaunched transfer (same id) finds its
/// own partial again.
pub fn partial_path(dest: &str, transfer_id: &str) -> PathBuf {
    let dest = Path::new(dest);
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tag: String = transfer_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    dest.with_file_name(format!(".{name}.{tag}.termihub-part"))
}

/// Make sure the destination's parent directory exists (as `copy_sync` does).
async fn ensure_parent(path: &Path) -> std::io::Result<()> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => tokio::fs::create_dir_all(parent).await,
        _ => Ok(()),
    }
}

/// Promote a completed temp file to the destination: sync it, give it the
/// source's permission bits, and atomically rename it over `dest`.
async fn finalize(src: &str, part: &Path, dest: &str) -> Result<(), LocalTransferError> {
    let io = |what: &str, e: std::io::Error| LocalTransferError::Io(format!("{what}: {e}"));
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(part)
        .await
        .map_err(|e| io("reopen temp file", e))?;
    file.sync_all().await.map_err(|e| io("sync temp file", e))?;
    drop(file);
    let perms = tokio::fs::metadata(src)
        .await
        .map_err(|e| io("read source permissions", e))?
        .permissions();
    tokio::fs::set_permissions(part, perms)
        .await
        .map_err(|e| io("apply source permissions", e))?;
    tokio::fs::rename(part, dest)
        .await
        .map_err(|e| io("move temp file into place", e))
}

/// Run one copy attempt from `offset` into the temp file `part`, renaming it
/// over `dest` when the source reaches EOF.
async fn copy_attempt<P, S>(
    src: &str,
    part: &Path,
    dest: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, LocalTransferError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut reader = open_local_read(src, offset)
        .await
        .map_err(|e| LocalTransferError::Io(format!("open source: {e}")))?;
    ensure_parent(part)
        .await
        .map_err(|e| LocalTransferError::Io(format!("create destination folder: {e}")))?;
    let part_str = part.to_string_lossy();
    let mut writer = open_local_dest(&part_str, offset)
        .await
        .map_err(|e| LocalTransferError::Io(format!("open temp file: {e}")))?;
    let outcome = run_chunked_copy(
        &mut reader,
        &mut writer,
        CHUNK_SIZE,
        offset,
        should_stop,
        on_progress,
        copy_error,
    )
    .await?;
    settle_writer(&mut writer, &outcome).await;
    drop(writer);
    if matches!(outcome, ChunkedCopyOutcome::Completed { .. }) {
        finalize(src, part, dest).await?;
    }
    Ok(map_copy_outcome(outcome))
}

/// Re-verify the resume point before an attempt via the shared gate, over a
/// freshly-read source fingerprint and temp-file size.
async fn gate_resume(
    src: &str,
    part: &Path,
    cursor: &mut ResumeCursor,
    handle: &TransferHandle,
    sink: &ProgressSink,
) {
    let current = local_fingerprint(src).await;
    let present = if cursor.offset == 0 {
        None
    } else {
        local_size(&part.to_string_lossy()).await
    };
    apply_resume_gate(cursor, handle, sink, current, present, BACKEND);
}

/// Run a single attempt from `cursor.offset` under the stall watchdog,
/// advancing the cursor to the bytes it reached.
async fn run_one(
    src: &str,
    part: &Path,
    dest: &str,
    cursor: &mut ResumeCursor,
    handle: &Arc<TransferHandle>,
    sink: &ProgressSink,
) -> Result<AttemptOutcome, LocalTransferError> {
    let progress = Arc::new(AtomicU64::new(cursor.offset));
    let mut reporter = ProgressReporter::new(
        handle.clone(),
        sink.clone(),
        cursor.total,
        progress.clone(),
        cursor.offset,
    );
    let stop_handle = handle.clone();
    let attempt = copy_attempt(
        src,
        part,
        dest,
        cursor.offset,
        |t| reporter.report(t),
        move || stop_reason(&stop_handle),
    );
    let result = guard_stall(
        attempt,
        &progress,
        handle,
        STALL_TIMEOUT,
        LocalTransferError::Io,
    )
    .await;
    cursor.offset = progress.load(Ordering::Relaxed);
    result
}

/// Run attempts (with auto-retry/backoff) for one Active stint.
async fn run_attempts(
    src: &str,
    part: &Path,
    dest: &str,
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
        gate_resume(src, part, cursor, handle, sink).await;
        let result = run_one(src, part, dest, cursor, handle, sink).await;
        if let Some(outcome) =
            settle_attempt(result, cursor, &mut attempt, handle, sink, BACKEND, "disk").await
        {
            return outcome;
        }
    }
}

/// Best-effort removal of the temp file on cancel. The destination name is
/// never touched: it still holds whatever was there before the copy started.
async fn cleanup_partial(part: &Path) {
    match tokio::fs::remove_file(part).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => debug!(error = %e, "could not remove partial local copy (best-effort)"),
    }
}

/// Drive a queued local file copy `src` → `dest` to a terminal state on the
/// rich queue model, emitting `transfer-progress` throughout (PARITY-004,
/// #3567).
///
/// Consumes the handle registered via [`TransferRegistry::enqueue`] (under
/// [`LOCAL_TRANSFER_SESSION`]); drops the registry entry on completion, so the
/// generic `transfer_pause` / `resume` / `retry` / `cancel` commands work
/// exactly as for SFTP, FTP and Docker.
///
/// `start_offset` seeds the first stint's resume offset (`0` for a fresh copy;
/// a relaunched checkpoint passes its persisted offset). It is still verified
/// against the temp file before any append.
pub async fn run_local_transfer(
    src: String,
    dest: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    start_offset: u64,
) {
    let part = partial_path(&dest, &handle.transfer_id);
    let baseline = local_fingerprint(&src).await;
    let total = baseline.map(|fp| fp.size).unwrap_or_default();
    let offset = rehydrate_start_offset(start_offset, handle.snapshot().total, baseline);
    if offset != start_offset {
        info!(transfer_id = %handle.transfer_id, start_offset, "local source changed since the checkpoint; restarting from zero");
    }
    handle.set_metrics(offset, total, 0);
    emit(&handle, &sink, TransferPhase::Transferring, None, None);

    let cursor = ResumeCursor {
        offset,
        total,
        baseline,
    };
    let (src, part, dest, handle, sink) = (&src, &part, &dest, &handle, &sink);
    drive_transfer(
        handle,
        &registry,
        sink,
        BACKEND,
        cursor,
        |mut cursor| async move {
            let result = run_attempts(src, part, dest, &mut cursor, handle, sink).await;
            (result, cursor)
        },
        || cleanup_partial(part),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::transfer::{TransferDirection, TransferProgress, TransferStateTag};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    /// Deterministic, non-repeating-per-chunk test content.
    fn content(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    /// A sink recording every emitted phase.
    fn recording_sink() -> (ProgressSink, Arc<Mutex<Vec<TransferPhase>>>) {
        let phases = Arc::new(Mutex::new(Vec::new()));
        let rec = phases.clone();
        let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
            rec.lock().expect("lock").push(p.phase);
        });
        (sink, phases)
    }

    fn enqueue(reg: &TransferRegistry, id: &str, dest: &str, total: u64) -> Arc<TransferHandle> {
        reg.enqueue(
            id,
            LOCAL_TRANSFER_SESSION,
            TransferDirection::Download,
            "f",
            dest,
            total,
        )
    }

    #[test]
    fn threshold_keeps_small_files_direct() {
        assert!(!should_queue_local_copy(0));
        assert!(!should_queue_local_copy(DIRECT_COPY_MAX_BYTES));
        assert!(should_queue_local_copy(DIRECT_COPY_MAX_BYTES + 1));
    }

    #[test]
    fn partial_path_is_a_hidden_tagged_sibling() {
        let p = partial_path("/data/out/big.iso", "3f2a-9b1c-77de-0000");
        assert_eq!(p, Path::new("/data/out/.big.iso.3f2a9b1c.termihub-part"));
        // Windows / WSL UNC paths as the frontend passes them (forward slashes).
        let p = partial_path("//wsl$/Ubuntu/home/u/a.bin", "abcdef123456");
        assert_eq!(
            p,
            Path::new("//wsl$/Ubuntu/home/u/.a.bin.abcdef12.termihub-part")
        );
    }

    #[test]
    fn copy_error_names_the_phase() {
        let e = copy_error(CopyPhase::Read, std::io::Error::other("eio"));
        assert_eq!(e.to_string(), "Local copy error: read failed: eio");
    }

    #[tokio::test]
    async fn attempt_copies_in_chunks_and_renames_on_completion() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = content(CHUNK_SIZE * 3 + 17);
        let src = dir.path().join("src.bin");
        std::fs::write(&src, &data).expect("write");
        let dest = dir.path().join("nested/dst.bin");
        let part = partial_path(&s(&dest), "t1");

        let mut reports = Vec::new();
        let outcome = copy_attempt(
            &s(&src),
            &part,
            &s(&dest),
            0,
            |t| reports.push(t),
            || None,
        )
        .await
        .expect("copy");

        assert_eq!(
            outcome,
            AttemptOutcome::Completed {
                transferred: data.len() as u64
            }
        );
        // One progress report per chunk → the copy really was chunked.
        assert_eq!(reports.len(), 4);
        assert_eq!(std::fs::read(&dest).expect("read"), data);
        assert!(!part.exists(), "temp file must be renamed away");
    }

    #[tokio::test]
    async fn stopped_attempt_never_touches_the_destination_and_resumes_from_offset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = content(CHUNK_SIZE * 4);
        let src = dir.path().join("src.bin");
        std::fs::write(&src, &data).expect("write");
        let dest = dir.path().join("dst.bin");
        std::fs::write(&dest, b"previous contents").expect("seed dest");
        let part = partial_path(&s(&dest), "t2");

        // Pause after two chunks.
        let chunks = AtomicUsize::new(0);
        let outcome = copy_attempt(
            &s(&src),
            &part,
            &s(&dest),
            0,
            |_| {
                chunks.fetch_add(1, Ordering::SeqCst);
            },
            || (chunks.load(Ordering::SeqCst) >= 2).then_some(StopReason::Pause),
        )
        .await
        .expect("copy");
        let reached = (CHUNK_SIZE * 2) as u64;
        assert_eq!(
            outcome,
            AttemptOutcome::Stopped {
                transferred: reached,
                reason: StopReason::Pause,
            }
        );
        // The destination name still holds the old file; the partial is aside.
        assert_eq!(std::fs::read(&dest).expect("read"), b"previous contents");
        assert_eq!(std::fs::metadata(&part).expect("part").len(), reached);

        // Resume from the offset: only the tail is copied.
        let mut reports = Vec::new();
        let outcome = copy_attempt(
            &s(&src),
            &part,
            &s(&dest),
            reached,
            |t| reports.push(t),
            || None,
        )
        .await
        .expect("resume");
        assert_eq!(
            outcome,
            AttemptOutcome::Completed {
                transferred: data.len() as u64
            }
        );
        assert_eq!(reports.first().copied(), Some(reached + CHUNK_SIZE as u64));
        assert_eq!(std::fs::read(&dest).expect("read"), data);
        assert!(!part.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn completed_copy_carries_the_source_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("run.sh");
        std::fs::write(&src, b"#!/bin/sh\n").expect("write");
        std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o750)).expect("chmod");
        let dest = dir.path().join("copy.sh");
        let part = partial_path(&s(&dest), "t3");
        copy_attempt(&s(&src), &part, &s(&dest), 0, |_| {}, || None)
            .await
            .expect("copy");
        let mode = std::fs::metadata(&dest).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
    }

    #[tokio::test]
    async fn executor_completes_and_emits_done() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = content(CHUNK_SIZE * 2 + 5);
        let src = dir.path().join("src.bin");
        std::fs::write(&src, &data).expect("write");
        let dest = dir.path().join("out/dst.bin");
        let reg = TransferRegistry::new();
        let handle = enqueue(&reg, "done-1", &s(&dest), 0);
        let (sink, phases) = recording_sink();

        run_local_transfer(s(&src), s(&dest), handle.clone(), reg.clone(), sink, 0).await;

        assert_eq!(std::fs::read(&dest).expect("read"), data);
        assert_eq!(handle.state().tag(), TransferStateTag::Completed);
        assert_eq!(handle.snapshot().transferred, data.len() as u64);
        assert_eq!(
            phases.lock().expect("lock").last(),
            Some(&TransferPhase::Done)
        );
        assert!(reg.get("done-1").is_none(), "registry entry dropped");
        assert!(!partial_path(&s(&dest), "done-1").exists());
    }

    #[tokio::test]
    async fn executor_cancel_removes_the_partial_and_keeps_the_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("src.bin");
        std::fs::write(&src, content(CHUNK_SIZE * 2)).expect("write");
        let dest = dir.path().join("dst.bin");
        std::fs::write(&dest, b"keep me").expect("seed dest");
        let reg = TransferRegistry::new();
        let handle = enqueue(&reg, "cancel-1", &s(&dest), 0);
        let part = partial_path(&s(&dest), "cancel-1");
        // A partial from an earlier stint that the cancel must clean up.
        std::fs::write(&part, b"partial").expect("seed part");

        // Pause at the first chunk boundary, then cancel while paused.
        assert!(reg.pause("cancel-1"));
        let (sink, phases) = recording_sink();
        let task = tokio::spawn(run_local_transfer(
            s(&src),
            s(&dest),
            handle.clone(),
            reg.clone(),
            sink,
            0,
        ));
        wait_for(|| handle.state().tag() == TransferStateTag::Paused).await;
        assert!(reg.cancel("cancel-1"));
        task.await.expect("join");

        assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
        assert!(!part.exists(), "partial removed on cancel");
        assert_eq!(std::fs::read(&dest).expect("read"), b"keep me");
        assert_eq!(
            phases.lock().expect("lock").last(),
            Some(&TransferPhase::Cancelled)
        );
    }

    #[tokio::test]
    async fn executor_pause_then_resume_completes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = content(CHUNK_SIZE * 3);
        let src = dir.path().join("src.bin");
        std::fs::write(&src, &data).expect("write");
        let dest = dir.path().join("dst.bin");
        let reg = TransferRegistry::new();
        let handle = enqueue(&reg, "pause-1", &s(&dest), 0);

        assert!(reg.pause("pause-1"));
        let (sink, _) = recording_sink();
        let task = tokio::spawn(run_local_transfer(
            s(&src),
            s(&dest),
            handle.clone(),
            reg.clone(),
            sink,
            0,
        ));
        wait_for(|| handle.state().tag() == TransferStateTag::Paused).await;
        assert!(!dest.exists(), "nothing at the destination while paused");
        assert!(reg.resume("pause-1"));
        task.await.expect("join");

        assert_eq!(handle.state().tag(), TransferStateTag::Completed);
        assert_eq!(std::fs::read(&dest).expect("read"), data);
    }

    #[tokio::test]
    async fn executor_resumes_a_relaunched_checkpoint_from_its_partial() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = content(CHUNK_SIZE * 2);
        let src = dir.path().join("src.bin");
        std::fs::write(&src, &data).expect("write");
        let dest = dir.path().join("dst.bin");
        let reg = TransferRegistry::new();
        let total = data.len() as u64;
        let handle = enqueue(&reg, "relaunch-1", &s(&dest), total);
        // A marker prefix proves the copy appended to the partial instead of
        // restarting (a real partial would hold the source's own bytes).
        let offset = 1000u64;
        std::fs::write(partial_path(&s(&dest), "relaunch-1"), vec![b'X'; 1000]).expect("part");

        let (sink, _) = recording_sink();
        run_local_transfer(s(&src), s(&dest), handle, reg, sink, offset).await;

        let out = std::fs::read(&dest).expect("read");
        assert_eq!(out.len(), data.len());
        assert!(out[..1000].iter().all(|&b| b == b'X'));
        assert_eq!(&out[1000..], &data[1000..]);
    }

    #[tokio::test]
    async fn executor_restarts_when_the_source_changed_since_the_checkpoint() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data = content(CHUNK_SIZE + 3);
        let src = dir.path().join("src.bin");
        std::fs::write(&src, &data).expect("write");
        let dest = dir.path().join("dst.bin");
        let reg = TransferRegistry::new();
        // The persisted total no longer matches the source's size.
        let handle = enqueue(&reg, "changed-1", &s(&dest), 42);
        std::fs::write(partial_path(&s(&dest), "changed-1"), vec![b'X'; 1000]).expect("part");

        let (sink, _) = recording_sink();
        run_local_transfer(s(&src), s(&dest), handle, reg, sink, 1000).await;

        assert_eq!(std::fs::read(&dest).expect("read"), data);
    }

    #[tokio::test]
    async fn executor_fails_permanently_on_a_missing_source_without_a_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("missing.bin");
        let dest = dir.path().join("dst.bin");
        let reg = TransferRegistry::new();
        let handle = enqueue(&reg, "missing-1", &s(&dest), 0);
        let (sink, phases) = recording_sink();
        let task = tokio::spawn(run_local_transfer(
            s(&src),
            s(&dest),
            handle.clone(),
            reg.clone(),
            sink,
            0,
        ));
        // Retryable failures back off first; the Error phase marks the
        // permanent one, after the retry budget is spent.
        wait_for(|| phases.lock().expect("lock").contains(&TransferPhase::Error)).await;
        assert_eq!(handle.state().tag(), TransferStateTag::Failed);
        assert!(!dest.exists());
        // A failed transfer waits for a manual retry; cancel ends it.
        assert!(reg.cancel("missing-1"));
        task.await.expect("join");
        assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
    }

    /// Poll `cond` (yielding to the executor) until it holds, bounded.
    async fn wait_for(cond: impl Fn() -> bool) {
        for _ in 0..20_000 {
            if cond() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        panic!("condition not reached");
    }
}
