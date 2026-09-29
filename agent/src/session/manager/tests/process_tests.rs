//! Resolving a session's process manager (#3210): the session must exist, be
//! running and be held by this worker before anything is listed or killed in
//! it, and a local session keeps the agent host's own manager.

use super::*;
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

fn manager() -> SessionManager {
    SessionManager::with_launcher(
        test_notification_tx(),
        test_registry(),
        Arc::new(StubLauncher),
    )
}

fn ssh() -> serde_json::Value {
    serde_json::json!({"host": "bastion", "username": "alice", "authMethod": "password"})
}

#[tokio::test]
async fn an_unknown_session_is_not_found() {
    let mgr = manager();
    assert!(matches!(
        mgr.session_process_manager("no-such-session").await,
        Err(SessionProcessError::NotFound)
    ));
}

/// A session this worker created but does not hold (never attached, or
/// detached) is refused: a client may only reach processes in a session it
/// controls.
#[tokio::test]
async fn a_session_not_attached_by_this_worker_is_not_held() {
    let mgr = manager();
    let s = mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    assert!(matches!(
        mgr.session_process_manager(&s.id).await,
        Err(SessionProcessError::NotHeld)
    ));

    mgr.attach(&s.id).await.unwrap();
    mgr.detach(&s.id).await.unwrap();
    assert!(matches!(
        mgr.session_process_manager(&s.id).await,
        Err(SessionProcessError::NotHeld)
    ));
}

/// An attached local session lists the agent host's processes, as before.
#[tokio::test]
async fn an_attached_local_session_uses_the_agent_hosts_manager() {
    let mgr = manager();
    let s = mgr
        .create("local", "t".into(), serde_json::json!({}), None)
        .await
        .unwrap();
    mgr.attach(&s.id).await.unwrap();
    assert!(mgr.session_process_manager(&s.id).await.is_ok());
}

/// An attached remote session whose backend exposes no process capability is
/// reported as not supported (the stub stands in for such a backend).
#[tokio::test]
async fn an_attached_session_without_a_process_backend_is_not_supported() {
    let mgr = manager();
    let s = mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    mgr.attach(&s.id).await.unwrap();
    assert!(matches!(
        mgr.session_process_manager(&s.id).await,
        Err(SessionProcessError::NotSupported(_))
    ));
}

/// A session that has exited cannot be managed.
#[tokio::test]
async fn an_exited_session_is_not_running() {
    let mgr = manager();
    let s = mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    mgr.attach(&s.id).await.unwrap();
    mgr.sessions
        .lock()
        .await
        .get_mut(&s.id)
        .expect("session")
        .status = SessionStatus::Exited;
    assert!(matches!(
        mgr.session_process_manager(&s.id).await,
        Err(SessionProcessError::NotRunning)
    ));
}
