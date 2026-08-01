//! Small filesystem predicates and helpers shared across modules.

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use tempfile::NamedTempFile;

/// Atomically write `contents` to `path`.
///
/// The bytes are first written to a temporary file in the **same directory** as
/// `path` (so the final rename stays on one filesystem and is therefore atomic),
/// flushed to disk, and only then renamed over `path`. A crash, power loss, or
/// full disk mid-write can leave the temporary file behind but never touches the
/// destination: `path` always holds either the complete previous contents or the
/// complete new contents, never a truncated mix.
///
/// This protects every config-persistence store from silent total data loss on a
/// torn write. A plain [`std::fs::write`] opens the destination with `O_TRUNC`,
/// truncating it to zero *before* writing — so an interrupted write leaves
/// invalid JSON that the recovery paths discard, wiping the saved data
/// (#2318 / #2320). Route all production config saves through this helper.
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));

    let mut tmp = NamedTempFile::new_in(parent)
        .context("Failed to create temporary file for atomic write")?;
    tmp.write_all(contents.as_bytes())
        .context("Failed to write to temporary file")?;
    // Flush the data to disk before the rename so a crash after the rename can
    // never expose a temp file whose contents were not durably written.
    tmp.as_file()
        .sync_all()
        .context("Failed to flush temporary file to disk")?;
    tmp.persist(path)
        .map_err(|e| e.error)
        .context("Failed to persist temporary file over target")?;

    Ok(())
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

    #[test]
    fn write_atomic_writes_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");

        write_atomic(&path, "{\"hello\":true}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"hello\":true}");
    }

    #[test]
    fn write_atomic_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");

        write_atomic(&path, "old").unwrap();
        write_atomic(&path, "new-and-longer").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new-and-longer");
    }

    #[test]
    fn write_atomic_leaves_no_temp_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");

        write_atomic(&path, "payload").unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["data.json".to_string()], "got {names:?}");
    }

    /// A failed atomic write must leave the previous good file untouched — this is
    /// the whole point of the helper (a torn write must never lose saved data).
    #[cfg(unix)]
    #[test]
    fn write_atomic_failed_write_preserves_existing_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        write_atomic(&path, "original").unwrap();

        let restore = std::fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        std::fs::set_permissions(dir.path(), ro).unwrap();

        // Skip under root, which can create files regardless of directory mode.
        let probe = dir.path().join(".probe");
        if std::fs::write(&probe, b"x").is_ok() {
            let _ = std::fs::remove_file(&probe);
            std::fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let result = write_atomic(&path, "replacement");
        std::fs::set_permissions(dir.path(), restore).unwrap();

        assert!(result.is_err(), "write into a read-only dir must fail");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "original",
            "a failed atomic write must leave the previous file intact"
        );
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
