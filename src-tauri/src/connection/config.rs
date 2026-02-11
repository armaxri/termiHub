use serde::{Deserialize, Serialize};

use crate::terminal::backend::ConnectionConfig;

/// A saved connection with a name and optional folder assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub config: ConnectionConfig,
    pub folder_id: Option<String>,
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
