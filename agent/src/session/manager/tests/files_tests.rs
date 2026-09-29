//! Resolving a session's file browser (#3242): the session must exist, be
//! running and be held by this worker before any file in it is touched, and a
//! local session keeps browsing the agent host.

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
        mgr.session_file_browser("no-such-session").await,
        Err(SessionProcessError::Unknown)
    ));
}

/// A session this worker created but does not hold (never attached, or
/// detached) is refused: a client may only browse a session it controls.
#[tokio::test]
async fn a_session_not_attached_by_this_worker_is_not_held() {
    let mgr = manager();
    let s = mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    assert!(matches!(
        mgr.session_file_browser(&s.id).await,
        Err(SessionProcessError::HeldElsewhere)
    ));

    mgr.attach(&s.id).await.unwrap();
    mgr.detach(&s.id).await.unwrap();
    assert!(matches!(
        mgr.session_file_browser(&s.id).await,
        Err(SessionProcessError::HeldElsewhere)
    ));
}

/// An attached local session browses the agent host, as before.
#[tokio::test]
async fn an_attached_local_session_browses_the_agent_host() {
    let mgr = manager();
    let s = mgr
        .create("local", "t".into(), serde_json::json!({}), None)
        .await
        .unwrap();
    mgr.attach(&s.id).await.unwrap();
    let browser = mgr.session_file_browser(&s.id).await.expect("held local");
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("marker.txt"), b"x").unwrap();
    let entries = browser
        .list_dir(dir.path().to_str().unwrap())
        .await
        .expect("lists the agent host");
    assert!(entries.iter().any(|e| e.name == "marker.txt"));
}

/// An attached remote session whose backend exposes no file browser is
/// reported as not supported (the stub stands in for such a backend).
#[tokio::test]
async fn an_attached_session_without_a_file_backend_is_not_supported() {
    let mgr = manager();
    let s = mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    mgr.attach(&s.id).await.unwrap();
    assert!(matches!(
        mgr.session_file_browser(&s.id).await,
        Err(SessionProcessError::Unsupported(_))
    ));
}

/// A session that has exited cannot be browsed.
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
        mgr.session_file_browser(&s.id).await,
        Err(SessionProcessError::Exited)
    ));
}

/// A non-persistent (in-process) backend with a file browser, standing in for
/// an agent-hosted FTP session.
struct InProcessBrowsable {
    browser: Arc<termihub_core::files::LocalFileBrowser>,
    output: std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl termihub_core::connection::ConnectionType for InProcessBrowsable {
    fn type_id(&self) -> &str {
        "browsable"
    }
    fn display_name(&self) -> &str {
        "Browsable"
    }
    fn settings_schema(&self) -> termihub_core::connection::SettingsSchema {
        termihub_core::connection::SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> termihub_core::connection::Capabilities {
        termihub_core::connection::Capabilities {
            monitoring: false,
            file_browser: true,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: false,
            tunneling: false,
        }
    }
    async fn connect(
        &mut self,
        _settings: serde_json::Value,
    ) -> Result<(), termihub_core::errors::SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), termihub_core::errors::SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), termihub_core::errors::SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), termihub_core::errors::SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> termihub_core::connection::OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        // Keep the sender so the session stays running.
        *self.output.lock().unwrap() = Some(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        Some(self.browser.as_ref())
    }
    fn file_browser_handle(
        &self,
    ) -> Option<Arc<dyn termihub_core::files::FileBrowser + Send + Sync>> {
        Some(self.browser.clone())
    }
}

/// An in-process session (FTP is one) is browsed through its own connection's
/// file browser, once this worker holds it.
#[tokio::test]
async fn a_held_in_process_session_browses_through_its_own_connection() {
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "browsable",
        "Browsable",
        "network",
        Box::new(|| {
            Box::new(InProcessBrowsable {
                browser: Arc::new(termihub_core::files::LocalFileBrowser::new()),
                output: std::sync::Mutex::new(None),
            })
        }),
    );
    let mgr = SessionManager::with_launcher(
        test_notification_tx(),
        Arc::new(registry),
        Arc::new(StubLauncher),
    );
    let s = mgr
        .create("browsable", "t".into(), serde_json::json!({}), None)
        .await
        .unwrap();
    assert!(matches!(
        mgr.session_file_browser(&s.id).await,
        Err(SessionProcessError::HeldElsewhere)
    ));

    mgr.attach(&s.id).await.unwrap();
    let browser = mgr.session_file_browser(&s.id).await.expect("held");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hello.txt");
    browser
        .write_file(path.to_str().unwrap(), b"through the session")
        .await
        .expect("write");
    assert_eq!(
        browser.read_file(path.to_str().unwrap()).await.unwrap(),
        b"through the session"
    );
}
