//! Async file browsing capability trait for connection types.
//!
//! Unlike [`FileBackend`](super::FileBackend) (which requires `Send + Sync`
//! and has a slightly different API surface), `FileBrowser` is the capability
//! interface returned by
//! [`ConnectionType::file_browser()`](crate::connection::ConnectionType::file_browser).

use crate::errors::FileError;
use crate::files::FileEntry;

/// Async file browsing capability exposed by connection types.
///
/// Connection types that support file browsing return
/// `Some(&dyn FileBrowser)` from
/// [`ConnectionType::file_browser()`](crate::connection::ConnectionType::file_browser).
///
/// This trait differs from [`FileBackend`](super::FileBackend) in method
/// naming and the `delete` signature (no `is_directory` parameter).
#[async_trait::async_trait]
pub trait FileBrowser: Send {
    /// List directory contents at the given path.
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError>;

    /// Read a file's contents, returning raw bytes.
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError>;

    /// Write raw bytes to a file, creating or overwriting it.
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError>;

    /// Delete a file or directory at the given path.
    async fn delete(&self, path: &str) -> Result<(), FileError>;

    /// Rename or move a file or directory.
    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError>;

    /// Get metadata for a single file or directory.
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verify FileBrowser is object-safe and Send.
    fn _assert_object_safe(_: &dyn FileBrowser) {}
    fn _assert_send<T: Send>() {}

    #[test]
    fn file_browser_is_send() {
        _assert_send::<Box<dyn FileBrowser>>();
    }
}
