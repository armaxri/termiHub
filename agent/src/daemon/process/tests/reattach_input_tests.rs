//! Input sent the moment a worker re-attached reaches the session, and its
//! answer reaches that worker (#5990).
//!
//! The real [`DaemonClient`] adopts a session from the real `daemon_loop`, as
//! an agent does when a desktop opens a persistent session it left running.
//! The session's backend echoes what it is sent, so a byte that is missing
//! from `written` was lost on the way in and one that is missing from the
//! notifications on the way out.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;
use tokio::sync::mpsc;

use crate::daemon::client::DaemonClient;
use crate::daemon::transport::{self, DaemonListener};
use crate::io::transport::NotificationSender;

/// How long a byte may take. Only a failing run waits this long.
const BOUND: Duration = Duration::from_secs(10);

/// A backend that records every write and prints it back at once.
struct EchoConnection {
    written: Arc<Mutex<Vec<u8>>>,
    output: mpsc::Sender<Vec<u8>>,
}

#[async_trait::async_trait]
impl ConnectionType for EchoConnection {
    fn type_id(&self) -> &str {
        "echo"
    }
    fn display_name(&self) -> &str {
        "Echo"
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
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        self.written
            .lock()
            .expect("written")
            .extend_from_slice(data);
        self.output.try_send(data.to_vec()).expect("echo");
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        mpsc::channel(1).1
    }
    fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        None
    }
}

/// The bytes of every `connection.output` notification until `needle` is in
/// them.
async fn output_until(
    notifications: &mut mpsc::UnboundedReceiver<crate::protocol::messages::JsonRpcNotification>,
    needle: &[u8],
) -> Vec<u8> {
    use base64::Engine;
    let mut seen = Vec::new();
    let all = tokio::time::timeout(BOUND, async {
        while !seen.windows(needle.len()).any(|w| w == needle) {
            let note = notifications.recv().await.expect("the worker is attached");
            if let Some(data) = note.params.get("data").and_then(|d| d.as_str()) {
                seen.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .expect("base64"),
                );
            }
        }
    })
    .await;
    assert!(all.is_ok(), "{needle:?} never reached the worker: {seen:?}");
    seen
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_right_after_an_adoption_reaches_the_session_and_is_answered() {
    let endpoint = transport::session_endpoint(&format!("itest-5990-{}", std::process::id()));
    let mut listener = DaemonListener::bind(&endpoint).await.expect("bind");
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
    let written = Arc::new(Mutex::new(Vec::new()));
    let backend = EchoConnection {
        written: written.clone(),
        output: out_tx.clone(),
    };
    let daemon = tokio::spawn(async move {
        let _ = super::super::daemon_loop(
            "test-5990",
            Box::new(backend),
            out_rx,
            &mut listener,
            4096,
            None,
        )
        .await;
        listener.cleanup();
    });

    // The session prints its prompt, then the first worker leaves.
    let attach = |tx: NotificationSender| {
        DaemonClient::connect_for_recovery("test-5990".into(), endpoint.clone(), tx)
    };
    let (tx, mut notes) = mpsc::unbounded_channel();
    let mut first = attach(tx).await.expect("attach");
    out_tx.send(b"$ ".to_vec()).await.expect("prompt");
    assert_eq!(output_until(&mut notes, b"$ ").await, b"$ ");
    first.detach().await;

    // Adopt it again and again, typing at once each time.
    let mut expected = b"$ ".to_vec();
    for round in 0..20 {
        let (tx, mut notes) = mpsc::unbounded_channel();
        let mut client = attach(tx).await.expect("adopt");
        let line = format!("round-{round}\r").into_bytes();
        DaemonClient::write_via_handle(&client.writer_handle(), &line)
            .await
            .expect("write");
        expected.extend_from_slice(&line);
        // The replay, then the answer: nothing lost, nothing twice.
        assert_eq!(output_until(&mut notes, &line).await, expected);
        client.detach().await;
    }
    assert_eq!(
        *written.lock().expect("written"),
        expected[2..],
        "every byte reached the session, in order"
    );
    daemon.abort();
}
