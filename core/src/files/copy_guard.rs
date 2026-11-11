//! Refuse a same-backend copy of a file onto itself or of a folder into
//! itself, before anything is created or truncated (#5320, #5325).
//!
//! A copy opens its destination for writing with truncation. When the
//! destination is the source, the file is emptied and the copy still reports
//! success. A folder copied into itself, or into one of its descendants,
//! recurses into its own output until the path is too long.
//!
//! - [`copy_conflict`] compares two already-canonical `/`-separated remote
//!   paths (a server's `realpath`). It is the same check as the SFTP browser's
//!   guard, so that guard can move onto it.
//! - [`local_copy_conflict`] resolves two local paths itself: canonical paths
//!   (so `dir/./f`, `..` and symlinks compare equal) and, on Unix, the
//!   device and inode (so a hard link is the same file too).
//! - [`copy_refused`] words the refusal like the SFTP guard.

use std::path::{Component, Path, PathBuf};

use crate::errors::FileError;

/// The refusal reason when the destination is the source itself.
pub const SAME_FILE: &str = "source and destination are the same file";

/// The refusal reason when a folder's destination lies inside it.
pub const INSIDE_SOURCE: &str = "the destination is inside the source folder";

/// The error for a refused copy of `src` to `dest`, as the user typed them.
pub fn copy_refused(src: &str, dest: &str, reason: &str) -> FileError {
    FileError::OperationFailed(refusal_message(src, dest, reason))
}

fn refusal_message(src: &str, dest: &str, reason: &str) -> String {
    format!("copy {src} to {dest} refused: {reason}")
}

/// Why copying `src` to `dest` must be refused, if it must. Both are
/// canonical `/`-separated paths (as a remote server resolves them).
pub fn copy_conflict(src: &str, dest: &str, src_is_dir: bool) -> Option<&'static str> {
    let src = src.trim_end_matches('/');
    let dest = dest.trim_end_matches('/');
    if src == dest {
        return Some(SAME_FILE);
    }
    // The root folder trims to "", so every absolute path lies inside it.
    if src_is_dir && dest.starts_with(&format!("{src}/")) {
        return Some(INSIDE_SOURCE);
    }
    None
}

/// Why copying the local `src` to `dest` must be refused, if it must.
///
/// `dest` need not exist. A `src` that cannot be resolved is not a refusal:
/// the copy then fails with its own, more specific error.
pub fn local_copy_conflict(src: &Path, dest: &Path, src_is_dir: bool) -> Option<&'static str> {
    let src_canon = std::fs::canonicalize(src).ok()?;
    let dest_resolved = resolve_maybe_missing(dest);
    if dest_resolved == src_canon {
        return Some(SAME_FILE);
    }
    if same_entry(src, &dest_resolved) {
        return Some(SAME_FILE);
    }
    if !src_is_dir {
        return None;
    }
    if dest_resolved.starts_with(&src_canon) {
        return Some(INSIDE_SOURCE);
    }
    // A spelling canonicalize does not unify (a case-insensitive name, a bind
    // mount): an existing ancestor of the destination is the source folder.
    dest_resolved
        .ancestors()
        .skip(1)
        .any(|ancestor| same_entry(src, ancestor))
        .then_some(INSIDE_SOURCE)
}

/// Refuse a local copy of `src` onto itself or of a folder into itself.
pub fn ensure_local_copy_allowed(src: &str, dest: &str, src_is_dir: bool) -> Result<(), FileError> {
    match local_copy_conflict(Path::new(src), Path::new(dest), src_is_dir) {
        Some(reason) => Err(copy_refused(src, dest, reason)),
        None => Ok(()),
    }
}

/// [`ensure_local_copy_allowed`] for the `std::io` callers: the refusal is an
/// [`InvalidInput`](std::io::ErrorKind::InvalidInput) error with the same
/// message.
pub fn ensure_local_copy_allowed_io(
    src: &str,
    dest: &str,
    src_is_dir: bool,
) -> std::io::Result<()> {
    match local_copy_conflict(Path::new(src), Path::new(dest), src_is_dir) {
        Some(reason) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            refusal_message(src, dest, reason),
        )),
        None => Ok(()),
    }
}

/// Whether `a` and `b` are the same existing entry (symlinks followed): the
/// same device and inode. `false` when either is missing.
#[cfg(unix)]
fn same_entry(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) => ma.dev() == mb.dev() && ma.ino() == mb.ino(),
        _ => false,
    }
}

/// Whether `a` and `b` are the same existing entry. Without a portable file
/// id, the canonical paths compare, ignoring ASCII case (Windows filesystems
/// are case-insensitive).
#[cfg(not(unix))]
fn same_entry(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca
            .to_string_lossy()
            .eq_ignore_ascii_case(&cb.to_string_lossy()),
        _ => false,
    }
}

/// Resolve `path` via its nearest existing ancestor, appending the missing
/// tail with `.` / `..` applied lexically. Falls back to `path` unchanged.
pub(crate) fn resolve_maybe_missing(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut tail = Vec::new();
    loop {
        if let Ok(resolved) = std::fs::canonicalize(existing) {
            let mut out = resolved;
            for part in tail.iter().rev() {
                match part {
                    Component::ParentDir => {
                        out.pop();
                    }
                    Component::Normal(name) => out.push(name),
                    _ => {}
                }
            }
            return out;
        }
        match (existing.parent(), existing.components().next_back()) {
            (Some(parent), Some(last)) => {
                tail.push(last);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_onto_itself_is_a_conflict() {
        assert_eq!(copy_conflict("/a/f", "/a/f", false), Some(SAME_FILE));
        assert_eq!(copy_conflict("/a/d", "/a/d/", true), Some(SAME_FILE));
    }

    #[test]
    fn folder_into_itself_is_a_conflict_but_a_sibling_is_not() {
        assert_eq!(copy_conflict("/a/d", "/a/d/sub", true), Some(INSIDE_SOURCE));
        assert_eq!(copy_conflict("/", "/x", true), Some(INSIDE_SOURCE));
        assert_eq!(copy_conflict("/a/d", "/a/d2", true), None);
        // A file is never "inside" another file.
        assert_eq!(copy_conflict("/a/f", "/a/f/x", false), None);
    }

    #[test]
    fn the_refusal_names_both_paths_and_the_reason() {
        match copy_refused("/a/f", "/a/./f", SAME_FILE) {
            FileError::OperationFailed(msg) => assert_eq!(
                msg,
                "copy /a/f to /a/./f refused: source and destination are the same file"
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_missing_source_is_left_to_the_copy() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone");
        assert_eq!(local_copy_conflict(&gone, &gone, false), None);
    }

    #[test]
    fn a_different_local_file_is_not_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::write(&a, b"x").unwrap();
        assert_eq!(local_copy_conflict(&a, &dir.path().join("b"), false), None);
        std::fs::write(dir.path().join("b"), b"x").unwrap();
        assert_eq!(local_copy_conflict(&a, &dir.path().join("b"), false), None);
    }
}
