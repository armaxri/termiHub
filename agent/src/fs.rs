//! Small filesystem helpers shared across the agent.

use std::io::Write;
use std::path::{Path, PathBuf};

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

/// The sidecar lock-file path guarding a shared config file (e.g. `state.json`
/// → `state.json.lock`).
///
/// A dedicated sidecar is used rather than locking the config file itself
/// because [`write_atomic`] replaces the config file's inode on every save
/// (temp file + rename), which would drop any advisory lock held on the old
/// inode. The lock file is never renamed, so the lock stays valid across the
/// atomic write it protects.
pub fn lock_path_for(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".lock");
    path.with_file_name(name)
}

/// A held **cross-process** advisory lock on a config file's sidecar
/// lock-file.
///
/// This is the concurrency control [`write_atomic`] alone cannot provide: it
/// prevents a torn *file*, but two `--stdio` workers sharing a per-user
/// `state.json` or `connections.json` can still lost-update each other (worker
/// A loads, B loads, A saves, B saves → A's entry vanishes). Serialising a
/// locked read → modify → write over the shared file closes that window
/// (AGT-016, PER2-001).
///
/// Built on [`std::fs::File::lock`] / [`std::fs::File::lock_shared`]
/// (`flock` on unix, `LockFileEx` on windows). These are OS locks, so a
/// crashed holder never leaves a stale lock behind: the OS drops it with the
/// process. The lock is released when this guard is dropped. It is **never**
/// nested with another file lock in the same worker, and it guards the only
/// resource shared across workers, so it cannot participate in a cross-worker
/// deadlock (a peer waiting on the lock never also needs any in-process mutex
/// this worker holds).
#[must_use = "the lock is released as soon as the guard is dropped"]
pub struct FileLock {
    file: std::fs::File,
}

impl FileLock {
    /// Acquire an exclusive advisory lock on `path`'s sidecar lock-file,
    /// blocking until it is available. Creates the lock-file (and its parent
    /// directory) if needed. Use this for every read-modify-write.
    pub fn acquire(path: &Path) -> Result<Self> {
        let (file, lock_path) = Self::open(path)?;
        file.lock()
            .with_context(|| format!("failed to lock {}", lock_path.display()))?;
        Ok(Self { file })
    }

    /// Acquire a shared advisory lock on `path`'s sidecar lock-file, blocking
    /// while an exclusive holder is mid read-modify-write. Several readers may
    /// hold it at once.
    pub fn acquire_shared(path: &Path) -> Result<Self> {
        let (file, lock_path) = Self::open(path)?;
        file.lock_shared()
            .with_context(|| format!("failed to lock {} (shared)", lock_path.display()))?;
        Ok(Self { file })
    }

    fn open(path: &Path) -> Result<(std::fs::File, PathBuf)> {
        let lock_path = lock_path_for(path);
        if let Some(parent) = lock_path.parent() {
            // Best-effort: `open` below surfaces a real error if the dir is
            // genuinely missing and could not be created.
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("failed to open lock file {}", lock_path.display()))?;
        Ok((file, lock_path))
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // Closing the handle would release the lock too, but windows only
        // promises to do that "eventually"; unlock explicitly so the next
        // waiter gets the lock immediately.
        let _ = self.file.unlock();
    }
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

    #[test]
    fn lock_path_for_appends_lock_suffix() {
        let p = Path::new("/tmp/cfg/state.json");
        assert_eq!(lock_path_for(p), PathBuf::from("/tmp/cfg/state.json.lock"));
    }

    #[test]
    fn file_lock_can_be_acquired_and_released() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        {
            let _lock = FileLock::acquire(&path).expect("first acquire");
            // The sidecar lock file is created next to the target.
            assert!(dir.path().join("state.json.lock").exists());
        }
        // Once dropped the lock is released, so a fresh acquire succeeds.
        let _lock = FileLock::acquire(&path).expect("re-acquire after drop");
    }

    /// The lock must actually serialise two concurrent read-modify-write cycles
    /// against the same file so neither clobbers the other (AGT-016). Each thread
    /// holds the lock across a read → brief pause → increment → write; without a
    /// working cross-process lock the interleaving loses updates and the final
    /// counter is < the number of increments.
    #[test]
    fn file_lock_serialises_concurrent_read_modify_write() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("counter.txt"));
        std::fs::write(path.as_path(), "0").unwrap();

        let threads = 4;
        let iters = 25;
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    for _ in 0..iters {
                        let _lock = FileLock::acquire(&path).expect("acquire");
                        let cur: u64 = std::fs::read_to_string(path.as_path())
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        // Widen the race window so a missing lock reliably drops
                        // updates.
                        std::thread::yield_now();
                        write_atomic(&path, &(cur + 1).to_string()).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let final_count: u64 = std::fs::read_to_string(path.as_path())
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(
            final_count,
            (threads * iters) as u64,
            "the lock must serialise every increment — a lost update means a broken lock"
        );
    }

    /// A shared lock admits other readers but excludes a writer until it is
    /// dropped; an exclusive lock excludes readers.
    #[test]
    fn shared_lock_excludes_writers_but_not_readers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let lock_file = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(lock_path_for(&path))
                .unwrap()
        };

        let reader = FileLock::acquire_shared(&path).expect("shared acquire");
        let second_reader = FileLock::acquire_shared(&path).expect("second reader");
        assert!(
            matches!(
                lock_file().try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ),
            "a writer must wait for the readers"
        );
        drop(reader);
        drop(second_reader);

        let _writer = FileLock::acquire(&path).expect("exclusive acquire");
        assert!(
            matches!(
                lock_file().try_lock_shared(),
                Err(std::fs::TryLockError::WouldBlock)
            ),
            "a reader must wait for the writer"
        );
    }
}
