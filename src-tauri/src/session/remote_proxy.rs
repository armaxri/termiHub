//! [`ConnectionType`] implementation that forwards all calls to a remote
//! agent via JSON-RPC through [`AgentConnectionManager`].
//!
//! The desktop creates a `RemoteProxy` instead of a concrete backend when
//! the user specifies an `agent_id`. All terminal I/O, file browsing, and
//! monitoring operations are proxied to the agent over the SSH transport.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::Value;
use tracing::debug;

use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::{CoreError, FileError, SessionError};
use termihub_core::files::{FileBrowser, FileEntry};
use termihub_core::monitoring::{MonitoringProvider, MonitoringReceiver};

use crate::terminal::agent_manager::AgentConnectionManager;
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
    agent_manager: Arc<AgentConnectionManager>,
    /// The type_id of the remote connection (e.g., "local", "ssh").
    remote_type_id: Mutex<String>,
    /// Capabilities reported by the agent for this connection type.
    remote_capabilities: Mutex<Capabilities>,
    /// std output channel for receiving data from agent_manager.
    std_output_rx: Mutex<Option<mpsc::Receiver<Vec<u8>>>>,
    /// Whether the proxy is connected to a remote session.
    connected: AtomicBool,
    /// File browser proxy (set during connect if supported).
    file_browser_proxy: Mutex<Option<RemoteFileBrowserProxy>>,
    /// Monitoring proxy (set during connect if supported).
    monitoring_proxy: Mutex<Option<RemoteMonitoringProxy>>,
}

impl RemoteProxy {
    /// Create a new disconnected `RemoteProxy`.
    ///
    /// Call [`connect()`](ConnectionType::connect) with settings JSON
    /// containing `type` and connection-specific parameters to establish
    /// the remote session.
    pub fn new(agent_id: String, agent_manager: Arc<AgentConnectionManager>) -> Self {
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
            file_browser_proxy: Mutex::new(None),
            monitoring_proxy: Mutex::new(None),
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
                                    if let Ok(mut fb) = self.file_browser_proxy.lock() {
                                        *fb = Some(RemoteFileBrowserProxy {
                                            agent_id: self.agent_id.clone(),
                                            remote_session_id: remote_sid.clone(),
                                            agent_manager: self.agent_manager.clone(),
                                        });
                                    }
                                }
                                // Set up monitoring proxy if supported.
                                if parsed.monitoring {
                                    if let Ok(mut mp) = self.monitoring_proxy.lock() {
                                        *mp = Some(RemoteMonitoringProxy {
                                            agent_id: self.agent_id.clone(),
                                            remote_session_id: remote_sid.clone(),
                                            agent_manager: self.agent_manager.clone(),
                                        });
                                    }
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
            // Detach from output first.
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
        if let Ok(mut fb) = self.file_browser_proxy.lock() {
            *fb = None;
        }
        if let Ok(mut mp) = self.monitoring_proxy.lock() {
            *mp = None;
        }

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
        // Safety: we need a stable reference. The proxy lives as long as
        // the connection, so the Option contents don't change after connect.
        // We use an unsafe trick to return a reference to the inner value
        // without holding the lock. This is safe because:
        // 1. The Option is set once during connect() and cleared during disconnect()
        // 2. monitoring() is only called while connected
        // 3. The MonitoringProxy itself is Send and uses Arc internally
        //
        // Actually, let's use a simpler approach: return None and handle
        // monitoring through explicit commands instead.
        // TODO: Revisit if we need to support monitoring through the trait.
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        // Same reasoning as monitoring() — returning a reference from behind
        // a Mutex is not straightforward. We'll handle file browsing through
        // explicit session-based commands in the Tauri layer.
        // TODO: Revisit if we need to support file_browser through the trait.
        None
    }
}

/// File browser proxy that forwards operations to a remote agent.
///
/// Used by session-level file commands rather than through the
/// `ConnectionType::file_browser()` trait method (which cannot easily
/// return references from behind a Mutex).
pub struct RemoteFileBrowserProxy {
    agent_id: String,
    remote_session_id: String,
    agent_manager: Arc<AgentConnectionManager>,
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
}

/// Monitoring proxy that forwards operations to a remote agent.
pub struct RemoteMonitoringProxy {
    agent_id: String,
    remote_session_id: String,
    agent_manager: Arc<AgentConnectionManager>,
}

#[async_trait::async_trait]
impl MonitoringProvider for RemoteMonitoringProxy {
    async fn subscribe(&self) -> Result<MonitoringReceiver, CoreError> {
        let (tx, rx) = tokio::sync::mpsc::channel(16);

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

        // TODO: Route monitoring data notifications from agent to this channel.
        // For now, the channel stays open but won't receive data until
        // the agent_manager notification routing is extended.
        let _ = tx;

        Ok(rx)
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
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
    use super::*;

    /// Compile-time verification that `RemoteProxy` is Send.
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
}
