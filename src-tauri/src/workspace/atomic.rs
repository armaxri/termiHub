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
/// This protects the workspace persistence stores from silent total data loss on
/// a torn write. A plain [`std::fs::write`] opens the destination with
/// `O_TRUNC`, truncating it to zero *before* writing — so an interrupted write
/// leaves invalid JSON that the recovery paths discard, wiping every saved
/// workspace / the restored session (#2318).
pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn writes_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("data.json");

        write_atomic(&path, "{\"hello\":true}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"hello\":true}");
    }

    #[test]
    fn overwrites_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("data.json");

        write_atomic(&path, "old").unwrap();
        write_atomic(&path, "new-and-longer").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new-and-longer");
    }

    #[test]
    fn leaves_no_temp_artifacts() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("data.json");

        write_atomic(&path, "payload").unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["data.json".to_string()], "got {names:?}");
    }

    #[cfg(unix)]
    #[test]
    fn failed_write_preserves_existing_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
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
}
