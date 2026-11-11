//! Error mapping and safety checks for the SFTP attribute and copy operations
//! (chmod, chown, symlink, copy) of [`SftpFileBrowser`](super::SftpFileBrowser)
//! (#5320).
//!
//! These operations change the remote filesystem, so a refusal has to reach
//! the user as what it is. The server's `PERMISSION_DENIED` and
//! `NO_SUCH_FILE` statuses become [`FileError::PermissionDenied`] and
//! [`FileError::NotFound`]; every other failure stays an
//! [`FileError::OperationFailed`] that names the operation.
//!
//! A copy is also checked before any byte moves: a stream copy of a file onto
//! itself creates (truncates) the destination first, which is the source, so
//! it would empty the file and still report success. A folder copied into
//! itself would recurse into its own copy.

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;

use crate::errors::FileError;

/// One SFTP mutation, for the wording of its errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mutation {
    /// `setstat` with the permission bits.
    Chmod,
    /// `setstat` with uid/gid (and the `stat` that fills an unchanged side).
    Chown,
    /// `symlink`; the path is the new link.
    Symlink,
}

impl Mutation {
    /// What the user tried, as it reads after "Permission denied:".
    fn denied(self, path: &str) -> String {
        match self {
            Mutation::Chmod => format!("cannot change the permissions of {path}"),
            Mutation::Chown => format!("cannot change the owner of {path}"),
            Mutation::Symlink => format!("cannot create the symlink {path}"),
        }
    }

    /// Short operation name for an unclassified failure.
    fn name(self) -> &'static str {
        match self {
            Mutation::Chmod => "chmod",
            Mutation::Chown => "chown",
            Mutation::Symlink => "symlink",
        }
    }
}

/// Map a failed SFTP mutation on `path` to a [`FileError`].
pub(super) fn mutation_error(op: Mutation, path: &str, err: SftpError) -> FileError {
    match &err {
        SftpError::Status(status) if status.status_code == StatusCode::PermissionDenied => {
            FileError::PermissionDenied(op.denied(path))
        }
        SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile => {
            FileError::NotFound(path.to_string())
        }
        _ => FileError::OperationFailed(format!("{} {path} failed: {err}", op.name())),
    }
}

/// Why copying `src` (canonical) to `dest` (canonical) must be refused, if it
/// must: the same entry, or a folder copied into itself.
pub(super) fn copy_conflict(src: &str, dest: &str, src_is_dir: bool) -> Option<&'static str> {
    let src = src.trim_end_matches('/');
    let dest = dest.trim_end_matches('/');
    if src == dest {
        return Some("source and destination are the same file");
    }
    // The root folder trims to "", so every absolute path lies inside it.
    if src_is_dir && dest.starts_with(&format!("{src}/")) {
        return Some("the destination is inside the source folder");
    }
    None
}

/// Split a remote path into its parent folder and final name.
fn split_parent(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => (".", trimmed),
    }
}

/// Canonical form of a copy destination that may not exist yet: the path
/// itself when the server resolves it, else its resolved parent plus the
/// final name. `None` when neither resolves (the copy then reports its own
/// error).
async fn canonical_dest(sftp: &SftpSession, dest: &str) -> Option<String> {
    if let Ok(path) = sftp.canonicalize(dest).await {
        return Some(path);
    }
    let (parent, name) = split_parent(dest);
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let parent = sftp.canonicalize(parent).await.ok()?;
    Some(if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    })
}

/// Refuse a copy of `src` onto itself or of a folder into itself, before
/// anything is written. A path the server cannot resolve is not a refusal:
/// the copy then fails with its own, more specific error.
pub(super) async fn ensure_copy_allowed(
    sftp: &SftpSession,
    src: &str,
    dest: &str,
    src_is_dir: bool,
) -> Result<(), FileError> {
    let Ok(src_canon) = sftp.canonicalize(src).await else {
        return Ok(());
    };
    let Some(dest_canon) = canonical_dest(sftp, dest).await else {
        return Ok(());
    };
    match copy_conflict(&src_canon, &dest_canon, src_is_dir) {
        Some(reason) => Err(FileError::OperationFailed(format!(
            "copy {src} to {dest} refused: {reason}"
        ))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(code: StatusCode) -> SftpError {
        SftpError::Status(russh_sftp::protocol::Status {
            id: 0,
            status_code: code,
            error_message: "server says".to_string(),
            language_tag: String::new(),
        })
    }

    #[test]
    fn permission_denied_status_is_permission_denied_naming_the_path() {
        for (op, words) in [
            (Mutation::Chmod, "permissions"),
            (Mutation::Chown, "owner"),
            (Mutation::Symlink, "symlink"),
        ] {
            let err = mutation_error(op, "/etc/x", status(StatusCode::PermissionDenied));
            match err {
                FileError::PermissionDenied(msg) => {
                    assert!(msg.contains("/etc/x") && msg.contains(words), "{msg}");
                }
                other => panic!("{op:?}: expected PermissionDenied, got {other:?}"),
            }
        }
    }

    #[test]
    fn no_such_file_status_is_not_found() {
        let err = mutation_error(Mutation::Chmod, "/gone", status(StatusCode::NoSuchFile));
        assert!(matches!(err, FileError::NotFound(p) if p == "/gone"));
    }

    #[test]
    fn other_failures_stay_operation_failed_naming_the_operation() {
        for err in [
            status(StatusCode::Failure),
            status(StatusCode::OpUnsupported),
            SftpError::Timeout,
        ] {
            match mutation_error(Mutation::Chown, "/f", err) {
                FileError::OperationFailed(msg) => {
                    assert!(msg.starts_with("chown /f failed: "), "{msg}");
                }
                other => panic!("expected OperationFailed, got {other:?}"),
            }
        }
    }

    #[test]
    fn copy_onto_itself_is_a_conflict() {
        assert!(copy_conflict("/a/f", "/a/f", false).is_some());
        assert!(copy_conflict("/a/d", "/a/d/", true).is_some());
    }

    #[test]
    fn folder_into_itself_is_a_conflict_but_a_sibling_is_not() {
        assert!(copy_conflict("/a/d", "/a/d/sub", true).is_some());
        assert!(copy_conflict("/", "/x", true).is_some());
        assert!(copy_conflict("/a/d", "/a/d2", true).is_none());
        // A file is never "inside" another file.
        assert!(copy_conflict("/a/f", "/a/f/x", false).is_none());
        assert!(copy_conflict("/a/f", "/a/g", false).is_none());
    }

    #[test]
    fn split_parent_handles_root_relative_and_trailing_slash() {
        assert_eq!(split_parent("/a/b"), ("/a", "b"));
        assert_eq!(split_parent("/b"), ("/", "b"));
        assert_eq!(split_parent("/a/b/"), ("/a", "b"));
        assert_eq!(split_parent("b"), (".", "b"));
    }
}
