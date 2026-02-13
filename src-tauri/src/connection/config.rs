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
