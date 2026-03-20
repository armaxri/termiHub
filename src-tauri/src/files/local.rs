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
pub fn mkdir(path: &str) -> Result<(), TerminalError> {
    std::fs::create_dir(path)?;
    Ok(())
}

/// Delete a file or directory.
pub fn delete(path: &str, is_directory: bool) -> Result<(), TerminalError> {
    if is_directory {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Rename a file or directory.
pub fn rename(old_path: &str, new_path: &str) -> Result<(), TerminalError> {
    std::fs::rename(old_path, new_path)?;
    Ok(())
}

/// Copy a file or directory to a new location.
///
/// For files, uses `std::fs::copy`. For directories, performs a recursive copy
/// preserving the directory structure.
pub fn copy_file(src: &str, dest: &str, is_directory: bool) -> Result<(), TerminalError> {
    if is_directory {
        copy_dir_recursive(std::path::Path::new(src), std::path::Path::new(dest))
    } else {
        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(dest).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dest)?;
        Ok(())
    }
}

/// Recursively copy a directory and all its contents.
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), TerminalError> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Return the current user's home directory.
pub fn home_dir() -> Result<String, TerminalError> {
    use termihub_core::files::utils::normalize_platform_path;
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(|p| normalize_platform_path(&p))
        .map_err(|e| TerminalError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, e)))
}

/// Read a file's contents as a UTF-8 string.
pub fn read_file_content(path: &str) -> Result<String, TerminalError> {
    std::fs::read_to_string(path).map_err(TerminalError::Io)
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

    #[test]
    fn copy_file_preserves_content() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.txt");
        let dest = dir.path().join("dest.txt");
        std::fs::write(&src, "copy me").unwrap();

        copy_file(src.to_str().unwrap(), dest.to_str().unwrap(), false).unwrap();
        assert!(dest.exists());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "copy me");
        // Source should still exist (it's a copy, not move)
        assert!(src.exists());
    }

    #[test]
    fn copy_directory_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src_dir");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("file.txt"), "hello").unwrap();
        std::fs::write(src.join("sub/nested.txt"), "nested").unwrap();

        let dest = dir.path().join("dest_dir");
        copy_file(src.to_str().unwrap(), dest.to_str().unwrap(), true).unwrap();

        assert!(dest.is_dir());
        assert_eq!(
            std::fs::read_to_string(dest.join("file.txt")).unwrap(),
            "hello"
        );
        assert!(dest.join("sub").is_dir());
        assert_eq!(
            std::fs::read_to_string(dest.join("sub/nested.txt")).unwrap(),
            "nested"
        );
        // Source should still exist
        assert!(src.is_dir());
    }

    #[test]
    fn copy_file_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.txt");
        let dest = dir.path().join("a/b/c/dest.txt");
        std::fs::write(&src, "deep copy").unwrap();

        copy_file(src.to_str().unwrap(), dest.to_str().unwrap(), false).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "deep copy");
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
