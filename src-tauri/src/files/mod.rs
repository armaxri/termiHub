pub mod local;
pub mod sftp;
pub mod utils;

use serde::Serialize;

/// A file or directory entry returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: String,
    pub permissions: Option<String>,
}
