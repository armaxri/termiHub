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
use crate::session_projection::store::{
    EndReason, SessionLifecycleStore, SessionStatus, TerminalExit, TerminalExitReason,
};
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
    /// Count of `attach_session` calls — the redrive's re-attach of the surviving
    /// live session goes through here (via `reconnect_existing`), so this proves a
    /// single reconnect performs exactly one re-attach and never double-attaches.
    attach_count: AtomicUsize,
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
            attach_count: AtomicUsize::new(0),
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
        self.attach_count.fetch_add(1, Ordering::SeqCst);
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
    // The re-arm is driven by the timer-driver reconcile that runs *after* the
    // store fold, so on a loaded runner the `Waiting` phase is observable a beat
    // before the re-arm lands. Wait for the observable re-arm instead of asserting
    // it is instantaneous (a bare `assert!` here raced — #2719); a timeout here
    // still fails the test, so this keeps proving the timer IS re-armed.
    poll_until(
        || scheduler.armed("tab-1"),
        "timer re-armed after failed attempt",
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
    let attaches_before = agent.attach_count.load(Ordering::SeqCst);
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
    assert_eq!(
        agent.attach_count.load(Ordering::SeqCst) - attaches_before,
        1,
        "a single reconnect must perform exactly one re-attach of the live session \
         (no double-attach)"
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

/// #2556: the **transient agent-transport-break** reconnecting lifecycle folded at
/// the backend source (`agent_io_task`), not via the frontend client mirror.
///
/// Drives the production `SessionManager` identity accessor + the two `agent_io_task`
/// fold helpers against the controllable `FakeAgent`, with the real
/// `ReconnectTimerDriver`, to prove:
///  1. the agent → desktop → tab identity resolution (`agent_hosted_sessions`);
///  2. the **enter** fold surfaces `Reconnecting` for every hosted session while the
///     reconnect loop stays `Idle` and **no redrive timer is armed** (the in-task
///     loop is the single owner of a transient break);
///  3. the **resolve** folds each recovered-in-place session back to `Connected`,
///     while a session the agent did NOT recover folds the terminal `SessionLost`
///     state at the backend source (#2564) — still no timer armed either way.
#[test]
fn transient_agent_break_folds_region_server_side_without_arming_the_timer() {
    use crate::terminal::agent_manager::{
        fold_agent_hosted_reconnecting, resolve_agent_hosted_sessions,
    };

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
    let driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(move || {
            publish_sessions(&projector, &store_for_publish);
        }),
    ));
    handle.manage(driver);

    // Two live agent-hosted sessions on `agent-1` (remote-0 → tab-1, remote-1 →
    // tab-2), each settled Connected as it would be after the initial connect.
    let manager_ref = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "config": {} });
    for (tab, connect) in [("tab-1", "tab-1:0"), ("tab-2", "tab-2:0")] {
        tauri::async_runtime::block_on(manager_ref.create_connection(
            "shell",
            settings.clone(),
            Some("agent-1"),
            Some(connect),
            false,
            true, // resilient
            handle.clone(),
        ))
        .expect("initial connect succeeds");
        store.connect(tab);
        store.connected(tab);
    }
    publish_sessions(&projector_seed, &store);

    // (1) The identity accessor resolves both hosted sessions' (remote, tab) pairs.
    let hosted = tauri::async_runtime::block_on(manager_ref.agent_hosted_sessions("agent-1"));
    let mut pairs: Vec<(String, String)> = hosted
        .iter()
        .map(|h| (h.remote_session_id.clone(), h.tab_id.clone()))
        .collect();
    pairs.sort();
    assert_eq!(
        pairs,
        vec![
            ("remote-0".to_string(), "tab-1".to_string()),
            ("remote-1".to_string(), "tab-2".to_string()),
        ],
        "the accessor maps each hosted agent session to its frontend tab id"
    );

    // (2) Enter: fold every hosted session Reconnecting at the source. Status-only,
    // loop Idle, and — crucially — the redrive timer is NOT armed for either tab.
    tauri::async_runtime::block_on(fold_agent_hosted_reconnecting(
        &handle,
        "agent-1",
        Some("connection reset"),
    ));
    for tab in ["tab-1", "tab-2"] {
        let life = store.get(tab).unwrap();
        assert_eq!(
            life.status,
            SessionStatus::Reconnecting,
            "{tab} folds Reconnecting on the transient break"
        );
        assert_eq!(
            life.reconnect.phase,
            ReconnectPhase::Idle,
            "{tab} keeps the reconnect loop Idle — the in-task loop owns the break"
        );
        assert_eq!(
            life.reconnect_error.as_deref(),
            Some("connection reset"),
            "{tab} records the trigger cause the overlay shows"
        );
        assert!(
            !scheduler.armed(tab),
            "{tab} must NOT arm the backend redrive for a transient break"
        );
    }

    // (3) Resolve: the agent recovered remote-0 (tab-1) in place but NOT remote-1
    // (tab-2). tab-1 folds back to Connected; tab-2 folds the terminal SessionLost
    // state at the backend source (#2564). No timer armed either way — a lost
    // session's loop is idle, so the timer reconcile is a cancel.
    let live_ids: std::collections::HashSet<String> =
        ["remote-0".to_string()].into_iter().collect();
    tauri::async_runtime::block_on(resolve_agent_hosted_sessions(&handle, &hosted, &live_ids));

    let recovered = store.get("tab-1").unwrap();
    assert_eq!(
        recovered.status,
        SessionStatus::Connected,
        "the recovered-in-place session folds back to Connected"
    );

    let lost = store.get("tab-2").unwrap();
    assert_eq!(
        lost.status,
        SessionStatus::SessionLost,
        "a session the agent did not recover folds SessionLost at the backend source (#2564)"
    );
    assert_eq!(
        lost.error.as_deref(),
        Some("the live agent session could not be recovered"),
        "the session-lost fold carries the same message the backend redrive uses"
    );
    assert!(
        lost.backend_session_id.is_none(),
        "the lost session clears its re-attach id — there is no live backend session"
    );
    assert_eq!(
        lost.reconnect.phase,
        ReconnectPhase::Idle,
        "SessionLost resets the reconnect loop to idle (no client-driven backoff)"
    );
    assert!(
        !scheduler.armed("tab-1") && !scheduler.armed("tab-2"),
        "no redrive timer is armed across the whole transient-break lifecycle"
    );
}

/// SM-002: a user Stop that races the agent-task in-place recovery must win — the
/// recover resolve must NOT silently resurrect a tab the user explicitly Stopped,
/// and it must tear the freshly recovered agent session down instead of adopting it.
///
/// Drives the production `SessionManager` + the enter fold + `cancel_reconnect`
/// (the Stop button's intent) + `resolve_agent_hosted_sessions`. Without the guard
/// the recover fold folds `Connected` unconditionally, resurrecting the Stopped tab
/// and re-adopting the session the user asked to abandon.
#[test]
fn user_cancel_wins_over_agent_recover_fold_and_tears_the_session_down() {
    use crate::terminal::agent_manager::{
        fold_agent_hosted_reconnecting, resolve_agent_hosted_sessions,
    };

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
    let projector_seed = projection.projector.clone();
    handle.manage(projection);

    // Two live resilient agent-hosted sessions on `agent-1` (remote-0 → tab-1,
    // remote-1 → tab-2), each settled Connected as after the initial connect.
    let manager_ref = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "config": {} });
    for (tab, connect) in [("tab-1", "tab-1:0"), ("tab-2", "tab-2:0")] {
        tauri::async_runtime::block_on(manager_ref.create_connection(
            "shell",
            settings.clone(),
            Some("agent-1"),
            Some(connect),
            false,
            true, // resilient
            handle.clone(),
        ))
        .expect("initial connect succeeds");
        store.connect(tab);
        store.connected(tab);
    }
    publish_sessions(&projector_seed, &store);

    let hosted = tauri::async_runtime::block_on(manager_ref.agent_hosted_sessions("agent-1"));

    // Transient break: both hosted tabs fold Reconnecting at the source.
    tauri::async_runtime::block_on(fold_agent_hosted_reconnecting(
        &handle,
        "agent-1",
        Some("connection reset"),
    ));

    // The user Stops tab-1 while the transport is still re-establishing: the Stop
    // button dispatches `session.cancelReconnect`, forcing Disconnected(User). tab-2
    // is left reconnecting (the control — the normal recovery path must be intact).
    store.cancel_reconnect("tab-1");
    assert_eq!(
        store.get("tab-1").unwrap().status,
        SessionStatus::Disconnected,
        "the Stop button folds the tab to Disconnected before the recovery lands"
    );

    // The agent then reports BOTH sessions recovered in place. The resolve must
    // honour the cancel for tab-1 (no resurrection + teardown) yet still fold tab-2
    // back to Connected.
    let live_ids: std::collections::HashSet<String> =
        ["remote-0".to_string(), "remote-1".to_string()]
            .into_iter()
            .collect();
    tauri::async_runtime::block_on(resolve_agent_hosted_sessions(&handle, &hosted, &live_ids));

    // tab-1: the user's Stop wins — the tab stays Disconnected(User), NOT Connected.
    let cancelled = store.get("tab-1").unwrap();
    assert_eq!(
        cancelled.status,
        SessionStatus::Disconnected,
        "a Stopped tab must NOT be silently resurrected to Connected by the recover fold (SM-002)"
    );
    assert_eq!(
        cancelled.end_reason,
        Some(EndReason::User),
        "the tab keeps the user-cancel reason — the Stop intent is preserved"
    );

    // The freshly recovered agent session for tab-1 is torn down, not adopted — it
    // no longer appears among the agent's hosted sessions.
    let remaining = tauri::async_runtime::block_on(manager_ref.agent_hosted_sessions("agent-1"));
    let tabs: Vec<&str> = remaining.iter().map(|h| h.tab_id.as_str()).collect();
    assert!(
        !tabs.contains(&"tab-1"),
        "the recovered session for the cancelled tab is torn down, not left alive"
    );

    // tab-2 (the control): the normal, non-cancelled recovery still folds Connected.
    assert_eq!(
        store.get("tab-2").unwrap().status,
        SessionStatus::Connected,
        "a non-cancelled recovered-in-place session still folds back to Connected"
    );
    assert!(
        tabs.contains(&"tab-2"),
        "the non-cancelled tab's session stays alive"
    );
}

/// #2612/#2564: the **fully-failed** resolve of the transient agent-transport-break
/// lifecycle — the agent's in-task reconnect loop exhausts its budget and the
/// transport cannot be re-established (`agent → disconnected`) — folded at the backend
/// source (`agent_io_task`), not left `Reconnecting` for the frontend `disconnected`
/// resolver.
///
/// Drives the production `SessionManager` identity accessor + the enter fold +
/// `fold_agent_hosted_reconnect_failed`, with the real `ReconnectTimerDriver`, to prove
/// every hosted session folds the terminal `Failed` state carrying the reconnect error,
/// clears its re-attach id, leaves the reconnect loop `Idle`, and arms **no** redrive
/// timer — the same authority the "Reconnect failed" overlay reads from the region.
#[test]
fn fully_failed_agent_break_folds_region_failed_at_the_source() {
    use crate::terminal::agent_manager::{
        fold_agent_hosted_reconnect_failed, fold_agent_hosted_reconnecting,
    };

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
    let driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(move || {
            publish_sessions(&projector, &store_for_publish);
        }),
    ));
    handle.manage(driver);

    // Two live agent-hosted sessions on `agent-1`, each Connected after initial connect.
    let manager_ref = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "config": {} });
    for (tab, connect) in [("tab-1", "tab-1:0"), ("tab-2", "tab-2:0")] {
        tauri::async_runtime::block_on(manager_ref.create_connection(
            "shell",
            settings.clone(),
            Some("agent-1"),
            Some(connect),
            false,
            true, // resilient
            handle.clone(),
        ))
        .expect("initial connect succeeds");
        store.connect(tab);
        store.connected(tab);
    }
    publish_sessions(&projector_seed, &store);

    // Enter: fold every hosted session Reconnecting at the source (the transient break).
    tauri::async_runtime::block_on(fold_agent_hosted_reconnecting(
        &handle,
        "agent-1",
        Some("connection reset"),
    ));
    for tab in ["tab-1", "tab-2"] {
        assert_eq!(
            store.get(tab).unwrap().status,
            SessionStatus::Reconnecting,
            "{tab} folds Reconnecting on the transient break"
        );
    }

    // Fully failed: the in-task reconnect loop exhausted its budget. Fold every hosted
    // session `Reconnecting → Failed` at the source with the reconnect error.
    tauri::async_runtime::block_on(fold_agent_hosted_reconnect_failed(
        &handle,
        "agent-1",
        "reconnection failed: connection refused",
    ));

    for tab in ["tab-1", "tab-2"] {
        let failed = store.get(tab).unwrap();
        assert_eq!(
            failed.status,
            SessionStatus::Failed,
            "{tab} folds the terminal Failed state at the backend source (#2612/#2564)"
        );
        assert_eq!(
            failed.error.as_deref(),
            Some("reconnection failed: connection refused"),
            "{tab} carries the reconnect error the overlay surfaces from the region"
        );
        assert!(
            failed.backend_session_id.is_none(),
            "{tab} clears its re-attach id — the transport is definitively gone"
        );
        assert_eq!(
            failed.reconnect.phase,
            ReconnectPhase::Idle,
            "{tab} resets the reconnect loop to idle (no client-driven backoff)"
        );
        assert!(
            !scheduler.armed(tab),
            "{tab} arms no redrive timer for a definitively-failed session"
        );
    }
}

/// SM-001 (state-machine-ux/0001): the **unconfirmed-session** resolve of the transient
/// agent-transport-break lifecycle — the agent re-established its transport, but the
/// post-reconnect `connection.list` never answered within the bounded retry budget, so
/// which hosted sessions survived cannot be confirmed.
///
/// This is the exact no-exit case the audit flagged: before the fix, the
/// `connection.list == None` branch did nothing, so every hosted tab stayed folded to
/// `Reconnecting` with the reconnect loop `Idle` — no timer armed (the backend timer arms
/// only on `Waiting`), no task driving it — a "Reconnecting… forever" state escapable only
/// by a manual Stop.
///
/// Drives the production `SessionManager` identity accessor + the enter fold +
/// [`resolve_hosted_sessions_after_reconnect`] with `live_ids == None` (the settle path
/// the `agent_io_task` reconnect loop now always takes when the list is unavailable),
/// against the real `ReconnectTimerDriver`, to prove every hosted session **leaves**
/// `Reconnecting` for the terminal `SessionLost` state, clears its re-attach id, resets the
/// reconnect loop to idle, and arms **no** timer — i.e. the machine can never sit stuck.
#[test]
fn unconfirmed_agent_break_settles_region_off_reconnecting_at_the_source() {
    use crate::terminal::agent_manager::{
        fold_agent_hosted_reconnecting, resolve_hosted_sessions_after_reconnect,
    };

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
    let driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(move || {
            publish_sessions(&projector, &store_for_publish);
        }),
    ));
    handle.manage(driver);

    // Two live agent-hosted sessions on `agent-1`, each Connected after initial connect.
    let manager_ref = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "config": {} });
    for (tab, connect) in [("tab-1", "tab-1:0"), ("tab-2", "tab-2:0")] {
        tauri::async_runtime::block_on(manager_ref.create_connection(
            "shell",
            settings.clone(),
            Some("agent-1"),
            Some(connect),
            false,
            true, // resilient
            handle.clone(),
        ))
        .expect("initial connect succeeds");
        store.connect(tab);
        store.connected(tab);
        store.set_backend_session_id(tab, Some(format!("backend-{tab}")));
    }
    publish_sessions(&projector_seed, &store);

    // Enter: fold every hosted session Reconnecting at the source (the transient break) —
    // loop Idle, so nothing is armed. This is the state the tab is stuck in on `develop`.
    tauri::async_runtime::block_on(fold_agent_hosted_reconnecting(
        &handle,
        "agent-1",
        Some("connection reset"),
    ));
    let hosted = tauri::async_runtime::block_on(manager_ref.agent_hosted_sessions("agent-1"));
    for tab in ["tab-1", "tab-2"] {
        let life = store.get(tab).unwrap();
        assert_eq!(
            life.status,
            SessionStatus::Reconnecting,
            "{tab} folds Reconnecting on the transient break"
        );
        assert_eq!(
            life.reconnect.phase,
            ReconnectPhase::Idle,
            "{tab} keeps the reconnect loop Idle — the in-task loop owns the break"
        );
        assert!(
            !scheduler.armed(tab),
            "{tab} arms no timer while Reconnecting(Idle) — the no-exit precondition"
        );
    }

    // Resolve with `live_ids == None`: the transport is back but `connection.list` never
    // answered after the bounded budget. Every hosted tab MUST leave `Reconnecting` for the
    // terminal `SessionLost` state (SM-001). Without the fix this call is a no-op and the
    // tabs below would still read `Reconnecting` — the stuck state.
    tauri::async_runtime::block_on(resolve_hosted_sessions_after_reconnect(
        &handle, &hosted, None,
    ));

    for tab in ["tab-1", "tab-2"] {
        let settled = store.get(tab).unwrap();
        assert_ne!(
            settled.status,
            SessionStatus::Reconnecting,
            "{tab} must not stay stuck Reconnecting when the session cannot be confirmed (SM-001)"
        );
        assert_eq!(
            settled.status,
            SessionStatus::SessionLost,
            "{tab} settles the terminal SessionLost state at the backend source (SM-001)"
        );
        assert_eq!(
            settled.error.as_deref(),
            Some("the agent session could not be confirmed after reconnect"),
            "{tab} carries the unconfirmed-session cause the overlay surfaces"
        );
        assert_eq!(
            settled.reconnect.phase,
            ReconnectPhase::Idle,
            "{tab} resets the reconnect loop to idle — a settled state, not a live loop"
        );
        assert!(
            settled.backend_session_id.is_none(),
            "{tab} clears its re-attach id — there is no confirmed live backend session"
        );
        assert!(
            !scheduler.armed(tab),
            "{tab} arms no timer after settling — the machine has reached a terminal state"
        );
    }
}

/// #2637: a **clean** process exit folds the coarse status to terminal
/// `Disconnected` (reason `Normal`) server-side, reconciling the real
/// `ReconnectTimerDriver`.
///
/// A clean exit is the one disconnect variant that fires no status intent
/// (`setTerminalExited(tab, { reason: "clean" })` mirrors only `session.exited`),
/// so before #2637 the ended state was inferred solely from `exit != null`. This
/// drives the two steps the production `session.exited` route performs for a clean
/// exit — `SessionLifecycleStore::set_exit` (the fold) then the timer `sync` the
/// route calls when the exit is clean — the same store + driver wiring the sibling
/// source-fold tests in this file use. It proves the fold makes the ended state
/// explicit: status `Disconnected` / `Normal`, the reconnect loop reset to idle,
/// the re-attach id dropped — and that a clean exit tears down any armed backoff
/// window. The published region carries exactly the fields the disconnect overlay
/// reads, with **no** `error` (so its "Reconnect failed" error variant never fires)
/// — byte-identical overlay-variant selection to the pre-fold representation.
#[test]
fn clean_exit_folds_status_disconnected_and_disarms_the_timer() {
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

    // Arm the reconnect timer via a genuine drop (the `session.reconnect` route's
    // two steps: fold Reconnecting, then sync the timer → Waiting arms the backoff).
    store.reconnect("tab-1");
    driver.sync("tab-1");
    assert_eq!(
        store.get("tab-1").map(|s| s.status),
        Some(SessionStatus::Reconnecting)
    );
    assert!(
        scheduler.armed("tab-1"),
        "a resilient reconnect arms the backoff timer"
    );

    // A clean exit: the `session.exited` route's steps for `reason == clean` — the
    // fold, then the timer sync the route now performs for a clean exit (#2637).
    store.set_exit(
        "tab-1",
        Some(TerminalExit {
            reason: TerminalExitReason::Clean,
            code: Some(0),
        }),
    );
    driver.sync("tab-1");

    let s = store.get("tab-1").unwrap();
    assert_eq!(
        s.status,
        SessionStatus::Disconnected,
        "a clean exit folds the coarse status explicitly (#2637)"
    );
    assert_eq!(s.end_reason, Some(EndReason::Normal));
    assert_eq!(
        s.reconnect.phase,
        ReconnectPhase::Idle,
        "a clean exit resets the reconnect loop to idle"
    );
    assert_eq!(
        s.error, None,
        "no error → the overlay's error variant never fires"
    );
    assert_eq!(s.exit.map(|e| e.reason), Some(TerminalExitReason::Clean));
    assert!(
        !scheduler.armed("tab-1"),
        "a clean exit tears down any armed reconnect backoff"
    );

    // The published region carries exactly the fields the overlay's variant
    // selection reads — the terminal `disconnected` status + the clean `exit` cause,
    // and crucially NO `error` field and NO live re-attach id.
    let snap = store.snapshot();
    let entry = &snap["sessions"]["tab-1"];
    assert_eq!(entry["status"], "disconnected");
    assert_eq!(entry["endReason"], "normal");
    assert_eq!(entry["exit"]["reason"], "clean");
    assert_eq!(entry["exit"]["code"], 0);
    assert!(
        entry.get("error").is_none(),
        "no error field is serialised for a clean exit"
    );
    assert!(
        entry.get("sessionId").is_none(),
        "the dead re-attach id is dropped from the region"
    );
}

/// #2637: a **dropped** exit stays a pure metadata write in `set_exit` — its status
/// is folded by the accompanying `session.dropped` intent, so `session.exited` must
/// NOT re-fold it (double-write) and the route performs no timer sync for it. Only
/// the clean variant folds status. Contrasts the clean-exit fold above.
#[test]
fn dropped_exit_is_pure_metadata_and_leaves_the_timer_untouched() {
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
    let _driver = Arc::new(ReconnectTimerDriver::new(
        store.clone(),
        scheduler.clone(),
        Arc::new(move || {
            publish_sessions(&projector, &store_for_publish);
        }),
    ));

    // A dropped exit records only the cause: status stays `Connected` (the
    // accompanying `session.dropped` intent owns the status fold), and — because the
    // route performs no sync for a non-clean exit — no timer arms.
    store.set_exit(
        "tab-1",
        Some(TerminalExit {
            reason: TerminalExitReason::Dropped,
            code: None,
        }),
    );

    let s = store.get("tab-1").unwrap();
    assert_eq!(
        s.status,
        SessionStatus::Connected,
        "a dropped exit does not fold status in `session.exited` (#2637)"
    );
    assert_eq!(s.end_reason, None);
    assert_eq!(s.exit.map(|e| e.reason), Some(TerminalExitReason::Dropped));
    assert!(
        !scheduler.armed("tab-1"),
        "a dropped exit's pure-metadata write arms no reconnect timer"
    );
}
