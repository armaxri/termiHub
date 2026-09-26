//! Resume-relaunch of rehydrated transfers (#3199 — the deferred completion of
//! PROD-0011).
//!
//! PROD-0011 made the transfer queue durable: an incomplete transfer is persisted
//! as **metadata only** (id, session *reference*, source/destination paths,
//! direction, resume offset, totals — never credentials) and rehydrates on the
//! next launch as a **paused** row in the shared `transfers` region. But a
//! rehydrated row has **no live [`TransferHandle`], no live session and no
//! credentials**, so the generic `transfer_resume` — which only signals an
//! in-memory handle ([`TransferRegistry::resume`]) — is a no-op for it. This
//! module closes that gap: it makes resuming a rehydrated transfer actually
//! **relaunch** it.
//!
//! # What a relaunch does
//!
//! 1. **Re-attach the session** from the stored session reference via the normal
//!    session path ([`SessionManager::sftp_transfer_browser`]). If the session is
//!    not currently connected, the row moves to a clear **Failed** state
//!    ("session unavailable …") — never a silent drop or a stuck "Resuming…".
//! 2. **Re-source credentials at resume time.** Credentials were deliberately
//!    never persisted (the PROD-0011 invariant); the live SFTP session already
//!    holds the credentials the session machinery sourced from the credential
//!    store at connect time, so re-attaching the session *is* the re-sourcing.
//!    Nothing here ever reads a credential from — or writes one to — the
//!    persisted queue.
//! 3. **Re-spawn the executor from the stored resume offset** ([`run_sftp_transfer`]
//!    with `start_offset = resume_offset`), reusing the existing PROD-0012
//!    byte-verified offset-resume (with automatic restart-from-zero fallback).
//! 4. **Re-enter the scheduler** — the fresh handle starts `Queued` and competes
//!    for a per-session slot exactly like any other transfer.
//!
//! # Live vs rehydrated
//!
//! The single resume entry point ([`resume_or_relaunch`]) handles both: a normal
//! in-memory paused row (a live handle exists → just signal it) and a rehydrated
//! row (no handle → full relaunch). The distinction is made by whether the
//! registry still holds a handle for the id.
//!
//! # Scope
//!
//! **SFTP session** transfers (`session_download` / `session_upload`) relaunch
//! through their session reference, which resolves to a live SFTP browser that
//! carries the credentials. **Docker session** transfers (#3585) relaunch through
//! their persisted full container id instead (the session id does not survive a
//! restart): see [`super::relaunch_docker`] for how the container is re-attached
//! by identity and why a same-name recreated container is never resumed into.
//! Remote-to-remote copies persist only their
//! destination endpoint (the source session/path were never persisted), and FTP
//! transfers carry their credentials inline in a frontend-supplied config that is
//! not persisted and has no credential-store re-sourcing seam yet — both surface
//! an honest Failed state rather than a half-working resume (follow-up tracked
//! separately). Queued **local-disk copies** (PARITY-004, #3567) need no session
//! and always relaunch from their temp file.

use tauri::{AppHandle, Manager};

use super::persist::PersistedTransfer;
use super::persist_manager::TransferPersistenceManager;
use super::registry::TransferRegistry;
use super::state::MAX_RETRIES;
use super::{ProgressSink, TransferDirection, TransferPhase, TransferProgress, TransferStateTag};
use crate::session::manager::SessionManager;

/// How a rehydrated transfer can be relaunched, derived **purely** from its
/// persisted metadata (never credentials).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RelaunchPlan {
    /// An SFTP session download/upload: relaunchable given a live session browser.
    /// Carries only references, paths, the resume offset and totals.
    Sftp {
        session_id: String,
        direction: TransferDirection,
        remote_path: String,
        local_path: String,
        offset: u64,
        total: u64,
    },
    /// A Docker session download/upload (#3585): relaunchable by re-attaching to
    /// the persisted container id. Carries references, paths and progress only.
    Docker {
        session_id: String,
        container_id: String,
        direction: TransferDirection,
        remote_path: String,
        local_path: String,
        offset: u64,
        total: u64,
    },
    /// A queued local-disk copy (PARITY-004, #3567): needs no session at all, so
    /// it always relaunches, continuing from its temp file behind the resume gate.
    Local {
        src_path: String,
        dest_path: String,
        offset: u64,
        total: u64,
    },
    /// The transfer cannot be relaunched from its persisted metadata alone; the
    /// row must move to a Failed state carrying `reason`.
    Unsupported { reason: String },
}

/// The decision the resume entry point takes for a transfer id.
#[derive(Debug)]
pub(crate) enum ResumeDecision {
    /// A live handle exists and accepted the resume signal (normal paused row).
    Signaled,
    /// No live handle, but a rehydrated record was found — relaunch it.
    Relaunch(PersistedTransfer),
    /// No live handle and no rehydrated record: an unknown / finished id (no-op).
    Unknown,
}

/// Derive the relaunch plan for a persisted transfer from its **metadata only**.
///
/// A download or upload persists a `local_path` (the local endpoint) and is
/// relaunchable as an SFTP session transfer — or, when it carries a persisted
/// container identity, as a Docker session transfer (#3585). A record under the
/// reserved local session id is a queued local-disk copy (#3567) and relaunches
/// with no session at all. A remote-to-remote copy persists no
/// local endpoint (`local_path == None`) — and never persisted its *source*
/// session/path — so it cannot be relaunched after a restart.
pub(crate) fn plan_from_record(record: &PersistedTransfer) -> RelaunchPlan {
    match (&record.local_path, &record.docker) {
        (Some(dest_path), None) if record.session_id == super::local::LOCAL_TRANSFER_SESSION => {
            RelaunchPlan::Local {
                src_path: record.remote_path.clone(),
                dest_path: dest_path.clone(),
                offset: record.resume_offset,
                total: record.total,
            }
        }
        (Some(local_path), Some(docker)) => RelaunchPlan::Docker {
            session_id: record.session_id.clone(),
            container_id: docker.container_id.clone(),
            direction: record.direction,
            remote_path: record.remote_path.clone(),
            local_path: local_path.clone(),
            offset: record.resume_offset,
            total: record.total,
        },
        (Some(local_path), None) => RelaunchPlan::Sftp {
            session_id: record.session_id.clone(),
            direction: record.direction,
            remote_path: record.remote_path.clone(),
            local_path: local_path.clone(),
            offset: record.resume_offset,
            total: record.total,
        },
        (None, _) => RelaunchPlan::Unsupported {
            reason: "Cannot resume a remote-to-remote copy after a restart \
                     (the source was not retained)"
                .to_string(),
        },
    }
}

/// Build the synthetic `failed` progress event used to move a rehydrated row to a
/// clear Failed state with an honest message.
///
/// It is assembled from the persisted **metadata only** (id, session reference,
/// paths, byte count) plus the supplied message — it never carries a credential.
/// Fed through the same store fold the transfer engine uses, so the Failed row is
/// indistinguishable from any other failed transfer.
fn failed_progress(record: &PersistedTransfer, message: String) -> TransferProgress {
    TransferProgress {
        transfer_id: record.transfer_id.clone(),
        session_id: record.session_id.clone(),
        direction: record.direction,
        file_name: record.file_name.clone(),
        path: record.remote_path.clone(),
        transferred: record.transferred,
        total: record.total,
        phase: TransferPhase::Error,
        message: Some(message),
        state: TransferStateTag::Failed,
        speed: 0,
        total_bytes: record.total,
        eta_secs: None,
        attempt: 0,
        max_attempts: MAX_RETRIES,
    }
}

/// Decide what a resume of `transfer_id` should do: signal a live handle, relaunch
/// a rehydrated record, or no-op an unknown id.
///
/// Signalling the live handle is a side effect of the `registry.resume` probe: for
/// a normal in-memory paused row this both detects and resumes it in one step.
pub(crate) fn decide_resume(
    transfer_id: &str,
    registry: &TransferRegistry,
    persist: &TransferPersistenceManager,
) -> ResumeDecision {
    if registry.resume(transfer_id) {
        return ResumeDecision::Signaled;
    }
    match persist.get_record(transfer_id) {
        Some(record) => ResumeDecision::Relaunch(record),
        None => ResumeDecision::Unknown,
    }
}

/// Resume a transfer, relaunching it from its persisted checkpoint when it is a
/// rehydrated row with no live handle (#3199).
///
/// Returns `true` when the resume was acted on — a live handle was signalled, a
/// relaunch was spawned, or the row was honestly moved to Failed — and `false`
/// only for a genuinely unknown / already-finished id (a no-op), mirroring the
/// existing `transfer_resume` contract.
pub(crate) async fn resume_or_relaunch(
    transfer_id: &str,
    registry: &TransferRegistry,
    manager: &SessionManager,
    app_handle: &AppHandle,
) -> bool {
    let Some(persist) = app_handle.try_state::<TransferPersistenceManager>() else {
        // No durable queue this run: only a live handle can be resumed.
        return registry.resume(transfer_id);
    };
    match decide_resume(transfer_id, registry, &persist) {
        ResumeDecision::Signaled => true,
        ResumeDecision::Unknown => false,
        ResumeDecision::Relaunch(record) => {
            relaunch_record(record, registry, manager, app_handle).await
        }
    }
}

/// Relaunch a rehydrated transfer from its persisted record. Always returns `true`
/// (it always produces a visible outcome — a spawned executor or a Failed row).
async fn relaunch_record(
    record: PersistedTransfer,
    registry: &TransferRegistry,
    manager: &SessionManager,
    app_handle: &AppHandle,
) -> bool {
    match plan_from_record(&record) {
        RelaunchPlan::Sftp {
            session_id,
            direction,
            remote_path,
            local_path,
            offset,
            total,
        } => {
            // Re-attach the session (and, transitively, its credentials) through
            // the normal session path. A not-connected session errors here → the
            // row moves to a clear Failed state rather than hanging.
            match manager.sftp_transfer_browser(&session_id).await {
                Ok(browser) => {
                    let (spawn_remote, spawn_local) = (remote_path.clone(), local_path);
                    spawn_relaunch(
                        &record,
                        direction,
                        &remote_path,
                        total,
                        registry,
                        app_handle,
                        move |handle, registry, sink| async move {
                            super::sftp::run_sftp_transfer(
                                browser,
                                direction,
                                spawn_remote,
                                spawn_local,
                                handle,
                                registry,
                                sink,
                                super::sftp::DEFAULT_RESUME_MODE,
                                offset,
                            )
                            .await;
                        },
                    );
                    true
                }
                Err(e) => {
                    fail_row(
                        app_handle,
                        &record,
                        format!("Cannot resume: session unavailable ({e})"),
                    );
                    true
                }
            }
        }
        RelaunchPlan::Docker {
            session_id,
            container_id,
            direction,
            remote_path,
            local_path,
            offset,
            total,
        } => {
            // Re-attach by the persisted container id (never by name). A gone,
            // stopped or unreachable container fails the row with a message that
            // says what makes a Retry work.
            match super::relaunch_docker::resolve_docker_target(manager, &session_id, &container_id)
                .await
            {
                Ok(target) => {
                    let (spawn_remote, spawn_local) = (remote_path.clone(), local_path);
                    spawn_relaunch(
                        &record,
                        direction,
                        &remote_path,
                        total,
                        registry,
                        app_handle,
                        move |handle, registry, sink| async move {
                            super::docker::run_docker_transfer(
                                target,
                                direction,
                                spawn_remote,
                                spawn_local,
                                handle,
                                registry,
                                sink,
                                offset,
                            )
                            .await;
                        },
                    );
                    true
                }
                Err(message) => {
                    fail_row(app_handle, &record, message);
                    true
                }
            }
        }
        RelaunchPlan::Local {
            src_path,
            dest_path,
            offset,
            total,
        } => {
            let spawn_src = src_path.clone();
            spawn_relaunch(
                &record,
                TransferDirection::Download,
                &src_path,
                total,
                registry,
                app_handle,
                move |handle, registry, sink| async move {
                    super::local::run_local_transfer(
                        spawn_src, dest_path, handle, registry, sink, offset,
                    )
                    .await;
                },
            );
            true
        }
        RelaunchPlan::Unsupported { reason } => {
            fail_row(app_handle, &record, reason);
            true
        }
    }
}

/// Re-enqueue a rehydrated transfer and spawn its executor (`run`), which
/// resumes from the persisted offset. Race-safe:
/// [`TransferRegistry::enqueue_if_absent`] means two concurrent resume clicks
/// never spawn two executors for the same file — a losing caller just signals
/// the now-present handle.
fn spawn_relaunch<F, Fut>(
    record: &PersistedTransfer,
    direction: TransferDirection,
    remote_path: &str,
    total: u64,
    registry: &TransferRegistry,
    app_handle: &AppHandle,
    run: F,
) where
    F: FnOnce(
        std::sync::Arc<super::registry::TransferHandle>,
        TransferRegistry,
        ProgressSink,
    ) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let Some(handle) = registry.enqueue_if_absent(
        &record.transfer_id,
        &record.session_id,
        direction,
        &record.file_name,
        remote_path,
        total,
    ) else {
        // Already registered concurrently (another resume won the race): just
        // signal the existing handle instead of spawning a duplicate executor.
        registry.resume(&record.transfer_id);
        return;
    };

    let sink = super::app_progress_sink(app_handle.clone());
    tauri::async_runtime::spawn(run(handle, registry.clone(), sink));
}

/// Move a rehydrated row to a clear Failed state with an honest message, folding a
/// synthetic `failed` progress event through the shared transfers store (so every
/// subscriber sees the diff). The persisted record is left intact so the user can
/// reconnect the session and retry.
fn fail_row(app_handle: &AppHandle, record: &PersistedTransfer, message: String) {
    let progress = failed_progress(record, message);
    if let Ok(value) = serde_json::to_value(&progress) {
        crate::transfers_projection::projection::fold_transfer_progress(app_handle, &value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::transfer::persist::PersistedTransferStatus;

    fn record(id: &str, local_path: Option<&str>) -> PersistedTransfer {
        PersistedTransfer {
            transfer_id: id.to_string(),
            session_id: "sess-a".to_string(),
            direction: TransferDirection::Download,
            file_name: "data.csv".to_string(),
            remote_path: "/remote/data.csv".to_string(),
            local_path: local_path.map(str::to_string),
            status: PersistedTransferStatus::Paused,
            transferred: 4096,
            total: 8192,
            resume_offset: 4096,
            created_at_ms: 1_000,
            updated_at_ms: 2_000,
            docker: None,
        }
    }

    fn docker_record(id: &str, local_path: Option<&str>) -> PersistedTransfer {
        PersistedTransfer {
            docker: Some(crate::files::transfer::persist::PersistedDockerTarget {
                container_id: "c0ffee".repeat(10),
            }),
            ..record(id, local_path)
        }
    }

    #[test]
    fn plan_for_a_download_or_upload_is_relaunchable_from_the_offset() {
        let plan = plan_from_record(&record("t1", Some("/home/user/data.csv")));
        assert_eq!(
            plan,
            RelaunchPlan::Sftp {
                session_id: "sess-a".to_string(),
                direction: TransferDirection::Download,
                remote_path: "/remote/data.csv".to_string(),
                local_path: "/home/user/data.csv".to_string(),
                offset: 4096,
                total: 8192,
            },
            "the relaunch plan resumes from the persisted checkpoint offset"
        );
    }

    /// A Docker record (#3585) relaunches by its persisted container id — not
    /// through the SFTP path, which a Docker session can never satisfy — and
    /// from the persisted checkpoint (the executor's gate still verifies it).
    #[test]
    fn plan_for_a_docker_transfer_reattaches_by_container_id() {
        let plan = plan_from_record(&docker_record("t1", Some("/home/user/data.csv")));
        assert_eq!(
            plan,
            RelaunchPlan::Docker {
                session_id: "sess-a".to_string(),
                container_id: "c0ffee".repeat(10),
                direction: TransferDirection::Download,
                remote_path: "/remote/data.csv".to_string(),
                local_path: "/home/user/data.csv".to_string(),
                offset: 4096,
                total: 8192,
            }
        );
    }

    #[test]
    fn plan_for_a_docker_record_without_a_local_endpoint_is_unsupported() {
        assert!(matches!(
            plan_from_record(&docker_record("t1", None)),
            RelaunchPlan::Unsupported { .. }
        ));
    }

    /// A Docker record keeps its container identity through the persisted
    /// queue, so a resume after restart plans a Docker relaunch.
    #[test]
    fn decide_resume_relaunches_a_rehydrated_docker_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist.record_registration(
            "docker-t",
            "sess-a",
            TransferDirection::Upload,
            "data.csv",
            "/remote/data.csv",
            Some("/home/user/data.csv".to_string()),
            8192,
        );
        persist.record_docker_target("docker-t", "abc123");

        match decide_resume("docker-t", &registry, &persist) {
            ResumeDecision::Relaunch(rec) => assert!(matches!(
                plan_from_record(&rec),
                RelaunchPlan::Docker { ref container_id, .. } if container_id == "abc123"
            )),
            other => panic!("expected Relaunch, got {other:?}"),
        }
    }

    #[test]
    fn plan_for_a_local_copy_relaunches_without_a_session() {
        let mut rec = record("t3", Some("/backup/data.csv"));
        rec.session_id = crate::files::transfer::local::LOCAL_TRANSFER_SESSION.to_string();
        rec.remote_path = "/home/user/data.csv".to_string();
        assert_eq!(
            plan_from_record(&rec),
            RelaunchPlan::Local {
                src_path: "/home/user/data.csv".to_string(),
                dest_path: "/backup/data.csv".to_string(),
                offset: 4096,
                total: 8192,
            }
        );
    }

    #[test]
    fn plan_for_a_remote_to_remote_copy_is_unsupported() {
        // A remote→remote copy persists no local endpoint and never persisted its
        // source, so it cannot relaunch — it must Fail honestly, not hang.
        match plan_from_record(&record("t1", None)) {
            RelaunchPlan::Unsupported { reason } => {
                assert!(
                    reason.contains("remote-to-remote"),
                    "honest reason: {reason}"
                );
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    /// SECURITY (PROD-0011 invariant): the Failed event built during a relaunch is
    /// assembled from metadata only and must never carry a credential field.
    #[test]
    fn failed_progress_carries_no_credential_fields() {
        let progress = failed_progress(&record("t1", Some("/l")), "session unavailable".into());
        let value = serde_json::to_value(&progress).unwrap();
        let obj = value.as_object().unwrap();

        assert_eq!(obj.get("state").and_then(|v| v.as_str()), Some("failed"));
        assert_eq!(
            obj.get("message").and_then(|v| v.as_str()),
            Some("session unavailable"),
            "the failure reason is surfaced honestly"
        );
        for forbidden in [
            "password",
            "passphrase",
            "secret",
            "credential",
            "credentials",
            "privateKey",
            "private_key",
            "key",
            "token",
            "config",
            "auth",
        ] {
            assert!(
                !obj.contains_key(forbidden),
                "the relaunch Failed event must not carry a `{forbidden}` field"
            );
        }
        let json = serde_json::to_string(&progress).unwrap().to_lowercase();
        for needle in ["password", "passphrase", "secret", "privatekey"] {
            assert!(
                !json.contains(needle),
                "the Failed event leaked a `{needle}`"
            );
        }
    }

    #[test]
    fn decide_resume_signals_a_live_handle() {
        // A normal in-memory paused row: a live handle exists, so resume signals it
        // rather than relaunching.
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        registry.enqueue(
            "live",
            "sess-a",
            TransferDirection::Download,
            "f",
            "/remote/f",
            100,
        );

        assert!(matches!(
            decide_resume("live", &registry, &persist),
            ResumeDecision::Signaled
        ));
    }

    #[test]
    fn decide_resume_relaunches_a_rehydrated_record() {
        // No live handle, but a persisted record exists → relaunch it.
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist.record_registration(
            "rehydrated",
            "sess-a",
            TransferDirection::Download,
            "data.csv",
            "/remote/data.csv",
            Some("/home/user/data.csv".to_string()),
            8192,
        );

        match decide_resume("rehydrated", &registry, &persist) {
            ResumeDecision::Relaunch(rec) => {
                assert_eq!(rec.transfer_id, "rehydrated");
                assert_eq!(rec.session_id, "sess-a");
                assert_eq!(rec.local_path.as_deref(), Some("/home/user/data.csv"));
            }
            other => panic!("expected Relaunch, got {other:?}"),
        }
    }

    #[test]
    fn decide_resume_is_unknown_for_an_unregistered_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        assert!(matches!(
            decide_resume("ghost", &registry, &persist),
            ResumeDecision::Unknown
        ));
    }
}
