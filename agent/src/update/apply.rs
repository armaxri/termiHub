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

use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

use tracing::debug;
#[cfg(unix)]
use tracing::{info, warn};

use super::version;
use crate::state::persistence::{AgentState, PendingUpdate};

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
        apply_update_binary(&pending.binary_path)
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
fn apply_update_binary(binary_path: &str) -> anyhow::Result<()> {
    use anyhow::Context;

    let current = std::env::current_exe().context("resolve current agent executable")?;
    let backup = backup_path_for(&current);

    // Preserve the currently-running (working) binary. A *copy* — not a rename —
    // so `current` is never absent: the live swap below stays an atomic same-dir
    // rename over an always-present target.
    back_up_current_binary(&current, &backup)
        .with_context(|| format!("back up current agent binary at {}", current.display()))?;

    if let Err(e) = replace_binary(Path::new(binary_path), &current)
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
fn apply_update_binary(_binary_path: &str) -> anyhow::Result<()> {
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
}
