//! Container re-attachment for relaunched Docker transfers (#3585).
//!
//! A rehydrated Docker transfer persists its container's **full id** (never a
//! name, never a runtime config or secret). Its original session id does not
//! survive an app restart, so the relaunch resolves a streaming target in this
//! order, always by that exact id:
//!
//! 1. the original session, if it is still live in this run and still points at
//!    the same container;
//! 2. any live Docker session on that same container — the user reconnected the
//!    container's tab after the restart, under a new session id;
//! 3. a backend-owned connection to the local container runtime
//!    ([`reattach_transfer_target`]), which verifies the id and that the
//!    container is running.
//!
//! A container recreated under the same name has a new id, so it never matches
//! any step: the row fails with a clear message instead of resuming a partial
//! into a different filesystem. A stopped container or an unreachable runtime
//! also fails the row, with a message saying what to fix before **Retry** —
//! which re-runs this resolution, since the persisted record is kept.
//!
//! The resolved target then runs [`run_docker_transfer`](super::docker::run_docker_transfer)
//! from the persisted offset, whose resume gate still byte-verifies the source
//! fingerprint and destination before any append.

use termihub_core::backends::docker::{
    reattach_transfer_target, short_container_id, DockerTransferTarget, ReattachError,
};

use crate::session::manager::SessionManager;

/// Whether a live session's container is the persisted one. Only an exact,
/// non-empty full-id match counts.
fn is_same_container(candidate: &str, persisted: &str) -> bool {
    !persisted.is_empty() && candidate == persisted
}

/// The Failed-row message for a container that could not be re-attached,
/// saying what (if anything) makes a Retry succeed.
fn reattach_failure_message(err: &ReattachError) -> String {
    match err {
        ReattachError::Gone(id) => format!(
            "Cannot resume: container {id} no longer exists (it was removed or \
             recreated), so the partial transfer cannot continue — start it again"
        ),
        ReattachError::NotRunning(id) => format!(
            "Cannot resume: container {id} is not running — start it or reconnect \
             its session, then Retry"
        ),
        ReattachError::Unreachable(e) => format!(
            "Cannot resume: container runtime unreachable ({e}) — reconnect the \
             Docker session, then Retry"
        ),
    }
}

/// Resolve the streaming target for a relaunched Docker transfer on exactly
/// `container_id`, or the Failed-row message explaining why it cannot run.
pub(crate) async fn resolve_docker_target(
    manager: &SessionManager,
    session_id: &str,
    container_id: &str,
) -> Result<DockerTransferTarget, String> {
    if let Ok(target) = manager.docker_transfer_target(session_id).await {
        if is_same_container(target.container_id(), container_id) {
            return Ok(target);
        }
        tracing::warn!(
            session_id,
            persisted = short_container_id(container_id),
            live = short_container_id(target.container_id()),
            "Docker session now points at a different container; not resuming there"
        );
    }
    if let Some(target) = manager
        .docker_transfer_target_for_container(container_id)
        .await
    {
        return Ok(target);
    }
    reattach_transfer_target(container_id)
        .await
        .map_err(|e| reattach_failure_message(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn only_the_exact_container_id_matches() {
        assert!(is_same_container(ID, ID));
        // A recreated container (same name, new id) is a different filesystem.
        assert!(!is_same_container(
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            ID
        ));
        // An id prefix is not the container.
        assert!(!is_same_container(&ID[..12], ID));
        assert!(!is_same_container("", ""));
    }

    #[test]
    fn failure_messages_say_what_makes_a_retry_work() {
        let gone = reattach_failure_message(&ReattachError::Gone("0123456789ab".into()));
        assert!(gone.contains("0123456789ab") && gone.contains("removed or recreated"));
        assert!(gone.contains("start it again"), "{gone}");

        let stopped = reattach_failure_message(&ReattachError::NotRunning("0123456789ab".into()));
        assert!(stopped.contains("not running") && stopped.ends_with("then Retry"));

        let down = reattach_failure_message(&ReattachError::Unreachable("refused".into()));
        assert!(down.contains("refused") && down.ends_with("then Retry"));
    }
}
