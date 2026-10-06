//! Remote→remote copies with a ranged end (#4115): an in-memory
//! [`RangedTransferTarget`] that follows the [`RangedFileAccess`] rules
//! exactly (a write must land at the current size) stands in for an
//! agent-hosted session, paired with the SFTP/Docker mock endpoints of the
//! parent module or with a second ranged end (agent→agent).

use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use super::*;
use crate::errors::FileError;
use crate::files::transfer::ranged::mtime_token;
use crate::files::{FileEntry, RangedFileAccess, MAX_RANGE_BYTES};

const SLICE: u64 = MAX_RANGE_BYTES as u64;

/// An in-memory agent-hosted session serving ranged slices.
#[derive(Default)]
struct MemRanged {
    files: Mutex<HashMap<String, MockFile>>,
    /// `(offset, len)` of every `read_range` / `write_range`, in order.
    reads: Mutex<Vec<(u64, usize)>>,
    writes: Mutex<Vec<(u64, usize)>>,
    /// Fail the call with this (1-based) index once.
    fail_read_call: AtomicUsize,
    fail_write_call: AtomicUsize,
    /// Refuse the slice probe with this reason.
    refuse_probe: Option<String>,
    /// Called with the destination size after each write lands.
    on_write: Mutex<Option<WriteHook>>,
}

impl MemRanged {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn put(&self, path: &str, data: Vec<u8>, mtime: u64) {
        self.files
            .lock()
            .expect("files")
            .insert(path.to_string(), MockFile { data, mtime });
    }

    fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.files
            .lock()
            .expect("files")
            .get(path)
            .map(|f| f.data.clone())
    }

    fn truncate(&self, path: &str, len: usize) {
        if let Some(file) = self.files.lock().expect("files").get_mut(path) {
            file.data.truncate(len);
        }
    }

    fn reads(&self) -> Vec<(u64, usize)> {
        self.reads.lock().expect("reads").clone()
    }

    fn writes(&self) -> Vec<(u64, usize)> {
        self.writes.lock().expect("writes").clone()
    }

    fn set_hook(&self, hook: WriteHook) {
        *self.on_write.lock().expect("hook") = Some(hook);
    }

    fn should_fail(trigger: &AtomicUsize, calls: usize) -> bool {
        trigger
            .compare_exchange(calls, 0, AtomicOrdering::SeqCst, AtomicOrdering::SeqCst)
            .is_ok()
    }

    /// This target as one end of a copy, the way the desktop resolves it.
    fn endpoint(self: &Arc<Self>) -> Arc<dyn CopyEndpoint> {
        RemoteCopyEndpoint::Ranged(self.clone()).into_endpoint()
    }
}

#[async_trait]
impl RangedFileAccess for MemRanged {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        assert!(len <= MAX_RANGE_BYTES, "a slice never exceeds the cap");
        let calls = {
            let mut reads = self.reads.lock().expect("reads");
            reads.push((offset, len as usize));
            reads.len()
        };
        if Self::should_fail(&self.fail_read_call, calls) {
            return Err(FileError::OperationFailed("agent link dropped".into()));
        }
        let files = self.files.lock().expect("files");
        let file = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        let start = (offset as usize).min(file.data.len());
        let end = (start + len as usize).min(file.data.len());
        Ok(file.data[start..end].to_vec())
    }

    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        assert!(data.len() as u64 <= SLICE, "a slice never exceeds the cap");
        let calls = {
            let mut writes = self.writes.lock().expect("writes");
            writes.push((offset, data.len()));
            writes.len()
        };
        if Self::should_fail(&self.fail_write_call, calls) {
            return Err(FileError::OperationFailed("agent link dropped".into()));
        }
        let size = {
            let mut files = self.files.lock().expect("files");
            if offset == 0 {
                files.insert(
                    path.into(),
                    MockFile {
                        data: data.to_vec(),
                        mtime: 1,
                    },
                );
                data.len() as u64
            } else {
                let file = files
                    .get_mut(path)
                    .ok_or_else(|| FileError::NotFound(path.into()))?;
                let present = file.data.len() as u64;
                if present != offset {
                    return Err(crate::files::ranged::offset_mismatch(path, present, offset));
                }
                file.data.extend_from_slice(data);
                file.data.len() as u64
            }
        };
        let hook = self.on_write.lock().expect("hook").clone();
        if let Some(hook) = hook {
            hook(size);
        }
        Ok(())
    }

    async fn probe(&self) -> Result<(), FileError> {
        match &self.refuse_probe {
            Some(reason) => Err(FileError::OperationFailed(reason.clone())),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl RangedTransferTarget for MemRanged {
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let files = self.files.lock().expect("files");
        let file = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        Ok(FileEntry {
            name: "data.bin".into(),
            path: path.into(),
            size: file.data.len() as u64,
            modified: format!("mtime-{}", file.mtime),
            ..FileEntry::default()
        })
    }

    async fn remove_file(&self, path: &str) -> Result<(), FileError> {
        self.files.lock().expect("files").remove(path);
        Ok(())
    }
}

/// Every write starts where the previous one ended, from `from`.
fn assert_contiguous(writes: &[(u64, usize)], from: u64) {
    let mut expected = from;
    for &(offset, len) in writes {
        assert_eq!(offset, expected, "writes are contiguous: {writes:?}");
        expected += len as u64;
    }
}

#[tokio::test]
async fn agent_to_sftp_copies_byte_exact_in_slices() {
    let src = MemRanged::new();
    let dst = MockEndpoint::server();
    let data = content(2 * MIB + 123, 0);
    src.put(SRC, data.clone(), 7);

    let run = Run::start_ends(src.endpoint(), dst.clone(), 0, None);
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    let last = events.last().expect("done event");
    assert_eq!(last.transferred, data.len() as u64);
    assert_eq!(last.total, data.len() as u64);
    // One 256 KiB request per slice, at consecutive offsets; the short
    // ninth slice ends the file.
    let reads = src.reads();
    assert_eq!(reads.len(), 9);
    for (i, &(offset, len)) in reads.iter().enumerate() {
        assert_eq!(offset, i as u64 * SLICE);
        assert_eq!(len as u64, SLICE);
    }
}

#[tokio::test]
async fn docker_to_agent_writes_full_slices_at_the_expected_offsets() {
    let src = MockEndpoint::container();
    let dst = MemRanged::new();
    let data = content(MIB + 5, 1);
    src.put(SRC, data.clone(), 3);

    let run = Run::start_ends(src.clone(), dst.endpoint(), 0, None);
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    let writes = dst.writes();
    assert_contiguous(&writes, 0);
    assert_eq!(
        writes.iter().map(|&(_, len)| len).collect::<Vec<_>>(),
        [
            SLICE as usize,
            SLICE as usize,
            SLICE as usize,
            SLICE as usize,
            5
        ]
    );
}

#[tokio::test]
async fn agent_to_agent_copies_byte_exact() {
    let src = MemRanged::new();
    let dst = MemRanged::new();
    let data = content(3 * MIB / 2, 2);
    src.put(SRC, data.clone(), 5);

    let run = Run::start_ends(src.endpoint(), dst.endpoint(), 0, None);
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_contiguous(&dst.writes(), 0);
}

/// An empty source still creates an (empty) destination.
#[tokio::test]
async fn an_empty_source_creates_an_empty_agent_destination() {
    let src = MockEndpoint::server();
    let dst = MemRanged::new();
    src.put(SRC, Vec::new(), 1);

    let run = Run::start_ends(src.clone(), dst.endpoint(), 0, None);
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(&[][..]));
    assert_eq!(dst.writes(), [(0, 0)]);
}

#[tokio::test]
async fn pause_then_resume_into_an_agent_continues_from_the_landed_bytes() {
    let src = MockEndpoint::server();
    let dst = MemRanged::new();
    let data = content(3 * MIB, 3);
    src.put(SRC, data.clone(), 9);

    let run = Run::start_ends(src.clone(), dst.endpoint(), 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;

    // Pausing settles the staged slice, so the partial is exactly what was
    // counted, and it is a prefix of the source.
    let partial = dst.get(DST).expect("partial kept while paused");
    assert!(partial.len() >= MIB && partial.len() < 3 * MIB);
    assert_eq!(partial.as_slice(), &data[..partial.len()]);
    let writes_before = dst.writes().len();

    assert!(run.registry.resume(ID));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    let writes = dst.writes();
    assert_contiguous(&writes, 0);
    assert_eq!(writes[writes_before].0, partial.len() as u64);
    assert_eq!(
        src.opens(),
        [Open::Read(0), Open::Read(partial.len() as u64)]
    );
}

#[tokio::test]
async fn pause_then_resume_from_an_agent_reads_from_the_verified_offset() {
    let src = MemRanged::new();
    let dst = MockEndpoint::container();
    let data = content(3 * MIB, 4);
    src.put(SRC, data.clone(), 9);

    let run = Run::start_ends(src.endpoint(), dst.clone(), 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;
    let partial = dst.get(DST).expect("partial").len() as u64;
    let reads_before = src.reads().len();

    assert!(run.registry.resume(ID));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(
        src.reads()[reads_before].0,
        partial,
        "resumed at the offset"
    );
    assert_eq!(dst.opens(), [Open::Write(0), Open::Write(partial)]);
}

/// A destination that lost bytes while paused resumes from what it really
/// holds: every write states its offset, so nothing is spliced past a gap.
#[tokio::test]
async fn a_shrunk_agent_partial_resumes_from_its_real_size() {
    let src = MockEndpoint::server();
    let dst = MemRanged::new();
    let data = content(2 * MIB, 5);
    src.put(SRC, data.clone(), 2);

    let run = Run::start_ends(src.clone(), dst.endpoint(), 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;
    dst.truncate(DST, MIB / 2);
    let writes_before = dst.writes().len();

    assert!(run.registry.resume(ID));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(dst.writes()[writes_before].0, (MIB / 2) as u64);
}

/// A dropped write is retried after the backoff and continues from the
/// slices that landed; the failure names the agent end.
#[tokio::test]
async fn a_failed_agent_write_retries_from_the_landed_slices() {
    let src = MockEndpoint::server();
    let dst = MemRanged::new();
    let data = content(2 * MIB, 6);
    src.put(SRC, data.clone(), 4);
    dst.fail_write_call.store(3, AtomicOrdering::SeqCst);

    let run = Run::start_ends(src.clone(), dst.endpoint(), 0, None);
    let events_handle = run.events.clone();
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    // Two slices landed before the third failed; the retry re-reads the
    // source from there instead of from zero.
    assert_eq!(src.opens(), [Open::Read(0), Open::Read(2 * SLICE)]);
    let writes = dst.writes();
    assert_eq!(writes[3].0, 2 * SLICE, "the failed slice is re-sent");
    assert_contiguous(&writes[3..], 2 * SLICE);
    let messages: Vec<String> = events_handle
        .lock()
        .expect("events")
        .iter()
        .filter_map(|p| p.message.clone())
        .collect();
    assert!(
        messages
            .iter()
            .any(|m| m.starts_with("Agent error: transfer") && m.contains("agent link dropped")),
        "the failure names the agent end: {messages:?}"
    );
}

#[tokio::test]
async fn a_failed_agent_read_retries_from_the_bytes_that_landed() {
    let src = MemRanged::new();
    let dst = MockEndpoint::server();
    let data = content(2 * MIB, 7);
    src.put(SRC, data.clone(), 4);
    src.fail_read_call.store(5, AtomicOrdering::SeqCst);

    let run = Run::start_ends(src.endpoint(), dst.clone(), 0, None);
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(dst.opens(), [Open::Write(0), Open::Write(4 * SLICE)]);
    assert_eq!(src.reads()[5].0, 4 * SLICE, "the failed slice is re-read");
}

#[tokio::test]
async fn cancel_removes_the_partial_agent_destination() {
    let src = MockEndpoint::container();
    let dst = MemRanged::new();
    src.put(SRC, content(3 * MIB, 1), 1);

    let run = Run::start_ends(src.clone(), dst.endpoint(), 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.cancel(ID);
    }));
    let registry = run.registry.clone();
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Cancelled);
    assert_eq!(dst.get(DST), None, "the partial destination is removed");
    assert!(registry.get(ID).is_none());
}

#[tokio::test]
async fn cancel_while_paused_removes_the_partial_agent_destination() {
    let src = MemRanged::new();
    let dst = MemRanged::new();
    src.put(SRC, content(2 * MIB, 1), 1);

    let run = Run::start_ends(src.endpoint(), dst.endpoint(), 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;
    assert!(dst.get(DST).is_some());
    assert!(run.registry.cancel(ID));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Cancelled);
    assert_eq!(dst.get(DST), None);
}

/// A copy relaunched after a restart (#4114) appends to the agent-side
/// partial while the source still has its persisted size and mtime.
#[tokio::test]
async fn a_relaunched_copy_resumes_into_an_agent_partial() {
    let src = MockEndpoint::container();
    let dst = MemRanged::new();
    let data = content(2 * MIB, 8);
    src.put(SRC, data.clone(), 42);
    dst.put(DST, data[..MIB].to_vec(), 1);

    let run = Run::start_ends(
        src.clone(),
        dst.endpoint(),
        MIB as u64,
        Some((data.len() as u64, 42)),
    );
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(events.first().map(|p| p.transferred), Some(MIB as u64));
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(src.opens(), [Open::Read(MIB as u64)]);
    assert_contiguous(&dst.writes(), MIB as u64);
}

/// An agent source whose mtime changed while the app was closed restarts
/// the relaunched copy from zero.
#[tokio::test]
async fn a_relaunched_copy_from_a_changed_agent_source_restarts() {
    let src = MemRanged::new();
    let dst = MockEndpoint::server();
    let data = content(2 * MIB, 9);
    src.put(SRC, data.clone(), 43);
    dst.put(DST, content(MIB, 99), 1);

    // The persisted mtime token is the fingerprint of "mtime-42".
    let stale = mtime_token("mtime-42").expect("a token");
    let run = Run::start_ends(
        src.endpoint(),
        dst.clone(),
        MIB as u64,
        Some((data.len() as u64, stale)),
    );
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(dst.opens(), [Open::Write(0)]);
    assert_eq!(src.reads()[0].0, 0);
}

/// A session that refuses the slice probe cannot be linked, and says why.
#[tokio::test]
async fn a_refused_probe_fails_the_link_with_its_reason() {
    let target = Arc::new(MemRanged {
        refuse_probe: Some("agent too old".into()),
        ..MemRanged::default()
    });
    let endpoint = target.endpoint();
    let err = match endpoint.link().await {
        Ok(_) => panic!("a refused probe must not link"),
        Err(e) => e,
    };
    assert!(err.contains("ranged file access unavailable"), "{err}");
    assert!(err.contains("agent too old"), "{err}");
    assert_eq!(endpoint.peer(), "agent");
    assert_eq!(endpoint.error_prefix(), "Agent error");
}

#[test]
fn a_ranged_end_debug_prints_its_kind() {
    let end = RemoteCopyEndpoint::Ranged(MemRanged::new());
    assert_eq!(format!("{end:?}"), "Ranged");
}
