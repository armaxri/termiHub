//! A transfer is complete only when the server has closed its file (#6040): it
//! may hold data back until then, and Windows keeps the file locked.

use std::sync::Mutex;
use std::time::Duration;

use super::*;
use crate::backends::ssh::locking_sftp_test_server::{browser, Disk, SharedDisk};
use crate::files::transfer::remote_copy::{run_remote_copy, RemoteCopyEndpoint};
use crate::files::transfer::TransferStateTag;
use crate::files::FileBrowser;

const REMOTE: &str = "/srv/data.bin";
const LAG: Duration = Duration::from_millis(300);

fn disk(close_lag: Duration) -> SharedDisk {
    let mut disk = Disk::default();
    disk.close_lag = close_lag;
    Arc::new(Mutex::new(disk))
}

fn content(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// A transfer that ran to its end.
struct Ran {
    handle: Arc<TransferHandle>,
    messages: Vec<String>,
}

impl Ran {
    fn state(&self) -> TransferStateTag {
        self.handle.state().tag()
    }
}

/// A transfer on its own task.
struct Running {
    registry: TransferRegistry,
    handle: Arc<TransferHandle>,
    messages: Arc<Mutex<Vec<String>>>,
    sink: ProgressSink,
}

impl Running {
    fn new(direction: TransferDirection, total: usize) -> Self {
        let registry = TransferRegistry::new();
        let handle = registry.enqueue("t", "s", direction, "data.bin", REMOTE, total as u64);
        let messages = Arc::new(Mutex::new(Vec::new()));
        let rec = messages.clone();
        let sink: ProgressSink = Arc::new(move |p| {
            if let Some(m) = &p.message {
                rec.lock().expect("messages").push(m.clone());
            }
        });
        Self {
            registry,
            handle,
            messages,
            sink,
        }
    }

    /// Wait for `task`, failing instead of hanging when it never ends.
    async fn end(self, task: impl std::future::Future<Output = ()>) -> Ran {
        // Boxed: the futures of a transfer are large for a test thread's stack.
        tokio::time::timeout(Duration::from_secs(30), Box::pin(task))
            .await
            .expect("the transfer ends");
        let messages = self.messages.lock().expect("messages").clone();
        Ran {
            handle: self.handle,
            messages,
        }
    }
}

/// Run a transfer between `local` and the server to its end.
async fn run(
    browser: &Arc<SftpFileBrowser>,
    direction: TransferDirection,
    local: &std::path::Path,
    total: usize,
    start_offset: u64,
) -> Ran {
    let running = Running::new(direction, total);
    if let Some(fp) = local_fingerprint(&local.to_string_lossy()).await {
        running.handle.set_source_mtime(fp.mtime);
    }
    let task = Box::pin(run_sftp_transfer(
        browser.clone(),
        direction,
        REMOTE.to_string(),
        local.to_string_lossy().into_owned(),
        running.handle.clone(),
        running.registry.clone(),
        running.sink.clone(),
        DEFAULT_RESUME_MODE,
        start_offset,
    ));
    running.end(task).await
}

#[tokio::test]
async fn a_completed_upload_has_closed_its_file() {
    let data = content(600_000);
    for start in [0, 200_000] {
        let disk = disk(LAG);
        disk.lock()
            .expect("disk")
            .files
            .insert(REMOTE.to_string(), data[..start].to_vec());
        let dir = tempfile::tempdir().expect("tempdir");
        let local = dir.path().join("data.bin");
        std::fs::write(&local, &data).expect("write");
        let browser = browser(&disk).await;

        let ran = run(
            &browser,
            TransferDirection::Upload,
            &local,
            data.len(),
            start as u64,
        )
        .await;

        assert_eq!(
            ran.state(),
            TransferStateTag::Completed,
            "{:?}",
            ran.messages
        );
        assert_eq!(
            disk.lock().expect("disk").open(REMOTE),
            (0, 0),
            "from {start}"
        );
        let landed = browser.read_file(REMOTE).await.expect("read it at once");
        assert!(landed == data, "from {start}");
        assert!(ran.messages.is_empty(), "{:?}", ran.messages);
    }
}

#[tokio::test]
async fn an_upload_whose_file_the_server_cannot_close_is_not_complete() {
    let disk = disk(Duration::ZERO);
    disk.lock().expect("disk").failing_closes = usize::MAX;
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");
    std::fs::write(&local, content(1000)).expect("write");

    let ran = run(
        &browser(&disk).await,
        TransferDirection::Upload,
        &local,
        1000,
        0,
    )
    .await;

    assert_eq!(ran.state(), TransferStateTag::Failed, "{:?}", ran.messages);
    let last = ran.messages.last().expect("a reason");
    assert!(last.contains("close"), "{last}");
}

#[tokio::test]
async fn an_upload_whose_close_fails_once_is_tried_again() {
    let data = content(1000);
    let disk = disk(Duration::ZERO);
    disk.lock().expect("disk").failing_closes = 1;
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");
    std::fs::write(&local, &data).expect("write");

    let ran = run(
        &browser(&disk).await,
        TransferDirection::Upload,
        &local,
        1000,
        0,
    )
    .await;

    assert_eq!(
        ran.state(),
        TransferStateTag::Completed,
        "{:?}",
        ran.messages
    );
    assert_eq!(ran.messages.len(), 1, "{:?}", ran.messages);
    assert!(disk.lock().expect("disk").files[REMOTE] == data);
}

/// The file an attempt leaves behind is closed before the next one opens it.
#[tokio::test]
async fn a_failed_attempt_does_not_lock_out_the_next_one() {
    let data = content(600_000);
    let disk = disk(Duration::from_millis(2500));
    disk.lock().expect("disk").failing_writes = 1;
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");
    std::fs::write(&local, &data).expect("write");

    let ran = run(
        &browser(&disk).await,
        TransferDirection::Upload,
        &local,
        data.len(),
        0,
    )
    .await;

    assert_eq!(
        ran.state(),
        TransferStateTag::Completed,
        "{:?}",
        ran.messages
    );
    let open_failures: Vec<_> = ran.messages.iter().filter(|m| m.contains("open")).collect();
    assert!(open_failures.is_empty(), "{:?}", ran.messages);
    assert!(disk.lock().expect("disk").files[REMOTE] == data);
}

#[tokio::test]
async fn a_completed_download_has_closed_its_source() {
    let data = content(600_000);
    let disk = disk(LAG);
    disk.lock()
        .expect("disk")
        .files
        .insert(REMOTE.to_string(), data.clone());
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");

    let ran = run(
        &browser(&disk).await,
        TransferDirection::Download,
        &local,
        data.len(),
        0,
    )
    .await;

    assert_eq!(
        ran.state(),
        TransferStateTag::Completed,
        "{:?}",
        ran.messages
    );
    assert_eq!(disk.lock().expect("disk").open(REMOTE), (0, 0));
    assert!(std::fs::read(&local).expect("read") == data);
}

/// Run a copy from one server to another to its end.
async fn copy_across(src: &SharedDisk, dst: &SharedDisk, total: usize) -> Ran {
    let running = Running::new(TransferDirection::Upload, total);
    let task = Box::pin(run_remote_copy(
        RemoteCopyEndpoint::Sftp(browser(src).await),
        RemoteCopyEndpoint::Sftp(browser(dst).await),
        REMOTE.to_string(),
        REMOTE.to_string(),
        running.handle.clone(),
        running.registry.clone(),
        running.sink.clone(),
        DEFAULT_RESUME_MODE,
        0,
    ));
    running.end(task).await
}

#[tokio::test]
async fn a_completed_copy_between_servers_has_closed_both_files() {
    let data = content(600_000);
    let (src, dst) = (disk(LAG), disk(LAG));
    src.lock()
        .expect("disk")
        .files
        .insert(REMOTE.to_string(), data.clone());

    let ran = copy_across(&src, &dst, data.len()).await;

    assert_eq!(
        ran.state(),
        TransferStateTag::Completed,
        "{:?}",
        ran.messages
    );
    assert_eq!(
        dst.lock().expect("disk").open(REMOTE),
        (0, 0),
        "destination"
    );
    assert_eq!(src.lock().expect("disk").open(REMOTE), (0, 0), "source");
    assert!(dst.lock().expect("disk").files[REMOTE] == data);
}

#[tokio::test]
async fn a_copy_whose_destination_cannot_be_closed_is_not_complete() {
    let (src, dst) = (disk(Duration::ZERO), disk(Duration::ZERO));
    src.lock()
        .expect("disk")
        .files
        .insert(REMOTE.to_string(), content(1000));
    dst.lock().expect("disk").failing_closes = usize::MAX;

    let ran = copy_across(&src, &dst, 1000).await;

    assert_eq!(ran.state(), TransferStateTag::Failed, "{:?}", ran.messages);
}

/// A cancel drops a write that hangs; the server closes the file later, and the
/// partial is removed then.
#[tokio::test]
async fn a_cancelled_upload_removes_a_partial_that_is_still_open() {
    let disk = disk(Duration::from_millis(100));
    disk.lock().expect("disk").hold_writes = true;
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");
    std::fs::write(&local, content(8_000_000)).expect("write");
    let running = Running::new(TransferDirection::Upload, 8_000_000);
    let registry = running.registry.clone();
    let handle = running.handle.clone();
    let task = tokio::spawn(run_sftp_transfer(
        browser(&disk).await,
        TransferDirection::Upload,
        REMOTE.to_string(),
        local.to_string_lossy().into_owned(),
        running.handle.clone(),
        registry.clone(),
        running.sink.clone(),
        DEFAULT_RESUME_MODE,
        0,
    ));
    for _ in 0..1000 {
        if disk.lock().expect("disk").writes > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(registry.cancel("t"));
    let released = disk.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        released.lock().expect("disk").hold_writes = false;
    });
    running.end(async { task.await.expect("task") }).await;

    assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
    assert!(!disk.lock().expect("disk").files.contains_key(REMOTE));
}

/// A copy inside one server.
#[tokio::test]
async fn a_server_side_copy_reports_a_destination_that_cannot_be_closed() {
    for (failing, ok) in [(0, true), (1, false)] {
        let disk = disk(Duration::ZERO);
        disk.lock()
            .expect("disk")
            .files
            .insert("/srv/a".to_string(), content(1000));
        disk.lock().expect("disk").failing_closes = failing;
        let copied = browser(&disk).await.copy("/srv/a", "/srv/b").await;
        assert_eq!(copied.is_ok(), ok, "{copied:?}");
    }
}

/// The bare `Failure` of a file that another handle still has open says so.
#[tokio::test]
async fn a_file_that_is_still_open_elsewhere_is_named_as_the_likely_reason() {
    let disk = disk(Duration::ZERO);
    disk.lock()
        .expect("disk")
        .files
        .insert(REMOTE.to_string(), content(10));
    let (other, browser) = (browser(&disk).await, browser(&disk).await);
    let channel = other.open_dedicated_channel().await.expect("channel");
    let held = channel.open_write_at(REMOTE, 10).await.expect("open");

    let mine = browser.open_dedicated_channel().await.expect("channel");
    let errors = [
        browser.read_file(REMOTE).await.expect_err("read"),
        browser.write_file(REMOTE, b"x").await.expect_err("write"),
        mine.create_write(REMOTE).await.err().expect("create"),
        mine.open_write_at(REMOTE, 10).await.err().expect("append"),
        mine.open_read(REMOTE).await.err().expect("open"),
    ];
    for e in errors {
        assert!(e.to_string().contains("may still be open"), "{e}");
    }
    // A file that is not there is not in use.
    let e = browser.read_file("/srv/none").await.expect_err("missing");
    assert!(!e.to_string().contains("still be open"), "{e}");
    drop(held);
}
