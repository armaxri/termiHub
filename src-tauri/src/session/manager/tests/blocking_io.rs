//! One stalled session must not freeze the others (#4300, TAURI2-001 /
//! CONC2-002): a backend write that blocks (a PTY whose child stopped reading
//! stdin, a half-open telnet socket, an agent waiting for queue credit) must not
//! hold the app-wide session-map lock, so input, resize, list and close on every
//! other session — and resize / close of the stalled one — still complete.

use super::*;

use std::sync::{Condvar, Mutex as StdMutex};
use std::time::Duration;

/// How long an operation that must not be blocked may take.
const BOUND: Duration = Duration::from_secs(3);

/// A gate a blocked `write` parks on until the test opens it.
#[derive(Default)]
struct Gate {
    open: StdMutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn wait(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.cv.wait(open).unwrap();
        }
    }

    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.cv.notify_all();
    }
}

/// A connection whose writes park on `gate` while the written bytes start with
/// `block_prefix`. Every write is recorded (in completion order); `entered` is
/// notified when a write starts parking; `disconnected` records teardown.
struct StallingConnection {
    gate: Arc<Gate>,
    block_prefix: Option<Vec<u8>>,
    entered: Arc<tokio::sync::Notify>,
    writes: Arc<StdMutex<Vec<u8>>>,
    resizes: Arc<StdMutex<Vec<(u16, u16)>>>,
    disconnected: Arc<AtomicBool>,
}

struct Probe {
    gate: Arc<Gate>,
    entered: Arc<tokio::sync::Notify>,
    writes: Arc<StdMutex<Vec<u8>>>,
    resizes: Arc<StdMutex<Vec<(u16, u16)>>>,
    disconnected: Arc<AtomicBool>,
}

fn stalling(block_prefix: Option<&[u8]>) -> (Box<dyn ConnectionType>, Probe) {
    let probe = Probe {
        gate: Arc::new(Gate::default()),
        entered: Arc::new(tokio::sync::Notify::new()),
        writes: Arc::default(),
        resizes: Arc::default(),
        disconnected: Arc::new(AtomicBool::new(false)),
    };
    let conn = StallingConnection {
        gate: probe.gate.clone(),
        block_prefix: block_prefix.map(<[u8]>::to_vec),
        entered: probe.entered.clone(),
        writes: probe.writes.clone(),
        resizes: probe.resizes.clone(),
        disconnected: probe.disconnected.clone(),
    };
    (Box::new(conn), probe)
}

#[async_trait::async_trait]
impl ConnectionType for StallingConnection {
    fn type_id(&self) -> &str {
        "stalling"
    }
    fn display_name(&self) -> &str {
        "Stalling"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
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
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        if self
            .block_prefix
            .as_deref()
            .is_some_and(|prefix| data.starts_with(prefix))
        {
            self.entered.notify_one();
            self.gate.wait();
        }
        self.writes.lock().unwrap().extend_from_slice(data);
        Ok(())
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.resizes.lock().unwrap().push((cols, rows));
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
        None
    }
}

/// A manager holding a stalled session `stuck` (its write of `STALL` parks) and
/// a healthy session `other`; returns once `stuck`'s write is parked.
async fn manager_with_parked_write() -> (
    Arc<SessionManager>,
    Probe,
    Probe,
    tokio::task::JoinHandle<Result<(), TerminalError>>,
) {
    let manager = Arc::new(SessionManager::new(
        ConnectionTypeRegistry::new(),
        Arc::new(NullAgent),
    ));
    let (stuck_conn, stuck) = stalling(Some(b"STALL"));
    let (other_conn, other) = stalling(None);
    manager.insert_test_session("stuck", stuck_conn).await;
    manager.insert_test_session("other", other_conn).await;

    let parked = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.send_input_raw("stuck", b"STALL").await })
    };
    tokio::time::timeout(BOUND, stuck.entered.notified())
        .await
        .expect("the stalled write must start");
    (manager, stuck, other, parked)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_write_does_not_block_input_to_another_session() {
    let (manager, stuck, other, parked) = manager_with_parked_write().await;

    let result = tokio::time::timeout(BOUND, manager.send_input_raw("other", b"hi")).await;
    stuck.gate.release();
    result
        .expect("input to another session must not wait behind a stalled write")
        .unwrap();
    assert_eq!(other.writes.lock().unwrap().as_slice(), b"hi");
    parked.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_write_does_not_block_resize_of_any_session() {
    let (manager, stuck, other, parked) = manager_with_parked_write().await;

    let other_resize = tokio::time::timeout(BOUND, manager.resize("other", 100, 40)).await;
    let stuck_resize = tokio::time::timeout(BOUND, manager.resize("stuck", 120, 50)).await;
    stuck.gate.release();
    other_resize
        .expect("resizing another session must not wait behind a stalled write")
        .unwrap();
    stuck_resize
        .expect("resizing the stalled session itself must not wait behind its write")
        .unwrap();
    assert_eq!(other.resizes.lock().unwrap().as_slice(), &[(100, 40)]);
    assert_eq!(stuck.resizes.lock().unwrap().as_slice(), &[(120, 50)]);
    parked.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_write_does_not_block_list_or_close() {
    let (manager, stuck, other, parked) = manager_with_parked_write().await;

    let listed = tokio::time::timeout(BOUND, manager.list_sessions()).await;
    let close_other = tokio::time::timeout(BOUND, manager.close_session("other")).await;
    let close_stuck = tokio::time::timeout(BOUND, manager.close_session("stuck")).await;
    let remaining = tokio::time::timeout(BOUND, manager.list_sessions()).await;
    let stuck_disconnected_while_parked = stuck.disconnected.load(Ordering::SeqCst);
    stuck.gate.release();

    assert_eq!(
        listed
            .expect("list_sessions must not wait behind a stalled write")
            .len(),
        2
    );
    close_other
        .expect("closing another session must not wait behind a stalled write")
        .unwrap();
    assert!(other.disconnected.load(Ordering::SeqCst));
    close_stuck
        .expect("closing the stalled session must not wait behind its write")
        .unwrap();
    assert!(
        remaining.expect("list after close").is_empty(),
        "both sessions are removed at close"
    );
    // The stalled backend cannot be disconnected while its write is still in
    // flight (`disconnect` needs exclusive access); teardown is deferred until
    // the write returns, then still runs.
    assert!(!stuck_disconnected_while_parked);
    parked.await.unwrap().unwrap();
    tokio::time::timeout(BOUND, async {
        while !stuck.disconnected.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the deferred disconnect must run once the write returns");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn writes_to_one_session_keep_their_order_behind_a_stall() {
    let (manager, stuck, _other, parked) = manager_with_parked_write().await;

    // Queue more input behind the parked write, one after another.
    let mut queued = Vec::new();
    for chunk in [&b"-a"[..], b"-b", b"-c"] {
        let manager = manager.clone();
        let chunk = chunk.to_vec();
        queued.push(tokio::spawn(async move {
            manager.send_input_raw("stuck", &chunk).await
        }));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        stuck.writes.lock().unwrap().as_slice(),
        b"",
        "queued input must wait for the earlier write of the same session"
    );
    stuck.gate.release();
    parked.await.unwrap().unwrap();
    for task in queued {
        tokio::time::timeout(BOUND, task)
            .await
            .expect("queued input completes once the stall clears")
            .unwrap()
            .unwrap();
    }
    assert_eq!(stuck.writes.lock().unwrap().as_slice(), b"STALL-a-b-c");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn input_to_a_closed_session_reports_not_found() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    let (conn, _probe) = stalling(None);
    manager.insert_test_session("gone", conn).await;
    manager.close_session("gone").await.unwrap();
    assert!(matches!(
        manager.send_input_raw("gone", b"x").await,
        Err(TerminalError::SessionNotFound(_))
    ));
    assert!(matches!(
        manager.resize("gone", 80, 24).await,
        Err(TerminalError::SessionNotFound(_))
    ));
}
