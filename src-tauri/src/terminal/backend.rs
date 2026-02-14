use std::sync::mpsc;

use serde::{Deserialize, Serialize};

use crate::utils::expand::expand_env_placeholders;

/// Trait for all terminal backends (PTY, serial, SSH, telnet).
pub trait TerminalBackend: Send {
    /// Write user input to the terminal.
    fn write_input(&self, data: &[u8]) -> Result<(), crate::utils::errors::TerminalError>;

    /// Resize the terminal (no-op for serial/telnet).
    fn resize(&self, cols: u16, rows: u16) -> Result<(), crate::utils::errors::TerminalError>;

    /// Close the terminal session.
    fn close(&self) -> Result<(), crate::utils::errors::TerminalError>;

    /// Check if the terminal is still alive.
    fn is_alive(&self) -> bool;
}

/// A live terminal session with its backend and output channel.
pub struct TerminalSession {
    pub backend: Box<dyn TerminalBackend>,
    pub info: SessionInfo,
}

/// Information about an active session.
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub connection_type: String,
    pub alive: bool,
}

/// Output event emitted via Tauri events.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: Vec<u8>,
}

/// Exit event emitted when a terminal process exits.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

/// Connection configuration matching the frontend TypeScript types.
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
    #[serde(rename = "remote")]
    Remote(RemoteConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellConfig {
    pub shell_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    #[serde(default)]
    pub enable_x11_forwarding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// "shell" or "serial"
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
}

/// Event emitted when a remote connection's state changes.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteStateChangeEvent {
    pub session_id: String,
    pub state: String,
}

impl ConnectionConfig {
    /// Return a copy with all `${env:...}` placeholders expanded.
    pub fn expand(self) -> Self {
        match self {
            Self::Local(cfg) => Self::Local(cfg.expand()),
            Self::Ssh(cfg) => Self::Ssh(cfg.expand()),
            Self::Telnet(cfg) => Self::Telnet(cfg.expand()),
            Self::Serial(cfg) => Self::Serial(cfg.expand()),
            Self::Remote(cfg) => Self::Remote(cfg.expand()),
        }
    }
}

impl LocalShellConfig {
    pub fn expand(mut self) -> Self {
        self.initial_command = self.initial_command.map(|s| expand_env_placeholders(&s));
        self
    }
}

impl SshConfig {
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self.username = expand_env_placeholders(&self.username);
        self.key_path = self.key_path.map(|s| expand_env_placeholders(&s));
        self.password = self.password.map(|s| expand_env_placeholders(&s));
        self
    }
}

impl TelnetConfig {
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self
    }
}

impl SerialConfig {
    pub fn expand(mut self) -> Self {
        self.port = expand_env_placeholders(&self.port);
        self
    }
}

impl RemoteConfig {
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self.username = expand_env_placeholders(&self.username);
        self.key_path = self.key_path.map(|s| expand_env_placeholders(&s));
        self.password = self.password.map(|s| expand_env_placeholders(&s));
        self.shell = self.shell.map(|s| expand_env_placeholders(&s));
        self.serial_port = self.serial_port.map(|s| expand_env_placeholders(&s));
        self
    }

    /// Build an `SshConfig` from this remote config for SSH connection reuse.
    pub fn to_ssh_config(&self) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: self.auth_method.clone(),
            password: self.password.clone(),
            key_path: self.key_path.clone(),
            enable_x11_forwarding: false,
        }
    }
}

/// Channel sender type for output data from backends.
pub type OutputSender = mpsc::Sender<Vec<u8>>;
/// Channel receiver type for output data from backends (used in future phases).
#[allow(dead_code)]
pub type OutputReceiver = mpsc::Receiver<Vec<u8>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_config_local_serde_round_trip() {
        let config = ConnectionConfig::Local(LocalShellConfig {
            shell_type: "zsh".to_string(),
            initial_command: Some("echo hello".to_string()),
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Local(local) = deserialized {
            assert_eq!(local.shell_type, "zsh");
            assert_eq!(local.initial_command, Some("echo hello".to_string()));
        } else {
            panic!("Expected Local config");
        }
    }

    #[test]
    fn connection_config_ssh_serde_round_trip() {
        let config = ConnectionConfig::Ssh(SshConfig {
            host: "example.com".to_string(),
            port: 2222,
            username: "root".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("/home/user/.ssh/id_rsa".to_string()),
            enable_x11_forwarding: true,
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Ssh(ssh) = deserialized {
            assert_eq!(ssh.host, "example.com");
            assert_eq!(ssh.port, 2222);
            assert!(ssh.enable_x11_forwarding);
        } else {
            panic!("Expected SSH config");
        }
    }

    #[test]
    fn connection_config_serial_serde_round_trip() {
        let config = ConnectionConfig::Serial(SerialConfig {
            port: "/dev/ttyUSB0".to_string(),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".to_string(),
            flow_control: "hardware".to_string(),
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Serial(serial) = deserialized {
            assert_eq!(serial.baud_rate, 9600);
            assert_eq!(serial.flow_control, "hardware");
        } else {
            panic!("Expected Serial config");
        }
    }

    #[test]
    fn ssh_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_SSH_HOST", "192.168.1.100");
        std::env::set_var("TERMIHUB_TEST_SSH_USER", "deploy");

        let config = SshConfig {
            host: "${env:TERMIHUB_TEST_SSH_HOST}".to_string(),
            port: 22,
            username: "${env:TERMIHUB_TEST_SSH_USER}".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("${env:HOME}/.ssh/id_rsa".to_string()),
            enable_x11_forwarding: false,
        };
        let expanded = config.expand();
        assert_eq!(expanded.host, "192.168.1.100");
        assert_eq!(expanded.username, "deploy");

        std::env::remove_var("TERMIHUB_TEST_SSH_HOST");
        std::env::remove_var("TERMIHUB_TEST_SSH_USER");
    }

    #[test]
    fn local_config_expand_replaces_initial_command() {
        std::env::set_var("TERMIHUB_TEST_CMD", "make build");

        let config = LocalShellConfig {
            shell_type: "bash".to_string(),
            initial_command: Some("${env:TERMIHUB_TEST_CMD}".to_string()),
        };
        let expanded = config.expand();
        assert_eq!(expanded.initial_command, Some("make build".to_string()));

        std::env::remove_var("TERMIHUB_TEST_CMD");
    }

    #[test]
    fn telnet_config_expand_replaces_host() {
        std::env::set_var("TERMIHUB_TEST_TELNET_HOST", "10.0.0.1");

        let config = TelnetConfig {
            host: "${env:TERMIHUB_TEST_TELNET_HOST}".to_string(),
            port: 23,
        };
        let expanded = config.expand();
        assert_eq!(expanded.host, "10.0.0.1");

        std::env::remove_var("TERMIHUB_TEST_TELNET_HOST");
    }

    #[test]
    fn serial_config_expand_replaces_port() {
        std::env::set_var("TERMIHUB_TEST_SERIAL_PORT", "/dev/ttyACM0");

        let config = SerialConfig {
            port: "${env:TERMIHUB_TEST_SERIAL_PORT}".to_string(),
            baud_rate: 115200,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".to_string(),
            flow_control: "none".to_string(),
        };
        let expanded = config.expand();
        assert_eq!(expanded.port, "/dev/ttyACM0");

        std::env::remove_var("TERMIHUB_TEST_SERIAL_PORT");
    }

    #[test]
    fn connection_config_remote_serde_round_trip() {
        let config = ConnectionConfig::Remote(RemoteConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("/home/user/.ssh/id_rsa".to_string()),
            session_type: "shell".to_string(),
            shell: Some("/bin/bash".to_string()),
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
            title: Some("Build session".to_string()),
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Remote(remote) = deserialized {
            assert_eq!(remote.host, "pi.local");
            assert_eq!(remote.port, 22);
            assert_eq!(remote.username, "pi");
            assert_eq!(remote.session_type, "shell");
            assert_eq!(remote.shell, Some("/bin/bash".to_string()));
            assert_eq!(remote.title, Some("Build session".to_string()));
        } else {
            panic!("Expected Remote config");
        }
    }

    #[test]
    fn connection_config_remote_serial_serde_round_trip() {
        let config = ConnectionConfig::Remote(RemoteConfig {
            host: "pi.local".to_string(),
            port: 22,
            username: "pi".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            session_type: "serial".to_string(),
            shell: None,
            serial_port: Some("/dev/ttyUSB0".to_string()),
            baud_rate: Some(115200),
            data_bits: Some(8),
            stop_bits: Some(1),
            parity: Some("none".to_string()),
            flow_control: Some("none".to_string()),
            title: None,
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Remote(remote) = deserialized {
            assert_eq!(remote.session_type, "serial");
            assert_eq!(remote.serial_port, Some("/dev/ttyUSB0".to_string()));
            assert_eq!(remote.baud_rate, Some(115200));
        } else {
            panic!("Expected Remote config");
        }
    }

    #[test]
    fn remote_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_REMOTE_HOST", "10.0.0.50");
        std::env::set_var("TERMIHUB_TEST_REMOTE_USER", "admin");

        let config = RemoteConfig {
            host: "${env:TERMIHUB_TEST_REMOTE_HOST}".to_string(),
            port: 22,
            username: "${env:TERMIHUB_TEST_REMOTE_USER}".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("${env:HOME}/.ssh/id_rsa".to_string()),
            session_type: "shell".to_string(),
            shell: Some("${env:SHELL}".to_string()),
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
            title: None,
        };
        let expanded = config.expand();
        assert_eq!(expanded.host, "10.0.0.50");
        assert_eq!(expanded.username, "admin");

        std::env::remove_var("TERMIHUB_TEST_REMOTE_HOST");
        std::env::remove_var("TERMIHUB_TEST_REMOTE_USER");
    }

    #[test]
    fn remote_config_json_shape_matches_frontend() {
        let config = ConnectionConfig::Remote(RemoteConfig {
            host: "host".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            session_type: "shell".to_string(),
            shell: None,
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
            title: None,
        });
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "remote");
        assert_eq!(v["config"]["sessionType"], "shell");
        assert_eq!(v["config"]["authMethod"], "password");
    }
}
