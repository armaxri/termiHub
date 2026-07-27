//! Shared russh-sftp mechanics consumed by every SFTP path in the workspace.
//!
//! Two SFTP implementations historically forked the same low-level russh-sftp
//! plumbing: the core [`SftpFileBrowser`](super::file_browser) (the
//! [`FileBrowser`](crate::files::FileBrowser) trait path) and the desktop
//! `SftpSession` / transfer subsystem in `src-tauri`. Both opened the SFTP
//! subsystem the same way and mapped `readdir` / `stat` attributes into
//! [`FileEntry`] with byte-for-byte identical logic (#2075). That duplication
//! is what let the two paths drift.
//!
//! This module holds that shared mechanism once so both consume it:
//!
//! * [`open_sftp_subsystem`] — open a fresh SFTP subsystem channel on an
//!   authenticated SSH session (also used by the desktop transfer subsystem's
//!   dedicated per-transfer channel and by `remote_exec`).
//! * [`list_dir`] / [`stat`] — turn russh-sftp attributes into [`FileEntry`]
//!   rows, including the best-effort `readlink` for symlink rows.
//!
//! Capabilities that remain desktop-only (elevated `sudo` writes, the write-open
//! writability probe, the transfer queue) stay in `src-tauri`; they are layered
//! *on top of* these shared primitives rather than forking them.

use russh_sftp::client::error::Error as RusshSftpError;
use russh_sftp::client::SftpSession as RusshSftp;
use russh_sftp::protocol::FileAttributes;

use crate::files::utils::{chrono_from_epoch, format_permissions, writable_from_permissions};
use crate::files::FileEntry;

use super::handler::SshSession;

/// Failure while opening an SFTP subsystem channel on an SSH session.
///
/// Distinguishes the three steps so callers can surface a precise message.
#[derive(Debug)]
pub enum OpenSftpError {
    /// Opening the SSH session channel failed.
    ChannelOpen(russh::Error),
    /// Requesting the `sftp` subsystem on the channel failed.
    Subsystem(russh::Error),
    /// The SFTP protocol handshake / init failed.
    Init(RusshSftpError),
}

impl std::fmt::Display for OpenSftpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenSftpError::ChannelOpen(e) => write!(f, "SFTP channel open failed: {e}"),
            OpenSftpError::Subsystem(e) => write!(f, "SFTP subsystem request failed: {e}"),
            OpenSftpError::Init(e) => write!(f, "SFTP init failed: {e}"),
        }
    }
}

impl std::error::Error for OpenSftpError {}

/// Open a **fresh** SFTP subsystem on the given authenticated SSH session.
///
/// Opens a new session channel, requests the `sftp` subsystem, and completes the
/// russh-sftp handshake. The returned [`RusshSftp`] owns its own channel, so
/// callers may open several independent SFTP sessions on one SSH connection
/// (e.g. the desktop transfer subsystem's dedicated per-transfer channel, #1245,
/// which runs a copy without holding the browsing channel's lock).
pub async fn open_sftp_subsystem(session: &SshSession) -> Result<RusshSftp, OpenSftpError> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(OpenSftpError::ChannelOpen)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(OpenSftpError::Subsystem)?;
    RusshSftp::new(channel.into_stream())
        .await
        .map_err(OpenSftpError::Init)
}

/// Build a [`FileEntry`] from russh-sftp [`FileAttributes`].
///
/// Shared by [`list_dir`] and [`stat`] so the desktop and core paths derive the
/// `permissions` string and the conservative `writable` hint identically. The
/// caller supplies the entry `name`, its full `path`, and any resolved
/// `symlink_target` (a directory-listing row resolves it via `readlink`; a
/// `stat` never does).
fn attrs_to_file_entry(
    name: String,
    path: String,
    meta: &FileAttributes,
    symlink_target: Option<String>,
) -> FileEntry {
    let permissions = meta.permissions.map(format_permissions);
    let writable = permissions.as_deref().and_then(writable_from_permissions);
    FileEntry {
        name,
        path,
        is_directory: meta.is_dir(),
        size: meta.size.unwrap_or(0),
        modified: meta
            .mtime
            .map(|t| chrono_from_epoch(t as u64))
            .unwrap_or_default(),
        permissions,
        writable,
        is_symlink: meta.is_symlink(),
        symlink_target,
    }
}

/// List a remote directory, mapping each row into a [`FileEntry`].
///
/// Filters out `.` and `..`. `read_dir` returns lstat-style attributes, so
/// `is_symlink` flags the link itself; for link rows only, the target is
/// resolved with a best-effort `read_link` (a plain file never triggers the
/// extra round-trip, and a failed `read_link` yields `None` rather than an
/// error). Errors from `read_dir` propagate as the native russh-sftp error so
/// each caller can wrap it in its own error type.
pub async fn list_dir(sftp: &RusshSftp, path: &str) -> Result<Vec<FileEntry>, RusshSftpError> {
    let entries = sftp.read_dir(path).await?;

    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let full_path = format!("{}/{}", path.trim_end_matches('/'), name);
        let symlink_target = if meta.is_symlink() {
            sftp.read_link(full_path.clone()).await.ok()
        } else {
            None
        };
        result.push(attrs_to_file_entry(name, full_path, &meta, symlink_target));
    }
    Ok(result)
}

/// Stat a single remote path, mapping the result into a [`FileEntry`].
///
/// `metadata` follows symlinks, so `is_symlink` reports the *target*'s type and
/// no link target is resolved. The error propagates as the native russh-sftp
/// error for the caller to wrap.
pub async fn stat(sftp: &RusshSftp, path: &str) -> Result<FileEntry, RusshSftpError> {
    let meta = sftp.metadata(path).await?;
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(attrs_to_file_entry(name, path.to_string(), &meta, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::FileMode;

    /// Build attributes with a raw permission bitmask (mode bits + type bits).
    fn attrs(perm: u32, size: u64, mtime: u32) -> FileAttributes {
        FileAttributes {
            size: Some(size),
            uid: None,
            user: None,
            gid: None,
            group: None,
            permissions: Some(perm),
            atime: None,
            mtime: Some(mtime),
        }
    }

    /// A regular file maps its permission string, a writable hint, size and
    /// mtime, and carries no symlink metadata.
    #[test]
    fn attrs_to_file_entry_regular_file() {
        // rw-r--r-- regular file.
        let perm = FileMode::REG.bits() | 0o644;
        let entry = attrs_to_file_entry(
            "notes.txt".to_string(),
            "/home/u/notes.txt".to_string(),
            &attrs(perm, 1234, 1_600_000_000),
            None,
        );
        assert_eq!(entry.name, "notes.txt");
        assert_eq!(entry.path, "/home/u/notes.txt");
        assert!(!entry.is_directory);
        assert_eq!(entry.size, 1234);
        assert_eq!(entry.permissions.as_deref(), Some("rw-r--r--"));
        // Owner-write present → conservative hint says writable.
        assert_eq!(entry.writable, Some(true));
        assert!(!entry.is_symlink);
        assert_eq!(entry.symlink_target, None);
        assert!(!entry.modified.is_empty());
    }

    /// A directory sets `is_directory` from the mode's DIR bit.
    #[test]
    fn attrs_to_file_entry_directory() {
        let perm = FileMode::DIR.bits() | 0o755;
        let entry = attrs_to_file_entry(
            "src".to_string(),
            "/home/u/src".to_string(),
            &attrs(perm, 4096, 1_600_000_000),
            None,
        );
        assert!(entry.is_directory);
        assert_eq!(entry.permissions.as_deref(), Some("rwxr-xr-x"));
    }

    /// A read-only-for-all file yields a `Some(false)` writable hint.
    #[test]
    fn attrs_to_file_entry_read_only_hint() {
        let perm = FileMode::REG.bits() | 0o444;
        let entry = attrs_to_file_entry(
            "ro".to_string(),
            "/ro".to_string(),
            &attrs(perm, 0, 0),
            None,
        );
        assert_eq!(entry.writable, Some(false));
    }

    /// A symlink row keeps the link flag and the caller-resolved target.
    #[test]
    fn attrs_to_file_entry_symlink_keeps_target() {
        let perm = FileMode::LNK.bits() | 0o777;
        let entry = attrs_to_file_entry(
            "link".to_string(),
            "/link".to_string(),
            &attrs(perm, 0, 0),
            Some("/real/target".to_string()),
        );
        assert!(entry.is_symlink);
        assert_eq!(entry.symlink_target.as_deref(), Some("/real/target"));
    }

    /// Absent permissions leave both the string and the writable hint `None`.
    #[test]
    fn attrs_to_file_entry_missing_permissions() {
        let meta = FileAttributes {
            size: None,
            uid: None,
            user: None,
            gid: None,
            group: None,
            permissions: None,
            atime: None,
            mtime: None,
        };
        let entry = attrs_to_file_entry("x".to_string(), "/x".to_string(), &meta, None);
        assert_eq!(entry.permissions, None);
        assert_eq!(entry.writable, None);
        // A missing size defaults to 0 and a missing mtime to the epoch default.
        assert_eq!(entry.size, 0);
    }

    /// `OpenSftpError` renders a distinct, step-identifying message per variant.
    #[test]
    fn open_sftp_error_messages_identify_the_step() {
        let init = OpenSftpError::Init(RusshSftpError::Timeout);
        assert!(init.to_string().starts_with("SFTP init failed:"));
    }
}
