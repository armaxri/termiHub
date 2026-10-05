//! Offset-addressed file access for chunked, resumable transfers (#3587).
//!
//! The queued transfer executors (`files::transfer`) normally run in the same
//! process as the backend they copy through — an SFTP channel, a `docker exec`
//! stream. An agent-hosted session's backend lives on the agent host, so the
//! desktop can only reach it one request at a time over `connection.files.*`.
//! [`RangedFileAccess`] is the small primitive that makes that enough: read a
//! bounded slice at an offset, and write a slice at an offset that must equal
//! the bytes already there. Each call is self-contained, so pause, resume,
//! retry and cancel are decided entirely by the caller holding the offset.
//!
//! A backend exposes it through
//! [`FileBrowser::ranged`](super::FileBrowser::ranged); a backend that returns
//! `None` keeps whole-file reads and writes only.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use crate::errors::FileError;

/// Largest slice one [`RangedFileAccess`] call moves. Equal to the transfer
/// chunk size, and small enough that its base64 form fits comfortably in one
/// agent JSON-RPC message (the agent caps an incoming line at 1 MiB).
pub const MAX_RANGE_BYTES: u32 = 256 * 1024;

/// Offset-addressed reads and writes on one backend (#3587).
///
/// Semantics every implementation follows:
///
/// - [`read_range`](Self::read_range) returns at most `len` bytes starting at
///   `offset`. Fewer than `len` bytes (including none) means the end of the
///   file was reached. An offset past the end returns no bytes.
/// - [`write_range`](Self::write_range) with `offset == 0` creates the file or
///   truncates it, then writes `data`. With `offset > 0` the file must already
///   hold exactly `offset` bytes — otherwise the call fails without writing —
///   and `data` is appended. This makes a retried or resumed upload safe: a
///   chunk can never land on top of, or leave a gap after, the bytes already
///   there.
#[async_trait::async_trait]
pub trait RangedFileAccess: Send + Sync {
    /// Read at most `len` bytes of `path` from `offset`.
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError>;

    /// Write `data` to `path` at `offset` (see the trait docs for the rules).
    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError>;
}

/// The error a [`RangedFileAccess::write_range`] reports when the file does not
/// hold exactly `offset` bytes.
pub fn offset_mismatch(path: &str, present: u64, offset: u64) -> FileError {
    FileError::OperationFailed(format!(
        "{path}: destination holds {present} bytes, expected {offset}; refusing to write"
    ))
}

fn io_error(e: std::io::Error, path: &str) -> FileError {
    match e.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound(path.to_string()),
        std::io::ErrorKind::PermissionDenied => FileError::PermissionDenied(path.to_string()),
        _ => FileError::OperationFailed(format!("{path}: {e}")),
    }
}

/// [`RangedFileAccess::read_range`] for a filesystem path (local disk, a WSL
/// UNC share). `label` names the file in errors.
pub async fn fs_read_range(
    path: PathBuf,
    label: String,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, FileError> {
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path).map_err(|e| io_error(e, &label))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| io_error(e, &label))?;
        let mut buf = Vec::with_capacity(len as usize);
        file.take(u64::from(len))
            .read_to_end(&mut buf)
            .map_err(|e| io_error(e, &label))?;
        Ok(buf)
    })
    .await
    .map_err(|e| FileError::OperationFailed(e.to_string()))?
}

/// [`RangedFileAccess::write_range`] for a filesystem path (local disk, a WSL
/// UNC share). `label` names the file in errors.
pub async fn fs_write_range(
    path: PathBuf,
    label: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<(), FileError> {
    tokio::task::spawn_blocking(move || {
        let mut file = if offset == 0 {
            std::fs::File::create(&path).map_err(|e| io_error(e, &label))?
        } else {
            let file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .map_err(|e| io_error(e, &label))?;
            let present = file.metadata().map_err(|e| io_error(e, &label))?.len();
            if present != offset {
                return Err(offset_mismatch(&label, present, offset));
            }
            file
        };
        file.write_all(&data).map_err(|e| io_error(e, &label))?;
        file.flush().map_err(|e| io_error(e, &label))
    })
    .await
    .map_err(|e| FileError::OperationFailed(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        (dir, path)
    }

    fn label(path: &std::path::Path) -> String {
        path.display().to_string()
    }

    #[tokio::test]
    async fn read_range_returns_the_slice_and_a_short_read_at_eof() {
        let (_dir, path) = temp("f");
        std::fs::write(&path, b"0123456789").unwrap();
        let l = label(&path);
        assert_eq!(
            fs_read_range(path.clone(), l.clone(), 2, 3).await.unwrap(),
            b"234"
        );
        assert_eq!(
            fs_read_range(path.clone(), l.clone(), 8, 5).await.unwrap(),
            b"89"
        );
        assert!(fs_read_range(path.clone(), l.clone(), 10, 5)
            .await
            .unwrap()
            .is_empty());
        assert!(fs_read_range(path, l, 99, 5).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn read_range_of_a_missing_file_is_not_found() {
        let (_dir, path) = temp("missing");
        let l = label(&path);
        assert!(matches!(
            fs_read_range(path, l, 0, 4).await,
            Err(FileError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn write_range_truncates_at_zero_and_appends_at_the_exact_size() {
        let (_dir, path) = temp("f");
        std::fs::write(&path, b"old contents").unwrap();
        let l = label(&path);
        fs_write_range(path.clone(), l.clone(), 0, b"abc".to_vec())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        fs_write_range(path.clone(), l, 3, b"def".to_vec())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
    }

    #[tokio::test]
    async fn write_range_refuses_an_offset_that_is_not_the_current_size() {
        let (_dir, path) = temp("f");
        std::fs::write(&path, b"abcdef").unwrap();
        let l = label(&path);
        // Behind the end: would overwrite bytes already there.
        let err = fs_write_range(path.clone(), l.clone(), 4, b"X".to_vec())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("holds 6 bytes, expected 4"),
            "{err}"
        );
        // Past the end: would leave a gap.
        assert!(fs_write_range(path.clone(), l, 9, b"X".to_vec())
            .await
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
    }

    #[tokio::test]
    async fn write_range_at_an_offset_needs_an_existing_file() {
        let (_dir, path) = temp("missing");
        let l = label(&path);
        assert!(matches!(
            fs_write_range(path, l, 3, b"X".to_vec()).await,
            Err(FileError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn write_range_of_nothing_at_zero_creates_an_empty_file() {
        let (_dir, path) = temp("empty");
        let l = label(&path);
        fs_write_range(path.clone(), l, 0, Vec::new())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");
    }
}
