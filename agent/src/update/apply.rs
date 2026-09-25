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
pub fn confine_to_staging(
    roots: &[PathBuf],
    requested: &Path,
) -> Result<PathBuf, StagingConfinementError> {
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
                return Ok(canonical);
            }
        }
    }

    Err(StagingConfinementError::OutsideStaging {
        path: canonical.display().to_string(),
    })
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
fn files_identical(a: &Path, b: &Path) -> bool {
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
}

/// Production [`UpdateApplier`] that swaps the on-disk binary and re-execs.
pub struct SystemUpdateApplier;

impl UpdateApplier for SystemUpdateApplier {
    fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
        apply_update_binary(&pending.binary_path, pending.expected_sha256.as_deref())
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
fn apply_update_binary(binary_path: &str, expected_sha256: Option<&str>) -> anyhow::Result<()> {
    apply_update_binary_confined(binary_path, expected_sha256, &production_staging_roots())
}

/// The fixed remote path the desktop coordinated-push deploy uploads a staged
/// agent binary to before calling `agent.request_update` (#1616). Kept in sync
/// with the desktop's `agent_install::POSIX_UPLOAD_PATH`; a binary staged here
/// by the desktop's authenticated SFTP channel is trusted the same as a
/// self-downloaded one (AGT-003).
#[cfg(unix)]
pub const POSIX_COORDINATED_UPLOAD_PATH: &str = "/tmp/termihub-agent-upload";

/// The agent-owned staging locations a self-update binary may legitimately live
/// in (AGT-003): the self-update download dir (`<config>/updates`) and the fixed
/// desktop coordinated-push upload path. Nonexistent roots are skipped by
/// [`confine_to_staging`].
#[cfg(unix)]
fn production_staging_roots() -> Vec<PathBuf> {
    vec![
        AgentState::config_dir().join("updates"),
        PathBuf::from(POSIX_COORDINATED_UPLOAD_PATH),
    ]
}

/// Swap-and-re-exec, but refuse a source outside `staging_roots` (AGT-003
/// defense-in-depth) **and** whose bytes do not match `expected_sha256`
/// (AGT-004) first.
///
/// This is the last gate before the running binary is replaced. Two guards run,
/// in order, **before any copy or re-exec**:
///
/// 1. **Confinement (AGT-003, #3214).** Even though `request_deferred_update`
///    already confined the path when the update was staged, the apply path
///    re-asserts it here so a source outside the trusted staging locations is
///    refused — it must never rely solely on the upstream check.
/// 2. **Integrity (AGT-004).** The on-disk bytes at the confined path are
///    SHA-256-hashed and compared to `expected_sha256`. A missing digest, a read
///    error, or a mismatch all reject. This re-verification at apply time is what
///    closes the stage-then-tamper TOCTOU: a binary verified at download/upload
///    can still be swapped on disk before it is applied, so the bytes are
///    re-hashed here, immediately before the swap.
///
/// Fails **closed** on any violation of either guard — the running binary is
/// never touched.
#[cfg(unix)]
fn apply_update_binary_confined(
    binary_path: &str,
    expected_sha256: Option<&str>,
    staging_roots: &[PathBuf],
) -> anyhow::Result<()> {
    use anyhow::Context;

    // Both guards run — confinement then digest — before the running binary is
    // ever touched. Extracted into `confine_and_verify` so the tamper-vector
    // tests can exercise the gate without driving the (destructive) swap+re-exec.
    let src = confine_and_verify(binary_path, expected_sha256, staging_roots)?;

    let current = std::env::current_exe().context("resolve current agent executable")?;
    let backup = backup_path_for(&current);

    // Preserve the currently-running (working) binary. A *copy* — not a rename —
    // so `current` is never absent: the live swap below stays an atomic same-dir
    // rename over an always-present target.
    back_up_current_binary(&current, &backup)
        .with_context(|| format!("back up current agent binary at {}", current.display()))?;

    if let Err(e) = replace_binary(&src, &current)
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

/// Run both apply-time guards — confinement (AGT-003) then integrity (AGT-004) —
/// and return the confined, verified source path. Neither touches the running
/// binary, so this is the non-destructive gate the swap depends on (and the seam
/// the tamper-vector tests drive without a real swap+re-exec).
///
/// Order matters: confinement is FIRST so an out-of-staging path is rejected
/// before its bytes are ever read. Fails **closed** on either guard.
#[cfg(unix)]
fn confine_and_verify(
    binary_path: &str,
    expected_sha256: Option<&str>,
    staging_roots: &[PathBuf],
) -> anyhow::Result<PathBuf> {
    use anyhow::Context;

    let src = confine_to_staging(staging_roots, Path::new(binary_path))
        .context("refuse to apply an agent update binary outside the trusted staging directory")?;

    verify_confined_digest(&src, expected_sha256)
        .context("refuse to apply an agent update binary that failed integrity verification")?;

    Ok(src)
}

/// Verify the confined update binary at `src` against its `expected_sha256`
/// digest (AGT-004), failing **closed**.
///
/// Re-hashes the on-disk bytes at `src` and compares them to the digest the
/// route that staged the update recorded. This runs immediately before the swap
/// so a binary that was verified at download/upload but then swapped on disk is
/// still caught (the stage-then-tamper TOCTOU).
///
/// Fails closed on all three failure modes:
/// - **Missing digest** (`None`) — no route supplied one, so there is nothing to
///   verify against; reject rather than skip.
/// - **Read error** — the bytes cannot be hashed, so integrity cannot be proven.
/// - **Mismatch** — the bytes are not the ones the initiator intended.
#[cfg(unix)]
fn verify_confined_digest(src: &Path, expected_sha256: Option<&str>) -> anyhow::Result<()> {
    let expected = expected_sha256.ok_or_else(|| {
        anyhow::anyhow!(
            "no expected SHA-256 digest was carried to the apply path for {} — refusing to \
             apply an unverified agent binary (fail closed)",
            src.display()
        )
    })?;
    super::checksum::verify_file_checksum(src, expected)
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
fn apply_update_binary(_binary_path: &str, _expected_sha256: Option<&str>) -> anyhow::Result<()> {
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
fn new_staging_temp(dir: &Path) -> anyhow::Result<tempfile::NamedTempFile> {
    use anyhow::Context;

    tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("create staging temp file in {}", dir.display()))
}

/// Atomically replace the executable at `dst` with the file at `src`, marking it
/// executable. Stages into a **uniquely-named** sibling temp file first so a
/// crash mid-copy can never leave a truncated agent binary in place, and so
/// concurrent/retried applies never collide on a shared temp name (AGT-006).
#[cfg(unix)]
fn replace_binary(src: &Path, dst: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;

    let dir = dst.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = new_staging_temp(dir)?;

    // Copy the staged binary into the temp file through its handle, then flush to
    // disk before the rename so a crash right after the rename can never expose a
    // temp file whose bytes were not durably written.
    {
        let mut staged = std::fs::File::open(src)
            .with_context(|| format!("open staged binary {}", src.display()))?;
        std::io::copy(&mut staged, tmp.as_file_mut()).with_context(|| {
            format!(
                "copy staged binary {} -> {}",
                src.display(),
                tmp.path().display()
            )
        })?;
    }
    tmp.as_file()
        .sync_all()
        .with_context(|| format!("flush staged binary {} to disk", tmp.path().display()))?;

    let mut perms = tmp
        .as_file()
        .metadata()
        .with_context(|| format!("stat staged binary {}", tmp.path().display()))?
        .permissions();
    perms.set_mode(0o755);
    tmp.as_file()
        .set_permissions(perms)
        .with_context(|| format!("chmod staged binary {}", tmp.path().display()))?;

    // `persist` renames the temp file over `dst`; the target always holds either
    // the complete old binary or the complete new one, never a partial mix.
    tmp.persist(dst)
        .map_err(|e| e.error)
        .with_context(|| format!("atomically replace {}", dst.display()))?;

    Ok(())
}

/// Re-exec `exe` with the current process's CLI arguments. On success this
/// replaces the process image and never returns; it only returns on failure.
#[cfg(unix)]
fn reexec(exe: &Path) -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt;

    let args: Vec<String> = std::env::args().skip(1).collect();
    // `exec` replaces the current image with `exe`; control only returns here if
    // the exec itself failed.
    let err = std::process::Command::new(exe).args(&args).exec();
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
    fn replace_binary_swaps_contents_and_marks_executable() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let staged = tmp.path().join("staged-agent");
        let current = tmp.path().join("running-agent");
        std::fs::write(&staged, b"NEW-BINARY").unwrap();
        std::fs::write(&current, b"OLD-BINARY").unwrap();
        // Start the "running" binary non-executable to prove replace fixes perms.
        std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o600)).unwrap();

        replace_binary(&staged, &current).unwrap();

        assert_eq!(std::fs::read(&current).unwrap(), b"NEW-BINARY");
        let mode = std::fs::metadata(&current).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0, "replaced binary must be executable");
        // No staging temp file may linger next to the binary — the directory
        // should hold exactly the staged source and the swapped-in target.
        let mut names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["running-agent".to_string(), "staged-agent".to_string()],
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
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("running-agent");
        let staged = dir.path().join("staged-agent");
        std::fs::write(&current, b"GOOD-OLD-BINARY").unwrap();
        std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(&staged, b"BAD-NEW-BINARY-LONGER").unwrap();
        let backup = backup_path_for(&current);

        back_up_current_binary(&current, &backup).unwrap();
        replace_binary(&staged, &current).unwrap();
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
            &[staging],
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
        let staging = dir.join("updates");
        std::fs::create_dir_all(&staging).unwrap();
        let bin = staging.join("termihub-agent-linux-x64");
        std::fs::write(&bin, bytes).unwrap();
        (staging, bin, sha256_hex(bytes))
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
            std::slice::from_ref(&staging),
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
            std::slice::from_ref(&staging),
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
            std::slice::from_ref(&staging),
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
        // passes the gate and returns the canonical confined path. (The full
        // swap+re-exec cannot run in-process; the swap itself is covered by the
        // `replace_binary_*` tests.)
        let tmp = tempfile::tempdir().unwrap();
        let (staging, staged, good_digest) = stage_valid_binary(tmp.path(), b"CORRECT-AGENT-BYTES");

        let confined = confine_and_verify(
            staged.to_str().unwrap(),
            Some(&good_digest),
            std::slice::from_ref(&staging),
        )
        .expect("a matching, confined binary must pass the gate");
        assert_eq!(confined, std::fs::canonicalize(&staged).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn verify_confined_digest_rejects_missing_mismatch_and_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("agent");
        std::fs::write(&bin, b"AGENT-BYTES").unwrap();
        let good = sha256_hex(b"AGENT-BYTES");

        // Missing digest → fail closed.
        assert!(verify_confined_digest(&bin, None).is_err());
        // Mismatch → reject.
        assert!(verify_confined_digest(&bin, Some(&sha256_hex(b"OTHER"))).is_err());
        // Unreadable file → reject (cannot prove integrity).
        assert!(verify_confined_digest(&tmp.path().join("does-not-exist"), Some(&good)).is_err());
        // Match → OK.
        assert!(verify_confined_digest(&bin, Some(&good)).is_ok());
    }
}
