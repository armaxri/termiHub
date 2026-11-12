//! Tests for the in-place serial reopen (#5396). A fake port probe and a fake
//! serial backend stand in for the agent host, so no real device is touched.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use termihub_core::reconnect_backoff::RECONNECT_POLICY;

const PORT: &str = "/dev/ttyUSB0";

fn identity(serial: &str) -> SerialDeviceIdentity {
    SerialDeviceIdentity {
        vendor_id: "0403".into(),
        product_id: "6001".into(),
        serial_number: Some(serial.into()),
    }
}

/// The agent host's ports as the test sets them: name → identity.
#[derive(Default)]
struct FakeProbe {
    ports: Mutex<HashMap<String, Option<SerialDeviceIdentity>>>,
}

impl FakeProbe {
    fn set(&self, port: &str, id: Option<SerialDeviceIdentity>) {
        self.ports.lock().unwrap().insert(port.into(), id);
    }
    fn unplug(&self, port: &str) {
        self.ports.lock().unwrap().remove(port);
    }
}

impl SerialPortProbe for FakeProbe {
    fn port_present(&self, port: &str) -> bool {
        self.ports.lock().unwrap().contains_key(port)
    }
    fn list_ports(&self) -> Vec<String> {
        self.ports.lock().unwrap().keys().cloned().collect()
    }
    fn identity(&self, port: &str) -> Option<SerialDeviceIdentity> {
        self.ports.lock().unwrap().get(port).cloned().flatten()
    }
}

/// What the fake backends did: each open's port and output sender (dropping
/// a sender is the adapter being unplugged), and every write.
#[derive(Default)]
struct Opens {
    opened: Vec<(String, mpsc::Sender<Vec<u8>>)>,
    writes: Vec<(usize, Vec<u8>)>,
}

type SharedOpens = Arc<Mutex<Opens>>;

/// A serial backend that "opens" any port and records it.
struct FakeSerial {
    opens: SharedOpens,
    index: Option<usize>,
    rx: Mutex<Option<OutputReceiver>>,
}

#[async_trait::async_trait]
impl ConnectionType for FakeSerial {
    fn type_id(&self) -> &str {
        "serial"
    }
    fn display_name(&self) -> &str {
        "Serial"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: true,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, settings: Value) -> Result<(), SessionError> {
        let port = settings["port"].as_str().unwrap_or_default().to_string();
        let (tx, rx) = mpsc::channel(16);
        let mut opens = self.opens.lock().unwrap();
        opens.opened.push((port, tx));
        self.index = Some(opens.opened.len() - 1);
        *self.rx.lock().unwrap() = Some(rx);
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        self.index.is_some()
    }
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let index = self.index.expect("written only while open");
        self.opens
            .lock()
            .unwrap()
            .writes
            .push((index, data.to_vec()));
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        self.rx.lock().unwrap().take().expect("one subscriber")
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

struct Harness {
    probe: Arc<FakeProbe>,
    opens: SharedOpens,
    reopen: SerialReopen,
    status: ReopenStatusRx,
    output: OutputReceiver,
}

impl Harness {
    /// A wrapper opened on [`PORT`], whose device has identity `S1`.
    async fn open() -> Self {
        let probe = Arc::new(FakeProbe::default());
        probe.set(PORT, Some(identity("S1")));
        let opens: SharedOpens = Arc::default();
        let factory_opens = Arc::clone(&opens);
        let factory: ConnectionFactory = Arc::new(move || {
            Box::new(FakeSerial {
                opens: Arc::clone(&factory_opens),
                index: None,
                rx: Mutex::new(None),
            }) as Box<dyn ConnectionType>
        });
        // No jitter, so the backoff windows are the policy's nominal ones.
        let policy = BackoffConfig {
            jitter_ratio: 0.0,
            ..RECONNECT_POLICY
        };
        let probe_dyn: Arc<dyn SerialPortProbe> = probe.clone();
        let mut reopen = SerialReopen::with_policy(factory, probe_dyn, policy, Box::new(|| 0.0));
        let status = reopen.status_watch();
        reopen
            .connect(json!({ "port": PORT, "baudRate": 115200 }))
            .await
            .expect("first open");
        let output = reopen.subscribe_output();
        Self {
            probe,
            opens,
            reopen,
            status,
            output,
        }
    }

    fn open_count(&self) -> usize {
        self.opens.lock().unwrap().opened.len()
    }

    fn opened_port(&self, index: usize) -> String {
        self.opens.lock().unwrap().opened[index].0.clone()
    }

    /// The backend `index` produces `data`.
    async fn emit(&self, index: usize, data: &[u8]) {
        let tx = self.opens.lock().unwrap().opened[index].1.clone();
        tx.send(data.to_vec()).await.expect("backend output");
    }

    /// The adapter behind backend `index` drops: its output ends.
    fn drop_port(&self, index: usize) {
        let (closed, _) = mpsc::channel(1);
        self.opens.lock().unwrap().opened[index].1 = closed;
    }

    /// Wait (in paused time) for the next published step matching `pred`.
    async fn wait_for(&mut self, pred: impl Fn(&SessionReconnectStatus) -> bool) -> ReopenStatus {
        tokio::time::timeout(Duration::from_secs(600), async {
            loop {
                if let Some(status) = self.status.borrow_and_update().clone() {
                    if pred(&status.status) {
                        return status;
                    }
                }
                self.status.changed().await.expect("status sender alive");
            }
        })
        .await
        .expect("the expected reconnect step")
    }
}

fn waiting_reason(status: &SessionReconnectStatus) -> Option<&str> {
    match status {
        SessionReconnectStatus::Waiting { reason, .. } => reason.as_deref(),
        _ => None,
    }
}

#[tokio::test(start_paused = true)]
async fn drop_absent_different_device_then_the_original_is_reopened() {
    let mut h = Harness::open().await;
    h.emit(0, b"before").await;
    assert_eq!(h.output.recv().await.as_deref(), Some(&b"before"[..]));

    // Unplug: the port is gone and its output ends.
    h.probe.unplug(PORT);
    h.drop_port(0);
    let first = h
        .wait_for(|s| matches!(s, SessionReconnectStatus::Waiting { attempt: 0, .. }))
        .await;
    assert_eq!(
        first.status,
        SessionReconnectStatus::Waiting {
            attempt: 0,
            delay_ms: 1_000,
            reason: Some(format!("Serial port {PORT} disconnected.")),
        }
    );
    // While the port is down, typing has nowhere to go.
    assert!(h.reopen.write(b"x").is_err());

    // The first attempt finds no port.
    let absent = h
        .wait_for(|s| matches!(s, SessionReconnectStatus::Waiting { attempt: 1, .. }))
        .await;
    assert!(waiting_reason(&absent.status).is_some_and(|r| r.contains("is not present")));

    // Another adapter appears on the same name: it is never opened.
    h.probe.set(PORT, Some(identity("OTHER")));
    let different = h
        .wait_for(|s| waiting_reason(s).is_some_and(|r| r.contains("different device")))
        .await;
    assert!(matches!(
        different.status,
        SessionReconnectStatus::Waiting { attempt: 2, .. }
    ));
    assert_eq!(h.open_count(), 1, "a different device must not be opened");

    // The original adapter is back: the same session reopens it.
    h.probe.set(PORT, Some(identity("S1")));
    let done = h
        .wait_for(|s| matches!(s, SessionReconnectStatus::Reconnected))
        .await;
    assert!(done.seq > different.seq, "steps carry a growing sequence");
    assert_eq!(h.open_count(), 2);
    assert_eq!(h.opened_port(1), PORT);

    // Output and input flow through the reopened port, on the same session.
    h.emit(1, b"after").await;
    assert_eq!(h.output.recv().await.as_deref(), Some(&b"after"[..]));
    h.reopen.write(b"hi").expect("write after the reopen");
    assert_eq!(h.opens.lock().unwrap().writes, vec![(1, b"hi".to_vec())]);
    assert!(h.reopen.is_connected());
}

#[tokio::test(start_paused = true)]
async fn an_unidentifiable_device_on_the_name_is_not_opened() {
    let mut h = Harness::open().await;
    h.probe.unplug(PORT);
    h.drop_port(0);
    h.probe.set(PORT, None);
    let unverified = h
        .wait_for(|s| waiting_reason(s).is_some_and(|r| r.contains("could not be identified")))
        .await;
    assert!(matches!(
        unverified.status,
        SessionReconnectStatus::Waiting { attempt: 1, .. }
    ));
    assert_eq!(h.open_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_renamed_port_is_followed_on_a_unique_serial_match() {
    let mut h = Harness::open().await;
    h.probe.unplug(PORT);
    h.drop_port(0);
    h.probe.set("/dev/ttyUSB1", Some(identity("S1")));
    h.wait_for(|s| matches!(s, SessionReconnectStatus::Reconnected))
        .await;
    assert_eq!(h.opened_port(1), "/dev/ttyUSB1");
}

#[tokio::test(start_paused = true)]
async fn the_loop_gives_up_at_the_policy_limit_and_ends_the_session() {
    let mut h = Harness::open().await;
    h.probe.unplug(PORT);
    h.drop_port(0);
    let gave_up = h
        .wait_for(|s| matches!(s, SessionReconnectStatus::GaveUp { .. }))
        .await;
    assert_eq!(
        gave_up.status,
        SessionReconnectStatus::GaveUp {
            reason: Some(format!("Serial port {PORT} is not present.")),
        }
    );
    // Drop + per attempt (connecting + waiting/gave-up): the policy's
    // ten attempts, no more.
    assert_eq!(gave_up.seq, 1 + 2 * RECONNECT_POLICY.max_attempts as u64);
    assert_eq!(h.open_count(), 1);
    // The session output closes, so the daemon ends the session.
    assert_eq!(h.output.recv().await, None);

    // A port that returns after the give-up is not reopened.
    h.probe.set(PORT, Some(identity("S1")));
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(h.open_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn stop_cancels_the_loop() {
    let mut h = Harness::open().await;
    h.probe.unplug(PORT);
    h.drop_port(0);
    h.wait_for(|s| matches!(s, SessionReconnectStatus::Waiting { attempt: 1, .. }))
        .await;

    // The desktop's Stop closes the session, which disconnects the backend.
    h.reopen.disconnect().await.expect("disconnect");
    let last = h.status.borrow().clone();
    assert_eq!(h.output.recv().await, None, "the session output ends");

    // The device comes back later: nothing is opened and no step follows.
    h.probe.set(PORT, Some(identity("S1")));
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(h.open_count(), 1);
    assert_eq!(*h.status.borrow(), last);
}

#[tokio::test(start_paused = true)]
async fn disconnect_while_connected_ends_without_a_reopen() {
    let mut h = Harness::open().await;
    h.reopen.disconnect().await.expect("disconnect");
    assert_eq!(h.output.recv().await, None);
    assert!(h.status.borrow().is_none(), "a plain close is not a drop");
    assert_eq!(h.open_count(), 1);
}

#[test]
fn only_serial_with_auto_reconnect_on_reopens() {
    assert!(wants_reopen("serial", &json!({ "port": PORT })));
    assert!(wants_reopen(
        "serial",
        &json!({ "port": PORT, "autoReconnect": true })
    ));
    assert!(!wants_reopen(
        "serial",
        &json!({ "port": PORT, "autoReconnect": false })
    ));
    assert!(!wants_reopen("ssh", &json!({ "host": "h" })));
    assert!(!wants_reopen("telnet", &json!({ "host": "h" })));
}

#[test]
fn a_status_serializes_with_its_sequence_and_state() {
    let status = ReopenStatus {
        seq: 2,
        status: SessionReconnectStatus::Connecting {
            attempt: 1,
            reason: None,
        },
    };
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "seq": 2, "state": "connecting", "attempt": 1 })
    );
    assert!(status.is_running());
    assert!(!status.is_gave_up());
}
