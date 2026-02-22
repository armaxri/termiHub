pub mod local;
pub mod utils;

pub use local::LocalFileBackend;

use crate::errors::FileError;
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

/// Trait for connection-scoped file operations.
///
/// Each connection type (local, docker, ssh) provides its own implementation.
/// All methods are async to support network-based backends (SFTP, docker exec).
/// Uses `#[async_trait]` for dyn compatibility in the dispatcher.
#[async_trait::async_trait]
pub trait FileBackend: Send + Sync {
    /// List directory contents at the given path.
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError>;

    /// Read file content, returning raw bytes.
    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError>;

    /// Write raw bytes to a file, creating or overwriting.
    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError>;

    /// Delete a file or directory.
    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError>;

    /// Rename/move a file or directory.
    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError>;

    /// Get metadata for a single file or directory.
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError>;
}
