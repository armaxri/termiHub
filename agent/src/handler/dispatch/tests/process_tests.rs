//! `connection.processes.list` / `.kill` for agent-hosted sessions (#3210):
//! SSH, Docker and WSL sessions reach their own backend's process manager,
//! a session this client does not hold is refused, and every failure keeps
//! its JSON-RPC code.

use super::*;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use termihub_core::monitoring::{KillSignal, ProcessError, ProcessInfo, ProcessManager};

use crate::session::manager::SessionProcessError;

/// A per-session process manager standing in for a session backend's own
/// (an SSH exec, a `docker exec`, a `wsl.exe -d`).
struct FakeProcesses {
    host: String,
    kill_result: Result<(), ProcessError>,
    kills: StdMutex<Vec<(u32, KillSignal)>>,
}

impl FakeProcesses {
    fn new(host: &str) -> Arc<Self> {
        Arc::new(Self {
            host: host.to_string(),
            kill_result: Ok(()),
            kills: StdMutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl ProcessManager for FakeProcesses {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        Ok(vec![ProcessInfo {
            pid: 100,
            name: format!("{}-init", self.host),
            user: "root".into(),
            cpu_percent: 0.5,
            memory_percent: 0.1,
            memory_kb: None,
        }])
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        self.kills.lock().unwrap().push((pid, signal));
        self.kill_result.clone()
    }
}

type Resolution = Result<Arc<dyn ProcessManager + Send + Sync>, SessionProcessError>;

/// Session manager double whose process resolution is scripted per session.
struct ProcessSessionManager {
    registry: termihub_core::connection::ConnectionTypeRegistry,
    resolutions: StdMutex<HashMap<String, Resolution>>,
}

impl ProcessSessionManager {
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
impl SessionManagerApi for ProcessSessionManager {
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
    async fn session_process_manager(&self, session_id: &str) -> Resolution {
        self.resolutions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or(Err(SessionProcessError::Unknown))
    }
    async fn close(&self, _session_id: &str) -> bool {
        false
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

async fn handler_with(sessions: Arc<ProcessSessionManager>) -> AgentHandler {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!("termihub-proc-{}.json", uuid::Uuid::new_v4()));
    let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
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
    handler
}

fn list_params(session_id: &str) -> Value {
    json!({ "connection_id": session_id })
}

fn kill_params(session_id: &str, pid: u32, signal: &str) -> Value {
    json!({ "connection_id": session_id, "pid": pid, "signal": signal })
}

#[tokio::test]
async fn initialize_advertises_session_processes() {
    let handler = make_handler();
    let r = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(r["result"]["capabilities"]["sessionProcesses"], true, "{r}");
}

/// Each agent-hosted session type lists through its own backend — the table
/// shows that session's host, never the agent host's.
#[tokio::test]
async fn ssh_docker_and_wsl_sessions_list_their_own_processes() {
    let sessions = ProcessSessionManager::new();
    for host in ["ssh", "docker", "wsl"] {
        sessions.script(&format!("{host}-session"), Ok(FakeProcesses::new(host)));
    }
    let handler = handler_with(sessions).await;

    for host in ["ssh", "docker", "wsl"] {
        let r = dispatch(
            &handler,
            pm::CONNECTION_PROCESSES_LIST,
            list_params(&format!("{host}-session")),
            2,
        )
        .await;
        let listed: ProcessesListResult =
            serde_json::from_value(r["result"].clone()).unwrap_or_else(|e| panic!("{e}: {r}"));
        assert_eq!(listed.processes[0].name, format!("{host}-init"));
    }
}

#[tokio::test]
async fn kill_reaches_the_sessions_backend_with_the_exact_pid_and_signal() {
    let sessions = ProcessSessionManager::new();
    let docker = FakeProcesses::new("docker");
    let ssh = FakeProcesses::new("ssh");
    sessions.script("docker-session", Ok(docker.clone()));
    sessions.script("ssh-session", Ok(ssh.clone()));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_KILL,
        kill_params("docker-session", 321, "usr1"),
        2,
    )
    .await;
    assert!(r["result"].is_null(), "{r}");
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(*docker.kills.lock().unwrap(), vec![(321, KillSignal::Usr1)]);
    assert!(
        ssh.kills.lock().unwrap().is_empty(),
        "a kill never leaks into another session"
    );
}

#[tokio::test]
async fn an_unsupported_signal_is_reported_with_its_reason() {
    let sessions = ProcessSessionManager::new();
    let mut fake = FakeProcesses::new("wsl");
    Arc::get_mut(&mut fake).unwrap().kill_result = Err(ProcessError::UnsupportedSignal {
        signal: KillSignal::Stop,
        reason: "kill: invalid signal".into(),
    });
    sessions.script("wsl-session", Ok(fake));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_KILL,
        kill_params("wsl-session", 7, "stop"),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::PROCESS_OPERATION_FAILED, "{r}");
    let message = r["error"]["message"].as_str().unwrap();
    assert!(message.contains("SIGSTOP"), "{message}");
}

#[tokio::test]
async fn an_unknown_signal_name_is_invalid_params() {
    let sessions = ProcessSessionManager::new();
    sessions.script("ssh-session", Ok(FakeProcesses::new("ssh")));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_KILL,
        kill_params("ssh-session", 7, "sigsegv"),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{r}");
}

/// Ownership: a session this client does not hold (another desktop's, or one
/// it detached from) is refused for both list and kill, and no kill runs.
#[tokio::test]
async fn a_session_held_by_another_client_is_refused() {
    let sessions = ProcessSessionManager::new();
    sessions.script("theirs", Err(SessionProcessError::HeldElsewhere));
    let handler = handler_with(sessions).await;

    let list = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_LIST,
        list_params("theirs"),
        2,
    )
    .await;
    assert_eq!(
        list["error"]["code"],
        errors::SESSION_HELD_BY_OTHER,
        "{list}"
    );

    let kill = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_KILL,
        kill_params("theirs", 1, "kill"),
        3,
    )
    .await;
    assert_eq!(
        kill["error"]["code"],
        errors::SESSION_HELD_BY_OTHER,
        "{kill}"
    );
}

#[tokio::test]
async fn an_exited_session_is_not_running() {
    let sessions = ProcessSessionManager::new();
    sessions.script("gone", Err(SessionProcessError::Exited));
    let handler = handler_with(sessions).await;
    let r = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_LIST,
        list_params("gone"),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::SESSION_NOT_RUNNING, "{r}");
}

#[tokio::test]
async fn a_backend_without_processes_is_not_supported() {
    let sessions = ProcessSessionManager::new();
    sessions.script(
        "serial",
        Err(SessionProcessError::Unsupported("no processes".into())),
    );
    let handler = handler_with(sessions).await;
    let r = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_LIST,
        list_params("serial"),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::PROCESS_NOT_SUPPORTED, "{r}");
}

/// An id that is neither a session of this client nor a saved connection is
/// not found — it never falls back to the agent host's own process table.
#[tokio::test]
async fn an_unknown_id_is_not_found() {
    let handler = handler_with(ProcessSessionManager::new()).await;
    let r = dispatch(
        &handler,
        pm::CONNECTION_PROCESSES_KILL,
        kill_params("someone-elses-session", 1, "kill"),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::CONNECTION_NOT_FOUND, "{r}");
}
