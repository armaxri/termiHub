//! Connection-scoped file browsing for the agent.
//!
//! Each connection type (local, docker, ssh) provides its own implementation
//! of the [`FileBackend`] trait. The dispatcher resolves which backend to use
//! based on the connection's `session_type`.

#[cfg(unix)]
pub mod docker;
pub mod local;
pub mod ssh;

use crate::protocol::methods::{FileEntry, FilesStatResult};
pub use termihub_core::errors::FileError;

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

    /// Get metadata for a single file/directory.
    async fn stat(&self, path: &str) -> Result<FilesStatResult, FileError>;
}

// ── Re-exported utility functions from core ──────────────────────────
pub use termihub_core::files::utils::{chrono_from_epoch, format_permissions};
