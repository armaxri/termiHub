//! Shared types used by the agent infrastructure (setup, deploy, manager).
//!
//! This module previously contained the `TerminalBackend` trait and per-type
//! config enums. Those have been replaced by the `ConnectionType` trait from
//! `termihub_core` and the unified `SessionManager` in `crate::session`.
//!
//! What remains here are the agent SSH transport config, channel constants,
//! the generic `ConnectionConfig` persistence struct, and re-exports of core
//! config types used across the desktop crate.

use std::sync::mpsc;

use serde::{Deserialize, Serialize};

use crate::utils::expand::{expand_env_placeholders, expand_tilde};

pub use termihub_core::config::SshConfig;

/// Default install path for the agent binary on the remote host.
///
/// Uses `~/.local/bin` so setup works without privilege escalation.
const DEFAULT_AGENT_PATH: &str = "~/.local/bin/termihub-agent";

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
    /// Path to the agent binary on the remote host.
    ///
    /// Defaults to `~/.local/bin/termihub-agent`. The `~` prefix is expanded
    /// to `$HOME` in SSH exec commands so it works in non-interactive sessions
    /// where `~/.local/bin` may not be on the PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
}

impl RemoteAgentConfig {
    /// Return the agent binary path, defaulting to `~/.local/bin/termihub-agent`.
    pub fn agent_path(&self) -> &str {
        self.agent_path.as_deref().unwrap_or(DEFAULT_AGENT_PATH)
    }

    /// Build the shell command to launch the agent over SSH exec.
    ///
    /// Expands a leading `~/` to `$HOME/` so the command works in
    /// non-interactive SSH sessions where `~/.local/bin` is not on PATH.
    pub fn agent_exec_command(&self) -> String {
        let path = self.agent_path();
        let resolved = if let Some(rest) = path.strip_prefix("~/") {
            format!("$HOME/{rest}")
        } else {
            path.to_string()
        };
        format!("{resolved} --stdio")
    }

    /// Build the shell command to check the agent version on a remote host.
    ///
    /// Same `~/` → `$HOME/` expansion as [`agent_exec_command`].
    pub fn agent_version_command(&self) -> String {
        let path = self.agent_path();
        let resolved = if let Some(rest) = path.strip_prefix("~/") {
            format!("$HOME/{rest}")
        } else {
            path.to_string()
        };
        format!("{resolved} --version 2>/dev/null")
    }

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

/// Generic connection configuration for saved connections (persistence format).
///
/// Stores the connection type as a plain string and the settings as
/// unstructured JSON. The on-disk format is `{"type": "<id>", "config": {...}}`
/// which is backward-compatible with the previous tagged-enum format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(rename = "config")]
    pub settings: serde_json::Value,
}

/// Event emitted when a remote connection's state changes.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteStateChangeEvent {
    pub session_id: String,
    pub state: String,
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
            agent_path: None,
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
            agent_path: None,
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
            agent_path: None,
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
            agent_path: None,
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
            agent_path: None,
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
            agent_path: None,
        };
        let ssh = agent.to_ssh_config();
        assert_eq!(ssh.save_password, Some(true));
    }

    #[test]
    fn connection_config_backward_compat_local() {
        let json = r#"{"type": "local", "config": {"shellType": "bash"}}"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.type_id, "local");
        assert_eq!(config.settings["shellType"], "bash");
    }

    #[test]
    fn connection_config_backward_compat_ssh() {
        let json = r#"{
            "type": "ssh",
            "config": {
                "host": "example.com",
                "port": 22,
                "username": "admin",
                "authMethod": "password",
                "enableX11Forwarding": false
            }
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.type_id, "ssh");
        assert_eq!(config.settings["host"], "example.com");
        assert_eq!(config.settings["port"], 22);
        assert_eq!(config.settings["username"], "admin");
    }

    #[test]
    fn connection_config_backward_compat_serial() {
        let json = r#"{
            "type": "serial",
            "config": {
                "port": "/dev/ttyUSB0",
                "baudRate": 115200,
                "dataBits": 8,
                "stopBits": 1,
                "parity": "none",
                "flowControl": "none"
            }
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.type_id, "serial");
        assert_eq!(config.settings["baudRate"], 115200);
    }

    #[test]
    fn connection_config_round_trip() {
        let config = ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({
                "host": "pi.local",
                "port": 22,
                "username": "pi",
                "authMethod": "key"
            }),
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.type_id, "ssh");
        assert_eq!(deserialized.settings["host"], "pi.local");
    }

    #[test]
    fn agent_exec_command_default_path() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
        };
        assert_eq!(
            config.agent_exec_command(),
            "$HOME/.local/bin/termihub-agent --stdio"
        );
    }

    #[test]
    fn agent_exec_command_custom_tilde_path() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: Some("~/bin/termihub-agent".to_string()),
        };
        assert_eq!(
            config.agent_exec_command(),
            "$HOME/bin/termihub-agent --stdio"
        );
    }

    #[test]
    fn agent_exec_command_absolute_path() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: Some("/usr/local/bin/termihub-agent".to_string()),
        };
        assert_eq!(
            config.agent_exec_command(),
            "/usr/local/bin/termihub-agent --stdio"
        );
    }

    #[test]
    fn agent_version_command_default_path() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
        };
        assert_eq!(
            config.agent_version_command(),
            "$HOME/.local/bin/termihub-agent --version 2>/dev/null"
        );
    }

    #[test]
    fn agent_version_command_absolute_path() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: Some("/opt/termihub-agent".to_string()),
        };
        assert_eq!(
            config.agent_version_command(),
            "/opt/termihub-agent --version 2>/dev/null"
        );
    }

    #[test]
    fn agent_path_defaults_when_missing_from_json() {
        let json = r#"{
            "host": "pi.local",
            "port": 22,
            "username": "pi",
            "authMethod": "key"
        }"#;
        let config: RemoteAgentConfig = serde_json::from_str(json).unwrap();
        assert!(config.agent_path.is_none());
        assert_eq!(config.agent_path(), "~/.local/bin/termihub-agent");
        assert_eq!(
            config.agent_exec_command(),
            "$HOME/.local/bin/termihub-agent --stdio"
        );
    }

    /// Regression test for #406: exec command must never be a bare command
    /// name — it must always contain a `/` (path separator) so it works in
    /// non-interactive SSH sessions where `~/.local/bin` is not on PATH.
    #[test]
    fn agent_exec_command_never_bare_name() {
        let configs = [
            // Default path (None)
            None,
            // Tilde path
            Some("~/bin/termihub-agent".to_string()),
            // Absolute path
            Some("/usr/local/bin/termihub-agent".to_string()),
        ];
        for agent_path in configs {
            let config = RemoteAgentConfig {
                host: "test".to_string(),
                port: 22,
                username: "test".to_string(),
                auth_method: "key".to_string(),
                password: None,
                key_path: None,
                save_password: None,
                agent_path,
            };
            let cmd = config.agent_exec_command();
            let binary = cmd.split_whitespace().next().unwrap();
            assert!(
                binary.contains('/'),
                "Exec command must use a full path, not a bare name. Got: {cmd}"
            );

            let ver_cmd = config.agent_version_command();
            let ver_binary = ver_cmd.split_whitespace().next().unwrap();
            assert!(
                ver_binary.contains('/'),
                "Version command must use a full path, not a bare name. Got: {ver_cmd}"
            );
        }
    }

    #[test]
    fn agent_path_none_omitted_in_json() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v.get("agentPath").is_none(),
            "agentPath should be omitted when None, got: {json}"
        );
    }
}
