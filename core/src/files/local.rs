use std::path::Path;

use super::utils::{chrono_from_epoch, normalize_path_separators};
use super::FileEntry;

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

        let full_path =
            normalize_path_separators(&entry.path().to_string_lossy());

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
}
