//! Small filesystem predicates shared across modules.

use std::path::Path;

/// Returns `true` if `path` is a regular file with a non-zero length.
///
/// Used to decide whether a cached or extracted artifact on disk is usable — a
/// zero-byte file (e.g. a truncated download) is treated as absent.
pub fn is_nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn true_for_nonempty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("blob.bin");
        std::fs::write(&path, b"content").unwrap();
        assert!(is_nonempty_file(&path));
    }

    #[test]
    fn false_for_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        assert!(!is_nonempty_file(&path));
    }

    #[test]
    fn false_for_missing_path() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_nonempty_file(&tmp.path().join("nope.bin")));
    }

    #[test]
    fn false_for_directory() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_nonempty_file(tmp.path()));
    }
}
