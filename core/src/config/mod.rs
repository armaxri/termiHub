pub mod expand;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Terminal dimensions (columns x rows).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PtySize {
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

impl Default for PtySize {
    fn default() -> Self {
        Self {
            cols: default_cols(),
            rows: default_rows(),
        }
    }
}

/// A key-value pair for environment variables.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// A Docker volume mount definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeMount {
    pub host_path: String,
    pub container_path: String,
    #[serde(default)]
    pub read_only: bool,
}

/// Unified shell session configuration.
///
/// Superset of desktop `LocalShellConfig` and agent `ShellConfig`.
/// - `shell`: shell executable path or name; `None` means auto-detect.
/// - `cols`/`rows`: terminal dimensions (defaults 80x24).
/// - `env`: additional environment variables for the shell process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellConfig {
    pub shell: Option<String>,
    pub initial_command: Option<String>,
    pub starting_directory: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            shell: None,
            initial_command: None,
            starting_directory: None,
            cols: default_cols(),
            rows: default_rows(),
            env: HashMap::new(),
        }
    }
}

/// Unified serial port configuration.
///
/// Shared between desktop and agent serial backends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port: String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_flow_control")]
    pub flow_control: String,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port: String::new(),
            baud_rate: default_baud_rate(),
            data_bits: default_data_bits(),
            stop_bits: default_stop_bits(),
            parity: default_parity(),
            flow_control: default_flow_control(),
        }
    }
}

/// Unified Docker container session configuration.
///
/// Superset of desktop `DockerConfig` and agent `DockerSessionConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerConfig {
    pub image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env_vars: Vec<EnvVar>,
    #[serde(default)]
    pub volumes: Vec<VolumeMount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default = "default_remove_on_exit")]
    pub remove_on_exit: bool,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl Default for DockerConfig {
    fn default() -> Self {
        Self {
            image: String::new(),
            shell: None,
            cols: default_cols(),
            rows: default_rows(),
            env_vars: Vec::new(),
            volumes: Vec::new(),
            working_directory: None,
            remove_on_exit: default_remove_on_exit(),
            env: HashMap::new(),
        }
    }
}

/// Unified SSH session configuration.
///
/// Superset of desktop `SshConfig` and agent `SshSessionConfig`.
/// - `port`: defaults to 22.
/// - `cols`/`rows`: terminal dimensions (defaults 80x24).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub enable_x11_forwarding: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_monitoring: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_file_browser: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_password: Option<bool>,
}

impl Default for SshConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: default_ssh_port(),
            username: String::new(),
            auth_method: String::new(),
            password: None,
            key_path: None,
            shell: None,
            cols: default_cols(),
            rows: default_rows(),
            env: HashMap::new(),
            enable_x11_forwarding: false,
            enable_monitoring: None,
            enable_file_browser: None,
            save_password: None,
        }
    }
}

// --- Expand methods ---

impl SerialConfig {
    /// Return a copy with all `${env:...}` placeholders expanded.
    pub fn expand(mut self) -> Self {
        self.port = expand::expand_env_placeholders(&self.port);
        self
    }
}

impl SshConfig {
    /// Return a copy with all `${env:...}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.host = expand::expand_env_placeholders(&self.host);
        self.username = expand::expand_env_placeholders(&self.username);
        self.key_path = self.key_path.map(|s| {
            // Strip surrounding quotes — users often paste paths like "C:\...\key"
            let stripped = s.trim().trim_matches('"').trim_matches('\'');
            expand::expand_tilde(&expand::expand_env_placeholders(stripped))
        });
        self.password = self.password.map(|s| expand::expand_env_placeholders(&s));
        self
    }
}

impl DockerConfig {
    /// Return a copy with all `${env:...}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.image = expand::expand_env_placeholders(&self.image);
        self.shell = self.shell.map(|s| expand::expand_env_placeholders(&s));
        self.working_directory = self
            .working_directory
            .map(|s| expand::expand_tilde(&expand::expand_env_placeholders(&s)));
        for env in &mut self.env_vars {
            env.key = expand::expand_env_placeholders(&env.key);
            env.value = expand::expand_env_placeholders(&env.value);
        }
        for vol in &mut self.volumes {
            vol.host_path = expand::expand_tilde(&expand::expand_env_placeholders(&vol.host_path));
            vol.container_path = expand::expand_env_placeholders(&vol.container_path);
        }
        self
    }
}

// --- Default value functions ---

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

fn default_baud_rate() -> u32 {
    115200
}

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> u8 {
    1
}

fn default_parity() -> String {
    "none".to_string()
}

fn default_flow_control() -> String {
    "none".to_string()
}

fn default_remove_on_exit() -> bool {
    true
}

fn default_ssh_port() -> u16 {
    22
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Default value tests ---

    #[test]
    fn pty_size_default() {
        let size = PtySize::default();
        assert_eq!(size.cols, 80);
        assert_eq!(size.rows, 24);
    }

    #[test]
    fn shell_config_default() {
        let cfg = ShellConfig::default();
        assert!(cfg.shell.is_none());
        assert!(cfg.initial_command.is_none());
        assert!(cfg.starting_directory.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn serial_config_default() {
        let cfg = SerialConfig::default();
        assert!(cfg.port.is_empty());
        assert_eq!(cfg.baud_rate, 115200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, "none");
        assert_eq!(cfg.flow_control, "none");
    }

    #[test]
    fn docker_config_default() {
        let cfg = DockerConfig::default();
        assert!(cfg.image.is_empty());
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env_vars.is_empty());
        assert!(cfg.volumes.is_empty());
        assert!(cfg.working_directory.is_none());
        assert!(cfg.remove_on_exit);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn ssh_config_default() {
        let cfg = SshConfig::default();
        assert!(cfg.host.is_empty());
        assert_eq!(cfg.port, 22);
        assert!(cfg.username.is_empty());
        assert!(cfg.auth_method.is_empty());
        assert!(cfg.password.is_none());
        assert!(cfg.key_path.is_none());
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
        assert!(!cfg.enable_x11_forwarding);
        assert!(cfg.enable_monitoring.is_none());
        assert!(cfg.enable_file_browser.is_none());
        assert!(cfg.save_password.is_none());
    }

    // --- Serde round-trip tests ---

    #[test]
    fn pty_size_roundtrip() {
        let size = PtySize {
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&size).unwrap();
        let back: PtySize = serde_json::from_str(&json).unwrap();
        assert_eq!(back.cols, 120);
        assert_eq!(back.rows, 40);
    }

    #[test]
    fn env_var_roundtrip() {
        let var = EnvVar {
            key: "TERM".into(),
            value: "xterm-256color".into(),
        };
        let json = serde_json::to_string(&var).unwrap();
        let back: EnvVar = serde_json::from_str(&json).unwrap();
        assert_eq!(back.key, "TERM");
        assert_eq!(back.value, "xterm-256color");
    }

    #[test]
    fn volume_mount_roundtrip() {
        let vol = VolumeMount {
            host_path: "/host/data".into(),
            container_path: "/data".into(),
            read_only: true,
        };
        let json = serde_json::to_string(&vol).unwrap();
        let back: VolumeMount = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host_path, "/host/data");
        assert_eq!(back.container_path, "/data");
        assert!(back.read_only);
    }

    #[test]
    fn shell_config_roundtrip() {
        let cfg = ShellConfig {
            shell: Some("/bin/zsh".into()),
            initial_command: Some("ls".into()),
            starting_directory: Some("/home/user".into()),
            cols: 100,
            rows: 30,
            env: HashMap::from([("FOO".into(), "bar".into())]),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: ShellConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.shell.as_deref(), Some("/bin/zsh"));
        assert_eq!(back.initial_command.as_deref(), Some("ls"));
        assert_eq!(back.starting_directory.as_deref(), Some("/home/user"));
        assert_eq!(back.cols, 100);
        assert_eq!(back.rows, 30);
        assert_eq!(back.env.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn serial_config_roundtrip() {
        let cfg = SerialConfig {
            port: "/dev/ttyUSB0".into(),
            baud_rate: 9600,
            data_bits: 7,
            stop_bits: 2,
            parity: "even".into(),
            flow_control: "hardware".into(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SerialConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.port, "/dev/ttyUSB0");
        assert_eq!(back.baud_rate, 9600);
        assert_eq!(back.data_bits, 7);
        assert_eq!(back.stop_bits, 2);
        assert_eq!(back.parity, "even");
        assert_eq!(back.flow_control, "hardware");
    }

    #[test]
    fn docker_config_roundtrip() {
        let cfg = DockerConfig {
            image: "ubuntu:22.04".into(),
            shell: Some("/bin/bash".into()),
            cols: 80,
            rows: 24,
            env_vars: vec![EnvVar {
                key: "MY_VAR".into(),
                value: "my_val".into(),
            }],
            volumes: vec![VolumeMount {
                host_path: "/tmp".into(),
                container_path: "/mnt".into(),
                read_only: false,
            }],
            working_directory: Some("/app".into()),
            remove_on_exit: false,
            env: HashMap::from([("LANG".into(), "en_US.UTF-8".into())]),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: DockerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.image, "ubuntu:22.04");
        assert_eq!(back.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(back.env_vars.len(), 1);
        assert_eq!(back.volumes.len(), 1);
        assert!(!back.remove_on_exit);
        assert_eq!(back.env.get("LANG").unwrap(), "en_US.UTF-8");
    }

    #[test]
    fn ssh_config_roundtrip() {
        let cfg = SshConfig {
            host: "example.com".into(),
            port: 2222,
            username: "admin".into(),
            auth_method: "key".into(),
            password: None,
            key_path: Some("/home/admin/.ssh/id_ed25519".into()),
            shell: Some("/bin/bash".into()),
            cols: 132,
            rows: 43,
            env: HashMap::new(),
            enable_x11_forwarding: true,
            enable_monitoring: Some(true),
            enable_file_browser: Some(false),
            save_password: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SshConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "example.com");
        assert_eq!(back.port, 2222);
        assert_eq!(back.username, "admin");
        assert_eq!(back.auth_method, "key");
        assert!(back.password.is_none());
        assert_eq!(
            back.key_path.as_deref(),
            Some("/home/admin/.ssh/id_ed25519")
        );
        assert!(back.enable_x11_forwarding);
        assert_eq!(back.enable_monitoring, Some(true));
        assert_eq!(back.enable_file_browser, Some(false));
        assert!(back.save_password.is_none());
    }

    // --- camelCase field name tests ---

    #[test]
    fn shell_config_snake_case_fields() {
        let json = r#"{
            "shell": null,
            "initial_command": "echo hi",
            "starting_directory": "/tmp",
            "cols": 80,
            "rows": 24,
            "env": {}
        }"#;
        let cfg: ShellConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.initial_command.as_deref(), Some("echo hi"));
        assert_eq!(cfg.starting_directory.as_deref(), Some("/tmp"));
    }

    #[test]
    fn serial_config_camel_case_fields() {
        let json = r#"{
            "port": "COM3",
            "baudRate": 9600,
            "dataBits": 8,
            "stopBits": 1,
            "parity": "none",
            "flowControl": "none"
        }"#;
        let cfg: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, "COM3");
        assert_eq!(cfg.baud_rate, 9600);
    }

    #[test]
    fn docker_config_camel_case_fields() {
        let json = r#"{
            "image": "alpine",
            "envVars": [],
            "volumes": [],
            "workingDirectory": "/opt",
            "removeOnExit": false
        }"#;
        let cfg: DockerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.working_directory.as_deref(), Some("/opt"));
        assert!(!cfg.remove_on_exit);
    }

    #[test]
    fn ssh_config_camel_case_fields() {
        let json = r#"{
            "host": "server",
            "port": 22,
            "username": "root",
            "authMethod": "password",
            "keyPath": null,
            "enableX11Forwarding": true,
            "enableMonitoring": true,
            "enableFileBrowser": false,
            "savePassword": true
        }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.enable_x11_forwarding);
        assert_eq!(cfg.enable_monitoring, Some(true));
        assert_eq!(cfg.enable_file_browser, Some(false));
        assert_eq!(cfg.save_password, Some(true));
    }

    // --- Serde default tests (missing fields use defaults) ---

    #[test]
    fn shell_config_missing_fields_use_defaults() {
        let json = r#"{}"#;
        let cfg: ShellConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn serial_config_missing_fields_use_defaults() {
        let json = r#"{"port": "/dev/ttyS0"}"#;
        let cfg: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.baud_rate, 115200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, "none");
        assert_eq!(cfg.flow_control, "none");
    }

    #[test]
    fn docker_config_missing_fields_use_defaults() {
        let json = r#"{"image": "nginx"}"#;
        let cfg: DockerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env_vars.is_empty());
        assert!(cfg.volumes.is_empty());
        assert!(cfg.remove_on_exit);
    }

    #[test]
    fn ssh_config_missing_optional_fields_use_defaults() {
        let json = r#"{
            "host": "h",
            "username": "u",
            "authMethod": "password"
        }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, 22);
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(!cfg.enable_x11_forwarding);
        assert!(cfg.env.is_empty());
    }

    // --- Expand method tests ---

    #[test]
    fn serial_config_expand_replaces_port() {
        std::env::set_var("TERMIHUB_TEST_SERIAL_PORT", "/dev/ttyACM0");
        let cfg = SerialConfig {
            port: "${env:TERMIHUB_TEST_SERIAL_PORT}".into(),
            ..SerialConfig::default()
        };
        let expanded = cfg.expand();
        assert_eq!(expanded.port, "/dev/ttyACM0");
        std::env::remove_var("TERMIHUB_TEST_SERIAL_PORT");
    }

    #[test]
    fn ssh_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_SSH_HOST", "192.168.1.100");
        std::env::set_var("TERMIHUB_TEST_SSH_USER", "deploy");
        let cfg = SshConfig {
            host: "${env:TERMIHUB_TEST_SSH_HOST}".into(),
            username: "${env:TERMIHUB_TEST_SSH_USER}".into(),
            auth_method: "key".into(),
            key_path: Some("${env:HOME}/.ssh/id_rsa".into()),
            ..SshConfig::default()
        };
        let expanded = cfg.expand();
        assert_eq!(expanded.host, "192.168.1.100");
        assert_eq!(expanded.username, "deploy");
        std::env::remove_var("TERMIHUB_TEST_SSH_HOST");
        std::env::remove_var("TERMIHUB_TEST_SSH_USER");
    }

    #[test]
    fn ssh_config_expand_tilde_in_key_path() {
        let cfg = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "key".into(),
            key_path: Some("~/.ssh/id_ed25519".into()),
            ..SshConfig::default()
        };
        let expanded = cfg.expand();
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
        let cfg = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "key".into(),
            key_path: Some(r#""C:\Users\me\.ssh\id_ed25519""#.into()),
            ..SshConfig::default()
        };
        let expanded = cfg.expand();
        let key = expanded.key_path.unwrap();
        assert!(!key.contains('"'), "quotes should be stripped, got: {key}");
        assert!(
            key.starts_with("C:"),
            "expected Windows path after stripping, got: {key}"
        );
    }

    #[test]
    fn docker_config_expand_replaces_placeholders() {
        std::env::set_var("TERMIHUB_TEST_DOCKER_IMAGE", "myapp");
        std::env::set_var("TERMIHUB_TEST_DOCKER_VAL", "production");
        let cfg = DockerConfig {
            image: "${env:TERMIHUB_TEST_DOCKER_IMAGE}:latest".into(),
            shell: Some("${env:TERMIHUB_TEST_DOCKER_IMAGE}".into()),
            env_vars: vec![EnvVar {
                key: "ENV".into(),
                value: "${env:TERMIHUB_TEST_DOCKER_VAL}".into(),
            }],
            working_directory: Some("${env:TERMIHUB_TEST_DOCKER_VAL}".into()),
            ..DockerConfig::default()
        };
        let expanded = cfg.expand();
        assert_eq!(expanded.image, "myapp:latest");
        assert_eq!(expanded.shell, Some("myapp".into()));
        assert_eq!(expanded.env_vars[0].value, "production");
        assert_eq!(expanded.working_directory, Some("production".into()));
        std::env::remove_var("TERMIHUB_TEST_DOCKER_IMAGE");
        std::env::remove_var("TERMIHUB_TEST_DOCKER_VAL");
    }

    #[test]
    fn docker_config_expand_tilde_in_volumes() {
        let cfg = DockerConfig {
            image: "ubuntu".into(),
            volumes: vec![VolumeMount {
                host_path: "~/projects".into(),
                container_path: "/workspace".into(),
                read_only: true,
            }],
            working_directory: Some("~/work".into()),
            ..DockerConfig::default()
        };
        let expanded = cfg.expand();
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
}
