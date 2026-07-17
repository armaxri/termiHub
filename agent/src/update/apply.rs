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

use tracing::debug;

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
/// Compares lengths first so the (rare) SHA-256 pass only runs on a real
/// candidate. Any I/O error means "cannot prove identical" → `false`, which
/// keeps the pending update rather than dropping it on a guess.
fn files_identical(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if !meta_a.is_file() || !meta_b.is_file() || meta_a.len() != meta_b.len() {
        return false;
    }
    match (file_digest(a), file_digest(b)) {
        (Some(da), Some(db)) => da == db,
        _ => false,
    }
}

/// SHA-256 of a file's contents, streamed so a large binary is never fully
/// buffered. `None` on any I/O error.
fn file_digest(path: &Path) -> Option<[u8; 32]> {
    use sha2::{Digest, Sha256};

    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(hasher.finalize().into())
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
/// temp file + `rename` in the same directory) and then the process re-execs
/// itself with the same CLI arguments so the new code takes over immediately.
#[cfg(unix)]
fn apply_update_binary(binary_path: &str) -> anyhow::Result<()> {
    use anyhow::Context;

    let current = std::env::current_exe().context("resolve current agent executable")?;
    replace_binary(Path::new(binary_path), &current)
        .with_context(|| format!("replace agent binary at {}", current.display()))?;
    reexec(&current)
}

/// Non-Unix stub: applying a deferred update is only supported on Unix, where a
/// running executable can be replaced in place. Returns an error so the caller
/// surfaces it; keeps Windows/other builds compiling.
#[cfg(not(unix))]
fn apply_update_binary(_binary_path: &str) -> anyhow::Result<()> {
    anyhow::bail!("deferred agent update apply is only supported on Unix platforms")
}

/// Atomically replace the executable at `dst` with the file at `src`, marking it
/// executable. Copies to a sibling temp file first so a crash mid-copy can never
/// leave a truncated agent binary in place.
#[cfg(unix)]
fn replace_binary(src: &Path, dst: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;

    let dir = dst.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(".termihub-agent.update.tmp");

    std::fs::copy(src, &tmp)
        .with_context(|| format!("copy staged binary {} -> {}", src.display(), tmp.display()))?;

    let mut perms = std::fs::metadata(&tmp)
        .with_context(|| format!("stat staged binary {}", tmp.display()))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&tmp, perms)
        .with_context(|| format!("chmod staged binary {}", tmp.display()))?;

    std::fs::rename(&tmp, dst).with_context(|| format!("atomically replace {}", dst.display()))?;

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
        // The temp file must not linger next to the binary.
        assert!(!tmp.path().join(".termihub-agent.update.tmp").exists());
    }
}
