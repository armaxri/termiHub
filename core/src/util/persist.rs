//! The shared persistence-safety layer for every JSON store (DUP2-003,
//! PER2-004, #4334): atomic writes, the schema-version gate and the
//! corrupt-file backup.
//!
//! The desktop (`src-tauri::utils::{fs, migrate}`), the agent
//! (`agent::{fs, store_version}`) and the plugin stores in
//! [`crate::plugin`] all link this one implementation, so a fix to any of
//! these rules reaches every store at once.
//!
//! * [`write_atomic`] — temp file in the **same directory** (unique name), the
//!   bytes fsynced, then renamed over the target. A crash leaves either the
//!   complete old file or the complete new one, and two concurrent writers
//!   never share a temp file.
//! * [`read_version`] / [`check_version`] / [`guard_not_newer`] — the
//!   downgrade gate: a file written by a newer schema is never overwritten.
//! * [`backup_corrupt`] / [`backup_corrupt_file`] — copy a corrupt store to the
//!   first free `<file>.bak`, `<file>.bak.1`, … so no earlier backup is ever
//!   clobbered (ERR2-002).
//! * [`prepare_overwrite`] — the one check a store runs before it replaces
//!   its file: refuse a newer file, refuse a corrupt file that could not be
//!   backed up, and back up a corrupt file before it is replaced.
//!
//! `version` is read flexibly — a JSON string (`"2"`) or a number (`2`) — and a
//! file without one is the baseline [`ASSUMED_VERSION`].

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::de::DeserializeOwned;
use serde_json::Value;
use tempfile::NamedTempFile;

/// The schema version assumed for a file with no readable `version` field,
/// so a legacy, pre-versioning file still loads.
pub const ASSUMED_VERSION: u32 = 1;

/// How many corrupt-store backups (`<name>.bak`, `<name>.bak.1`, …) are kept
/// per file. Once every slot is taken a new corruption cannot be backed up,
/// and callers then leave the live file untouched rather than overwrite an
/// earlier backup (ERR2-002).
pub const MAX_CORRUPT_BACKUPS: usize = 20;

/// A persisted store was written by a **newer** schema version than this
/// binary supports. Returned on load (the file is then left intact) and by
/// [`guard_not_newer`] to refuse a save that would overwrite it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "{store} was written by a newer version of termiHub (schema v{found}, this build supports \
     v{supported}); refusing to overwrite it to avoid data loss"
)]
pub struct NewerVersionError {
    /// Diagnostic name of the store (e.g. `"workspaces.json"`).
    pub store: &'static str,
    /// The schema version found on disk.
    pub found: u32,
    /// The newest schema version this binary understands.
    pub supported: u32,
}

/// Atomically replace `path` with `contents`.
///
/// The bytes go to a uniquely named temporary file in `path`'s directory (so
/// the rename stays on one filesystem and concurrent writers never share a
/// temp file), are flushed to disk with `sync_all`, and only then is the temp
/// file renamed over `path`. A crash, power loss or full disk mid-write may
/// leave a stray temp file but never a truncated `path`. A plain
/// [`std::fs::write`] truncates the destination before writing, so an
/// interrupted write loses the saved data (#2318, #2366).
///
/// # Errors
///
/// Any I/O failure, with the failing step named in the message. `path` is then
/// left exactly as it was.
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let step = |what: &str| {
        let what = what.to_owned();
        move |e: std::io::Error| std::io::Error::new(e.kind(), format!("{what}: {e}"))
    };
    let mut tmp = NamedTempFile::new_in(parent)
        .map_err(step("failed to create temporary file for atomic write"))?;
    tmp.write_all(contents.as_ref())
        .map_err(step("failed to write to temporary file"))?;
    tmp.as_file()
        .sync_all()
        .map_err(step("failed to flush temporary file to disk"))?;
    tmp.persist(path)
        .map_err(|e| e.error)
        .map_err(step("failed to persist temporary file over target"))?;
    Ok(())
}

/// Read a `version` field as an integer, accepting either a JSON string
/// (`"2"`) or a JSON number (`2`). Absent or unparseable → `None`.
#[must_use]
pub fn read_version(value: &Value) -> Option<u32> {
    match value.get("version") {
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(Value::Number(n)) => u32::try_from(n.as_u64()?).ok(),
        _ => None,
    }
}

/// The effective schema version of a parsed store: its `version` field, or
/// [`ASSUMED_VERSION`] when absent.
///
/// # Errors
///
/// [`NewerVersionError`] when that version is newer than `current`.
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
/// Re-reads `path` on every call, so it protects a save even when a newer
/// build wrote the file after the store was loaded. A missing or unparseable
/// file, or one at the same or an older version, may be overwritten — only a
/// *parseable-but-newer* file is protected. Stateless: the unbacked-corrupt
/// guard is checked separately ([`is_unbacked_corrupt`], [`prepare_overwrite`]).
///
/// # Errors
///
/// [`NewerVersionError`] for a file written by a newer schema.
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

/// Write `contents` to the first free `<file>.bak`, `<file>.bak.1`, … next to
/// `path`, fsynced, and return the backup's path.
///
/// Each slot is claimed with `create_new`, so an earlier backup is never
/// overwritten, not even by a concurrent backup. Callers may overwrite the
/// store only once this has succeeded (ERR2-002, #3931).
///
/// # Errors
///
/// An I/O failure (the half-written slot is removed again), or every one of
/// the [`MAX_CORRUPT_BACKUPS`] slots already being taken.
pub fn backup_corrupt(path: &Path, contents: &[u8]) -> std::io::Result<PathBuf> {
    let name = path
        .file_name()
        .map_or_else(|| "store".to_owned(), |n| n.to_string_lossy().into_owned());
    for n in 0..MAX_CORRUPT_BACKUPS {
        let candidate = if n == 0 {
            path.with_file_name(format!("{name}.bak"))
        } else {
            path.with_file_name(format!("{name}.bak.{n}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                let written = file.write_all(contents).and_then(|()| file.sync_all());
                if let Err(e) = written {
                    drop(file);
                    let _ = std::fs::remove_file(&candidate);
                    return Err(e);
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other(format!(
        "{MAX_CORRUPT_BACKUPS} backups of {name} already exist"
    )))
}

/// Copy the corrupt store at `path` to the first free `<file>.bak[.N]` slot
/// ([`backup_corrupt`]) and return the backup's path.
///
/// # Errors
///
/// `path` cannot be read, or [`backup_corrupt`] fails.
pub fn backup_corrupt_file(path: &Path) -> std::io::Result<PathBuf> {
    let contents = std::fs::read(path)?;
    backup_corrupt(path, &contents)
}

/// Files whose corrupt original could not be backed up this session. While a
/// path is listed, [`prepare_overwrite`] (and the desktop's save guard)
/// refuse every save to it, so the only copy of the user's data is never
/// overwritten (ERR2-002).
static UNBACKED_CORRUPT: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn unbacked_corrupt() -> MutexGuard<'static, Vec<PathBuf>> {
    UNBACKED_CORRUPT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Arm the save guard for `path`: its corrupt original could not be backed
/// up, so no save may overwrite it until it loads cleanly again.
pub fn protect_unbacked_corrupt(path: &Path) {
    let mut paths = unbacked_corrupt();
    if !paths.iter().any(|p| p == path) {
        paths.push(path.to_path_buf());
    }
}

/// Disarm the save guard for `path` (it parses again).
pub fn release_unbacked_corrupt(path: &Path) {
    unbacked_corrupt().retain(|p| p != path);
}

/// Whether `path`'s save guard is armed ([`protect_unbacked_corrupt`]).
#[must_use]
pub fn is_unbacked_corrupt(path: &Path) -> bool {
    unbacked_corrupt().iter().any(|p| p == path)
}

/// Why [`prepare_overwrite`] refused a save.
#[derive(Debug, thiserror::Error)]
pub enum OverwriteError {
    /// The file on disk was written by a newer schema.
    #[error(transparent)]
    Newer(#[from] NewerVersionError),
    /// The file on disk is corrupt and an earlier attempt to back it up failed.
    #[error(
        "{store} is corrupt and could not be backed up; refusing to overwrite the only copy \
         (free disk space or fix the file, then restart termiHub)"
    )]
    UnbackedCorrupt {
        /// Diagnostic name of the store.
        store: &'static str,
    },
    /// The file on disk is corrupt and backing it up failed just now.
    #[error("{store} is corrupt and could not be backed up ({source}); refusing to overwrite it")]
    Backup {
        /// Diagnostic name of the store.
        store: &'static str,
        /// The backup failure.
        source: std::io::Error,
    },
}

/// The check a store runs right before it replaces its file at `path`.
///
/// * missing file, or a valid `T` at or below `current` → proceed (`Ok(None)`);
/// * a file whose `version` is newer than `current` → refused
///   ([`OverwriteError::Newer`]), even when this build cannot parse it;
/// * a corrupt file (not JSON, or not a valid `T`) → copied to a fresh
///   `<file>.bak[.N]` first and `Ok(Some(backup))` returned; when that copy
///   fails the save guard is armed and the save refused, so the only copy is
///   never overwritten;
/// * a path whose save guard is armed → refused.
///
/// Backing up on overwrite (rather than on every load) means a store that is
/// loaded often while corrupt does not pile up identical backups.
///
/// # Errors
///
/// See above.
pub fn prepare_overwrite<T: DeserializeOwned>(
    path: &Path,
    store: &'static str,
    current: u32,
) -> Result<Option<PathBuf>, OverwriteError> {
    if is_unbacked_corrupt(path) {
        return Err(OverwriteError::UnbackedCorrupt { store });
    }
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(OverwriteError::Backup { store, source }),
    };
    if let Ok(value) = serde_json::from_slice::<Value>(&raw) {
        check_version(&value, store, current)?;
        if serde_json::from_value::<T>(value).is_ok() {
            return Ok(None);
        }
    }
    match backup_corrupt(path, &raw) {
        Ok(backup) => Ok(Some(backup)),
        Err(source) => {
            protect_unbacked_corrupt(path);
            Err(OverwriteError::Backup { store, source })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_atomic_writes_and_overwrites() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data.json");
        write_atomic(&path, "old").unwrap();
        write_atomic(&path, b"new-and-longer").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new-and-longer");
        assert_eq!(names_in(tmp.path()), vec!["data.json".to_owned()]);
    }

    /// PER2-004: concurrent writers each use their own temp file, so every
    /// rename installs one writer's complete document — never interleaved
    /// bytes — and no temp file is left behind.
    #[test]
    fn concurrent_writers_use_unique_temp_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        let docs: Vec<String> = (0..8u8)
            .map(|i| {
                let body = char::from(b'a' + i).to_string().repeat(64 * 1024);
                format!("{{\"writer\":{i},\"body\":\"{body}\"}}")
            })
            .collect();
        std::thread::scope(|s| {
            for doc in &docs {
                let path = &path;
                s.spawn(move || {
                    for _ in 0..10 {
                        let result = write_atomic(path, doc);
                        // Windows may refuse a rename while another writer's
                        // rename holds the target; the target is still intact.
                        if cfg!(not(windows)) {
                            result.unwrap();
                        }
                    }
                });
            }
        });
        let last = std::fs::read_to_string(&path).unwrap();
        assert!(docs.contains(&last), "the file is one writer's whole document");
        assert_eq!(names_in(tmp.path()), vec!["state.json".to_owned()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_leaves_the_previous_file() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data.json");
        write_atomic(&path, "original").unwrap();
        let restore = std::fs::metadata(tmp.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        std::fs::set_permissions(tmp.path(), ro).unwrap();
        // Root can write a read-only directory; nothing to prove then.
        let probe = tmp.path().join(".probe");
        if std::fs::write(&probe, b"x").is_ok() {
            let _ = std::fs::remove_file(&probe);
            std::fs::set_permissions(tmp.path(), restore).unwrap();
            return;
        }
        let result = write_atomic(&path, "replacement");
        std::fs::set_permissions(tmp.path(), restore).unwrap();
        let err = result.unwrap_err();
        assert!(err.to_string().contains("temporary file"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    }

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
    fn check_version_treats_missing_as_baseline_and_refuses_newer() {
        assert_eq!(check_version(&json!({}), "s", 1), Ok(ASSUMED_VERSION));
        assert_eq!(check_version(&json!({"version": "1"}), "s", 2), Ok(1));
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
        assert!(msg.contains("s.json") && msg.contains("newer version"), "{msg}");
    }

    #[test]
    fn guard_not_newer_refuses_only_a_parseable_newer_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.json");
        assert!(guard_not_newer(&path, "s", 2).is_ok());
        for ok in ["not json", r#"{"version":"2"}"#, r#"{"version":1}"#, "{}"] {
            std::fs::write(&path, ok).unwrap();
            assert!(guard_not_newer(&path, "s", 2).is_ok(), "{ok}");
        }
        std::fs::write(&path, r#"{"version":"3"}"#).unwrap();
        let err = guard_not_newer(&path, "s", 2).unwrap_err();
        assert_eq!((err.found, err.supported), (3, 2));
    }

    #[test]
    fn backups_take_the_first_free_slot_and_never_overwrite() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.json");
        std::fs::write(&path, "one").unwrap();
        let first = backup_corrupt_file(&path).unwrap();
        let second = backup_corrupt(&path, b"two").unwrap();
        assert_eq!(first, tmp.path().join("s.json.bak"));
        assert_eq!(second, tmp.path().join("s.json.bak.1"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");

        // A gap is reused before a higher slot.
        std::fs::remove_file(&first).unwrap();
        assert_eq!(backup_corrupt(&path, b"three").unwrap(), first);
    }

    #[test]
    fn backups_stop_when_every_slot_is_taken() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.json");
        for _ in 0..MAX_CORRUPT_BACKUPS {
            backup_corrupt(&path, b"x").unwrap();
        }
        assert!(backup_corrupt(&path, b"y").is_err());
    }

    #[derive(serde::Deserialize)]
    struct Doc {
        #[allow(dead_code)]
        items: Vec<String>,
    }

    #[test]
    fn prepare_overwrite_allows_missing_and_valid_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("d.json");
        assert!(prepare_overwrite::<Doc>(&path, "d", 1).unwrap().is_none());
        std::fs::write(&path, r#"{"version":1,"items":["a"]}"#).unwrap();
        assert!(prepare_overwrite::<Doc>(&path, "d", 1).unwrap().is_none());
        assert_eq!(names_in(tmp.path()), vec!["d.json".to_owned()]);
    }

    /// A newer-version file is refused even when this build cannot parse it.
    #[test]
    fn prepare_overwrite_refuses_a_newer_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("d.json");
        std::fs::write(&path, r#"{"version":5,"items":7}"#).unwrap();
        let err = prepare_overwrite::<Doc>(&path, "d", 1).unwrap_err();
        assert!(matches!(err, OverwriteError::Newer(ref e) if e.found == 5), "{err}");
        assert_eq!(names_in(tmp.path()), vec!["d.json".to_owned()]);
    }

    /// A corrupt file — not JSON, or JSON of the wrong shape — is backed up
    /// before it may be replaced.
    #[test]
    fn prepare_overwrite_backs_up_a_corrupt_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("d.json");
        std::fs::write(&path, "{ not json").unwrap();
        let backup = prepare_overwrite::<Doc>(&path, "d", 1).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "{ not json");

        std::fs::write(&path, r#"{"items":5}"#).unwrap();
        let backup = prepare_overwrite::<Doc>(&path, "d", 1).unwrap().unwrap();
        assert_eq!(backup, tmp.path().join("d.json.bak.1"));
        assert_eq!(std::fs::read_to_string(backup).unwrap(), r#"{"items":5}"#);
    }

    #[test]
    fn prepare_overwrite_refuses_a_corrupt_file_it_cannot_back_up() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("d.json");
        std::fs::write(&path, "{ not json").unwrap();
        for _ in 0..MAX_CORRUPT_BACKUPS {
            backup_corrupt(&path, b"x").unwrap();
        }
        let err = prepare_overwrite::<Doc>(&path, "d", 1).unwrap_err();
        assert!(matches!(err, OverwriteError::Backup { .. }), "{err}");
        assert!(is_unbacked_corrupt(&path));
        // Armed: refused even after a backup slot frees up.
        std::fs::remove_file(tmp.path().join("d.json.bak")).unwrap();
        assert!(matches!(
            prepare_overwrite::<Doc>(&path, "d", 1),
            Err(OverwriteError::UnbackedCorrupt { .. })
        ));
        release_unbacked_corrupt(&path);
        assert!(prepare_overwrite::<Doc>(&path, "d", 1).unwrap().is_some());
    }
}
