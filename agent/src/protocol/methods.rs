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

// ── connections.create ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionCreateParams {
    pub name: String,
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub persistent: bool,
    pub folder_id: Option<String>,
}

// ── connections.update ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionUpdateParams {
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub session_type: Option<String>,
    pub config: Option<serde_json::Value>,
    pub persistent: Option<bool>,
    /// Use JSON `null` to move to root, omit to leave unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub folder_id: Option<serde_json::Value>,
}

// ── connections.delete ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionDeleteParams {
    pub id: String,
}

// ── connections.folders.create ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FolderCreateParams {
    pub name: String,
    pub parent_id: Option<String>,
}

// ── connections.folders.update ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FolderUpdateParams {
    pub id: String,
    pub name: Option<String>,
    /// Use JSON `null` to move to root, omit to leave unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub parent_id: Option<serde_json::Value>,
    pub is_expanded: Option<bool>,
}

// ── connections.folders.delete ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FolderDeleteParams {
    pub id: String,
}

// ── Helper: distinguish absent field from explicit null ──────────────

/// Deserializes a field so that absent → `None`, explicit `null` → `Some(Value::Null)`,
/// and a present value → `Some(value)`. Standard `Option<Value>` collapses both
/// absent and null into `None`.
fn deserialize_optional_nullable<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(serde_json::Value::deserialize(deserializer)?))
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

// ── files.* types ──────────────────────────────────────────────────

/// A file or directory entry returned by file browsing operations.
/// Matches the desktop's `FileEntry` format for seamless display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    /// ISO 8601 timestamp.
    pub modified: String,
    /// Unix "rwxrwxrwx" format, `None` when not available.
    pub permissions: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesListParams {
    /// Connection to scope the operation to. If absent, use local filesystem.
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilesListResult {
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesReadParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilesReadResult {
    /// Base64-encoded file content.
    pub data: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesWriteParams {
    pub connection_id: Option<String>,
    pub path: String,
    /// Base64-encoded content to write.
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesDeleteParams {
    pub connection_id: Option<String>,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesRenameParams {
    pub connection_id: Option<String>,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesStatParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesStatResult {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: String,
    pub permissions: Option<String>,
}

// ── monitoring.subscribe ────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct MonitoringSubscribeParams {
    /// `"self"` for the agent's own host, or a connection ID for a jump target.
    pub host: String,
    /// Collection interval in milliseconds (default: 2000).
    pub interval_ms: Option<u64>,
}

// ── monitoring.unsubscribe ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct MonitoringUnsubscribeParams {
    pub host: String,
}

// ── monitoring.data (notification payload) ──────────────────────────

/// System statistics sent as a `monitoring.data` notification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringData {
    /// `"self"` or connection ID identifying the monitored host.
    pub host: String,
    pub hostname: String,
    pub uptime_seconds: f64,
    pub load_average: [f64; 3],
    pub cpu_usage_percent: f64,
    pub memory_total_kb: u64,
    pub memory_available_kb: u64,
    pub memory_used_percent: f64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_used_percent: f64,
    pub os_info: String,
}

// ── SSH session config ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SshSessionConfig {
    pub host: String,
    pub username: String,
    /// "key", "password", or "agent".
    pub auth_method: String,
    /// SSH port (default: 22).
    pub port: Option<u16>,
    /// Password for password auth. Requires `sshpass` on the agent host.
    pub password: Option<String>,
    /// Path to private key file for key-based auth.
    pub key_path: Option<String>,
    /// Remote shell to invoke (default: user's login shell on target).
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
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
    fn connection_create_params_serde() {
        let json = json!({
            "name": "Build Shell",
            "type": "shell",
            "config": {"shell": "/bin/bash"},
            "persistent": true,
            "folder_id": "folder-1"
        });
        let params: ConnectionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Build Shell");
        assert_eq!(params.session_type, "shell");
        assert!(params.persistent);
        assert_eq!(params.folder_id, Some("folder-1".to_string()));
    }

    #[test]
    fn connection_create_params_defaults() {
        let json = json!({"name": "Temp", "type": "shell"});
        let params: ConnectionCreateParams = serde_json::from_value(json).unwrap();
        assert!(!params.persistent);
        assert_eq!(params.folder_id, None);
    }

    #[test]
    fn connection_update_params_serde() {
        let json = json!({
            "id": "conn-1",
            "name": "New Name",
            "persistent": true,
            "folder_id": null
        });
        let params: ConnectionUpdateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "conn-1");
        assert_eq!(params.name, Some("New Name".to_string()));
        assert_eq!(params.persistent, Some(true));
        assert!(params.folder_id.is_some()); // present but null
        assert!(params.folder_id.unwrap().is_null());
    }

    #[test]
    fn connection_update_params_minimal() {
        let json = json!({"id": "conn-1"});
        let params: ConnectionUpdateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "conn-1");
        assert!(params.name.is_none());
        assert!(params.session_type.is_none());
        assert!(params.config.is_none());
        assert!(params.persistent.is_none());
        assert!(params.folder_id.is_none());
    }

    #[test]
    fn connection_delete_params_serde() {
        let json = json!({"id": "conn-123"});
        let params: ConnectionDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "conn-123");
    }

    #[test]
    fn folder_create_params_serde() {
        let json = json!({"name": "Project A", "parent_id": "folder-0"});
        let params: FolderCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Project A");
        assert_eq!(params.parent_id, Some("folder-0".to_string()));
    }

    #[test]
    fn folder_create_params_root() {
        let json = json!({"name": "Root Folder"});
        let params: FolderCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Root Folder");
        assert_eq!(params.parent_id, None);
    }

    #[test]
    fn folder_update_params_serde() {
        let json = json!({
            "id": "folder-1",
            "name": "Renamed",
            "parent_id": null,
            "is_expanded": true
        });
        let params: FolderUpdateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "folder-1");
        assert_eq!(params.name, Some("Renamed".to_string()));
        assert!(params.parent_id.is_some());
        assert!(params.parent_id.unwrap().is_null());
        assert_eq!(params.is_expanded, Some(true));
    }

    #[test]
    fn folder_delete_params_serde() {
        let json = json!({"id": "folder-123"});
        let params: FolderDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "folder-123");
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

    #[test]
    fn ssh_session_config_defaults() {
        let json = json!({"host": "build.internal", "username": "dev", "auth_method": "agent"});
        let cfg: SshSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.host, "build.internal");
        assert_eq!(cfg.username, "dev");
        assert_eq!(cfg.auth_method, "agent");
        assert!(cfg.port.is_none());
        assert!(cfg.password.is_none());
        assert!(cfg.key_path.is_none());
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn ssh_session_config_full() {
        let json = json!({
            "host": "build.internal",
            "username": "deploy",
            "auth_method": "key",
            "port": 2222,
            "password": "secret",
            "key_path": "/home/user/.ssh/id_ed25519",
            "shell": "/bin/bash",
            "cols": 120,
            "rows": 40,
            "env": {"TERM": "xterm-256color"}
        });
        let cfg: SshSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.host, "build.internal");
        assert_eq!(cfg.username, "deploy");
        assert_eq!(cfg.auth_method, "key");
        assert_eq!(cfg.port, Some(2222));
        assert_eq!(cfg.password.as_deref(), Some("secret"));
        assert_eq!(cfg.key_path.as_deref(), Some("/home/user/.ssh/id_ed25519"));
        assert_eq!(cfg.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(cfg.cols, 120);
        assert_eq!(cfg.rows, 40);
        assert_eq!(cfg.env.get("TERM").unwrap(), "xterm-256color");
    }

    // ── File browsing types ────────────────────────────────────────

    #[test]
    fn file_entry_serializes_camel_case() {
        let entry = FileEntry {
            name: "readme.md".to_string(),
            path: "/home/user/readme.md".to_string(),
            is_directory: false,
            size: 1024,
            modified: "2026-02-20T10:00:00Z".to_string(),
            permissions: Some("rw-r--r--".to_string()),
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["name"], "readme.md");
        assert_eq!(v["isDirectory"], false);
        assert!(v.get("is_directory").is_none());
        assert_eq!(v["size"], 1024);
        assert_eq!(v["modified"], "2026-02-20T10:00:00Z");
        assert_eq!(v["permissions"], "rw-r--r--");
    }

    #[test]
    fn file_entry_null_permissions() {
        let entry = FileEntry {
            name: "file.txt".to_string(),
            path: "/file.txt".to_string(),
            is_directory: false,
            size: 0,
            modified: String::new(),
            permissions: None,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v["permissions"].is_null());
    }

    #[test]
    fn files_list_params_serde() {
        let json = json!({"path": "/home"});
        let params: FilesListParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/home");
        assert!(params.connection_id.is_none());

        let json = json!({"connection_id": "conn-1", "path": "/tmp"});
        let params: FilesListParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-1".to_string()));
        assert_eq!(params.path, "/tmp");
    }

    #[test]
    fn files_list_result_serializes() {
        let result = FilesListResult {
            entries: vec![FileEntry {
                name: "dir".to_string(),
                path: "/dir".to_string(),
                is_directory: true,
                size: 4096,
                modified: "2026-01-01T00:00:00Z".to_string(),
                permissions: Some("rwxr-xr-x".to_string()),
            }],
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 1);
        assert_eq!(v["entries"][0]["isDirectory"], true);
    }

    #[test]
    fn files_read_params_serde() {
        let json = json!({"path": "/etc/hosts"});
        let params: FilesReadParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/etc/hosts");
        assert!(params.connection_id.is_none());
    }

    #[test]
    fn files_read_result_serializes() {
        let result = FilesReadResult {
            data: "aGVsbG8=".to_string(),
            size: 5,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["data"], "aGVsbG8=");
        assert_eq!(v["size"], 5);
    }

    #[test]
    fn files_write_params_serde() {
        let json = json!({"path": "/tmp/out.txt", "data": "aGVsbG8="});
        let params: FilesWriteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/tmp/out.txt");
        assert_eq!(params.data, "aGVsbG8=");
        assert!(params.connection_id.is_none());
    }

    #[test]
    fn files_delete_params_serde() {
        let json = json!({"path": "/tmp/old", "isDirectory": true});
        let params: FilesDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/tmp/old");
        assert!(params.is_directory);
        assert!(params.connection_id.is_none());
    }

    #[test]
    fn files_rename_params_serde() {
        let json = json!({"old_path": "/a.txt", "new_path": "/b.txt"});
        let params: FilesRenameParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.old_path, "/a.txt");
        assert_eq!(params.new_path, "/b.txt");
    }

    #[test]
    fn files_stat_params_serde() {
        let json = json!({"connection_id": "conn-42", "path": "/var/log"});
        let params: FilesStatParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-42".to_string()));
        assert_eq!(params.path, "/var/log");
    }

    #[test]
    fn files_stat_result_serializes_camel_case() {
        let result = FilesStatResult {
            name: "log".to_string(),
            path: "/var/log".to_string(),
            is_directory: true,
            size: 4096,
            modified: "2026-02-20T10:00:00Z".to_string(),
            permissions: Some("rwxr-xr-x".to_string()),
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["isDirectory"], true);
        assert!(v.get("is_directory").is_none());
        assert_eq!(v["name"], "log");
    }

    // ── Monitoring types ─────────────────────────────────────────

    #[test]
    fn monitoring_subscribe_params_serde() {
        let json = json!({"host": "self", "interval_ms": 5000});
        let params: MonitoringSubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.host, "self");
        assert_eq!(params.interval_ms, Some(5000));
    }

    #[test]
    fn monitoring_subscribe_params_defaults() {
        let json = json!({"host": "conn-123"});
        let params: MonitoringSubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.host, "conn-123");
        assert_eq!(params.interval_ms, None);
    }

    #[test]
    fn monitoring_unsubscribe_params_serde() {
        let json = json!({"host": "self"});
        let params: MonitoringUnsubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.host, "self");
    }

    #[test]
    fn monitoring_data_serializes_camel_case() {
        let data = MonitoringData {
            host: "self".to_string(),
            hostname: "raspberrypi".to_string(),
            uptime_seconds: 12345.67,
            load_average: [0.15, 0.10, 0.05],
            cpu_usage_percent: 78.5,
            memory_total_kb: 16384000,
            memory_available_kb: 12000000,
            memory_used_percent: 25.0,
            disk_total_kb: 50000000,
            disk_used_kb: 20000000,
            disk_used_percent: 42.0,
            os_info: "Linux 5.15.0".to_string(),
        };
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(v["host"], "self");
        assert_eq!(v["hostname"], "raspberrypi");
        assert_eq!(v["uptimeSeconds"], 12345.67);
        assert_eq!(v["cpuUsagePercent"], 78.5);
        assert_eq!(v["memoryTotalKb"], 16384000);
        assert_eq!(v["memoryAvailableKb"], 12000000);
        assert_eq!(v["memoryUsedPercent"], 25.0);
        assert_eq!(v["diskTotalKb"], 50000000);
        assert_eq!(v["diskUsedKb"], 20000000);
        assert_eq!(v["diskUsedPercent"], 42.0);
        assert_eq!(v["osInfo"], "Linux 5.15.0");
        // Verify camelCase (no snake_case keys)
        assert!(v.get("uptime_seconds").is_none());
        assert!(v.get("cpu_usage_percent").is_none());
        assert!(v.get("memory_total_kb").is_none());
    }
}
