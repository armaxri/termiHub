//! Small filesystem helpers shared across the agent.

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
/// This protects the agent's config-persistence stores from silent total data
/// loss on a torn write. A plain [`std::fs::write`] opens the destination with
/// `O_TRUNC`, truncating it to zero *before* writing — so an interrupted write
/// leaves invalid JSON that the recovery paths discard, wiping the saved session
/// state (#2366). Route all production config saves through this helper.
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));

    let mut tmp = NamedTempFile::new_in(parent)
        .context("failed to create temporary file for atomic write")?;
    tmp.write_all(contents.as_bytes())
        .context("failed to write to temporary file")?;
    // Flush the data to disk before the rename so a crash after the rename can
    // never expose a temp file whose contents were not durably written.
    tmp.as_file()
        .sync_all()
        .context("failed to flush temporary file to disk")?;
    tmp.persist(path)
        .map_err(|e| e.error)
        .context("failed to persist temporary file over target")?;

    Ok(())
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

    /// A failed atomic write must leave the previous good file untouched — this
    /// is the whole point of the helper (a torn write must never lose saved
    /// data).
    #[cfg(unix)]
    #[test]
    fn write_atomic_failed_write_preserves_existing_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        write_atomic(&path, "original").unwrap();

        // Make the directory read-only so a new temp file cannot be created.
        let restore = std::fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        std::fs::set_permissions(dir.path(), ro).unwrap();

        let result = write_atomic(&path, "replacement");

        // Restore permissions before asserting so temp-dir cleanup succeeds.
        std::fs::set_permissions(dir.path(), restore).unwrap();

        assert!(result.is_err(), "write into read-only dir should fail");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "original",
            "failed write must preserve the previous file contents"
        );
    }
}
