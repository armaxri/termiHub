//! [`ConnectionType`] implementation that forwards all calls to a remote
//! agent via JSON-RPC through [`AgentConnectionManager`].
//!
//! The desktop creates a `RemoteProxy` instead of a concrete backend when
//! the user specifies an `agent_id`. All terminal I/O, file browsing, and
//! monitoring operations are proxied to the agent over the SSH transport.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

// Note: `Mutex` is used only for fields that need interior mutability
// through `&self` (remote_session_id, remote_type_id, etc.).
// `file_browser_proxy` and `monitoring_proxy` use plain `Option` because
// they are only set in `connect(&mut self)` and cleared in
// `disconnect(&mut self)`, so mutable access is guaranteed.

use serde_json::Value;
use tracing::debug;

use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::{CoreError, FileError, SessionError};
use termihub_core::files::{FileBrowser, FileEntry};
use termihub_core::monitoring::{MonitoringProvider, MonitoringReceiver};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::terminal::backend::OUTPUT_CHANNEL_CAPACITY;

/// A [`ConnectionType`] implementation that proxies all operations to a
/// remote agent via JSON-RPC.
///
/// Created by the [`SessionManager`](super::manager::SessionManager) when
/// `agent_id` is provided during connection creation.
pub struct RemoteProxy {
    agent_id: String,
    /// The remote session ID assigned by the agent after `connection.create`.
    remote_session_id: Mutex<Option<String>>,
    agent_manager: Arc<dyn AgentRpcClient>,
    /// The type_id of the remote connection (e.g., "local", "ssh").
    remote_type_id: Mutex<String>,
    /// Capabilities reported by the agent for this connection type.
    remote_capabilities: Mutex<Capabilities>,
    /// std output channel for receiving data from agent_manager.
    std_output_rx: Mutex<Option<mpsc::Receiver<Vec<u8>>>>,
    /// Whether the proxy is connected to a remote session.
    connected: AtomicBool,
    /// File browser proxy (set during connect if supported).
    file_browser_proxy: Option<RemoteFileBrowserProxy>,
    /// Monitoring proxy (set during connect if supported).
    monitoring_proxy: Option<RemoteMonitoringProxy>,
}

impl RemoteProxy {
    /// Create a new disconnected `RemoteProxy`.
    ///
    /// Call [`connect()`](ConnectionType::connect) with settings JSON
    /// containing `type` and connection-specific parameters to establish
    /// the remote session.
    pub fn new(agent_id: String, agent_manager: Arc<dyn AgentRpcClient>) -> Self {
        Self {
            agent_id,
            remote_session_id: Mutex::new(None),
            agent_manager,
            remote_type_id: Mutex::new("remote".to_string()),
            remote_capabilities: Mutex::new(Capabilities {
                monitoring: false,
                file_browser: false,
                resize: true,
                persistent: false,
            }),
            std_output_rx: Mutex::new(None),
            connected: AtomicBool::new(false),
            file_browser_proxy: None,
            monitoring_proxy: None,
        }
    }

    fn agent_id(&self) -> &str {
        &self.agent_id
    }

    fn remote_session_id(&self) -> Option<String> {
        self.remote_session_id.lock().ok()?.clone()
    }
}

#[async_trait::async_trait]
impl ConnectionType for RemoteProxy {
    fn type_id(&self) -> &str {
        // Return a static string; callers wanting the actual remote type
        // should check session info.
        "remote"
    }

    fn display_name(&self) -> &str {
        "Remote"
    }

    fn settings_schema(&self) -> SettingsSchema {
        // Remote connections use the agent's schema, not a local one.
        SettingsSchema { groups: vec![] }
    }

    fn capabilities(&self) -> Capabilities {
        self.remote_capabilities
            .lock()
            .map(|c| c.clone())
            .unwrap_or(Capabilities {
                monitoring: false,
                file_browser: false,
                resize: true,
                persistent: false,
            })
    }

    async fn connect(&mut self, settings: Value) -> Result<(), SessionError> {
        if self.connected.load(Ordering::SeqCst) {
            return Err(SessionError::AlreadyExists(
                "Already connected to remote session".to_string(),
            ));
        }

        // Extract the remote connection type and config from settings.
        let session_type = settings
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("local")
            .to_string();

        let config = settings
            .get("config")
            .cloned()
            .unwrap_or_else(|| settings.clone());

        let title = settings
            .get("title")
            .and_then(|v| v.as_str())
            .map(String::from);

        // Store the remote type for metadata.
        if let Ok(mut t) = self.remote_type_id.lock() {
            *t = session_type.clone();
        }

        // Create the session on the agent.
        let session_info = self
            .agent_manager
            .create_session(self.agent_id(), &session_type, config, title.as_deref())
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let remote_sid = session_info.session_id.clone();

        // Set up output channel: std sync channel for agent_manager,
        // which we'll bridge to tokio in subscribe_output().
        let (std_tx, std_rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHANNEL_CAPACITY);

        // Register the output sender with the agent manager.
        self.agent_manager
            .register_session_output(self.agent_id(), &remote_sid, std_tx)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        // Attach to the session to start receiving output.
        self.agent_manager
            .attach_session(self.agent_id(), &remote_sid)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        // Store state.
        if let Ok(mut sid) = self.remote_session_id.lock() {
            *sid = Some(remote_sid.clone());
        }
        if let Ok(mut rx) = self.std_output_rx.lock() {
            *rx = Some(std_rx);
        }

        // Query capabilities from the agent for this session type.
        if let Ok(caps_result) = self.agent_manager.send_request(
            self.agent_id(),
            "connection.types",
            serde_json::json!({}),
        ) {
            if let Some(types) = caps_result.get("types").and_then(|v| v.as_array()) {
                for type_info in types {
                    if type_info.get("typeId").and_then(|v| v.as_str()) == Some(&session_type) {
                        if let Some(caps) = type_info.get("capabilities") {
                            if let Ok(parsed) = serde_json::from_value::<Capabilities>(caps.clone())
                            {
                                if let Ok(mut c) = self.remote_capabilities.lock() {
                                    *c = parsed.clone();
                                }
                                // Set up file browser proxy if supported.
                                if parsed.file_browser {
                                    self.file_browser_proxy = Some(RemoteFileBrowserProxy {
                                        agent_id: self.agent_id.clone(),
                                        remote_session_id: remote_sid.clone(),
                                        agent_manager: self.agent_manager.clone(),
                                    });
                                }
                                // Set up monitoring proxy if supported.
                                if parsed.monitoring {
                                    self.monitoring_proxy = Some(RemoteMonitoringProxy {
                                        agent_id: self.agent_id.clone(),
                                        remote_session_id: remote_sid.clone(),
                                        agent_manager: self.agent_manager.clone(),
                                    });
                                }
                            }
                        }
                        break;
                    }
                }
            }
        }

        self.connected.store(true, Ordering::SeqCst);
        debug!(
            agent_id = self.agent_id(),
            remote_session_id = %remote_sid,
            "Remote proxy connected"
        );

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        let remote_sid = self.remote_session_id();

        if let Some(ref sid) = remote_sid {
            // Unregister monitoring channel if monitoring was active.
            if self.monitoring_proxy.is_some() {
                let _ = self
                    .agent_manager
                    .unregister_monitoring_output(self.agent_id(), sid);
            }

            // Detach from output.
            let _ = self
                .agent_manager
                .unregister_session_output(self.agent_id(), sid);

            // Close the session on the agent.
            let _ = self.agent_manager.close_session(self.agent_id(), sid);
        }

        // Clear local state.
        if let Ok(mut sid) = self.remote_session_id.lock() {
            *sid = None;
        }
        if let Ok(mut rx) = self.std_output_rx.lock() {
            *rx = None;
        }
        self.file_browser_proxy = None;
        self.monitoring_proxy = None;

        self.connected.store(false, Ordering::SeqCst);
        debug!(agent_id = self.agent_id(), "Remote proxy disconnected");
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst) && self.agent_manager.is_connected(self.agent_id())
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let remote_sid = self
            .remote_session_id()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        self.agent_manager
            .send_session_input(self.agent_id(), &remote_sid, data)
            .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let remote_sid = self
            .remote_session_id()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        self.agent_manager
            .resize_session(self.agent_id(), &remote_sid, cols, rows)
            .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tokio_tx, tokio_rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);

        // Take the std receiver and bridge it to the tokio channel.
        let std_rx = self.std_output_rx.lock().ok().and_then(|mut r| r.take());

        if let Some(std_rx) = std_rx {
            std::thread::spawn(move || {
                while let Ok(data) = std_rx.recv() {
                    if tokio_tx.blocking_send(data).is_err() {
                        break;
                    }
                }
            });
        }

        tokio_rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        self.monitoring_proxy
            .as_ref()
            .map(|p| p as &dyn MonitoringProvider)
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        self.file_browser_proxy
            .as_ref()
            .map(|p| p as &dyn FileBrowser)
    }
}

/// File browser proxy that forwards operations to a remote agent.
///
/// Returned by `ConnectionType::file_browser()` on `RemoteProxy`.
pub struct RemoteFileBrowserProxy {
    agent_id: String,
    remote_session_id: String,
    agent_manager: Arc<dyn AgentRpcClient>,
}

#[async_trait::async_trait]
impl FileBrowser for RemoteFileBrowserProxy {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let result = self
            .agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.list",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;

        let entries = result
            .get("entries")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        serde_json::from_value(entries).map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let result = self
            .agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.read",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;

        let data_b64 = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
        base64_decode(data_b64)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        self.agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.write",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                    "data": encoded,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.delete",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.rename",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "from": from,
                    "to": to,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let result = self
            .agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.stat",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;

        serde_json::from_value(result).map_err(|e| FileError::OperationFailed(e.to_string()))
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.agent_manager
            .send_request(
                &self.agent_id,
                "connection.files.mkdir",
                serde_json::json!({
                    "connection_id": self.remote_session_id,
                    "path": path,
                }),
            )
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        Ok(())
    }
}

/// Monitoring proxy that forwards operations to a remote agent.
pub struct RemoteMonitoringProxy {
    agent_id: String,
    remote_session_id: String,
    agent_manager: Arc<dyn AgentRpcClient>,
}

#[async_trait::async_trait]
impl MonitoringProvider for RemoteMonitoringProxy {
    async fn subscribe(&self) -> Result<MonitoringReceiver, CoreError> {
        let (tx, rx) = tokio::sync::mpsc::channel(16);

        // Register monitoring channel so agent_manager routes notifications to it.
        self.agent_manager
            .register_monitoring_output(&self.agent_id, &self.remote_session_id, tx)
            .map_err(|e| CoreError::Other(e.to_string()))?;

        // Send subscribe request to agent.
        self.agent_manager
            .send_request(
                &self.agent_id,
                "connection.monitoring.subscribe",
                serde_json::json!({
                    "host": self.remote_session_id,
                    "interval_ms": 2000,
                }),
            )
            .map_err(|e| CoreError::Other(e.to_string()))?;

        Ok(rx)
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        // Unregister monitoring channel before telling the agent to stop.
        let _ = self
            .agent_manager
            .unregister_monitoring_output(&self.agent_id, &self.remote_session_id);

        self.agent_manager
            .send_request(
                &self.agent_id,
                "connection.monitoring.unsubscribe",
                serde_json::json!({
                    "host": self.remote_session_id,
                }),
            )
            .map_err(|e| CoreError::Other(e.to_string()))?;
        Ok(())
    }
}

/// Decode a base64 string to bytes.
fn base64_decode(input: &str) -> Result<Vec<u8>, FileError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| FileError::OperationFailed(format!("Base64 decode failed: {e}")))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::terminal::agent_manager::{
        AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
        AgentFolderInfo, AgentRpcClient, AgentSessionInfo,
    };
    use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
    use crate::utils::errors::TerminalError;
    use termihub_core::monitoring::MonitoringSender;

    // ── MockAgentRpcClient ────────────────────────────────────────────

    /// Minimal in-memory mock of `AgentRpcClient` for unit tests.
    ///
    /// `create_session` records calls and returns a canned session.
    /// All other mutating methods succeed silently. `is_connected` returns
    /// `true` once at least one `create_session` call has been recorded.
    struct MockAgentRpcClient {
        created_sessions: Mutex<Vec<(String, String, serde_json::Value)>>,
        send_request_result: Option<serde_json::Value>,
    }

    impl MockAgentRpcClient {
        fn new() -> Self {
            Self {
                created_sessions: Mutex::new(Vec::new()),
                send_request_result: None,
            }
        }
    }

    impl AgentRpcClient for MockAgentRpcClient {
        fn connect_agent(
            &self,
            _agent_id: &str,
            _config: &RemoteAgentConfig,
        ) -> Result<AgentConnectResult, TerminalError> {
            Ok(AgentConnectResult {
                capabilities: AgentCapabilities {
                    connection_types: vec![],
                    max_sessions: 10,
                    available_shells: vec![],
                    available_serial_ports: vec![],
                    docker_available: false,
                    available_docker_images: vec![],
                },
                agent_version: "mock".to_string(),
                protocol_version: "0.2.0".to_string(),
            })
        }

        fn disconnect_agent(&self, _agent_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }

        fn is_connected(&self, _agent_id: &str) -> bool {
            !self.created_sessions.lock().unwrap().is_empty()
        }

        fn get_capabilities(&self, _agent_id: &str) -> Option<AgentCapabilities> {
            None
        }

        fn shutdown_agent(
            &self,
            _agent_id: &str,
            _reason: Option<&str>,
        ) -> Result<u32, TerminalError> {
            Ok(0)
        }

        fn send_request(
            &self,
            _agent_id: &str,
            _method: &str,
            _params: serde_json::Value,
        ) -> Result<serde_json::Value, TerminalError> {
            Ok(self
                .send_request_result
                .clone()
                .unwrap_or(serde_json::Value::Null))
        }

        fn create_session(
            &self,
            agent_id: &str,
            session_type: &str,
            config: serde_json::Value,
            _title: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            self.created_sessions.lock().unwrap().push((
                agent_id.to_string(),
                session_type.to_string(),
                config,
            ));
            Ok(AgentSessionInfo {
                session_id: "mock-session-1".to_string(),
                title: "Mock Session".to_string(),
                session_type: session_type.to_string(),
                status: "running".to_string(),
                attached: false,
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
            Ok(vec![])
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

        fn list_definitions(
            &self,
            _agent_id: &str,
        ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            Ok(vec![])
        }

        fn save_definition(
            &self,
            _agent_id: &str,
            _definition: serde_json::Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            Ok(AgentDefinitionInfo {
                id: "mock-def".to_string(),
                name: "Mock".to_string(),
                session_type: "local".to_string(),
                config: serde_json::Value::Null,
                persistent: false,
                folder_id: None,
                terminal_options: None,
                icon: None,
            })
        }

        fn update_definition(
            &self,
            _agent_id: &str,
            _params: serde_json::Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            Ok(AgentDefinitionInfo {
                id: "mock-def".to_string(),
                name: "Updated".to_string(),
                session_type: "local".to_string(),
                config: serde_json::Value::Null,
                persistent: false,
                folder_id: None,
                terminal_options: None,
                icon: None,
            })
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
            Ok(AgentFolderInfo {
                id: "mock-folder".to_string(),
                name: "Mock Folder".to_string(),
                parent_id: None,
                is_expanded: false,
            })
        }

        fn update_folder(
            &self,
            _agent_id: &str,
            _params: serde_json::Value,
        ) -> Result<AgentFolderInfo, TerminalError> {
            Ok(AgentFolderInfo {
                id: "mock-folder".to_string(),
                name: "Updated Folder".to_string(),
                parent_id: None,
                is_expanded: false,
            })
        }

        fn delete_folder(&self, _agent_id: &str, _folder_id: &str) -> Result<(), TerminalError> {
            Ok(())
        }

        fn register_session_output(
            &self,
            _agent_id: &str,
            _remote_session_id: &str,
            _output_tx: OutputSender,
        ) -> Result<(), TerminalError> {
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
    }

    fn make_proxy() -> RemoteProxy {
        RemoteProxy::new("agent-1".to_string(), Arc::new(MockAgentRpcClient::new()))
    }

    // ── Compile-time trait checks ─────────────────────────────────────

    fn _assert_send<T: Send>() {}

    #[test]
    fn remote_proxy_is_send() {
        _assert_send::<RemoteProxy>();
    }

    #[test]
    fn remote_file_browser_proxy_is_send() {
        _assert_send::<RemoteFileBrowserProxy>();
    }

    #[test]
    fn remote_monitoring_proxy_is_send() {
        _assert_send::<RemoteMonitoringProxy>();
    }

    fn _assert_file_browser_compiles(proxy: &RemoteProxy) {
        let _: Option<&dyn FileBrowser> = proxy.file_browser();
        let _: Option<&dyn MonitoringProvider> = proxy.monitoring();
    }

    // ── Behaviour tests using MockAgentRpcClient ──────────────────────

    #[test]
    fn new_proxy_is_not_connected() {
        let proxy = make_proxy();
        assert!(!proxy.is_connected());
    }

    #[tokio::test]
    async fn connect_calls_create_and_attach_session() {
        let mock = Arc::new(MockAgentRpcClient::new());
        let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());

        let settings = json!({ "type": "local", "config": {} });
        proxy
            .connect(settings)
            .await
            .expect("connect should succeed");

        let sessions = mock.created_sessions.lock().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].0, "agent-1");
        assert_eq!(sessions[0].1, "local");
    }

    #[tokio::test]
    async fn connect_twice_returns_error() {
        let mut proxy = make_proxy();
        let settings = json!({ "type": "local", "config": {} });
        proxy
            .connect(settings.clone())
            .await
            .expect("first connect");
        let result = proxy.connect(settings).await;
        assert!(result.is_err(), "second connect should fail");

        proxy.disconnect().await.ok();
    }

    #[tokio::test]
    async fn disconnect_clears_connected_state() {
        let mut proxy = make_proxy();
        let settings = json!({ "type": "local", "config": {} });
        proxy.connect(settings).await.expect("connect");

        proxy.disconnect().await.expect("disconnect");

        // is_connected checks both local flag and mock.is_connected()
        // After disconnect the local flag is false.
        assert!(!proxy.is_connected());
    }

    #[tokio::test]
    async fn write_after_connect_succeeds() {
        let mut proxy = make_proxy();
        proxy
            .connect(json!({ "type": "local", "config": {} }))
            .await
            .expect("connect");

        let result = proxy.write(b"hello");
        assert!(result.is_ok());

        proxy.disconnect().await.ok();
    }

    #[tokio::test]
    async fn resize_after_connect_succeeds() {
        let mut proxy = make_proxy();
        proxy
            .connect(json!({ "type": "local", "config": {} }))
            .await
            .expect("connect");

        let result = proxy.resize(120, 40);
        assert!(result.is_ok());

        proxy.disconnect().await.ok();
    }

    #[test]
    fn write_before_connect_returns_error() {
        let proxy = make_proxy();
        assert!(proxy.write(b"data").is_err());
    }

    #[test]
    fn resize_before_connect_returns_error() {
        let proxy = make_proxy();
        assert!(proxy.resize(80, 24).is_err());
    }
}
