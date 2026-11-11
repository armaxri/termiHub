//! A reopening backend's reconnect steps reach the desktop, end to end (#5396).
//!
//! Drives the real `daemon_loop_with_reopen` over a real endpoint with real
//! `DaemonClient` connects. The backend's steps (published on the watch the
//! test holds, as `SerialReopen` does) reach the attached worker, which sends
//! the desktop a `connection.reconnect` notification; a worker that attaches
//! mid-reopen hears the running step; a give-up is told before the exit.

use std::time::Duration;

use crate::daemon::client::DaemonClient;
use crate::daemon::serial_reopen::ReopenStatus;
use crate::daemon::transport::{self, DaemonListener};
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{SessionReconnectStatus, CONNECTION_EXIT, CONNECTION_RECONNECT};
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;

type NotificationRx = tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>;
type StatusTx = tokio::sync::watch::Sender<Option<ReopenStatus>>;

/// A persistent backend standing in for the reopening serial wrapper.
struct QuietConnection;

#[async_trait::async_trait]
impl ConnectionType for QuietConnection {
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
        "itest-5396-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

/// Run a real daemon loop whose reconnect steps the returned watch sender
/// publishes. Dropping the returned output sender ends the session.
async fn spawn_daemon(endpoint: &str) -> (StatusTx, tokio::sync::mpsc::Sender<Vec<u8>>) {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (status_tx, status_rx) = tokio::sync::watch::channel(None);
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let conn: Box<dyn ConnectionType> = Box::new(QuietConnection);
        let _ = super::super::daemon_loop_with_reopen(
            "reopen-session",
            conn,
            out_rx,
            &mut listener,
            4096,
            None,
            Some(status_rx),
        )
        .await;
        listener.cleanup();
    });
    (status_tx, out_tx)
}

fn step(seq: u64, status: SessionReconnectStatus) -> Option<ReopenStatus> {
    Some(ReopenStatus { seq, status })
}

/// The next notification of `method` within `within`, skipping others.
async fn next_of(
    rx: &mut NotificationRx,
    method: &str,
    within: Duration,
) -> Option<serde_json::Value> {
    tokio::time::timeout(within, async {
        loop {
            let n = rx.recv().await?;
            if n.method == method {
                return Some(n.params);
            }
        }
    })
    .await
    .ok()
    .flatten()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_step_reaches_the_attached_worker_as_a_notification() {
    let endpoint = unique_endpoint("live");
    let (status, _out) = spawn_daemon(&endpoint).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");

    status.send_replace(step(
        1,
        SessionReconnectStatus::Waiting {
            attempt: 0,
            delay_ms: 1000,
            reason: Some("Serial port /dev/ttyUSB0 disconnected.".into()),
        },
    ));
    let params = next_of(&mut rx, CONNECTION_RECONNECT, Duration::from_secs(5))
        .await
        .expect("the waiting step reaches the desktop");
    assert_eq!(params["session_id"], "s-1");
    assert_eq!(params["seq"], 1);
    assert_eq!(params["state"], "waiting");
    assert_eq!(params["delay_ms"], 1000);
    assert_eq!(params["reason"], "Serial port /dev/ttyUSB0 disconnected.");

    status.send_replace(step(2, SessionReconnectStatus::Reconnected));
    let params = next_of(&mut rx, CONNECTION_RECONNECT, Duration::from_secs(5))
        .await
        .expect("the reconnected step reaches the desktop");
    assert_eq!(params["state"], "reconnected");
    assert!(client.is_alive(), "the session stays the same session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_attaching_mid_reopen_hears_the_running_step() {
    let endpoint = unique_endpoint("later");
    let (status, _out) = spawn_daemon(&endpoint).await;
    status.send_replace(step(
        3,
        SessionReconnectStatus::Connecting {
            attempt: 1,
            reason: None,
        },
    ));
    // Nobody attached yet; give the loop a moment to see the step.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let _client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");
    let params = next_of(&mut rx, CONNECTION_RECONNECT, Duration::from_secs(5))
        .await
        .expect("an attach mid-reopen hears where the loop stands");
    assert_eq!(params["seq"], 3);
    assert_eq!(params["state"], "connecting");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_give_up_is_told_before_the_session_ends() {
    let endpoint = unique_endpoint("gaveup");
    let (status, out) = spawn_daemon(&endpoint).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let _client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");

    // The give-up and the end of the output race, as in the real wrapper.
    status.send_replace(step(
        21,
        SessionReconnectStatus::GaveUp {
            reason: Some("Serial port /dev/ttyUSB0 is not present.".into()),
        },
    ));
    drop(out);

    let mut methods = Vec::new();
    while let Ok(Some(n)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        let done = n.method == CONNECTION_EXIT;
        methods.push((n.method, n.params));
        if done {
            break;
        }
    }
    let gave_up = methods
        .iter()
        .position(|(m, p)| m == CONNECTION_RECONNECT && p["state"] == "gaveUp")
        .expect("the give-up reaches the desktop");
    let exit = methods
        .iter()
        .position(|(m, _)| m == CONNECTION_EXIT)
        .expect("the session ends");
    assert!(gave_up < exit, "the give-up comes before the exit");
}
