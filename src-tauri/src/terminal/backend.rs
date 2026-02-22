//! Shared types used by the agent infrastructure (setup, deploy, manager).
//!
//! This module previously contained the `TerminalBackend` trait and per-type
//! config enums. Those have been replaced by the `ConnectionType` trait from
//! `termihub_core` and the unified `SessionManager` in `crate::session`.
//!
//! What remains here are the agent SSH transport config, channel constants,
//! and re-exports of core config types used across the desktop crate.

use std::sync::mpsc;

use serde::{Deserialize, Serialize};

use crate::utils::expand::{expand_env_placeholders, expand_tilde};

pub use termihub_core::config::{
    DockerConfig, EnvVar, SerialConfig, SshConfig, TelnetConfig, VolumeMount,
};

/// SSH transport configuration for a remote agent (no session details).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_password: Option<bool>,
}

impl RemoteAgentConfig {
    #[allow(dead_code)]
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self.username = expand_env_placeholders(&self.username);
        self.key_path = self.key_path.map(|s| {
            // Strip surrounding quotes — users often paste paths like "C:\...\key"
            let stripped = s.trim().trim_matches('"').trim_matches('\'');
            expand_tilde(&expand_env_placeholders(stripped))
        });
        self.password = self.password.map(|s| expand_env_placeholders(&s));
        self
    }

    /// Build an `SshConfig` from this agent config for SSH connection.
    pub fn to_ssh_config(&self) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: self.auth_method.clone(),
            password: self.password.clone(),
            key_path: self.key_path.clone(),
            save_password: self.save_password,
            ..SshConfig::default()
        }
    }
}

/// Connection configuration for saved connections (persistence format).
///
/// This tagged enum defines the on-disk JSON shape for saved connections.
/// It is no longer used at runtime for creating sessions — the new
/// `SessionManager` uses `type_id` + settings JSON via `ConnectionType`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "config")]
pub enum ConnectionConfig {
    #[serde(rename = "local")]
    Local(LocalShellConfig),
    #[serde(rename = "ssh")]
    Ssh(SshConfig),
    #[serde(rename = "telnet")]
    Telnet(TelnetConfig),
    #[serde(rename = "serial")]
    Serial(SerialConfig),
    #[serde(rename = "remote-session")]
    RemoteSession(Box<RemoteSessionConfig>),
    #[serde(rename = "docker")]
    Docker(DockerConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellConfig {
    pub shell_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starting_directory: Option<String>,
}

/// Session configuration for a session running on a remote agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionConfig {
    /// ID of the parent remote agent.
    pub agent_id: String,
    /// "shell" or "serial".
    pub session_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baud_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bits: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_bits: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_control: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Whether this session survives reconnection (re-attach vs recreate).
    #[serde(default)]
    pub persistent: bool,
    /// Docker image name (for docker session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_image: Option<String>,
    /// Docker environment variables (for docker session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_env_vars: Option<Vec<EnvVar>>,
    /// Docker volume mounts (for docker session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_volumes: Option<Vec<VolumeMount>>,
    /// Docker working directory (for docker session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_working_directory: Option<String>,
    /// Remove Docker container on exit (for docker session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_remove_on_exit: Option<bool>,
    /// SSH target host (for ssh session type — jump host).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    /// SSH target port (for ssh session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    /// SSH username (for ssh session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_username: Option<String>,
    /// SSH auth method: "key", "password", or "agent" (for ssh session type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_auth_method: Option<String>,
    /// SSH password (for ssh session type, password auth).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_password: Option<String>,
    /// SSH private key path (for ssh session type, key auth).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key_path: Option<String>,
}

/// Event emitted when a remote connection's state changes.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteStateChangeEvent {
    pub session_id: String,
    pub state: String,
}

impl ConnectionConfig {
    /// Return a copy with all `${env:...}` placeholders expanded.
    #[allow(dead_code)]
    pub fn expand(self) -> Self {
        match self {
            Self::Local(cfg) => Self::Local(cfg.expand()),
            Self::Ssh(cfg) => Self::Ssh(cfg.expand()),
            Self::Telnet(cfg) => Self::Telnet(cfg.expand()),
            Self::Serial(cfg) => Self::Serial(cfg.expand()),
            Self::RemoteSession(cfg) => Self::RemoteSession(Box::new(cfg.expand())),
            Self::Docker(cfg) => Self::Docker(cfg.expand()),
        }
    }
}

impl LocalShellConfig {
    #[allow(dead_code)]
    pub fn expand(mut self) -> Self {
        self.initial_command = self.initial_command.map(|s| expand_env_placeholders(&s));
        self.starting_directory = self
            .starting_directory
            .map(|s| expand_tilde(&expand_env_placeholders(&s)));
        self
    }
}

impl RemoteSessionConfig {
    #[allow(dead_code)]
    pub fn expand(mut self) -> Self {
        self.shell = self.shell.map(|s| expand_env_placeholders(&s));
        self.serial_port = self.serial_port.map(|s| expand_env_placeholders(&s));
        self.docker_image = self.docker_image.map(|s| expand_env_placeholders(&s));
        self.docker_working_directory = self
            .docker_working_directory
            .map(|s| expand_tilde(&expand_env_placeholders(&s)));
        self.ssh_host = self.ssh_host.map(|s| expand_env_placeholders(&s));
        self.ssh_username = self.ssh_username.map(|s| expand_env_placeholders(&s));
        self.ssh_key_path = self.ssh_key_path.map(|s| {
            let stripped = s.trim().trim_matches('"').trim_matches('\'');
            expand_tilde(&expand_env_placeholders(stripped))
        });
        self.ssh_password = self.ssh_password.map(|s| expand_env_placeholders(&s));
        self
    }
}

/// Bounded channel capacity for output data from backends.
/// Provides backpressure to prevent a fast-producing terminal from flooding memory.
pub const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Channel sender type for output data from backends (bounded, blocking when full).
pub type OutputSender = mpsc::SyncSender<Vec<u8>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_agent_config_serde_round_trip() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("/home/user/.ssh/id_rsa".to_string()),
            save_password: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: RemoteAgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.host, "pi.local");
        assert_eq!(deserialized.port, 22);
        assert_eq!(deserialized.username, "pi");
        assert_eq!(deserialized.auth_method, "key");
        assert_eq!(
            deserialized.key_path,
            Some("/home/user/.ssh/id_rsa".to_string())
        );
        assert!(deserialized.password.is_none());
    }

    #[test]
    fn remote_agent_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_AGENT_HOST", "10.0.0.99");
        std::env::set_var("TERMIHUB_TEST_AGENT_USER", "deploy");

        let config = RemoteAgentConfig {
            host: "${env:TERMIHUB_TEST_AGENT_HOST}".to_string(),
            port: 22,
            username: "${env:TERMIHUB_TEST_AGENT_USER}".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("${env:HOME}/.ssh/id_rsa".to_string()),
            save_password: None,
        };
        let expanded = config.expand();
        assert_eq!(expanded.host, "10.0.0.99");
        assert_eq!(expanded.username, "deploy");

        std::env::remove_var("TERMIHUB_TEST_AGENT_HOST");
        std::env::remove_var("TERMIHUB_TEST_AGENT_USER");
    }

    #[test]
    fn remote_agent_config_to_ssh_config() {
        let agent = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 2222,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("/home/.ssh/id_rsa".to_string()),
            save_password: None,
        };
        let ssh = agent.to_ssh_config();
        assert_eq!(ssh.host, "pi.local");
        assert_eq!(ssh.port, 2222);
        assert_eq!(ssh.username, "pi");
        assert_eq!(ssh.auth_method, "key");
        assert!(!ssh.enable_x11_forwarding);
    }

    #[test]
    fn remote_agent_config_save_password_serde_round_trip() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "password".to_string(),
            password: Some("secret".to_string()),
            key_path: None,
            save_password: Some(true),
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: RemoteAgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.save_password, Some(true));
    }

    #[test]
    fn remote_agent_config_save_password_none_omitted() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v.get("savePassword").is_none(),
            "savePassword should be omitted when None, got: {json}"
        );
    }

    #[test]
    fn remote_agent_config_to_ssh_config_copies_save_password() {
        let agent = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "password".to_string(),
            password: Some("secret".to_string()),
            key_path: None,
            save_password: Some(true),
        };
        let ssh = agent.to_ssh_config();
        assert_eq!(ssh.save_password, Some(true));
    }
}
