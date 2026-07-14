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

#[cfg(unix)]
use std::path::Path;

use crate::state::persistence::PendingUpdate;

/// Decide whether a pending update should be applied right now.
///
/// Returns `true` only when the agent is idle (`active_count == 0`) **and** an
/// update is actually pending. This is the single source of truth for the
/// "apply on last disconnect" gate: it must never return `true` while a session
/// is still running.
pub fn should_apply_deferred_update(active_count: u32, has_pending: bool) -> bool {
    active_count == 0 && has_pending
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
