//! File browsing for a daemon-hosted session, end to end (#3242).
//!
//! Drives the real `daemon_loop` over a real endpoint with real `DaemonClient`
//! connects: the daemon advertises the file capability of its session's
//! `ConnectionType`, serves every file operation through that backend's own
//! browser — large reads and writes in chunks that interleave with terminal
//! output — and answers only the worker that holds the session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine;

use crate::daemon::client::DaemonClient;
use crate::daemon::files_rpc::CHUNK_SIZE;
use crate::daemon::protocol::{self, MSG_ATTACH_INTENT, MSG_READY};
use crate::daemon::transport::{self, DaemonListener};
use crate::io::transport::NotificationSender;
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::{FileError, SessionError};
use termihub_core::files::{FileBrowser, FileEntry, RangedFileAccess};

/// An in-memory file tree standing in for the session backend's browser (an
/// SFTP channel, a `docker exec`, an FTP control connection).
#[derive(Default)]
struct FakeFiles {
    files: StdMutex<HashMap<String, Vec<u8>>>,
    dirs: StdMutex<Vec<String>>,
    /// Whether the backend offers ranged access (#3587).
    ranges: bool,
}

#[async_trait::async_trait]
impl RangedFileAccess for FakeFiles {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        let files = self.files.lock().unwrap();
        let data = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        let start = (offset as usize).min(data.len());
        let end = (start + len as usize).min(data.len());
        Ok(data[start..end].to_vec())
    }
    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        let mut files = self.files.lock().unwrap();
        let file = files.entry(path.into()).or_default();
        if offset == 0 {
            file.clear();
        } else if file.len() as u64 != offset {
            return Err(termihub_core::files::ranged::offset_mismatch(
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
impl FileBrowser for FakeFiles {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        if path == "/forbidden" {
            return Err(FileError::PermissionDenied("forbidden".into()));
        }
        let mut entries: Vec<FileEntry> = self
            .files
            .lock()
            .unwrap()
            .iter()
            .map(|(p, d)| FileEntry {
                name: p.rsplit('/').next().unwrap_or(p).into(),
                path: p.clone(),
                size: d.len() as u64,
                ..FileEntry::default()
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| FileError::NotFound(path.into()))
    }
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), data.to_vec());
        Ok(())
    }
    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.files
            .lock()
            .unwrap()
            .remove(path)
            .map(|_| ())
            .ok_or_else(|| FileError::NotFound(path.into()))
    }
    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        let mut files = self.files.lock().unwrap();
        let data = files
            .remove(from)
            .ok_or_else(|| FileError::NotFound(from.into()))?;
        files.insert(to.into(), data);
        Ok(())
    }
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let size = self
            .files
            .lock()
            .unwrap()
            .get(path)
            .map(|d| d.len() as u64)
            .ok_or_else(|| FileError::NotFound(path.into()))?;
        Ok(FileEntry {
            name: path.rsplit('/').next().unwrap_or(path).into(),
            path: path.into(),
            size,
            ..FileEntry::default()
        })
    }
    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.dirs.lock().unwrap().push(path.into());
        Ok(())
    }
    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn set_owner(
        &self,
        _path: &str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn create_symlink(&self, _target: &str, _link_path: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn copy(&self, _src: &str, _dest: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    fn ranged(&self) -> Option<&dyn RangedFileAccess> {
        self.ranges.then_some(self as &dyn RangedFileAccess)
    }
}

/// A persistent session backend (standing in for SSH / Docker) that
/// optionally has a file browser.
struct FakeConnection {
    files: Option<Arc<FakeFiles>>,
}

#[async_trait::async_trait]
impl ConnectionType for FakeConnection {
    fn type_id(&self) -> &str {
        "fake"
    }
    fn display_name(&self) -> &str {
        "Fake"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: self.files.is_some(),
            graphical: false,
            resize: true,
            persistent: true,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        self.files.as_deref().map(|f| f as &dyn FileBrowser)
    }
    fn file_browser_handle(&self) -> Option<Arc<dyn FileBrowser + Send + Sync>> {
        self.files
            .as_ref()
            .map(|f| f.clone() as Arc<dyn FileBrowser + Send + Sync>)
    }
}

fn notification_tx() -> NotificationSender {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    tx
}

fn unique_endpoint(tag: &str) -> String {
    let id = format!(
        "itest-3242-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

/// Run a real `daemon_loop` for a session whose backend has `files`. Returns
/// the sender of the session's terminal output.
async fn spawn_daemon(
    endpoint: &str,
    files: Option<Arc<FakeFiles>>,
) -> tokio::sync::mpsc::Sender<Vec<u8>> {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let conn: Box<dyn ConnectionType> = Box::new(FakeConnection { files });
        let _ = super::super::daemon_loop(
            "files-session",
            conn,
            out_rx,
            &mut listener,
            1024 * 1024,
            None,
        )
        .await;
        listener.cleanup();
    });
    out_tx
}

async fn eventually(mut pred: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// Deterministic, non-repeating-per-chunk test contents.
fn contents(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daemon_session_browses_through_its_own_backend() {
    let endpoint = unique_endpoint("browse");
    let files = Arc::new(FakeFiles::default());
    let _out = spawn_daemon(&endpoint, Some(files.clone())).await;

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let browser = client
        .file_browser()
        .expect("the daemon advertises the file capability");

    browser.write_file("/srv/a.txt", b"hello").await.unwrap();
    browser.mkdir("/srv/new").await.unwrap();
    assert_eq!(*files.dirs.lock().unwrap(), vec!["/srv/new".to_string()]);
    assert_eq!(browser.stat("/srv/a.txt").await.unwrap().size, 5);
    assert_eq!(browser.read_file("/srv/a.txt").await.unwrap(), b"hello");
    browser.rename("/srv/a.txt", "/srv/b.txt").await.unwrap();
    let listed = browser.list_dir("/srv").await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, "/srv/b.txt");
    browser.delete("/srv/b.txt").await.unwrap();
    assert!(files.files.lock().unwrap().is_empty());

    // An empty file round-trips too.
    browser.write_file("/srv/empty", b"").await.unwrap();
    assert!(browser.read_file("/srv/empty").await.unwrap().is_empty());

    // Typed backend failures come back typed, not as opaque strings.
    assert!(matches!(
        browser.read_file("/missing").await,
        Err(FileError::NotFound(p)) if p == "/missing"
    ));
    assert!(matches!(
        browser.list_dir("/forbidden").await,
        Err(FileError::PermissionDenied(_))
    ));
    assert!(matches!(
        browser.set_permissions("/x", 0o644).await,
        Err(FileError::NotSupported)
    ));
}

/// Files many chunks long cross the daemon link intact in both directions.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_files_cross_the_link_in_chunks() {
    let endpoint = unique_endpoint("large");
    let files = Arc::new(FakeFiles::default());
    let _out = spawn_daemon(&endpoint, Some(files.clone())).await;
    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let browser = client.file_browser().expect("file capability");

    let upload = contents(CHUNK_SIZE * 7 + 123);
    browser.write_file("/big.bin", &upload).await.unwrap();
    assert_eq!(files.files.lock().unwrap()["/big.bin"], upload);

    let download = contents(CHUNK_SIZE * 9 + 1);
    files
        .files
        .lock()
        .unwrap()
        .insert("/down.bin".into(), download.clone());
    assert_eq!(browser.read_file("/down.bin").await.unwrap(), download);
}

/// A large read does not hold the daemon link: terminal output produced while
/// the read streams still reaches the worker, and neither is corrupted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_output_keeps_flowing_during_a_large_read() {
    let endpoint = unique_endpoint("interleave");
    let files = Arc::new(FakeFiles::default());
    let big = contents(CHUNK_SIZE * 64);
    files
        .files
        .lock()
        .unwrap()
        .insert("/huge.bin".into(), big.clone());
    let out_tx = spawn_daemon(&endpoint, Some(files)).await;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s".into(), endpoint, tx)
        .await
        .expect("worker attaches");
    let browser = client.file_browser().expect("file capability");

    let read = tokio::spawn(async move { browser.read_file("/huge.bin").await });
    for i in 0..50u32 {
        out_tx
            .send(format!("line {i}\n").into_bytes())
            .await
            .expect("daemon alive");
    }
    let got = read.await.unwrap().expect("read succeeds");
    assert_eq!(got.len(), big.len());
    assert!(got == big, "read contents intact");

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut output = Vec::new();
    let expected: Vec<u8> = (0..50u32)
        .flat_map(|i| format!("line {i}\n").into_bytes())
        .collect();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while output.len() < expected.len() && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(n)) if n.method == "connection.output" => {
                output.extend(b64.decode(n.params["data"].as_str().unwrap()).unwrap());
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    assert_eq!(output, expected, "every output byte arrives, in order");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_without_files_is_not_advertised() {
    let endpoint = unique_endpoint("no-files");
    let _out = spawn_daemon(&endpoint, None).await;

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    assert!(client.file_browser().is_none());
}

/// A daemon started by an older agent sends no capability frame: the current
/// worker must treat its session as unsupported rather than send it requests
/// it would silently drop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_daemon_without_the_capability_frame_is_unsupported() {
    let endpoint = unique_endpoint("old-daemon");
    let mut listener = DaemonListener::bind(&endpoint).await.expect("bind");
    tokio::spawn(async move {
        let (mut reader, mut writer) = listener.accept().await.expect("accept");
        let intent = protocol::read_frame_async(&mut reader).await;
        assert!(matches!(intent, Ok(Some(f)) if f.msg_type == MSG_ATTACH_INTENT));
        protocol::write_frame_async(&mut writer, MSG_READY, &[])
            .await
            .unwrap();
        // Hold the connection open like a live pre-#3242 daemon.
        while let Ok(Some(_)) = protocol::read_frame_async(&mut reader).await {}
        listener.cleanup();
    });

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    assert!(client.file_browser().is_none());
}

/// Single-attach ownership: once another worker takes the session over, the
/// evicted worker can no longer browse it, and a browser it handed out earlier
/// fails instead of reaching the session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_evicted_worker_loses_file_access() {
    let endpoint = unique_endpoint("evicted");
    let files = Arc::new(FakeFiles::default());
    files
        .files
        .lock()
        .unwrap()
        .insert("/secret".into(), b"s3cret".to_vec());
    let _out = spawn_daemon(&endpoint, Some(files.clone())).await;

    let client_a = DaemonClient::connect("s".into(), endpoint.clone(), notification_tx())
        .await
        .expect("worker A attaches");
    let stale = client_a.file_browser().expect("A holds the session");

    let client_b = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker B takes over");
    assert!(eventually(|| client_a.is_evicted()).await, "A is evicted");
    assert!(
        client_a.file_browser().is_none(),
        "the evicted worker has no file access"
    );
    assert!(stale.read_file("/secret").await.is_err());
    assert!(stale.write_file("/secret", b"overwrite").await.is_err());
    assert_eq!(files.files.lock().unwrap()["/secret"], b"s3cret");

    let browser = client_b.file_browser().expect("the new holder does");
    assert_eq!(browser.read_file("/secret").await.unwrap(), b"s3cret");
}

/// Ranged slices (#3587) cross the daemon link in both directions — a slice
/// larger than one data frame too — and a misplaced write comes back typed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ranged_backend_serves_slices_through_the_daemon() {
    let endpoint = unique_endpoint("ranges");
    let files = Arc::new(FakeFiles {
        ranges: true,
        ..FakeFiles::default()
    });
    let _out = spawn_daemon(&endpoint, Some(files.clone())).await;
    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let browser = client.file_browser().expect("file capability");
    let ranged = browser
        .ranged()
        .expect("the daemon advertises ranged access");

    let first = contents(CHUNK_SIZE * 2 + 7);
    ranged.write_range("/up.bin", 0, &first).await.unwrap();
    ranged
        .write_range("/up.bin", first.len() as u64, b"tail")
        .await
        .unwrap();
    let mut expected = first.clone();
    expected.extend_from_slice(b"tail");
    assert_eq!(files.files.lock().unwrap()["/up.bin"], expected);

    assert!(matches!(
        ranged.write_range("/up.bin", 3, b"X").await,
        Err(FileError::OperationFailed(m)) if m.contains("expected 3")
    ));

    let slice = ranged
        .read_range("/up.bin", 5, (CHUNK_SIZE * 2) as u32)
        .await
        .unwrap();
    assert_eq!(slice, expected[5..5 + CHUNK_SIZE * 2]);
    let tail = ranged
        .read_range("/up.bin", expected.len() as u64 - 2, 64)
        .await
        .unwrap();
    assert_eq!(tail, b"il");
    assert!(matches!(
        ranged.read_range("/missing", 0, 4).await,
        Err(FileError::NotFound(_))
    ));
}

/// A backend whose browser has no ranged access is not advertised as having
/// it, so the worker never asks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_without_ranges_is_not_advertised() {
    let endpoint = unique_endpoint("no-ranges");
    let _out = spawn_daemon(&endpoint, Some(Arc::new(FakeFiles::default()))).await;
    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let browser = client.file_browser().expect("file capability");
    assert!(browser.ranged().is_none());
}

/// A daemon from before #3587 advertises files but not ranges: its browser
/// offers no ranged access, so no request it would drop is ever sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pre_ranges_daemon_offers_files_without_ranges() {
    let endpoint = unique_endpoint("pre-ranges");
    let mut listener = DaemonListener::bind(&endpoint).await.expect("bind");
    tokio::spawn(async move {
        let (mut reader, mut writer) = listener.accept().await.expect("accept");
        let intent = protocol::read_frame_async(&mut reader).await;
        assert!(matches!(intent, Ok(Some(f)) if f.msg_type == MSG_ATTACH_INTENT));
        protocol::write_frame_async(
            &mut writer,
            protocol::MSG_CAPABILITIES,
            &[protocol::CAP_FILES],
        )
        .await
        .unwrap();
        protocol::write_frame_async(&mut writer, MSG_READY, &[])
            .await
            .unwrap();
        while let Ok(Some(_)) = protocol::read_frame_async(&mut reader).await {}
        listener.cleanup();
    });

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let browser = client.file_browser().expect("files advertised");
    assert!(browser.ranged().is_none());
}
