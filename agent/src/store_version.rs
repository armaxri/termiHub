//! Schema versioning + downgrade data-safety for the agent's persisted JSON stores.
//!
//! This mirrors the desktop's `src-tauri/src/utils/migrate.rs` layer
//! (`VersionedStore` / `load_versioned` / `guard_not_newer`) for the agent side,
//! which cannot link against the desktop crate:
//!
//! * a store carries a `version` field, written as a JSON **string** (`"1"`), read
//!   flexibly as a string **or** a number;
//! * a file with no readable `version` is the **baseline** (v1), so a legacy,
//!   pre-versioning file still loads;
//! * a file whose version is **newer** than this binary supports is refused on
//!   load — it is never reset, rewritten or migrated — and every save over it is
//!   refused ([`guard_not_newer`]), so a downgraded agent can never overwrite data
//!   a newer agent wrote (#3920).
//!
//! When a store's schema changes (for example a settings-key rename), bump its
//! current version and add a numbered step to its `migrate` function; the version
//! gate then makes the change forward-migrating and downgrade-safe.
//!
//! A store that is genuinely **corrupt** (not a newer version) is copied aside
//! with [`backup_corrupt`] before anything may overwrite it (#3931), so no path
//! can lose saved data without a copy on disk.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The schema version assumed for a file with no readable `version` field.
pub const ASSUMED_VERSION: u32 = 1;

/// A persisted store was written by a **newer** agent than this binary supports.
///
/// Returned on load (the file is then left intact) and by [`guard_not_newer`] to
/// refuse a save that would overwrite it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "{store} was written by a newer version of the termiHub agent (schema v{found}, \
     this agent supports v{supported}); refusing to overwrite it to avoid data loss. \
     Update the agent to edit these definitions"
)]
pub struct NewerVersionError {
    /// Diagnostic name of the store (e.g. `"connections.json"`).
    pub store: &'static str,
    /// The schema version found on disk.
    pub found: u32,
    /// The newest schema version this binary understands.
    pub supported: u32,
}

/// Read a `version` field as an integer, accepting either a JSON string (`"2"`)
/// or a JSON number (`2`). Absent or unparseable → `None`.
pub fn read_version(value: &Value) -> Option<u32> {
    match value.get("version") {
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(Value::Number(n)) => u32::try_from(n.as_u64()?).ok(),
        _ => None,
    }
}

/// The effective schema version of a parsed store: its `version` field, or
/// [`ASSUMED_VERSION`] when absent. Errors when that version is newer than
/// `current`.
pub fn check_version(
    value: &Value,
    store: &'static str,
    current: u32,
) -> Result<u32, NewerVersionError> {
    let found = read_version(value).unwrap_or(ASSUMED_VERSION);
    if found > current {
        return Err(NewerVersionError {
            store,
            found,
            supported: current,
        });
    }
    Ok(found)
}

/// Refuse to overwrite a file that was written by a **newer** schema version.
///
/// Re-reads `path` on every call, so it protects a save even when a newer agent
/// wrote the file after this store was loaded. A missing or unparseable file, or
/// one at the same or an older version, may be overwritten — only a
/// *parseable-but-newer* file is protected.
pub fn guard_not_newer(
    path: &Path,
    store: &'static str,
    current: u32,
) -> Result<(), NewerVersionError> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    match read_version(&value) {
        Some(found) if found > current => Err(NewerVersionError {
            store,
            found,
            supported: current,
        }),
        _ => Ok(()),
    }
}

/// Copy the raw bytes of a corrupt store aside, next to it, as
/// `<file name>.corrupt-<UTC timestamp>` (with a `-<n>` suffix when that name is
/// taken), and return the backup's path.
///
/// The backup is created with `create_new`, so an earlier backup is never
/// overwritten, and it is fsynced before this returns — callers may only
/// overwrite the store once this has succeeded (#3931).
pub fn backup_corrupt(path: &Path, contents: &[u8]) -> std::io::Result<PathBuf> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "store".to_string());
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let base = format!("{file_name}.corrupt-{stamp}");
    for attempt in 0u32.. {
        let name = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}-{attempt}")
        };
        let backup = path.with_file_name(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
        {
            Ok(mut file) => {
                file.write_all(contents)?;
                file.sync_all()?;
                return Ok(backup);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!("u32 backup-name space exhausted")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn read_version_accepts_string_and_number() {
        assert_eq!(read_version(&json!({"version": "2"})), Some(2));
        assert_eq!(read_version(&json!({"version": 3})), Some(3));
        assert_eq!(read_version(&json!({"version": " 4 "})), Some(4));
        assert_eq!(read_version(&json!({})), None);
        assert_eq!(read_version(&json!({"version": "abc"})), None);
        assert_eq!(read_version(&json!({"version": -1})), None);
    }

    #[test]
    fn check_version_treats_missing_as_baseline() {
        assert_eq!(check_version(&json!({}), "s", 1), Ok(ASSUMED_VERSION));
        assert_eq!(check_version(&json!({"version": "1"}), "s", 2), Ok(1));
    }

    #[test]
    fn check_version_refuses_newer() {
        let err = check_version(&json!({"version": "7"}), "s.json", 1).unwrap_err();
        assert_eq!(
            err,
            NewerVersionError {
                store: "s.json",
                found: 7,
                supported: 1
            }
        );
        let msg = err.to_string();
        assert!(msg.contains("s.json"), "{msg}");
        assert!(msg.contains("newer version"), "{msg}");
    }

    #[test]
    fn guard_allows_missing_corrupt_same_and_older() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.json");
        assert!(guard_not_newer(&path, "s", 2).is_ok());
        std::fs::write(&path, "not json").unwrap();
        assert!(guard_not_newer(&path, "s", 2).is_ok());
        std::fs::write(&path, r#"{"version":"2"}"#).unwrap();
        assert!(guard_not_newer(&path, "s", 2).is_ok());
        std::fs::write(&path, r#"{"version":1}"#).unwrap();
        assert!(guard_not_newer(&path, "s", 2).is_ok());
        std::fs::write(&path, r#"{}"#).unwrap();
        assert!(guard_not_newer(&path, "s", 2).is_ok());
    }

    #[test]
    fn backup_corrupt_copies_bytes_and_never_overwrites() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.json");
        let first = backup_corrupt(&path, b"one").unwrap();
        let second = backup_corrupt(&path, b"two").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
        for backup in [&first, &second] {
            let name = backup.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("s.json.corrupt-"), "{name}");
        }
    }

    #[test]
    fn guard_refuses_newer() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.json");
        std::fs::write(&path, r#"{"version":"3"}"#).unwrap();
        let err = guard_not_newer(&path, "s", 2).unwrap_err();
        assert_eq!(err.found, 3);
        assert_eq!(err.supported, 2);
    }
}
