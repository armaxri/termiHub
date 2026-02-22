//! Local filesystem operations for the agent host.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crate::protocol::methods::{FileEntry, FilesStatResult};

#[cfg(unix)]
use super::format_permissions;
use super::{chrono_from_epoch, FileBackend, FileError};

/// File backend that reads the agent host's local filesystem.
pub struct LocalFileBackend;

impl LocalFileBackend {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl FileBackend for LocalFileBackend {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || list_dir_sync(&path))
            .await
            .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            std::fs::read(&path).map_err(|e| map_io_error(e, &path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let path = path.to_string();
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            std::fs::write(&path, &data).map_err(|e| map_io_error(e, &path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            if is_directory {
                std::fs::remove_dir_all(&path).map_err(|e| map_io_error(e, &path))
            } else {
                std::fs::remove_file(&path).map_err(|e| map_io_error(e, &path))
            }
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError> {
        let old = old_path.to_string();
        let new = new_path.to_string();
        tokio::task::spawn_blocking(move || {
            std::fs::rename(&old, &new).map_err(|e| map_io_error(e, &old))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn stat(&self, path: &str) -> Result<FilesStatResult, FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || stat_sync(&path))
            .await
            .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }
}

/// Map `std::io::Error` to `FileError` based on error kind.
fn map_io_error(e: std::io::Error, path: &str) -> FileError {
    match e.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound(path.to_string()),
        std::io::ErrorKind::PermissionDenied => FileError::PermissionDenied(path.to_string()),
        _ => FileError::OperationFailed(format!("{}: {}", path, e)),
    }
}

/// Synchronous directory listing.
fn list_dir_sync(path: &str) -> Result<Vec<FileEntry>, FileError> {
    let dir = Path::new(path);
    let entries = std::fs::read_dir(dir).map_err(|e| map_io_error(e, path))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| map_io_error(e, path))?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "." || name == ".." {
            continue;
        }

        let metadata = entry.metadata().map_err(|e| map_io_error(e, path))?;
        let is_directory = metadata.is_dir();
        let size = metadata.len();

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| chrono_from_epoch(d.as_secs()))
            })
            .unwrap_or_default();

        #[cfg(unix)]
        let permissions = Some(format_permissions(metadata.permissions().mode()));
        #[cfg(not(unix))]
        let permissions = None;

        let full_path = entry.path().to_string_lossy().to_string();

        result.push(FileEntry {
            name,
            path: full_path,
            is_directory,
            size,
            modified,
            permissions,
        });
    }

    Ok(result)
}

/// Synchronous stat for a single path.
fn stat_sync(path: &str) -> Result<FilesStatResult, FileError> {
    let p = Path::new(path);
    let metadata = std::fs::metadata(p).map_err(|e| map_io_error(e, path))?;

    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| chrono_from_epoch(d.as_secs()))
        })
        .unwrap_or_default();

    #[cfg(unix)]
    let permissions = Some(format_permissions(metadata.permissions().mode()));
    #[cfg(not(unix))]
    let permissions = None;

    Ok(FilesStatResult {
        name,
        path: path.to_string(),
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        modified,
        permissions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn list_empty_dir() {
        let dir = TempDir::new().unwrap();
        let backend = LocalFileBackend::new();
        let entries = backend.list(dir.path().to_str().unwrap()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn list_dir_returns_entries() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "world").unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();

        let backend = LocalFileBackend::new();
        let entries = backend.list(dir.path().to_str().unwrap()).await.unwrap();
        assert_eq!(entries.len(), 2);

        let file = entries.iter().find(|e| e.name == "hello.txt").unwrap();
        assert!(!file.is_directory);
        assert_eq!(file.size, 5);
        #[cfg(unix)]
        assert!(file.permissions.is_some());
        #[cfg(not(unix))]
        assert!(file.permissions.is_none());

        let dir_entry = entries.iter().find(|e| e.name == "subdir").unwrap();
        assert!(dir_entry.is_directory);
    }

    #[tokio::test]
    async fn list_nonexistent_dir() {
        let backend = LocalFileBackend::new();
        let result = backend.list("/nonexistent/path/abc123").await;
        assert!(matches!(result, Err(FileError::NotFound(_))));
    }

    #[tokio::test]
    async fn read_write_round_trip() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.bin");
        let path_str = file_path.to_str().unwrap();

        let backend = LocalFileBackend::new();
        let data = b"hello, world!";
        backend.write(path_str, data).await.unwrap();

        let read_data = backend.read(path_str).await.unwrap();
        assert_eq!(read_data, data);
    }

    #[tokio::test]
    async fn read_nonexistent_file() {
        let backend = LocalFileBackend::new();
        let result = backend.read("/nonexistent/file.txt").await;
        assert!(matches!(result, Err(FileError::NotFound(_))));
    }

    #[tokio::test]
    async fn delete_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("to_delete.txt");
        std::fs::write(&file_path, "delete me").unwrap();

        let backend = LocalFileBackend::new();
        backend
            .delete(file_path.to_str().unwrap(), false)
            .await
            .unwrap();
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn delete_directory() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("to_delete_dir");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("inner.txt"), "inner").unwrap();

        let backend = LocalFileBackend::new();
        backend.delete(sub.to_str().unwrap(), true).await.unwrap();
        assert!(!sub.exists());
    }

    #[tokio::test]
    async fn rename_file() {
        let dir = TempDir::new().unwrap();
        let old = dir.path().join("old.txt");
        let new = dir.path().join("new.txt");
        std::fs::write(&old, "content").unwrap();

        let backend = LocalFileBackend::new();
        backend
            .rename(old.to_str().unwrap(), new.to_str().unwrap())
            .await
            .unwrap();
        assert!(!old.exists());
        assert!(new.exists());
        assert_eq!(std::fs::read_to_string(&new).unwrap(), "content");
    }

    #[tokio::test]
    async fn stat_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("stat_test.txt");
        std::fs::write(&file_path, "hello").unwrap();

        let backend = LocalFileBackend::new();
        let result = backend.stat(file_path.to_str().unwrap()).await.unwrap();
        assert_eq!(result.name, "stat_test.txt");
        assert!(!result.is_directory);
        assert_eq!(result.size, 5);
        #[cfg(unix)]
        assert!(result.permissions.is_some());
        #[cfg(not(unix))]
        assert!(result.permissions.is_none());
        assert!(!result.modified.is_empty());
    }

    #[tokio::test]
    async fn stat_directory() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("test_dir");
        std::fs::create_dir(&sub).unwrap();

        let backend = LocalFileBackend::new();
        let result = backend.stat(sub.to_str().unwrap()).await.unwrap();
        assert_eq!(result.name, "test_dir");
        assert!(result.is_directory);
    }

    #[tokio::test]
    async fn stat_nonexistent() {
        let backend = LocalFileBackend::new();
        let result = backend.stat("/nonexistent/path").await;
        assert!(matches!(result, Err(FileError::NotFound(_))));
    }
}
