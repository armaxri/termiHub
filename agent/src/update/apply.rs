//! Applying a deferred agent update (#1352, SI-6).
//!
//! The deferred-update contract: a staged/pending update is applied **strictly**
//! when the agent has zero active sessions, so swapping the running binary never
//! interrupts a live session. Persistent sessions live in detached daemon
//! processes ([`crate::daemon`]) that are decoupled from the agent's lifetime, so
//! replacing (and re-execing) the agent binary leaves them running — they are
//! re-attached by [`crate::session::manager::SessionManager::recover_sessions`]
//! once the new agent starts.
//!
//! The actual binary swap + re-exec is Unix-only (see [`apply_update_binary`]);
//! on other platforms it returns an error so the caller can surface it, keeping
//! the whole crate compiling everywhere.

use std::fmt;
use std::path::{Path, PathBuf};

use tracing::debug;
#[cfg(unix)]
use tracing::{info, warn};

use super::build_version::{VersionPolicy, VersionPolicyError};
#[cfg(unix)]
use super::signature::SignaturePolicy;
use super::signature::UpdateSignatureError;
use super::version;
use crate::state::persistence::{AgentState, PendingUpdate};

/// Why a requested update binary path was refused as an apply source (AGT-003).
///
/// Every variant is a **fail-closed** rejection: the requested path never
/// becomes the new agent binary. The typed shape lets callers surface an honest
/// reason instead of a bare string.
#[derive(Debug)]
pub enum StagingConfinementError {
    /// The path could not be canonicalized — it does not exist, is not
    /// reachable, or an I/O error occurred. An unresolvable path is never
    /// trusted.
    Unresolvable {
        /// The path as requested (pre-canonicalization).
        path: String,
        /// The underlying canonicalization error.
        source: std::io::Error,
    },
    /// The (canonicalized) path is not a regular file, so it cannot be a binary.
    NotAFile {
        /// The canonical path.
        path: String,
    },
    /// The canonical path resolves **outside** every trusted staging root — the
    /// core AGT-003 rejection. Catches absolute paths outside staging, `..`
    /// traversal, and symlinks that escape the staging dir alike, because the
    /// check is on the canonicalized path, not a string prefix.
    OutsideStaging {
        /// The canonical path that escaped confinement.
        path: String,
    },
    /// A component of the requested path **below** the trusted staging root is
    /// a symlink (AGT2-002, #4287). The staged binary must be named directly,
    /// never through a link that could be re-pointed between check and use.
    SymlinkInPath {
        /// The path component that is a symlink.
        path: String,
    },
}

impl fmt::Display for StagingConfinementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unresolvable { path, source } => {
                write!(
                    f,
                    "update binary path {path} could not be resolved: {source}"
                )
            }
            Self::NotAFile { path } => {
                write!(f, "update binary path {path} is not a regular file")
            }
            Self::OutsideStaging { path } => write!(
                f,
                "update binary path {path} is outside the trusted staging directory"
            ),
            Self::SymlinkInPath { path } => write!(
                f,
                "update binary path component {path} is a symlink inside the staging directory"
            ),
        }
    }
}

impl std::error::Error for StagingConfinementError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unresolvable { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Confine a requested update `binary_path` to the agent-owned staging locations
/// (AGT-003). Returns the **canonical** path on success, a typed rejection
/// otherwise.
///
/// The security boundary: an arbitrary readable path must not become the new
/// agent binary. So the requested path and each trusted root are both
/// canonicalized (resolving symlinks and `..`), and the requested path is
/// accepted only when its canonical form is **contained within** a canonical
/// root. Containment uses [`Path::starts_with`], which compares whole path
/// components — never a raw string prefix — so `/tmp/staging-evil` does not pass
/// as being under `/tmp/staging`.
///
/// Fails **closed** everywhere: a path that cannot be canonicalized, is not a
/// regular file, or lies outside every root is rejected. A root that does not
/// exist (cannot be canonicalized) simply contains nothing and is skipped, so a
/// missing staging dir never widens the check — it only ever narrows it.
///
/// A symlink **below** the root — the file itself or any directory between the
/// root and the file — is refused too (AGT2-002, #4287), even when it points
/// back inside the root. The root itself may be reached through a symlink (a
/// dotfiles-managed `~/.config`, say).
pub fn confine_to_staging(
    roots: &[PathBuf],
    requested: &Path,
) -> Result<PathBuf, StagingConfinementError> {
    confine_to_staging_root(roots, requested).map(|(canonical, _root)| canonical)
}

/// [`confine_to_staging`], also returning the canonical root the path was
/// confined to, so the apply path can check every directory below it.
fn confine_to_staging_root(
    roots: &[PathBuf],
    requested: &Path,
) -> Result<(PathBuf, PathBuf), StagingConfinementError> {
    let canonical = std::fs::canonicalize(requested).map_err(|source| {
        StagingConfinementError::Unresolvable {
            path: requested.display().to_string(),
            source,
        }
    })?;

    if !canonical.is_file() {
        return Err(StagingConfinementError::NotAFile {
            path: canonical.display().to_string(),
        });
    }

    for root in roots {
        // A root that cannot be canonicalized (does not exist yet) can contain
        // nothing — skip it rather than fail, so a not-yet-created staging dir
        // never becomes a bypass and never spuriously rejects a valid sibling.
        if let Ok(canonical_root) = std::fs::canonicalize(root) {
            if canonical.starts_with(&canonical_root) {
                reject_symlinks_below_root(requested, &canonical_root)?;
                return Ok((canonical, canonical_root));
            }
        }
    }

    Err(StagingConfinementError::OutsideStaging {
        path: canonical.display().to_string(),
    })
}

/// Refuse `requested` when it, or any of its ancestors that still resolve
/// strictly below `canonical_root`, is a symlink. Walking the *requested*
/// spelling (not the canonical one) is what catches a link: canonicalization
/// would already have resolved it away.
fn reject_symlinks_below_root(
    requested: &Path,
    canonical_root: &Path,
) -> Result<(), StagingConfinementError> {
    for candidate in requested.ancestors() {
        match std::fs::canonicalize(candidate) {
            Ok(resolved) if resolved != canonical_root && resolved.starts_with(canonical_root) => {}
            _ => break,
        }
        let is_link = std::fs::symlink_metadata(candidate)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true);
        if is_link {
            return Err(StagingConfinementError::SymlinkInPath {
                path: candidate.display().to_string(),
            });
        }
    }
    Ok(())
}

/// Decide whether a pending update should be applied right now.
///
/// Returns `true` only when the agent is idle (`active_count == 0`) **and** an
/// update is actually pending. This is the single source of truth for the
/// "apply on last disconnect" gate: it must never return `true` while a session
/// is still running.
pub fn should_apply_deferred_update(active_count: u32, has_pending: bool) -> bool {
    active_count == 0 && has_pending
}

/// Drop a `pending_update` that the running agent has **already applied** (#1551).
///
/// A successful Unix apply `execve`s the new binary and never returns, so the
/// post-apply "clear pending_update" step in
/// [`crate::session::manager::SessionManager::apply_pending_update`] never runs.
/// Without this startup sweep the stale record re-fires on the next
/// last-session disconnect: the agent re-applies the same, already-installed
/// binary and re-execs, dropping the client connection every time it goes idle.
///
/// Clearing happens **at startup only** — never before the re-exec — so a
/// *failed* apply still retains the record for a later retry.
///
/// Returns `true` when a record was dropped (the caller should persist).
///
/// An update counts as applied when either holds:
///
/// 1. **Version evidence** — `pending.version` is not newer than the version the
///    running agent reports. The record is then either applied or obsolete, and
///    dropping it is right in both cases.
/// 2. **Binary evidence** — the running executable is byte-identical to the
///    staged binary, i.e. this process *is* the staged build. This is what
///    covers the case where the record's version cannot settle the question:
///    an empty/unparsable version, or a staged build whose advertised tag the
///    compiled-in `CARGO_PKG_VERSION` does not reflect.
///
/// Anything else — notably a staged binary that is genuinely newer and genuinely
/// not the one running — is kept for retry.
pub fn prune_applied_pending_update(
    state: &mut AgentState,
    current_version: &str,
    current_exe: Option<&Path>,
) -> bool {
    let Some(pending) = state.update.pending_update.as_ref() else {
        return false;
    };
    if !pending_update_is_applied(pending, current_version, current_exe) {
        return false;
    }
    debug!(
        "Dropping already-applied pending update (version {:?}) from agent state",
        pending.version
    );
    state.update.pending_update = None;
    true
}

/// Whether `pending` has already been applied to the running agent. See
/// [`prune_applied_pending_update`] for the two forms of evidence.
fn pending_update_is_applied(
    pending: &PendingUpdate,
    current_version: &str,
    current_exe: Option<&Path>,
) -> bool {
    // A version that parses and is not newer proves the update is behind us.
    if let Ok(false) = version::is_newer(&pending.version, current_version) {
        return true;
    }
    // Otherwise: are we already running exactly those bytes?
    match current_exe {
        Some(exe) => files_identical(Path::new(&pending.binary_path), exe),
        None => false,
    }
}

/// Whether two paths are existing regular files with identical contents.
///
/// Two cheap metadata checks settle the common cases before a single byte is
/// read: a non-file or a **size mismatch** returns immediately, which is what a
/// genuinely different staged update looks like (a new build differs in length).
/// Only when the sizes match are the contents compared — byte for byte, with an
/// early exit on the first mismatch (see [`streams_identical`]). This is cheaper
/// than hashing both files: the identical case pays a plain memory compare
/// instead of SHA-256 over every byte, and a same-length-but-different binary
/// stops at the first differing byte rather than reading both to the end. It is
/// also strictly correct — an exact byte compare has no hash-collision risk.
///
/// Any I/O error means "cannot prove identical" → `false`, which keeps the
/// pending update rather than dropping it on a guess.
pub(super) fn files_identical(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if !meta_a.is_file() || !meta_b.is_file() || meta_a.len() != meta_b.len() {
        return false;
    }
    streams_identical(a, b).unwrap_or(false)
}

/// Byte-compare two files chunk by chunk, returning `false` at the first
/// differing byte. Neither file is ever fully buffered, and a mismatch early in
/// the file exits without reading the rest. Errors surface as `Err`, which the
/// caller treats as "cannot prove identical".
fn streams_identical(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut fa = std::fs::File::open(a)?;
    let mut fb = std::fs::File::open(b)?;
    let mut buf_a = [0u8; 16 * 1024];
    let mut buf_b = [0u8; 16 * 1024];
    loop {
        let na = fill(&mut fa, &mut buf_a)?;
        let nb = fill(&mut fb, &mut buf_b)?;
        if na != nb || buf_a[..na] != buf_b[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

/// Read into `buf` until it is full or EOF, retrying short and interrupted
/// reads; returns the number of bytes read (`0` only at EOF).
fn fill(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;

    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Applies a staged agent update by swapping the running binary and re-execing.
///
/// Injected into [`crate::session::manager::SessionManager`] so tests can record
/// apply calls without replacing the test process.
pub trait UpdateApplier: Send + Sync + 'static {
    /// Apply `pending`.
    ///
    /// On a successful Unix apply the process image is replaced by the new
    /// binary and this call **never returns**. An `Err` means the swap or
    /// re-exec failed (or the platform is unsupported) and the agent keeps
    /// running with the update unapplied.
    fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()>;

    /// Check an update's signature against this applier's trust policy before
    /// it is even staged (AGT-005), so a caller gets an immediate, typed refusal
    /// instead of a deferred update that can never apply. `digest_hex` is the
    /// initiator's expected SHA-256; the apply path re-binds it to the on-disk
    /// bytes and re-verifies the signature immediately before the swap.
    ///
    /// Defaults to the build's policy ([`super::signature::agent_policy`]).
    fn check_signature(
        &self,
        digest_hex: &str,
        signature: Option<&str>,
    ) -> Result<(), UpdateSignatureError> {
        super::signature::agent_policy()
            .verify(digest_hex, signature)
            .map(|_| ())
    }

    /// Check the binary at `binary` against the downgrade policy (SEC-006,
    /// #3213) before it is staged, so a refused downgrade is reported
    /// immediately. `pinned_version` is the desktop's matched-downgrade pin.
    /// The apply path re-checks it immediately before the swap.
    ///
    /// Defaults to the build's policy ([`VersionPolicy::for_build`]).
    fn check_version(
        &self,
        binary: &Path,
        pinned_version: Option<&str>,
    ) -> Result<(), VersionPolicyError> {
        VersionPolicy::for_build().check_binary(binary, pinned_version)
    }
}

/// Production [`UpdateApplier`] that swaps the on-disk binary and re-execs.
pub struct SystemUpdateApplier;

impl UpdateApplier for SystemUpdateApplier {
    fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
        apply_update_binary(
            &pending.binary_path,
            pending.expected_sha256.as_deref(),
            pending.signature.as_deref(),
            pending.pinned_version.as_deref(),
        )
    }
}

/// Swap the running agent binary with the staged one and re-exec (Unix).
///
/// The staged binary is copied over the current executable atomically (via a
/// **unique** temp file + `rename` in the same directory) and then the process
/// re-execs itself with the same CLI arguments so the new code takes over
/// immediately.
///
/// Before the swap the currently-running binary is preserved as a sibling
/// backup so a **failed re-exec** can restore it (AGT-006): if the newly-swapped
/// binary cannot be `execve`d, this function restores the previously-working
/// binary before returning the error, so the on-disk agent is always left in a
/// runnable state — never a path with no working binary. A *successful* re-exec
/// replaces this process image and never returns; the freshly-started new agent
/// removes the leftover backup at startup (see [`cleanup_stale_update_backup`]).
#[cfg(unix)]
fn apply_update_binary(
    binary_path: &str,
    expected_sha256: Option<&str>,
    signature: Option<&str>,
    pinned_version: Option<&str>,
) -> anyhow::Result<()> {
    apply_update_binary_confined(
        binary_path,
        expected_sha256,
        signature,
        pinned_version,
        &production_staging_roots(),
        &super::signature::agent_policy(),
        &VersionPolicy::for_build(),
    )
}

/// The agent-owned staging location a self-update binary may legitimately live
/// in (AGT-003): `<config>/updates`. It holds both the self-update downloads and
/// the desktop's coordinated-push uploads, which arrive in a fresh private
/// `upload.XXXXXX` dir inside it (AGT2-002, #4287). No world-shared path such
/// as `/tmp` is ever trusted. A nonexistent root is skipped by
/// [`confine_to_staging`].
#[cfg(unix)]
fn production_staging_roots() -> Vec<PathBuf> {
    vec![AgentState::config_dir().join("updates")]
}

/// Swap-and-re-exec, but refuse a source outside `staging_roots` (AGT-003
/// defense-in-depth), whose bytes do not match `expected_sha256` (AGT-004), or
/// whose `signature` does not verify under `policy` (AGT-005) first.
///
/// This is the last gate before the running binary is replaced. Three guards
/// run, in order, **before any copy or re-exec**:
///
/// 1. **Confinement (AGT-003, #3214).** Even though `request_deferred_update`
///    already confined the path when the update was staged, the apply path
///    re-asserts it here so a source outside the trusted staging locations is
///    refused — it must never rely solely on the upstream check.
/// 2. **Private staging + integrity (AGT2-002, AGT-004).** The confined file is
///    opened once (`O_NOFOLLOW`), refused unless it and its directories are
///    private to this user, and copied into a private temp file next to the
///    executable while being SHA-256-hashed. That digest must equal
///    `expected_sha256`; a missing digest, a read error, or a mismatch all
///    reject. Because every later guard and the final rename use this copy,
///    the bytes installed are exactly the bytes verified — swapping the staged
///    file after it was opened changes nothing.
/// 3. **Authenticity (AGT-005, #3213).** The now-verified digest must carry an
///    Ed25519 signature from a key compiled into this agent. Integrity alone
///    only proves the bytes are what the *initiator* intended; the signature
///    proves they are a genuinely published termiHub agent build.
/// 4. **Downgrade policy (SEC-006, #3213).** The version embedded in the
///    now-authentic binary must not be older than the running agent unless it
///    equals the desktop's matched-downgrade pin (see [`VersionPolicy`]).
///
/// Fails **closed** on any violation of any guard — the running binary is
/// never touched.
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn apply_update_binary_confined(
    binary_path: &str,
    expected_sha256: Option<&str>,
    signature: Option<&str>,
    pinned_version: Option<&str>,
    staging_roots: &[PathBuf],
    policy: &SignaturePolicy,
    version_policy: &VersionPolicy,
) -> anyhow::Result<()> {
    use anyhow::Context;

    let current = std::env::current_exe().context("resolve current agent executable")?;
    let exe_dir = current.parent().unwrap_or_else(|| Path::new("."));

    // All guards run — confinement, private staging, digest, signature,
    // downgrade policy — before the running binary is ever touched. They all
    // work on one private copy made from a single open of the staged file, and
    // that same copy is what gets renamed into place (AGT2-002). Extracted so
    // the tamper-vector tests can exercise the gate without driving the
    // (destructive) swap+re-exec.
    let verified = confine_and_verify(
        binary_path,
        expected_sha256,
        signature,
        staging_roots,
        policy,
        exe_dir,
    )?;
    check_version_policy(&verified, pinned_version, version_policy)?;

    let backup = backup_path_for(&current);

    // Preserve the currently-running (working) binary. A *copy* — not a rename —
    // so `current` is never absent: the live swap below stays an atomic same-dir
    // rename over an always-present target.
    back_up_current_binary(&current, &backup)
        .with_context(|| format!("back up current agent binary at {}", current.display()))?;

    if let Err(e) = install_verified(verified, &current)
        .with_context(|| format!("replace agent binary at {}", current.display()))
    {
        // The swap failed before any re-exec: `current` still holds the old
        // binary (the atomic rename either never ran or left it intact). Drop the
        // backup we just made so it does not linger.
        let _ = std::fs::remove_file(&backup);
        return Err(e);
    }

    // `reexec` replaces the process image on success and never returns; reaching
    // the next line means the exec itself failed and `current` now holds the
    // (possibly bad) NEW binary.
    let exec_result = reexec(&current);

    match restore_backup(&backup, &current) {
        Ok(()) => {
            info!(
                "re-exec of updated agent failed; restored the previous working binary at {}",
                current.display()
            );
            exec_result
        }
        Err(restore_err) => {
            // The exec failed AND the revert failed: the on-disk binary may be
            // the un-runnable new one. Surface both so this never fails silently.
            warn!(
                "re-exec of updated agent failed and restoring the backup binary \
                 ALSO failed: {restore_err:#}; on-disk agent at {} may be the \
                 un-runnable new binary",
                current.display()
            );
            exec_result.with_context(|| {
                format!(
                    "re-exec failed and backup restore also failed ({restore_err:#}); \
                     on-disk agent at {} may be un-runnable",
                    current.display()
                )
            })
        }
    }
}

/// Run the apply-time guards — confinement (AGT-003), private staging
/// (AGT2-002), integrity (AGT-004), then authenticity (AGT-005) — and return a
/// private copy of the verified bytes in `dest_dir`. None touches the running
/// binary, so this is the non-destructive gate the swap depends on (and the
/// seam the tamper-vector tests drive without a real swap+re-exec).
///
/// Order matters: confinement is FIRST so an out-of-staging path is rejected
/// before its bytes are ever read, and the signature is checked over the digest
/// only AFTER that digest has been bound to the copied bytes. Fails **closed**
/// on any guard (the temp copy is deleted on drop); a signature refusal keeps
/// its typed [`UpdateSignatureError`] in the error chain so the RPC layer can
/// surface a dedicated error code.
#[cfg(unix)]
fn confine_and_verify(
    binary_path: &str,
    expected_sha256: Option<&str>,
    signature: Option<&str>,
    staging_roots: &[PathBuf],
    policy: &SignaturePolicy,
    dest_dir: &Path,
) -> anyhow::Result<tempfile::NamedTempFile> {
    confine_and_verify_with_hook(
        binary_path,
        expected_sha256,
        signature,
        staging_roots,
        policy,
        dest_dir,
        |_| {},
    )
}

/// [`confine_and_verify`] with `after_open` run on the staged path right after
/// the file was opened and before a byte of it is read — the window an
/// attacker would race. Tests use it to swap or rewrite the file there.
#[cfg(unix)]
fn confine_and_verify_with_hook(
    binary_path: &str,
    expected_sha256: Option<&str>,
    signature: Option<&str>,
    staging_roots: &[PathBuf],
    policy: &SignaturePolicy,
    dest_dir: &Path,
    after_open: impl FnOnce(&Path),
) -> anyhow::Result<tempfile::NamedTempFile> {
    use anyhow::Context;

    const INTEGRITY: &str =
        "refuse to apply an agent update binary that failed integrity verification";

    let (src, root) = confine_to_staging_root(staging_roots, Path::new(binary_path))
        .context("refuse to apply an agent update binary outside the trusted staging directory")?;

    let mut staged = super::staged::open_private_staged(&root, &src)
        .context("refuse to apply an agent update binary that is not privately staged")?;
    after_open(&src);
    let (copy, actual) =
        super::staged::copy_into_private_temp(&mut staged, dest_dir).context(INTEGRITY)?;
    check_expected_digest(&src, &actual, expected_sha256).context(INTEGRITY)?;

    // The digest is now bound to the copied bytes; the signature is checked
    // over exactly that digest.
    policy
        .verify(&actual, signature)
        .map_err(anyhow::Error::from)
        .context("refuse to apply an agent update binary that failed signature verification")?;

    Ok(copy)
}

/// The downgrade-policy guard (SEC-006, #3213), run on the verified private
/// copy only after [`confine_and_verify`] has proven it authentic — so the
/// version it embeds can be trusted. Reads through the copy's open handle,
/// never by path. Keeps the typed [`VersionPolicyError`] in the chain.
#[cfg(unix)]
fn check_version_policy(
    verified: &tempfile::NamedTempFile,
    pinned_version: Option<&str>,
    version_policy: &VersionPolicy,
) -> anyhow::Result<()> {
    use anyhow::Context;

    version_policy
        .check_file(verified.as_file(), verified.path(), pinned_version)
        .map_err(anyhow::Error::from)
        .context("refuse to apply an agent update binary that violates the downgrade policy")
}

/// Compare the `actual` SHA-256 of the bytes copied from `src` with the
/// `expected_sha256` the route that staged the update recorded (AGT-004),
/// failing **closed**: a missing digest or a mismatch is rejected. The
/// comparison ignores case.
#[cfg(unix)]
fn check_expected_digest(
    src: &Path,
    actual: &str,
    expected_sha256: Option<&str>,
) -> anyhow::Result<()> {
    let Some(expected) = expected_sha256 else {
        anyhow::bail!(
            "no expected SHA-256 digest was carried to the apply path for {} — refusing to \
             apply an unverified agent binary (fail closed)",
            src.display()
        );
    };
    let expected = expected.trim().to_ascii_lowercase();
    if actual != expected {
        anyhow::bail!(
            "Checksum verification failed for {}: expected SHA-256 {expected}, computed \
             {actual}. Refusing to apply an agent binary that does not match its digest.",
            src.display()
        );
    }
    Ok(())
}

/// Path of the sibling backup kept for the current agent binary during a
/// self-update: `<exe>.backup`, in the same directory as `exe`.
///
/// A deterministic name (rather than a unique one) is deliberate: there is only
/// ever one live binary being replaced, and the freshly-started agent must be
/// able to find and clean up the leftover backup after a successful re-exec
/// without knowing a random name. Each apply overwrites any stale backup.
#[cfg(unix)]
fn backup_path_for(exe: &Path) -> PathBuf {
    let mut name = exe
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".backup");
    exe.with_file_name(name)
}

/// Copy the currently-running binary at `current` to `backup` (overwriting any
/// stale backup), preserving its contents and mode. Used so a failed re-exec can
/// restore a runnable binary. A copy (not a rename) keeps `current` in place so
/// the live swap never has a window with no target.
#[cfg(unix)]
fn back_up_current_binary(current: &Path, backup: &Path) -> anyhow::Result<()> {
    use anyhow::Context;

    std::fs::copy(current, backup).with_context(|| {
        format!(
            "copy current binary {} -> backup {}",
            current.display(),
            backup.display()
        )
    })?;
    Ok(())
}

/// Restore the backup binary at `backup` over `dst`, atomically, to revert a
/// failed re-exec (AGT-006).
///
/// `backup` is a sibling of `dst`, so the rename is a same-directory move: `dst`
/// transitions atomically from the bad new binary back to the previously-working
/// one and is never absent. The rename consumes `backup`, which doubles as its
/// cleanup. Factored out so the revert path is unit-testable without a real exec.
#[cfg(unix)]
fn restore_backup(backup: &Path, dst: &Path) -> anyhow::Result<()> {
    use anyhow::Context;

    std::fs::rename(backup, dst)
        .with_context(|| format!("restore backup {} over {}", backup.display(), dst.display()))
}

/// Remove a leftover self-update backup binary sitting next to `exe`, if any.
///
/// A *successful* update re-execs and never returns, so the process that made
/// the backup cannot delete it — the freshly-started agent does so here, at
/// startup, once it has confirmed it is the newly-applied binary. A missing
/// backup (the common case, no update just happened) is not an error. Best
/// effort: a failure to remove is logged, never fatal, so it can never block the
/// agent from starting.
#[cfg(unix)]
pub fn cleanup_stale_update_backup(exe: &Path) {
    let backup = backup_path_for(exe);
    match std::fs::remove_file(&backup) {
        Ok(()) => debug!("Removed leftover self-update backup {}", backup.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => debug!(
            "Could not remove leftover self-update backup {}: {e}",
            backup.display()
        ),
    }
}

/// Non-Unix stub: no in-place binary swap (and so no backup) on non-Unix
/// platforms. A no-op keeps the startup call site platform-agnostic.
#[cfg(not(unix))]
pub fn cleanup_stale_update_backup(_exe: &Path) {}

/// Non-Unix stub: applying a deferred update is only supported on Unix, where a
/// running executable can be replaced in place. Returns an error so the caller
/// surfaces it; keeps Windows/other builds compiling.
#[cfg(not(unix))]
fn apply_update_binary(
    _binary_path: &str,
    _expected_sha256: Option<&str>,
    _signature: Option<&str>,
    _pinned_version: Option<&str>,
) -> anyhow::Result<()> {
    anyhow::bail!("deferred agent update apply is only supported on Unix platforms")
}

/// Create a fresh, uniquely-named staging temp file in `dir`.
///
/// Uses [`tempfile::NamedTempFile`] (the same idiom [`crate::fs::write_atomic`]
/// uses) so each apply gets a **collision-resistant, unique** name in the target
/// directory — replacing the old fixed `.termihub-agent.update.tmp`, which two
/// concurrent or retried updates could clobber (AGT-006). Staging in `dir` (the
/// target's own directory) keeps the final rename on one filesystem and thus
/// atomic.
#[cfg(unix)]
pub(super) fn new_staging_temp(dir: &Path) -> anyhow::Result<tempfile::NamedTempFile> {
    use anyhow::Context;

    tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("create staging temp file in {}", dir.display()))
}

/// Atomically replace the executable at `dst` with the `verified` private
/// copy, marking it executable. The copy was made in `dst`'s directory under a
/// **unique** name (AGT-006) and already flushed to disk, so the final rename is
/// atomic: the target always holds either the complete old binary or the
/// complete new one. The mode is set through the open handle, so the file
/// renamed into place is the very file whose bytes were verified (AGT2-002).
#[cfg(unix)]
fn install_verified(verified: tempfile::NamedTempFile, dst: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;

    verified
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("chmod verified binary {}", verified.path().display()))?;
    verified
        .as_file()
        .sync_all()
        .with_context(|| format!("flush verified binary {}", verified.path().display()))?;
    verified
        .persist(dst)
        .map_err(|e| e.error)
        .with_context(|| format!("atomically replace {}", dst.display()))?;
    Ok(())
}

/// Re-exec `exe` with the current process's CLI arguments. On success this
/// replaces the process image and never returns; it only returns on failure.
///
/// Uses a plain `execv(2)`, **not** `std::process::Command::exec`. The latter
/// calls `execvp(3)`, which on `ENOEXEC` (a file the kernel does not recognise
/// as an executable — a corrupt or wrong-format update binary) silently retries
/// the file under `/bin/sh`. That "exec" succeeds, the shell then refuses the
/// binary and exits, and the agent is gone without the revert in
/// [`apply_update_binary_confined`] ever running — leaving the un-runnable new
/// binary on disk (#3064). `execv` has no such fallback: it returns the error,
/// so the backup is restored and the agent keeps running.
#[cfg(unix)]
fn reexec(exe: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(exe.as_os_str().as_bytes())
        .with_context(|| format!("re-exec of {} failed: NUL in path", exe.display()))?;
    // argv[0] is the executable path (as `Command` sets it), then the original
    // arguments byte-for-byte.
    let mut argv = vec![path.clone()];
    for arg in std::env::args_os().skip(1) {
        argv.push(
            CString::new(arg.as_bytes())
                .with_context(|| format!("re-exec of {} failed: NUL in argument", exe.display()))?,
        );
    }
    // `execv` replaces the current image with `exe`; control only returns here
    // if the exec itself failed.
    let err = match nix::unistd::execv(&path, &argv) {
        Ok(never) => match never {},
        Err(errno) => std::io::Error::from(errno),
    };
    Err(anyhow::anyhow!(
        "re-exec of {} failed: {err}",
        exe.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_only_when_idle_and_pending() {
        // The core "apply on last disconnect" gate.
        assert!(
            should_apply_deferred_update(0, true),
            "idle + pending → apply"
        );
        assert!(
            !should_apply_deferred_update(0, false),
            "idle but nothing pending → no apply"
        );
        assert!(
            !should_apply_deferred_update(1, true),
            "one active session → never apply"
        );
        assert!(
            !should_apply_deferred_update(5, true),
            "several active sessions → never apply"
        );
        assert!(
            !should_apply_deferred_update(1, false),
            "active + nothing pending → no apply"
        );
    }

    // ── Startup prune of an already-applied update (#1551) ───────────────

    fn pending(version: &str, binary_path: &Path) -> PendingUpdate {
        PendingUpdate {
            version: version.to_string(),
            binary_path: binary_path.to_string_lossy().into_owned(),
            staged_at: "2026-07-17T09:00:00Z".to_string(),
            expected_sha256: None,
            signature: None,
            pinned_version: None,
        }
    }

    fn state_with(pending: PendingUpdate) -> AgentState {
        let mut state = AgentState::default();
        state.update.pending_update = Some(pending);
        state
    }

    #[test]
    fn prune_drops_pending_update_not_newer_than_running_agent() {
        // The agent restarted on 0.3.0 with a 0.3.0 record still staged: that
        // update *is* the running agent, so the record must go.
        let tmp = tempfile::tempdir().unwrap();
        let staged = tmp.path().join("staged-agent");
        std::fs::write(&staged, b"NEW").unwrap();

        let mut state = state_with(pending("0.3.0", &staged));
        assert!(prune_applied_pending_update(&mut state, "0.3.0", None));
        assert!(state.update.pending_update.is_none());

        // An older record is likewise behind the running agent.
        let mut state = state_with(pending("v0.2.0", &staged));
        assert!(prune_applied_pending_update(&mut state, "0.3.0", None));
        assert!(state.update.pending_update.is_none());
    }

    #[test]
    fn prune_drops_pending_update_whose_binary_is_the_running_one() {
        // The record claims a newer version, but the running executable is
        // byte-identical to the staged binary — this process already *is* the
        // staged build (the shape the live-agent integration test exercises,
        // where a copy of the same build is published as v9.9.9).
        let tmp = tempfile::tempdir().unwrap();
        let staged = tmp.path().join("staged-agent");
        let running = tmp.path().join("running-agent");
        std::fs::write(&staged, b"IDENTICAL-BYTES").unwrap();
        std::fs::write(&running, b"IDENTICAL-BYTES").unwrap();

        let mut state = state_with(pending("9.9.9", &staged));
        assert!(prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(state.update.pending_update.is_none());
    }

    #[test]
    fn prune_keeps_a_genuinely_unapplied_update() {
        // Newer version AND different bytes on disk → the apply has not
        // happened (e.g. it failed). The record must survive for a retry.
        let tmp = tempfile::tempdir().unwrap();
        let staged = tmp.path().join("staged-agent");
        let running = tmp.path().join("running-agent");
        std::fs::write(&staged, b"NEW-BINARY").unwrap();
        std::fs::write(&running, b"OLD-BINARY").unwrap();

        let mut state = state_with(pending("9.9.9", &staged));
        assert!(!prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(
            state.update.pending_update.is_some(),
            "an unapplied update must be kept for retry"
        );
    }

    #[test]
    fn prune_keeps_update_when_staged_binary_differs_in_size() {
        // Different sizes settle it via the cheap metadata check alone (no bytes
        // are read). A genuinely newer staged build is a different length, so
        // this is the common production shape.
        let tmp = tempfile::tempdir().unwrap();
        let staged = tmp.path().join("staged-agent");
        let running = tmp.path().join("running-agent");
        std::fs::write(&staged, b"NEW-BINARY-THAT-IS-LONGER").unwrap();
        std::fs::write(&running, b"OLD").unwrap();

        let mut state = state_with(pending("9.9.9", &staged));
        assert!(!prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(state.update.pending_update.is_some());
    }

    #[test]
    fn prune_verdict_matches_across_multi_chunk_binaries() {
        // Binaries larger than one read buffer exercise the streaming compare:
        // identical multi-chunk contents clear; a single differing byte late in
        // an otherwise-identical, same-length binary keeps.
        let tmp = tempfile::tempdir().unwrap();
        let running = tmp.path().join("running-agent");
        let identical = tmp.path().join("staged-identical");
        let differ_late = tmp.path().join("staged-differ-late");

        let mut base = vec![0xABu8; 200 * 1024];
        for (i, b) in base.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        std::fs::write(&running, &base).unwrap();
        std::fs::write(&identical, &base).unwrap();
        let mut late = base.clone();
        *late.last_mut().unwrap() ^= 0xFF; // same length, last byte differs
        std::fs::write(&differ_late, &late).unwrap();

        let mut state = state_with(pending("9.9.9", &identical));
        assert!(prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(state.update.pending_update.is_none());

        let mut state = state_with(pending("9.9.9", &differ_late));
        assert!(!prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(state.update.pending_update.is_some());
    }

    #[test]
    fn prune_keeps_update_with_unparsable_version_and_different_binary() {
        // `agent.request_deferred_update` may stage a path with no version at
        // all. With nothing to compare and different bytes running, keep it.
        let tmp = tempfile::tempdir().unwrap();
        let staged = tmp.path().join("staged-agent");
        let running = tmp.path().join("running-agent");
        std::fs::write(&staged, b"NEW-BINARY").unwrap();
        std::fs::write(&running, b"OLD-BINARY").unwrap();

        let mut state = state_with(pending("", &staged));
        assert!(!prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(state.update.pending_update.is_some());
    }

    #[test]
    fn prune_keeps_update_when_staged_binary_is_gone() {
        // Nothing can prove the update was applied → keep rather than guess.
        let tmp = tempfile::tempdir().unwrap();
        let running = tmp.path().join("running-agent");
        std::fs::write(&running, b"OLD-BINARY").unwrap();

        let mut state = state_with(pending("9.9.9", &tmp.path().join("vanished")));
        assert!(!prune_applied_pending_update(
            &mut state,
            "0.1.0",
            Some(&running)
        ));
        assert!(state.update.pending_update.is_some());
    }

    #[test]
    fn prune_is_a_noop_without_a_pending_update() {
        let mut state = AgentState::default();
        assert!(!prune_applied_pending_update(&mut state, "0.1.0", None));
        assert!(state.update.pending_update.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn install_verified_swaps_contents_and_marks_executable() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("running-agent");
        std::fs::write(&current, b"OLD-BINARY").unwrap();
        // Start the "running" binary non-executable to prove install fixes perms.
        std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut verified = new_staging_temp(tmp.path()).unwrap();
        verified.write_all(b"NEW-BINARY").unwrap();

        install_verified(verified, &current).unwrap();

        assert_eq!(std::fs::read(&current).unwrap(), b"NEW-BINARY");
        let mode = std::fs::metadata(&current).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0, "replaced binary must be executable");
        // No staging temp file may linger next to the binary — the verified
        // copy is renamed into place, so only the target remains.
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec!["running-agent".to_string()],
            "a staging temp file must not linger, got {names:?}"
        );
    }

    // ── AGT-006: unique temp name, backup + revert on failed re-exec ──────

    #[cfg(unix)]
    #[test]
    fn staging_temp_names_are_unique_and_in_the_target_dir() {
        // Two staging temp files created for the same directory must have
        // distinct paths (no fixed name that concurrent/retried applies collide
        // on) and both live in that directory (so the final rename is atomic).
        let dir = tempfile::tempdir().unwrap();
        let a = new_staging_temp(dir.path()).unwrap();
        let b = new_staging_temp(dir.path()).unwrap();

        assert_ne!(a.path(), b.path(), "temp names must be unique");
        assert_eq!(a.path().parent().unwrap(), dir.path());
        assert_eq!(b.path().parent().unwrap(), dir.path());
    }

    #[cfg(unix)]
    #[test]
    fn backup_path_is_a_backup_suffixed_sibling() {
        let p = Path::new("/opt/termihub/termihub-agent");
        assert_eq!(
            backup_path_for(p),
            PathBuf::from("/opt/termihub/termihub-agent.backup")
        );
    }

    #[cfg(unix)]
    #[test]
    fn back_up_current_binary_copies_bytes_and_keeps_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("running-agent");
        std::fs::write(&current, b"WORKING-BINARY").unwrap();
        let backup = backup_path_for(&current);

        back_up_current_binary(&current, &backup).unwrap();

        assert_eq!(
            std::fs::read(&backup).unwrap(),
            b"WORKING-BINARY",
            "backup must hold the original bytes"
        );
        assert!(
            current.exists(),
            "the original binary must stay in place (copy, not move)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restore_backup_restores_the_original_bytes_and_consumes_the_backup() {
        // The revert path exercised directly, without a real exec: `dst` holds
        // the bad new binary, `backup` the previous working one; restoring must
        // leave `dst` byte-identical to the original and remove the backup.
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("running-agent");
        let backup = backup_path_for(&dst);
        std::fs::write(&dst, b"BAD-NEW-BINARY").unwrap();
        std::fs::write(&backup, b"GOOD-OLD-BINARY").unwrap();

        restore_backup(&backup, &dst).unwrap();

        assert_eq!(
            std::fs::read(&dst).unwrap(),
            b"GOOD-OLD-BINARY",
            "revert must restore the previously-working binary"
        );
        assert!(
            !backup.exists(),
            "the backup is consumed by the atomic restore"
        );
    }

    #[cfg(unix)]
    #[test]
    fn back_up_replace_restore_round_trips_to_the_original_binary() {
        // The full revert-on-failure sequence minus the exec: back up the working
        // binary, swap in a (bad) new one, then restore. The on-disk binary must
        // end up byte-identical to the original and remain executable — i.e. the
        // agent is never left without a runnable binary.
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("running-agent");
        std::fs::write(&current, b"GOOD-OLD-BINARY").unwrap();
        std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut verified = new_staging_temp(dir.path()).unwrap();
        verified.write_all(b"BAD-NEW-BINARY-LONGER").unwrap();
        let backup = backup_path_for(&current);

        back_up_current_binary(&current, &backup).unwrap();
        install_verified(verified, &current).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), b"BAD-NEW-BINARY-LONGER");

        restore_backup(&backup, &current).unwrap();

        assert_eq!(
            std::fs::read(&current).unwrap(),
            b"GOOD-OLD-BINARY",
            "after revert the agent must run the original binary again"
        );
        let mode = std::fs::metadata(&current).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0, "restored binary must stay executable");
        assert!(!backup.exists(), "backup consumed by restore");
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_stale_update_backup_removes_backup_and_tolerates_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("running-agent");
        std::fs::write(&exe, b"AGENT").unwrap();
        let backup = backup_path_for(&exe);
        std::fs::write(&backup, b"OLD-AGENT").unwrap();

        cleanup_stale_update_backup(&exe);
        assert!(!backup.exists(), "a leftover backup must be removed");
        assert!(exe.exists(), "the live binary must be untouched");

        // A second call with no backup present must be a no-op, never an error.
        cleanup_stale_update_backup(&exe);
        assert!(exe.exists());
    }

    // ── AGT-003: staging-dir confinement of the update binary path ────────

    #[test]
    fn confine_accepts_a_file_inside_the_staging_dir() {
        // (d) The legitimate case: a binary inside the trusted staging dir is
        // accepted, and the canonical path is returned.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let bin = staging.join("termihub-agent-linux-x64");
        std::fs::write(&bin, b"NEW-AGENT").unwrap();

        let confined = confine_to_staging(std::slice::from_ref(&staging), &bin)
            .expect("a binary inside the staging dir must be accepted");
        assert_eq!(confined, std::fs::canonicalize(&bin).unwrap());
    }

    #[test]
    fn confine_rejects_a_file_outside_the_staging_dir() {
        // (a) An absolute path outside staging — the core RCE vector — is refused.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let outside = dir.path().join("evil-agent");
        std::fs::write(&outside, b"EVIL").unwrap();

        let err = confine_to_staging(&[staging], &outside)
            .expect_err("a path outside the staging dir must be rejected");
        assert!(matches!(
            err,
            StagingConfinementError::OutsideStaging { .. }
        ));
    }

    #[test]
    fn confine_rejects_a_parent_traversal_escape() {
        // (c) A `..` traversal that climbs out of the staging dir is refused —
        // canonicalization resolves the `..` before the containment check.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let outside = dir.path().join("evil-agent");
        std::fs::write(&outside, b"EVIL").unwrap();

        let traversal = staging.join("..").join("evil-agent");
        let err = confine_to_staging(&[staging], &traversal)
            .expect_err("a `..` traversal out of staging must be rejected");
        assert!(matches!(
            err,
            StagingConfinementError::OutsideStaging { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn confine_rejects_a_symlink_that_escapes_staging() {
        // (b) A symlink placed *inside* staging that resolves *outside* is
        // refused — proving the check canonicalizes rather than string-prefixing.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let outside = dir.path().join("evil-agent");
        std::fs::write(&outside, b"EVIL").unwrap();

        let link = staging.join("termihub-agent-linux-x64");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let err = confine_to_staging(&[staging], &link)
            .expect_err("a symlink escaping staging must be rejected");
        assert!(matches!(
            err,
            StagingConfinementError::OutsideStaging { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn confine_refuses_a_symlink_inside_staging() {
        // AGT2-002: even a symlink that stays inside staging is refused — the
        // staged binary must be the file itself, never a name for another one.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let real = staging.join("real-agent");
        std::fs::write(&real, b"AGENT").unwrap();
        let link = staging.join("termihub-agent-linux-x64");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let err = confine_to_staging(&[staging], &link)
            .expect_err("a symlink inside staging must be refused");
        assert!(
            matches!(err, StagingConfinementError::SymlinkInPath { .. }),
            "got {err:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn confine_refuses_a_symlinked_directory_inside_staging() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        let real = staging.join("upload.real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("termihub-agent"), b"AGENT").unwrap();
        let link = staging.join("upload.link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let err = confine_to_staging(&[staging], &link.join("termihub-agent"))
            .expect_err("a symlinked directory below the staging root must be refused");
        assert!(
            matches!(err, StagingConfinementError::SymlinkInPath { .. }),
            "got {err:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn confine_accepts_a_staging_root_reached_through_a_symlink() {
        // A symlinked config dir (e.g. dotfiles-managed `~/.config`) is fine:
        // only components *below* the trusted root must not be symlinks.
        let dir = tempfile::tempdir().unwrap();
        let real_root = dir.path().join("real-config");
        std::fs::create_dir_all(&real_root).unwrap();
        let link_root = dir.path().join("config");
        std::os::unix::fs::symlink(&real_root, &link_root).unwrap();
        let bin = link_root.join("termihub-agent");
        std::fs::write(&bin, b"AGENT").unwrap();

        confine_to_staging(&[link_root], &bin).expect("a symlinked root must still be usable");
    }

    #[test]
    fn confine_rejects_a_sibling_prefix_dir() {
        // Containment is component-wise, not a raw string prefix: a sibling dir
        // whose name merely *starts with* the staging dir's name must not pass.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        std::fs::create_dir_all(&staging).unwrap();
        let sibling = dir.path().join("stage-evil");
        std::fs::create_dir_all(&sibling).unwrap();
        let bin = sibling.join("agent");
        std::fs::write(&bin, b"EVIL").unwrap();

        let err = confine_to_staging(&[staging], &bin)
            .expect_err("a sibling dir sharing a name prefix must be rejected");
        assert!(matches!(
            err,
            StagingConfinementError::OutsideStaging { .. }
        ));
    }

    #[test]
    fn confine_rejects_a_missing_path() {
        // Fail closed: an unresolvable path is never trusted.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();

        let err = confine_to_staging(
            std::slice::from_ref(&staging),
            &staging.join("does-not-exist"),
        )
        .expect_err("a missing path must be rejected");
        assert!(matches!(err, StagingConfinementError::Unresolvable { .. }));
    }

    #[test]
    fn confine_rejects_a_directory() {
        // A directory (even one inside staging) is not a binary.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        let subdir = staging.join("subdir");
        std::fs::create_dir_all(&subdir).unwrap();

        let err =
            confine_to_staging(&[staging], &subdir).expect_err("a directory must be rejected");
        assert!(matches!(err, StagingConfinementError::NotAFile { .. }));
    }

    #[test]
    fn confine_skips_a_nonexistent_root_without_widening() {
        // A root that does not exist contains nothing: it must neither admit a
        // path nor cause a spurious error for a path a *real* root would accept.
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("updates");
        std::fs::create_dir_all(&real).unwrap();
        let bin = real.join("agent");
        std::fs::write(&bin, b"NEW").unwrap();
        let missing = dir.path().join("does-not-exist");

        // Missing root first, real root second → still accepted via the real one.
        confine_to_staging(&[missing.clone(), real], &bin)
            .expect("a valid path must be accepted despite a missing sibling root");
        // Only the missing root → nothing is trusted, so the path is refused.
        let err = confine_to_staging(&[missing], &bin)
            .expect_err("a missing-only root set must reject everything");
        assert!(matches!(
            err,
            StagingConfinementError::OutsideStaging { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_a_source_outside_the_staging_dir() {
        // (e) Defense-in-depth: the apply path itself refuses an out-of-staging
        // source, returning *before* any copy or re-exec (the confinement check
        // is the first thing it does, so no swap of the running binary occurs).
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let outside = dir.path().join("evil-agent");
        std::fs::write(&outside, b"EVIL").unwrap();

        let err = apply_update_binary_confined(
            outside.to_str().unwrap(),
            Some(&sha256_hex(b"EVIL")),
            None,
            None,
            &[staging],
            &strict_test_policy(),
            &VersionPolicy::strict("0.0.0"),
        )
        .expect_err("apply must refuse a source outside the staging dir");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("outside the trusted staging directory"),
            "the apply error must name the confinement reason, got: {msg}"
        );
    }

    // ── AGT-004: apply-time SHA-256 integrity verification ────────────────

    #[cfg(unix)]
    use crate::update::signature::test_support::{sign_digest, test_signing_key};

    /// Seed of the only key [`strict_test_policy`] trusts.
    #[cfg(unix)]
    const TEST_KEY_SEED: u8 = 42;

    /// The release-build signature rule (no unsigned allowance), trusting a
    /// fixed test key — so these tests exercise production behaviour even
    /// though the test binary itself is a debug build.
    #[cfg(unix)]
    fn strict_test_policy() -> SignaturePolicy {
        SignaturePolicy::strict(vec![test_signing_key(TEST_KEY_SEED).verifying_key()])
    }

    #[cfg(unix)]
    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex::encode(hasher.finalize())
    }

    /// Stage a valid binary inside a staging dir, returning
    /// `(staging_root, staged_path, correct_digest)`.
    #[cfg(unix)]
    fn stage_valid_binary(dir: &Path, bytes: &[u8]) -> (PathBuf, PathBuf, String) {
        use std::os::unix::fs::PermissionsExt;

        let staging = dir.join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).unwrap();
        let bin = staging.join("termihub-agent-linux-x64");
        std::fs::write(&bin, bytes).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o600)).unwrap();
        (staging, bin, sha256_hex(bytes))
    }

    /// The bytes of a verified copy, read back through its handle.
    #[cfg(unix)]
    fn copy_bytes(copy: &tempfile::NamedTempFile) -> Vec<u8> {
        use std::io::{Read, Seek, SeekFrom};
        let mut handle = copy.as_file();
        handle.seek(SeekFrom::Start(0)).unwrap();
        let mut out = Vec::new();
        handle.read_to_end(&mut out).unwrap();
        out
    }

    // These drive `confine_and_verify` — the gate that runs before the swap — so
    // they exercise the real reject/accept decision without a destructive
    // swap+re-exec of the test binary.

    #[cfg(unix)]
    #[test]
    fn apply_rejects_a_binary_whose_bytes_do_not_match_the_expected_digest() {
        // (a) The staged bytes do not match the expected digest — a tampered or
        // corrupt binary. The gate must reject before any swap.
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, _good) = stage_valid_binary(tmp.path(), b"REAL-AGENT-BYTES");
        let wrong_digest = sha256_hex(b"WHAT-THE-INITIATOR-INTENDED");

        let err = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&wrong_digest),
            None,
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect_err("a digest mismatch must be rejected");
        let msg = format!("{err:#}");
        assert!(
            msg.to_ascii_lowercase().contains("checksum") || msg.contains("integrity verification"),
            "the apply error must name the integrity failure, got: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn apply_rejects_a_binary_swapped_after_staging_toctou() {
        // (b) TOCTOU: a good binary is staged and its digest recorded, then the
        // file at the path is replaced with different bytes before apply. The
        // gate re-hashes the on-disk bytes and rejects — the earlier
        // download/upload verification is not sufficient.
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, good_digest) = stage_valid_binary(tmp.path(), b"GOOD-STAGED-BYTES");

        // Attacker swaps the file at the confined path after staging.
        std::fs::write(&staged, b"MALICIOUS-SWAPPED-BYTES").unwrap();

        let err = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&good_digest),
            None,
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect_err("bytes swapped after staging must be rejected at apply time");
        let msg = format!("{err:#}").to_ascii_lowercase();
        assert!(
            msg.contains("checksum") || msg.contains("integrity"),
            "the apply error must name the integrity failure, got: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn apply_fails_closed_on_a_missing_expected_digest() {
        // (c) No expected digest carried → fail closed (reject), never skip
        // verification. A staged binary with no digest must not be applied.
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, _good) = stage_valid_binary(tmp.path(), b"UNVERIFIABLE-BYTES");

        let err = confine_and_verify(
            staged.to_str().unwrap(),
            None,
            None,
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect_err("a missing expected digest must fail closed");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("integrity verification") || msg.to_ascii_lowercase().contains("digest"),
            "the apply error must name the missing-digest fail-closed reason, got: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn apply_gate_accepts_a_matching_confined_binary() {
        // (d) The matching case: correct digest for the staged, confined bytes
        // passes the gate and returns a private copy of exactly those bytes.
        // (The full swap+re-exec cannot run in-process; the swap itself is
        // covered by the `install_verified_*` tests.)
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, good_digest) = stage_valid_binary(tmp.path(), b"CORRECT-AGENT-BYTES");

        let signature = sign_digest(&test_signing_key(TEST_KEY_SEED), &good_digest);

        let copy = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&good_digest),
            Some(&signature),
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect("a matching, confined, signed binary must pass the gate");
        assert_eq!(copy_bytes(&copy), b"CORRECT-AGENT-BYTES");
    }

    #[cfg(unix)]
    #[test]
    fn check_expected_digest_rejects_missing_and_mismatch() {
        let bin = Path::new("/staged/agent");
        let good = sha256_hex(b"AGENT-BYTES");

        // Missing digest → fail closed.
        assert!(check_expected_digest(bin, &good, None).is_err());
        // Mismatch → reject.
        assert!(check_expected_digest(bin, &good, Some(&sha256_hex(b"OTHER"))).is_err());
        // Match (case-insensitive) → OK.
        assert!(check_expected_digest(bin, &good, Some(&good.to_ascii_uppercase())).is_ok());
    }

    // ── AGT-005: apply-time Ed25519 signature verification (#3213) ──────

    /// Drive the gate with a staged, digest-correct binary and `signature`,
    /// returning the error (the gate must refuse).
    #[cfg(unix)]
    fn gate_rejects_with(signature: Option<&str>, policy: &SignaturePolicy) -> anyhow::Error {
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, good_digest) = stage_valid_binary(tmp.path(), b"STAGED-AGENT");
        confine_and_verify(
            staged.to_str().unwrap(),
            Some(&good_digest),
            signature,
            std::slice::from_ref(&staging),
            policy,
            tmp.path(),
        )
        .expect_err("the gate must refuse this signature")
    }

    #[cfg(unix)]
    fn signature_error_of(err: &anyhow::Error) -> UpdateSignatureError {
        err.downcast_ref::<UpdateSignatureError>()
            .cloned()
            .unwrap_or_else(|| panic!("typed signature error must be in the chain: {err:#}"))
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_an_unsigned_staged_binary() {
        // Digest matches, path is confined — but no signature: a release build
        // refuses before any swap.
        let err = gate_rejects_with(None, &strict_test_policy());
        assert_eq!(signature_error_of(&err), UpdateSignatureError::Missing);
        assert!(format!("{err:#}").contains("signature verification"));
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_a_binary_signed_by_a_foreign_key() {
        let digest = sha256_hex(b"STAGED-AGENT");
        let foreign = sign_digest(&test_signing_key(7), &digest);
        let err = gate_rejects_with(Some(&foreign), &strict_test_policy());
        assert_eq!(signature_error_of(&err), UpdateSignatureError::Invalid);
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_a_signature_made_for_different_bytes() {
        // A genuine release signature, lifted from another binary, does not
        // transfer to the staged one.
        let other = sign_digest(
            &test_signing_key(TEST_KEY_SEED),
            &sha256_hex(b"SOME-OTHER-RELEASE"),
        );
        let err = gate_rejects_with(Some(&other), &strict_test_policy());
        assert_eq!(signature_error_of(&err), UpdateSignatureError::Invalid);
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_everything_with_the_placeholder_key() {
        let digest = sha256_hex(b"STAGED-AGENT");
        let sig = sign_digest(&test_signing_key(TEST_KEY_SEED), &digest);
        let no_key = SignaturePolicy::strict(Vec::new());
        let err = gate_rejects_with(Some(&sig), &no_key);
        assert_eq!(
            signature_error_of(&err),
            UpdateSignatureError::KeyNotConfigured
        );
    }

    #[cfg(unix)]
    #[test]
    fn apply_checks_the_digest_before_the_signature() {
        // A validly signed digest is useless if the on-disk bytes were swapped:
        // the integrity guard fires first and no signature error is reported.
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, good_digest) = stage_valid_binary(tmp.path(), b"GOOD-BYTES");
        let sig = sign_digest(&test_signing_key(TEST_KEY_SEED), &good_digest);
        std::fs::write(&staged, b"SWAPPED-BYTES").unwrap();
        let err = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&good_digest),
            Some(&sig),
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect_err("swapped bytes must be refused");
        assert!(err.downcast_ref::<UpdateSignatureError>().is_none());
        assert!(format!("{err:#}").contains("integrity verification"));
    }

    #[cfg(unix)]
    #[test]
    fn apply_update_binary_confined_refuses_unsigned_before_touching_the_binary() {
        // The full apply entry point (not just the gate) refuses an unsigned,
        // otherwise-valid staged binary and returns — it never reaches the
        // backup/swap/re-exec (which would replace this test process).
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, good_digest) = stage_valid_binary(tmp.path(), b"UNSIGNED-AGENT");
        let exe = std::env::current_exe().unwrap();
        let err = apply_update_binary_confined(
            staged.to_str().unwrap(),
            Some(&good_digest),
            None,
            None,
            &[staging],
            &strict_test_policy(),
            &VersionPolicy::strict("0.0.0"),
        )
        .expect_err("an unsigned update must never be applied");
        assert_eq!(signature_error_of(&err), UpdateSignatureError::Missing);
        assert!(
            !backup_path_for(&exe).exists(),
            "the running binary must not even be backed up"
        );
    }

    // ── SEC-006: apply-time downgrade policy (#3213) ─────────────────────

    /// Stage a digest-correct, test-key-signed binary that embeds build version
    /// `version`, returning `(staging_root, staged_path, digest, signature)`.
    #[cfg(unix)]
    fn stage_signed_versioned_binary(
        dir: &Path,
        version: &str,
    ) -> (PathBuf, PathBuf, String, String) {
        let mut bytes = b"AGENT".to_vec();
        bytes.extend_from_slice(super::super::build_version::MARKER_PREFIX);
        bytes.extend_from_slice(version.as_bytes());
        bytes.push(0);
        let (staging, staged, digest) = stage_valid_binary(dir, &bytes);
        let signature = sign_digest(&test_signing_key(TEST_KEY_SEED), &digest);
        (staging, staged, digest, signature)
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_an_unpinned_downgrade_before_touching_the_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest, signature) =
            stage_signed_versioned_binary(tmp.path(), "0.1.0");
        let exe = std::env::current_exe().unwrap();
        let err = apply_update_binary_confined(
            staged.to_str().unwrap(),
            Some(&digest),
            Some(&signature),
            None,
            &[staging],
            &strict_test_policy(),
            &VersionPolicy::strict("9.9.9"),
        )
        .expect_err("an unpinned downgrade must never be applied");
        assert!(
            matches!(
                err.downcast_ref::<VersionPolicyError>(),
                Some(VersionPolicyError::Downgrade { .. })
            ),
            "typed policy error must be in the chain: {err:#}"
        );
        assert!(
            !backup_path_for(&exe).exists(),
            "the running binary must not even be backed up"
        );
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_a_pin_that_does_not_name_the_staged_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest, signature) =
            stage_signed_versioned_binary(tmp.path(), "0.1.0");
        let err = apply_update_binary_confined(
            staged.to_str().unwrap(),
            Some(&digest),
            Some(&signature),
            Some("0.2.0"),
            &[staging],
            &strict_test_policy(),
            &VersionPolicy::strict("9.9.9"),
        )
        .expect_err("a mismatched pin must never be applied");
        assert!(matches!(
            err.downcast_ref::<VersionPolicyError>(),
            Some(VersionPolicyError::PinnedVersionMismatch { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn apply_gate_accepts_a_pinned_downgrade_of_an_authentic_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest, signature) =
            stage_signed_versioned_binary(tmp.path(), "0.1.0");
        let copy = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&digest),
            Some(&signature),
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect("an authentic binary passes the signature gate");
        check_version_policy(&copy, Some("0.1.0"), &VersionPolicy::strict("9.9.9"))
            .expect("a matched pin authorises the downgrade");
        // And an upgrade needs no pin.
        check_version_policy(&copy, None, &VersionPolicy::strict("0.0.1"))
            .expect("an upgrade is always allowed");
    }

    // ── AGT2-002: handle-bound verification, private staging (#4287) ─────

    #[cfg(unix)]
    #[test]
    fn production_staging_roots_trust_no_shared_tmp_path() {
        let roots = production_staging_roots();
        assert_eq!(roots, vec![AgentState::config_dir().join("updates")]);
        assert!(
            roots.iter().all(|r| !r.starts_with("/tmp")),
            "a world-shared /tmp path must never be a staging root: {roots:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_renamed_over_the_staged_path_after_open_is_never_installed() {
        // The hook runs after the staged file is opened and before it is read:
        // an attacker renaming different bytes over the path at that moment
        // changes nothing, because verification and the copy both read the
        // already-open handle.
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest) = stage_valid_binary(tmp.path(), b"GOOD-STAGED-BYTES");
        let sig = sign_digest(&test_signing_key(TEST_KEY_SEED), &digest);

        let copy = confine_and_verify_with_hook(
            staged.to_str().unwrap(),
            Some(&digest),
            Some(&sig),
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
            |path| {
                let evil = path.with_file_name("evil");
                std::fs::write(&evil, b"MALICIOUS-SWAPPED-BYTES").unwrap();
                std::fs::rename(&evil, path).unwrap();
            },
        )
        .expect("the opened, verified bytes are still the good ones");

        assert_eq!(copy_bytes(&copy), b"GOOD-STAGED-BYTES");
        assert_eq!(std::fs::read(&staged).unwrap(), b"MALICIOUS-SWAPPED-BYTES");
    }

    #[cfg(unix)]
    #[test]
    fn a_staged_file_rewritten_in_place_after_open_is_detected() {
        // Rewriting the same inode after open is visible through the handle,
        // so the digest of the bytes actually copied no longer matches.
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest) = stage_valid_binary(tmp.path(), b"GOOD-STAGED-BYTES");
        let sig = sign_digest(&test_signing_key(TEST_KEY_SEED), &digest);

        let err = confine_and_verify_with_hook(
            staged.to_str().unwrap(),
            Some(&digest),
            Some(&sig),
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
            |path| std::fs::write(path, b"MALICIOUS-REWRITTEN-BYTES").unwrap(),
        )
        .expect_err("bytes rewritten after open must fail verification");
        assert!(format!("{err:#}").contains("integrity verification"));
    }

    #[cfg(unix)]
    #[test]
    fn apply_refuses_a_world_writable_staged_binary() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest) = stage_valid_binary(tmp.path(), b"AGENT");
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o666)).unwrap();

        let err = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&digest),
            None,
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            tmp.path(),
        )
        .expect_err("a binary other users can write must be refused");
        assert!(
            format!("{err:#}").contains("privately staged"),
            "got: {err:#}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_valid_signed_update_installs_exactly_the_verified_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, digest, signature) =
            stage_signed_versioned_binary(tmp.path(), "9.0.0");
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir(&bin_dir).unwrap();
        let current = bin_dir.join("termihub-agent");
        std::fs::write(&current, b"OLD-AGENT").unwrap();

        let copy = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&digest),
            Some(&signature),
            std::slice::from_ref(&staging),
            &strict_test_policy(),
            &bin_dir,
        )
        .expect("a valid signed update passes the gate");
        check_version_policy(&copy, None, &VersionPolicy::strict("1.0.0"))
            .expect("an upgrade passes the version policy");
        install_verified(copy, &current).expect("the verified copy installs");

        assert_eq!(
            std::fs::read(&current).unwrap(),
            std::fs::read(&staged).unwrap()
        );
    }
}
