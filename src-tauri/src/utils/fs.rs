//! Small filesystem predicates and helpers shared across modules.

use std::path::Path;

use anyhow::Result;

/// Atomically write `contents` to `path`: a uniquely named temp file in the
/// same directory, fsynced, then renamed over `path`, so a torn write never
/// loses the saved data (#2318 / #2320). Route all production config saves
/// through this helper.
///
/// A thin adapter over the shared
/// [`termihub_core::util::persist::write_atomic`] (#4334), returning
/// [`anyhow::Result`] for the desktop's error plumbing.
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> Result<()> {
    Ok(termihub_core::util::persist::write_atomic(path, contents)?)
}

/// Returns `true` if `path` is a regular file with a non-zero length.
///
/// Used to decide whether a cached or extracted artifact on disk is usable — a
/// zero-byte file (e.g. a truncated download) is treated as absent.
pub fn is_nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Extract the display file name from a path (falls back to the whole path).
///
/// Shared by the SFTP (`commands/files.rs`) and FTP (`commands/transfer.rs`)
/// transfer commands, which name a Transfer Queue row from the basename of the
/// path it displays so the name always agrees with the `path` cell beside it
/// (#1573, #1594).
pub fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The adapter reaches the shared helper (its behavior is covered by
    /// `termihub_core::util::persist`'s own tests).
    #[test]
    fn write_atomic_adapter_writes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        write_atomic(&path, "{\"hello\":true}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"hello\":true}");
    }

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

    #[test]
    fn file_name_of_names_a_file_by_its_basename() {
        assert_eq!(file_name_of("/home/testuser/report.csv"), "report.csv");
        assert_eq!(file_name_of("/report.csv"), "report.csv");
        assert_eq!(file_name_of("report.csv"), "report.csv");
    }

    #[test]
    fn file_name_of_falls_back_to_the_whole_path_when_there_is_no_basename() {
        assert_eq!(file_name_of("/"), "/");
        assert_eq!(file_name_of(""), "");
        assert_eq!(file_name_of(".."), "..");
    }

    /// Both SFTP (#1573) and FTP (#1594) transfer directions name a row from the
    /// *remote* path, so the name always agrees with the `path` cell beside it.
    /// Feeding an upload the destination path — rather than the local temp copy
    /// an SFTP→SFTP paste reads from — is what keeps the scratch name off the
    /// row.
    #[test]
    fn file_name_of_names_a_paste_upload_after_the_destination_not_the_temp_copy() {
        let temp_local = "/tmp/termihub-paste-1784278708447-report.csv";
        let remote_dest = "/home/testuser/dest/report.csv";

        assert_eq!(file_name_of(remote_dest), "report.csv");
        assert_eq!(
            file_name_of(temp_local),
            "termihub-paste-1784278708447-report.csv",
            "the temp basename is what the row must NOT show",
        );
    }
}
