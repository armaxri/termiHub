//! The sessions lock is never held across daemon I/O (#4286, CONC2-003).
//!
//! Re-attaching a daemon-backed session (detach + reconnect + handshake) and
//! querying its buffer talk to the daemon over its socket and can take tens of
//! seconds against a slow or wedged daemon. That I/O must run outside the
//! manager's `sessions` lock, so one stuck session never freezes `list`, input,
//! resize, create or attach of every other session on the agent. Operations on
//! the *same* session still queue behind it in order, and a reattach that
//! races a close or a shutdown still ends consistently.

use super::*;
use crate::daemon::protocol::{
    self, MSG_ATTACH_INTENT, MSG_BUFFER_REPLAY, MSG_DETACH, MSG_INPUT, MSG_KILL, MSG_QUERY_BUFFER,
    MSG_READY,
};
use crate::daemon::transport::{self, DaemonListener};
use crate::session::types::SessionBackend;
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

/// How long an operation on an unrelated session may take before the test
/// calls it blocked. Far below the daemon client's own timeouts (15 s ready,
/// 10 s buffer reply), which is what a blocked operation would wait for.
const PROMPT: Duration = Duration::from_secs(3);

/// What the fake daemon withholds.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stall {
    /// Answer everything.
    Nothing,
    /// Never send `MSG_READY` on a re-attach (any connection after the first)
    /// until the test releases it.
    Reattach,
    /// Never answer `MSG_QUERY_BUFFER`.
    Buffer,
    /// Take `MSG_DETACH` but never release the connection (#4476).
    Detach,
}

/// What a fake daemon observed, per kind of frame.
#[derive(Default)]
struct Seen {
    connects: AtomicUsize,
    detaches: AtomicUsize,
    kills: AtomicUsize,
    buffer_queries: AtomicUsize,
    /// `(connection number, bytes)` for every `MSG_INPUT`.
    inputs: std::sync::Mutex<Vec<(usize, Vec<u8>)>>,
}

/// A scripted session daemon on its own endpoint.
struct FakeDaemon {
    endpoint: String,
    seen: Arc<Seen>,
    /// Set to `true` to let stalled re-attach handshakes complete.
    release: tokio::sync::watch::Sender<bool>,
}

fn unique_endpoint(tag: &str) -> String {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    transport::session_endpoint(&format!(
        "lock4286-{tag}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

impl FakeDaemon {
    async fn spawn(tag: &str, stall: Stall) -> Self {
        let endpoint = unique_endpoint(tag);
        let mut listener = DaemonListener::bind(&endpoint).await.expect("bind");
        let seen = Arc::new(Seen::default());
        let (release, release_rx) = tokio::sync::watch::channel(false);
        let accept_seen = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut r, mut w)) = listener.accept().await {
                let n = accept_seen.connects.fetch_add(1, Ordering::SeqCst) + 1;
                let seen = accept_seen.clone();
                let mut release_rx = release_rx.clone();
                tokio::spawn(async move {
                    // The attach preamble: the intent frame comes first.
                    match protocol::read_frame_async(&mut r).await {
                        Ok(Some(f)) if f.msg_type == MSG_ATTACH_INTENT => {}
                        _ => return,
                    }
                    if stall == Stall::Reattach && n > 1 {
                        // Accepts the connection, then says nothing until released.
                        if release_rx.wait_for(|r| *r).await.is_err() {
                            return;
                        }
                    }
                    if protocol::write_frame_async(&mut w, MSG_READY, &[])
                        .await
                        .is_err()
                    {
                        return;
                    }
                    while let Ok(Some(frame)) = protocol::read_frame_async(&mut r).await {
                        match frame.msg_type {
                            MSG_DETACH => {
                                seen.detaches.fetch_add(1, Ordering::SeqCst);
                                if stall == Stall::Detach {
                                    // Keep the connection open: the client
                                    // waits for a release that never comes.
                                    let _ = release_rx.wait_for(|r| *r).await;
                                }
                                return;
                            }
                            MSG_KILL => {
                                seen.kills.fetch_add(1, Ordering::SeqCst);
                                return;
                            }
                            MSG_QUERY_BUFFER => {
                                seen.buffer_queries.fetch_add(1, Ordering::SeqCst);
                                if stall != Stall::Buffer {
                                    let _ = protocol::write_frame_async(
                                        &mut w,
                                        MSG_BUFFER_REPLAY,
                                        b"scrollback",
                                    )
                                    .await;
                                }
                            }
                            MSG_INPUT => {
                                seen.inputs.lock().unwrap().push((n, frame.payload));
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        Self {
            endpoint,
            seen,
            release,
        }
    }

    fn release(&self) {
        let _ = self.release.send(true);
    }
}

/// Launches each new daemon-backed session against the next queued endpoint.
struct QueueLauncher {
    endpoints: std::sync::Mutex<VecDeque<String>>,
}

#[async_trait::async_trait]
impl DaemonLauncher for QueueLauncher {
    async fn launch(
        &self,
        session_id: &str,
        _type_id: &str,
        _settings: &serde_json::Value,
        notification_tx: NotificationSender,
        _buffer_size_bytes: usize,
        _extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error> {
        let endpoint = self
            .endpoints
            .lock()
            .unwrap()
            .pop_front()
            .expect("an endpoint queued for every create");
        let client =
            DaemonClient::connect(session_id.to_string(), endpoint, notification_tx).await?;
        Ok(SessionBackend::Daemon(client))
    }
}

/// A manager whose daemon sessions connect to `daemons`, in creation order.
fn manager(daemons: &[&FakeDaemon]) -> Arc<SessionManager> {
    manager_with(daemons, test_registry())
}

/// Like [`manager`], with the given connection-type registry.
fn manager_with(
    daemons: &[&FakeDaemon],
    registry: Arc<ConnectionTypeRegistry>,
) -> Arc<SessionManager> {
    let launcher = QueueLauncher {
        endpoints: std::sync::Mutex::new(daemons.iter().map(|d| d.endpoint.clone()).collect()),
    };
    Arc::new(SessionManager::with_launcher(
        test_notification_tx(),
        registry,
        Arc::new(launcher),
    ))
}

async fn create(mgr: &SessionManager) -> String {
    mgr.create(
        "docker",
        "t".into(),
        serde_json::json!({"image": "alpine", "shell": "/bin/sh"}),
        None,
    )
    .await
    .expect("create a daemon session")
    .id
}

/// Wait (bounded) until `pred` holds.
async fn until(what: &str, pred: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !pred() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

/// `fut` must finish within [`PROMPT`]: it does not wait behind the stuck
/// session.
async fn promptly<T>(what: &str, fut: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(PROMPT, fut)
        .await
        .unwrap_or_else(|_| panic!("{what} blocked behind another session's daemon I/O"))
}

fn attached(listed: &[SessionSnapshot], id: &str) -> Option<bool> {
    listed.iter().find(|s| s.id == id).map(|s| s.attached)
}

/// Exercise every map-touching operation on a healthy session while another
/// session's daemon I/O is stuck.
async fn other_sessions_stay_responsive(mgr: &SessionManager, healthy: &str, third: &str) {
    promptly("list", mgr.list()).await;
    promptly("active_count", mgr.active_count()).await;
    promptly(
        "write_input",
        SessionManagerApi::write_input(mgr, healthy, b"hi"),
    )
    .await
    .expect("input reaches the healthy session");
    promptly("resize", SessionManagerApi::resize(mgr, healthy, 80, 24))
        .await
        .expect("resize the healthy session");
    let buffer = promptly("get_buffer", mgr.get_buffer(healthy))
        .await
        .expect("buffer of the healthy session");
    assert_eq!(buffer, b"scrollback");
    promptly("attach", mgr.attach(healthy))
        .await
        .expect("attach the healthy session");
    promptly("create", create(mgr)).await;
    promptly("close", mgr.close(third)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stuck_reattach_does_not_block_other_sessions() {
    let stuck = FakeDaemon::spawn("stuck", Stall::Reattach).await;
    let healthy = FakeDaemon::spawn("healthy", Stall::Nothing).await;
    let third = FakeDaemon::spawn("third", Stall::Nothing).await;
    let created = FakeDaemon::spawn("created", Stall::Nothing).await;
    let mgr = manager(&[&stuck, &healthy, &third, &created]);
    let a = create(&mgr).await;
    let b = create(&mgr).await;
    let c = create(&mgr).await;

    let attaching = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { mgr.attach(&a).await }
    });
    until("the re-attach to reach the daemon", || {
        stuck.seen.connects.load(Ordering::SeqCst) == 2
    })
    .await;

    other_sessions_stay_responsive(&mgr, &b, &c).await;
    assert!(
        !attaching.is_finished(),
        "the stuck re-attach is still waiting"
    );

    stuck.release();
    promptly("the released re-attach", attaching)
        .await
        .unwrap()
        .expect("re-attach completes once the daemon answers");
    assert_eq!(attached(&mgr.list().await, &a), Some(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stuck_buffer_query_does_not_block_other_sessions() {
    let stuck = FakeDaemon::spawn("stuck-buf", Stall::Buffer).await;
    let healthy = FakeDaemon::spawn("healthy-buf", Stall::Nothing).await;
    let third = FakeDaemon::spawn("third-buf", Stall::Nothing).await;
    let created = FakeDaemon::spawn("created-buf", Stall::Nothing).await;
    let mgr = manager(&[&stuck, &healthy, &third, &created]);
    let a = create(&mgr).await;
    let b = create(&mgr).await;
    let c = create(&mgr).await;

    let querying = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { mgr.get_buffer(&a).await }
    });
    until("the buffer query to reach the daemon", || {
        stuck.seen.buffer_queries.load(Ordering::SeqCst) == 1
    })
    .await;

    other_sessions_stay_responsive(&mgr, &b, &c).await;
    assert!(!querying.is_finished(), "the stuck query is still waiting");
    querying.abort();
}

/// Input sent while its own session re-attaches waits for the re-attach and
/// lands on the new connection, in order — it is neither lost nor refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn input_during_a_reattach_waits_and_lands_on_the_new_connection() {
    let daemon = FakeDaemon::spawn("order", Stall::Reattach).await;
    let mgr = manager(&[&daemon]);
    let a = create(&mgr).await;

    let attaching = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { mgr.attach(&a).await }
    });
    until("the re-attach to reach the daemon", || {
        daemon.seen.connects.load(Ordering::SeqCst) == 2
    })
    .await;
    let writing = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move {
            SessionManagerApi::write_input(&*mgr, &a, b"one").await?;
            SessionManagerApi::write_input(&*mgr, &a, b"two").await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!writing.is_finished(), "input queues behind the re-attach");

    daemon.release();
    attaching.await.unwrap().expect("re-attach completes");
    writing.await.unwrap().expect("queued input is delivered");
    until("both inputs to arrive", || {
        daemon.seen.inputs.lock().unwrap().len() == 2
    })
    .await;
    assert_eq!(
        *daemon.seen.inputs.lock().unwrap(),
        vec![(2, b"one".to_vec()), (2, b"two".to_vec())]
    );
}

/// A close issued while the session re-attaches waits for it, then kills the
/// session over the connection the re-attach made: nothing is left attached.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_racing_a_reattach_ends_closed() {
    let daemon = FakeDaemon::spawn("close", Stall::Reattach).await;
    let mgr = manager(&[&daemon]);
    let a = create(&mgr).await;

    let attaching = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { mgr.attach(&a).await }
    });
    until("the re-attach to reach the daemon", || {
        daemon.seen.connects.load(Ordering::SeqCst) == 2
    })
    .await;
    let closing = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { mgr.close(&a).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;

    daemon.release();
    let _ = promptly("the re-attach", attaching).await.unwrap();
    assert!(promptly("the close", closing).await.unwrap(), "closed");
    assert_eq!(attached(&mgr.list().await, &a), None, "the session is gone");
    until("the kill to reach the daemon", || {
        daemon.seen.kills.load(Ordering::SeqCst) == 1
    })
    .await;
}

/// A session removed while its re-attach is in flight (agent shutdown) does
/// not get the new connection published into a dead entry: the re-attach
/// fails and releases the daemon again, so the session stays running and free
/// for the next worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reattach_outliving_its_session_releases_the_daemon() {
    let daemon = FakeDaemon::spawn("gone", Stall::Reattach).await;
    let mgr = manager(&[&daemon]);
    let a = create(&mgr).await;

    let attaching = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { mgr.attach(&a).await }
    });
    until("the re-attach to reach the daemon", || {
        daemon.seen.connects.load(Ordering::SeqCst) == 2
    })
    .await;
    promptly("close_all", mgr.close_all()).await;

    daemon.release();
    let result = promptly("the re-attach", attaching).await.unwrap();
    assert!(result.is_err(), "the session went away meanwhile");
    // One detach from the re-attach releasing its old connection, one from
    // abandoning the new connection.
    until("the new connection to be released", || {
        daemon.seen.detaches.load(Ordering::SeqCst) == 2
    })
    .await;
    assert_eq!(daemon.seen.kills.load(Ordering::SeqCst), 0);
    // Shut down, so at most listed as still running on the host — never held.
    assert_ne!(attached(&mgr.list().await, &a), Some(true));
}

// ── In-process write / resize and shutdown (#4476) ─────────────────

/// Writes of this payload block in the backend until the test releases them.
const STALL: &[u8] = b"stall";

/// What the in-process stall backends observed, shared by all of them.
#[derive(Default)]
struct StallState {
    /// Lets stalled writes return.
    released: AtomicBool,
    /// Stalled writes currently blocked in the backend.
    blocked: AtomicUsize,
    /// Every write and resize, in the order the backends ran them.
    ops: std::sync::Mutex<Vec<String>>,
    disconnects: AtomicUsize,
}

impl StallState {
    fn ops(&self) -> Vec<String> {
        self.ops.lock().unwrap().clone()
    }
}

/// An in-process (non-persistent) backend whose `write` of [`STALL`] blocks
/// like a PTY whose program stopped reading its input.
struct StallConnection {
    state: Arc<StallState>,
}

#[async_trait::async_trait]
impl termihub_core::connection::ConnectionType for StallConnection {
    fn type_id(&self) -> &str {
        "stall"
    }
    fn display_name(&self) -> &str {
        "Stall"
    }
    fn settings_schema(&self) -> termihub_core::connection::SettingsSchema {
        termihub_core::connection::SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> termihub_core::connection::Capabilities {
        termihub_core::connection::Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(
        &mut self,
        _settings: serde_json::Value,
    ) -> Result<(), termihub_core::errors::SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), termihub_core::errors::SessionError> {
        self.state.disconnects.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, data: &[u8]) -> Result<(), termihub_core::errors::SessionError> {
        if data == STALL {
            self.state.blocked.fetch_add(1, Ordering::SeqCst);
            while !self.state.released.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.state.blocked.fetch_sub(1, Ordering::SeqCst);
        }
        self.state
            .ops
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(data).into_owned());
        Ok(())
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), termihub_core::errors::SessionError> {
        self.state
            .ops
            .lock()
            .unwrap()
            .push(format!("resize {cols}x{rows}"));
        Ok(())
    }
    fn subscribe_output(&self) -> termihub_core::connection::OutputReceiver {
        // Keep the sender alive so the session stays running.
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        std::mem::forget(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        None
    }
}

/// The agent's registry plus the `stall` in-process type, sharing `state`.
fn stall_registry(state: &Arc<StallState>) -> Arc<ConnectionTypeRegistry> {
    let mut registry = crate::registry::build_registry();
    let state = state.clone();
    registry.register(
        "stall",
        "Stall",
        "terminal",
        Box::new(move || {
            Box::new(StallConnection {
                state: state.clone(),
            })
        }),
    );
    Arc::new(registry)
}

async fn create_stall(mgr: &SessionManager) -> String {
    mgr.create("stall", "s".into(), serde_json::json!({}), None)
        .await
        .expect("create an in-process session")
        .id
}

/// Start a write on `id` in the background.
fn spawn_write(
    mgr: &Arc<SessionManager>,
    id: &str,
    data: &'static [u8],
) -> tokio::task::JoinHandle<Result<(), String>> {
    let mgr = mgr.clone();
    let id = id.to_string();
    tokio::spawn(async move { SessionManagerApi::write_input(&*mgr, &id, data).await })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stuck_in_process_write_does_not_block_other_sessions() {
    let state = Arc::new(StallState::default());
    let mgr = manager_with(&[], stall_registry(&state));
    let a = create_stall(&mgr).await;
    let b = create_stall(&mgr).await;
    let c = create_stall(&mgr).await;

    let writing = spawn_write(&mgr, &a, STALL);
    until("the write to block in the backend", || {
        state.blocked.load(Ordering::SeqCst) == 1
    })
    .await;

    promptly("list", mgr.list()).await;
    promptly("active_count", mgr.active_count()).await;
    promptly("write_input", SessionManagerApi::write_input(&*mgr, &b, b"hi"))
        .await
        .expect("input reaches the healthy session");
    promptly("resize", SessionManagerApi::resize(&*mgr, &b, 80, 24))
        .await
        .expect("resize the healthy session");
    promptly("attach", mgr.attach(&b))
        .await
        .expect("attach the healthy session");
    promptly("detach", mgr.detach(&b))
        .await
        .expect("detach the healthy session");
    promptly("create", create_stall(&mgr)).await;
    assert!(promptly("close", mgr.close(&c)).await, "closed");
    assert_eq!(state.ops(), vec!["hi", "resize 80x24"]);
    assert!(!writing.is_finished(), "the stuck write is still blocked");

    state.released.store(true, Ordering::SeqCst);
    promptly("the released write", writing)
        .await
        .unwrap()
        .expect("the stalled write completes once the backend drains");
}

/// Input and resizes queued behind a stalled write on the same session run in
/// arrival order once it returns — none overtakes it, none is lost.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_process_input_queued_behind_a_stuck_write_keeps_its_order() {
    let state = Arc::new(StallState::default());
    let mgr = manager_with(&[], stall_registry(&state));
    let a = create_stall(&mgr).await;

    let stalled = spawn_write(&mgr, &a, STALL);
    until("the write to block in the backend", || {
        state.blocked.load(Ordering::SeqCst) == 1
    })
    .await;
    let one = spawn_write(&mgr, &a, b"one");
    tokio::time::sleep(Duration::from_millis(50)).await;
    let resize = tokio::spawn({
        let mgr = mgr.clone();
        let a = a.clone();
        async move { SessionManagerApi::resize(&*mgr, &a, 100, 30).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let two = spawn_write(&mgr, &a, b"two");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(state.ops().is_empty(), "nothing overtakes the stalled write");

    state.released.store(true, Ordering::SeqCst);
    for op in [stalled, one, resize, two] {
        promptly("a queued operation", op).await.unwrap().unwrap();
    }
    assert_eq!(state.ops(), vec!["stall", "one", "resize 100x30", "two"]);
}

/// A write whose caller gave up keeps the session's turn until the backend
/// returns, so later input still cannot overtake it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_abandoned_in_process_write_still_keeps_its_place() {
    let state = Arc::new(StallState::default());
    let mgr = manager_with(&[], stall_registry(&state));
    let a = create_stall(&mgr).await;

    let stalled = spawn_write(&mgr, &a, STALL);
    until("the write to block in the backend", || {
        state.blocked.load(Ordering::SeqCst) == 1
    })
    .await;
    stalled.abort();
    let next = spawn_write(&mgr, &a, b"next");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!next.is_finished(), "input waits for the backend write");

    state.released.store(true, Ordering::SeqCst);
    promptly("the queued write", next).await.unwrap().unwrap();
    assert_eq!(state.ops(), vec!["stall", "next"]);
}

/// Shutdown detaches daemons concurrently and gives up on a stuck one at its
/// deadline: the other daemons are still released and the agent exits on time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_all_with_a_stuck_daemon_meets_its_deadline() {
    let stuck = FakeDaemon::spawn("stuck-detach", Stall::Detach).await;
    let healthy = [
        FakeDaemon::spawn("shut-1", Stall::Nothing).await,
        FakeDaemon::spawn("shut-2", Stall::Nothing).await,
        FakeDaemon::spawn("shut-3", Stall::Nothing).await,
    ];
    let mgr = manager(&[&stuck, &healthy[0], &healthy[1], &healthy[2]]);
    for _ in 0..4 {
        create(&mgr).await;
    }

    let started = std::time::Instant::now();
    promptly(
        "close_all",
        mgr.close_all_within(Duration::from_millis(500)),
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "close_all waited {:?} past its deadline",
        started.elapsed()
    );
    assert!(mgr.list().await.iter().all(|s| !s.attached), "nothing held");
    assert_eq!(stuck.seen.detaches.load(Ordering::SeqCst), 1);
    for daemon in &healthy {
        until("every healthy daemon to be detached", || {
            daemon.seen.detaches.load(Ordering::SeqCst) == 1
        })
        .await;
        assert_eq!(daemon.seen.kills.load(Ordering::SeqCst), 0, "detached, not killed");
    }
    stuck.release();
}

/// Shutdown neither hangs on an in-process session whose write is stuck nor
/// skips disconnecting the healthy ones.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_all_with_a_stuck_in_process_write_meets_its_deadline() {
    let state = Arc::new(StallState::default());
    let mgr = manager_with(&[], stall_registry(&state));
    let a = create_stall(&mgr).await;
    create_stall(&mgr).await;
    create_stall(&mgr).await;

    let writing = spawn_write(&mgr, &a, STALL);
    until("the write to block in the backend", || {
        state.blocked.load(Ordering::SeqCst) == 1
    })
    .await;

    promptly(
        "close_all",
        mgr.close_all_within(Duration::from_millis(500)),
    )
    .await;
    assert!(mgr.list().await.is_empty());
    assert_eq!(state.disconnects.load(Ordering::SeqCst), 2);
    state.released.store(true, Ordering::SeqCst);
    let _ = promptly("the released write", writing).await;
}
