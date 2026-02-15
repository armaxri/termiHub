use std::path::Path;

use super::utils::chrono_from_epoch;
use super::FileEntry;
use crate::utils::errors::TerminalError;

/// List directory contents, filtering out `.` and `..`.
pub fn list_dir(path: &str) -> Result<Vec<FileEntry>, TerminalError> {
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

/// Return the current user's home directory.
pub fn home_dir() -> Result<String, TerminalError> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
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
