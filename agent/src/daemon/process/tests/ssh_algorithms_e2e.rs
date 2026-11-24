//! An SSH session's negotiated algorithms reach the worker, end to end
//! (#5896).
//!
//! Drives the real `daemon_loop` over a real endpoint with real `DaemonClient`
//! connects. The daemon sends the backend's algorithms right after Ready on
//! every attach; the worker keeps them for `connection.sshAlgorithms`. A
//! backend without an SSH transport sends nothing.

use std::time::Duration;

use crate::daemon::client::DaemonClient;
use crate::daemon::transport::{self, DaemonListener};
use termihub_core::connection::{
    Capabilities, ConnectionType, OutputReceiver, SettingsSchema, SshNegotiatedAlgorithms,
};
use termihub_core::errors::SessionError;

/// A persistent session backend standing in for SSH, reporting `algorithms`.
struct AlgorithmsConnection {
    algorithms: Option<SshNegotiatedAlgorithms>,
}

#[async_trait::async_trait]
impl ConnectionType for AlgorithmsConnection {
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
    async fn ssh_algorithms(&self) -> Option<SshNegotiatedAlgorithms> {
        self.algorithms.clone()
    }
}

fn unique_endpoint(tag: &str) -> String {
    let id = format!(
        "itest-5896-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

fn sample() -> SshNegotiatedAlgorithms {
    SshNegotiatedAlgorithms::new(
        "curve25519-sha256",
        "ssh-ed25519",
        "aes256-ctr",
        "hmac-sha2-256-etm@openssh.com",
    )
}

/// Run a real `daemon_loop` for a session reporting `algorithms`. The output
/// sender is returned: dropping it would end the session.
async fn spawn_daemon(
    endpoint: &str,
    algorithms: Option<SshNegotiatedAlgorithms>,
) -> tokio::sync::mpsc::Sender<Vec<u8>> {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let conn: Box<dyn ConnectionType> = Box::new(AlgorithmsConnection { algorithms });
        let _ = super::super::daemon_loop(
            "algorithms-session",
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

/// Wait until `client` holds algorithms, or `within` passes.
async fn algorithms_of(client: &DaemonClient, within: Duration) -> Option<SshNegotiatedAlgorithms> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if let Some(algorithms) = client.ssh_algorithms() {
            return Some(algorithms);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_attached_worker_learns_the_algorithms() {
    let endpoint = unique_endpoint("live");
    let _out = spawn_daemon(&endpoint, Some(sample())).await;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");
    assert_eq!(
        algorithms_of(&client, Duration::from_secs(5)).await,
        Some(sample())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_attaching_later_learns_them_too() {
    let endpoint = unique_endpoint("later");
    let _out = spawn_daemon(&endpoint, Some(sample())).await;
    let (tx_a, _rx_a) = tokio::sync::mpsc::unbounded_channel();
    let client_a = DaemonClient::connect("s-1".into(), endpoint.clone(), tx_a)
        .await
        .expect("worker A attaches");
    assert!(algorithms_of(&client_a, Duration::from_secs(5))
        .await
        .is_some());

    let (tx_b, _rx_b) = tokio::sync::mpsc::unbounded_channel();
    let client_b = DaemonClient::connect("s-1".into(), endpoint, tx_b)
        .await
        .expect("worker B takes over");
    assert_eq!(
        algorithms_of(&client_b, Duration::from_secs(5)).await,
        Some(sample())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_without_ssh_reports_none() {
    let endpoint = unique_endpoint("none");
    let out = spawn_daemon(&endpoint, None).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = DaemonClient::connect("s-1".into(), endpoint, tx)
        .await
        .expect("worker attaches");
    // Output after Ready proves the frames before it were read.
    out.send(b"banner".to_vec()).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
    assert_eq!(client.ssh_algorithms(), None);
}
