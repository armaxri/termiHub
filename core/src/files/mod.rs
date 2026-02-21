pub mod local;
pub mod utils;

use serde::{Deserialize, Serialize};

/// A file or directory entry returned by file browsing operations.
///
/// This is the unified structure used by both the desktop and agent crates.
/// Field names are serialized as camelCase for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
