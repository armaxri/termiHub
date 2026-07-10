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

use crate::utils::expand::expand_config_value;

pub use termihub_core::config::SshConfig;

/// Default install path for the agent binary on the remote host.
///
/// Uses `~/.local/bin` so setup works without privilege escalation.
const DEFAULT_AGENT_PATH: &str = "~/.local/bin/termihub-agent";

/// An external connection file configured for a remote agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalAgentFile {
    /// Absolute path on the remote host.
    pub path: String,
    pub enabled: bool,
}

/// Strategy governing how a shared remote agent binary is updated.
///
/// Only [`UpdateStrategy::Immediate`] has an implemented dispatch path today
/// (hard shutdown + redeploy). `Coordinated` (SI-5) and `Deferred` (SI-6) are
/// configuration-only until those subsystems land; selecting them currently
/// resolves back to `Immediate` at update time (see
/// [`RemoteAgentConfig::effective_update_strategy`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateStrategy {
    /// Shut the running agent down and redeploy immediately (the only path
    /// implemented today). Active sessions on other hosts are cut over hard.
    #[default]
    Immediate,
    /// Broadcast an update notice to connected hosts and wait for a clean
    /// disconnect before applying. Not yet implemented (SI-5).
    Coordinated,
    /// Defer the update until the last session disconnects. Not yet
    /// implemented (SI-6).
    Deferred,
}

/// SSH transport configuration for a remote agent (no session details).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_auth_method")]
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
    /// External connection files to load on the remote host.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub external_connection_files: Vec<ExternalAgentFile>,
    /// Whether the agent may check GitHub and update itself in the background.
    ///
    /// Opt-in (`false` by default). The self-update mechanism (SI-8) is not yet
    /// implemented; this flag persists the user's preference until it lands.
    #[serde(default)]
    pub allow_self_update: bool,
    /// How this agent's binary is updated when a newer desktop version deploys.
    ///
    /// Defaults to [`UpdateStrategy::Immediate`]. See
    /// [`RemoteAgentConfig::effective_update_strategy`] for how non-immediate
    /// strategies are currently resolved.
    #[serde(default)]
    pub update_strategy: UpdateStrategy,
}

fn default_auth_method() -> String {
    "password".to_string()
}

impl Default for RemoteAgentConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_method: default_auth_method(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
            external_connection_files: Vec::new(),
            allow_self_update: false,
            update_strategy: UpdateStrategy::default(),
        }
    }
}

/// Build a Windows agent invocation: `<path> <args>`.
///
/// A path containing a space is double-quoted (required by `cmd.exe`). A
/// space-free path is left unquoted so it runs as a command in both `cmd.exe`
/// and PowerShell (a quoted leading token in PowerShell is a string literal,
/// not a command). The default `%LOCALAPPDATA%` install path and resolved
/// space-free absolute paths therefore work regardless of the remote shell.
fn windows_agent_command(path: &str, args: &str) -> String {
    if path.contains(' ') {
        format!("\"{path}\" {args}")
    } else {
        format!("{path} {args}")
    }
}

impl RemoteAgentConfig {
    /// Return the agent binary path, defaulting to `~/.local/bin/termihub-agent`.
    pub fn agent_path(&self) -> &str {
        self.agent_path.as_deref().unwrap_or(DEFAULT_AGENT_PATH)
    }

    /// Build the shell command to launch the agent over SSH exec.
    ///
    /// On POSIX hosts, expands a leading `~/` to `$HOME/` so the command works
    /// in non-interactive SSH sessions where `~/.local/bin` is not on PATH.
    /// Windows paths are launched without `$HOME` expansion (see
    /// [`windows_agent_command`]).
    pub fn agent_exec_command(&self) -> String {
        let path = self.agent_path();
        // Opt the agent into its background GitHub self-update check only when
        // the connection enables it (#1355); off by default.
        let args = if self.allow_self_update {
            "--stdio --allow-self-update"
        } else {
            "--stdio"
        };
        if crate::terminal::agent_install::is_windows_path(path) {
            return windows_agent_command(path, args);
        }
        let resolved = if let Some(rest) = path.strip_prefix("~/") {
            format!("$HOME/{rest}")
        } else {
            path.to_string()
        };
        format!("{resolved} {args}")
    }

    /// Build the shell command to check the agent version on a remote host.
    ///
    /// POSIX hosts get the same `~/` → `$HOME/` expansion as
    /// [`agent_exec_command`] plus a `2>/dev/null` redirect. Windows hosts get
    /// a plain `--version` invocation with no POSIX redirect.
    pub fn agent_version_command(&self) -> String {
        let path = self.agent_path();
        if crate::terminal::agent_install::is_windows_path(path) {
            return windows_agent_command(path, "--version");
        }
        let resolved = if let Some(rest) = path.strip_prefix("~/") {
            format!("$HOME/{rest}")
        } else {
            path.to_string()
        };
        format!("{resolved} --version 2>/dev/null")
    }

    #[allow(dead_code)]
    pub fn expand(mut self) -> Self {
        self.host = expand_config_value(&self.host);
        self.username = expand_config_value(&self.username);
        self.key_path = self.key_path.map(|s| {
            // Strip surrounding quotes — users often paste paths like "C:\...\key"
            let stripped = s.trim().trim_matches('"').trim_matches('\'');
            expand_config_value(stripped)
        });
        self.password = self.password.map(|s| expand_config_value(&s));
        self
    }

    /// The update strategy that can actually be honored at update time today.
    ///
    /// Only [`UpdateStrategy::Immediate`] has an implemented dispatch path
    /// (hard shutdown + redeploy). `Coordinated` (SI-5) and `Deferred` (SI-6)
    /// have no dispatch path yet, so they fall back to `Immediate` — the
    /// configured preference is still persisted so it takes effect once those
    /// subsystems land. See #1354.
    pub fn effective_update_strategy(&self) -> UpdateStrategy {
        match self.update_strategy {
            UpdateStrategy::Immediate => UpdateStrategy::Immediate,
            // No coordinated/deferred dispatch path exists yet — fall back.
            UpdateStrategy::Coordinated | UpdateStrategy::Deferred => UpdateStrategy::Immediate,
        }
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
    /// Human-readable error description when state is "disconnected" after a
    /// failed reconnect, or when the initial connection cannot be established.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
            external_connection_files: vec![],
            ..Default::default()
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
        temp_env::with_vars(
            [
                ("TERMIHUB_TEST_AGENT_HOST", Some("10.0.0.99")),
                ("TERMIHUB_TEST_AGENT_USER", Some("deploy")),
            ],
            || {
                let config = RemoteAgentConfig {
                    host: "${TERMIHUB_TEST_AGENT_HOST}".to_string(),
                    port: 22,
                    username: "${TERMIHUB_TEST_AGENT_USER}".to_string(),
                    auth_method: "key".to_string(),
                    password: None,
                    key_path: Some("${HOME}/.ssh/id_rsa".to_string()),
                    save_password: None,
                    agent_path: None,
                    external_connection_files: vec![],
                    ..Default::default()
                };
                let expanded = config.expand();
                assert_eq!(expanded.host, "10.0.0.99");
                assert_eq!(expanded.username, "deploy");
            },
        );
    }

    #[test]
    fn remote_agent_config_expand_supports_dollar_brace_syntax() {
        temp_env::with_vars(
            [
                ("TERMIHUB_NEW_AGENT_HOST", Some("10.20.30.40")),
                ("TERMIHUB_NEW_AGENT_USER", Some("ops")),
            ],
            || {
                let config = RemoteAgentConfig {
                    host: "${TERMIHUB_NEW_AGENT_HOST}".to_string(),
                    port: 22,
                    username: "${TERMIHUB_NEW_AGENT_USER}".to_string(),
                    auth_method: "password".to_string(),
                    password: None,
                    key_path: None,
                    save_password: None,
                    agent_path: None,
                    external_connection_files: vec![],
                    ..Default::default()
                };
                let expanded = config.expand();
                assert_eq!(expanded.host, "10.20.30.40");
                assert_eq!(expanded.username, "ops");
            },
        );
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
        };
        assert_eq!(
            config.agent_exec_command(),
            "$HOME/.local/bin/termihub-agent --stdio"
        );
    }

    #[test]
    fn agent_exec_command_appends_self_update_flag_when_enabled() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            username: "pi".to_string(),
            allow_self_update: true,
            ..Default::default()
        };
        assert_eq!(
            config.agent_exec_command(),
            "$HOME/.local/bin/termihub-agent --stdio --allow-self-update"
        );
    }

    #[test]
    fn agent_exec_command_omits_self_update_flag_by_default() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            username: "pi".to_string(),
            ..Default::default()
        };
        // Default is off — no self-update flag on the command line.
        assert!(!config.agent_exec_command().contains("--allow-self-update"));
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
        };
        assert_eq!(
            config.agent_version_command(),
            "/opt/termihub-agent --version 2>/dev/null"
        );
    }

    /// Helper to build a config with a specific agent path for command tests.
    fn config_with_path(path: Option<&str>) -> RemoteAgentConfig {
        RemoteAgentConfig {
            host: "win.local".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: path.map(str::to_string),
            external_connection_files: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn agent_exec_command_windows_env_path_unquoted() {
        // A `%LOCALAPPDATA%` path has no spaces — emit it unquoted so it runs in
        // both cmd.exe and PowerShell, with no POSIX `$HOME` expansion.
        let config = config_with_path(Some(r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"));
        assert_eq!(
            config.agent_exec_command(),
            r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe --stdio"
        );
        assert!(!config.agent_exec_command().contains("$HOME"));
    }

    #[test]
    fn agent_exec_command_windows_absolute_path_with_space_is_quoted() {
        let config = config_with_path(Some(r"C:\Program Files\termiHub\termihub-agent.exe"));
        assert_eq!(
            config.agent_exec_command(),
            r#""C:\Program Files\termiHub\termihub-agent.exe" --stdio"#
        );
    }

    #[test]
    fn agent_version_command_windows_no_posix_redirect() {
        let config = config_with_path(Some(r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"));
        let cmd = config.agent_version_command();
        assert_eq!(
            cmd,
            r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe --version"
        );
        assert!(!cmd.contains("2>/dev/null"));
        assert!(!cmd.contains("$HOME"));
    }

    /// Regression: configs saved without `authMethod` (e.g. created by an old
    /// version) must deserialize successfully and default to "password".
    #[test]
    fn remote_agent_config_auth_method_defaults_to_password() {
        let json = r#"{
            "host": "pi.local",
            "port": 22,
            "username": "pi"
        }"#;
        let config: RemoteAgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.auth_method, "password");
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
                external_connection_files: vec![],
                ..Default::default()
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
            external_connection_files: vec![],
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v.get("agentPath").is_none(),
            "agentPath should be omitted when None, got: {json}"
        );
    }

    #[test]
    fn external_connection_files_serde_round_trip() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
            external_connection_files: vec![
                ExternalAgentFile {
                    path: "/home/pi/team-connections.json".to_string(),
                    enabled: true,
                },
                ExternalAgentFile {
                    path: "/home/pi/extra.json".to_string(),
                    enabled: false,
                },
            ],
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: RemoteAgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.external_connection_files.len(), 2);
        assert_eq!(
            deserialized.external_connection_files[0].path,
            "/home/pi/team-connections.json"
        );
        assert!(deserialized.external_connection_files[0].enabled);
        assert!(!deserialized.external_connection_files[1].enabled);
    }

    #[test]
    fn external_connection_files_empty_omitted_in_json() {
        let config = RemoteAgentConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: None,
            save_password: None,
            agent_path: None,
            external_connection_files: vec![],
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v.get("externalConnectionFiles").is_none(),
            "externalConnectionFiles should be omitted when empty, got: {json}"
        );
    }

    /// Configs saved before this field existed must deserialize successfully.
    #[test]
    fn external_connection_files_defaults_when_missing() {
        let json = r#"{"host":"pi.local","port":22,"username":"pi","authMethod":"key"}"#;
        let config: RemoteAgentConfig = serde_json::from_str(json).unwrap();
        assert!(config.external_connection_files.is_empty());
    }

    // ── Update strategy (#1354) ─────────────────────────────────────────

    #[test]
    fn update_strategy_defaults_to_immediate() {
        assert_eq!(UpdateStrategy::default(), UpdateStrategy::Immediate);
    }

    /// New fields must round-trip through save/load per agent.
    #[test]
    fn update_settings_serde_round_trip() {
        let config = RemoteAgentConfig {
            allow_self_update: true,
            update_strategy: UpdateStrategy::Deferred,
            ..RemoteAgentConfig::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: RemoteAgentConfig = serde_json::from_str(&json).unwrap();
        assert!(deserialized.allow_self_update);
        assert_eq!(deserialized.update_strategy, UpdateStrategy::Deferred);
    }

    /// The camelCase wire names must match the TS type + schema keys.
    #[test]
    fn update_settings_use_camel_case_wire_names() {
        let config = RemoteAgentConfig {
            allow_self_update: true,
            update_strategy: UpdateStrategy::Coordinated,
            ..RemoteAgentConfig::default()
        };
        let v: serde_json::Value = serde_json::to_value(&config).unwrap();
        assert_eq!(
            v.get("allowSelfUpdate").and_then(|b| b.as_bool()),
            Some(true)
        );
        assert_eq!(
            v.get("updateStrategy").and_then(|s| s.as_str()),
            Some("coordinated")
        );
    }

    /// Configs saved before these fields existed must deserialize with defaults:
    /// `update_strategy` = immediate, `allow_self_update` = false (opt-in).
    #[test]
    fn update_settings_default_when_missing_from_json() {
        let json = r#"{"host":"pi.local","port":22,"username":"pi","authMethod":"key"}"#;
        let config: RemoteAgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.update_strategy, UpdateStrategy::Immediate);
        assert!(!config.allow_self_update);
    }

    /// Only the immediate dispatch path exists today; coordinated/deferred fall
    /// back to it until SI-5/SI-6 land.
    #[test]
    fn effective_update_strategy_falls_back_to_immediate() {
        for requested in [
            UpdateStrategy::Immediate,
            UpdateStrategy::Coordinated,
            UpdateStrategy::Deferred,
        ] {
            let config = RemoteAgentConfig {
                update_strategy: requested,
                ..RemoteAgentConfig::default()
            };
            assert_eq!(
                config.effective_update_strategy(),
                UpdateStrategy::Immediate,
                "requested {requested:?} should currently resolve to Immediate"
            );
        }
    }
}
