//! Shared path-sandboxing helper for the features that expose a single local
//! folder to the (possibly untrusted) remote session — RDPDR drive redirection
//! (#1757) and CLIPRDR file transfer (#1765).
//!
//! Both features must confine every remote-controlled path to exactly the one
//! folder the user opted into, never the whole filesystem. [`resolve_in_root`]
//! is the single choke point: it rejects `..` traversal, drive letters and NUL
//! bytes, and — for paths that already exist — canonicalises the result and
//! re-checks it against the root, defeating symlink escapes.

use std::path::{Path, PathBuf};

/// Resolve an RDP-style path (`\`- or `/`-separated, relative to `root`) to a
/// local path inside `root`, or `None` if it escapes the sandbox.
///
/// Rejects `..` traversal, drive letters / colons, and NUL bytes. For a path
/// that already exists, the result is canonicalised and re-checked against
/// `root` (which must itself be canonical) to defeat symlink escapes. For a
/// not-yet-existing path (e.g. a file about to be created), the parent — if it
/// exists — must canonicalise back inside `root`; `..` having already been
/// rejected lexically, the join cannot escape.
pub fn resolve_in_root(root: &Path, rdp_path: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for component in rdp_path.split(['\\', '/']) {
        match component {
            "" | "." => continue,
            ".." => return None,
            other => {
                if other.contains('\0') || other.contains(':') {
                    return None;
                }
                out.push(other);
            }
        }
    }
    // A path that already exists must canonicalise back inside the root; this is
    // what stops a symlink inside the share from pointing outward.
    if let Ok(canon) = std::fs::canonicalize(&out) {
        if !canon.starts_with(root) {
            return None;
        }
        return Some(canon);
    }
    // Not-yet-existing path (e.g. a create): its parent must be inside the root.
    // `..` was already rejected lexically, so the join cannot escape.
    if let Some(parent) = out.parent() {
        if let Ok(parent_canon) = std::fs::canonicalize(parent) {
            if !parent_canon.starts_with(root) {
                return None;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    #[test]
    fn rejects_parent_traversal() {
        let (_d, root) = root();
        assert!(resolve_in_root(&root, "..\\etc\\passwd").is_none());
        assert!(resolve_in_root(&root, "sub\\..\\..\\secret").is_none());
        assert!(resolve_in_root(&root, "a\\b\\..").is_none());
    }

    #[test]
    fn rejects_drive_letters_and_nul() {
        let (_d, root) = root();
        assert!(resolve_in_root(&root, "C:\\Windows").is_none());
        assert!(resolve_in_root(&root, "weird\0name").is_none());
    }

    #[test]
    fn allows_nested_paths_within_root() {
        let (dir, root) = root();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        let resolved = resolve_in_root(&root, "a\\b").unwrap();
        assert!(resolved.starts_with(&root));
        assert!(resolved.ends_with("b"));
        // Root itself resolves back to the root.
        assert_eq!(resolve_in_root(&root, "\\").unwrap(), root);
    }

    #[test]
    fn allows_not_yet_existing_file_in_root() {
        let (_d, root) = root();
        let resolved = resolve_in_root(&root, "new-file.txt").unwrap();
        assert_eq!(resolved, root.join("new-file.txt"));
    }
}
