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

/// A held exclusive **cross-process** advisory lock on a config file's sidecar
/// lock-file.
///
/// This is the concurrency control [`write_atomic`] alone cannot provide: it
/// prevents a torn *file*, but two `--stdio` workers sharing a per-user
/// `state.json` can still lost-update each other (worker A loads, B loads, A
/// saves, B saves → A's session vanishes). Serialising a locked read → modify →
/// write over the shared file closes that window (AGT-016).
///
/// The lock is advisory and process-wide: it is acquired with `flock` on unix
/// and `LockFileEx` on windows, and released when this guard is dropped. It is
/// **never** nested with another file lock in the same worker, and it guards the
/// only resource shared across workers, so it cannot participate in a
/// cross-worker deadlock (a peer waiting on the lock never also needs any
/// in-process mutex this worker holds).
#[must_use = "the lock is released as soon as the guard is dropped"]
pub struct FileLock {
    #[cfg(unix)]
    _flock: nix::fcntl::Flock<std::fs::File>,
    #[cfg(windows)]
    file: std::fs::File,
    #[cfg(not(any(unix, windows)))]
    _file: std::fs::File,
}

impl FileLock {
    /// Acquire an exclusive advisory lock on `path`'s sidecar lock-file,
    /// blocking until it is available. Creates the lock-file (and its parent
    /// directory) if needed.
    pub fn acquire(path: &Path) -> Result<Self> {
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
        Self::lock_file(file, &lock_path)
    }

    #[cfg(unix)]
    fn lock_file(file: std::fs::File, lock_path: &Path) -> Result<Self> {
        use nix::fcntl::{Flock, FlockArg};
        let flock = Flock::lock(file, FlockArg::LockExclusive)
            .map_err(|(_, errno)| errno)
            .with_context(|| format!("failed to flock {}", lock_path.display()))?;
        Ok(Self { _flock: flock })
    }

    #[cfg(windows)]
    fn lock_file(file: std::fs::File, lock_path: &Path) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK};
        use windows_sys::Win32::System::IO::OVERLAPPED;

        let handle = file.as_raw_handle();
        // Safety: `LockFileEx` on a valid handle with a zeroed OVERLAPPED takes a
        // blocking exclusive lock on a 1-byte range at offset 0. We hold `file`
        // for the guard's lifetime so the handle stays valid until Drop unlocks.
        let ok = unsafe {
            let mut overlapped: OVERLAPPED = std::mem::zeroed();
            LockFileEx(
                handle as _,
                LOCKFILE_EXCLUSIVE_LOCK,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("failed to LockFileEx {}", lock_path.display()));
        }
        Ok(Self { file })
    }

    #[cfg(not(any(unix, windows)))]
    fn lock_file(file: std::fs::File, _lock_path: &Path) -> Result<Self> {
        // No advisory-lock primitive on this platform; degrade to a best-effort
        // no-op guard (the agent only ships on unix and windows).
        Ok(Self { _file: file })
    }
}

#[cfg(windows)]
impl Drop for FileLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
        use windows_sys::Win32::System::IO::OVERLAPPED;

        let handle = self.file.as_raw_handle();
        // Safety: mirrors the 1-byte range locked in `lock_file`; the handle is
        // still valid because `self.file` is alive until this Drop completes.
        unsafe {
            let mut overlapped: OVERLAPPED = std::mem::zeroed();
            let _ = UnlockFileEx(handle as _, 0, 1, 0, &mut overlapped);
        }
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
}
