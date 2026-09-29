//! `connection.monitoring.*` for agent-hosted sessions (#3871): an SSH,
//! Docker or WSL session is monitored through its backend's own provider, a
//! session this client does not hold is refused, and `"self"` / saved SSH
//! connections keep the agent's own collectors.

use super::*;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use termihub_core::monitoring::MonitoringProvider;

use crate::monitoring::session::test_support::{stats, FakeProvider};
use crate::protocol::messages::JsonRpcNotification;
use crate::session::manager::SessionProcessError;

type Resolution = Result<Arc<dyn MonitoringProvider + Send + Sync>, SessionProcessError>;

/// Session manager double whose monitoring resolution is scripted per session.
struct MonitoredSessions {
    registry: termihub_core::connection::ConnectionTypeRegistry,
    resolutions: StdMutex<HashMap<String, Resolution>>,
}

impl MonitoredSessions {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            registry: crate::registry::build_registry(),
            resolutions: StdMutex::new(HashMap::new()),
        })
    }

    fn script(&self, session_id: &str, resolution: Resolution) {
        self.resolutions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), resolution);
    }
}

#[async_trait::async_trait]
impl SessionManagerApi for MonitoredSessions {
    fn registry(&self) -> &termihub_core::connection::ConnectionTypeRegistry {
        &self.registry
    }
    async fn create(
        &self,
        _type_id: &str,
        _title: String,
        _settings: Value,
        _definition_id: Option<String>,
    ) -> Result<crate::session::types::SessionSnapshot, SessionCreateError> {
        Err(SessionCreateError::InvalidConfig("unused".into()))
    }
    async fn list(&self) -> Vec<crate::session::types::SessionSnapshot> {
        Vec::new()
    }
    async fn get_session_type_id(&self, _session_id: &str) -> Option<String> {
        None
    }
    async fn session_process_manager(
        &self,
        _session_id: &str,
    ) -> Result<Arc<dyn ProcessManager + Send + Sync>, SessionProcessError> {
        Err(SessionProcessError::Unknown)
    }
    async fn session_monitoring(&self, session_id: &str) -> Resolution {
        self.resolutions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or(Err(SessionProcessError::Unknown))
    }
    async fn close(&self, _session_id: &str) -> bool {
        true
    }
    async fn active_count(&self) -> u32 {
        0
    }
    async fn request_deferred_update(
        &self,
        _binary_path: Option<String>,
        _version: Option<String>,
        _expected_sha256: Option<String>,
        _signature: Option<String>,
        _pinned_version: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError> {
        Ok(DeferredUpdateOutcome::Applying)
    }
    async fn attach(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn detach(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn write_input(&self, _session_id: &str, _data: &[u8]) -> Result<(), String> {
        Ok(())
    }
    async fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
        Ok(())
    }
    async fn get_buffer(&self, _session_id: &str) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    async fn set_persistent_buffer_size_bytes(&self, _bytes: usize) {}
    async fn agent_forward_write(&self, _stream_id: &str, _data: Vec<u8>) {}
    async fn agent_forward_close(&self, _stream_id: &str) {}
    async fn agent_forward_connect(
        &self,
        _stream_id: &str,
        _host: &str,
        _port: u16,
    ) -> Result<(), String> {
        Ok(())
    }
}

fn store() -> Arc<ConnectionStore> {
    let tmp = std::env::temp_dir().join(format!("termihub-mon-{}.json", uuid::Uuid::new_v4()));
    Arc::new(ConnectionStore::new_temp(tmp))
}

/// A handler over the real monitoring manager; returns the notifications it
/// streams to the desktop.
async fn real_handler(
    sessions: Arc<MonitoredSessions>,
) -> (
    AgentHandler,
    tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let conn_store = store();
    let monitoring = Arc::new(crate::monitoring::MonitoringManager::new(
        tx,
        conn_store.clone(),
    ));
    let handler = AgentHandler::new(
        sessions as Arc<dyn SessionManagerApi>,
        conn_store as Arc<dyn ConnectionStoreApi>,
        monitoring as Arc<dyn MonitoringManagerApi>,
    )
    .unwrap();
    init_handler(&handler).await;
    (handler, rx)
}

/// A handler over the recording monitoring manager.
async fn mock_handler(
    sessions: Arc<MonitoredSessions>,
) -> (AgentHandler, Arc<MockMonitoringManager>) {
    let monitor = Arc::new(MockMonitoringManager::new());
    let handler = AgentHandler::new(
        sessions as Arc<dyn SessionManagerApi>,
        store() as Arc<dyn ConnectionStoreApi>,
        monitor.clone() as Arc<dyn MonitoringManagerApi>,
    )
    .unwrap();
    init_handler(&handler).await;
    (handler, monitor)
}

async fn subscribe(handler: &AgentHandler, host: &str) -> Value {
    dispatch(
        handler,
        pm::CONNECTION_MONITORING_SUBSCRIBE,
        json!({"host": host, "interval_ms": 2000}),
        7,
    )
    .await
}

#[tokio::test]
async fn initialize_advertises_session_monitoring() {
    let handler = make_handler();
    let r = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(
        r["result"]["capabilities"]["sessionMonitoring"], true,
        "{r}"
    );
}

/// Each agent-hosted session type streams its own backend's samples, keyed by
/// the session id the desktop subscribed with.
#[tokio::test]
async fn ssh_docker_and_wsl_sessions_stream_their_own_backends_samples() {
    let sessions = MonitoredSessions::new();
    let providers: Vec<(&str, Arc<FakeProvider>)> = ["ssh", "docker", "wsl"]
        .into_iter()
        .map(|kind| (kind, Arc::new(FakeProvider::default())))
        .collect();
    for (kind, provider) in &providers {
        sessions.script(&format!("{kind}-session"), Ok(provider.clone() as _));
    }
    let (handler, mut rx) = real_handler(sessions).await;

    for (kind, provider) in &providers {
        let host = format!("{kind}-session");
        let r = subscribe(&handler, &host).await;
        assert!(r.get("result").is_some(), "{kind}: {r}");
        assert_eq!(provider.calls(), ["subscribe", "interval:2000"], "{kind}");

        provider.push(stats(&format!("{kind}-host"))).await;
        let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("a sample in time")
            .expect("channel open");
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["method"], pm::CONNECTION_MONITORING_DATA);
        assert_eq!(v["params"]["host"], host.as_str());
        assert_eq!(v["params"]["hostname"], format!("{kind}-host"));
    }
}

#[tokio::test]
async fn unsubscribe_and_close_stop_the_session_provider() {
    let sessions = MonitoredSessions::new();
    let a = Arc::new(FakeProvider::default());
    let b = Arc::new(FakeProvider::default());
    sessions.script("a", Ok(a.clone() as _));
    sessions.script("b", Ok(b.clone() as _));
    let (handler, _rx) = real_handler(sessions).await;
    subscribe(&handler, "a").await;
    subscribe(&handler, "b").await;

    dispatch(
        &handler,
        pm::CONNECTION_MONITORING_UNSUBSCRIBE,
        json!({"host": "a"}),
        8,
    )
    .await;
    assert!(!a.is_subscribed());

    dispatch(
        &handler,
        pm::CONNECTION_CLOSE,
        json!({"session_id": "b"}),
        9,
    )
    .await;
    assert!(!b.is_subscribed(), "closing the session stops its monitor");
}

#[tokio::test]
async fn detaching_a_session_stops_its_monitor() {
    let sessions = MonitoredSessions::new();
    let provider = Arc::new(FakeProvider::default());
    sessions.script("s", Ok(provider.clone() as _));
    let (handler, _rx) = real_handler(sessions).await;
    subscribe(&handler, "s").await;
    dispatch(
        &handler,
        pm::CONNECTION_DETACH,
        json!({"session_id": "s"}),
        9,
    )
    .await;
    assert!(!provider.is_subscribed());
}

/// Ownership refusals keep the same codes as `connection.processes.*`, so a
/// client never receives samples from a session it does not hold.
#[tokio::test]
async fn sessions_this_client_does_not_hold_are_refused() {
    let sessions = MonitoredSessions::new();
    sessions.script("taken", Err(SessionProcessError::HeldElsewhere));
    sessions.script("exited", Err(SessionProcessError::Exited));
    sessions.script(
        "old-daemon",
        Err(SessionProcessError::Unsupported(
            "reopen it — started by an older agent".into(),
        )),
    );
    let (handler, monitor) = mock_handler(sessions).await;

    let r = subscribe(&handler, "taken").await;
    assert_eq!(r["error"]["code"], errors::SESSION_HELD_BY_OTHER, "{r}");
    let r = subscribe(&handler, "exited").await;
    assert_eq!(r["error"]["code"], errors::SESSION_NOT_RUNNING, "{r}");
    let r = subscribe(&handler, "old-daemon").await;
    assert_eq!(r["error"]["code"], errors::MONITORING_ERROR, "{r}");
    assert!(r["error"]["message"]
        .as_str()
        .unwrap()
        .contains("older agent"));

    assert!(monitor.provider_subscribed.lock().await.is_empty());
    assert!(
        monitor.subscribed.lock().await.is_empty(),
        "a refused session never falls back to the agent's own collectors"
    );
}

/// `"self"` and ids that are not sessions of this client keep the agent's own
/// collectors (the agent host, a saved SSH connection).
#[tokio::test]
async fn non_session_hosts_keep_the_agents_own_collectors() {
    let (handler, monitor) = mock_handler(MonitoredSessions::new()).await;
    subscribe(&handler, "self").await;
    subscribe(&handler, "saved-ssh-connection").await;
    assert_eq!(
        monitor.subscribed.lock().await.as_slice(),
        ["self", "saved-ssh-connection"]
    );
    assert!(monitor.provider_subscribed.lock().await.is_empty());
}

#[tokio::test]
async fn a_session_subscribe_goes_to_the_provider_with_its_interval() {
    let sessions = MonitoredSessions::new();
    sessions.script("s", Ok(Arc::new(FakeProvider::default()) as _));
    let (handler, monitor) = mock_handler(sessions).await;
    let r = subscribe(&handler, "s").await;
    assert!(r.get("result").is_some(), "{r}");
    assert_eq!(
        monitor.provider_subscribed.lock().await.as_slice(),
        [("s".to_string(), Some(2000))]
    );
    assert!(monitor.subscribed.lock().await.is_empty());
}
