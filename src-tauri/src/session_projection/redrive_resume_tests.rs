//! Headless coverage for the **backend-driven agent reconnect redrive**
//! resume-after-transport-restore path (#2476 / #2480).
//!
//! The live agent-reconnect grade cannot run headlessly (the WKWebView is
//! occlusion-throttled and the real agent SSH handshake stalls over a throwaway
//! sshd — see #2480), so the redrive's *coordination* had no automated coverage
//! at all: nothing exercised "attempt fails while the transport is down → the
//! loop re-arms → an attempt after the transport returns mints a fresh session
//! and publishes its id for the frontend to re-attach to".
//!
//! This drives the **production** `AppReconnectRedrive`, `ReconnectTimerDriver`
//! and `SessionManager` against a controllable fake agent (transport down, then
//! up), with a deterministic manual scheduler, so the whole redrive resume
//! sequence runs synchronously with no wall-clock, webview, or real SSH — the
//! headless half of the #2480 lane. The frontend half (the reconcile → effect
//! re-run → re-attach chain) is covered by `Terminal.agent-reconnect*.test.tsx`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::Manager;

use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::reconnect_backoff::ReconnectPhase;

use crate::commands::projection::ProjectionState;
use crate::connection::config::AgentSettings;
use crate::session::manager::SessionManager;
use crate::session_projection::projection::{publish_sessions, SESSION_LIFECYCLE_REGION};
use crate::session_projection::redrive::AppReconnectRedrive;
use crate::session_projection::store::{SessionLifecycleStore, SessionStatus};
use crate::session_projection::timer::{
    ReconnectRedrive, ReconnectScheduler, ReconnectTimerDriver,
};
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
    AgentFolderInfo, AgentRpcClient, AgentSessionInfo,
};
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
use crate::utils::errors::TerminalError;
use termihub_core::monitoring::provider::MonitoringSender;

/// The armed one-shots a [`ManualScheduler`] records: `key → (delay, task)`.
type ArmedTasks = std::collections::HashMap<String, (u64, Box<dyn FnOnce() + Send>)>;

/// A test scheduler that records armed one-shots and fires on command.
#[derive(Default)]
struct ManualScheduler {
    tasks: Mutex<ArmedTasks>,
}
impl ManualScheduler {
    fn armed(&self, key: &str) -> bool {
        self.tasks.lock().unwrap().contains_key(key)
    }
    fn fire(&self, key: &str) {
        let t = self.tasks.lock().unwrap().remove(key);
        if let Some((_, task)) = t {
            task();
        }
    }
}
impl ReconnectScheduler for ManualScheduler {
    fn schedule(&self, key: String, delay_ms: u64, task: Box<dyn FnOnce() + Send>) {
        self.tasks.lock().unwrap().insert(key, (delay_ms, task));
    }
    fn cancel(&self, key: &str) {
        self.tasks.lock().unwrap().remove(key);
    }
}

/// Controllable fake agent: models the transport being down then up.
struct FakeAgent {
    connected: AtomicBool,
    /// Whether a cold reconnect (reconnect_retained_agent) can re-establish.
    reattach_ok: AtomicBool,
    create_count: AtomicUsize,
    /// The live agent session ids `create_session` minted, so `list_sessions` can
    /// report them as recoverable on reconnect (#2512).
    created_ids: Mutex<Vec<String>>,
    /// Whether the live agent session survived the drop and is recoverable. When
    /// `false`, `list_sessions` returns empty (the agent hard-restarted / the
    /// session aged out) so the redrive must fold session-lost, not create-new.
    session_recoverable: AtomicBool,
    /// Keep output senders alive so create_connection's reader does not end
    /// (which would tear the session down + fold a drop).
    senders: Mutex<Vec<OutputSender>>,
}
impl FakeAgent {
    fn new() -> Self {
        Self {
            connected: AtomicBool::new(true),
            reattach_ok: AtomicBool::new(true),
            create_count: AtomicUsize::new(0),
            created_ids: Mutex::new(Vec::new()),
            session_recoverable: AtomicBool::new(true),
            senders: Mutex::new(Vec::new()),
        }
    }
}
impl AgentRpcClient for FakeAgent {
    fn disconnect_agent(&self, _agent_id: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn is_connected(&self, _agent_id: &str) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
    fn get_capabilities(&self, _agent_id: &str) -> Option<AgentCapabilities> {
        None
    }
    fn reconnect_retained_agent(&self, _agent_id: &str) -> Result<(), TerminalError> {
        if self.connected.load(Ordering::SeqCst) {
            return Ok(());
        }
        if self.reattach_ok.load(Ordering::SeqCst) {
            self.connected.store(true, Ordering::SeqCst);
            Ok(())
        } else {
            Err(TerminalError::RemoteError("transport down".into()))
        }
    }
    fn shutdown_agent(&self, _agent_id: &str, _reason: Option<&str>) -> Result<u32, TerminalError> {
        Ok(0)
    }
    fn send_request(
        &self,
        _agent_id: &str,
        _method: &str,
        _params: Value,
    ) -> Result<Value, TerminalError> {
        // "connection.types" → no types (capabilities parsing is skipped).
        Ok(Value::Null)
    }
    fn create_session(
        &self,
        _agent_id: &str,
        session_type: &str,
        _config: Value,
        _title: Option<&str>,
        _definition_id: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        if !self.connected.load(Ordering::SeqCst) {
            return Err(TerminalError::RemoteError("Agent not connected".into()));
        }
        let n = self.create_count.fetch_add(1, Ordering::SeqCst);
        let session_id = format!("remote-{n}");
        self.created_ids.lock().unwrap().push(session_id.clone());
        Ok(AgentSessionInfo {
            session_id,
            title: "Shell".into(),
            session_type: session_type.into(),
            status: "running".into(),
            attached: false,
            definition_id: None,
        })
    }
    fn attach_session(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn close_session(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn list_sessions(&self, _agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        if !self.session_recoverable.load(Ordering::SeqCst) {
            return Ok(vec![]);
        }
        Ok(self
            .created_ids
            .lock()
            .unwrap()
            .iter()
            .map(|id| AgentSessionInfo {
                session_id: id.clone(),
                title: "Shell".into(),
                session_type: "local".into(),
                status: "running".into(),
                attached: false,
                definition_id: None,
            })
            .collect())
    }
    fn list_connections_and_folders(
        &self,
        _agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        Ok(AgentConnectionsData {
            connections: vec![],
            folders: vec![],
        })
    }
    fn list_definitions(&self, _agent_id: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        Ok(vec![])
    }
    fn save_definition(
        &self,
        _agent_id: &str,
        _definition: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _agent_id: &str,
        _params: Value,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _agent_id: &str, _def_id: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn create_folder(
        &self,
        _agent_id: &str,
        _name: &str,
        _parent_id: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _agent_id: &str,
        _params: Value,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _agent_id: &str, _folder_id: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn register_session_output(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        output_tx: OutputSender,
    ) -> Result<(), TerminalError> {
        self.senders.lock().unwrap().push(output_tx);
        Ok(())
    }
    fn unregister_session_output(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        _monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn unregister_monitoring_output(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn send_session_input(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        _data: &[u8],
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn resize_session(
        &self,
        _agent_id: &str,
        _remote_session_id: &str,
        _cols: u16,
        _rows: u16,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn apply_agent_settings(
        &self,
        _agent_id: &str,
        _settings: &AgentSettings,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn connect_agent(
        &self,
        _agent_id: &str,
        _config: &RemoteAgentConfig,
        _agent_settings: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        self.connected.store(true, Ordering::SeqCst);
        Ok(AgentConnectResult {
            capabilities: serde_json::from_value(serde_json::json!({
                "connection_types": [],
                "max_sessions": 10
            }))
            .unwrap(),
            agent_version: "test".into(),
            protocol_version: "1".into(),
        })
    }
    fn cancel_connect(&self, _agent_id: &str) -> bool {
        false
    }
    fn retain_agent_config(
        &self,
        _agent_id: &str,
        _config: &RemoteAgentConfig,
        _agent_settings: Option<&AgentSettings>,
    ) {
    }
}

fn poll_until<F: Fn() -> bool>(cond: F, label: &str) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("timed out waiting for: {label}");
}

#[test]
fn agent_reconnect_resumes_after_transport_restore() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let agent = Arc::new(FakeAgent::new());
    let manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        agent.clone() as Arc<dyn AgentRpcClient>,
    );
    handle.manage(manager);

    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    handle.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let projector = projection.projector.clone();
    let projector_seed = projection.projector.clone();
    let store_for_publish = store.clone();
    handle.manage(projection);

    let scheduler = Arc::new(ManualScheduler::default());
    let redrive: Arc<dyn ReconnectRedrive> = Arc::new(AppReconnectRedrive::new(handle.clone()));
    let driver = Arc::new(
        ReconnectTimerDriver::new(
            store.clone(),
            scheduler.clone(),
            Arc::new(move || {
                publish_sessions(&projector, &store_for_publish);
            }),
        )
        .with_redrive(redrive),
    );
    handle.manage(driver.clone());

    // Initial connect: agent up → session S1, request retained for the tab.
    let manager_ref = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "config": {} });
    let s1 = tauri::async_runtime::block_on(manager_ref.create_connection(
        "shell",
        settings.clone(),
        Some("agent-1"),
        Some("tab-1:0"),
        false,
        true, // resilient
        true, // backend_reattach
        handle.clone(),
    ))
    .expect("initial connect succeeds");
    store.connect("tab-1");
    store.connected("tab-1");
    store.set_backend_session_id("tab-1", Some(s1.clone()));
    publish_sessions(&projector_seed, &store);

    // Drop: arm the loop (the client session.reconnect mirror does this in prod).
    store.reconnect("tab-1");
    driver.sync("tab-1");
    assert!(scheduler.armed("tab-1"), "timer armed on drop");

    // Transport is DOWN.
    agent.connected.store(false, Ordering::SeqCst);
    agent.reattach_ok.store(false, Ordering::SeqCst);

    // Fire attempt 1: redrive can't re-establish → folds reconnect_failed → re-arms.
    scheduler.fire("tab-1");
    poll_until(
        || store.get("tab-1").map(|s| s.reconnect.phase) == Some(ReconnectPhase::Waiting),
        "redrive folds failure and re-arms Waiting",
    );
    assert!(
        scheduler.armed("tab-1"),
        "timer re-armed after failed attempt"
    );
    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(SessionStatus::Reconnecting)
    );

    // Transport RESTORED.
    agent.reattach_ok.store(true, Ordering::SeqCst);

    // Fire attempt 2: redrive re-establishes the transport and — since the live
    // agent session (`remote-0`) is still listed — RE-ATTACHES to it (#2512)
    // rather than minting a new one, publishing the new desktop session id.
    scheduler.fire("tab-1");
    poll_until(
        || store.get("tab-1").map(|s| s.status) == Some(SessionStatus::Connected),
        "redrive recovers to Connected after restore",
    );
    let life = store.get("tab-1").unwrap();
    assert_eq!(life.status, SessionStatus::Connected);
    assert!(
        life.backend_session_id.is_some()
            && life.backend_session_id.as_deref() != Some(s1.as_str()),
        "a fresh desktop session id is published for the frontend to re-attach"
    );
    assert_eq!(
        agent.create_count.load(Ordering::SeqCst),
        1,
        "the live agent session is re-attached, NOT re-created — only the initial \
         create_session ran (#2512)"
    );
}

/// #2512 session-lost: when the transport re-establishes but the live agent
/// session is genuinely gone (agent hard-restarted / aged out), the redrive must
/// fold the explicit terminal `SessionLost` state — never silently mint a new
/// shell in its place.
#[test]
fn agent_reconnect_folds_session_lost_when_live_session_unrecoverable() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let agent = Arc::new(FakeAgent::new());
    let manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        agent.clone() as Arc<dyn AgentRpcClient>,
    );
    handle.manage(manager);

    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    handle.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let projector = projection.projector.clone();
    let projector_seed = projection.projector.clone();
    let store_for_publish = store.clone();
    handle.manage(projection);

    let scheduler = Arc::new(ManualScheduler::default());
    let redrive: Arc<dyn ReconnectRedrive> = Arc::new(AppReconnectRedrive::new(handle.clone()));
    let driver = Arc::new(
        ReconnectTimerDriver::new(
            store.clone(),
            scheduler.clone(),
            Arc::new(move || {
                publish_sessions(&projector, &store_for_publish);
            }),
        )
        .with_redrive(redrive),
    );
    handle.manage(driver.clone());

    // Initial connect: agent up → session S1 (remote-0), request retained.
    let manager_ref = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "config": {} });
    let s1 = tauri::async_runtime::block_on(manager_ref.create_connection(
        "shell",
        settings.clone(),
        Some("agent-1"),
        Some("tab-1:0"),
        false,
        true, // resilient
        true, // backend_reattach
        handle.clone(),
    ))
    .expect("initial connect succeeds");
    store.connect("tab-1");
    store.connected("tab-1");
    store.set_backend_session_id("tab-1", Some(s1.clone()));
    publish_sessions(&projector_seed, &store);

    // Drop: arm the loop.
    store.reconnect("tab-1");
    driver.sync("tab-1");
    assert!(scheduler.armed("tab-1"), "timer armed on drop");

    // Transport comes back, but the live agent session did NOT survive.
    agent.session_recoverable.store(false, Ordering::SeqCst);

    // Fire the attempt: transport re-establishes, `connection.list` no longer
    // reports remote-0 → session-lost, and no new session is created.
    scheduler.fire("tab-1");
    poll_until(
        || store.get("tab-1").map(|s| s.status) == Some(SessionStatus::SessionLost),
        "redrive folds session-lost when the live session is unrecoverable",
    );
    let life = store.get("tab-1").unwrap();
    assert_eq!(life.status, SessionStatus::SessionLost);
    assert_eq!(
        life.backend_session_id, None,
        "a lost session leaves no backend id to re-attach to"
    );
    assert_eq!(
        agent.create_count.load(Ordering::SeqCst),
        1,
        "session-lost must NOT mint a replacement shell — only the initial \
         create_session ran (#2512)"
    );
    assert!(
        !manager_ref.has_retained_request("tab-1"),
        "the terminal session-lost state scrubs the retained request"
    );
}

/// The **authoritative source-side** drop fold ([`EventEmitter::fold_session_drop`],
/// the exact call `SessionManager::emit_and_cleanup` makes at the `terminal-exit`
/// source) must ARM the backend reconnect timer for a resilient drop, so the
/// backend redrive drives the reconnect itself (#2476) rather than depending on
/// the client's `session.reconnect` mirror to start the loop. Regression guard:
/// before the fix the fold set the store to `Reconnecting` but left the timer
/// unarmed (only the `session.*` intent routes called `sync`), so a tab whose
/// client mirror did not reach the backend sat in `Reconnecting` forever with no
/// attempt ever driven. A terminal (`Dropped`) fold cancels any pending timer.
#[test]
fn source_side_resilient_drop_fold_arms_the_reconnect_timer() {
    use crate::session::manager::{DropFold, EventEmitter};

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.5));
    store.connect("tab-1");
    store.connected("tab-1");
    handle.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let projector = projection.projector.clone();
    let store_for_publish = store.clone();
    handle.manage(projection);

    let scheduler = Arc::new(ManualScheduler::default());
    let driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(move || {
            publish_sessions(&projector, &store_for_publish);
        }),
    ));
    handle.manage(driver);

    // A resilient drop at the source → store Reconnecting AND the timer armed.
    handle.fold_session_drop("tab-1", DropFold::Reconnect);
    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(SessionStatus::Reconnecting)
    );
    assert!(
        scheduler.armed("tab-1"),
        "the source-side resilient drop fold must arm the backend reconnect timer"
    );

    // A terminal drop at the source cancels any pending timer.
    handle.fold_session_drop("tab-1", DropFold::Dropped);
    assert!(
        !scheduler.armed("tab-1"),
        "a terminal (dropped) source fold cancels the reconnect timer"
    );
}
