use serde::{Deserialize, Serialize};

use crate::credential::crypto::EncryptedEnvelope;
use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};

/// Per-connection terminal display options.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal_scrolling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrollback_buffer: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
}

/// A saved connection with a name and optional folder assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub config: ConnectionConfig,
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_options: Option<TerminalOptions>,
    /// Runtime-only: which external file this connection was loaded from.
    /// `None` = main connections.json, `Some(path)` = external file.
    /// Stripped before writing to disk.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_file: Option<String>,
}

/// A folder for organizing connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub is_expanded: bool,
}

/// A saved remote agent definition (SSH transport config only, no ephemeral state).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRemoteAgent {
    pub id: String,
    pub name: String,
    pub config: RemoteAgentConfig,
}

/// Top-level schema for the connections JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub version: String,
    pub folders: Vec<ConnectionFolder>,
    pub connections: Vec<SavedConnection>,
    #[serde(default)]
    pub agents: Vec<SavedRemoteAgent>,
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            folders: Vec::new(),
            connections: Vec::new(),
            agents: Vec::new(),
        }
    }
}

/// Schema for external connection files. Same as `ConnectionStore` but with an optional `name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalConnectionStore {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub version: String,
    pub folders: Vec<ConnectionFolder>,
    pub connections: Vec<SavedConnection>,
}

/// Export format that optionally includes an encrypted credentials section.
///
/// When the user exports "with credentials", the `$encrypted` field
/// contains an [`EncryptedEnvelope`] holding a JSON map of
/// `"connection_id:credential_type" -> "value"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedConnectionExport {
    pub version: String,
    pub folders: Vec<ConnectionFolder>,
    pub connections: Vec<SavedConnection>,
    #[serde(default)]
    pub agents: Vec<SavedRemoteAgent>,
    #[serde(rename = "$encrypted", skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<EncryptedEnvelope>,
}

/// Summary of an import file before the user confirms the import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub connection_count: usize,
    pub folder_count: usize,
    pub agent_count: usize,
    pub has_encrypted_credentials: bool,
}

/// Result of a completed import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub connections_imported: usize,
    pub credentials_imported: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::{
        LocalShellConfig, RemoteAgentConfig, SerialConfig, SshConfig, TelnetConfig,
    };

    #[test]
    fn saved_connection_local_serde_round_trip() {
        let conn = SavedConnection {
            id: "conn-1".to_string(),
            name: "My Shell".to_string(),
            config: ConnectionConfig::Local(LocalShellConfig {
                shell_type: "zsh".to_string(),
                initial_command: Some("ls".to_string()),
                starting_directory: None,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        };
        let json = serde_json::to_string(&conn).unwrap();
        let deserialized: SavedConnection = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "conn-1");
        assert_eq!(deserialized.name, "My Shell");
    }

    #[test]
    fn saved_connection_ssh_serde_round_trip() {
        let conn = SavedConnection {
            id: "conn-2".to_string(),
            name: "SSH Server".to_string(),
            config: ConnectionConfig::Ssh(SshConfig {
                host: "example.com".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth_method: "password".to_string(),
                password: Some("secret".to_string()),
                key_path: None,
                enable_x11_forwarding: false,
                enable_monitoring: None,
                enable_file_browser: None,
                save_password: None,
            }),
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
            source_file: None,
        };
        let json = serde_json::to_string(&conn).unwrap();
        let deserialized: SavedConnection = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "conn-2");
        if let ConnectionConfig::Ssh(ssh) = &deserialized.config {
            assert_eq!(ssh.host, "example.com");
            assert_eq!(ssh.port, 22);
        } else {
            panic!("Expected SSH config");
        }
    }

    #[test]
    fn saved_connection_serial_serde_round_trip() {
        let conn = SavedConnection {
            id: "conn-3".to_string(),
            name: "Serial Port".to_string(),
            config: ConnectionConfig::Serial(SerialConfig {
                port: "/dev/ttyUSB0".to_string(),
                baud_rate: 115200,
                data_bits: 8,
                stop_bits: 1,
                parity: "none".to_string(),
                flow_control: "none".to_string(),
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        };
        let json = serde_json::to_string(&conn).unwrap();
        let deserialized: SavedConnection = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Serial(serial) = &deserialized.config {
            assert_eq!(serial.baud_rate, 115200);
        } else {
            panic!("Expected Serial config");
        }
    }

    #[test]
    fn saved_connection_telnet_serde_round_trip() {
        let conn = SavedConnection {
            id: "conn-4".to_string(),
            name: "Telnet Server".to_string(),
            config: ConnectionConfig::Telnet(TelnetConfig {
                host: "telnet.example.com".to_string(),
                port: 23,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        };
        let json = serde_json::to_string(&conn).unwrap();
        let deserialized: SavedConnection = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Telnet(telnet) = &deserialized.config {
            assert_eq!(telnet.host, "telnet.example.com");
            assert_eq!(telnet.port, 23);
        } else {
            panic!("Expected Telnet config");
        }
    }

    #[test]
    fn saved_remote_agent_serde_round_trip() {
        let agent = SavedRemoteAgent {
            id: "agent-1".to_string(),
            name: "Pi Agent".to_string(),
            config: RemoteAgentConfig {
                host: "pi.local".to_string(),
                port: 22,
                username: "pi".to_string(),
                auth_method: "key".to_string(),
                password: None,
                key_path: Some("~/.ssh/id_ed25519".to_string()),
                save_password: None,
            },
        };
        let json = serde_json::to_string(&agent).unwrap();
        let deserialized: SavedRemoteAgent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "agent-1");
        assert_eq!(deserialized.name, "Pi Agent");
        assert_eq!(deserialized.config.host, "pi.local");
        assert_eq!(deserialized.config.auth_method, "key");
    }

    #[test]
    fn connection_store_with_agents_backward_compat() {
        // Existing JSON without "agents" field should deserialize with empty agents vec
        let json = r#"{"version":"1","folders":[],"connections":[]}"#;
        let store: ConnectionStore = serde_json::from_str(json).unwrap();
        assert!(store.agents.is_empty());
    }

    #[test]
    fn ssh_config_backward_compat_missing_feature_fields() {
        // Old JSON without enableMonitoring/enableFileBrowser should deserialize with None
        let json = r#"{
            "type": "ssh",
            "config": {
                "host": "example.com",
                "port": 22,
                "username": "admin",
                "authMethod": "password",
                "password": "secret",
                "enableX11Forwarding": false
            }
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        if let ConnectionConfig::Ssh(ssh) = &config {
            assert_eq!(ssh.host, "example.com");
            assert!(ssh.enable_monitoring.is_none());
            assert!(ssh.enable_file_browser.is_none());
        } else {
            panic!("Expected SSH config");
        }
    }

    #[test]
    fn ssh_config_feature_fields_round_trip() {
        let config = ConnectionConfig::Ssh(SshConfig {
            host: "example.com".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            enable_x11_forwarding: false,
            enable_monitoring: Some(false),
            enable_file_browser: Some(true),
            save_password: None,
        });
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        if let ConnectionConfig::Ssh(ssh) = &deserialized {
            assert_eq!(ssh.enable_monitoring, Some(false));
            assert_eq!(ssh.enable_file_browser, Some(true));
        } else {
            panic!("Expected SSH config");
        }

        // Verify None values are omitted from JSON
        let config_none = ConnectionConfig::Ssh(SshConfig {
            host: "example.com".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            enable_x11_forwarding: false,
            enable_monitoring: None,
            enable_file_browser: None,
            save_password: None,
        });
        let json_none = serde_json::to_string(&config_none).unwrap();
        assert!(!json_none.contains("enableMonitoring"));
        assert!(!json_none.contains("enableFileBrowser"));
    }

    #[test]
    fn serde_produces_correct_json_shape() {
        let conn = SavedConnection {
            id: "test".to_string(),
            name: "Test".to_string(),
            config: ConnectionConfig::Local(LocalShellConfig {
                shell_type: "bash".to_string(),
                initial_command: None,
                starting_directory: None,
            }),
            folder_id: None,
            terminal_options: Some(TerminalOptions {
                horizontal_scrolling: Some(true),
                color: None,
                ..Default::default()
            }),
            source_file: None,
        };
        let json: serde_json::Value = serde_json::to_value(&conn).unwrap();
        // Check camelCase renaming
        assert!(json.get("folderId").is_some());
        assert!(json.get("terminalOptions").is_some());
        // Check tagged enum format
        let config = json.get("config").unwrap();
        assert_eq!(config.get("type").unwrap(), "local");
        assert!(config.get("config").is_some());
        // source_file: None should be omitted from JSON
        assert!(json.get("sourceFile").is_none());
    }

    #[test]
    fn source_file_included_when_set() {
        let conn = SavedConnection {
            id: "test".to_string(),
            name: "Test".to_string(),
            config: ConnectionConfig::Local(LocalShellConfig {
                shell_type: "bash".to_string(),
                initial_command: None,
                starting_directory: None,
            }),
            folder_id: None,
            terminal_options: None,
            source_file: Some("/path/to/external.json".to_string()),
        };
        let json: serde_json::Value = serde_json::to_value(&conn).unwrap();
        assert_eq!(
            json.get("sourceFile").unwrap().as_str().unwrap(),
            "/path/to/external.json"
        );
    }

    #[test]
    fn source_file_defaults_to_none_on_deserialize() {
        // JSON without sourceFile should deserialize with source_file = None
        let json = r#"{
            "id": "test",
            "name": "Test",
            "config": {"type": "local", "config": {"shellType": "bash"}},
            "folderId": null
        }"#;
        let conn: SavedConnection = serde_json::from_str(json).unwrap();
        assert!(conn.source_file.is_none());
    }
}
