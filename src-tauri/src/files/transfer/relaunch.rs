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
//!
//! # Local folder copies keep their cancel group (#3613)
//!
//! Each large file of a local folder copy (#3605) is its own Transfer Queue
//! row, and cancelling one cancels the folder's rest. The group id is persisted
//! with every row, so after a restart:
//!
//! - resuming a row relaunches it inside its **rebuilt** group (every persisted
//!   row sharing its group id), so cancelling it cancels the siblings — the
//!   relaunched ones through the registry, the ones still waiting as rehydrated
//!   paused rows by pruning their record and moving them to Cancelled;
//! - cancelling a rehydrated row that was never resumed ([`cancel_rehydrated`])
//!   cancels it and its group the same way (a rehydrated row of any kind is now
//!   cancellable, rather than a silent no-op).
//!
//! What the UI shows: the rows stay individual Transfer Queue rows, exactly as
//! before the restart. The folder-level promise the copy's caller awaited
//! (`localCopyStart`) did not survive the restart, so there is no folder-level
//! completion toast afterwards; each row reports its own outcome through the
//! queue's event path, and the group only governs cancellation.

use tauri::{AppHandle, Manager};

use std::sync::Arc;

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
        /// The folder copy's cancel group (#3613), absent for a single file.
        group_id: Option<String>,
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
    Relaunch(Box<PersistedTransfer>),
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
                group_id: record.group_id.clone(),
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
    settled_progress(record, TransferPhase::Error, Some(message))
}

/// The synthetic `cancelled` progress event that moves a rehydrated row with no
/// live handle to Cancelled (#3613). Metadata only, like [`failed_progress`].
fn cancelled_progress(record: &PersistedTransfer) -> TransferProgress {
    settled_progress(record, TransferPhase::Cancelled, None)
}

/// A terminal progress event for a rehydrated row, built from its persisted
/// metadata only.
fn settled_progress(
    record: &PersistedTransfer,
    phase: TransferPhase,
    message: Option<String>,
) -> TransferProgress {
    TransferProgress {
        transfer_id: record.transfer_id.clone(),
        session_id: record.session_id.clone(),
        direction: record.direction,
        file_name: record.file_name.clone(),
        path: record.remote_path.clone(),
        transferred: record.transferred,
        total: record.total,
        phase,
        message,
        state: phase.state_tag(),
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
        Some(record) => ResumeDecision::Relaunch(Box::new(record)),
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
            relaunch_record(*record, registry, manager, app_handle).await
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
            group_id,
        } => {
            let group = group_id.as_deref().and_then(|group_id| {
                let persist = app_handle.try_state::<TransferPersistenceManager>()?;
                rebuild_group(&persist, group_id)
            });
            let spawn_src = src_path.clone();
            let app = app_handle.clone();
            spawn_relaunch(
                &record,
                TransferDirection::Download,
                &src_path,
                total,
                registry,
                app_handle,
                move |handle, registry, sink| async move {
                    run_local_relaunch(
                        spawn_src,
                        dest_path,
                        handle,
                        registry,
                        sink,
                        offset,
                        group,
                        |registry, group, own_id| {
                            if let Some(persist) = app.try_state::<TransferPersistenceManager>() {
                                for sibling in cancel_group_rest(registry, &persist, group, own_id)
                                {
                                    cancel_row(&app, &sibling);
                                }
                            }
                        },
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

/// The cancel group `group_id` rebuilt from the persisted queue (#3613): every
/// still-unfinished row of the folder copy, the relaunching one included.
/// `None` when no row carries it any more.
fn rebuild_group(persist: &TransferPersistenceManager, group_id: &str) -> Option<Arc<[String]>> {
    let members = persist.group_members(group_id);
    (!members.is_empty()).then(|| members.into())
}

/// Run a relaunched local copy from `offset` — inside its rebuilt folder
/// `group` when it has one (#3613).
///
/// A grouped file runs through
/// [`run_local_transfer_in_group`](termihub_core::files::transfer::local_folder::run_local_transfer_in_group),
/// which cancels the siblings that are live again. Siblings still waiting as
/// rehydrated rows have no handle to cancel, so when this file ends cancelled
/// (by the user, not the quit teardown) `cancel_rest` is handed the registry,
/// the group and this file's id to cancel them too.
#[allow(clippy::too_many_arguments)]
async fn run_local_relaunch(
    src: String,
    dest: String,
    handle: Arc<super::registry::TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    offset: u64,
    group: Option<Arc<[String]>>,
    cancel_rest: impl FnOnce(&TransferRegistry, &[String], &str),
) {
    let Some(group) = group else {
        super::local::run_local_transfer(src, dest, handle, registry, sink, offset).await;
        return;
    };
    termihub_core::files::transfer::local_folder::run_local_transfer_in_group(
        src,
        dest,
        handle.clone(),
        registry.clone(),
        sink,
        group.clone(),
        offset,
    )
    .await;
    if handle.state().tag() == TransferStateTag::Cancelled && !super::is_queue_teardown() {
        cancel_rest(&registry, &group, &handle.transfer_id);
    }
}

/// Cancel every row of `group` except `own_id` (#3613): a live one through the
/// registry, a rehydrated one (no live handle) by taking its persisted record so
/// it does not come back on the next launch. Returns the taken records, whose
/// rows the caller moves to Cancelled. Settled rows are already gone from both,
/// so they are skipped.
pub(crate) fn cancel_group_rest(
    registry: &TransferRegistry,
    persist: &TransferPersistenceManager,
    group: &[String],
    own_id: &str,
) -> Vec<PersistedTransfer> {
    let mut taken = Vec::new();
    for id in group.iter().filter(|id| id.as_str() != own_id) {
        if registry.cancel(id) {
            continue;
        }
        if let Some(record) = persist.take_record(id) {
            // A resume racing this cancel may have just registered it.
            registry.cancel(id);
            taken.push(record);
        }
    }
    taken
}

/// Cancel the rehydrated row `transfer_id` (no live handle) and, when it is a
/// file of a local folder copy, the rest of its group (#3613). Returns every
/// taken record whose row must move to Cancelled — empty when `transfer_id` has
/// no persisted record (an unknown or already-finished id).
pub(crate) fn cancel_rehydrated_in(
    transfer_id: &str,
    registry: &TransferRegistry,
    persist: &TransferPersistenceManager,
) -> Vec<PersistedTransfer> {
    let Some(record) = persist.take_record(transfer_id) else {
        return Vec::new();
    };
    // A resume racing this cancel may have just registered it.
    registry.cancel(transfer_id);
    let group = record
        .group_id
        .as_deref()
        .map(|group_id| persist.group_members(group_id))
        .unwrap_or_default();
    let mut cancelled = vec![record];
    cancelled.extend(cancel_group_rest(registry, persist, &group, transfer_id));
    cancelled
}

/// Cancel a rehydrated row with no live handle — pruning its persisted record
/// and moving it (and, for a local folder copy, its group) to Cancelled
/// (#3613). Returns `false` when there is nothing to cancel.
pub(crate) fn cancel_rehydrated(
    transfer_id: &str,
    registry: &TransferRegistry,
    app_handle: &AppHandle,
) -> bool {
    let Some(persist) = app_handle.try_state::<TransferPersistenceManager>() else {
        return false;
    };
    let cancelled = cancel_rehydrated_in(transfer_id, registry, &persist);
    for record in &cancelled {
        cancel_row(app_handle, record);
    }
    !cancelled.is_empty()
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
    fold_row(app_handle, &failed_progress(record, message));
}

/// Move a rehydrated row whose record was already taken to Cancelled (#3613).
fn cancel_row(app_handle: &AppHandle, record: &PersistedTransfer) {
    fold_row(app_handle, &cancelled_progress(record));
}

/// Fold a synthetic progress event through the shared transfers store.
fn fold_row(app_handle: &AppHandle, progress: &TransferProgress) {
    if let Ok(value) = serde_json::to_value(progress) {
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
            group_id: None,
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

    /// A local folder file (#3613) plans its relaunch with its cancel group.
    #[test]
    fn plan_for_a_grouped_local_copy_carries_its_group() {
        let mut rec = record("t3", Some("/backup/data.csv"));
        rec.session_id = crate::files::transfer::local::LOCAL_TRANSFER_SESSION.to_string();
        rec.group_id = Some("folder-1".to_string());
        assert!(matches!(
            plan_from_record(&rec),
            RelaunchPlan::Local { group_id: Some(ref g), .. } if g == "folder-1"
        ));
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
                group_id: None,
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

    // --- local folder cancel groups after a relaunch (#3613) -----------------

    use crate::files::transfer::local::LOCAL_TRANSFER_SESSION;
    use crate::files::transfer::registry::TransferHandle;
    use std::path::Path;

    /// Persist a queued local copy of `src` → `dest` in `group`.
    fn persist_local(persist: &TransferPersistenceManager, id: &str, group: Option<&str>) {
        persist.record_registration(
            id,
            LOCAL_TRANSFER_SESSION,
            TransferDirection::Download,
            "f.bin",
            &format!("/src/{id}"),
            Some(format!("/dest/{id}")),
            8192,
        );
        if let Some(group) = group {
            persist.record_group(id, group);
        }
    }

    /// A source big enough to hold the copy at a chunk boundary while paused.
    fn write_big(path: &Path) {
        let chunk = termihub_core::files::transfer::CHUNK_SIZE;
        std::fs::write(path, vec![7u8; chunk * 4]).expect("write");
    }

    fn quiet_sink() -> ProgressSink {
        Arc::new(|_: &TransferProgress| {})
    }

    async fn wait_for(cond: impl Fn() -> bool) {
        for _ in 0..20_000 {
            if cond() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        panic!("condition not reached");
    }

    /// Relaunch `id` (a paused handle, held at its first chunk) inside `group`,
    /// with the rehydrated-sibling cancel wired to `persist`.
    fn relaunch_in_group(
        dir: &Path,
        id: &str,
        registry: &TransferRegistry,
        persist: &Arc<TransferPersistenceManager>,
        group: Option<Arc<[String]>>,
    ) -> (Arc<TransferHandle>, tokio::task::JoinHandle<Vec<String>>) {
        let src = dir.join(format!("{id}.src"));
        write_big(&src);
        let dest = dir.join(format!("{id}.bin"));
        let handle = registry.enqueue(
            id,
            LOCAL_TRANSFER_SESSION,
            TransferDirection::Download,
            "f.bin",
            &src.to_string_lossy(),
            0,
        );
        assert!(registry.pause(id));
        let (registry, persist, task_handle) = (registry.clone(), persist.clone(), handle.clone());
        let task = tokio::spawn(async move {
            let mut taken = Vec::new();
            run_local_relaunch(
                src.to_string_lossy().into_owned(),
                dest.to_string_lossy().into_owned(),
                task_handle,
                registry,
                quiet_sink(),
                0,
                group,
                |registry, group, own_id| {
                    taken = cancel_group_rest(registry, &persist, group, own_id)
                        .into_iter()
                        .map(|r| r.transfer_id)
                        .collect();
                },
            )
            .await;
            taken
        });
        (handle, task)
    }

    #[test]
    fn relaunch_rebuilds_the_group_from_its_persisted_siblings() {
        let dir = tempfile::TempDir::new().unwrap();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist_local(&persist, "a", Some("folder-1"));
        persist_local(&persist, "b", Some("folder-1"));
        persist_local(&persist, "other", Some("folder-2"));
        persist_local(&persist, "single", None);

        let group = rebuild_group(&persist, "folder-1").expect("group");
        assert_eq!(&*group, &["a".to_string(), "b".to_string()]);
        assert!(rebuild_group(&persist, "gone").is_none());
    }

    /// Both files of a folder resumed after a relaunch: cancelling one cancels
    /// the other.
    #[tokio::test]
    async fn cancelling_one_relaunched_file_cancels_its_relaunched_sibling() {
        let dir = tempfile::TempDir::new().unwrap();
        let persist = Arc::new(TransferPersistenceManager::new_test(dir.path()));
        persist_local(&persist, "a", Some("folder-1"));
        persist_local(&persist, "b", Some("folder-1"));
        let registry = TransferRegistry::new();
        let group = rebuild_group(&persist, "folder-1");

        let (a, task_a) = relaunch_in_group(dir.path(), "a", &registry, &persist, group.clone());
        let (b, task_b) = relaunch_in_group(dir.path(), "b", &registry, &persist, group);
        wait_for(|| {
            [&a, &b]
                .iter()
                .all(|h| h.state().tag() == TransferStateTag::Paused)
        })
        .await;

        assert!(registry.cancel("a"));
        task_a.await.expect("join a");
        task_b.await.expect("join b");

        assert_eq!(a.state().tag(), TransferStateTag::Cancelled);
        assert_eq!(b.state().tag(), TransferStateTag::Cancelled);
    }

    /// One file resumed, its sibling still a rehydrated paused row: cancelling
    /// the resumed one cancels the waiting sibling too (its record is taken so
    /// it does not come back on the next launch). A file of another folder is
    /// left alone.
    #[tokio::test]
    async fn cancelling_a_relaunched_file_cancels_its_still_rehydrated_sibling() {
        let dir = tempfile::TempDir::new().unwrap();
        let persist = Arc::new(TransferPersistenceManager::new_test(dir.path()));
        persist_local(&persist, "a", Some("folder-1"));
        persist_local(&persist, "b", Some("folder-1"));
        persist_local(&persist, "other", Some("folder-2"));
        let registry = TransferRegistry::new();
        let group = rebuild_group(&persist, "folder-1");

        let (a, task_a) = relaunch_in_group(dir.path(), "a", &registry, &persist, group);
        wait_for(|| a.state().tag() == TransferStateTag::Paused).await;
        assert!(registry.cancel("a"));
        let taken = task_a.await.expect("join a");

        assert_eq!(a.state().tag(), TransferStateTag::Cancelled);
        assert_eq!(taken, vec!["b".to_string()]);
        assert!(
            persist.get_record("b").is_none(),
            "b will not rehydrate again"
        );
        assert!(persist.get_record("other").is_some());
    }

    /// A file of a folder that ends normally does not cancel its siblings.
    #[tokio::test]
    async fn a_completed_relaunched_file_leaves_its_siblings_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        let persist = Arc::new(TransferPersistenceManager::new_test(dir.path()));
        persist_local(&persist, "a", Some("folder-1"));
        persist_local(&persist, "b", Some("folder-1"));
        let registry = TransferRegistry::new();
        let group = rebuild_group(&persist, "folder-1");

        let (a, task_a) = relaunch_in_group(dir.path(), "a", &registry, &persist, group);
        wait_for(|| a.state().tag() == TransferStateTag::Paused).await;
        assert!(registry.resume("a"));
        let taken = task_a.await.expect("join a");

        assert_eq!(a.state().tag(), TransferStateTag::Completed);
        assert!(taken.is_empty());
        assert!(persist.get_record("b").is_some());
    }

    /// Cancelling a rehydrated row that was never resumed cancels it and its
    /// folder's rest: a resumed (live) sibling through the registry, a still
    /// rehydrated one by taking its record.
    #[test]
    fn cancelling_a_rehydrated_file_cancels_its_whole_group() {
        let dir = tempfile::TempDir::new().unwrap();
        let persist = TransferPersistenceManager::new_test(dir.path());
        for id in ["a", "b", "c"] {
            persist_local(&persist, id, Some("folder-1"));
        }
        persist_local(&persist, "other", None);
        let registry = TransferRegistry::new();
        let live_b = registry.enqueue(
            "b",
            LOCAL_TRANSFER_SESSION,
            TransferDirection::Download,
            "f.bin",
            "/src/b",
            0,
        );

        let cancelled: Vec<String> = cancel_rehydrated_in("a", &registry, &persist)
            .into_iter()
            .map(|r| r.transfer_id)
            .collect();

        assert_eq!(cancelled, vec!["a".to_string(), "c".to_string()]);
        assert!(live_b.is_cancelled(), "the live sibling is cancelled");
        assert!(persist.get_record("a").is_none());
        assert!(persist.get_record("c").is_none());
        assert!(persist.get_record("other").is_some());
        assert!(
            cancel_rehydrated_in("a", &registry, &persist).is_empty(),
            "an already-cancelled row is a no-op"
        );
    }

    /// An ungrouped rehydrated row cancels on its own; an unknown id is a no-op.
    #[test]
    fn cancelling_an_ungrouped_rehydrated_row_cancels_only_it() {
        let dir = tempfile::TempDir::new().unwrap();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist_local(&persist, "a", None);
        persist_local(&persist, "b", None);
        let registry = TransferRegistry::new();

        assert_eq!(cancel_rehydrated_in("a", &registry, &persist).len(), 1);
        assert!(persist.get_record("b").is_some());
        assert!(cancel_rehydrated_in("ghost", &registry, &persist).is_empty());
    }

    #[test]
    fn cancelled_progress_moves_the_row_to_cancelled() {
        let progress = cancelled_progress(&record("t1", Some("/l")));
        assert_eq!(progress.state, TransferStateTag::Cancelled);
        assert_eq!(progress.phase, TransferPhase::Cancelled);
        assert_eq!(progress.message, None);
    }
}
