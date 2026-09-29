//! Resolving a session's monitoring provider (#3871): the session must exist,
//! be running and be held by this worker before its backend's provider is
//! handed out, and a session hosted by an older daemon says so.

use super::*;
use crate::daemon::client::DaemonClient;
use crate::daemon::process::tests::monitoring_rpc_e2e::{
    spawn_daemon, spawn_old_daemon, unique_endpoint,
};
use crate::daemon::protocol::CAP_PROCESSES;
use crate::monitoring::session::test_support::FakeProvider;
use crate::session::types::SessionBackend;

/// Launches every daemon-backed session as a stub.
struct StubLauncher;

#[async_trait::async_trait]
impl DaemonLauncher for StubLauncher {
    async fn launch(
        &self,
        _session_id: &str,
        _type_id: &str,
        _settings: &serde_json::Value,
        _notification_tx: NotificationSender,
        _buffer_size_bytes: usize,
        _extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error> {
        Ok(SessionBackend::Stub {
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
}

/// Launches each session against a daemon already listening on `endpoint`.
struct EndpointLauncher {
    endpoint: String,
}

#[async_trait::async_trait]
impl DaemonLauncher for EndpointLauncher {
    async fn launch(
        &self,
        session_id: &str,
        _type_id: &str,
        _settings: &serde_json::Value,
        notification_tx: NotificationSender,
        _buffer_size_bytes: usize,
        _extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error> {
        let client = DaemonClient::connect(
            session_id.to_string(),
            self.endpoint.clone(),
            notification_tx,
        )
        .await?;
        Ok(SessionBackend::Daemon(client))
    }
}

fn manager(launcher: Arc<dyn DaemonLauncher>) -> SessionManager {
    SessionManager::with_launcher(test_notification_tx(), test_registry(), launcher)
}

fn docker() -> serde_json::Value {
    serde_json::json!({"image": "alpine", "shell": "/bin/sh"})
}

#[tokio::test]
async fn an_unknown_session_is_not_found() {
    let mgr = manager(Arc::new(StubLauncher));
    assert!(matches!(
        mgr.session_monitoring("no-such-session").await,
        Err(SessionProcessError::Unknown)
    ));
}

/// A session this worker created but does not hold (never attached, or
/// detached) is refused: a client only receives samples from a session it
/// controls.
#[tokio::test]
async fn a_session_not_attached_by_this_worker_is_not_held() {
    let mgr = manager(Arc::new(StubLauncher));
    let s = mgr
        .create("docker", "t".into(), docker(), None)
        .await
        .unwrap();
    assert!(matches!(
        mgr.session_monitoring(&s.id).await,
        Err(SessionProcessError::HeldElsewhere)
    ));

    mgr.attach(&s.id).await.unwrap();
    mgr.detach(&s.id).await.unwrap();
    assert!(matches!(
        mgr.session_monitoring(&s.id).await,
        Err(SessionProcessError::HeldElsewhere)
    ));
}

#[tokio::test]
async fn an_exited_session_is_not_running() {
    let mgr = manager(Arc::new(StubLauncher));
    let s = mgr
        .create("docker", "t".into(), docker(), None)
        .await
        .unwrap();
    mgr.attach(&s.id).await.unwrap();
    mgr.sessions
        .lock()
        .await
        .get_mut(&s.id)
        .expect("session")
        .status = SessionStatus::Exited;
    assert!(matches!(
        mgr.session_monitoring(&s.id).await,
        Err(SessionProcessError::Exited)
    ));
}

/// A held daemon session hands out its backend's provider, run in the daemon.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_daemon_session_monitors_through_its_backend() {
    let endpoint = unique_endpoint("mgr-held");
    let backend = Arc::new(FakeProvider::default());
    spawn_daemon(&endpoint, Some(backend.clone())).await;
    let mgr = manager(Arc::new(EndpointLauncher { endpoint }));
    let s = mgr
        .create("docker", "t".into(), docker(), None)
        .await
        .unwrap();
    mgr.attach(&s.id).await.unwrap();

    let provider = mgr.session_monitoring(&s.id).await.expect("held + served");
    let _subscription = provider.subscribe().await.expect("subscribe");
    assert_eq!(backend.calls(), ["subscribe"]);
}

/// Old-daemon fallback: a session started by an older agent's daemon cannot
/// be monitored and the message says to reopen it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_on_an_older_daemon_is_not_supported() {
    let endpoint = unique_endpoint("mgr-old");
    spawn_old_daemon(&endpoint, Some(CAP_PROCESSES)).await;
    let mgr = manager(Arc::new(EndpointLauncher { endpoint }));
    let s = mgr
        .create("docker", "t".into(), docker(), None)
        .await
        .unwrap();
    mgr.attach(&s.id).await.unwrap();

    match mgr.session_monitoring(&s.id).await {
        Err(SessionProcessError::Unsupported(message)) => {
            assert!(message.contains("older agent"), "{message}");
        }
        Err(other) => panic!("expected Unsupported, got {other:?}"),
        Ok(_) => panic!("expected Unsupported, got a provider"),
    }
}
