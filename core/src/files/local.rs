use std::path::Path;

use crate::errors::FileError;

use super::utils::{chrono_from_epoch, normalize_path_separators};
use super::{FileBackend, FileEntry};

/// List directory contents, filtering out `.` and `..`.
///
/// Results are sorted with directories first, then by name (case-insensitive).
pub fn list_dir_sync(path: &str) -> Result<Vec<FileEntry>, std::io::Error> {
    let dir = Path::new(path);
    let entries = std::fs::read_dir(dir)?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "." || name == ".." {
            continue;
        }

        let metadata = entry.metadata()?;
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

        let permissions = get_permissions(&metadata);

        let full_path = normalize_path_separators(&entry.path().to_string_lossy());

        result.push(FileEntry {
            name,
            path: full_path,
            is_directory,
            size,
            modified,
            permissions,
        });
    }

    result.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// Get permission string from metadata (Unix only).
#[cfg(unix)]
fn get_permissions(metadata: &std::fs::Metadata) -> Option<String> {
    use super::utils::format_permissions;
    use std::os::unix::fs::PermissionsExt;
    Some(format_permissions(metadata.permissions().mode()))
}

/// On non-Unix platforms, permissions are not available in rwx format.
#[cfg(not(unix))]
fn get_permissions(_metadata: &std::fs::Metadata) -> Option<String> {
    None
}

/// Map `std::io::Error` to `FileError` based on error kind.
fn map_io_error(e: std::io::Error, path: &str) -> FileError {
    match e.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound(path.to_string()),
        std::io::ErrorKind::PermissionDenied => FileError::PermissionDenied(path.to_string()),
        _ => FileError::OperationFailed(format!("{}: {}", path, e)),
    }
}

/// Synchronous stat for a single path.
fn stat_sync(path: &str) -> Result<FileEntry, FileError> {
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

    let permissions = get_permissions(&metadata);

    Ok(FileEntry {
        name,
        path: normalize_path_separators(path),
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        modified,
        permissions,
    })
}

/// File backend that operates on the local filesystem.
///
/// All blocking I/O is wrapped in `tokio::task::spawn_blocking` to avoid
/// stalling the async runtime.
pub struct LocalFileBackend;

impl Default for LocalFileBackend {
    fn default() -> Self {
        Self
    }
}

impl LocalFileBackend {
    /// Create a new `LocalFileBackend`.
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl FileBackend for LocalFileBackend {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            list_dir_sync(&path).map_err(|e| map_io_error(e, &path))
        })
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

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || stat_sync(&path))
            .await
            .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dir_sync_empty() {
        let dir = tempfile::tempdir().unwrap();
        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn list_dir_sync_returns_files_with_metadata() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "world").unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 2);

        let file_entry = entries.iter().find(|e| e.name == "hello.txt").unwrap();
        assert!(!file_entry.is_directory);
        assert_eq!(file_entry.size, 5);
        assert!(!file_entry.modified.is_empty());

        let dir_entry = entries.iter().find(|e| e.name == "subdir").unwrap();
        assert!(dir_entry.is_directory);
    }

    #[test]
    fn list_dir_sync_sorts_directories_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a_file.txt"), "content").unwrap();
        std::fs::create_dir(dir.path().join("z_dir")).unwrap();
        std::fs::write(dir.path().join("b_file.txt"), "content").unwrap();
        std::fs::create_dir(dir.path().join("a_dir")).unwrap();

        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 4);

        // Directories should come first, sorted by name
        assert!(entries[0].is_directory);
        assert_eq!(entries[0].name, "a_dir");
        assert!(entries[1].is_directory);
        assert_eq!(entries[1].name, "z_dir");

        // Files after directories, sorted by name
        assert!(!entries[2].is_directory);
        assert_eq!(entries[2].name, "a_file.txt");
        assert!(!entries[3].is_directory);
        assert_eq!(entries[3].name, "b_file.txt");
    }

    #[test]
    fn list_dir_sync_nonexistent_directory() {
        let result = list_dir_sync("/nonexistent/path/abc123");
        assert!(result.is_err());
    }

    #[test]
    fn list_dir_sync_path_uses_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "x").unwrap();

        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].path.contains('\\'));
    }

    // ── FileBackend async tests ──────────────────────────────────────

    #[tokio::test]
    async fn backend_list_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let backend = LocalFileBackend::new();
        let entries = backend.list(dir.path().to_str().unwrap()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn backend_list_dir_returns_entries() {
        let dir = tempfile::tempdir().unwrap();
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
    async fn backend_list_nonexistent_dir() {
        let backend = LocalFileBackend::new();
        let result = backend.list("/nonexistent/path/abc123").await;
        assert!(matches!(result, Err(FileError::NotFound(_))));
    }

    #[tokio::test]
    async fn backend_read_write_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.bin");
        let path_str = file_path.to_str().unwrap();

        let backend = LocalFileBackend::new();
        let data = b"hello, world!";
        backend.write(path_str, data).await.unwrap();

        let read_data = backend.read(path_str).await.unwrap();
        assert_eq!(read_data, data);
    }

    #[tokio::test]
    async fn backend_read_nonexistent_file() {
        let backend = LocalFileBackend::new();
        let result = backend.read("/nonexistent/file.txt").await;
        assert!(matches!(result, Err(FileError::NotFound(_))));
    }

    #[tokio::test]
    async fn backend_delete_file() {
        let dir = tempfile::tempdir().unwrap();
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
    async fn backend_delete_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("to_delete_dir");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("inner.txt"), "inner").unwrap();

        let backend = LocalFileBackend::new();
        backend.delete(sub.to_str().unwrap(), true).await.unwrap();
        assert!(!sub.exists());
    }

    #[tokio::test]
    async fn backend_rename_file() {
        let dir = tempfile::tempdir().unwrap();
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
    async fn backend_stat_file() {
        let dir = tempfile::tempdir().unwrap();
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
    async fn backend_stat_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("test_dir");
        std::fs::create_dir(&sub).unwrap();

        let backend = LocalFileBackend::new();
        let result = backend.stat(sub.to_str().unwrap()).await.unwrap();
        assert_eq!(result.name, "test_dir");
        assert!(result.is_directory);
    }

    #[tokio::test]
    async fn backend_stat_nonexistent() {
        let backend = LocalFileBackend::new();
        let result = backend.stat("/nonexistent/path").await;
        assert!(matches!(result, Err(FileError::NotFound(_))));
    }

    #[tokio::test]
    async fn backend_trait_object_safety() {
        let backend: Box<dyn FileBackend> = Box::new(LocalFileBackend::new());
        let dir = tempfile::tempdir().unwrap();
        let entries = backend.list(dir.path().to_str().unwrap()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn backend_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<LocalFileBackend>();
    }
}
