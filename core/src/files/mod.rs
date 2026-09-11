pub mod browser;
pub mod local;
pub mod utils;

pub use browser::FileBrowser;
pub use local::LocalFileBrowser;

use serde::{Deserialize, Serialize};

use crate::errors::FileError;

/// Hard ceiling on the number of bytes a single in-memory remote file read may
/// buffer (CORE-013).
///
/// The remote file readers (SFTP and Docker) pull the whole file into a `Vec`,
/// so an unbounded read of a huge — or hostile — file can exhaust host memory
/// and OOM the app. This cap is defense-in-depth *behind* the frontend
/// large-file guard (which warns around ~10 MiB and lets the user "Open
/// anyway"): it is set generously above that threshold so a legitimate
/// "Open anyway" on a moderately large file (tens of MiB) still works, while a
/// pathological multi-GB file is rejected with a clean [`FileError::TooLarge`]
/// instead of a panic or an out-of-memory crash.
///
/// Shared by every remote backend so the size policy can never drift between
/// the SFTP and Docker paths (the finding's "share one size policy" point).
pub const MAX_REMOTE_READ_BYTES: u64 = 256 * 1024 * 1024;

/// Reject an in-memory read whose size exceeds [`MAX_REMOTE_READ_BYTES`].
///
/// Callers `stat` the remote file first and pass the reported size here to fail
/// fast before streaming anything; the streaming read then re-checks the bytes
/// actually received, so a server that under-reports its size cannot slip past
/// the cap. Returns [`FileError::TooLarge`] carrying the offending size and the
/// limit, never a panic.
pub fn check_read_size(size: u64) -> Result<(), FileError> {
    if size > MAX_REMOTE_READ_BYTES {
        Err(FileError::TooLarge {
            size,
            limit: MAX_REMOTE_READ_BYTES,
        })
    } else {
        Ok(())
    }
}

/// A file or directory entry returned by file browsing operations.
///
/// This is the unified structure used by both the desktop and agent crates.
/// Field names are serialized as camelCase for the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    /// ISO 8601 timestamp.
    pub modified: String,
    /// Unix "rwxrwxrwx" format, `None` when not available.
    pub permissions: Option<String>,
    /// Cheap, conservative writability hint derived from the permission string
    /// (see [`utils::writable_from_permissions`]): `Some(false)` only when *no*
    /// class may write, `Some(true)` when at least one may, `None` when unknown
    /// (permissions absent or the backend does not derive it). The authoritative
    /// answer for a specific file comes from an SFTP write-open probe.
    pub writable: Option<bool>,
    /// True when this entry is a symbolic link. Populated by backends that can
    /// tell cheaply (the FTP listing parser, and the local filesystem browsers
    /// via `symlink_metadata`); `false` otherwise. `#[serde(default)]` keeps
    /// older persisted/round-tripped JSON without the field deserializing.
    #[serde(default)]
    pub is_symlink: bool,
    /// The link target, when the backend could determine it cheaply — e.g. the
    /// `-> target` suffix of a Unix `ls -l` FTP line, or `read_link` for a local
    /// entry. `None` for non-links and for formats that do not carry a target
    /// (MLSD `type=link`, SFTP `readdir`). `#[serde(default)]` for compatibility.
    #[serde(default)]
    pub symlink_target: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::FileEntry;

    #[test]
    fn symlink_fields_serialize_camel_case() {
        let entry = FileEntry {
            name: "link".to_string(),
            path: "/pub/link".to_string(),
            is_symlink: true,
            symlink_target: Some("target".to_string()),
            ..Default::default()
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["isSymlink"], true);
        assert_eq!(v["symlinkTarget"], "target");
        // snake_case keys must never appear.
        assert!(v.get("is_symlink").is_none());
        assert!(v.get("symlink_target").is_none());
    }

    #[test]
    fn old_json_without_symlink_fields_deserializes() {
        // A payload persisted before the symlink fields existed must still
        // deserialize, defaulting `is_symlink`/`symlink_target`.
        let json = serde_json::json!({
            "name": "file.txt",
            "path": "/file.txt",
            "isDirectory": false,
            "size": 12,
            "modified": "2026-01-01T00:00:00Z",
            "permissions": "rw-r--r--",
            "writable": true
        });
        let entry: FileEntry = serde_json::from_value(json).unwrap();
        assert_eq!(entry.name, "file.txt");
        assert!(!entry.is_symlink);
        assert_eq!(entry.symlink_target, None);
    }

    // --- read-size cap (CORE-013) ---

    use super::{check_read_size, MAX_REMOTE_READ_BYTES};
    use crate::errors::FileError;

    #[test]
    fn check_read_size_allows_under_and_at_the_cap() {
        // A small file, a mid-size "Open anyway" file, and a file exactly at the
        // cap must all pass — the guard only rejects what is strictly larger.
        assert!(check_read_size(0).is_ok());
        assert!(check_read_size(50 * 1024 * 1024).is_ok());
        assert!(check_read_size(MAX_REMOTE_READ_BYTES).is_ok());
    }

    #[test]
    fn check_read_size_rejects_over_the_cap_with_a_typed_error() {
        // A pathological multi-GB file is rejected cleanly (never OOM/panic) with
        // a typed error carrying both the offending size and the limit.
        let size = MAX_REMOTE_READ_BYTES + 1;
        match check_read_size(size) {
            Err(FileError::TooLarge { size: got, limit }) => {
                assert_eq!(got, size);
                assert_eq!(limit, MAX_REMOTE_READ_BYTES);
            }
            other => panic!("expected TooLarge, got {other:?}"),
        }

        // A hostile multi-GB advertisement is likewise rejected, not attempted.
        assert!(matches!(
            check_read_size(8 * 1024 * 1024 * 1024),
            Err(FileError::TooLarge { .. })
        ));
    }

    #[test]
    fn read_cap_is_generously_above_the_frontend_warn_threshold() {
        // The frontend large-file guard warns around 10 MiB; the backend cap must
        // sit well above it so a legitimate "Open anyway" on a tens-of-MiB file
        // still succeeds while multi-GB files are stopped.
        const _: () = assert!(MAX_REMOTE_READ_BYTES >= 128 * 1024 * 1024);
    }
}
