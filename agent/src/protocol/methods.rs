// Fields deserialized from the protocol but not read by agent code
// are kept for protocol completeness and forward compatibility.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ── initialize ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct InitializeParams {
    pub protocol_version: String,
    pub client: String,
    pub client_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub session_types: Vec<String>,
    pub max_sessions: u32,
    pub available_shells: Vec<String>,
    pub available_serial_ports: Vec<String>,
    pub docker_available: bool,
    pub available_docker_images: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InitializeResult {
    pub protocol_version: String,
    pub agent_version: String,
    pub capabilities: Capabilities,
}

// ── session.create ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionCreateParams {
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionCreateResult {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub created_at: String,
}

// ── session.list ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SessionListResult {
    pub sessions: Vec<SessionListEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionListEntry {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub created_at: String,
    pub last_activity: String,
    pub attached: bool,
}

// ── session.close ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionCloseParams {
    pub session_id: String,
}

// ── session.attach ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionAttachParams {
    pub session_id: String,
}

// ── session.detach ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionDetachParams {
    pub session_id: String,
}

// ── session.input ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionInputParams {
    pub session_id: String,
    /// Base64-encoded data.
    pub data: String,
}

// ── session.resize ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionResizeParams {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

// ── health.check ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct HealthCheckResult {
    pub status: String,
    pub uptime_secs: u64,
    pub active_sessions: u32,
}

// ── session.define ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionDefineParams {
    /// Unique ID for this definition. If omitted, auto-generated.
    pub id: Option<String>,
    pub name: String,
    /// "shell" or "serial".
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub persistent: bool,
}

// ── session.definitions.delete ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionDefinitionDeleteParams {
    pub id: String,
}

// ── Shell / Serial config (for validation in the stub) ──────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ShellConfig {
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Deserialize)]
pub struct SerialSessionConfig {
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

// ── Docker session config ───────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct DockerSessionConfig {
    pub image: String,
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env_vars: Vec<DockerEnvVar>,
    #[serde(default)]
    pub volumes: Vec<DockerVolumeMount>,
    pub working_directory: Option<String>,
    #[serde(default = "default_remove_on_exit")]
    pub remove_on_exit: bool,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

fn default_remove_on_exit() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DockerEnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DockerVolumeMount {
    pub host_path: String,
    pub container_path: String,
    #[serde(default)]
    pub read_only: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initialize_params_serde() {
        let json = json!({
            "protocol_version": "0.1.0",
            "client": "termihub-desktop",
            "client_version": "0.1.0"
        });
        let params: InitializeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.protocol_version, "0.1.0");
        assert_eq!(params.client, "termihub-desktop");
    }

    #[test]
    fn initialize_result_serializes() {
        let result = InitializeResult {
            protocol_version: "0.1.0".to_string(),
            agent_version: "0.1.0".to_string(),
            capabilities: Capabilities {
                session_types: vec!["shell".to_string(), "serial".to_string()],
                max_sessions: 20,
                available_shells: vec!["/bin/bash".to_string(), "/bin/zsh".to_string()],
                available_serial_ports: vec!["/dev/ttyUSB0".to_string()],
                docker_available: false,
                available_docker_images: vec![],
            },
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["protocol_version"], "0.1.0");
        assert_eq!(v["capabilities"]["max_sessions"], 20);
        assert_eq!(v["capabilities"]["session_types"][0], "shell");
        assert_eq!(v["capabilities"]["available_shells"][0], "/bin/bash");
        assert_eq!(
            v["capabilities"]["available_serial_ports"][0],
            "/dev/ttyUSB0"
        );
        assert_eq!(v["capabilities"]["docker_available"], false);
        assert!(v["capabilities"]["available_docker_images"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_create_params_shell() {
        let json = json!({
            "type": "shell",
            "config": {
                "shell": "/bin/bash",
                "cols": 120,
                "rows": 40,
                "env": {"TERM": "xterm-256color"}
            },
            "title": "Build session"
        });
        let params: SessionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_type, "shell");
        assert_eq!(params.title, Some("Build session".to_string()));

        // Verify the config can be further parsed as ShellConfig
        let shell_cfg: ShellConfig = serde_json::from_value(params.config).unwrap();
        assert_eq!(shell_cfg.shell, Some("/bin/bash".to_string()));
        assert_eq!(shell_cfg.cols, 120);
        assert_eq!(shell_cfg.rows, 40);
    }

    #[test]
    fn session_create_params_serial() {
        let json = json!({
            "type": "serial",
            "config": {
                "port": "/dev/ttyUSB0",
                "baud_rate": 9600
            },
            "title": "Serial monitor"
        });
        let params: SessionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_type, "serial");

        let serial_cfg: SerialSessionConfig = serde_json::from_value(params.config).unwrap();
        assert_eq!(serial_cfg.port, "/dev/ttyUSB0");
        assert_eq!(serial_cfg.baud_rate, 9600);
        // Defaults
        assert_eq!(serial_cfg.data_bits, 8);
        assert_eq!(serial_cfg.stop_bits, 1);
        assert_eq!(serial_cfg.parity, "none");
    }

    #[test]
    fn session_create_result_serializes() {
        let result = SessionCreateResult {
            session_id: "abc-123".to_string(),
            title: "Build session".to_string(),
            session_type: "shell".to_string(),
            status: "running".to_string(),
            created_at: "2026-02-14T10:30:00Z".to_string(),
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["session_id"], "abc-123");
        assert_eq!(v["type"], "shell");
        assert_eq!(v["status"], "running");
    }

    #[test]
    fn session_list_result_serializes() {
        let result = SessionListResult {
            sessions: vec![SessionListEntry {
                session_id: "abc-123".to_string(),
                title: "Test".to_string(),
                session_type: "shell".to_string(),
                status: "running".to_string(),
                created_at: "2026-02-14T10:30:00Z".to_string(),
                last_activity: "2026-02-14T12:00:00Z".to_string(),
                attached: false,
            }],
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(v["sessions"][0]["attached"], false);
    }

    #[test]
    fn session_close_params_serde() {
        let json = json!({"session_id": "abc-123"});
        let params: SessionCloseParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
    }

    #[test]
    fn health_check_result_serializes() {
        let result = HealthCheckResult {
            status: "ok".to_string(),
            uptime_secs: 86400,
            active_sessions: 3,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["uptime_secs"], 86400);
        assert_eq!(v["active_sessions"], 3);
    }

    #[test]
    fn shell_config_defaults() {
        let json = json!({});
        let cfg: ShellConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.shell.is_none());
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn serial_config_defaults() {
        let json = json!({"port": "/dev/ttyUSB0"});
        let cfg: SerialSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.baud_rate, 115200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, "none");
        assert_eq!(cfg.flow_control, "none");
    }

    #[test]
    fn session_attach_params_serde() {
        let json = json!({"session_id": "abc-123"});
        let params: SessionAttachParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
    }

    #[test]
    fn session_detach_params_serde() {
        let json = json!({"session_id": "abc-123"});
        let params: SessionDetachParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
    }

    #[test]
    fn session_input_params_serde() {
        let json = json!({"session_id": "abc-123", "data": "aGVsbG8="});
        let params: SessionInputParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
        assert_eq!(params.data, "aGVsbG8=");
    }

    #[test]
    fn session_resize_params_serde() {
        let json = json!({"session_id": "abc-123", "cols": 120, "rows": 40});
        let params: SessionResizeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
        assert_eq!(params.cols, 120);
        assert_eq!(params.rows, 40);
    }

    #[test]
    fn session_define_params_serde() {
        let json = json!({
            "name": "Build Shell",
            "type": "shell",
            "config": {"shell": "/bin/bash"},
            "persistent": true
        });
        let params: SessionDefineParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Build Shell");
        assert_eq!(params.session_type, "shell");
        assert!(params.persistent);
        assert!(params.id.is_none());
    }

    #[test]
    fn session_define_params_persistent_defaults_false() {
        let json = json!({"name": "Temp", "type": "shell"});
        let params: SessionDefineParams = serde_json::from_value(json).unwrap();
        assert!(!params.persistent);
    }

    #[test]
    fn session_definition_delete_params_serde() {
        let json = json!({"id": "def-123"});
        let params: SessionDefinitionDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "def-123");
    }

    #[test]
    fn docker_session_config_defaults() {
        let json = json!({"image": "ubuntu:22.04"});
        let cfg: DockerSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.image, "ubuntu:22.04");
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.shell.is_none());
        assert!(cfg.env_vars.is_empty());
        assert!(cfg.volumes.is_empty());
        assert!(cfg.working_directory.is_none());
        assert!(cfg.remove_on_exit);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn docker_session_config_full() {
        let json = json!({
            "image": "ubuntu:22.04",
            "shell": "/bin/bash",
            "cols": 120,
            "rows": 40,
            "env_vars": [{"key": "FOO", "value": "bar"}],
            "volumes": [{"host_path": "/host", "container_path": "/mnt", "read_only": true}],
            "working_directory": "/app",
            "remove_on_exit": false,
            "env": {"TERM": "xterm-256color"}
        });
        let cfg: DockerSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.shell, Some("/bin/bash".to_string()));
        assert_eq!(cfg.cols, 120);
        assert_eq!(cfg.rows, 40);
        assert_eq!(cfg.env_vars.len(), 1);
        assert_eq!(cfg.env_vars[0].key, "FOO");
        assert_eq!(cfg.env_vars[0].value, "bar");
        assert_eq!(cfg.volumes.len(), 1);
        assert!(cfg.volumes[0].read_only);
        assert_eq!(cfg.volumes[0].host_path, "/host");
        assert_eq!(cfg.volumes[0].container_path, "/mnt");
        assert_eq!(cfg.working_directory, Some("/app".to_string()));
        assert!(!cfg.remove_on_exit);
    }

    #[test]
    fn docker_env_var_serde() {
        let env = DockerEnvVar {
            key: "K".to_string(),
            value: "V".to_string(),
        };
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["key"], "K");
        assert_eq!(v["value"], "V");
    }

    #[test]
    fn docker_volume_mount_serde() {
        let vol = DockerVolumeMount {
            host_path: "/host".to_string(),
            container_path: "/container".to_string(),
            read_only: false,
        };
        let v = serde_json::to_value(&vol).unwrap();
        assert_eq!(v["host_path"], "/host");
        assert_eq!(v["container_path"], "/container");
        assert!(!v["read_only"].as_bool().unwrap());
    }
}
