//! Session monitoring for a daemon-hosted session, end to end (#3871).
//!
//! Drives the real `daemon_loop` over a real endpoint with real
//! `DaemonClient` connects: the daemon advertises its backend's monitoring
//! provider, runs it on subscribe, streams its samples only to the worker that
//! holds the session, and stops it once that worker no longer does.

use std::sync::Arc;
use std::time::Duration;

use crate::daemon::client::DaemonClient;
use crate::daemon::protocol::{
    self, CAP_PROCESSES, MSG_ATTACH_INTENT, MSG_CAPABILITIES, MSG_DETACH, MSG_READY,
};
use crate::daemon::transport::{self, DaemonListener};
use crate::io::transport::NotificationSender;
use crate::monitoring::session::test_support::{stats, FakeProvider};
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;
use termihub_core::monitoring::{MonitoringProvider, MonitoringSubscription};

/// A persistent session backend (standing in for SSH / Docker / WSL) that
/// optionally has a monitoring provider.
struct MonitoredConnection {
    provider: Option<Arc<FakeProvider>>,
}

#[async_trait::async_trait]
impl ConnectionType for MonitoredConnection {
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
            monitoring: self.provider.is_some(),
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
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        self.provider
            .as_ref()
            .map(|p| p.as_ref() as &dyn MonitoringProvider)
    }
    fn monitoring_handle(&self) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        self.provider
            .as_ref()
            .map(|p| p.clone() as Arc<dyn MonitoringProvider + Send + Sync>)
    }
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        None
    }
}

fn notification_tx() -> NotificationSender {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    tx
}

/// A fresh, unique daemon endpoint.
pub(crate) fn unique_endpoint(tag: &str) -> String {
    let id = format!(
        "itest-3871-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

/// Run a real `daemon_loop` for a session whose backend has `provider`.
pub(crate) async fn spawn_daemon(endpoint: &str, provider: Option<Arc<FakeProvider>>) {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let _out_tx = out_tx;
        let conn: Box<dyn ConnectionType> = Box::new(MonitoredConnection { provider });
        let _ =
            super::super::daemon_loop("mon-session", conn, out_rx, &mut listener, 4096, None).await;
        listener.cleanup();
    });
}

/// Run a stand-in for a daemon started by an older agent: it completes each
/// connect handshake with `capabilities` (or none) and then ignores every
/// frame but a detach.
pub(crate) async fn spawn_old_daemon(endpoint: &str, capabilities: Option<u8>) {
    let mut listener = DaemonListener::bind(endpoint).await.expect("bind");
    tokio::spawn(async move {
        while let Ok((mut reader, mut writer)) = listener.accept().await {
            tokio::spawn(async move {
                let intent = protocol::read_frame_async(&mut reader).await;
                assert!(matches!(intent, Ok(Some(f)) if f.msg_type == MSG_ATTACH_INTENT));
                if let Some(flags) = capabilities {
                    let _ =
                        protocol::write_frame_async(&mut writer, MSG_CAPABILITIES, &[flags]).await;
                }
                let _ = protocol::write_frame_async(&mut writer, MSG_READY, &[]).await;
                while let Ok(Some(frame)) = protocol::read_frame_async(&mut reader).await {
                    if frame.msg_type == MSG_DETACH {
                        break;
                    }
                }
            });
        }
    });
}

async fn eventually(mut pred: impl FnMut() -> bool) -> bool {
    for _ in 0..250 {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

async fn next_sample(subscription: &mut MonitoringSubscription) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(5), subscription.stats.recv())
        .await
        .expect("a sample or the end of the stream in time")
        .map(|s| s.hostname)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daemon_session_streams_its_own_backends_samples() {
    let endpoint = unique_endpoint("stream");
    let backend = Arc::new(FakeProvider::default());
    spawn_daemon(&endpoint, Some(backend.clone())).await;

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let provider = client
        .monitoring_provider()
        .expect("the daemon advertises the monitoring capability");

    let mut subscription = provider.subscribe().await.expect("subscribe");
    provider.set_interval(Duration::from_secs(3)).await;
    assert_eq!(backend.calls(), ["subscribe", "interval:3000"]);

    backend.push(stats("container-9")).await;
    assert_eq!(
        next_sample(&mut subscription).await.as_deref(),
        Some("container-9")
    );

    provider.unsubscribe().await.expect("unsubscribe");
    assert_eq!(
        backend.calls().last().map(String::as_str),
        Some("unsubscribe")
    );
    assert!(!backend.is_subscribed());
    assert_eq!(
        next_sample(&mut subscription).await,
        None,
        "the stream ends"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_connect_failure_is_the_subscribes_error() {
    let endpoint = unique_endpoint("fail");
    spawn_daemon(&endpoint, Some(Arc::new(FakeProvider::failing("no /proc")))).await;
    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let provider = client.monitoring_provider().expect("advertised");
    let err = match provider.subscribe().await {
        Ok(_) => panic!("the backend failed its connect probe"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("no /proc"), "{err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_without_monitoring_is_not_advertised() {
    let endpoint = unique_endpoint("no-mon");
    spawn_daemon(&endpoint, None).await;
    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    assert!(client.monitoring_provider().is_none());
}

/// A daemon started by an older agent — pre-#3210 (no capability frame) or
/// #3210 (processes only) — never gets a monitoring request it would drop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_daemon_is_not_monitored() {
    for (tag, caps) in [("pre-3210", None), ("3210", Some(CAP_PROCESSES))] {
        let endpoint = unique_endpoint(tag);
        spawn_old_daemon(&endpoint, caps).await;
        let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
            .await
            .expect("worker attaches");
        assert!(client.monitoring_provider().is_none(), "{tag}");
        assert_eq!(
            client.process_manager().is_some(),
            caps.is_some(),
            "{tag}: process support is read from the same frame"
        );
    }
}

/// Single-attach: when another worker takes the session over, the daemon
/// stops the evicted worker's stream (and the provider), and only the new
/// holder can monitor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_takeover_ends_the_evicted_workers_stream() {
    let endpoint = unique_endpoint("takeover");
    let backend = Arc::new(FakeProvider::default());
    spawn_daemon(&endpoint, Some(backend.clone())).await;

    let client_a = DaemonClient::connect("s".into(), endpoint.clone(), notification_tx())
        .await
        .expect("worker A attaches");
    let mut stream_a = client_a
        .monitoring_provider()
        .expect("A holds it")
        .subscribe()
        .await
        .expect("A subscribes");

    let client_b = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker B takes over");
    assert!(eventually(|| client_a.is_evicted()).await, "A is evicted");
    assert_eq!(next_sample(&mut stream_a).await, None, "A's stream ends");
    assert!(
        eventually(|| !backend.is_subscribed()).await,
        "the daemon stops the provider it ran for A"
    );
    assert!(client_a.monitoring_provider().is_none());

    let mut stream_b = client_b
        .monitoring_provider()
        .expect("the new holder can monitor")
        .subscribe()
        .await
        .expect("B subscribes");
    backend.push(stats("for-b")).await;
    assert_eq!(next_sample(&mut stream_b).await.as_deref(), Some("for-b"));
}

/// Detaching gives up the hold on the session, so the daemon stops the
/// provider it ran for this worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_detach_stops_the_workers_stream() {
    let endpoint = unique_endpoint("detach");
    let backend = Arc::new(FakeProvider::default());
    spawn_daemon(&endpoint, Some(backend.clone())).await;

    let mut client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let mut stream = client
        .monitoring_provider()
        .expect("held")
        .subscribe()
        .await
        .expect("subscribe");

    client.detach().await;
    assert_eq!(next_sample(&mut stream).await, None, "the stream ends");
    assert!(eventually(|| !backend.is_subscribed()).await);
}
