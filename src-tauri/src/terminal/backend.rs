use std::sync::mpsc;

use serde::{Deserialize, Serialize};

use crate::utils::expand::{expand_env_placeholders, expand_tilde};

pub use termihub_core::config::{DockerConfig, EnvVar, SerialConfig, SshConfig, VolumeMount};

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

/// Error event emitted when a session-level error occurs after establishment.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalErrorEvent {
    pub session_id: String,
    pub message: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
}

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
    pub fn expand(mut self) -> Self {
        self.initial_command = self.initial_command.map(|s| expand_env_placeholders(&s));
        self.starting_directory = self
            .starting_directory
            .map(|s| expand_tilde(&expand_env_placeholders(&s)));
        self
    }
}

impl TelnetConfig {
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self
    }
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

impl RemoteSessionConfig {
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
/// Channel receiver type for output data from backends.
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
            starting_directory: Some("/home/user/projects".to_string()),
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Local(local) = deserialized {
            assert_eq!(local.shell_type, "zsh");
            assert_eq!(local.initial_command, Some("echo hello".to_string()));
            assert_eq!(
                local.starting_directory,
                Some("/home/user/projects".to_string())
            );
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
            key_path: Some("/home/user/.ssh/id_rsa".to_string()),
            enable_x11_forwarding: true,
            ..SshConfig::default()
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
            username: "${env:TERMIHUB_TEST_SSH_USER}".to_string(),
            auth_method: "key".to_string(),
            key_path: Some("${env:HOME}/.ssh/id_rsa".to_string()),
            ..SshConfig::default()
        };
        let expanded = config.expand();
        assert_eq!(expanded.host, "192.168.1.100");
        assert_eq!(expanded.username, "deploy");

        std::env::remove_var("TERMIHUB_TEST_SSH_HOST");
        std::env::remove_var("TERMIHUB_TEST_SSH_USER");
    }

    #[test]
    fn ssh_config_expand_expands_tilde_in_key_path() {
        let config = SshConfig {
            host: "example.com".to_string(),
            username: "user".to_string(),
            auth_method: "key".to_string(),
            key_path: Some("~/.ssh/id_ed25519".to_string()),
            ..SshConfig::default()
        };
        let expanded = config.expand();
        let key = expanded.key_path.unwrap();
        assert!(
            !key.starts_with('~'),
            "tilde should be expanded, got: {key}"
        );
        assert!(
            key.ends_with(".ssh/id_ed25519") || key.ends_with(r".ssh\id_ed25519"),
            "expected path ending in .ssh/id_ed25519, got: {key}"
        );
    }

    #[test]
    fn ssh_config_expand_strips_quotes_from_key_path() {
        let config = SshConfig {
            host: "example.com".to_string(),
            username: "user".to_string(),
            auth_method: "key".to_string(),
            key_path: Some(r#""C:\Users\me\.ssh\id_ed25519""#.to_string()),
            ..SshConfig::default()
        };
        let expanded = config.expand();
        let key = expanded.key_path.unwrap();
        assert!(!key.contains('"'), "quotes should be stripped, got: {key}");
        assert!(
            key.starts_with("C:"),
            "expected Windows path after stripping, got: {key}"
        );
    }

    #[test]
    fn local_config_expand_replaces_initial_command() {
        std::env::set_var("TERMIHUB_TEST_CMD", "make build");

        let config = LocalShellConfig {
            shell_type: "bash".to_string(),
            initial_command: Some("${env:TERMIHUB_TEST_CMD}".to_string()),
            starting_directory: None,
        };
        let expanded = config.expand();
        assert_eq!(expanded.initial_command, Some("make build".to_string()));

        std::env::remove_var("TERMIHUB_TEST_CMD");
    }

    #[test]
    fn local_config_expand_replaces_starting_directory() {
        std::env::set_var("TERMIHUB_TEST_DIR", "/tmp/projects");

        let config = LocalShellConfig {
            shell_type: "bash".to_string(),
            initial_command: None,
            starting_directory: Some("${env:TERMIHUB_TEST_DIR}".to_string()),
        };
        let expanded = config.expand();
        assert_eq!(
            expanded.starting_directory,
            Some("/tmp/projects".to_string())
        );

        std::env::remove_var("TERMIHUB_TEST_DIR");
    }

    #[test]
    fn local_config_expand_tilde_in_starting_directory() {
        let config = LocalShellConfig {
            shell_type: "zsh".to_string(),
            initial_command: None,
            starting_directory: Some("~/work".to_string()),
        };
        let expanded = config.expand();
        let dir = expanded.starting_directory.unwrap();
        assert!(
            dir.ends_with("/work"),
            "expected tilde expansion, got: {dir}"
        );
        assert!(
            !dir.starts_with('~'),
            "tilde should be expanded, got: {dir}"
        );
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
    fn remote_session_config_serde_round_trip() {
        let config = ConnectionConfig::RemoteSession(Box::new(RemoteSessionConfig {
            agent_id: "agent-123".to_string(),
            session_type: "shell".to_string(),
            shell: Some("/bin/bash".to_string()),
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
            title: Some("Build session".to_string()),
            persistent: true,
            docker_image: None,
            docker_env_vars: None,
            docker_volumes: None,
            docker_working_directory: None,
            docker_remove_on_exit: None,
            ssh_host: None,
            ssh_port: None,
            ssh_username: None,
            ssh_auth_method: None,
            ssh_password: None,
            ssh_key_path: None,
        }));
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::RemoteSession(session) = deserialized {
            assert_eq!(session.agent_id, "agent-123");
            assert_eq!(session.session_type, "shell");
            assert_eq!(session.shell, Some("/bin/bash".to_string()));
            assert_eq!(session.title, Some("Build session".to_string()));
            assert!(session.persistent);
        } else {
            panic!("Expected RemoteSession config");
        }
    }

    #[test]
    fn remote_session_config_serial_serde_round_trip() {
        let config = ConnectionConfig::RemoteSession(Box::new(RemoteSessionConfig {
            agent_id: "agent-456".to_string(),
            session_type: "serial".to_string(),
            shell: None,
            serial_port: Some("/dev/ttyUSB0".to_string()),
            baud_rate: Some(115200),
            data_bits: Some(8),
            stop_bits: Some(1),
            parity: Some("none".to_string()),
            flow_control: Some("none".to_string()),
            title: None,
            persistent: false,
            docker_image: None,
            docker_env_vars: None,
            docker_volumes: None,
            docker_working_directory: None,
            docker_remove_on_exit: None,
            ssh_host: None,
            ssh_port: None,
            ssh_username: None,
            ssh_auth_method: None,
            ssh_password: None,
            ssh_key_path: None,
        }));
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::RemoteSession(session) = deserialized {
            assert_eq!(session.session_type, "serial");
            assert_eq!(session.serial_port, Some("/dev/ttyUSB0".to_string()));
            assert_eq!(session.baud_rate, Some(115200));
            assert!(!session.persistent);
        } else {
            panic!("Expected RemoteSession config");
        }
    }

    #[test]
    fn remote_session_config_json_shape_matches_frontend() {
        let config = ConnectionConfig::RemoteSession(Box::new(RemoteSessionConfig {
            agent_id: "agent-1".to_string(),
            session_type: "shell".to_string(),
            shell: Some("/bin/zsh".to_string()),
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
            title: None,
            persistent: true,
            docker_image: None,
            docker_env_vars: None,
            docker_volumes: None,
            docker_working_directory: None,
            docker_remove_on_exit: None,
            ssh_host: None,
            ssh_port: None,
            ssh_username: None,
            ssh_auth_method: None,
            ssh_password: None,
            ssh_key_path: None,
        }));
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "remote-session");
        assert_eq!(v["config"]["agentId"], "agent-1");
        assert_eq!(v["config"]["sessionType"], "shell");
        assert_eq!(v["config"]["persistent"], true);
    }

    #[test]
    fn remote_session_config_persistent_defaults_to_false() {
        let json = r#"{
            "agentId": "agent-1",
            "sessionType": "shell",
            "persistent": false
        }"#;
        let config: RemoteSessionConfig = serde_json::from_str(json).unwrap();
        assert!(!config.persistent);

        // Also test when persistent is omitted (should default to false)
        let json_no_persistent = r#"{
            "agentId": "agent-1",
            "sessionType": "shell"
        }"#;
        let config2: RemoteSessionConfig = serde_json::from_str(json_no_persistent).unwrap();
        assert!(!config2.persistent);
    }

    #[test]
    fn remote_session_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_SESSION_SHELL", "/usr/bin/fish");

        let config = RemoteSessionConfig {
            agent_id: "agent-1".to_string(),
            session_type: "shell".to_string(),
            shell: Some("${env:TERMIHUB_TEST_SESSION_SHELL}".to_string()),
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
            title: None,
            persistent: false,
            docker_image: None,
            docker_env_vars: None,
            docker_volumes: None,
            docker_working_directory: None,
            docker_remove_on_exit: None,
            ssh_host: None,
            ssh_port: None,
            ssh_username: None,
            ssh_auth_method: None,
            ssh_password: None,
            ssh_key_path: None,
        };
        let expanded = config.expand();
        assert_eq!(expanded.shell, Some("/usr/bin/fish".to_string()));

        std::env::remove_var("TERMIHUB_TEST_SESSION_SHELL");
    }

    #[test]
    fn connection_config_docker_serde_round_trip() {
        let config = ConnectionConfig::Docker(DockerConfig {
            image: "ubuntu:22.04".to_string(),
            shell: Some("/bin/bash".to_string()),
            env_vars: vec![EnvVar {
                key: "TERM".to_string(),
                value: "xterm-256color".to_string(),
            }],
            volumes: vec![VolumeMount {
                host_path: "/home/user/project".to_string(),
                container_path: "/workspace".to_string(),
                read_only: false,
            }],
            working_directory: Some("/workspace".to_string()),
            ..DockerConfig::default()
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Docker(docker) = deserialized {
            assert_eq!(docker.image, "ubuntu:22.04");
            assert_eq!(docker.shell, Some("/bin/bash".to_string()));
            assert_eq!(docker.env_vars.len(), 1);
            assert_eq!(docker.env_vars[0].key, "TERM");
            assert_eq!(docker.volumes.len(), 1);
            assert_eq!(docker.volumes[0].host_path, "/home/user/project");
            assert_eq!(docker.volumes[0].container_path, "/workspace");
            assert!(!docker.volumes[0].read_only);
            assert_eq!(docker.working_directory, Some("/workspace".to_string()));
            assert!(docker.remove_on_exit);
        } else {
            panic!("Expected Docker config");
        }
    }

    #[test]
    fn docker_config_default_remove_on_exit() {
        let json = r#"{"image": "alpine"}"#;
        let config: DockerConfig = serde_json::from_str(json).unwrap();
        assert!(config.remove_on_exit);
        assert!(config.env_vars.is_empty());
        assert!(config.volumes.is_empty());
        assert!(config.shell.is_none());
        assert!(config.working_directory.is_none());
    }

    #[test]
    fn docker_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_DOCKER_IMAGE", "myapp");
        std::env::set_var("TERMIHUB_TEST_DOCKER_VAL", "production");

        let config = DockerConfig {
            image: "${env:TERMIHUB_TEST_DOCKER_IMAGE}:latest".to_string(),
            shell: Some("${env:TERMIHUB_TEST_DOCKER_IMAGE}".to_string()),
            env_vars: vec![EnvVar {
                key: "ENV".to_string(),
                value: "${env:TERMIHUB_TEST_DOCKER_VAL}".to_string(),
            }],
            working_directory: Some("${env:TERMIHUB_TEST_DOCKER_VAL}".to_string()),
            ..DockerConfig::default()
        };
        let expanded = config.expand();
        assert_eq!(expanded.image, "myapp:latest");
        assert_eq!(expanded.shell, Some("myapp".to_string()));
        assert_eq!(expanded.env_vars[0].value, "production");
        assert_eq!(expanded.working_directory, Some("production".to_string()));

        std::env::remove_var("TERMIHUB_TEST_DOCKER_IMAGE");
        std::env::remove_var("TERMIHUB_TEST_DOCKER_VAL");
    }

    #[test]
    fn docker_config_expand_tilde_in_volumes() {
        let config = DockerConfig {
            image: "ubuntu".to_string(),
            volumes: vec![VolumeMount {
                host_path: "~/projects".to_string(),
                container_path: "/workspace".to_string(),
                read_only: true,
            }],
            working_directory: Some("~/work".to_string()),
            remove_on_exit: false,
            ..DockerConfig::default()
        };
        let expanded = config.expand();
        assert!(
            !expanded.volumes[0].host_path.starts_with('~'),
            "tilde should be expanded in volume host path, got: {}",
            expanded.volumes[0].host_path
        );
        assert!(
            !expanded
                .working_directory
                .as_ref()
                .unwrap()
                .starts_with('~'),
            "tilde should be expanded in working directory"
        );
    }

    #[test]
    fn env_var_serde_round_trip() {
        let env = EnvVar {
            key: "FOO".to_string(),
            value: "bar".to_string(),
        };
        let json = serde_json::to_string(&env).unwrap();
        let deserialized: EnvVar = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.key, "FOO");
        assert_eq!(deserialized.value, "bar");
    }

    #[test]
    fn ssh_config_save_password_serde_round_trip() {
        let config = SshConfig {
            host: "example.com".to_string(),
            username: "user".to_string(),
            auth_method: "password".to_string(),
            password: Some("secret".to_string()),
            save_password: Some(true),
            ..SshConfig::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: SshConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.save_password, Some(true));
    }

    #[test]
    fn ssh_config_save_password_none_omitted_from_json() {
        let config = SshConfig {
            host: "example.com".to_string(),
            username: "user".to_string(),
            auth_method: "key".to_string(),
            ..SshConfig::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v.get("savePassword").is_none(),
            "savePassword should be omitted when None, got: {json}"
        );
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

    #[test]
    fn volume_mount_serde_round_trip() {
        let vol = VolumeMount {
            host_path: "/host/path".to_string(),
            container_path: "/container/path".to_string(),
            read_only: true,
        };
        let json = serde_json::to_string(&vol).unwrap();
        let deserialized: VolumeMount = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.host_path, "/host/path");
        assert_eq!(deserialized.container_path, "/container/path");
        assert!(deserialized.read_only);

        // Verify camelCase serialization
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v["hostPath"].is_string());
        assert!(v["containerPath"].is_string());
        assert!(v["readOnly"].is_boolean());
    }
}
