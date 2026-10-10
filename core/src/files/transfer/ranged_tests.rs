//! Tests for the ranged transfer executor (#3587).
//!
//! They drive [`run_ranged_transfer`] against an in-memory target that follows
//! the [`RangedFileAccess`] rules exactly (a write must land at the current
//! size), with fault injection, so pause/resume, retry-from-verified-offset
//! and cancel are exercised without an agent.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

use super::*;
use crate::files::transfer::{TransferProgress, TransferStateTag};

const REMOTE: &str = "/srv/data.bin";

/// Deterministic, non-repeating-per-chunk test content.
fn content(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// An in-memory remote filesystem with fault injection.
#[derive(Default)]
struct MemTarget {
    files: Mutex<HashMap<String, Vec<u8>>>,
    /// Offsets of every `read_range`, in order.
    reads: Mutex<Vec<u64>>,
    /// Offsets of every `write_range`, in order.
    writes: Mutex<Vec<u64>>,
    /// Fail the call with this (1-based) index once.
    fail_read_call: AtomicUsize,
    fail_write_call: AtomicUsize,
    /// Number of `stat` calls so far.
    stat_calls: AtomicUsize,
    /// Park every `stat` call from this (1-based) index on forever — a dead
    /// connection (#4672). `0` never parks.
    park_stat_from: AtomicUsize,
}

impl MemTarget {
    fn with_file(data: Vec<u8>) -> Arc<Self> {
        let target = Self::default();
        target.files.lock().unwrap().insert(REMOTE.into(), data);
        Arc::new(target)
    }

    fn file(&self) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(REMOTE).cloned()
    }

    fn should_fail(trigger: &AtomicUsize, calls: usize) -> bool {
        trigger
            .compare_exchange(calls, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[async_trait::async_trait]
impl RangedFileAccess for MemTarget {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        let calls = {
            let mut reads = self.reads.lock().unwrap();
            reads.push(offset);
            reads.len()
        };
        if Self::should_fail(&self.fail_read_call, calls) {
            return Err(FileError::OperationFailed("link dropped".into()));
        }
        let files = self.files.lock().unwrap();
        let data = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        let start = (offset as usize).min(data.len());
        let end = (start + len as usize).min(data.len());
        Ok(data[start..end].to_vec())
    }

    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        let calls = {
            let mut writes = self.writes.lock().unwrap();
            writes.push(offset);
            writes.len()
        };
        if Self::should_fail(&self.fail_write_call, calls) {
            return Err(FileError::OperationFailed("link dropped".into()));
        }
        let mut files = self.files.lock().unwrap();
        if offset == 0 {
            files.insert(path.into(), data.to_vec());
            return Ok(());
        }
        let file = files
            .get_mut(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        if file.len() as u64 != offset {
            return Err(crate::files::ranged::offset_mismatch(
                path,
                file.len() as u64,
                offset,
            ));
        }
        file.extend_from_slice(data);
        Ok(())
    }
}

#[async_trait::async_trait]
impl RangedTransferTarget for MemTarget {
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let call = self.stat_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let park_from = self.park_stat_from.load(Ordering::SeqCst);
        if park_from != 0 && call >= park_from {
            std::future::pending::<()>().await;
        }
        let files = self.files.lock().unwrap();
        let data = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        Ok(FileEntry {
            name: "data.bin".into(),
            path: path.into(),
            size: data.len() as u64,
            modified: "2026-10-05T12:00:00Z".into(),
            ..FileEntry::default()
        })
    }

    async fn remove_file(&self, path: &str) -> Result<(), FileError> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }
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

fn enqueue(reg: &TransferRegistry, id: &str, direction: TransferDirection) -> Arc<TransferHandle> {
    reg.enqueue(id, "agent-session", direction, "data.bin", REMOTE, 0)
}

async fn wait_for(cond: impl Fn() -> bool) {
    for _ in 0..20_000 {
        if cond() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("condition not reached");
}

fn run(
    target: &Arc<MemTarget>,
    direction: TransferDirection,
    local: &Path,
    handle: &Arc<TransferHandle>,
    reg: &TransferRegistry,
    sink: ProgressSink,
) -> impl std::future::Future<Output = ()> + Send + 'static {
    run_ranged_transfer(
        target.clone(),
        direction,
        REMOTE.into(),
        s(local),
        handle.clone(),
        reg.clone(),
        sink,
        0,
    )
}

#[test]
fn mtime_token_is_stable_and_tracks_the_timestamp() {
    let a = mtime_token("2026-10-05T12:00:00Z");
    assert_eq!(a, mtime_token("2026-10-05T12:00:00Z"));
    assert_ne!(a, mtime_token("2026-10-05T12:00:01Z"));
    assert_eq!(mtime_token(""), None);
}

#[tokio::test]
async fn download_moves_the_file_in_chunks_and_completes() {
    let data = content(CHUNK_SIZE * 3 + 17);
    let target = MemTarget::with_file(data.clone());
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("out.bin");
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "dl-1", TransferDirection::Download);
    let (sink, phases) = recording_sink();

    run(
        &target,
        TransferDirection::Download,
        &local,
        &handle,
        &reg,
        sink,
    )
    .await;

    assert_eq!(std::fs::read(&local).unwrap(), data);
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(handle.snapshot().transferred, data.len() as u64);
    assert_eq!(handle.snapshot().total, data.len() as u64);
    assert_eq!(phases.lock().unwrap().last(), Some(&TransferPhase::Done));
    assert!(reg.get("dl-1").is_none(), "registry entry dropped");
    let step = CHUNK_SIZE as u64;
    assert_eq!(
        *target.reads.lock().unwrap(),
        vec![0, step, 2 * step, 3 * step]
    );
}

#[tokio::test]
async fn upload_moves_the_file_in_chunks_and_completes() {
    let data = content(CHUNK_SIZE * 2 + 5);
    let target = Arc::new(MemTarget::default());
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("in.bin");
    std::fs::write(&local, &data).unwrap();
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "ul-1", TransferDirection::Upload);
    let (sink, phases) = recording_sink();

    run(
        &target,
        TransferDirection::Upload,
        &local,
        &handle,
        &reg,
        sink,
    )
    .await;

    assert_eq!(target.file().unwrap(), data);
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(phases.lock().unwrap().last(), Some(&TransferPhase::Done));
    let step = CHUNK_SIZE as u64;
    assert_eq!(*target.writes.lock().unwrap(), vec![0, step, 2 * step]);
}

#[tokio::test]
async fn an_exact_multiple_of_the_chunk_size_sends_no_empty_tail() {
    let data = content(CHUNK_SIZE * 2);
    let target = Arc::new(MemTarget::default());
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("in.bin");
    std::fs::write(&local, &data).unwrap();
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "ul-exact", TransferDirection::Upload);
    let (sink, _) = recording_sink();

    run(
        &target,
        TransferDirection::Upload,
        &local,
        &handle,
        &reg,
        sink,
    )
    .await;

    assert_eq!(target.file().unwrap(), data);
    assert_eq!(target.writes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn an_empty_upload_still_creates_the_remote_file() {
    let target = Arc::new(MemTarget::default());
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("empty.bin");
    std::fs::write(&local, b"").unwrap();
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "ul-empty", TransferDirection::Upload);
    let (sink, _) = recording_sink();

    run(
        &target,
        TransferDirection::Upload,
        &local,
        &handle,
        &reg,
        sink,
    )
    .await;

    assert_eq!(target.file().unwrap(), b"");
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
}

#[tokio::test]
async fn pause_then_resume_completes() {
    let data = content(CHUNK_SIZE * 3);
    let target = MemTarget::with_file(data.clone());
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("out.bin");
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "pause-1", TransferDirection::Download);

    assert!(reg.pause("pause-1"));
    let (sink, _) = recording_sink();
    let task = tokio::spawn(run(
        &target,
        TransferDirection::Download,
        &local,
        &handle,
        &reg,
        sink,
    ));
    wait_for(|| handle.state().tag() == TransferStateTag::Paused).await;
    assert!(reg.resume("pause-1"));
    task.await.unwrap();

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(std::fs::read(&local).unwrap(), data);
}

#[tokio::test]
async fn a_failed_download_chunk_retries_from_the_verified_offset() {
    let data = content(CHUNK_SIZE * 4);
    let target = MemTarget::with_file(data.clone());
    // The third read (offset 2 chunks) fails once.
    target.fail_read_call.store(3, Ordering::SeqCst);
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("out.bin");
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "retry-dl", TransferDirection::Download);
    let (sink, _) = recording_sink();

    run(
        &target,
        TransferDirection::Download,
        &local,
        &handle,
        &reg,
        sink,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(std::fs::read(&local).unwrap(), data);
    let step = CHUNK_SIZE as u64;
    // The retry continues at the failed chunk; it never starts over at zero.
    assert_eq!(
        *target.reads.lock().unwrap(),
        vec![0, step, 2 * step, 2 * step, 3 * step, 4 * step]
    );
}

#[tokio::test]
async fn a_failed_upload_chunk_retries_from_the_remote_size() {
    let data = content(CHUNK_SIZE * 3 + 9);
    let target = Arc::new(MemTarget::default());
    // The second write (offset 1 chunk) fails once.
    target.fail_write_call.store(2, Ordering::SeqCst);
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("in.bin");
    std::fs::write(&local, &data).unwrap();
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "retry-ul", TransferDirection::Upload);
    let (sink, _) = recording_sink();

    run(
        &target,
        TransferDirection::Upload,
        &local,
        &handle,
        &reg,
        sink,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(target.file().unwrap(), data);
    let step = CHUNK_SIZE as u64;
    assert_eq!(
        *target.writes.lock().unwrap(),
        vec![0, step, step, 2 * step, 3 * step]
    );
}

#[tokio::test]
async fn cancelling_an_upload_removes_the_remote_partial() {
    let target = Arc::new(MemTarget::default());
    target
        .files
        .lock()
        .unwrap()
        .insert(REMOTE.into(), b"partial".to_vec());
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("in.bin");
    std::fs::write(&local, content(CHUNK_SIZE * 2)).unwrap();
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "cancel-ul", TransferDirection::Upload);

    assert!(reg.pause("cancel-ul"));
    let (sink, phases) = recording_sink();
    let task = tokio::spawn(run(
        &target,
        TransferDirection::Upload,
        &local,
        &handle,
        &reg,
        sink,
    ));
    wait_for(|| handle.state().tag() == TransferStateTag::Paused).await;
    assert!(reg.cancel("cancel-ul"));
    task.await.unwrap();

    assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
    assert!(target.file().is_none(), "remote partial removed on cancel");
    assert_eq!(
        phases.lock().unwrap().last(),
        Some(&TransferPhase::Cancelled)
    );
}

#[tokio::test]
async fn cancelling_a_download_removes_the_local_partial() {
    let target = MemTarget::with_file(content(CHUNK_SIZE * 2));
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("out.bin");
    std::fs::write(&local, b"partial").unwrap();
    let reg = TransferRegistry::new();
    let handle = enqueue(&reg, "cancel-dl", TransferDirection::Download);

    assert!(reg.pause("cancel-dl"));
    let (sink, _) = recording_sink();
    let task = tokio::spawn(run(
        &target,
        TransferDirection::Download,
        &local,
        &handle,
        &reg,
        sink,
    ));
    wait_for(|| handle.state().tag() == TransferStateTag::Paused).await;
    assert!(reg.cancel("cancel-dl"));
    task.await.unwrap();

    assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
    assert!(!local.exists(), "local partial removed on cancel");
}

// ── a cancel while a probe is parked settles promptly (#4672) ───────────────

/// Run a download whose `park_stat_from`-th `stat` never resolves, cancel it
/// once that call is parked, and assert it settles as cancelled promptly,
/// exactly once, with its slot handed to a queued peer.
async fn cancel_during_parked_stat(park_stat_from: usize) {
    let target = MemTarget::with_file(content(CHUNK_SIZE * 2));
    target
        .park_stat_from
        .store(park_stat_from, Ordering::SeqCst);
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("out.bin");
    let reg = TransferRegistry::with_max_concurrent(1);
    let handle = enqueue(&reg, "parked", TransferDirection::Download);
    let peer = enqueue(&reg, "peer", TransferDirection::Download);
    let (sink, phases) = recording_sink();
    let task = tokio::spawn(run(
        &target,
        TransferDirection::Download,
        &local,
        &handle,
        &reg,
        sink,
    ));
    wait_for(|| target.stat_calls.load(Ordering::SeqCst) >= park_stat_from).await;
    // Parked inside the stint, the transfer holds the session's only slot.
    if park_stat_from > 1 {
        use crate::files::transfer::scheduler::Admission;
        assert_eq!(reg.request_slot(&peer), Admission::Queue);
    }
    assert!(reg.cancel("parked"));
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("a cancel during a parked probe settles promptly")
        .unwrap();

    assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
    let phases = phases.lock().unwrap();
    let cancelled = phases
        .iter()
        .filter(|p| **p == TransferPhase::Cancelled)
        .count();
    assert_eq!(cancelled, 1, "exactly one terminal emit: {phases:?}");
    assert_eq!(phases.last(), Some(&TransferPhase::Cancelled));
    assert!(reg.get("parked").is_none(), "registry entry dropped");
    assert!(
        target.reads.lock().unwrap().is_empty(),
        "no bytes were read"
    );
    if park_stat_from > 1 {
        assert!(peer.state().is_active(), "the slot passed to the peer");
    } else {
        use crate::files::transfer::scheduler::Admission;
        assert_eq!(reg.request_slot(&peer), Admission::Run, "no slot was held");
    }
}

#[tokio::test]
async fn cancel_during_the_up_front_probe_settles_promptly() {
    cancel_during_parked_stat(1).await;
}

#[tokio::test]
async fn cancel_during_the_per_attempt_resume_probe_settles_promptly() {
    cancel_during_parked_stat(2).await;
}
