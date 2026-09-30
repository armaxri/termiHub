//! SHA-256 integrity verification for the bundled `termihub-rdp-helper` sidecar.
//!
//! A released build ships the sidecar next to the desktop binary via Tauri
//! `externalBin` (#1754). Before spawning it (#1762) the adapter verifies the
//! resolved binary against a **known-good SHA-256 embedded at build time**, so a
//! tampered, corrupted, or wrong-arch helper is rejected before it ever runs —
//! mirroring the agent-binary checksum verification in `src-tauri`.
//!
//! The expected digest is produced by `core/build.rs`, which hashes the staged
//! `externalBin` (the exact bytes Tauri bundles) and emits it as the
//! `TERMIHUB_RDP_HELPER_SHA256` compile-time env var, read here via
//! [`option_env!`]. When no digest is embedded — per-PR compile/test jobs and
//! plain dev builds never stage the sidecar — the check is **skipped**, exactly
//! as the agent path tolerates a missing checksum sidecar. The
//! `$TERMIHUB_RDP_HELPER` dev/test override also skips the check, so a
//! locally-built helper still runs.
//!
//! ## Closing the check→exec TOCTOU window (#2835)
//!
//! Verification does not hash a *path* and later spawn that path — an attacker
//! able to replace the file between the two could swap in an unverified binary.
//! Instead [`verify_helper_integrity`] opens the helper **once**, streams the
//! digest from **that handle**, and returns a [`PinnedHelper`] that retains it.
//! The spawn is then built from the pinned handle ([`PinnedHelper::command`]),
//! and [`PinnedHelper::confirm_after_spawn`] re-verifies the handle before the
//! caller sends the child anything (the connect payload carries credentials).
//! The exact residual guarantee differs per OS:
//!
//! - **Linux / Android** — the child execs `/proc/self/fd/<n>`, i.e. the very
//!   inode that was hashed; no path lookup happens between hash and exec, so a
//!   rename/replace of the on-disk path cannot substitute a different file. The
//!   post-spawn re-hash of the same inode additionally catches an *in-place*
//!   rewrite made before exec (the kernel refuses writes to a running image, so
//!   such a rewrite cannot be undone after exec). `/proc` must be mounted; if
//!   it is not, the spawn fails and the connection is refused (fail-closed).
//! - **macOS / other Unix** — there is no `fexecve` on macOS and exec of
//!   `/dev/fd/<n>` is not reliable, so the child is spawned by path. The path is
//!   checked to still name the hashed inode (same `st_dev`/`st_ino`) immediately
//!   before **and** after the spawn, and the retained handle is re-hashed after
//!   the spawn; any mismatch kills the child before it receives credentials.
//!   Residual: an attacker with write access to the install directory who swaps
//!   the file *and swaps it back* entirely inside the spawn window (between the
//!   two inode checks) is not detected.
//! - **Windows** — the helper is opened with a share mode that grants only
//!   `FILE_SHARE_READ` (no `FILE_SHARE_WRITE`/`FILE_SHARE_DELETE`), so while the
//!   handle is held the file cannot be written, deleted, renamed or replaced
//!   (and its directory cannot be renamed). The handle is held across the
//!   spawn, so the file `CreateProcess` maps is the hashed one.
//!
//! When the check is skipped (override / no embedded digest) no handle is
//! pinned and the helper is spawned by path exactly as before.

use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tracing::{debug, warn};

/// The known-good sidecar SHA-256 (lowercase hex), embedded at build time by
/// `core/build.rs`. `None` when no digest was staged (dev/branch builds).
pub const EXPECTED_HELPER_SHA256: Option<&str> = option_env!("TERMIHUB_RDP_HELPER_SHA256");

/// Windows `FILE_SHARE_READ`: while our handle is open, other openers may only
/// read (or execute) the file — never write, delete or rename it.
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;

/// Compute the lowercase-hex SHA-256 digest of a file's contents.
///
/// The file is streamed through the hasher, so an arbitrarily large binary is
/// hashed without loading it all into memory.
pub fn sha256_hex_of_file(path: &Path) -> std::io::Result<String> {
    sha256_hex_of_handle(&File::open(path)?)
}

/// Compute the lowercase-hex SHA-256 digest of an already-open file, from its
/// start regardless of the handle's current position.
///
/// Hashing the *handle* rather than re-opening a path is what lets the digest
/// and the exec reference the identical file (#2835).
pub fn sha256_hex_of_handle(file: &File) -> std::io::Result<String> {
    let mut reader = file;
    reader.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut reader, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// Open the helper for hashing and (where supported) exec-by-handle.
///
/// On Windows the handle denies write/delete sharing for as long as it lives.
fn open_helper(path: &Path) -> std::io::Result<File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(FILE_SHARE_READ);
    }
    opts.open(path)
}

/// A helper binary that passed (or was deliberately exempted from) the
/// integrity check, carrying the retained handle the digest was computed from.
///
/// Build the spawn with [`command`](Self::command), call
/// [`confirm_after_spawn`](Self::confirm_after_spawn) once the child exists and
/// before writing anything to it, and keep this value alive until then.
#[derive(Debug)]
pub struct PinnedHelper {
    /// The resolved absolute path (also the child's `argv[0]`).
    path: PathBuf,
    /// The verified handle and its expected digest; `None` when the integrity
    /// check was skipped (override active / no embedded digest).
    verified: Option<(File, String)>,
}

impl PinnedHelper {
    /// The resolved helper path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the helper was actually hashed and is pinned by handle.
    pub fn is_verified(&self) -> bool {
        self.verified.is_some()
    }

    /// Build the command that launches the pinned helper.
    ///
    /// On Linux/Android this execs `/proc/self/fd/<n>` — the hashed inode, not
    /// the path. Elsewhere it spawns the path after confirming it still names
    /// the hashed file (Windows: guaranteed by the share-deny handle).
    pub fn command(&self) -> Result<tokio::process::Command, String> {
        let Some((file, _)) = &self.verified else {
            return Ok(tokio::process::Command::new(&self.path));
        };
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            use std::os::fd::AsRawFd;
            // The fd is inherited across the fork; execve resolves this path to
            // the open file description before O_CLOEXEC fds are closed, so the
            // child execs exactly the inode we hashed. `argv[0]` stays the real
            // path so the helper's process name is unchanged.
            let mut cmd =
                tokio::process::Command::new(format!("/proc/self/fd/{}", file.as_raw_fd()));
            cmd.arg0(&self.path);
            Ok(cmd)
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            self.check_path_still_names_handle(file)?;
            Ok(tokio::process::Command::new(&self.path))
        }
    }

    /// Re-verify the pinned file after the child was spawned and before it is
    /// sent anything. On failure the caller must kill the child.
    pub fn confirm_after_spawn(&self) -> Result<(), String> {
        let Some((file, expected)) = &self.verified else {
            return Ok(());
        };
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        self.check_path_still_names_handle(file)?;
        let actual = sha256_hex_of_handle(file).map_err(|e| {
            format!(
                "failed to re-read RDP helper '{}' after spawn: {e}",
                self.path.display()
            )
        })?;
        if actual == *expected {
            Ok(())
        } else {
            Err(format!(
                "RDP helper '{}' changed between its integrity check and launch \
                 (expected SHA-256 {expected}, now {actual}); refusing to use it.",
                self.path.display()
            ))
        }
    }

    /// Path-spawning platforms: fail unless `self.path` still resolves to the
    /// same file as the hashed handle (a swap would change the file identity).
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    fn check_path_still_names_handle(&self, file: &File) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let pinned = file.metadata();
            let current = std::fs::metadata(&self.path);
            match (pinned, current) {
                (Ok(p), Ok(c)) if p.dev() == c.dev() && p.ino() == c.ino() => Ok(()),
                _ => Err(format!(
                    "RDP helper '{}' was replaced after its integrity check; \
                     refusing to launch it.",
                    self.path.display()
                )),
            }
        }
        #[cfg(not(unix))]
        {
            // Windows: the share-deny handle makes a swap impossible while held.
            let _ = file;
            Ok(())
        }
    }
}

/// Verify the resolved sidecar binary against its build-time SHA-256 and pin
/// it for spawning.
///
/// Returns `Ok` — the binary may be spawned via [`PinnedHelper::command`] — when:
/// - `override_active` is set (the `$TERMIHUB_RDP_HELPER` dev/test override is in
///   use, so the operator picked the binary deliberately), or
/// - `expected` is `None` (no digest was embedded — an out-of-scope dev/branch
///   build that does not stage the sidecar), in which case integrity cannot be
///   verified and the connection proceeds with a warning, or
/// - the digest of the opened handle matches `expected`; the handle is retained
///   so the spawn references the identical file (#2835).
///
/// Returns `Err(message)` — refuse to spawn — when a digest is embedded and the
/// binary's actual SHA-256 does not match it, or the binary cannot be read. The
/// message names the file and both digests so the failure is actionable.
pub fn verify_helper_integrity(
    path: &Path,
    override_active: bool,
    expected: Option<&str>,
) -> Result<PinnedHelper, String> {
    let unverified = || PinnedHelper {
        path: path.to_path_buf(),
        verified: None,
    };
    if override_active {
        debug!(
            path = %path.display(),
            "TERMIHUB_RDP_HELPER override is set — skipping sidecar integrity check"
        );
        return Ok(unverified());
    }

    let expected = match expected {
        Some(e) if !e.trim().is_empty() => e.trim().to_ascii_lowercase(),
        _ => {
            warn!(
                path = %path.display(),
                "no build-time SHA-256 embedded for the RDP helper — spawning without \
                 integrity verification (dev/branch build)"
            );
            return Ok(unverified());
        }
    };

    let read_err = |e: std::io::Error| {
        format!(
            "failed to read RDP helper '{}' for integrity verification: {e}",
            path.display()
        )
    };
    let file = open_helper(path).map_err(read_err)?;
    let actual = sha256_hex_of_handle(&file).map_err(read_err)?;

    if actual == expected {
        debug!(path = %path.display(), "RDP helper SHA-256 verified");
        Ok(PinnedHelper {
            path: path.to_path_buf(),
            verified: Some((file, expected)),
        })
    } else {
        Err(format!(
            "RDP helper integrity check failed for '{}': expected SHA-256 {expected}, \
             computed {actual}. Refusing to spawn a sidecar that does not match the digest \
             embedded at build time. Rebuild it with scripts/build-rdp-sidecar.sh, or point \
             {env} at a trusted binary.",
            path.display(),
            env = super::HELPER_PATH_ENV,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The canonical SHA-256 test vector: `sha256("abc")`.
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn write_temp(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("termihub-rdp-helper");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn sha256_hex_of_file_matches_known_vector() {
        let (_dir, path) = write_temp(b"abc");
        assert_eq!(sha256_hex_of_file(&path).unwrap(), SHA256_OF_ABC);
    }

    #[test]
    fn sha256_hex_of_file_is_lowercase_64_hex() {
        let (_dir, path) = write_temp(b"anything");
        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn sha256_hex_of_file_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sha256_hex_of_file(&dir.path().join("nope")).is_err());
    }

    #[test]
    fn verify_accepts_a_matching_digest() {
        let (_dir, path) = write_temp(b"abc");
        assert!(verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).is_ok());
        // Case-insensitive on the expected side.
        let upper = SHA256_OF_ABC.to_ascii_uppercase();
        assert!(verify_helper_integrity(&path, false, Some(&upper)).is_ok());
    }

    #[test]
    fn verify_rejects_a_mismatched_digest_with_a_clear_error() {
        // A file whose digest is NOT SHA256_OF_ABC.
        let (_dir, path) = write_temp(b"tampered");
        let err = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap_err();
        assert!(err.contains("integrity check failed"), "got: {err}");
        assert!(
            err.contains(SHA256_OF_ABC),
            "error should name the expected digest: {err}"
        );
    }

    #[test]
    fn verify_skips_when_no_digest_is_embedded() {
        // No embedded digest (dev/branch build) → cannot verify, must not fail.
        let (_dir, path) = write_temp(b"abc");
        assert!(verify_helper_integrity(&path, false, None).is_ok());
        assert!(verify_helper_integrity(&path, false, Some("   ")).is_ok());
    }

    #[test]
    fn verify_skips_when_override_is_active() {
        // With the $TERMIHUB_RDP_HELPER override in use the check is skipped even
        // when the digest would otherwise mismatch — and even for a missing file.
        let (_dir, path) = write_temp(b"tampered");
        assert!(verify_helper_integrity(&path, true, Some(SHA256_OF_ABC)).is_ok());
        let dir = tempfile::tempdir().unwrap();
        assert!(
            verify_helper_integrity(&dir.path().join("nope"), true, Some(SHA256_OF_ABC)).is_ok()
        );
    }
    // ── #2835: hash-by-handle + exec-by-handle ─────────────────────────────

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn sha256_hex_of_handle_hashes_from_the_start_regardless_of_position() {
        let (_dir, path) = write_temp(b"abc");
        let mut file = File::open(&path).unwrap();
        // Move the cursor to EOF: the digest must still cover the whole file.
        file.seek(SeekFrom::End(0)).unwrap();
        assert_eq!(sha256_hex_of_handle(&file).unwrap(), SHA256_OF_ABC);
        // Hashing twice from the same handle is stable (used post-spawn).
        assert_eq!(sha256_hex_of_handle(&file).unwrap(), SHA256_OF_ABC);
    }

    #[test]
    fn verified_helper_is_pinned_by_handle_and_skipped_ones_are_not() {
        let (_dir, path) = write_temp(b"abc");
        let pinned = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap();
        assert!(pinned.is_verified());
        assert_eq!(pinned.path(), path.as_path());
        assert!(pinned.confirm_after_spawn().is_ok());

        assert!(!verify_helper_integrity(&path, true, Some(SHA256_OF_ABC))
            .unwrap()
            .is_verified());
        assert!(!verify_helper_integrity(&path, false, None)
            .unwrap()
            .is_verified());
    }

    /// An in-place rewrite of the pinned file between the check and the spawn
    /// is caught by the post-spawn re-hash of the retained handle.
    #[cfg(unix)]
    #[test]
    fn confirm_after_spawn_rejects_an_in_place_rewrite_of_the_pinned_file() {
        let (_dir, path) = write_temp(b"abc");
        let pinned = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap();
        // Same inode, different bytes.
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap()
            .write_all(b"evil")
            .unwrap();
        let err = pinned.confirm_after_spawn().unwrap_err();
        assert!(err.contains("changed between"), "got: {err}");
    }

    /// The pinned handle still hashes the ORIGINAL bytes after the path has been
    /// replaced — the digest is of the opened file, not a re-lookup of the path.
    #[cfg(unix)]
    #[test]
    fn pinned_handle_keeps_hashing_the_original_after_a_path_swap() {
        let (dir, path) = write_temp(b"abc");
        let pinned = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap();
        swap_path(dir.path(), &path, b"evil");
        let (file, _) = pinned.verified.as_ref().unwrap();
        assert_eq!(sha256_hex_of_handle(file).unwrap(), SHA256_OF_ABC);
    }

    /// Atomically replace `path` with a new file holding `bytes` (new inode).
    #[cfg(unix)]
    fn swap_path(dir: &Path, path: &Path, bytes: &[u8]) {
        use std::os::unix::fs::PermissionsExt;
        let evil = dir.join("evil");
        std::fs::write(&evil, bytes).unwrap();
        std::fs::set_permissions(&evil, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::rename(&evil, path).unwrap();
    }

    /// Copy a real system executable into a temp dir to act as the helper.
    fn copy_real_executable(src: &Path) -> (tempfile::TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(super::super::HELPER_BIN_NAME);
        std::fs::copy(src, &path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let digest = sha256_hex(&std::fs::read(&path).unwrap());
        (dir, path, digest)
    }

    /// Spawn with piped stdout, retrying the Linux fork/exec `ETXTBSY` race that
    /// a freshly written executable can hit while other test threads fork.
    async fn run_pinned(pinned: &PinnedHelper, args: &[&str]) -> std::process::Output {
        for _ in 0..50 {
            let mut cmd = pinned.command().unwrap();
            cmd.args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            match cmd.output().await {
                Ok(out) => return out,
                Err(e) if e.raw_os_error() == Some(26) => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                Err(e) => panic!("spawn of pinned helper failed: {e}"),
            }
        }
        panic!("spawn of pinned helper kept failing with ETXTBSY");
    }

    /// An echo-like helper for the spawn tests. Linux execs by fd, which needs a
    /// real ELF (a `#!` script's interpreter cannot reopen the O_CLOEXEC
    /// `/proc/self/fd/<n>`), so it copies `/bin/echo`. macOS SIGKILLs copies of
    /// platform binaries, so there it is a shell script (spawned by path).
    #[cfg(unix)]
    fn echo_helper() -> (tempfile::TempDir, PathBuf, String) {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            copy_real_executable(Path::new("/bin/echo"))
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            let script = tempfile::tempdir().unwrap();
            let src = script.path().join("echo.sh");
            std::fs::write(&src, b"#!/bin/sh\necho \"$@\"\n").unwrap();
            copy_real_executable(&src)
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pinned_helper_spawns_the_verified_binary() {
        let (_dir, path, digest) = echo_helper();
        let pinned = verify_helper_integrity(&path, false, Some(&digest)).unwrap();
        let out = run_pinned(&pinned, &["pinned-ok"]).await;
        assert!(out.status.success(), "helper failed: {out:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "pinned-ok");
        assert!(pinned.confirm_after_spawn().is_ok());
    }

    /// Linux: the child execs the hashed inode via `/proc/self/fd/<n>`, so
    /// replacing the path after the check still runs the verified binary.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[tokio::test]
    async fn linux_exec_by_fd_runs_the_verified_inode_after_a_path_swap() {
        let (dir, path, digest) = echo_helper();
        let pinned = verify_helper_integrity(&path, false, Some(&digest)).unwrap();
        swap_path(dir.path(), &path, b"#!/bin/sh\necho swapped\n");
        let out = run_pinned(&pinned, &["verified"]).await;
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "verified");
        assert!(pinned.confirm_after_spawn().is_ok());
    }

    /// macOS/other Unix (spawn by path): a swap after the check is detected by
    /// the inode identity check both before and after the spawn.
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    #[test]
    fn path_spawn_platforms_refuse_a_swapped_helper() {
        let (dir, path) = write_temp(b"abc");
        let pinned = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap();
        swap_path(dir.path(), &path, b"abc");
        // Same bytes, different inode: still refused — identity, not content.
        let err = pinned.command().unwrap_err();
        assert!(err.contains("replaced"), "got: {err}");
        assert!(pinned.confirm_after_spawn().is_err());
    }

    /// Windows: the share-deny handle blocks write, delete and replace of the
    /// verified file for as long as it is pinned.
    #[cfg(windows)]
    #[test]
    fn windows_pinned_helper_cannot_be_written_deleted_or_replaced() {
        let (dir, path) = write_temp(b"abc");
        let pinned = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap();
        assert!(
            std::fs::write(&path, b"evil").is_err(),
            "write must be denied"
        );
        assert!(
            std::fs::remove_file(&path).is_err(),
            "delete must be denied"
        );
        let evil = dir.path().join("evil");
        std::fs::write(&evil, b"evil").unwrap();
        assert!(
            std::fs::rename(&evil, &path).is_err(),
            "replace must be denied"
        );
        assert!(
            std::fs::rename(&path, dir.path().join("moved")).is_err(),
            "rename must be denied"
        );
        assert!(pinned.confirm_after_spawn().is_ok());
        drop(pinned);
        // Released: the file is writable again.
        assert!(std::fs::write(&path, b"evil").is_ok());
    }

    /// Windows: `CreateProcess` can still launch the file while our
    /// read-only-share handle is held.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_pinned_helper_spawns_while_share_denied() {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let src = Path::new(&root).join("System32").join("hostname.exe");
        let (_dir, path, digest) = copy_real_executable(&src);
        let pinned = verify_helper_integrity(&path, false, Some(&digest)).unwrap();
        let out = run_pinned(&pinned, &[]).await;
        assert!(out.status.success(), "hostname.exe failed: {out:?}");
        assert!(!out.stdout.is_empty());
        assert!(pinned.confirm_after_spawn().is_ok());
    }
}
