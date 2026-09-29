//! Process list + kill for a daemon-hosted session, end to end (#3210).
//!
//! Drives the real `daemon_loop` over a real endpoint with real
//! `DaemonClient` connects: the daemon advertises the process capability of
//! its session's `ConnectionType`, serves list / kill through that backend's
//! own process manager, and answers only the worker that holds the session.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use crate::daemon::client::DaemonClient;
use crate::daemon::protocol::{self, MSG_ATTACH_INTENT, MSG_READY};
use crate::daemon::transport::{self, DaemonListener};
use crate::io::transport::NotificationSender;
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::SessionError;
use termihub_core::monitoring::{KillSignal, ProcessError, ProcessInfo, ProcessManager};

/// The backend-side process manager a daemon session exposes.
struct FakeProcesses {
    kills: StdMutex<Vec<(u32, KillSignal)>>,
}

#[async_trait::async_trait]
impl ProcessManager for FakeProcesses {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        Ok(vec![ProcessInfo {
            pid: 4242,
            name: "postgres".into(),
            user: "db".into(),
            cpu_percent: 12.0,
            memory_percent: 3.0,
            memory_kb: None,
        }])
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        if pid == 1 {
            return Err(ProcessError::PermissionDenied("operation not permitted".into()));
        }
        self.kills.lock().unwrap().push((pid, signal));
        Ok(())
    }
}

/// A persistent session backend (standing in for SSH / Docker / WSL) that
/// optionally has a process manager.
struct FakeConnection {
    processes: Option<Arc<FakeProcesses>>,
}

#[async_trait::async_trait]
impl ConnectionType for FakeConnection {
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
            monitoring: true,
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
    fn process_manager(&self) -> Option<Arc<dyn ProcessManager + Send + Sync>> {
        self.processes
            .as_ref()
            .map(|p| p.clone() as Arc<dyn ProcessManager + Send + Sync>)
    }
}

fn notification_tx() -> NotificationSender {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    tx
}

fn unique_endpoint(tag: &str) -> String {
    let id = format!(
        "itest-3210-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    transport::session_endpoint(&id)
}

/// Run a real `daemon_loop` for a session whose backend has `processes`.
async fn spawn_daemon(endpoint: &str, processes: Option<Arc<FakeProcesses>>) {
    let mut listener = DaemonListener::bind(endpoint)
        .await
        .expect("bind daemon endpoint");
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let _out_tx = out_tx;
        let conn: Box<dyn ConnectionType> = Box::new(FakeConnection { processes });
        let _ = super::super::daemon_loop("proc-session", conn, out_rx, &mut listener, 4096, None)
            .await;
        listener.cleanup();
    });
}

fn fake_processes() -> Arc<FakeProcesses> {
    Arc::new(FakeProcesses {
        kills: StdMutex::new(Vec::new()),
    })
}

async fn eventually(mut pred: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daemon_session_lists_and_kills_through_its_own_backend() {
    let endpoint = unique_endpoint("list-kill");
    let processes = fake_processes();
    spawn_daemon(&endpoint, Some(processes.clone())).await;

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    let manager = client
        .process_manager()
        .expect("the daemon advertises the process capability");

    let listed = manager.list_processes().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pid, 4242);
    assert_eq!(listed[0].name, "postgres");

    manager
        .kill_process(4242, KillSignal::Quit)
        .await
        .expect("kill");
    assert_eq!(
        *processes.kills.lock().unwrap(),
        vec![(4242, KillSignal::Quit)],
        "the kill reaches the session's backend with the exact pid and signal"
    );

    // A typed backend failure comes back typed, not as an opaque string.
    assert_eq!(
        manager.kill_process(1, KillSignal::Term).await,
        Err(ProcessError::PermissionDenied(
            "operation not permitted".into()
        ))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_without_processes_is_not_advertised() {
    let endpoint = unique_endpoint("no-procs");
    spawn_daemon(&endpoint, None).await;

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    assert!(client.process_manager().is_none());
}

/// A daemon started by an older agent sends no capability frame: the current
/// worker must treat its session as unsupported rather than send it requests
/// it would silently drop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_daemon_without_the_capability_frame_is_unsupported() {
    let endpoint = unique_endpoint("old-daemon");
    let mut listener = DaemonListener::bind(&endpoint).await.expect("bind");
    tokio::spawn(async move {
        let (mut reader, mut writer) = listener.accept().await.expect("accept");
        let intent = protocol::read_frame_async(&mut reader).await;
        assert!(matches!(intent, Ok(Some(f)) if f.msg_type == MSG_ATTACH_INTENT));
        protocol::write_frame_async(&mut writer, MSG_READY, &[])
            .await
            .unwrap();
        // Hold the connection open like a live pre-#3210 daemon.
        while let Ok(Some(_)) = protocol::read_frame_async(&mut reader).await {}
        listener.cleanup();
    });

    let client = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker attaches");
    assert!(client.process_manager().is_none());
}

/// Single-attach ownership: once another worker takes the session over, the
/// evicted worker can no longer list or kill in it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_evicted_worker_loses_process_access() {
    let endpoint = unique_endpoint("evicted");
    spawn_daemon(&endpoint, Some(fake_processes())).await;

    let client_a = DaemonClient::connect("s".into(), endpoint.clone(), notification_tx())
        .await
        .expect("worker A attaches");
    assert!(client_a.process_manager().is_some());

    let client_b = DaemonClient::connect("s".into(), endpoint, notification_tx())
        .await
        .expect("worker B takes over");
    assert!(eventually(|| client_a.is_evicted()).await, "A is evicted");
    assert!(
        client_a.process_manager().is_none(),
        "the evicted worker has no process access"
    );

    let manager = client_b.process_manager().expect("the new holder does");
    assert_eq!(manager.list_processes().await.unwrap()[0].pid, 4242);
}
