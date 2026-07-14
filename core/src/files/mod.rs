pub mod browser;
pub mod local;
pub mod utils;

pub use browser::FileBrowser;
pub use local::{LocalFileBackend, LocalFileBrowser};

use crate::errors::FileError;
use serde::{Deserialize, Serialize};

/// A file or directory entry returned by file browsing operations.
///
/// This is the unified structure used by both the desktop and agent crates.
/// Field names are serialized as camelCase for the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Cheap, conservative writability hint derived from the permission string
    /// (see [`utils::writable_from_permissions`]): `Some(false)` only when *no*
    /// class may write, `Some(true)` when at least one may, `None` when unknown
    /// (permissions absent or the backend does not derive it). The authoritative
    /// answer for a specific file comes from an SFTP write-open probe.
    pub writable: Option<bool>,
    /// True when this entry is a symbolic link. Populated by backends that can
    /// tell cheaply (the FTP listing parser, and the local filesystem browsers
    /// via `symlink_metadata`); `false` otherwise. `#[serde(default)]` keeps
    /// older persisted/round-tripped JSON without the field deserializing.
    #[serde(default)]
    pub is_symlink: bool,
    /// The link target, when the backend could determine it cheaply — e.g. the
    /// `-> target` suffix of a Unix `ls -l` FTP line, or `read_link` for a local
    /// entry. `None` for non-links and for formats that do not carry a target
    /// (MLSD `type=link`, SFTP `readdir`). `#[serde(default)]` for compatibility.
    #[serde(default)]
    pub symlink_target: Option<String>,
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

    /// Create a directory (and any missing parent directories) at the given path.
    async fn mkdir(&self, path: &str) -> Result<(), FileError>;
}

#[cfg(test)]
mod tests {
    use super::FileEntry;

    #[test]
    fn symlink_fields_serialize_camel_case() {
        let entry = FileEntry {
            name: "link".to_string(),
            path: "/pub/link".to_string(),
            is_symlink: true,
            symlink_target: Some("target".to_string()),
            ..Default::default()
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["isSymlink"], true);
        assert_eq!(v["symlinkTarget"], "target");
        // snake_case keys must never appear.
        assert!(v.get("is_symlink").is_none());
        assert!(v.get("symlink_target").is_none());
    }

    #[test]
    fn old_json_without_symlink_fields_deserializes() {
        // A payload persisted before the symlink fields existed must still
        // deserialize, defaulting `is_symlink`/`symlink_target`.
        let json = serde_json::json!({
            "name": "file.txt",
            "path": "/file.txt",
            "isDirectory": false,
            "size": 12,
            "modified": "2026-01-01T00:00:00Z",
            "permissions": "rw-r--r--",
            "writable": true
        });
        let entry: FileEntry = serde_json::from_value(json).unwrap();
        assert_eq!(entry.name, "file.txt");
        assert!(!entry.is_symlink);
        assert_eq!(entry.symlink_target, None);
    }
}
