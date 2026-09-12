use std::path::Path;

use crate::config::expand_tilde_only;
use crate::errors::FileError;

use super::utils::{chrono_from_epoch, normalize_path_separators, normalize_platform_path};
use super::FileEntry;

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

        // `DirEntry::metadata()` uses `symlink_metadata` semantics (it does NOT
        // follow the link), so a symlink's own type/size lands here. Resolving
        // through `resolve_entry_metadata` follows the link for `is_directory`
        // (and stats) so a symlink-to-dir is navigable, while a dangling/looping
        // link degrades to the link's own metadata instead of aborting the list.
        let own_metadata = entry.metadata()?;
        let file_type = entry.file_type().ok();
        let is_symlink_entry = file_type.is_some_and(|ft| ft.is_symlink());
        let (metadata, is_directory) =
            resolve_entry_metadata(&entry.path(), is_symlink_entry, own_metadata);
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

        // The non-following `file_type` detects the link and `read_link` records
        // its target; `is_directory` above already reflects the followed target,
        // so a symlink-to-dir is both flagged `is_symlink` and navigable.
        let (is_symlink, symlink_target) = read_symlink(file_type, &entry.path());

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
pub fn stat_sync(path: &str) -> Result<FileEntry, FileError> {
    let normalized = normalize_platform_path(path);
    let p = Path::new(&normalized);
    // `symlink_metadata` never follows, so it succeeds even for a dangling or
    // looping link and tells us whether the path itself is a symlink.
    let own_metadata = std::fs::symlink_metadata(p).map_err(|e| map_io_error(e, path))?;
    // `FileType` is `Copy`, so capture it before `own_metadata` is moved below.
    let own_file_type = own_metadata.file_type();
    let is_symlink_entry = own_file_type.is_symlink();
    // Follow the link (when it is one) so `is_directory`/size/modified describe
    // the target and a symlink-to-dir stats as navigable; a dangling/looping
    // link degrades to the link's own metadata rather than erroring the stat.
    let (metadata, is_directory) = resolve_entry_metadata(p, is_symlink_entry, own_metadata);

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

    // The non-following file type (from `own_metadata`) decides the symlink flag
    // and `read_link` records its target.
    let (is_symlink, symlink_target) = read_symlink(Some(own_file_type), p);

    Ok(FileEntry {
        name,
        path: normalize_path_separators(path),
        is_directory,
        size: metadata.len(),
        modified,
        permissions,
        // Writability is derived only for the desktop SFTP browser (#1324).
        writable: None,
        is_symlink,
        symlink_target,
    })
}

/// Resolve the metadata that describes an entry, following a symlink to its
/// target so a symlink-to-directory is navigable-as-directory.
///
/// Returns the effective [`Metadata`](std::fs::Metadata) plus the `is_directory`
/// flag. `own_metadata` is the entry's own (non-following) metadata:
///
/// - Not a symlink → the entry's own metadata already describes it.
/// - Symlink whose target resolves → the target's metadata, so `is_directory`
///   (and size/modified) reflect what the link points at.
/// - Symlink that is dangling or forms a loop → following fails, so we degrade
///   to the link's own metadata with `is_directory = false`. A single bad link
///   therefore never aborts a directory listing or a stat.
///
/// This mirrors the shared [`FileEntry`] semantics used by the FTP listing
/// parser (`is_symlink`/`symlink_target` flag the link; `is_directory` describes
/// navigability), extended to follow the target because the local filesystem —
/// unlike an FTP listing — can cheaply resolve it.
fn resolve_entry_metadata(
    path: &Path,
    is_symlink: bool,
    own_metadata: std::fs::Metadata,
) -> (std::fs::Metadata, bool) {
    if is_symlink {
        match std::fs::metadata(path) {
            Ok(target) => {
                let is_dir = target.is_dir();
                (target, is_dir)
            }
            // Dangling or looping link: keep the link's own metadata, not a dir.
            Err(_) => (own_metadata, false),
        }
    } else {
        let is_dir = own_metadata.is_dir();
        (own_metadata, is_dir)
    }
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

/// [`FileBrowser`](super::browser::FileBrowser) capability for the local
/// filesystem.
///
/// A thin wrapper around the local filesystem operations (`list_dir_sync` /
/// `stat_sync`, blocking I/O offloaded to `spawn_blocking`) that implements the
/// `FileBrowser` capability returned by `ConnectionType::file_browser()`. It is
/// the single local-filesystem file capability across desktop and agent (#2104);
/// each method expands a leading `~` so callers can pass `~`-relative paths.
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

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<(), FileError> {
        set_permissions_impl(&expand_tilde_only(path), mode).await
    }
}

/// Apply Unix permission bits to a local path (Unix only).
#[cfg(unix)]
async fn set_permissions_impl(path: &str, mode: u32) -> Result<(), FileError> {
    use std::os::unix::fs::PermissionsExt;
    let path = path.to_string();
    tokio::task::spawn_blocking(move || {
        // Only the low 12 mode bits (permissions + setuid/setgid/sticky) are
        // meaningful for `chmod`; higher (file-type) bits are masked off.
        let perms = std::fs::Permissions::from_mode(mode & 0o7777);
        std::fs::set_permissions(&path, perms).map_err(|e| map_io_error(e, &path))
    })
    .await
    .map_err(|e| FileError::OperationFailed(e.to_string()))?
}

/// On non-Unix platforms there is no `rwx` permission model to set.
#[cfg(not(unix))]
async fn set_permissions_impl(_path: &str, _mode: u32) -> Result<(), FileError> {
    Err(FileError::NotSupported)
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

    #[cfg(unix)]
    #[tokio::test]
    async fn set_permissions_changes_local_mode() {
        use super::super::browser::FileBrowser;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("script.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let browser = LocalFileBrowser::new();
        browser
            .set_permissions(file.to_str().unwrap(), 0o755)
            .await
            .unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        // Only the low 12 bits are the chmod payload; the file-type bits vary.
        assert_eq!(mode & 0o7777, 0o755);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_permissions_masks_high_bits() {
        use super::super::browser::FileBrowser;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();

        let browser = LocalFileBrowser::new();
        // Pass a full stat-style mode (0o100600): the S_IFREG type bits must be
        // masked off, leaving just 0o600.
        browser
            .set_permissions(file.to_str().unwrap(), 0o100600)
            .await
            .unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, 0o600);
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
    fn list_dir_sync_symlink_to_directory_is_navigable() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("real_dir")).unwrap();
        symlink(dir.path().join("real_dir"), dir.path().join("dir_link")).unwrap();

        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();

        let link = entries.iter().find(|e| e.name == "dir_link").unwrap();
        assert!(link.is_symlink, "dir_link should be flagged as a symlink");
        assert!(
            link.is_directory,
            "a symlink pointing at a directory must be navigable-as-directory"
        );
        assert!(
            link.symlink_target
                .as_deref()
                .unwrap()
                .ends_with("real_dir"),
            "target should point at real_dir, got {:?}",
            link.symlink_target
        );
    }

    /// Full CORE-037 fixture: a real dir, a symlink→dir, a symlink→file and a
    /// dangling symlink must each be labelled correctly, and the single bad
    /// (dangling) link must never abort the whole listing.
    #[cfg(unix)]
    #[test]
    fn list_dir_sync_labels_every_symlink_kind() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();

        // (a) a real directory
        std::fs::create_dir(dir.path().join("real_dir")).unwrap();
        // (b) a symlink pointing to that directory
        symlink(dir.path().join("real_dir"), dir.path().join("dir_link")).unwrap();
        // (c) a symlink pointing to a regular file
        std::fs::write(dir.path().join("real_file"), "hi").unwrap();
        symlink(dir.path().join("real_file"), dir.path().join("file_link")).unwrap();
        // (d) a dangling symlink (target never exists)
        symlink(
            dir.path().join("does_not_exist"),
            dir.path().join("dangling_link"),
        )
        .unwrap();

        let entries = list_dir_sync(dir.path().to_str().unwrap()).unwrap();

        let real_dir = entries.iter().find(|e| e.name == "real_dir").unwrap();
        assert!(real_dir.is_directory);
        assert!(!real_dir.is_symlink);
        assert_eq!(real_dir.symlink_target, None);

        let dir_link = entries.iter().find(|e| e.name == "dir_link").unwrap();
        assert!(dir_link.is_symlink);
        assert!(dir_link.is_directory, "symlink→dir is a directory");
        assert!(dir_link.symlink_target.is_some());

        let file_link = entries.iter().find(|e| e.name == "file_link").unwrap();
        assert!(file_link.is_symlink);
        assert!(!file_link.is_directory, "symlink→file is not a directory");
        assert!(file_link.symlink_target.is_some());

        let dangling = entries.iter().find(|e| e.name == "dangling_link").unwrap();
        assert!(dangling.is_symlink, "a dangling link is still a symlink");
        assert!(
            !dangling.is_directory,
            "an unresolvable symlink is not a directory"
        );
        assert!(
            dangling.symlink_target.is_some(),
            "the link text is recorded even when the target is missing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stat_sync_symlink_to_directory_is_navigable() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("real_dir")).unwrap();
        let link_path = dir.path().join("dir_link");
        symlink(dir.path().join("real_dir"), &link_path).unwrap();

        let entry = stat_sync(link_path.to_str().unwrap()).unwrap();
        assert!(entry.is_symlink);
        assert!(entry.is_directory, "symlink→dir must stat as a directory");
        assert!(entry.symlink_target.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn stat_sync_dangling_symlink_does_not_error() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let link_path = dir.path().join("dangling_link");
        symlink(dir.path().join("does_not_exist"), &link_path).unwrap();

        // Following the target would fail (NotFound); stat must still succeed by
        // describing the link itself.
        let entry = stat_sync(link_path.to_str().unwrap()).unwrap();
        assert!(entry.is_symlink);
        assert!(!entry.is_directory);
        assert!(entry.symlink_target.is_some());
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
        let entries = browser
            .list_dir(dir.path().to_str().unwrap())
            .await
            .unwrap();
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
        let entries = browser
            .list_dir("~")
            .await
            .expect("listing '~' should work");
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
        assert_eq!(
            entry.path, home,
            "stat path should be the expanded home dir"
        );
        assert!(entry.is_directory);
    }

    #[test]
    fn browser_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Box<dyn FileBrowser>>();
        assert_send::<LocalFileBrowser>();
    }
}
