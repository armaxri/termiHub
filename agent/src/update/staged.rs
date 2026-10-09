//! Private, handle-bound staging of an agent update binary (#4287, AGT2-002).
//!
//! A staged update binary is only as trustworthy as the directory it sits in.
//! If another local user can write that directory (or the file), they can swap
//! the bytes between the moment the agent verifies them and the moment it
//! installs them. So the rules here are:
//!
//! - The staging dir is created **owner-only** (`0700`) — see
//!   [`ensure_private_dir`].
//! - At apply time the staged file is opened **once**, with `O_NOFOLLOW`, and
//!   refused unless it and every directory from the trusted root down to it is
//!   owned by this user and not writable by anyone else, and the file has a
//!   single link — see [`open_private_staged`].
//! - The bytes are then copied from that one handle into a private temp file
//!   next to the executable while being hashed — see
//!   [`copy_into_private_temp`]. Every later check (digest, signature, version)
//!   and the final rename work on that copy, so nothing is ever re-opened by
//!   path after it has been verified.

use std::path::{Path, PathBuf};

use anyhow::Context;
#[cfg(unix)]
use anyhow::{bail, Result};
use tracing::debug;

/// Mode bits that would let a group member or other user write a file or dir.
#[cfg(unix)]
const SHARED_WRITE_BITS: u32 = 0o022;

/// Prefix of the per-upload dirs the desktop creates inside the staging root
/// (`mktemp -d <root>/upload.XXXXXX`). Only dirs with this prefix are removed
/// once their upload has been applied.
const UPLOAD_DIR_PREFIX: &str = "upload.";

/// Create `dir` (and any missing parents) and restrict it to its owner.
///
/// On Unix the dir ends up `0700` even when it already existed with a wider
/// mode, and a symlink in its place is refused rather than followed. On
/// Windows it gets a protected DACL granting only the current user and
/// `LocalSystem` full control, inherited by everything created inside it (the
/// desktop's per-upload subdirs included), even when it already existed with a
/// broader ACL — defence in depth, as the staged binary is never applied there
/// (apply is Unix-only). Elsewhere the dir is just created.
pub(crate) fn ensure_private_dir(dir: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .with_context(|| format!("create staging dir {}", dir.display()))?;
        let meta = std::fs::symlink_metadata(dir)
            .with_context(|| format!("stat staging dir {}", dir.display()))?;
        if !meta.is_dir() {
            bail!(
                "staging dir {} is not a real directory (symlink?)",
                dir.display()
            );
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restrict staging dir {} to 0700", dir.display()))?;
    }
    #[cfg(windows)]
    {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("create staging dir {}", dir.display()))?;
        restrict_dir_to_current_user(dir)?;
    }
    #[cfg(not(any(unix, windows)))]
    std::fs::create_dir_all(dir)
        .with_context(|| format!("create staging dir {}", dir.display()))?;
    Ok(())
}

/// The staging dir's DACL on Windows (#4494): the current user and
/// `LocalSystem`, object- and container-inheritable, protected so nothing is
/// inherited from the parent.
///
/// `LocalSystem` is kept for parity with the other per-user objects built from
/// the shared helper (the core local-IPC endpoints,
/// `ListenerSecurity::CurrentUserOnly`) and with the user-profile ACL the dir
/// would otherwise inherit: SYSTEM already holds full control of the whole
/// profile, so excluding it adds no protection and only breaks system services
/// (backup, Defender scans) that legitimately read it.
#[cfg(windows)]
pub(crate) const STAGING_DACL: termihub_win_security::DaclSpec<'static> =
    termihub_win_security::DaclSpec {
        extra_sids: &[],
        include_system: true,
        inherit_to_children: true,
    };

/// Replace `dir`'s DACL with [`STAGING_DACL`], refusing a reparse point (a
/// symlink or junction) in its place rather than re-ACLing its target.
#[cfg(windows)]
fn restrict_dir_to_current_user(dir: &Path) -> anyhow::Result<()> {
    let meta = std::fs::symlink_metadata(dir)
        .with_context(|| format!("stat staging dir {}", dir.display()))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        anyhow::bail!(
            "staging dir {} is not a real directory (symlink or junction?)",
            dir.display()
        );
    }
    termihub_win_security::ProtectedDacl::new(&STAGING_DACL)
        .and_then(|dacl| dacl.apply_to_path(dir))
        .with_context(|| format!("restrict staging dir {} to the current user", dir.display()))
}

/// Open the staged binary at `src` — already confined below `root` — exactly
/// once, refusing anything another local user could have tampered with.
///
/// `root` and `src` must both be canonical (as returned by confinement), so
/// every component between them is a real directory. Each of those
/// directories, and the file itself, must be owned by the effective user and
/// carry no group/other write bit; the file must be a regular file with a
/// single link (a hard link elsewhere would be a second name that can change
/// it). The open uses `O_NOFOLLOW`, so a symlink swapped in at the last moment
/// fails instead of being followed, and `O_NONBLOCK`, so a FIFO cannot hang
/// the agent.
#[cfg(unix)]
pub(super) fn open_private_staged(root: &Path, src: &Path) -> Result<std::fs::File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let euid = nix::unistd::geteuid().as_raw();
    let parent = src
        .parent()
        .with_context(|| format!("staged binary {} has no parent dir", src.display()))?;
    let below_root = parent
        .strip_prefix(root)
        .with_context(|| format!("{} is not below {}", src.display(), root.display()))?;

    let mut dir = root.to_path_buf();
    check_private_dir(&dir, euid)?;
    for component in below_root.components() {
        dir.push(component);
        check_private_dir(&dir, euid)?;
    }

    let flags = nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_NONBLOCK;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(flags.bits())
        .open(src)
        .with_context(|| {
            format!(
                "open staged binary {} without following links",
                src.display()
            )
        })?;
    let meta = file
        .metadata()
        .with_context(|| format!("stat staged binary {}", src.display()))?;
    if !meta.is_file() {
        bail!("staged binary {} is not a regular file", src.display());
    }
    if meta.nlink() != 1 {
        bail!(
            "staged binary {} has {} hard links; only a single link is accepted",
            src.display(),
            meta.nlink()
        );
    }
    check_owner_and_mode(src, meta.uid(), meta.mode(), euid)?;
    Ok(file)
}

/// Require `dir` to be a real directory (not a symlink) that only `euid` can
/// write.
#[cfg(unix)]
fn check_private_dir(dir: &Path, euid: u32) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let meta = std::fs::symlink_metadata(dir)
        .with_context(|| format!("stat staging dir {}", dir.display()))?;
    if !meta.is_dir() {
        bail!(
            "staging path component {} is not a real directory",
            dir.display()
        );
    }
    check_owner_and_mode(dir, meta.uid(), meta.mode(), euid)
}

/// Require `path` to be owned by `euid` and not writable by group or others.
#[cfg(unix)]
fn check_owner_and_mode(path: &Path, uid: u32, mode: u32, euid: u32) -> Result<()> {
    if uid != euid {
        bail!(
            "{} is owned by uid {uid}, not by the agent's uid {euid}",
            path.display()
        );
    }
    if mode & SHARED_WRITE_BITS != 0 {
        bail!(
            "{} is group- or world-writable (mode {:o})",
            path.display(),
            mode & 0o7777
        );
    }
    Ok(())
}

/// Copy everything readable from `staged` into a fresh owner-only temp file in
/// `dest_dir`, hashing exactly the bytes written. Returns the temp file (still
/// open, positioned at its end) and the lowercase-hex SHA-256 of its contents.
///
/// `dest_dir` is the running executable's directory, so the later rename over
/// the executable stays on one filesystem and is atomic. The copy is flushed to
/// disk before it is returned.
#[cfg(unix)]
pub(super) fn copy_into_private_temp(
    staged: &mut std::fs::File,
    dest_dir: &Path,
) -> Result<(tempfile::NamedTempFile, String)> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    let mut copy = super::apply::new_staging_temp(dest_dir)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match staged.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e).context("read staged binary"),
        };
        hasher.update(&buf[..n]);
        copy.write_all(&buf[..n])
            .with_context(|| format!("write private copy {}", copy.path().display()))?;
    }
    copy.as_file()
        .sync_all()
        .with_context(|| format!("flush private copy {}", copy.path().display()))?;
    Ok((copy, hex::encode(hasher.finalize())))
}

/// Remove a staged update binary that has been applied, plus the per-upload
/// dir it sat in when that dir is now empty. Best effort and fail-safe: a path
/// that does not confine to one of `roots` is never touched, and errors are
/// only logged.
pub fn discard_applied_upload(roots: &[PathBuf], path: &Path) {
    let Ok(canonical) = super::confine_to_staging(roots, path) else {
        return;
    };
    match std::fs::remove_file(&canonical) {
        Ok(()) => debug!("Removed applied update binary {}", canonical.display()),
        Err(e) => {
            debug!(
                "Could not remove applied update binary {}: {e}",
                canonical.display()
            );
            return;
        }
    }
    let Some(dir) = canonical.parent() else {
        return;
    };
    let is_upload_dir = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(UPLOAD_DIR_PREFIX));
    if is_upload_dir {
        // `remove_dir` only succeeds on an empty dir, so anything else the dir
        // holds keeps it in place.
        if let Err(e) = std::fs::remove_dir(dir) {
            debug!("Kept upload dir {}: {e}", dir.display());
        }
    }
}

#[cfg(all(test, unix))]
#[path = "staged_tests.rs"]
mod tests;

#[cfg(all(test, windows))]
#[path = "staged_windows_tests.rs"]
mod windows_tests;
