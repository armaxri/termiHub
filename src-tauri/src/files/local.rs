use std::path::Path;

use super::FileEntry;
use super::utils::chrono_from_epoch;
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
    use std::os::unix::fs::PermissionsExt;
    use super::utils::format_permissions;
    Some(format_permissions(metadata.permissions().mode()))
}

/// On non-Unix platforms, permissions are not available in rwx format.
#[cfg(not(unix))]
fn get_permissions(_metadata: &std::fs::Metadata) -> Option<String> {
    None
}

/// Read a file's contents as a UTF-8 string.
pub fn read_file_content(path: &str) -> Result<String, TerminalError> {
    std::fs::read_to_string(path).map_err(TerminalError::Io)
}

/// Write a string to a file, creating or overwriting it.
pub fn write_file_content(path: &str, content: &str) -> Result<(), TerminalError> {
    std::fs::write(path, content).map_err(TerminalError::Io)
}
