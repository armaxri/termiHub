//! Unit tests for the generic remote→remote copy (#3586), driven through
//! in-memory mock endpoints so progress, pause/resume, cancel and the resume
//! checks run without a server or a container.

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::*;
use crate::files::transfer::registry::TransferRegistry;
use crate::files::transfer::{TransferDirection, TransferProgress, TransferStateTag};

const MIB: usize = 1024 * 1024;

/// One file of a mock filesystem.
#[derive(Clone)]
struct MockFile {
    data: Vec<u8>,
    mtime: u64,
}

type MockFs = Arc<Mutex<HashMap<String, MockFile>>>;

/// Which stream a mock endpoint opened, and from which offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Read(u64),
    Write(u64),
}

/// Called by a mock writer with the absolute byte count written so far.
type WriteHook = Arc<dyn Fn(u64) + Send + Sync>;

/// An in-memory endpoint standing in for an SFTP server or a container.
struct MockEndpoint {
    fs: MockFs,
    peer: &'static str,
    prefix: &'static str,
    /// Whether this end can verify and continue a partial read / write (a
    /// container without `tail`/`stat` or `wc` cannot).
    resume_read: bool,
    resume_write: bool,
    /// Refuse any non-zero-offset open (a server rejecting the seek/append).
    reject_offset_open: bool,
    /// Fail the next opened read once this many absolute bytes have been read.
    fail_read_at: Arc<Mutex<Option<u64>>>,
    on_write: Mutex<Option<WriteHook>>,
    opens: Arc<Mutex<Vec<Open>>>,
}

impl MockEndpoint {
    fn new(peer: &'static str, prefix: &'static str) -> Arc<Self> {
        Arc::new(Self {
            fs: Arc::new(Mutex::new(HashMap::new())),
            peer,
            prefix,
            resume_read: true,
            resume_write: true,
            reject_offset_open: false,
            fail_read_at: Arc::new(Mutex::new(None)),
            on_write: Mutex::new(None),
            opens: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn server() -> Arc<Self> {
        Self::new("server", "SSH error")
    }

    fn container() -> Arc<Self> {
        Self::new("container", "Docker error")
    }

    fn with(peer: &'static str, f: impl FnOnce(&mut Self)) -> Arc<Self> {
        let mut ep = Self {
            fs: Arc::new(Mutex::new(HashMap::new())),
            peer,
            prefix: "Mock error",
            resume_read: true,
            resume_write: true,
            reject_offset_open: false,
            fail_read_at: Arc::new(Mutex::new(None)),
            on_write: Mutex::new(None),
            opens: Arc::new(Mutex::new(Vec::new())),
        };
        f(&mut ep);
        Arc::new(ep)
    }

    fn put(&self, path: &str, data: Vec<u8>, mtime: u64) {
        self.fs
            .lock()
            .expect("fs")
            .insert(path.to_string(), MockFile { data, mtime });
    }

    fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.fs
            .lock()
            .expect("fs")
            .get(path)
            .map(|f| f.data.clone())
    }

    fn opens(&self) -> Vec<Open> {
        self.opens.lock().expect("opens").clone()
    }

    fn set_hook(&self, hook: WriteHook) {
        *self.on_write.lock().expect("hook") = Some(hook);
    }
}

#[async_trait]
impl CopyEndpoint for MockEndpoint {
    fn peer(&self) -> &'static str {
        self.peer
    }

    fn error_prefix(&self) -> &'static str {
        self.prefix
    }

    async fn link(&self) -> Result<Box<dyn EndpointLink>, String> {
        Ok(Box::new(MockLink {
            fs: self.fs.clone(),
            resume_read: self.resume_read,
            resume_write: self.resume_write,
            reject_offset_open: self.reject_offset_open,
            fail_read_at: self.fail_read_at.clone(),
            on_write: self.on_write.lock().expect("hook").clone(),
            opens: self.opens.clone(),
        }))
    }

    async fn remove_partial(&self, path: &str) {
        self.fs.lock().expect("fs").remove(path);
    }
}

/// One attempt's access to a mock endpoint.
struct MockLink {
    fs: MockFs,
    resume_read: bool,
    resume_write: bool,
    reject_offset_open: bool,
    fail_read_at: Arc<Mutex<Option<u64>>>,
    on_write: Option<WriteHook>,
    /// Shared with the owning endpoint, which the assertions read.
    opens: Arc<Mutex<Vec<Open>>>,
}

impl MockLink {
    fn log(&self, open: Open) {
        self.opens.lock().expect("opens").push(open);
    }
}

#[async_trait]
impl EndpointLink for MockLink {
    async fn fingerprint(&self, path: &str) -> Option<SourceFingerprint> {
        self.fs
            .lock()
            .expect("fs")
            .get(path)
            .map(|f| SourceFingerprint {
                size: f.data.len() as u64,
                mtime: Some(f.mtime),
            })
    }

    async fn file_size(&self, path: &str) -> Option<u64> {
        self.fs
            .lock()
            .expect("fs")
            .get(path)
            .map(|f| f.data.len() as u64)
    }

    fn can_resume_read(&self) -> bool {
        self.resume_read
    }

    fn can_resume_write(&self) -> bool {
        self.resume_write
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn CopyReader>, OpenError> {
        self.log(Open::Read(offset));
        if offset > 0 && self.reject_offset_open {
            return Err(OpenError::ResumeRejected("seek refused".into()));
        }
        let data = self
            .fs
            .lock()
            .expect("fs")
            .get(path)
            .map(|f| f.data.clone())
            .ok_or_else(|| OpenError::Failed("no such file".into()))?;
        Ok(Box::new(MockReader {
            data,
            pos: offset as usize,
            fail_at: self.fail_read_at.lock().expect("fail").take(),
        }))
    }

    async fn open_write(&self, path: &str, offset: u64) -> Result<Box<dyn CopyWriter>, OpenError> {
        self.log(Open::Write(offset));
        if offset > 0 && self.reject_offset_open {
            return Err(OpenError::ResumeRejected("append refused".into()));
        }
        let mut fs = self.fs.lock().expect("fs");
        if offset == 0 {
            fs.insert(
                path.to_string(),
                MockFile {
                    data: Vec::new(),
                    mtime: 1,
                },
            );
        } else if !fs.contains_key(path) {
            return Err(OpenError::Failed("no partial to append to".into()));
        }
        Ok(Box::new(MockWriter {
            fs: self.fs.clone(),
            path: path.to_string(),
            pos: offset as usize,
            on_write: self.on_write.clone(),
        }))
    }
}

struct MockReader {
    data: Vec<u8>,
    pos: usize,
    fail_at: Option<u64>,
}

impl AsyncRead for MockReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Some(at) = self.fail_at {
            if self.pos as u64 >= at {
                self.fail_at = None;
                return Poll::Ready(Err(io::Error::other("connection reset")));
            }
        }
        let end = (self.pos + buf.remaining()).min(self.data.len());
        let start = self.pos;
        buf.put_slice(&self.data[start..end]);
        self.pos = end;
        Poll::Ready(Ok(()))
    }
}

#[async_trait]
impl CopyReader for MockReader {
    async fn finish(self: Box<Self>) -> io::Result<()> {
        Ok(())
    }
}

struct MockWriter {
    fs: MockFs,
    path: String,
    pos: usize,
    on_write: Option<WriteHook>,
}

impl AsyncWrite for MockWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let pos = self.pos;
        {
            let mut fs = self.fs.lock().expect("fs");
            let file = fs
                .get_mut(&self.path)
                .ok_or_else(|| io::Error::other("destination vanished"))?;
            file.data.truncate(pos);
            file.data.extend_from_slice(buf);
        }
        self.pos += buf.len();
        if let Some(hook) = &self.on_write {
            hook(self.pos as u64);
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[async_trait]
impl CopyWriter for MockWriter {
    async fn finish(self: Box<Self>) -> io::Result<()> {
        Ok(())
    }
}

/// A deterministic, non-repeating byte pattern.
fn content(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| ((i % 251) as u8).wrapping_add(seed)).collect()
}

/// A copy running on its own task plus everything it emitted.
struct Run {
    registry: TransferRegistry,
    handle: Arc<TransferHandle>,
    events: Arc<Mutex<Vec<TransferProgress>>>,
    task: tokio::task::JoinHandle<()>,
}

const ID: &str = "r2r";
const SRC: &str = "/src/data.bin";
const DST: &str = "/dst/data.bin";

impl Run {
    /// Register a copy (with the persisted `total` / source mtime a relaunch
    /// seeds) and start it from `start_offset`.
    fn start(
        src: &Arc<MockEndpoint>,
        dst: &Arc<MockEndpoint>,
        start_offset: u64,
        seed: Option<(u64, u64)>,
    ) -> Self {
        let registry = TransferRegistry::new();
        let total = seed.map(|(total, _)| total).unwrap_or(0);
        let handle = registry.enqueue(ID, "dst", TransferDirection::Upload, "data.bin", DST, total);
        if let Some((_, mtime)) = seed {
            handle.set_source_mtime(Some(mtime));
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorder = events.clone();
        let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
            recorder.lock().expect("events").push(p.clone());
        });
        let task = tokio::spawn(run_copy(
            src.clone(),
            dst.clone(),
            SRC.to_string(),
            DST.to_string(),
            handle.clone(),
            registry.clone(),
            sink,
            ResumeMode::Resume,
            start_offset,
        ));
        Self {
            registry,
            handle,
            events,
            task,
        }
    }

    async fn wait_for(&self, tag: TransferStateTag) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.handle.snapshot().state != tag {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("transfer never reached {tag:?}"));
    }

    async fn finish(self) -> Vec<TransferProgress> {
        tokio::time::timeout(Duration::from_secs(30), self.task)
            .await
            .expect("copy settles")
            .expect("copy task");
        let events = self.events.lock().expect("events").clone();
        events
    }
}

/// A hook that fires `action` once, when the written byte count first
/// reaches `at`.
fn once_at(at: u64, action: impl Fn() + Send + Sync + 'static) -> WriteHook {
    let fired = Arc::new(AtomicBool::new(false));
    Arc::new(move |written| {
        if written >= at && !fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
            action();
        }
    })
}

fn terminal(events: &[TransferProgress]) -> TransferPhase {
    events.last().expect("an event").phase
}

#[tokio::test]
async fn copies_byte_exact_with_monotonic_progress() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::container();
    let data = content(2 * MIB + 123, 0);
    src.put(SRC, data.clone(), 7);

    let run = Run::start(&src, &dst, 0, None);
    let (registry, handle) = (run.registry.clone(), run.handle.clone());
    let events = run.finish().await;

    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(terminal(&events), TransferPhase::Done);
    let last = events.last().expect("done event");
    assert_eq!(last.transferred, data.len() as u64);
    assert_eq!(last.total, data.len() as u64);
    assert!(
        events
            .windows(2)
            .all(|w| w[0].transferred <= w[1].transferred),
        "progress never goes backwards on a clean copy"
    );
    assert_eq!(src.opens(), [Open::Read(0)]);
    assert_eq!(dst.opens(), [Open::Write(0)]);
    assert!(registry.get(ID).is_none(), "the entry is dropped when done");
    assert_eq!(handle.snapshot().state, TransferStateTag::Completed);
}

#[tokio::test]
async fn pause_then_resume_continues_from_the_verified_offset() {
    let src = MockEndpoint::container();
    let dst = MockEndpoint::server();
    let data = content(3 * MIB, 3);
    src.put(SRC, data.clone(), 9);

    let run = Run::start(&src, &dst, 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;

    let partial = dst.get(DST).expect("partial kept while paused");
    assert_eq!(partial.len(), MIB, "paused on the chunk boundary");
    assert_eq!(partial.as_slice(), &data[..MIB]);

    assert!(run.registry.resume(ID));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(src.opens(), [Open::Read(0), Open::Read(MIB as u64)]);
    assert_eq!(dst.opens(), [Open::Write(0), Open::Write(MIB as u64)]);
}

#[tokio::test]
async fn cancel_removes_the_partial_destination() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::container();
    src.put(SRC, content(3 * MIB, 1), 1);

    let run = Run::start(&src, &dst, 0, None);
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
async fn cancel_while_paused_removes_the_partial_destination() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::server();
    src.put(SRC, content(2 * MIB, 1), 1);

    let run = Run::start(&src, &dst, 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;
    assert!(run.registry.cancel(ID));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Cancelled);
    assert_eq!(dst.get(DST), None);
}

/// A dropped read mid-copy is retried after the backoff and continues from
/// the bytes that actually landed at the destination.
#[tokio::test]
async fn a_failed_attempt_retries_from_the_bytes_that_landed() {
    let src = MockEndpoint::container();
    let dst = MockEndpoint::container();
    let data = content(2 * MIB, 5);
    src.put(SRC, data.clone(), 4);
    *src.fail_read_at.lock().expect("fail") = Some(MIB as u64);

    let run = Run::start(&src, &dst, 0, None);
    let messages = {
        let events = run.events.clone();
        let events_done = run.finish().await;
        assert_eq!(terminal(&events_done), TransferPhase::Done);
        let collected: Vec<String> = events
            .lock()
            .expect("events")
            .iter()
            .filter_map(|p| p.message.clone())
            .collect();
        collected
    };

    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(src.opens(), [Open::Read(0), Open::Read(MIB as u64)]);
    assert!(
        messages
            .iter()
            .any(|m| m == "Docker error: transfer read failed: connection reset"),
        "the failure names the source end: {messages:?}"
    );
}

/// The source rewritten while the copy was paused: the resume gate restarts
/// from zero instead of splicing two versions.
#[tokio::test]
async fn a_source_changed_while_paused_restarts_from_zero() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::container();
    src.put(SRC, content(2 * MIB, 0), 1);

    let run = Run::start(&src, &dst, 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;

    // Same size, new content and mtime.
    let rewritten = content(2 * MIB, 77);
    src.put(SRC, rewritten.clone(), 2);
    assert!(run.registry.resume(ID));
    let messages_run = run.events.clone();
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(rewritten.as_slice()));
    assert_eq!(dst.opens(), [Open::Write(0), Open::Write(0)]);
    let messages: Vec<String> = messages_run
        .lock()
        .expect("events")
        .iter()
        .filter_map(|p| p.message.clone())
        .collect();
    assert!(messages
        .iter()
        .any(|m| m == "source file changed; restarting from start"));
}

/// A destination that cannot measure its partial (a container without
/// `wc`) refuses the resume; the copy restarts from zero and says why.
#[tokio::test]
async fn an_end_without_resume_support_restarts_from_zero() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::with("container", |ep| ep.resume_write = false);
    let data = content(2 * MIB, 8);
    src.put(SRC, data.clone(), 1);

    let run = Run::start(&src, &dst, 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;
    assert!(run.registry.resume(ID));
    let messages = run.messages_after_finish().await;

    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(dst.opens(), [Open::Write(0), Open::Write(0)]);
    assert!(messages
        .iter()
        .any(|m| m == "resume not supported by container; restarting from start"));
}

/// A server that refuses the offset open (the seek on the source) restarts
/// the copy from zero without consuming a retry.
#[tokio::test]
async fn a_refused_offset_open_restarts_from_zero() {
    let src = MockEndpoint::with("server", |ep| ep.reject_offset_open = true);
    let dst = MockEndpoint::container();
    let data = content(2 * MIB, 2);
    src.put(SRC, data.clone(), 1);

    let run = Run::start(&src, &dst, 0, None);
    let registry = run.registry.clone();
    dst.set_hook(once_at(MIB as u64, move || {
        registry.pause(ID);
    }));
    run.wait_for(TransferStateTag::Paused).await;
    assert!(run.registry.resume(ID));
    let messages = run.messages_after_finish().await;

    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(
        src.opens(),
        [Open::Read(0), Open::Read(MIB as u64), Open::Read(0)]
    );
    assert!(messages
        .iter()
        .any(|m| m == "resume not supported by server; restarting from start"));
}

/// A copy relaunched after a restart (#3206, #3847) keeps its checkpoint
/// while the source still has the persisted size and mtime.
#[tokio::test]
async fn a_relaunched_copy_resumes_when_size_and_mtime_match() {
    let src = MockEndpoint::container();
    let dst = MockEndpoint::server();
    let data = content(2 * MIB, 4);
    src.put(SRC, data.clone(), 42);
    dst.put(DST, data[..MIB].to_vec(), 1);

    let run = Run::start(&src, &dst, MIB as u64, Some((data.len() as u64, 42)));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(events.first().map(|p| p.transferred), Some(MIB as u64));
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(src.opens(), [Open::Read(MIB as u64)]);
    assert_eq!(dst.opens(), [Open::Write(MIB as u64)]);
}

/// Same size but a new mtime: the source was rewritten while the app was
/// closed (#3572, #3847), so the relaunch restarts from zero.
#[tokio::test]
async fn a_relaunched_copy_restarts_when_the_source_mtime_changed() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::container();
    let data = content(2 * MIB, 6);
    src.put(SRC, data.clone(), 43);
    dst.put(DST, content(MIB, 99), 1);

    let run = Run::start(&src, &dst, MIB as u64, Some((data.len() as u64, 42)));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(events.first().map(|p| p.transferred), Some(0));
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(src.opens(), [Open::Read(0)]);
}

/// A relaunched checkpoint whose source changed size restarts from zero.
#[tokio::test]
async fn a_relaunched_copy_restarts_when_the_source_size_changed() {
    let src = MockEndpoint::server();
    let dst = MockEndpoint::server();
    let data = content(2 * MIB + 10, 6);
    src.put(SRC, data.clone(), 42);
    dst.put(DST, data[..MIB].to_vec(), 1);

    let run = Run::start(&src, &dst, MIB as u64, Some((2 * MIB as u64, 42)));
    let events = run.finish().await;

    assert_eq!(terminal(&events), TransferPhase::Done);
    assert_eq!(dst.get(DST).as_deref(), Some(data.as_slice()));
    assert_eq!(dst.opens(), [Open::Write(0)]);
}

#[test]
fn resume_mode_default_is_resume() {
    assert_eq!(ResumeMode::default(), ResumeMode::Resume);
    assert_eq!(DEFAULT_RESUME_MODE, ResumeMode::Resume);
}

#[test]
fn copy_errors_name_the_end_that_failed() {
    let read = copy_error(CopyPhase::Read, io::Error::other("reset"), "SSH error", "Docker error");
    assert_eq!(read.to_string(), "SSH error: transfer read failed: reset");
    let write = copy_error(CopyPhase::Write, io::Error::other("pipe"), "SSH error", "Docker error");
    assert_eq!(write.to_string(), "Docker error: transfer write failed: pipe");
    let flush = copy_error(CopyPhase::Flush, io::Error::other("x"), "SSH error", "Docker error");
    assert_eq!(flush.to_string(), "Docker error: transfer flush failed: x");
}

impl Run {
    async fn messages_after_finish(self) -> Vec<String> {
        let events = self.events.clone();
        let done = self.finish().await;
        assert_eq!(terminal(&done), TransferPhase::Done);
        let messages = events
            .lock()
            .expect("events")
            .iter()
            .filter_map(|p| p.message.clone())
            .collect();
        messages
    }
}
