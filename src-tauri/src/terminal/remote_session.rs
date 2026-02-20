//! Remote session backend — thin wrapper over AgentConnectionManager.
//!
//! Implements `TerminalBackend` for sessions running on a shared remote
//! agent connection. All I/O is routed through the agent's I/O thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::terminal::agent_manager::AgentConnectionManager;
use crate::terminal::backend::{OutputSender, RemoteSessionConfig, TerminalBackend};
use crate::utils::errors::TerminalError;

/// A terminal backend for sessions on a remote agent.
///
/// This is a thin wrapper that sends commands to the shared
/// `AgentConnectionManager` instead of owning its own SSH connection.
pub struct RemoteSessionBackend {
    agent_manager: Arc<AgentConnectionManager>,
    agent_id: String,
    remote_session_id: String,
    alive: Arc<AtomicBool>,
}

impl RemoteSessionBackend {
    /// Create a new remote session backend.
    ///
    /// This creates a session on the agent, attaches to it, and registers
    /// the output sender so that session output is routed correctly.
    pub fn new(
        config: &RemoteSessionConfig,
        output_tx: OutputSender,
        agent_manager: Arc<AgentConnectionManager>,
    ) -> Result<Self, TerminalError> {
        let agent_id = config.agent_id.clone();

        // Build session create params
        let session_config = match config.session_type.as_str() {
            "serial" => {
                let mut cfg = serde_json::json!({});
                if let Some(ref port) = config.serial_port {
                    cfg["port"] = serde_json::Value::String(port.clone());
                }
                if let Some(baud) = config.baud_rate {
                    cfg["baud_rate"] = serde_json::json!(baud);
                }
                if let Some(bits) = config.data_bits {
                    cfg["data_bits"] = serde_json::json!(bits);
                }
                if let Some(bits) = config.stop_bits {
                    cfg["stop_bits"] = serde_json::json!(bits);
                }
                if let Some(ref p) = config.parity {
                    cfg["parity"] = serde_json::Value::String(p.clone());
                }
                if let Some(ref fc) = config.flow_control {
                    cfg["flow_control"] = serde_json::Value::String(fc.clone());
                }
                cfg
            }
            "docker" => {
                let image = config.docker_image.as_deref().unwrap_or("ubuntu:22.04");

                let mut cfg = serde_json::json!({
                    "image": image,
                    "cols": 80,
                    "rows": 24,
                    "env": { "TERM": "xterm-256color" },
                    "remove_on_exit": config.docker_remove_on_exit.unwrap_or(true),
                });

                if let Some(ref shell) = config.shell {
                    cfg["shell"] = serde_json::Value::String(shell.clone());
                }
                if let Some(ref workdir) = config.docker_working_directory {
                    cfg["working_directory"] = serde_json::Value::String(workdir.clone());
                }
                if let Some(ref env_vars) = config.docker_env_vars {
                    cfg["env_vars"] = serde_json::json!(env_vars
                        .iter()
                        .map(|e| serde_json::json!({"key": e.key, "value": e.value}))
                        .collect::<Vec<_>>());
                }
                if let Some(ref volumes) = config.docker_volumes {
                    cfg["volumes"] = serde_json::json!(volumes
                        .iter()
                        .map(|v| serde_json::json!({
                            "host_path": v.host_path,
                            "container_path": v.container_path,
                            "read_only": v.read_only,
                        }))
                        .collect::<Vec<_>>());
                }

                cfg
            }
            "ssh" => {
                let host = config.ssh_host.as_ref().ok_or_else(|| {
                    TerminalError::SpawnFailed("SSH session requires ssh_host".to_string())
                })?;
                let username = config.ssh_username.as_ref().ok_or_else(|| {
                    TerminalError::SpawnFailed("SSH session requires ssh_username".to_string())
                })?;

                let mut cfg = serde_json::json!({
                    "host": host,
                    "username": username,
                    "auth_method": config.ssh_auth_method.as_deref().unwrap_or("agent"),
                    "cols": 80,
                    "rows": 24,
                    "env": { "TERM": "xterm-256color" },
                });

                if let Some(port) = config.ssh_port {
                    cfg["port"] = serde_json::json!(port);
                }
                if let Some(ref password) = config.ssh_password {
                    cfg["password"] = serde_json::Value::String(password.clone());
                }
                if let Some(ref key_path) = config.ssh_key_path {
                    cfg["key_path"] = serde_json::Value::String(key_path.clone());
                }
                if let Some(ref shell) = config.shell {
                    cfg["shell"] = serde_json::Value::String(shell.clone());
                }

                cfg
            }
            _ => {
                // Default to shell
                let mut cfg = serde_json::json!({
                    "cols": 80,
                    "rows": 24,
                    "env": { "TERM": "xterm-256color" }
                });
                if let Some(ref shell) = config.shell {
                    cfg["shell"] = serde_json::Value::String(shell.clone());
                }
                cfg
            }
        };

        // Create session on agent
        let session_info = agent_manager.create_session(
            &agent_id,
            &config.session_type,
            session_config,
            config.title.as_deref(),
        )?;

        let remote_session_id = session_info.session_id;

        // Register output sender
        agent_manager.register_session_output(&agent_id, &remote_session_id, output_tx)?;

        // Attach to session
        agent_manager.attach_session(&agent_id, &remote_session_id)?;

        Ok(Self {
            agent_manager,
            agent_id,
            remote_session_id,
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
}

impl TerminalBackend for RemoteSessionBackend {
    fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
        self.agent_manager
            .send_session_input(&self.agent_id, &self.remote_session_id, data)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        self.agent_manager
            .resize_session(&self.agent_id, &self.remote_session_id, cols, rows)
    }

    fn close(&self) -> Result<(), TerminalError> {
        self.alive.store(false, Ordering::SeqCst);
        // Detach and unregister output, but don't close the session on the agent
        // (it may be persistent and re-attachable)
        let _ = self
            .agent_manager
            .detach_session(&self.agent_id, &self.remote_session_id);
        let _ = self
            .agent_manager
            .unregister_session_output(&self.agent_id, &self.remote_session_id);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && self.agent_manager.is_connected(&self.agent_id)
    }
}
