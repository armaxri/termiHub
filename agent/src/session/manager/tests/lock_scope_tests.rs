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
        let client = DaemonClient::connect(session_id.to_string(), endpoint, notification_tx).await?;
        Ok(SessionBackend::Daemon(client))
    }
}

/// A manager whose daemon sessions connect to `daemons`, in creation order.
fn manager(daemons: &[&FakeDaemon]) -> Arc<SessionManager> {
    let launcher = QueueLauncher {
        endpoints: std::sync::Mutex::new(daemons.iter().map(|d| d.endpoint.clone()).collect()),
    };
    Arc::new(SessionManager::with_launcher(
        test_notification_tx(),
        test_registry(),
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
    assert!(!attaching.is_finished(), "the stuck re-attach is still waiting");

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
    assert!(mgr.list().await.is_empty());
    // One detach from the re-attach releasing its old connection, one from
    // abandoning the new connection.
    until("the new connection to be released", || {
        daemon.seen.detaches.load(Ordering::SeqCst) == 2
    })
    .await;
    assert_eq!(daemon.seen.kills.load(Ordering::SeqCst), 0);
}
