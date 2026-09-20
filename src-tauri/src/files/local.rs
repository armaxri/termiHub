use crate::utils::errors::TerminalError;
use termihub_core::files::FileEntry;

/// List directory contents, filtering out `.` and `..`.
///
/// Delegates to `termihub_core::files::local::list_dir_sync()` which also
/// sorts results (directories first, then by name case-insensitively).
pub fn list_dir(path: &str) -> Result<Vec<FileEntry>, TerminalError> {
    Ok(termihub_core::files::local::list_dir_sync(path)?)
}

/// Create a directory.
///
/// Delegates to `termihub_core::files::local::mkdir_sync()` — `create_dir` (a
/// single directory, no parents), so an existing name or missing parent surfaces
/// an error, which the "New Folder" UI relies on.
pub fn mkdir(path: &str) -> Result<(), TerminalError> {
    termihub_core::files::local::mkdir_sync(path)?;
    Ok(())
}

/// Delete a file or directory.
///
/// Delegates to `termihub_core::files::local::delete_sync()`; the `is_directory`
/// flag selects `remove_dir_all` vs `remove_file`.
pub fn delete(path: &str, is_directory: bool) -> Result<(), TerminalError> {
    termihub_core::files::local::delete_sync(path, is_directory)?;
    Ok(())
}

/// Rename a file or directory.
///
/// Delegates to `termihub_core::files::local::rename_sync()`.
pub fn rename(old_path: &str, new_path: &str) -> Result<(), TerminalError> {
    termihub_core::files::local::rename_sync(old_path, new_path)?;
    Ok(())
}

/// Change the permission bits (chmod) of a local file or directory.
///
/// `mode` is the low 12 bits of a Unix mode (e.g. `0o755`); higher (file-type)
/// bits are masked off. Unix only — on other platforms there is no `rwx`
/// permission model, so it returns an unsupported error.
#[cfg(unix)]
pub fn set_permissions(path: &str, mode: u32) -> Result<(), TerminalError> {
    termihub_core::files::local::set_permissions_sync(path, mode)?;
    Ok(())
}

/// Non-Unix stub: no `rwx` permission model to change.
#[cfg(not(unix))]
pub fn set_permissions(_path: &str, _mode: u32) -> Result<(), TerminalError> {
    Err(TerminalError::EditorError(
        "Changing permissions is not supported on this platform".to_string(),
    ))
}

/// Change the owner (`uid`) and/or group (`gid`) of a local file or directory.
///
/// A `None` id leaves that side unchanged. Unix only — other platforms have no
/// numeric-owner model, so it returns an unsupported error.
#[cfg(unix)]
pub fn set_owner(path: &str, uid: Option<u32>, gid: Option<u32>) -> Result<(), TerminalError> {
    termihub_core::files::local::set_owner_sync(path, uid, gid)?;
    Ok(())
}

/// Non-Unix stub: no numeric-owner model to change.
#[cfg(not(unix))]
pub fn set_owner(_path: &str, _uid: Option<u32>, _gid: Option<u32>) -> Result<(), TerminalError> {
    Err(TerminalError::EditorError(
        "Changing ownership is not supported on this platform".to_string(),
    ))
}

/// Create a symbolic link at `link_path` pointing at `target`.
///
/// Unix only — local symlink creation on other platforms needs elevated
/// privileges and a file-vs-dir choice this op does not carry, so it returns an
/// unsupported error there.
#[cfg(unix)]
pub fn create_symlink(target: &str, link_path: &str) -> Result<(), TerminalError> {
    termihub_core::files::local::create_symlink_sync(target, link_path)?;
    Ok(())
}

/// Non-Unix stub: local symlink creation is not supported.
#[cfg(not(unix))]
pub fn create_symlink(_target: &str, _link_path: &str) -> Result<(), TerminalError> {
    Err(TerminalError::EditorError(
        "Creating symlinks is not supported on this platform".to_string(),
    ))
}

/// Copy a file or directory to a new location.
///
/// Delegates to `termihub_core::files::local::copy_sync()`, the single home for
/// the recursive local copy (DUP-024): files use `std::fs::copy` (creating
/// missing parent directories), directories are copied recursively with nested
/// symlinks recreated verbatim.
pub fn copy_file(src: &str, dest: &str, is_directory: bool) -> Result<(), TerminalError> {
    termihub_core::files::local::copy_sync(src, dest, is_directory)?;
    Ok(())
}

/// Return the current user's home directory.
pub fn home_dir() -> Result<String, TerminalError> {
    use termihub_core::config::home_directory;
    use termihub_core::files::utils::normalize_platform_path;
    home_directory()
        .map(|p| normalize_platform_path(&p.to_string_lossy()))
        .ok_or_else(|| {
            TerminalError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "home directory not found (HOME / USERPROFILE not set)",
            ))
        })
}

/// Read a file's contents as a UTF-8 string.
pub fn read_file_content(path: &str) -> Result<String, TerminalError> {
    std::fs::read_to_string(path).map_err(TerminalError::Io)
}

/// Get metadata (including size) for a single local file or directory.
///
/// Cheap metadata-only lookup used by the editor's large-file guard (#PROD-014,
/// #PERF-002): the frontend stats before reading so it can warn instead of
/// blindly loading a huge file into Monaco. Mirrors the remote `session_stat`
/// path so both transports share one guard.
pub fn stat(path: &str) -> Result<FileEntry, TerminalError> {
    use termihub_core::errors::FileError;
    termihub_core::files::local::stat_sync(path).map_err(|e| match e {
        FileError::NotFound(p) => TerminalError::NotFound(p),
        other => TerminalError::EditorError(other.to_string()),
    })
}

/// Write a string to a file, creating or overwriting it.
pub fn write_file_content(path: &str, content: &str) -> Result<(), TerminalError> {
    std::fs::write(path, content).map_err(TerminalError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dir_empty() {
        let dir = tempfile::tempdir().unwrap();
        let entries = list_dir(dir.path().to_str().unwrap()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn list_dir_returns_files_with_metadata() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "world").unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = list_dir(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 2);

        let file_entry = entries.iter().find(|e| e.name == "hello.txt").unwrap();
        assert!(!file_entry.is_directory);
        assert_eq!(file_entry.size, 5);

        let dir_entry = entries.iter().find(|e| e.name == "subdir").unwrap();
        assert!(dir_entry.is_directory);
    }

    #[test]
    fn stat_returns_file_size() {
        // Backs the editor's large-file guard (#PROD-014 / #PERF-002): the
        // frontend stats before reading so it can warn on an oversized file.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hello.txt");
        std::fs::write(&file, "world!").unwrap();

        let e = stat(file.to_str().unwrap()).unwrap();
        assert_eq!(e.name, "hello.txt");
        assert!(!e.is_directory);
        assert_eq!(e.size, 6);
    }

    #[test]
    fn stat_missing_path_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.txt");
        let err = stat(missing.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, TerminalError::NotFound(_)));
    }

    #[test]
    fn mkdir_creates_directory() {
        let dir = tempfile::tempdir().unwrap();
        let new_dir = dir.path().join("new_dir");
        mkdir(new_dir.to_str().unwrap()).unwrap();
        assert!(new_dir.is_dir());
    }

    #[test]
    fn delete_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("to_delete.txt");
        std::fs::write(&file, "delete me").unwrap();
        assert!(file.exists());

        delete(file.to_str().unwrap(), false).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn delete_removes_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("to_delete_dir");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("inner.txt"), "inner").unwrap();

        delete(sub.to_str().unwrap(), true).unwrap();
        assert!(!sub.exists());
    }

    #[test]
    fn rename_moves_file() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.txt");
        let new_path = dir.path().join("new.txt");
        std::fs::write(&old, "content").unwrap();

        rename(old.to_str().unwrap(), new_path.to_str().unwrap()).unwrap();
        assert!(!old.exists());
        assert!(new_path.exists());
        assert_eq!(std::fs::read_to_string(&new_path).unwrap(), "content");
    }

    #[cfg(unix)]
    #[test]
    fn set_permissions_changes_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("run.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();

        set_permissions(file.to_str().unwrap(), 0o755).unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn set_owner_to_current_ids_is_a_safe_no_op() {
        // chown to the file's *current* owner succeeds without privilege, exercising
        // the desktop wrapper's delegation to the core sync chown without needing
        // root or a `libc` dependency in this crate.
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("owned.txt");
        std::fs::write(&file, "x").unwrap();
        let meta = std::fs::metadata(&file).unwrap();

        set_owner(file.to_str().unwrap(), Some(meta.uid()), Some(meta.gid())).unwrap();
        // A no-op (both None) still succeeds.
        set_owner(file.to_str().unwrap(), None, None).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn create_symlink_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.txt");
        std::fs::write(&target, "hi").unwrap();
        let link = dir.path().join("link.txt");

        create_symlink(target.to_str().unwrap(), link.to_str().unwrap()).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
    }

    #[test]
    fn copy_file_delegates_to_core() {
        // Thorough copy edge cases (recursive dirs, nested symlinks, parent-dir
        // creation) are covered once in `core::files::local`; this only smoke
        // -tests the desktop wrapper's delegation.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.txt");
        let dest = dir.path().join("dest.txt");
        std::fs::write(&src, "copy me").unwrap();

        copy_file(src.to_str().unwrap(), dest.to_str().unwrap(), false).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "copy me");
        // Source should still exist (it's a copy, not move)
        assert!(src.exists());
    }

    #[test]
    fn home_dir_returns_non_empty_absolute_path() {
        let home = home_dir().unwrap();
        assert!(!home.is_empty());
        assert!(std::path::Path::new(&home).is_absolute());
    }

    #[test]
    fn read_write_file_content_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("roundtrip.txt");
        let path = file.to_str().unwrap();

        write_file_content(path, "Hello, World!").unwrap();
        let content = read_file_content(path).unwrap();
        assert_eq!(content, "Hello, World!");
    }
}
