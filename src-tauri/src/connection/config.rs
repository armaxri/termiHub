use serde::{Deserialize, Serialize};

use crate::terminal::backend::ConnectionConfig;

/// Per-connection terminal display options.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal_scrolling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
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

/// Top-level schema for the connections JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub version: String,
    pub folders: Vec<ConnectionFolder>,
    pub connections: Vec<SavedConnection>,
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            folders: Vec::new(),
            connections: Vec::new(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::{LocalShellConfig, SerialConfig, SshConfig, TelnetConfig};

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
            }),
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
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
            }),
        };
        let json: serde_json::Value = serde_json::to_value(&conn).unwrap();
        // Check camelCase renaming
        assert!(json.get("folderId").is_some());
        assert!(json.get("terminalOptions").is_some());
        // Check tagged enum format
        let config = json.get("config").unwrap();
        assert_eq!(config.get("type").unwrap(), "local");
        assert!(config.get("config").is_some());
    }
}
