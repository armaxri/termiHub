//! Pinning a backend library across its integrity check and `dlopen` (#2796).
//!
//! The loader used to hash the library **by path** and then `dlopen` the same
//! path, so a file swapped in between the two was loaded unverified (the
//! check→open race of the verify-then-load TOCTOU, CORE-034). A
//! [`PinnedLibrary`] instead opens the file **once**, hashes the bytes through
//! **that handle**, keeps the handle open across the load, and re-checks it
//! afterwards — the same approach #2835 took for the RDP sidecar
//! (`backends::rdp_sidecar::integrity`).
//!
//! `libloading` offers no portable load-from-handle / load-from-memory, so the
//! residual guarantee differs per OS:
//!
//! - **Linux / Android** — the library is opened as `/proc/self/fd/<n>`, i.e.
//!   the very inode that was hashed; no path lookup happens between hash and
//!   open, so renaming or replacing the on-disk path cannot substitute another
//!   file. The handle is re-hashed after the load to catch an *in-place*
//!   rewrite of that inode made before or during the mapping. Residual: an
//!   in-place rewrite that is reverted before the post-load re-hash (the
//!   kernel does not forbid writing a `dlopen`ed file the way it does a running
//!   executable). `/proc` must be mounted; without it the open fails and the
//!   plugin is refused (fail-closed).
//! - **Windows** — the handle is opened with a share mode that grants only
//!   `FILE_SHARE_READ`, so while it is held (across `LoadLibrary`) the file
//!   cannot be written, deleted, renamed or replaced; once mapped as an image
//!   Windows itself refuses writes. The load therefore maps exactly the hashed
//!   bytes. The post-load re-hash is kept as defense in depth.
//! - **macOS / other Unix** — no load-from-descriptor exists (`dlopen` of
//!   `/dev/fd/<n>` is not reliable), so the library is opened by path. The path
//!   is checked to still name the hashed inode (same `st_dev` / `st_ino`)
//!   immediately **before and after** the load, and the handle is re-hashed
//!   after it; any mismatch unloads the library and refuses it. Residual: a
//!   swap *and swap back* entirely inside the `dlopen` window is not detected,
//!   and the swapped library's initializers would already have run. Pair with
//!   the install-record binding and trust-store anchoring in the host, which
//!   make a lasting swap impossible to load.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::LoadError;

/// The digest algorithm prefix of a `sha256:<hex>` digest — the same value
/// `termihub_core::plugin::DIGEST_ALGORITHM` names.
pub const DIGEST_ALGORITHM: &str = "sha256";

/// Windows `FILE_SHARE_READ`: while our handle is open, other openers may only
/// read (or map/execute) the file — never write, delete or rename it.
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;

/// A backend library whose bytes were hashed through a retained handle, to be
/// loaded from [`load_path`](Self::load_path) and then confirmed with
/// [`confirm_after_load`](Self::confirm_after_load). Keep it alive until then.
#[derive(Debug)]
pub struct PinnedLibrary {
    path: PathBuf,
    file: File,
    expected: String,
}

impl PinnedLibrary {
    /// Open `path`, hash it through the opened handle, and require the digest to
    /// equal `expected` (`sha256:`-prefixed). A file that cannot be opened or
    /// read fails closed with [`LoadError::LibraryDigestMismatch`].
    pub fn open_verified(path: &Path, expected: &str) -> Result<Self, LoadError> {
        let mismatch = |actual: String| LoadError::LibraryDigestMismatch {
            path: path.to_owned(),
            expected: expected.to_owned(),
            actual,
        };
        let file = open_pinned(path).map_err(|e| mismatch(format!("<unreadable: {e}>")))?;
        let actual = sha256_of_handle(&file).map_err(|e| mismatch(format!("<unreadable: {e}>")))?;
        if actual != expected {
            return Err(mismatch(actual));
        }
        Ok(Self {
            path: path.to_owned(),
            file,
            expected: expected.to_owned(),
        })
    }

    /// The path to hand to `dlopen` / `LoadLibrary`.
    ///
    /// Linux / Android: `/proc/self/fd/<n>` — the hashed inode itself. Elsewhere
    /// the real path, after confirming it still names the hashed file.
    pub fn load_path(&self) -> Result<PathBuf, LoadError> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            use std::os::fd::AsRawFd;
            Ok(PathBuf::from(format!(
                "/proc/self/fd/{}",
                self.file.as_raw_fd()
            )))
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            self.check_path_still_names_handle()?;
            Ok(self.path.clone())
        }
    }

    /// Re-verify after the load: the retained handle still hashes to the
    /// expected digest and (path-loading platforms) the path still names it.
    /// On `Err` the caller must drop (unload) the library.
    pub fn confirm_after_load(&self) -> Result<(), LoadError> {
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        self.check_path_still_names_handle()?;
        let actual = sha256_of_handle(&self.file).map_err(|e| self.changed(e.to_string()))?;
        if actual == self.expected {
            Ok(())
        } else {
            Err(self.changed(format!("expected {}, now {actual}", self.expected)))
        }
    }

    fn changed(&self, detail: String) -> LoadError {
        LoadError::LibraryChangedDuringLoad {
            path: self.path.clone(),
            detail,
        }
    }

    /// Path-loading platforms: fail unless `self.path` still resolves to the
    /// same file as the hashed handle (a replace changes the file identity).
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    fn check_path_still_names_handle(&self) -> Result<(), LoadError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            match (self.file.metadata(), std::fs::metadata(&self.path)) {
                (Ok(p), Ok(c)) if p.dev() == c.dev() && p.ino() == c.ino() => Ok(()),
                _ => Err(self.changed("the file was replaced after its integrity check".into())),
            }
        }
        #[cfg(not(unix))]
        {
            // Windows: the share-deny handle makes a replace impossible while held.
            Ok(())
        }
    }
}

/// Open the library for hashing; on Windows deny write/delete sharing for as
/// long as the handle lives.
fn open_pinned(path: &Path) -> std::io::Result<File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(FILE_SHARE_READ);
    }
    opts.open(path)
}

/// The `sha256:`-prefixed digest of an open file, from its start regardless of
/// the handle's position — the same value as `signature::sha256_file`.
fn sha256_of_handle(file: &File) -> std::io::Result<String> {
    let mut reader = file;
    reader.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!(
        "{DIGEST_ALGORITHM}:{}",
        hex::encode(hasher.finalize())
    ))
}

#[cfg(test)]

/// The `sha256:`-prefixed digest of `bytes` (test helper; core's
/// `signature::sha256_digest` produces the same value).
#[cfg(test)]
fn sha256_digest(bytes: &[u8]) -> String {
    format!("{DIGEST_ALGORITHM}:{}", hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib_with(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("libp.bin");
        std::fs::write(&path, bytes).unwrap();
        (tmp, path)
    }

    #[test]
    fn handle_digest_matches_the_path_digest() {
        let (_tmp, path) = lib_with(b"library bytes");
        let file = open_pinned(&path).unwrap();
        assert_eq!(
            sha256_of_handle(&file).unwrap(),
            sha256_digest(&std::fs::read(&path).unwrap())
        );
    }

    #[test]
    fn a_mismatched_digest_is_refused_before_load() {
        let (_tmp, path) = lib_with(b"evil bytes");
        match PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")) {
            Err(LoadError::LibraryDigestMismatch { actual, .. }) => {
                assert_eq!(actual, sha256_digest(b"evil bytes"));
            }
            other => panic!("expected LibraryDigestMismatch, got {other:?}"),
        }
    }

    #[test]
    fn an_unreadable_library_fails_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("gone.bin");
        assert!(matches!(
            PinnedLibrary::open_verified(&missing, &sha256_digest(b"x")),
            Err(LoadError::LibraryDigestMismatch { .. })
        ));
    }

    #[test]
    fn an_unchanged_pin_confirms() {
        let (_tmp, path) = lib_with(b"good bytes");
        let pin = PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")).unwrap();
        let _ = pin.load_path().unwrap();
        pin.confirm_after_load().unwrap();
    }

    /// Linux / Android load the hashed inode through `/proc/self/fd/<n>`, so a
    /// rename-replace of the path after the check does not change what loads.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn linux_loads_the_pinned_inode_not_the_path() {
        let (tmp, path) = lib_with(b"good bytes");
        let pin = PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")).unwrap();

        let evil = tmp.path().join("evil.bin");
        std::fs::write(&evil, b"evil bytes").unwrap();
        std::fs::rename(&evil, &path).unwrap();

        let load_path = pin.load_path().unwrap();
        assert!(load_path.starts_with("/proc/self/fd/"), "{load_path:?}");
        assert_eq!(std::fs::read(&load_path).unwrap(), b"good bytes");
        pin.confirm_after_load().unwrap();
    }

    /// Linux: an in-place rewrite of the pinned inode is caught by the post-load
    /// re-hash.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn linux_detects_an_in_place_rewrite() {
        let (_tmp, path) = lib_with(b"good bytes");
        let pin = PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")).unwrap();
        std::fs::write(&path, b"evil bytes").unwrap();
        assert!(matches!(
            pin.confirm_after_load(),
            Err(LoadError::LibraryChangedDuringLoad { .. })
        ));
    }

    /// macOS / other Unix load by path, so a replace after the check is caught
    /// by the identity check before (and after) the load.
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    #[test]
    fn path_loading_unix_detects_a_replaced_file() {
        let (tmp, path) = lib_with(b"good bytes");
        let pin = PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")).unwrap();

        let evil = tmp.path().join("evil.bin");
        std::fs::write(&evil, b"evil bytes").unwrap();
        std::fs::rename(&evil, &path).unwrap();

        assert!(matches!(
            pin.load_path(),
            Err(LoadError::LibraryChangedDuringLoad { .. })
        ));
        assert!(matches!(
            pin.confirm_after_load(),
            Err(LoadError::LibraryChangedDuringLoad { .. })
        ));
    }

    /// macOS / other Unix: an in-place rewrite keeps the inode but is caught by
    /// the post-load re-hash of the retained handle.
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    #[test]
    fn path_loading_unix_detects_an_in_place_rewrite() {
        let (_tmp, path) = lib_with(b"good bytes");
        let pin = PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")).unwrap();
        std::fs::write(&path, b"evil bytes").unwrap();
        assert!(matches!(
            pin.confirm_after_load(),
            Err(LoadError::LibraryChangedDuringLoad { .. })
        ));
    }

    /// Windows: while the pin is held the file cannot be rewritten, replaced or
    /// deleted, so what loads is what was hashed.
    #[cfg(windows)]
    #[test]
    fn windows_pin_denies_write_replace_and_delete() {
        let (tmp, path) = lib_with(b"good bytes");
        let pin = PinnedLibrary::open_verified(&path, &sha256_digest(b"good bytes")).unwrap();

        assert!(std::fs::write(&path, b"evil bytes").is_err());
        let evil = tmp.path().join("evil.bin");
        std::fs::write(&evil, b"evil bytes").unwrap();
        assert!(std::fs::rename(&evil, &path).is_err());
        assert!(std::fs::remove_file(&path).is_err());

        assert_eq!(pin.load_path().unwrap(), path);
        pin.confirm_after_load().unwrap();
        drop(pin);
        std::fs::remove_file(&path).unwrap();
    }
}
