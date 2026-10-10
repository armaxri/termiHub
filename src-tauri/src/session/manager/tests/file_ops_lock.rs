//! A slow file operation must not freeze the other sessions (#4393): a
//! file-browser call that hangs (an SFTP server that stopped answering, an
//! agent request waiting out its timeout) must not hold the app-wide
//! session-map lock, so input, list and close on every other session still
//! complete — and closing the browsing session itself neither waits for the
//! call nor tears its connection down underneath it.

use super::*;

use std::sync::Mutex as StdMutex;
use std::time::Duration;

use termihub_core::errors::FileError;
use tokio::sync::{watch, Notify};

/// How long an operation that must not be blocked may take.
const BOUND: Duration = Duration::from_secs(3);

/// The one path whose listing parks until the test releases it.
const PARK_PATH: &str = "/park";

/// A file browser whose `list_dir` of [`PARK_PATH`] parks until `release` is
/// set; `entered` is notified once it has parked.
struct ParkingBrowser {
    release: watch::Receiver<bool>,
    entered: Arc<Notify>,
}

fn entry(path: &str) -> FileEntry {
    FileEntry {
        name: path.to_string(),
        path: path.to_string(),
        is_directory: false,
        size: 0,
        modified: String::new(),
        permissions: None,
        writable: None,
        is_symlink: false,
        symlink_target: None,
    }
}

#[async_trait::async_trait]
impl FileBrowser for ParkingBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        if path == PARK_PATH {
            let mut release = self.release.clone();
            self.entered.notify_one();
            // The test owns the sender, so the wait cannot observe it closing.
            let _ = release.wait_for(|open| *open).await;
        }
        Ok(vec![entry(&format!("{path}/file"))])
    }
    async fn read_file(&self, _path: &str) -> Result<Vec<u8>, FileError> {
        Ok(Vec::new())
    }
    async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), FileError> {
        Ok(())
    }
    async fn delete(&self, _path: &str) -> Result<(), FileError> {
        Ok(())
    }
    async fn rename(&self, _from: &str, _to: &str) -> Result<(), FileError> {
        Ok(())
    }
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        Ok(entry(path))
    }
    async fn mkdir(&self, _path: &str) -> Result<(), FileError> {
        Ok(())
    }
    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
        Ok(())
    }
    async fn set_owner(
        &self,
        _path: &str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> Result<(), FileError> {
        Ok(())
    }
    async fn create_symlink(&self, _target: &str, _link_path: &str) -> Result<(), FileError> {
        Ok(())
    }
    async fn copy(&self, _src: &str, _dest: &str) -> Result<(), FileError> {
        Ok(())
    }
}

/// A terminal + file-browser connection recording its writes, close-time
/// interrupt and teardown.
struct BrowsingConnection {
    browser: ParkingBrowser,
    writes: Arc<StdMutex<Vec<u8>>>,
    interrupted: Arc<AtomicBool>,
    disconnected: Arc<AtomicBool>,
}

/// The test's view of a [`BrowsingConnection`].
struct Probe {
    release: watch::Sender<bool>,
    entered: Arc<Notify>,
    writes: Arc<StdMutex<Vec<u8>>>,
    interrupted: Arc<AtomicBool>,
    disconnected: Arc<AtomicBool>,
}

impl Probe {
    fn release(&self) {
        self.release.send_replace(true);
    }

    async fn wait_disconnected(&self) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(BOUND, async {
            while !self.disconnected.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
    }
}

fn browsing() -> (Box<dyn ConnectionType>, Probe) {
    let (release, release_rx) = watch::channel(false);
    let probe = Probe {
        release,
        entered: Arc::new(Notify::new()),
        writes: Arc::default(),
        interrupted: Arc::new(AtomicBool::new(false)),
        disconnected: Arc::new(AtomicBool::new(false)),
    };
    let conn = BrowsingConnection {
        browser: ParkingBrowser {
            release: release_rx,
            entered: probe.entered.clone(),
        },
        writes: probe.writes.clone(),
        interrupted: probe.interrupted.clone(),
        disconnected: probe.disconnected.clone(),
    };
    (Box::new(conn), probe)
}

#[async_trait::async_trait]
impl ConnectionType for BrowsingConnection {
    fn type_id(&self) -> &str {
        "browsing"
    }
    fn display_name(&self) -> &str {
        "Browsing"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.disconnected.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn interrupt_io(&self) {
        self.interrupted.store(true, Ordering::SeqCst);
    }
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        self.writes.lock().unwrap().extend_from_slice(data);
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        Some(&self.browser)
    }
}

/// A manager holding a session `browse` whose listing of [`PARK_PATH`] is
/// parked, and a healthy session `other`; returns once the listing has parked.
async fn manager_with_parked_listing() -> (
    Arc<SessionManager>,
    Probe,
    Probe,
    tokio::task::JoinHandle<Result<Vec<FileEntry>, TerminalError>>,
) {
    let manager = Arc::new(SessionManager::new(
        ConnectionTypeRegistry::new(),
        Arc::new(NullAgent),
    ));
    let (browse_conn, browse) = browsing();
    let (other_conn, other) = browsing();
    manager.insert_test_session("browse", browse_conn).await;
    manager.insert_test_session("other", other_conn).await;

    let parked = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.list_files("browse", PARK_PATH).await })
    };
    tokio::time::timeout(BOUND, browse.entered.notified())
        .await
        .expect("the parked listing must start");
    (manager, browse, other, parked)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parked_file_op_does_not_block_other_sessions() {
    let (manager, browse, other, parked) = manager_with_parked_listing().await;

    let input = tokio::time::timeout(BOUND, manager.send_input_raw("other", b"hi")).await;
    let listed = tokio::time::timeout(BOUND, manager.list_sessions()).await;
    let other_files = tokio::time::timeout(BOUND, manager.list_files("other", "/home")).await;
    let same_files = tokio::time::timeout(BOUND, manager.list_files("browse", "/home")).await;
    let close_other = tokio::time::timeout(BOUND, manager.close_session("other")).await;
    // Unpark before asserting, so a regression fails instead of hanging.
    browse.release();

    input
        .expect("input to another session must not wait behind a parked file op")
        .unwrap();
    assert_eq!(other.writes.lock().unwrap().as_slice(), b"hi");
    assert_eq!(
        listed
            .expect("list_sessions must not wait behind a parked file op")
            .len(),
        2
    );
    assert_eq!(
        other_files
            .expect("another session's file op must not wait behind a parked one")
            .unwrap()[0]
            .path,
        "/home/file"
    );
    same_files
        .expect("a second file op on the same session must not wait behind the parked one")
        .unwrap();
    close_other
        .expect("closing another session must not wait behind a parked file op")
        .unwrap();
    assert!(other.disconnected.load(Ordering::SeqCst));
    assert!(
        !other.interrupted.load(Ordering::SeqCst),
        "a session with no file op in flight is disconnected directly"
    );
    let entries = tokio::time::timeout(BOUND, parked)
        .await
        .expect("the parked listing completes once released")
        .unwrap()
        .unwrap();
    assert_eq!(entries[0].path, format!("{PARK_PATH}/file"));
}

/// Closing the session whose file op is parked returns at once; the connection
/// stays alive under the in-flight call (no use-after-free), the call finishes,
/// and only then does the deferred disconnect run.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_a_session_with_a_parked_file_op_defers_its_disconnect() {
    let (manager, browse, _other, parked) = manager_with_parked_listing().await;

    let closed = tokio::time::timeout(BOUND, manager.close_session("browse")).await;
    let disconnected_while_parked = browse.disconnected.load(Ordering::SeqCst);
    let after_close = tokio::time::timeout(BOUND, manager.list_files("browse", "/home")).await;
    let remaining = tokio::time::timeout(BOUND, manager.list_sessions()).await;
    // Unpark before asserting, so a regression fails instead of hanging.
    browse.release();

    closed
        .expect("closing a session must not wait behind its parked file op")
        .unwrap();
    assert!(
        !disconnected_while_parked,
        "the connection must not be torn down under an in-flight file op"
    );
    assert!(
        browse.interrupted.load(Ordering::SeqCst),
        "close asks the backend to interrupt the in-flight I/O"
    );
    let after_close =
        after_close.expect("a file op after close must not wait behind the parked one");
    assert!(
        matches!(after_close, Err(TerminalError::SessionNotFound(_))),
        "a file op after close reports the session gone, got {after_close:?}"
    );
    assert_eq!(
        remaining
            .expect("list_sessions must not wait behind a parked file op")
            .len(),
        1,
        "the closed session is removed at once"
    );

    tokio::time::timeout(BOUND, parked)
        .await
        .expect("the parked listing completes once released")
        .unwrap()
        .expect("the in-flight file op finishes on the still-live connection");
    browse
        .wait_disconnected()
        .await
        .expect("the deferred disconnect must run once the file op returns");
}
