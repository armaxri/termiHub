//! Re-attach a queued Docker transfer to its container after an app restart
//! (#3585).
//!
//! A relaunched transfer knows only the **full container id** it streamed
//! from/into — persisted as a non-secret reference. The session that owned it
//! died with the previous app run, so this rebuilds a backend-owned
//! [`DockerTransferTarget`] by asking the container runtime about that exact id.
//!
//! **Identity, not name.** A container recreated under the same name is a
//! different filesystem: resuming a partial against it would splice bytes from
//! two unrelated files. Docker container ids are random 256-bit values that are
//! never reused, so the runtime's answer must carry *exactly* the persisted id —
//! anything else (not found, a different id behind the same reference) is
//! [`ReattachError::Gone`] and the transfer is never resumed there.
//!
//! No credential is involved: the local runtime socket is reached exactly as a
//! Docker session reaches it (Docker CLI endpoint, then the Podman socket).

use tracing::{debug, info};

use super::transfer::DockerTransferTarget;

/// Why a persisted container could not be re-attached for a relaunch.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReattachError {
    /// No container with the persisted id exists any more (removed, or
    /// recreated under the same name with a new id). Never resumable.
    #[error("container {0} no longer exists (it was removed or recreated)")]
    Gone(String),
    /// The container still exists but is stopped; starting it makes the
    /// transfer resumable again.
    #[error("container {0} is not running")]
    NotRunning(String),
    /// No container runtime could be reached to check.
    #[error("container runtime unreachable: {0}")]
    Unreachable(String),
}

/// The short (12-char) form of a container id, for messages.
pub fn short_container_id(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}

/// Decide whether an inspected container is the persisted one and usable.
///
/// Pure: `inspected_id` is the id the runtime returned for the lookup (or
/// `None` when it reported no such container), `running` its state. Only an
/// exact id match counts — a lookup that resolved to another container (e.g.
/// through a name or id-prefix match) is treated as the container being gone.
pub fn check_reattach_identity(
    expected_id: &str,
    inspected_id: Option<&str>,
    running: Option<bool>,
) -> Result<(), ReattachError> {
    let short = short_container_id(expected_id).to_string();
    match inspected_id {
        Some(id) if !expected_id.is_empty() && id == expected_id => {
            if running.unwrap_or(false) {
                Ok(())
            } else {
                Err(ReattachError::NotRunning(short))
            }
        }
        _ => Err(ReattachError::Gone(short)),
    }
}

/// Look `container_id` up on one runtime client.
async fn check_on(client: &bollard::Docker, container_id: &str) -> Result<(), ReattachError> {
    match client.inspect_container(container_id, None).await {
        Ok(info) => {
            let running = info.state.as_ref().and_then(|s| s.running);
            check_reattach_identity(container_id, info.id.as_deref(), running)
        }
        Err(bollard::errors::Error::DockerResponseServerError {
            status_code: 404, ..
        }) => check_reattach_identity(container_id, None, None),
        Err(e) => Err(ReattachError::Unreachable(e.to_string())),
    }
}

/// The runtime clients a persisted container may live on: the Docker CLI
/// endpoint first, then the Podman socket (mirroring the `Auto` runtime).
fn candidate_clients() -> Vec<Result<bollard::Docker, String>> {
    let mut clients = vec![super::connect_docker_endpoint()
        .map(|(client, _)| client)
        .map_err(|e| e.to_string())];
    if let Some(uri) = super::podman_socket_uri() {
        clients.push(super::connect_via_uri(&uri).map_err(|e| e.to_string()));
    }
    clients
}

/// Rebuild a streaming transfer target for the persisted `container_id` on
/// whichever local runtime holds it, verifying its identity first.
///
/// Returns [`ReattachError::Gone`] when a reachable runtime reports no
/// container with that exact id, [`ReattachError::NotRunning`] when it exists
/// but is stopped, and [`ReattachError::Unreachable`] only when no runtime
/// could answer at all.
pub async fn reattach_transfer_target(
    container_id: &str,
) -> Result<DockerTransferTarget, ReattachError> {
    let mut outcome: Option<ReattachError> = None;
    for candidate in candidate_clients() {
        let result = match candidate {
            Ok(client) => match check_on(&client, container_id).await {
                Ok(()) => {
                    info!(
                        container = short_container_id(container_id),
                        "Re-attached Docker transfer target"
                    );
                    return Ok(DockerTransferTarget::new(client, container_id.to_string()));
                }
                Err(e) => e,
            },
            Err(e) => ReattachError::Unreachable(e),
        };
        debug!(container = short_container_id(container_id), error = %result, "Docker re-attach candidate rejected");
        outcome = Some(more_definite(outcome, result));
    }
    Err(outcome.unwrap_or_else(|| {
        ReattachError::Unreachable("no container runtime configured".to_string())
    }))
}

/// Keep the most definite of two rejections: a stopped container outranks a
/// missing one, which outranks an unreachable runtime (another runtime simply
/// may not hold the container).
fn more_definite(prev: Option<ReattachError>, next: ReattachError) -> ReattachError {
    fn rank(e: &ReattachError) -> u8 {
        match e {
            ReattachError::NotRunning(_) => 2,
            ReattachError::Gone(_) => 1,
            ReattachError::Unreachable(_) => 0,
        }
    }
    match prev {
        Some(prev) if rank(&prev) >= rank(&next) => prev,
        _ => next,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn same_running_container_is_accepted() {
        assert_eq!(check_reattach_identity(ID, Some(ID), Some(true)), Ok(()));
    }

    #[test]
    fn a_recreated_container_is_gone_not_resumable() {
        // Same name, new container: the runtime resolves to a different id.
        assert_eq!(
            check_reattach_identity(ID, Some(OTHER), Some(true)),
            Err(ReattachError::Gone("0123456789ab".to_string()))
        );
    }

    #[test]
    fn a_missing_container_is_gone() {
        assert_eq!(
            check_reattach_identity(ID, None, None),
            Err(ReattachError::Gone("0123456789ab".to_string()))
        );
    }

    #[test]
    fn a_stopped_container_is_not_running() {
        assert_eq!(
            check_reattach_identity(ID, Some(ID), Some(false)),
            Err(ReattachError::NotRunning("0123456789ab".to_string()))
        );
        assert_eq!(
            check_reattach_identity(ID, Some(ID), None),
            Err(ReattachError::NotRunning("0123456789ab".to_string()))
        );
    }

    #[test]
    fn an_empty_persisted_id_never_matches() {
        assert!(matches!(
            check_reattach_identity("", Some(""), Some(true)),
            Err(ReattachError::Gone(_))
        ));
    }

    #[test]
    fn the_most_definite_rejection_wins() {
        let gone = ReattachError::Gone("a".into());
        let stopped = ReattachError::NotRunning("a".into());
        let down = ReattachError::Unreachable("x".into());
        assert_eq!(more_definite(Some(down.clone()), gone.clone()), gone);
        assert_eq!(more_definite(Some(gone.clone()), down.clone()), gone);
        assert_eq!(more_definite(Some(gone), stopped.clone()), stopped);
        assert_eq!(more_definite(None, down.clone()), down);
    }

    #[test]
    fn short_id_is_twelve_chars_or_whole() {
        assert_eq!(short_container_id(ID), "0123456789ab");
        assert_eq!(short_container_id("abc"), "abc");
    }
}
