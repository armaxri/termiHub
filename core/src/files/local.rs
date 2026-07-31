use std::path::Path;

use crate::config::expand_tilde_only;
use crate::errors::FileError;

use super::utils::{chrono_from_epoch, normalize_path_separators, normalize_platform_path};
use super::{FileBackend, FileEntry};

/// List directory contents, filtering out `.` and `..`.
///
/// Results are sorted with directories first, then by name (case-insensitive).
pub fn list_dir_sync(path: &str) -> Result<Vec<FileEntry>, std::io::Error> {
    let normalized = normalize_platform_path(path);
    let dir = Path::new(&normalized);
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

        // `DirEntry::file_type()` is cheap (backed by the readdir `d_type` where
        // available) and does not follow the link, so it detects symlinks
        // without an extra stat. `is_directory` above still reflects the
        // followed target, so a symlink-to-dir stays navigable.
        let (is_symlink, symlink_target) = read_symlink(entry.file_type().ok(), &entry.path());

        let full_path = normalize_path_separators(&entry.path().to_string_lossy());

        result.push(FileEntry {
            name,
            path: full_path,
            is_directory,
            size,
            modified,
            permissions,
            // Writability is derived only for the desktop SFTP browser (#1324).
            writable: None,
            is_symlink,
            symlink_target,
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
    let normalized = normalize_platform_path(path);
    let p = Path::new(&normalized);
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

    // `metadata` above follows the link; a separate `symlink_metadata` reveals
    // whether the path itself is a symlink (and, if so, its target).
    let symlink_type = std::fs::symlink_metadata(p).ok().map(|m| m.file_type());
    let (is_symlink, symlink_target) = read_symlink(symlink_type, p);

    Ok(FileEntry {
        name,
        path: normalize_path_separators(path),
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        modified,
        permissions,
        // Writability is derived only for the desktop SFTP browser (#1324).
        writable: None,
        is_symlink,
        symlink_target,
    })
}

/// Derive `(is_symlink, symlink_target)` from a (non-following) file type.
///
/// When `file_type` reports a symlink, the target is read with `read_link`
/// (cheap: one syscall, only for links). Any read failure degrades to `None`
/// rather than erroring, so a broken or unreadable link still lists.
fn read_symlink(file_type: Option<std::fs::FileType>, path: &Path) -> (bool, Option<String>) {
    if file_type.is_some_and(|ft| ft.is_symlink()) {
        let target = std::fs::read_link(path)
            .ok()
            .map(|t| t.to_string_lossy().into_owned());
        (true, target)
    } else {
        (false, None)
    }
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

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&path).map_err(|e| map_io_error(e, &path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }
}

/// [`FileBrowser`] capability for the local filesystem.
///
/// A thin wrapper around the local filesystem operations that implements the
/// `FileBrowser` capability interface (used by `ConnectionType::file_browser()`).
/// Using a separate struct avoids method ambiguity with `LocalFileBackend`
/// which implements the `FileBackend` trait.
pub struct LocalFileBrowser;

impl LocalFileBrowser {
    /// Create a new `LocalFileBrowser`.
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalFileBrowser {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl super::browser::FileBrowser for LocalFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let path = expand_tilde_only(path);
        tokio::task::spawn_blocking(move || {
            list_dir_sync(&path).map_err(|e| map_io_error(e, &path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let path = expand_tilde_only(path);
        tokio::task::spawn_blocking(move || {
            std::fs::read(&path).map_err(|e| map_io_error(e, &path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let path = expand_tilde_only(path);
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            std::fs::write(&path, &data).map_err(|e| map_io_error(e, &path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        let path = expand_tilde_only(path);
        // `stat` re-expands the (already absolute) path idempotently, then the
        // directory flag it reports picks `remove_dir_all` vs `remove_file`.
        let entry = super::browser::FileBrowser::stat(self, &path).await?;
        tokio::task::spawn_blocking(move || {
            if entry.is_directory {
                std::fs::remove_dir_all(&path).map_err(|e| map_io_error(e, &path))
            } else {
                std::fs::remove_file(&path).map_err(|e| map_io_error(e, &path))
            }
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        let old = expand_tilde_only(from);
        let new = expand_tilde_only(to);
        tokio::task::spawn_blocking(move || {
            std::fs::rename(&old, &new).map_err(|e| map_io_error(e, &old))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let path = expand_tilde_only(path);
        tokio::task::spawn_blocking(move || stat_sync(&path))
            .await
            .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        let path = expand_tilde_only(path);
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&path).map_err(|e| map_io_error(e, &path))
        })
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

    #[cfg(unix)]
    #[test]
    fn list_dir_sync_flags_symlink_with_target() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), "hi").unwrap();
        symlink(dir.path().join("real.txt"), dir.path().join("link.txt")).unwrap();

        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();

        let link = entries.iter().find(|e| e.name == "link.txt").unwrap();
        assert!(link.is_symlink, "link.txt should be flagged as a symlink");
        assert!(
            link.symlink_target
                .as_deref()
                .unwrap()
                .ends_with("real.txt"),
            "target should point at real.txt, got {:?}",
            link.symlink_target
        );

        let real = entries.iter().find(|e| e.name == "real.txt").unwrap();
        assert!(!real.is_symlink);
        assert_eq!(real.symlink_target, None);
    }

    #[cfg(unix)]
    #[test]
    fn stat_sync_flags_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), "hi").unwrap();
        let link_path = dir.path().join("link.txt");
        symlink(dir.path().join("real.txt"), &link_path).unwrap();

        let entry = stat_sync(link_path.to_str().unwrap()).unwrap();
        assert!(entry.is_symlink);
        assert!(entry
            .symlink_target
            .as_deref()
            .unwrap()
            .ends_with("real.txt"));
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

    // ── LocalFileBrowser (FileBrowser) tests ─────────────────────────
    //
    // `LocalFileBrowser` is the single local-filesystem capability behind
    // `ConnectionType::file_browser()` for both desktop and agent (#2104). These
    // exercise the browser directly, including the leading-`~` expansion it must
    // provide so the agent's file commands keep resolving `~` after the parallel
    // agent `LocalFileBackend` was retired.
    use super::super::browser::FileBrowser;

    #[tokio::test]
    async fn browser_list_and_stat_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let browser = LocalFileBrowser::new();
        let entries = browser.list_dir(dir.path().to_str().unwrap()).await.unwrap();
        assert_eq!(entries.len(), 2);
        // Directories sort first (inherited from `list_dir_sync`).
        assert!(entries[0].is_directory);
        assert_eq!(entries[0].name, "sub");

        let stat = browser
            .stat(dir.path().join("a.txt").to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(stat.name, "a.txt");
        assert_eq!(stat.size, 2);
    }

    #[tokio::test]
    async fn browser_read_write_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.bin");
        let path = file.to_str().unwrap();

        let browser = LocalFileBrowser::new();
        browser.write_file(path, b"payload").await.unwrap();
        assert_eq!(browser.read_file(path).await.unwrap(), b"payload");

        // `delete` self-detects the entry kind via `stat` (no `is_directory`
        // flag), the behaviour the retired `FileBackend::delete` took a hint for.
        browser.delete(path).await.unwrap();
        assert!(!file.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_list_tilde_expands_to_home_dir() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let browser = LocalFileBrowser::new();
        let entries = browser.list_dir("~").await.expect("listing '~' should work");
        for entry in entries {
            assert!(
                entry.path.starts_with(&home),
                "entry path '{}' does not start with HOME '{}'",
                entry.path,
                home
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_stat_tilde_expands_to_home_dir() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let browser = LocalFileBrowser::new();
        let entry = browser.stat("~").await.expect("stat of '~' should work");
        assert_eq!(entry.path, home, "stat path should be the expanded home dir");
        assert!(entry.is_directory);
    }

    #[test]
    fn browser_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Box<dyn FileBrowser>>();
        assert_send::<LocalFileBrowser>();
    }
}
