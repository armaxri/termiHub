//! Root-anchored filesystem opens for the plugin capability bridge (#4391).
//!
//! [`FilesystemScope::check`](super::FilesystemScope::check) canonicalizes a
//! requested path and proves it lies under a declared root. Opening the
//! resolved path **by name** afterwards leaves a window: a component inside the
//! root can be swapped for a symlink pointing outside it (by the plugin, through
//! its own write access to the root, or by another process) between the check
//! and the open, and a by-name open would follow it out of scope.
//!
//! The functions here close that window by never resolving a path by name
//! beyond the canonical root:
//!
//! * **Linux** — `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` relative to a
//!   handle on the root, so the kernel refuses any symlink and any escape.
//!   Kernels or sandboxes without `openat2` fall back to the macOS walk.
//! * **Unix (macOS, and the Linux fallback)** — a per-component walk from the
//!   root handle with `openat(O_NOFOLLOW | O_DIRECTORY)`, then the leaf with
//!   `O_NOFOLLOW`: a symlink anywhere in the path fails the open (`ELOOP` /
//!   `ENOTDIR`) instead of being followed.
//! * **Windows** — the leaf is opened with `FILE_FLAG_OPEN_REPARSE_POINT` (a
//!   swapped-in symlink or junction is opened as itself and refused, never
//!   followed), without `FILE_SHARE_DELETE` (the handle pins the path), and the
//!   handle's final path (`GetFinalPathNameByHandleW`) must still lie under the
//!   canonical root — which catches a reparse point swapped into an ancestor.
//!
//! As defence in depth, every opened handle's real path is re-verified against
//! the canonical root where that is cheap (`/proc/self/fd` on Linux,
//! `F_GETPATH` on macOS, `GetFinalPathNameByHandleW` on Windows); a mismatch is
//! refused as an escape.
//!
//! These opens run **after** the scope check, never instead of it: the check
//! still decides *whether* a path is in scope; this module guarantees that the
//! object actually opened is the one the check approved.

use std::ffi::OsString;
use std::fs::File;
use std::path::{Component, Path};

/// Why an anchored open failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnchoredError {
    /// The path no longer resolves inside the root without following a
    /// symlink — a component was swapped after the scope check. Reported to the
    /// plugin as a permission denial.
    Escape,
    /// A component of the path does not exist.
    NotFound,
    /// Any other I/O failure.
    Io,
}

/// How [`open_write`] opens its target, mirroring the ABI's write modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteMode {
    /// Create if missing, truncate if present.
    Truncate,
    /// Create if missing, append if present.
    Append,
    /// Create; fail if the path already exists.
    CreateNew,
}

/// Metadata of an anchored [`stat`] that found its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stat {
    /// Whether the target is a directory.
    pub(crate) is_dir: bool,
    /// The target's length in bytes.
    pub(crate) len: u64,
}

/// The components of `resolved` below `root`, all plain names.
///
/// Both paths are canonical (the scope check produced them), so the remainder
/// holds no `.`/`..`/root components; anything else is refused as an escape.
fn relative_components<'a>(
    root: &Path,
    resolved: &'a Path,
) -> Result<Vec<&'a std::ffi::OsStr>, AnchoredError> {
    let rest = resolved
        .strip_prefix(root)
        .map_err(|_| AnchoredError::Escape)?;
    rest.components()
        .map(|c| match c {
            Component::Normal(name) => Ok(name),
            _ => Err(AnchoredError::Escape),
        })
        .collect()
}

/// Whether `real` (an opened handle's real path) lies at or under `root`.
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", windows)),
    allow(dead_code, reason = "no cheap fd-path lookup on this platform")
)]
fn within(root: &Path, real: &Path) -> bool {
    real == root || real.starts_with(root)
}

/// Open the existing file `resolved` (under the canonical `root`) for reading.
pub(crate) fn open_read(root: &Path, resolved: &Path) -> Result<File, AnchoredError> {
    imp::open_read(root, resolved)
}

/// Open `resolved` (under the canonical `root`) for writing per `mode`,
/// creating it inside its (existing) parent directory where `mode` allows.
pub(crate) fn open_write(
    root: &Path,
    resolved: &Path,
    mode: WriteMode,
) -> Result<File, AnchoredError> {
    imp::open_write(root, resolved, mode)
}

/// Metadata of `resolved` (under the canonical `root`), or `None` if it does
/// not exist. A symlink at the leaf is refused, never followed.
pub(crate) fn stat(root: &Path, resolved: &Path) -> Result<Option<Stat>, AnchoredError> {
    imp::stat(root, resolved)
}

/// The entry names of the directory `resolved` (under the canonical `root`),
/// in the host's directory order, read through the anchored directory handle.
/// `.` and `..` are omitted.
pub(crate) fn list_dir(
    root: &Path,
    resolved: &Path,
) -> Result<impl Iterator<Item = OsString>, AnchoredError> {
    imp::list_dir(root, resolved)
}

#[cfg(unix)]
mod imp {
    use super::{relative_components, AnchoredError, Stat, WriteMode};
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;

    /// Flags for walking an intermediate directory component.
    const DIR_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    /// The mode a newly created file gets (before the umask), as `std` uses.
    const CREATE_MODE: libc::mode_t = 0o666;

    fn c_string(name: &OsStr) -> Result<CString, AnchoredError> {
        CString::new(name.as_bytes()).map_err(|_| AnchoredError::Io)
    }

    fn last_error() -> std::io::Error {
        std::io::Error::last_os_error()
    }

    /// `lstat`-style metadata of `name` in `dir`, never following a symlink.
    fn lstat_at(dir: RawFd, name: &CStr) -> Option<libc::stat> {
        // SAFETY: `stat` is plain old data, so a zeroed value is valid and
        // `fstatat` fully initializes it on success.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `dir` is an open descriptor, `name` a NUL-terminated string,
        // and `st` a valid out-pointer for the duration of the call.
        let rc = unsafe { libc::fstatat(dir, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
        (rc == 0).then_some(st)
    }

    fn is_symlink(st: &libc::stat) -> bool {
        (st.st_mode & libc::S_IFMT) == libc::S_IFLNK
    }

    /// Classify a failed `openat` of `name` in `dir`. A symlink in the way
    /// (`ELOOP`, or `ENOTDIR` where the platform reports a refused
    /// `O_NOFOLLOW | O_DIRECTORY` that way) is an escape attempt.
    fn classify(dir: RawFd, name: &CStr, err: &std::io::Error) -> AnchoredError {
        match err.raw_os_error() {
            Some(libc::ELOOP) | Some(libc::EXDEV) => AnchoredError::Escape,
            Some(libc::ENOENT) => AnchoredError::NotFound,
            _ if lstat_at(dir, name).is_some_and(|st| is_symlink(&st)) => AnchoredError::Escape,
            _ => AnchoredError::Io,
        }
    }

    fn openat(
        dir: RawFd,
        name: &CStr,
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> Result<OwnedFd, AnchoredError> {
        // SAFETY: `dir` is an open descriptor and `name` a NUL-terminated
        // string; the mode is passed as the variadic `c_uint` `openat` expects.
        let fd = unsafe { libc::openat(dir, name.as_ptr(), flags, libc::c_uint::from(mode)) };
        if fd < 0 {
            let err = last_error();
            return Err(classify(dir, name, &err));
        }
        // SAFETY: `fd` is a freshly opened descriptor that nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// Open the canonical root itself. It was canonicalized by the scope check,
    /// so its last component is not a symlink unless one was swapped in since.
    fn open_root(root: &Path) -> Result<OwnedFd, AnchoredError> {
        let path = c_string(root.as_os_str())?;
        // SAFETY: `path` is NUL-terminated; `open` takes no mode without O_CREAT.
        let fd = unsafe { libc::open(path.as_ptr(), DIR_FLAGS) };
        if fd < 0 {
            return Err(match last_error().raw_os_error() {
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => AnchoredError::Escape,
                Some(libc::ENOENT) => AnchoredError::NotFound,
                _ => AnchoredError::Io,
            });
        }
        // SAFETY: `fd` is a freshly opened descriptor that nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// Walk `components` below `root_fd` one directory at a time with
    /// `O_NOFOLLOW`, returning a handle on the last one (or a duplicate of the
    /// root for none).
    fn walk(root_fd: &OwnedFd, components: &[&OsStr]) -> Result<OwnedFd, AnchoredError> {
        let mut current = root_fd.try_clone().map_err(|_| AnchoredError::Io)?;
        for name in components {
            let name = c_string(name)?;
            current = openat(current.as_raw_fd(), &name, DIR_FLAGS, 0)?;
        }
        Ok(current)
    }

    /// `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` of `components` below
    /// `root_fd`. `None` when the kernel (or a seccomp filter) does not offer
    /// `openat2`, so the caller falls back to the per-component walk.
    #[cfg(target_os = "linux")]
    fn openat2_beneath(
        root_fd: &OwnedFd,
        components: &[&OsStr],
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> Option<Result<OwnedFd, AnchoredError>> {
        let joined: std::path::PathBuf = if components.is_empty() {
            ".".into()
        } else {
            components.iter().collect()
        };
        let path = match c_string(joined.as_os_str()) {
            Ok(p) => p,
            Err(e) => return Some(Err(e)),
        };
        // SAFETY: `open_how` is plain old data; zero is a valid value for each
        // field (and is required for the reserved/unused ones).
        let mut how: libc::open_how = unsafe { std::mem::zeroed() };
        how.flags = u64::try_from(flags | libc::O_CLOEXEC).unwrap_or(0);
        how.mode = if flags & libc::O_CREAT != 0 {
            u64::from(mode)
        } else {
            0
        };
        how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS;
        // SAFETY: `root_fd` is an open descriptor, `path` NUL-terminated, and
        // `how` a valid `open_how` of the size passed.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root_fd.as_raw_fd(),
                path.as_ptr(),
                std::ptr::addr_of!(how),
                std::mem::size_of::<libc::open_how>(),
            )
        };
        if rc < 0 {
            let err = last_error();
            return match err.raw_os_error() {
                // Unavailable (old kernel, seccomp profile) or an argument this
                // kernel rejects: the per-component walk is equally safe.
                Some(libc::ENOSYS) | Some(libc::EPERM) | Some(libc::EINVAL) | Some(libc::E2BIG) => {
                    None
                }
                Some(libc::ELOOP) | Some(libc::EXDEV) => Some(Err(AnchoredError::Escape)),
                Some(libc::ENOENT) => Some(Err(AnchoredError::NotFound)),
                _ => Some(Err(AnchoredError::Io)),
            };
        }
        let Ok(fd) = RawFd::try_from(rc) else {
            return Some(Err(AnchoredError::Io));
        };
        // SAFETY: `fd` is a freshly opened descriptor that nothing else owns.
        Some(Ok(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    /// Open `components` below `root_fd` with `flags`, refusing any symlink.
    fn open_beneath(
        root_fd: &OwnedFd,
        components: &[&OsStr],
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> Result<OwnedFd, AnchoredError> {
        #[cfg(target_os = "linux")]
        if let Some(result) = openat2_beneath(root_fd, components, flags, mode) {
            return result;
        }
        walk_open(root_fd, components, flags, mode)
    }

    /// The portable form of [`open_beneath`]: walk the parents with
    /// `O_NOFOLLOW | O_DIRECTORY`, then open the leaf with `O_NOFOLLOW`. Used on
    /// macOS, and on Linux when `openat2` is unavailable.
    fn walk_open(
        root_fd: &OwnedFd,
        components: &[&OsStr],
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> Result<OwnedFd, AnchoredError> {
        let flags = flags | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        match components.split_last() {
            None => openat(root_fd.as_raw_fd(), c".", flags, mode),
            Some((leaf, parents)) => {
                let parent = walk(root_fd, parents)?;
                openat(parent.as_raw_fd(), &c_string(leaf)?, flags, mode)
            }
        }
    }

    /// The real path the kernel associates with `fd`, where that is cheap.
    #[cfg(target_os = "linux")]
    fn fd_path(fd: RawFd) -> Option<std::path::PathBuf> {
        std::fs::read_link(format!("/proc/self/fd/{fd}")).ok()
    }

    /// The real path the kernel associates with `fd`, where that is cheap.
    #[cfg(target_os = "macos")]
    fn fd_path(fd: RawFd) -> Option<std::path::PathBuf> {
        let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
        // SAFETY: `F_GETPATH` writes at most `MAXPATHLEN` (== `PATH_MAX`)
        // bytes, NUL included, into the buffer, which is larger than that.
        let rc = unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) };
        if rc < 0 {
            return None;
        }
        let len = buf.iter().position(|&b| b == 0)?;
        buf.truncate(len);
        Some(OsString::from_vec(buf).into())
    }

    /// No cheap descriptor-to-path lookup on this platform; the anchored open
    /// alone carries the guarantee.
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn fd_path(_fd: RawFd) -> Option<std::path::PathBuf> {
        None
    }

    /// Defence in depth: refuse a handle whose real path left the root.
    fn verify(root: &Path, fd: &OwnedFd) -> Result<(), AnchoredError> {
        match fd_path(fd.as_raw_fd()) {
            Some(real) if !super::within(root, &real) => Err(AnchoredError::Escape),
            _ => Ok(()),
        }
    }

    /// Open `resolved` for reading through the per-component walk only,
    /// bypassing `openat2`, so tests exercise the Linux fallback too.
    #[cfg(test)]
    pub(super) fn open_read_walk_only(root: &Path, resolved: &Path) -> Result<File, AnchoredError> {
        let components = relative_components(root, resolved)?;
        let root_fd = open_root(root)?;
        let fd = walk_open(&root_fd, &components, libc::O_RDONLY, 0)?;
        verify(root, &fd)?;
        Ok(File::from(fd))
    }

    fn open_file(
        root: &Path,
        resolved: &Path,
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> Result<File, AnchoredError> {
        let components = relative_components(root, resolved)?;
        let root_fd = open_root(root)?;
        let fd = open_beneath(&root_fd, &components, flags, mode)?;
        verify(root, &fd)?;
        Ok(File::from(fd))
    }

    pub(super) fn open_read(root: &Path, resolved: &Path) -> Result<File, AnchoredError> {
        open_file(root, resolved, libc::O_RDONLY, 0)
    }

    pub(super) fn open_write(
        root: &Path,
        resolved: &Path,
        mode: WriteMode,
    ) -> Result<File, AnchoredError> {
        let flags = match mode {
            WriteMode::Truncate => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
            WriteMode::Append => libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
            WriteMode::CreateNew => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        };
        open_file(root, resolved, flags, CREATE_MODE)
    }

    pub(super) fn stat(root: &Path, resolved: &Path) -> Result<Option<Stat>, AnchoredError> {
        let components = relative_components(root, resolved)?;
        let root_fd = open_root(root)?;
        let (dir, leaf) = match components.split_last() {
            None => (root_fd, c".".to_owned()),
            Some((leaf, parents)) => {
                let dir = match open_beneath(&root_fd, parents, DIR_FLAGS, 0) {
                    Ok(dir) => dir,
                    Err(AnchoredError::NotFound) => return Ok(None),
                    Err(e) => return Err(e),
                };
                (dir, c_string(leaf)?)
            }
        };
        verify(root, &dir)?;
        let Some(st) = lstat_at(dir.as_raw_fd(), &leaf) else {
            return match last_error().raw_os_error() {
                Some(libc::ENOENT) | Some(libc::ENOTDIR) => Ok(None),
                _ => Err(AnchoredError::Io),
            };
        };
        if is_symlink(&st) {
            return Err(AnchoredError::Escape);
        }
        Ok(Some(Stat {
            is_dir: (st.st_mode & libc::S_IFMT) == libc::S_IFDIR,
            len: u64::try_from(st.st_size).unwrap_or(0),
        }))
    }

    /// A directory stream read from an anchored descriptor; closed on drop.
    pub(super) struct Dir(std::ptr::NonNull<libc::DIR>);

    impl Iterator for Dir {
        type Item = OsString;

        fn next(&mut self) -> Option<OsString> {
            loop {
                // SAFETY: `self.0` is an open stream owned by this `Dir`.
                let entry = unsafe { libc::readdir(self.0.as_ptr()) };
                if entry.is_null() {
                    return None;
                }
                // SAFETY: a non-null `readdir` result points at a valid entry
                // whose `d_name` is NUL-terminated, until the next call.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                let bytes = name.to_bytes();
                if bytes == b"." || bytes == b".." {
                    continue;
                }
                return Some(OsString::from_vec(bytes.to_vec()));
            }
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            // SAFETY: `self.0` is an open stream owned by this `Dir`, closed
            // exactly once here (which also closes its descriptor).
            unsafe {
                libc::closedir(self.0.as_ptr());
            }
        }
    }

    pub(super) fn list_dir(root: &Path, resolved: &Path) -> Result<Dir, AnchoredError> {
        let components = relative_components(root, resolved)?;
        let root_fd = open_root(root)?;
        let fd = open_beneath(&root_fd, &components, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        verify(root, &fd)?;
        let raw = fd.into_raw_fd();
        // SAFETY: `raw` is an open directory descriptor whose ownership passes
        // to the stream on success.
        let stream = unsafe { libc::fdopendir(raw) };
        match std::ptr::NonNull::new(stream) {
            Some(stream) => Ok(Dir(stream)),
            None => {
                // SAFETY: `fdopendir` failed, so `raw` is still ours to close.
                drop(unsafe { OwnedFd::from_raw_fd(raw) });
                Err(AnchoredError::Io)
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{relative_components, AnchoredError, Stat, WriteMode};
    use std::ffi::OsString;
    use std::fs::{File, OpenOptions};
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_NAME_NORMALIZED, FILE_SHARE_READ, FILE_SHARE_WRITE, VOLUME_NAME_DOS,
    };

    fn io_error(err: &std::io::Error) -> AnchoredError {
        if err.kind() == std::io::ErrorKind::NotFound {
            AnchoredError::NotFound
        } else {
            AnchoredError::Io
        }
    }

    /// The handle's final, fully resolved path (`\\?\C:\…`, the same form
    /// `std::fs::canonicalize` — and so the canonical root — uses).
    fn final_path(file: &File) -> Option<PathBuf> {
        let mut buf: Vec<u16> = vec![0; 512];
        loop {
            let cap = u32::try_from(buf.len()).ok()?;
            // SAFETY: the handle is open for the duration of the call and
            // `buf` is a writable buffer of `cap` UTF-16 units.
            let len = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buf.as_mut_ptr(),
                    cap,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            };
            let len = usize::try_from(len).ok()?;
            if len == 0 {
                return None;
            }
            if len < buf.len() {
                buf.truncate(len);
                return Some(OsString::from_wide(&buf).into());
            }
            // Too small: `len` is the size needed, NUL included.
            buf.resize(len + 1, 0);
        }
    }

    /// Open `resolved` with `options`, never following a reparse point at the
    /// leaf, then prove the handle is not a link and still lies under `root`.
    ///
    /// The handle is opened without `FILE_SHARE_DELETE`, so while it is held
    /// neither it nor (on NTFS) any ancestor directory can be renamed or
    /// replaced.
    fn open_verified(
        root: &Path,
        resolved: &Path,
        options: &mut OpenOptions,
    ) -> Result<File, AnchoredError> {
        // Proves `resolved` lies under `root` before touching the filesystem.
        relative_components(root, resolved)?;
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
        let file = options.open(resolved).map_err(|e| io_error(&e))?;
        let meta = file.metadata().map_err(|_| AnchoredError::Io)?;
        // A symlink or junction swapped in at the leaf is opened as itself
        // (`FILE_FLAG_OPEN_REPARSE_POINT`): refuse it rather than use it.
        if meta.file_type().is_symlink() {
            return Err(AnchoredError::Escape);
        }
        // A reparse point swapped into an ancestor was followed by the open;
        // the handle's final path then lies outside the root.
        match final_path(&file) {
            Some(real) if super::within(root, &real) => Ok(file),
            Some(_) => Err(AnchoredError::Escape),
            None => Err(AnchoredError::Io),
        }
    }

    pub(super) fn open_read(root: &Path, resolved: &Path) -> Result<File, AnchoredError> {
        open_verified(root, resolved, OpenOptions::new().read(true))
    }

    pub(super) fn open_write(
        root: &Path,
        resolved: &Path,
        mode: WriteMode,
    ) -> Result<File, AnchoredError> {
        let mut options = OpenOptions::new();
        match mode {
            // Not `truncate(true)`: truncation waits until the handle is
            // verified, so a swapped-in link is never truncated through.
            WriteMode::Truncate => options.write(true).create(true),
            WriteMode::Append => options.append(true).create(true),
            WriteMode::CreateNew => options.write(true).create_new(true),
        };
        let file = open_verified(root, resolved, &mut options)?;
        if mode == WriteMode::Truncate {
            file.set_len(0).map_err(|_| AnchoredError::Io)?;
        }
        Ok(file)
    }

    pub(super) fn stat(root: &Path, resolved: &Path) -> Result<Option<Stat>, AnchoredError> {
        // Access 0: metadata only, so a file the user cannot read still stats.
        match open_verified(root, resolved, OpenOptions::new().access_mode(0)) {
            Ok(file) => {
                let meta = file.metadata().map_err(|_| AnchoredError::Io)?;
                Ok(Some(Stat {
                    is_dir: meta.is_dir(),
                    len: meta.len(),
                }))
            }
            Err(AnchoredError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// A directory listing read while the verified directory handle is held.
    pub(super) struct Dir {
        /// Pins the directory (no `FILE_SHARE_DELETE`) for the listing.
        _handle: File,
        entries: std::fs::ReadDir,
    }

    impl Iterator for Dir {
        type Item = OsString;

        fn next(&mut self) -> Option<OsString> {
            self.entries
                .by_ref()
                .flatten()
                .next()
                .map(|e| e.file_name())
        }
    }

    pub(super) fn list_dir(root: &Path, resolved: &Path) -> Result<Dir, AnchoredError> {
        let handle = open_verified(root, resolved, OpenOptions::new().read(true))?;
        if !handle.metadata().map_err(|_| AnchoredError::Io)?.is_dir() {
            return Err(AnchoredError::Io);
        }
        // The held handle stops the directory (and its ancestors) from being
        // renamed or replaced, so this by-name read sees the verified object.
        let entries = std::fs::read_dir(resolved).map_err(|e| io_error(&e))?;
        Ok(Dir {
            _handle: handle,
            entries,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::PluginPermission;
    use crate::plugin::security::{PermissionSet, ScopedPath};
    use std::io::{Read, Write};

    /// The scope check for `path` under a filesystem grant on `root` — run
    /// separately from the open, as the bridge does, so a test can mutate the
    /// tree in between.
    fn check(root: &Path, path: &Path) -> ScopedPath {
        let roots = vec![root.to_str().unwrap().to_owned()];
        PermissionSet::from_parts([PluginPermission::Filesystem], &roots)
            .check_path_anchored(path)
            .expect("in scope at check time")
    }

    fn read_all(mut file: File) -> Vec<u8> {
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        buf
    }

    #[test]
    fn relative_components_strip_the_root() {
        let root = Path::new("/r/root");
        assert_eq!(
            relative_components(root, Path::new("/r/root/a/b")),
            Ok(vec![std::ffi::OsStr::new("a"), std::ffi::OsStr::new("b")])
        );
        assert_eq!(relative_components(root, root), Ok(vec![]));
        assert_eq!(
            relative_components(root, Path::new("/r/other")),
            Err(AnchoredError::Escape)
        );
    }

    /// A scratch tree: `<tmp>/root/sub/data.txt` in scope and
    /// `<tmp>/outside/{secret.txt,dir/}` out of it.
    struct Tree {
        _tmp: tempfile::TempDir,
        root: std::path::PathBuf,
        outside: std::path::PathBuf,
    }

    fn tree() -> Tree {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(outside.join("dir")).unwrap();
        std::fs::write(root.join("sub/data.txt"), b"in scope").unwrap();
        std::fs::write(outside.join("secret.txt"), b"top secret").unwrap();
        std::fs::write(outside.join("dir/hidden.txt"), b"hidden").unwrap();
        Tree {
            _tmp: tmp,
            root,
            outside,
        }
    }

    #[test]
    fn in_scope_operations_work() {
        let t = tree();
        let data = t.root.join("sub/data.txt");

        let s = check(&t.root, &data);
        assert_eq!(
            read_all(open_read(&s.root, &s.resolved).unwrap()),
            b"in scope"
        );

        let s = check(&t.root, &data);
        open_write(&s.root, &s.resolved, WriteMode::Truncate)
            .unwrap()
            .write_all(b"new")
            .unwrap();
        open_write(&s.root, &s.resolved, WriteMode::Append)
            .unwrap()
            .write_all(b"+more")
            .unwrap();
        assert_eq!(std::fs::read(&data).unwrap(), b"new+more");

        assert_eq!(
            stat(&s.root, &s.resolved).unwrap(),
            Some(Stat {
                is_dir: false,
                len: 8
            })
        );
        let sub = check(&t.root, &t.root.join("sub"));
        assert!(stat(&sub.root, &sub.resolved).unwrap().unwrap().is_dir);
        let root = check(&t.root, &t.root);
        assert!(stat(&root.root, &root.resolved).unwrap().unwrap().is_dir);

        let missing = check(&t.root, &t.root.join("sub/missing"));
        assert_eq!(stat(&missing.root, &missing.resolved).unwrap(), None);
        let missing_parent = check(&t.root, &t.root.join("nope/missing"));
        assert_eq!(
            stat(&missing_parent.root, &missing_parent.resolved).unwrap(),
            None
        );

        let names: Vec<OsString> = list_dir(&root.root, &root.resolved).unwrap().collect();
        assert_eq!(names, vec![OsString::from("sub")]);
        let names: Vec<OsString> = list_dir(&sub.root, &sub.resolved).unwrap().collect();
        assert_eq!(names, vec![OsString::from("data.txt")]);
    }

    #[test]
    fn new_files_are_created_inside_scope() {
        let t = tree();
        let fresh = t.root.join("sub/fresh.txt");
        let s = check(&t.root, &fresh);
        open_write(&s.root, &s.resolved, WriteMode::CreateNew)
            .unwrap()
            .write_all(b"created")
            .unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"created");
        // Create-new on an existing file is an I/O error, not an escape.
        assert_eq!(
            open_write(&s.root, &s.resolved, WriteMode::CreateNew).err(),
            Some(AnchoredError::Io)
        );
        // Truncate/append create a missing file too.
        for (name, mode) in [("t.txt", WriteMode::Truncate), ("a.txt", WriteMode::Append)] {
            let s = check(&t.root, &t.root.join(name));
            open_write(&s.root, &s.resolved, mode).unwrap();
            assert!(t.root.join(name).is_file());
        }
        // A missing parent directory is not created.
        let deep = check(&t.root, &t.root.join("no/such/dir.txt"));
        assert_eq!(
            open_write(&deep.root, &deep.resolved, WriteMode::Truncate).err(),
            Some(AnchoredError::NotFound)
        );
    }

    /// Replace `path` (inside the root) with a symlink to `target`.
    #[cfg(unix)]
    fn swap_for_symlink(path: &Path, target: &Path) {
        if path.is_dir() {
            std::fs::rename(path, path.with_extension("moved")).unwrap();
        } else if path.exists() {
            std::fs::remove_file(path).unwrap();
        }
        std::os::unix::fs::symlink(target, path).unwrap();
    }

    /// The race #4391 closes: a directory component inside the root is swapped
    /// for a symlink to outside **after** the scope check approved the path.
    /// Every operation must refuse it rather than follow it out of scope.
    #[cfg(unix)]
    #[test]
    fn a_directory_swapped_for_a_symlink_after_the_check_is_refused() {
        let t = tree();
        let sub = t.root.join("sub");
        // All checks happen while `sub` is still a real directory ...
        let read = check(&t.root, &sub.join("secret.txt"));
        let _ = std::fs::write(sub.join("secret.txt"), b"decoy");
        let write = check(&t.root, &sub.join("secret.txt"));
        let create = check(&t.root, &sub.join("planted.txt"));
        let stat_child = check(&t.root, &sub.join("secret.txt"));
        let list = check(&t.root, &sub);
        let list_nested = check(&t.root, &sub);

        // ... then `sub` becomes a symlink to the out-of-scope directory.
        swap_for_symlink(&sub, &t.outside);

        assert_eq!(
            open_read(&read.root, &read.resolved).err(),
            Some(AnchoredError::Escape)
        );
        assert_eq!(
            imp::open_read_walk_only(&read.root, &read.resolved).err(),
            Some(AnchoredError::Escape)
        );
        for mode in [WriteMode::Truncate, WriteMode::Append, WriteMode::CreateNew] {
            assert_eq!(
                open_write(&write.root, &write.resolved, mode).err(),
                Some(AnchoredError::Escape)
            );
        }
        assert_eq!(
            open_write(&create.root, &create.resolved, WriteMode::CreateNew).err(),
            Some(AnchoredError::Escape)
        );
        assert_eq!(
            stat(&stat_child.root, &stat_child.resolved),
            Err(AnchoredError::Escape)
        );
        assert_eq!(
            list_dir(&list.root, &list.resolved).err(),
            Some(AnchoredError::Escape)
        );
        assert_eq!(
            list_dir(&list_nested.root, &list_nested.resolved).err(),
            Some(AnchoredError::Escape)
        );

        // Nothing outside the root was read, truncated or created.
        assert_eq!(
            std::fs::read(t.outside.join("secret.txt")).unwrap(),
            b"top secret"
        );
        assert!(!t.outside.join("planted.txt").exists());
    }

    /// The leaf itself swapped for a symlink to an out-of-scope file after the
    /// check: it is refused, and the target is neither read nor truncated.
    #[cfg(unix)]
    #[test]
    fn a_file_swapped_for_a_symlink_after_the_check_is_refused() {
        let t = tree();
        let data = t.root.join("sub/data.txt");
        let s = check(&t.root, &data);

        swap_for_symlink(&data, &t.outside.join("secret.txt"));

        assert_eq!(
            open_read(&s.root, &s.resolved).err(),
            Some(AnchoredError::Escape)
        );
        assert_eq!(
            imp::open_read_walk_only(&s.root, &s.resolved).err(),
            Some(AnchoredError::Escape)
        );
        for mode in [WriteMode::Truncate, WriteMode::Append, WriteMode::CreateNew] {
            assert!(open_write(&s.root, &s.resolved, mode).is_err());
        }
        assert_eq!(stat(&s.root, &s.resolved), Err(AnchoredError::Escape));
        assert_eq!(
            std::fs::read(t.outside.join("secret.txt")).unwrap(),
            b"top secret"
        );
    }

    /// A dangling symlink planted at a not-yet-existing write target after the
    /// check is not followed to create a file outside the root.
    #[cfg(unix)]
    #[test]
    fn a_planted_dangling_symlink_is_not_followed_on_create() {
        let t = tree();
        let target = t.root.join("sub/new.txt");
        let s = check(&t.root, &target);

        std::os::unix::fs::symlink(t.outside.join("created.txt"), &target).unwrap();

        for mode in [WriteMode::Truncate, WriteMode::Append, WriteMode::CreateNew] {
            assert!(open_write(&s.root, &s.resolved, mode).is_err());
        }
        assert!(!t.outside.join("created.txt").exists());
    }

    /// The declared root itself swapped for a symlink after the check.
    #[cfg(unix)]
    #[test]
    fn a_root_swapped_for_a_symlink_after_the_check_is_refused() {
        let t = tree();
        let s = check(&t.root, &t.root.join("sub/data.txt"));
        let listing = check(&t.root, &t.root);

        swap_for_symlink(&t.root, &t.outside);

        assert_eq!(
            open_read(&s.root, &s.resolved).err(),
            Some(AnchoredError::Escape)
        );
        assert_eq!(
            list_dir(&listing.root, &listing.resolved).err(),
            Some(AnchoredError::Escape)
        );
    }
}
