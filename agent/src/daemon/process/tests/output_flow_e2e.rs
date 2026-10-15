//! Output flow control for daemon-backed (persistent) sessions, end to end
//! (#4416).
//!
//! Drives the real `daemon_loop` over a real endpoint with real `DaemonClient`
//! connects. While the attached worker has paused the session's output, the
//! daemon must not read its backend's output channel at all, so the bounded
//! channel fills and the backend's producer (the PTY reader) is backpressured.
//! Resuming delivers every held chunk, in order; a worker that attaches later
//! starts flowing again.

use std::time::Duration;

use base64::Engine;

use crate::daemon::client::DaemonClient;
use crate::daemon::transport::{self, DaemonListener};
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::CONNECTION_OUTPUT;
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;

type NotificationRx = tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>;

/// A persistent session backend whose output the test feeds directly into the
/// daemon's output channel.
struct QuietConnection;

#[async_trait::async_trait]
impl ConnectionType for QuietConnection {
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
            file_browser: false,
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
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        None
    }
}

fn unique_endpoint(tag: &str) -> String {
    let id = format!(
        "itest-4416-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

/// Capacity of the backend output channel the daemon reads.
const OUTPUT_CAPACITY: usize = 2;

/// Run a real `daemon_loop`; the returned sender is the backend's output
/// producer (dropping it ends the session).
async fn spawn_daemon(endpoint: &str) -> tokio::sync::mpsc::Sender<Vec<u8>> {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(OUTPUT_CAPACITY);
    tokio::spawn(async move {
        let conn: Box<dyn ConnectionType> = Box::new(QuietConnection);
        let _ = super::super::daemon_loop(
            "output-flow-session",
            conn,
            out_rx,
            &mut listener,
            4096,
            None,
        )
        .await;
        listener.cleanup();
    });
    out_tx
}

/// Collect `connection.output` bytes until `want` bytes arrived or `within`
/// passed.
async fn collect_output(rx: &mut NotificationRx, want: usize, within: Duration) -> Vec<u8> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut got = Vec::new();
    let _ = tokio::time::timeout(within, async {
        while got.len() < want {
            let Some(n) = rx.recv().await else { break };
            if n.method == CONNECTION_OUTPUT {
                let data = n.params["data"].as_str().unwrap_or_default();
                got.extend(b64.decode(data).unwrap_or_default());
            }
        }
    })
    .await;
    got
}

/// Push `chunks` into the producer until the channel refuses one; returns how
/// many were accepted. A daemon that is reading never lets the channel fill.
async fn fill_until_refused(out: &tokio::sync::mpsc::Sender<Vec<u8>>, chunk: &[u8]) -> usize {
    let mut accepted = 0;
    for _ in 0..64 {
        if out.try_send(chunk.to_vec()).is_err() {
            return accepted;
        }
        accepted += 1;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    accepted
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paused_daemon_stops_reading_output_until_resumed() {
    let endpoint = unique_endpoint("pause");
    let out = spawn_daemon(&endpoint).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");
    assert!(
        client.output_flow_supported(),
        "this daemon must advertise output flow control"
    );

    client.set_output_paused(true).await.expect("pause sent");
    // Let the daemon apply the pause before output arrives.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let accepted = fill_until_refused(&out, b"x").await;
    assert_eq!(
        accepted, OUTPUT_CAPACITY,
        "a paused daemon must not read its output channel (no backpressure)"
    );
    assert!(
        collect_output(&mut rx, 1, Duration::from_millis(200))
            .await
            .is_empty(),
        "a paused daemon forwarded output"
    );

    client.set_output_paused(false).await.expect("resume sent");
    let got = collect_output(&mut rx, OUTPUT_CAPACITY, Duration::from_secs(5)).await;
    assert_eq!(got, b"xx", "resumed daemon must deliver the held output");

    // Flowing again: the channel drains as fast as it is fed.
    out.send(b"after".to_vec()).await.unwrap();
    let got = collect_output(&mut rx, 5, Duration::from_secs(5)).await;
    assert_eq!(got, b"after");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_newly_attached_worker_starts_flowing() {
    let endpoint = unique_endpoint("reattach");
    let out = spawn_daemon(&endpoint).await;
    let (tx_a, _rx_a) = tokio::sync::mpsc::unbounded_channel();
    let client_a = DaemonClient::connect("s-1".into(), endpoint.clone(), tx_a)
        .await
        .expect("worker A attaches");
    client_a.set_output_paused(true).await.expect("pause sent");
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Worker B takes the session over: the pause was A's, so B must see output.
    let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel();
    let _client_b = DaemonClient::connect("s-1".into(), endpoint, tx_b)
        .await
        .expect("worker B takes over");
    out.send(b"for-b".to_vec()).await.unwrap();
    let got = collect_output(&mut rx_b, 5, Duration::from_secs(5)).await;
    assert_eq!(got, b"for-b", "a new worker must not inherit the pause");
}

/// #4439: with the transport stalled (the worker's notifications are held, so
/// none returns its credit), the daemon stops reading once the credit window is
/// used up and the worker pauses it at its budget: the backend producer is
/// backpressured and the queue stays within the window plus one chunk. Writing
/// the queue out returns the credit and resumes the daemon.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_transport_pauses_the_daemon_at_the_budget() {
    use crate::daemon::protocol::OUTPUT_CREDIT_WINDOW;
    use crate::session::output_budget::OUTPUT_BUDGET_BYTES;

    const CHUNK: usize = 64 * 1024;
    let endpoint = unique_endpoint("budget");
    let out = spawn_daemon(&endpoint).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");
    assert!(client.output_flow_supported());

    // Flood until the producer stays blocked.
    let chunk = vec![b'z'; CHUNK];
    let max = 8 * OUTPUT_BUDGET_BYTES / CHUNK;
    let mut accepted = 0;
    while accepted < max {
        let send = out.send(chunk.clone());
        if tokio::time::timeout(Duration::from_millis(500), send)
            .await
            .is_err()
        {
            break;
        }
        accepted += 1;
    }
    assert!(accepted < max, "the daemon must stop reading at the budget");
    // Frames the daemon sent before stopping may still be on the socket.
    let mut paused = client.output_budget().subscribe();
    tokio::time::timeout(Duration::from_secs(5), paused.wait_for(|p| *p))
        .await
        .expect("the worker queued its whole budget")
        .unwrap();
    let queued = client.output_budget().queued();
    assert!(
        queued >= OUTPUT_BUDGET_BYTES,
        "paused early: {queued} bytes"
    );
    // Output credit is the strict bound: the daemon keeps at most the window
    // unacknowledged (and reads one more backend chunk at most), however late
    // the pause lands. Without it a loaded Linux runner queued 3.75 MiB while
    // the pause was still in flight.
    let bound = OUTPUT_CREDIT_WINDOW + CHUNK;
    assert!(
        queued <= bound,
        "{queued} bytes queued for one session (bound {bound})"
    );

    // The transport writes the queue out: the daemon resumes and drains.
    let mut held = Vec::new();
    while let Ok(n) = rx.try_recv() {
        held.push(n);
    }
    drop(held);
    tokio::time::timeout(Duration::from_secs(5), out.send(b"end".to_vec()))
        .await
        .expect("the daemon resumed reading")
        .unwrap();
    let mut tail = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while !tail.ends_with(b"end") {
            tail.extend(collect_output(&mut rx, 1, Duration::from_secs(5)).await);
        }
    })
    .await;
    assert!(
        tail.ends_with(b"end"),
        "the held output and the tail arrived"
    );
}

/// Flood the producer with `chunk` until a send stays blocked; returns how many
/// were accepted, capped at `max`.
async fn flood_until_blocked(
    out: &tokio::sync::mpsc::Sender<Vec<u8>>,
    chunk: &[u8],
    max: usize,
) -> usize {
    let mut accepted = 0;
    while accepted < max {
        let send = out.send(chunk.to_vec());
        if tokio::time::timeout(Duration::from_millis(500), send)
            .await
            .is_err()
        {
            break;
        }
        accepted += 1;
    }
    accepted
}

/// #4768: the credit window holds from the moment a worker attaches, not only
/// once its capabilities frame has been processed. A worker whose capabilities
/// are late — the stretch a loaded Windows runner stretched until the daemon
/// had sent 1.5 MiB against a 576 KiB bound — is still held to the window
/// while they are owed; once they arrive declaring no credit, output flows.
///
/// The worker here is raw: it attaches, keeps reading every frame (so the
/// daemon's worker queue never fills and only credit can stop the reads), and
/// sends neither its capabilities nor any ack until told to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_window_holds_while_a_workers_capabilities_are_owed() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use crate::daemon::protocol::{self, MSG_AGENT_CAPABILITIES, MSG_OUTPUT, OUTPUT_CREDIT_WINDOW};

    const CHUNK: usize = 64 * 1024;
    let endpoint = unique_endpoint("owed-caps");
    let out = spawn_daemon(&endpoint).await;
    let (mut reader, mut writer) = transport::connect(&endpoint)
        .await
        .expect("worker connects");

    let received = Arc::new(AtomicUsize::new(0));
    let counted = received.clone();
    let tail = Arc::new(tokio::sync::Notify::new());
    let tail_seen = tail.clone();
    tokio::spawn(async move {
        while let Ok(Some(frame)) = protocol::read_frame_async(&mut reader).await {
            if frame.msg_type == MSG_OUTPUT {
                counted.fetch_add(frame.payload.len(), Ordering::SeqCst);
                if frame.payload == b"end" {
                    tail_seen.notify_one();
                }
            }
        }
    });

    let chunk = vec![b'z'; CHUNK];
    let max = 8 * OUTPUT_CREDIT_WINDOW / CHUNK;
    let accepted = flood_until_blocked(&out, &chunk, max).await;
    assert!(
        accepted < max,
        "the daemon kept reading output for a worker whose capabilities are owed"
    );
    // Frames the daemon sent before stopping may still be on the socket.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let sent = received.load(Ordering::SeqCst);
    let bound = OUTPUT_CREDIT_WINDOW + CHUNK;
    assert!(
        sent <= bound,
        "{sent} bytes sent before the worker's capabilities (bound {bound})"
    );

    // The capabilities arrive, declaring no credit: nothing is held any more.
    protocol::write_frame_async(&mut writer, MSG_AGENT_CAPABILITIES, &[0])
        .await
        .expect("capabilities sent");
    tokio::time::timeout(Duration::from_secs(5), out.send(b"end".to_vec()))
        .await
        .expect("the daemon resumed reading")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), tail.notified())
        .await
        .expect("the held output and the tail arrived");
}

/// #4768: a worker that never declares its capabilities (one predating #3140)
/// is held to the window only until the capabilities deadline, never stalled
/// for good: past it, the daemon reads its output again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_that_declares_no_capabilities_flows_after_the_deadline() {
    use crate::daemon::protocol::{self, MSG_OUTPUT, OUTPUT_CREDIT_WINDOW};

    const CHUNK: usize = 64 * 1024;
    let endpoint = unique_endpoint("no-caps");
    let out = spawn_daemon(&endpoint).await;
    let (mut reader, _writer) = transport::connect(&endpoint)
        .await
        .expect("worker connects");
    let (tail_tx, tail_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut tail_tx = Some(tail_tx);
        while let Ok(Some(frame)) = protocol::read_frame_async(&mut reader).await {
            if frame.msg_type == MSG_OUTPUT && frame.payload == b"end" {
                if let Some(tx) = tail_tx.take() {
                    let _ = tx.send(());
                }
            }
        }
    });

    let max = 8 * OUTPUT_CREDIT_WINDOW / CHUNK;
    let accepted = flood_until_blocked(&out, &vec![b'z'; CHUNK], max).await;
    assert!(
        accepted < max,
        "held to the window while capabilities are owed"
    );

    let deadline = super::super::AGENT_CAPABILITIES_TIMEOUT + Duration::from_secs(5);
    tokio::time::timeout(deadline, out.send(b"end".to_vec()))
        .await
        .expect("the daemon reads again once the capabilities deadline passed")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), tail_rx)
        .await
        .expect("the held output and the tail arrived")
        .unwrap();
}
