//! Connection-scoped file browsing for the agent.
//!
//! Each connection type (local, docker, ssh) provides its own implementation
//! of the [`FileBackend`] trait. The dispatcher resolves which backend to use
//! based on the connection's `session_type`.

pub mod docker;
pub mod local;
pub mod ssh;

use crate::protocol::methods::{FileEntry, FilesStatResult};

/// Errors from file operations, mapped to JSON-RPC error codes by the dispatcher.
#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("File not found: {0}")]
    NotFound(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("File operation failed: {0}")]
    OperationFailed(String),

    #[error("File browsing not supported for this connection type")]
    NotSupported,
}

/// Trait for connection-scoped file operations.
///
/// Each connection type (local, docker, ssh) provides its own implementation.
/// All methods are async to support network-based backends (SFTP, docker exec).
/// Uses `#[async_trait]` for dyn compatibility in the dispatcher.
#[async_trait::async_trait]
pub trait FileBackend: Send + Sync {
    /// List directory contents at the given path.
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError>;

    /// Read file content, returning raw bytes.
    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError>;

    /// Write raw bytes to a file, creating or overwriting.
    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError>;

    /// Delete a file or directory.
    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError>;

    /// Rename/move a file or directory.
    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError>;

    /// Get metadata for a single file/directory.
    async fn stat(&self, path: &str) -> Result<FilesStatResult, FileError>;
}

// ── Utility functions ──────────────────────────────────────────────

/// Format a Unix timestamp (seconds since epoch) as ISO 8601.
pub fn chrono_from_epoch(secs: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let dt = UNIX_EPOCH + Duration::from_secs(secs);
    match dt.duration_since(UNIX_EPOCH) {
        Ok(d) => {
            let total_secs = d.as_secs();
            let days = total_secs / 86400;
            let remaining = total_secs % 86400;
            let hours = remaining / 3600;
            let minutes = (remaining % 3600) / 60;
            let seconds = remaining % 60;

            let (year, month, day) = days_to_ymd(days);
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                year, month, day, hours, minutes, seconds
            )
        }
        Err(_) => String::new(),
    }
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Format Unix permission bits as rwxrwxrwx string.
pub fn format_permissions(perm: u32) -> String {
    let mut s = String::with_capacity(9);
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in bits {
        if perm & bit != 0 {
            s.push(ch);
        } else {
            s.push('-');
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_permissions_755() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
    }

    #[test]
    fn format_permissions_644() {
        assert_eq!(format_permissions(0o644), "rw-r--r--");
    }

    #[test]
    fn format_permissions_000() {
        assert_eq!(format_permissions(0o000), "---------");
    }

    #[test]
    fn chrono_from_epoch_zero() {
        assert_eq!(chrono_from_epoch(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn chrono_from_epoch_known_timestamp() {
        // 2024-01-15 12:30:45 UTC = 1705321845
        assert_eq!(chrono_from_epoch(1705321845), "2024-01-15T12:30:45Z");
    }
}
