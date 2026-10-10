//! Output flow control for in-process agent sessions (#4416).
//!
//! When the desktop terminal falls behind it sends `connection.output_flow`
//! with `paused: true`. The session's output pump must then stop reading the
//! backend's bounded output channel, so the producer (the PTY reader) blocks
//! and the program on the agent host is backpressured — nothing is buffered or
//! dropped on the agent. Resuming delivers every held chunk in order.

use super::*;

use base64::Engine;
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;

use crate::protocol::methods::CONNECTION_OUTPUT;

/// Capacity of the fake backend's output channel.
const OUTPUT_CAPACITY: usize = 2;

type ProducerSlot = Arc<std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>>;
type Rx = tokio::sync::mpsc::UnboundedReceiver<crate::protocol::messages::JsonRpcNotification>;

/// A non-persistent (in-process) backend whose output producer the test holds.
struct FloodConnection {
    producer: ProducerSlot,
}

#[async_trait::async_trait]
impl ConnectionType for FloodConnection {
    fn type_id(&self) -> &str {
        "flood"
    }
    fn display_name(&self) -> &str {
        "Flood"
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
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CAPACITY);
        *self.producer.lock().unwrap() = Some(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        None
    }
}

/// A manager whose only connection type is the flood backend, plus the
/// notification stream it writes to and the slot the producer lands in.
fn manager() -> (SessionManager, Rx, ProducerSlot) {
    let producer: ProducerSlot = Arc::default();
    let factory_slot = producer.clone();
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "flood",
        "Flood",
        "terminal",
        Box::new(move || {
            Box::new(FloodConnection {
                producer: factory_slot.clone(),
            })
        }),
    );
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (SessionManager::new(tx, Arc::new(registry)), rx, producer)
}

async fn create_flood_session(
    mgr: &SessionManager,
    producer: &ProducerSlot,
) -> (String, tokio::sync::mpsc::Sender<Vec<u8>>) {
    let snapshot = mgr
        .create("flood", "flood".into(), serde_json::json!({}), None)
        .await
        .expect("in-process session created");
    let tx = producer
        .lock()
        .unwrap()
        .clone()
        .expect("the backend handed out its producer");
    (snapshot.id, tx)
}

/// Push one-byte chunks until the channel refuses one; returns how many were
/// accepted. A pump that is reading never lets the channel fill.
async fn fill_until_refused(out: &tokio::sync::mpsc::Sender<Vec<u8>>) -> usize {
    let mut accepted = 0;
    for _ in 0..64 {
        if out.try_send(b"x".to_vec()).is_err() {
            return accepted;
        }
        accepted += 1;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    accepted
}

/// Collect `connection.output` bytes until `want` arrived or `within` passed.
async fn collect_output(rx: &mut Rx, want: usize, within: Duration) -> Vec<u8> {
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

#[tokio::test]
async fn paused_session_pump_stops_reading_until_resumed() {
    let (mgr, mut rx, producer) = manager();
    let (sid, out) = create_flood_session(&mgr, &producer).await;

    mgr.set_output_paused(&sid, true).await.expect("pause");
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(
        fill_until_refused(&out).await,
        OUTPUT_CAPACITY,
        "a paused pump must not read the backend's channel (no backpressure)"
    );
    assert!(
        collect_output(&mut rx, 1, Duration::from_millis(100))
            .await
            .is_empty(),
        "a paused pump forwarded output"
    );

    mgr.set_output_paused(&sid, false).await.expect("resume");
    assert_eq!(
        collect_output(&mut rx, OUTPUT_CAPACITY, Duration::from_secs(5)).await,
        b"xx",
        "the resumed pump must deliver the held output, in order"
    );
    out.send(b"more".to_vec()).await.unwrap();
    assert_eq!(
        collect_output(&mut rx, 4, Duration::from_secs(5)).await,
        b"more"
    );
}

#[tokio::test]
async fn detach_and_attach_resume_a_paused_session() {
    // The pause belongs to the desktop that sent it: once it detaches (tab
    // closed, transport lost) the program must not stay blocked, and the next
    // desktop to attach starts flowing.
    let (mgr, mut rx, producer) = manager();
    let (sid, out) = create_flood_session(&mgr, &producer).await;

    mgr.set_output_paused(&sid, true).await.expect("pause");
    mgr.detach(&sid).await.expect("detach");
    out.send(b"after-detach".to_vec()).await.unwrap();
    assert_eq!(
        collect_output(&mut rx, 12, Duration::from_secs(5)).await,
        b"after-detach"
    );

    mgr.set_output_paused(&sid, true).await.expect("pause");
    SessionManagerApi::attach(&mgr, &sid).await.expect("attach");
    out.send(b"after-attach".to_vec()).await.unwrap();
    assert_eq!(
        collect_output(&mut rx, 12, Duration::from_secs(5)).await,
        b"after-attach"
    );
}

#[tokio::test]
async fn output_flow_for_an_unknown_session_is_an_error() {
    let (mgr, _rx, _producer) = manager();
    assert!(mgr.set_output_paused("missing", true).await.is_err());
}

/// Bytes of one flood chunk in the budget tests.
const BUDGET_CHUNK: usize = 64 * 1024;

/// Send `chunk`s until a send stays blocked for a while (the producer is
/// backpressured), or `max` were accepted. Returns how many were accepted.
async fn flood_until_blocked(
    out: &tokio::sync::mpsc::Sender<Vec<u8>>,
    chunk: &[u8],
    max: usize,
) -> usize {
    for accepted in 0..max {
        let send = out.send(chunk.to_vec());
        if tokio::time::timeout(Duration::from_millis(300), send)
            .await
            .is_err()
        {
            return accepted;
        }
    }
    max
}

/// `connection.output` bytes per session in `held` (notifications still queued).
fn queued_bytes(held: &[crate::protocol::messages::JsonRpcNotification], sid: &str) -> usize {
    let b64 = base64::engine::general_purpose::STANDARD;
    held.iter()
        .filter(|n| n.method == CONNECTION_OUTPUT && n.params["session_id"] == sid)
        .map(|n| {
            b64.decode(n.params["data"].as_str().unwrap_or_default())
                .map(|d| d.len())
                .unwrap_or_default()
        })
        .sum()
}

/// #4439: with the transport stalled (nothing is written, so every queued
/// notification keeps its credit), a flooding session queues at most its byte
/// budget — plus the one chunk the pump read before pausing — and then stops
/// reading, so its producer is backpressured. Another session and control
/// notifications still get through, and draining the queue resumes the flood.
#[tokio::test]
async fn a_stalled_transport_bounds_one_sessions_queued_output() {
    use crate::session::output_budget::OUTPUT_BUDGET_BYTES;

    let (mgr, mut rx, producer) = manager();
    let (flood_sid, flood) = create_flood_session(&mgr, &producer).await;

    let chunk = vec![b'y'; BUDGET_CHUNK];
    let max = 4 * OUTPUT_BUDGET_BYTES / BUDGET_CHUNK;
    let accepted = flood_until_blocked(&flood, &chunk, max).await;
    assert!(
        accepted < max,
        "the flooding producer must be backpressured once the budget is used"
    );

    // Hold every queued notification: the transport has written none of them.
    let mut held = Vec::new();
    while let Ok(n) = rx.try_recv() {
        held.push(n);
    }
    let queued = queued_bytes(&held, &flood_sid);
    assert!(
        queued <= OUTPUT_BUDGET_BYTES + BUDGET_CHUNK,
        "{queued} bytes queued for one session exceed the budget"
    );
    assert!(
        queued >= OUTPUT_BUDGET_BYTES,
        "the pump paused before using its budget ({queued} bytes queued)"
    );
    assert_eq!(
        accepted * BUDGET_CHUNK,
        queued + OUTPUT_CAPACITY * BUDGET_CHUNK,
        "everything accepted is either queued or held in the backend channel"
    );

    // Another session on the same connection is not held up by the flood.
    let (other_sid, other) = create_flood_session(&mgr, &producer).await;
    other.send(b"other".to_vec()).await.unwrap();
    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let n = rx.recv().await.expect("channel open");
            let is_other = n.method == CONNECTION_OUTPUT && n.params["session_id"] == other_sid;
            held.push(n);
            if is_other {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(got, "the other session's output must still be forwarded");

    // Control traffic shares the channel uncharged.
    mgr.notification_tx
        .send(crate::protocol::messages::JsonRpcNotification::new(
            "test.control",
            serde_json::json!({}),
        ))
        .unwrap();
    assert_eq!(
        rx.try_recv().expect("control queued").method,
        "test.control"
    );

    // The transport catches up: the flood resumes and its producer drains.
    assert!(
        tokio::time::timeout(Duration::from_secs(1), flood.send(chunk.clone()))
            .await
            .is_err(),
        "still paused while the queue is full"
    );
    drop(held);
    let mut resumed = 0;
    let delivered = tokio::time::timeout(Duration::from_secs(5), async {
        flood.send(chunk.clone()).await.unwrap();
        while let Some(n) = rx.recv().await {
            if n.method == CONNECTION_OUTPUT && n.params["session_id"] == flood_sid {
                resumed += 1;
                // The held channel contents plus the chunk sent above.
                if resumed == OUTPUT_CAPACITY + 1 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(delivered, "draining the queue must resume the session");
}
