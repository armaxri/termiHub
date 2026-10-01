//! A files-only session reaches the desktop, end to end (#4081).
//!
//! Drives the real `daemon_loop` over a real endpoint with real `DaemonClient`
//! connects. When the session backend reports files-only (its SSH host refused
//! the shell but SFTP works), the daemon tells the attached worker, which sends
//! the desktop a `connection.filesOnly` notification; a worker that attaches
//! later (a re-attach, a takeover, a recovering worker) hears it too.

use std::time::Duration;

use crate::daemon::client::DaemonClient;
use crate::daemon::transport::{self, DaemonListener};
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::CONNECTION_FILES_ONLY;
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;

type NotificationRx = tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>;

/// A persistent session backend (standing in for SSH) whose files-only verdict
/// the test sets through the watch sender it keeps.
struct FilesOnlyConnection {
    files_only: tokio::sync::watch::Receiver<bool>,
}

#[async_trait::async_trait]
impl ConnectionType for FilesOnlyConnection {
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
    fn files_only_watch(&self) -> Option<tokio::sync::watch::Receiver<bool>> {
        Some(self.files_only.clone())
    }
}

fn unique_endpoint(tag: &str) -> String {
    let id = format!(
        "itest-4081-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

/// Run a real `daemon_loop` for a session whose files-only verdict the returned
/// sender controls. The output sender is returned too: dropping it would end
/// the session.
async fn spawn_daemon(
    endpoint: &str,
) -> (
    tokio::sync::watch::Sender<bool>,
    tokio::sync::mpsc::Sender<Vec<u8>>,
) {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (files_only_tx, files_only_rx) = tokio::sync::watch::channel(false);
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let conn: Box<dyn ConnectionType> = Box::new(FilesOnlyConnection {
            files_only: files_only_rx,
        });
        let _ = super::super::daemon_loop(
            "files-only-session",
            conn,
            out_rx,
            &mut listener,
            4096,
            None,
        )
        .await;
        listener.cleanup();
    });
    (files_only_tx, out_tx)
}

/// The next `connection.filesOnly` notification within `within`, skipping any
/// other notification; `None` if none arrived.
async fn next_files_only(rx: &mut NotificationRx, within: Duration) -> Option<serde_json::Value> {
    tokio::time::timeout(within, async {
        loop {
            let n = rx.recv().await?;
            if n.method == CONNECTION_FILES_ONLY {
                return Some(n.params);
            }
        }
    })
    .await
    .ok()
    .flatten()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_only_reaches_the_attached_worker_as_a_notification() {
    let endpoint = unique_endpoint("live");
    let (files_only, out) = spawn_daemon(&endpoint).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");

    // Ordinary output is not a files-only verdict.
    out.send(b"banner".to_vec()).await.unwrap();
    assert!(
        next_files_only(&mut rx, Duration::from_millis(200))
            .await
            .is_none(),
        "no files-only notice before the backend reports it"
    );

    files_only.send_replace(true);
    let params = next_files_only(&mut rx, Duration::from_secs(5))
        .await
        .expect("the worker must report files-only to the desktop");
    assert_eq!(params["session_id"], "s-1");
    assert!(client.is_alive(), "a files-only session stays alive");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_attaching_later_hears_files_only_again() {
    let endpoint = unique_endpoint("later");
    let (files_only, _out) = spawn_daemon(&endpoint).await;
    let (tx_a, mut rx_a) = tokio::sync::mpsc::unbounded_channel();
    let _client_a = DaemonClient::connect("s-1".into(), endpoint.clone(), tx_a)
        .await
        .expect("worker A attaches");
    files_only.send_replace(true);
    next_files_only(&mut rx_a, Duration::from_secs(5))
        .await
        .expect("worker A hears files-only");

    // Worker B takes the session over (another desktop, or this desktop's
    // re-attach after a transport break): it learns the verdict on attach.
    let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel();
    let client_b = DaemonClient::connect("s-1".into(), endpoint, tx_b)
        .await
        .expect("worker B takes over");
    let params = next_files_only(&mut rx_b, Duration::from_secs(5))
        .await
        .expect("a later attach must hear files-only too");
    assert_eq!(params["session_id"], "s-1");
    assert!(client_b.is_alive());
}
