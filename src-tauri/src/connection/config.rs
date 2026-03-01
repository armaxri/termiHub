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

// ---------------------------------------------------------------------------
// On-disk types (v2 nested tree format)
// ---------------------------------------------------------------------------

/// A node in the connection tree stored on disk.
///
/// Folders contain children; connections are leaf nodes.
/// Neither has an `id` — identity is determined by name within the parent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionTreeNode {
    /// A folder containing child nodes.
    #[serde(rename_all = "camelCase")]
    Folder {
        name: String,
        #[serde(default)]
        is_expanded: bool,
        #[serde(default)]
        children: Vec<ConnectionTreeNode>,
    },
    /// A saved connection.
    #[serde(rename_all = "camelCase")]
    Connection {
        name: String,
        config: ConnectionConfig,
        #[serde(skip_serializing_if = "Option::is_none")]
        terminal_options: Option<TerminalOptions>,
    },
}

/// A saved remote agent definition (SSH transport config only, no ephemeral state).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRemoteAgent {
    pub id: String,
    pub name: String,
    pub config: RemoteAgentConfig,
}

/// Top-level schema for the connections JSON file (v2 nested format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub version: String,
    pub children: Vec<ConnectionTreeNode>,
    #[serde(default)]
    pub agents: Vec<SavedRemoteAgent>,
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self {
            version: "2".to_string(),
            children: Vec::new(),
            agents: Vec::new(),
        }
    }
}

/// Schema for external connection files. Same nested format with an optional `name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalConnectionStore {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub version: String,
    pub children: Vec<ConnectionTreeNode>,
}

/// Export format that optionally includes an encrypted credentials section.
///
/// When the user exports "with credentials", the `$encrypted` field
/// contains an [`EncryptedEnvelope`] holding a JSON map of
/// `"connection_path_id:credential_type" -> "value"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedConnectionExport {
    pub version: String,
    pub children: Vec<ConnectionTreeNode>,
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

// ---------------------------------------------------------------------------
// In-memory types (flat, with generated path-based IDs)
// ---------------------------------------------------------------------------

/// In-memory representation of a saved connection (with generated path-based ID).
///
/// The `id` is not stored on disk — it is derived from the connection's
/// position in the tree (e.g., `"Work/Dev/My SSH"`).
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
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_file: Option<String>,
}

/// In-memory representation of a folder (with generated path-based ID).
///
/// The `id` is not stored on disk — it is derived from the folder's
/// position in the tree (e.g., `"Work/Dev"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub is_expanded: bool,
}

/// Flattened in-memory store used by the manager and IPC layer.
///
/// This is NOT serialized to disk — the on-disk format is [`ConnectionStore`]
/// (nested tree). Conversion happens in `tree.rs`.
pub struct FlatConnectionStore {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<ConnectionFolder>,
    pub agents: Vec<SavedRemoteAgent>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::RemoteAgentConfig;

    fn make_local_config() -> ConnectionConfig {
        ConnectionConfig {
            type_id: "local".to_string(),
            settings: serde_json::json!({"shell": "bash"}),
        }
    }

    fn make_ssh_config() -> ConnectionConfig {
        ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({
                "host": "example.com",
                "port": 22,
                "username": "admin",
                "authMethod": "password",
                "enableX11Forwarding": false
            }),
        }
    }

    #[test]
    fn connection_tree_node_folder_serde_round_trip() {
        let node = ConnectionTreeNode::Folder {
            name: "Work".to_string(),
            is_expanded: true,
            children: vec![ConnectionTreeNode::Connection {
                name: "My SSH".to_string(),
                config: make_ssh_config(),
                terminal_options: None,
            }],
        };
        let json = serde_json::to_string(&node).unwrap();
        let deserialized: ConnectionTreeNode = serde_json::from_str(&json).unwrap();
        match deserialized {
            ConnectionTreeNode::Folder {
                name,
                is_expanded,
                children,
            } => {
                assert_eq!(name, "Work");
                assert!(is_expanded);
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected Folder"),
        }
    }

    #[test]
    fn connection_tree_node_connection_serde_round_trip() {
        let node = ConnectionTreeNode::Connection {
            name: "Local Shell".to_string(),
            config: make_local_config(),
            terminal_options: Some(TerminalOptions {
                horizontal_scrolling: Some(true),
                ..Default::default()
            }),
        };
        let json = serde_json::to_string(&node).unwrap();
        let deserialized: ConnectionTreeNode = serde_json::from_str(&json).unwrap();
        match deserialized {
            ConnectionTreeNode::Connection {
                name,
                config,
                terminal_options,
            } => {
                assert_eq!(name, "Local Shell");
                assert_eq!(config.type_id, "local");
                assert!(terminal_options.is_some());
            }
            _ => panic!("Expected Connection"),
        }
    }

    #[test]
    fn connection_store_v2_serde_round_trip() {
        let store = ConnectionStore {
            version: "2".to_string(),
            children: vec![
                ConnectionTreeNode::Folder {
                    name: "Work".to_string(),
                    is_expanded: true,
                    children: vec![ConnectionTreeNode::Connection {
                        name: "Prod SSH".to_string(),
                        config: make_ssh_config(),
                        terminal_options: None,
                    }],
                },
                ConnectionTreeNode::Connection {
                    name: "Local".to_string(),
                    config: make_local_config(),
                    terminal_options: None,
                },
            ],
            agents: vec![],
        };
        let json = serde_json::to_string_pretty(&store).unwrap();
        let deserialized: ConnectionStore = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.version, "2");
        assert_eq!(deserialized.children.len(), 2);
        assert!(deserialized.agents.is_empty());
    }

    #[test]
    fn connection_store_default_is_v2() {
        let store = ConnectionStore::default();
        assert_eq!(store.version, "2");
        assert!(store.children.is_empty());
        assert!(store.agents.is_empty());
    }

    #[test]
    fn connection_store_with_agents_backward_compat() {
        // agents field missing from JSON should default to empty
        let json = r#"{"version":"2","children":[]}"#;
        let store: ConnectionStore = serde_json::from_str(json).unwrap();
        assert!(store.agents.is_empty());
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
                agent_path: None,
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
    fn serde_produces_correct_json_shape() {
        let node = ConnectionTreeNode::Connection {
            name: "Test".to_string(),
            config: make_local_config(),
            terminal_options: Some(TerminalOptions {
                horizontal_scrolling: Some(true),
                color: None,
                ..Default::default()
            }),
        };
        let json: serde_json::Value = serde_json::to_value(&node).unwrap();
        assert_eq!(json.get("type").unwrap(), "connection");
        assert_eq!(json.get("name").unwrap(), "Test");
        assert!(json.get("config").is_some());
        assert!(json.get("terminalOptions").is_some());
    }

    #[test]
    fn folder_json_shape_has_type_tag() {
        let node = ConnectionTreeNode::Folder {
            name: "Work".to_string(),
            is_expanded: false,
            children: vec![],
        };
        let json: serde_json::Value = serde_json::to_value(&node).unwrap();
        assert_eq!(json.get("type").unwrap(), "folder");
        assert_eq!(json.get("name").unwrap(), "Work");
        assert_eq!(json.get("isExpanded").unwrap(), false);
    }
}
