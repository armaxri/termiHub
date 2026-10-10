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
//!    session path ([`SessionManager::sftp_transfer_browser`]). When that session
//!    is gone (after a restart it always is), the record's saved-connection id
//!    finds a session the user reopened for the same connection (#3876).
//! 2. **Re-source credentials at resume time.** Credentials were deliberately
//!    never persisted (the PROD-0011 invariant); a live session already holds
//!    the credentials the session machinery sourced from the credential store
//!    at connect time, so re-attaching the session *is* the re-sourcing. With
//!    no live session, the saved connection's password or key passphrase is
//!    read from the **unlocked** store under its existing key and the
//!    connection is opened unattended (#3876, see
//!    [`super::relaunch_credentials`]). A relaunch never prompts: a locked
//!    store or a secret that is not stored keeps the row **paused** with the
//!    reason "Needs credentials — open the connection to resume"; any other
//!    failure moves it to a clear **Failed** state — never a silent drop or a
//!    stuck "Resuming…". Nothing here ever reads a credential from — or writes
//!    one to — the persisted queue.
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
//! **SFTP and FTP session** transfers (`session_download` / `session_upload`)
//! relaunch through their session reference,
//! which resolves to the live session's SFTP browser or FTP connection settings
//! — the credentials come from the live session, never from the persisted queue
//! (see [`super::relaunch_session`]). **Remote-to-remote copies** (PROD-0013)
//! persist their source endpoint too (#3206) and relaunch by re-attaching both
//! sessions; one persisted before that kept only its destination and fails
//! honestly. **Docker session** transfers (#3585) relaunch through
//! their persisted full container id instead (the session id does not survive a
//! restart): see [`super::relaunch_docker`] for how the container is re-attached
//! by identity and why a same-name recreated container is never resumed into.
//! **Agent-hosted** transfers (#4114) relaunch through their persisted agent
//! session identity — the same agent-side session, or one reopened from the
//! same saved definition on the same agent — and wait, paused, until the agent
//! is reconnected: see [`super::relaunch_agent`].
//! **Graphical side-channel** transfers of a VNC session (#4205) relaunch
//! through their persisted side-channel identity — a session of the same saved
//! VNC connection whose channel still reaches the same file host — and wait,
//! paused, until that connection is reopened: see [`super::relaunch_graphical`].
//! Queued **local-disk copies** (PARITY-004, #3567) need no session
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

use super::persist::{PersistedAgentTarget, PersistedGraphicalTarget, PersistedTransfer};
use super::persist_manager::TransferPersistenceManager;
use super::registry::TransferRegistry;
use super::relaunch_credentials::RelaunchBlocked;
use super::state::MAX_RETRIES;
use super::{ProgressSink, TransferDirection, TransferPhase, TransferProgress, TransferStateTag};
use crate::session::manager::SessionManager;

/// How a rehydrated transfer can be relaunched, derived **purely** from its
/// persisted metadata (never credentials).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RelaunchPlan {
    /// A session download/upload over SFTP or FTP (#3206): relaunchable given
    /// the live session behind `session_id`. Carries only references, paths,
    /// the resume offset and totals.
    Session {
        session_id: String,
        /// The saved connection the session was opened for (#3876), used when
        /// the session is gone.
        saved_connection_id: Option<String>,
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
    /// An agent-hosted session download/upload (#4114): relaunchable over the
    /// live agent session matching the persisted identity — the same
    /// agent-side session, or one reopened from the same saved definition on
    /// the same agent. Carries ids, paths and progress only.
    Agent {
        session_id: String,
        agent: PersistedAgentTarget,
        direction: TransferDirection,
        remote_path: String,
        local_path: String,
        offset: u64,
        total: u64,
    },
    /// A graphical (VNC) session's side-channel download/upload (#4205):
    /// relaunchable over a live graphical session of the same saved
    /// connection whose side channel still reaches the same file host by the
    /// same route. Carries ids, paths and progress only.
    Graphical {
        target: PersistedGraphicalTarget,
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
    /// A remote-to-remote copy (PROD-0013) that persisted its source endpoint
    /// (#3206): relaunchable given both ends. An end with a persisted container
    /// id is a Docker session re-attached by that id (#3586), an end with a
    /// persisted agent identity is the matching live agent-hosted session
    /// (#4115); any other end is an SFTP session.
    RemoteCopy {
        src_session_id: String,
        src_saved_connection_id: Option<String>,
        src_container_id: Option<String>,
        src_agent: Option<PersistedAgentTarget>,
        src_path: String,
        dst_session_id: String,
        dst_saved_connection_id: Option<String>,
        dst_container_id: Option<String>,
        dst_agent: Option<PersistedAgentTarget>,
        dst_path: String,
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
    Relaunch(Box<PersistedTransfer>),
    /// No live handle and no rehydrated record: an unknown / finished id (no-op).
    Unknown,
}

/// Derive the relaunch plan for a persisted transfer from its **metadata only**.
///
/// A download or upload persists a `local_path` (the local endpoint) and is
/// relaunchable as an SFTP or FTP session transfer — or, when it carries a
/// persisted container identity, as a Docker session transfer (#3585), and when
/// it carries a persisted agent session identity, as an agent-hosted ranged
/// transfer (#4114). A record
/// under the reserved local session id is a queued local-disk copy (#3567) and
/// relaunches with no session at all. A remote-to-remote copy persists no local
/// endpoint (`local_path == None`); it relaunches from its persisted source
/// endpoint (#3206), and one persisted before that (no source) cannot be
/// relaunched after a restart.
pub(crate) fn plan_from_record(record: &PersistedTransfer) -> RelaunchPlan {
    // A graphical session's side-channel download/upload (#4205) re-attaches
    // through a session of its saved VNC connection, never by session id.
    if let (Some(local_path), Some(target)) = (&record.local_path, &record.graphical) {
        return RelaunchPlan::Graphical {
            target: target.clone(),
            direction: record.direction,
            remote_path: record.remote_path.clone(),
            local_path: local_path.clone(),
            offset: record.resume_offset,
            total: record.total,
        };
    }
    // An agent-hosted download/upload (#4114) re-attaches by its session
    // identity, not through the SFTP/FTP session path.
    if let (Some(local_path), None, Some(agent)) =
        (&record.local_path, &record.docker, &record.agent)
    {
        return RelaunchPlan::Agent {
            session_id: record.session_id.clone(),
            agent: agent.clone(),
            direction: record.direction,
            remote_path: record.remote_path.clone(),
            local_path: local_path.clone(),
            offset: record.resume_offset,
            total: record.total,
        };
    }
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
        (Some(local_path), None) => RelaunchPlan::Session {
            session_id: record.session_id.clone(),
            saved_connection_id: record.saved_connection_id.clone(),
            direction: record.direction,
            remote_path: record.remote_path.clone(),
            local_path: local_path.clone(),
            offset: record.resume_offset,
            total: record.total,
        },
        (None, _) => match &record.remote_source {
            Some(source) => RelaunchPlan::RemoteCopy {
                src_session_id: source.session_id.clone(),
                src_saved_connection_id: source.saved_connection_id.clone(),
                src_container_id: source.container_id.clone(),
                src_agent: source.agent.clone(),
                src_path: source.path.clone(),
                dst_session_id: record.session_id.clone(),
                dst_saved_connection_id: record.saved_connection_id.clone(),
                dst_container_id: record.docker.as_ref().map(|d| d.container_id.clone()),
                dst_agent: record.agent.clone(),
                dst_path: record.remote_path.clone(),
                offset: record.resume_offset,
                total: record.total,
            },
            None => RelaunchPlan::Unsupported {
                reason: "Cannot resume a remote-to-remote copy after a restart \
                         (the source was not retained)"
                    .to_string(),
            },
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

/// The synthetic event that keeps a rehydrated row **paused** with `reason`
/// (#3876): its secret cannot be re-sourced without the user. Metadata only,
/// like [`failed_progress`]; the progress so far is kept.
fn paused_progress(record: &PersistedTransfer, reason: String) -> TransferProgress {
    TransferProgress {
        state: TransferStateTag::Paused,
        ..settled_progress(record, TransferPhase::Transferring, Some(reason))
    }
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
    // A resume by the user, or by a trigger (#3883): either way the row stops
    // waiting for credentials. A relaunch blocked again puts it back.
    persist.credential_waits().forget(transfer_id);
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
        RelaunchPlan::Session {
            session_id,
            saved_connection_id,
            direction,
            remote_path,
            local_path,
            offset,
            total,
        } => {
            // Re-attach the session (and, transitively, its credentials) through
            // the normal session path — or, when it is gone, the saved connection
            // it was opened for (#3876). A secret that cannot be re-sourced
            // unattended keeps the row paused with a reason; any other failure
            // moves it to a clear Failed state rather than hanging.
            let sources = sources(manager, app_handle);
            match super::relaunch_session::resolve_session_target(
                &sources,
                &session_id,
                saved_connection_id.as_deref(),
            )
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
                        move |handle, registry, sink| {
                            super::relaunch_session::run_session_target(
                                target,
                                direction,
                                spawn_remote,
                                spawn_local,
                                handle,
                                registry,
                                sink,
                                offset,
                            )
                        },
                    );
                    true
                }
                Err(blocked) => {
                    block_row(app_handle, &record, blocked);
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
        RelaunchPlan::Agent {
            session_id: _,
            agent,
            direction,
            remote_path,
            local_path,
            offset,
            total,
        } => {
            // Find the live agent session by the persisted identity (the
            // desktop session id did not survive the restart). None yet keeps
            // the row paused until the agent is reconnected (#4114).
            match super::relaunch_agent::resolve_live_agent_target(manager, &agent).await {
                Ok(proxy) => {
                    let (spawn_remote, spawn_local) = (remote_path.clone(), local_path);
                    spawn_relaunch(
                        &record,
                        direction,
                        &remote_path,
                        total,
                        registry,
                        app_handle,
                        move |handle, registry, sink| async move {
                            termihub_core::files::transfer::ranged::run_ranged_transfer(
                                proxy,
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
                Err(blocked) => {
                    block_row(app_handle, &record, blocked);
                    true
                }
            }
        }
        RelaunchPlan::Graphical {
            target,
            direction,
            remote_path,
            local_path,
            offset,
            total,
        } => {
            // Find a session of the saved VNC connection whose side channel
            // still leads to the same file host. None yet keeps the row
            // paused until the connection is reopened (#4205).
            match super::relaunch_graphical::resolve_live_graphical_target(app_handle, &target)
                .await
            {
                Ok((graphical_session_id, carrier)) => {
                    // Queue it under the live graphical session, so closing
                    // that session cancels it like its other uploads.
                    let live_record = PersistedTransfer {
                        session_id: graphical_session_id,
                        ..record.clone()
                    };
                    let spawn_remote = remote_path.clone();
                    spawn_relaunch(
                        &live_record,
                        direction,
                        &remote_path,
                        total,
                        registry,
                        app_handle,
                        move |handle, registry, sink| {
                            run_side_channel_transfer(
                                carrier,
                                direction,
                                spawn_remote,
                                local_path,
                                handle,
                                registry,
                                sink,
                                offset,
                            )
                        },
                    );
                    true
                }
                Err(blocked) => {
                    block_row(app_handle, &record, blocked);
                    true
                }
            }
        }
        RelaunchPlan::RemoteCopy {
            src_session_id,
            src_saved_connection_id,
            src_container_id,
            src_agent,
            src_path,
            dst_session_id,
            dst_saved_connection_id,
            dst_container_id,
            dst_agent,
            dst_path,
            offset,
            total,
        } => {
            // Re-attach both ends; either one unavailable fails the row, or keeps
            // it paused when only a secret is missing (the record is kept, so a
            // Resume/Retry after reconnecting relaunches it).
            use super::relaunch_session::CopyEnd;
            let sources = sources(manager, app_handle);
            match super::relaunch_session::resolve_remote_copy(
                &sources,
                CopyEnd {
                    session_id: &src_session_id,
                    saved_connection_id: src_saved_connection_id.as_deref(),
                    container_id: src_container_id.as_deref(),
                    agent: src_agent.as_ref(),
                },
                CopyEnd {
                    session_id: &dst_session_id,
                    saved_connection_id: dst_saved_connection_id.as_deref(),
                    container_id: dst_container_id.as_deref(),
                    agent: dst_agent.as_ref(),
                },
            )
            .await
            {
                Ok((src_end, dst_end)) => {
                    let spawn_dst = dst_path.clone();
                    spawn_relaunch(
                        &record,
                        TransferDirection::Upload,
                        &dst_path,
                        total,
                        registry,
                        app_handle,
                        move |handle, registry, sink| {
                            super::remote_copy::run_remote_copy(
                                src_end,
                                dst_end,
                                src_path,
                                spawn_dst,
                                handle,
                                registry,
                                sink,
                                super::remote_copy::DEFAULT_RESUME_MODE,
                                offset,
                            )
                        },
                    );
                    true
                }
                Err(blocked) => {
                    block_row(app_handle, &record, blocked);
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

/// Run a side-channel transfer over `carrier` from `offset` (#4205): SFTP on
/// the VNC tunnel's session, or ranged slices over the hosting agent. Either
/// executor's resume gate re-verifies the destination (and the source
/// fingerprint) before appending, and restarts from zero when it does not
/// match.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_side_channel_transfer(
    carrier: crate::session::graphical_upload::UploadCarrier,
    direction: TransferDirection,
    remote_path: String,
    local_path: String,
    handle: Arc<super::registry::TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    offset: u64,
) {
    use crate::session::graphical_upload::UploadCarrier;
    match carrier {
        UploadCarrier::Sftp(browser) => {
            super::sftp::run_sftp_transfer(
                browser,
                direction,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
                super::sftp::DEFAULT_RESUME_MODE,
                offset,
            )
            .await;
        }
        UploadCarrier::Agent(files) => {
            termihub_core::files::transfer::ranged::run_ranged_transfer(
                files,
                direction,
                remote_path,
                local_path,
                handle,
                registry,
                sink,
                offset,
            )
            .await;
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
    if handle.state().tag() == TransferStateTag::Cancelled && !registry.is_queue_teardown() {
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
    // Seed the persisted source mtime (#3572): the executor compares it (with
    // the persisted total) against the source it finds, so a source rewritten
    // to the same size while the app was closed restarts from zero.
    handle.set_source_mtime(record.source_mtime);

    let sink = super::app_progress_sink(app_handle.clone());
    // Not app-owned (#3105): a transfer; cancelled explicitly via `TransferRegistry::cancel_all`.
    tauri::async_runtime::spawn(run(handle, registry.clone(), sink));
}

/// The running app's live sessions, saved connections and credential store,
/// for re-sourcing a relaunched transfer's connection (#3876).
fn sources<'a>(
    manager: &'a SessionManager,
    app_handle: &'a AppHandle,
) -> super::relaunch_session::AppSources<'a> {
    super::relaunch_session::AppSources {
        manager,
        connections: app_handle
            .try_state::<crate::connection::manager::ConnectionManager>()
            .map(|state| state.inner()),
    }
}

/// Settle a rehydrated row a relaunch could not start (#3876): keep it paused
/// with the reason when only its credentials are missing, otherwise fail it
/// with the message. The persisted record is left intact either way.
fn block_row(app_handle: &AppHandle, record: &PersistedTransfer, blocked: RelaunchBlocked) {
    match blocked {
        RelaunchBlocked::NeedsCredentials
        | RelaunchBlocked::AgentSessionUnavailable
        | RelaunchBlocked::GraphicalSessionUnavailable => {
            // Resume by itself once the connection opens or the store unlocks
            // (#3883) — or, for an agent-hosted transfer, once a matching
            // agent session opens (#4114), and for a graphical side-channel
            // transfer once a session of its VNC connection is active (#4205).
            if let Some(persist) = app_handle.try_state::<TransferPersistenceManager>() {
                super::relaunch_auto::note_blocked(persist.credential_waits(), record, &blocked);
            }
            fold_row(app_handle, &paused_progress(record, blocked.message()));
        }
        RelaunchBlocked::Failed(message) => fail_row(app_handle, record, message),
    }
}

/// Move a rehydrated row to a clear Failed state with an honest message, folding a
/// synthetic `failed` progress event through the shared transfers store (so every
/// subscriber sees the diff). The persisted record is left intact so the user can
/// reconnect the session and retry.
fn fail_row<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    record: &PersistedTransfer,
    message: String,
) {
    fold_row(app_handle, &failed_progress(record, message));
}

/// Move a rehydrated row whose record was already taken to Cancelled (#3613).
fn cancel_row<R: tauri::Runtime>(app_handle: &AppHandle<R>, record: &PersistedTransfer) {
    fold_row(app_handle, &cancelled_progress(record));
}

/// Fold a synthetic progress event through the shared transfers store.
fn fold_row<R: tauri::Runtime>(app_handle: &AppHandle<R>, progress: &TransferProgress) {
    crate::transfers_projection::projection::fold_transfer_progress(app_handle, progress);
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
            folder_paste_id: None,
            source_mtime: None,
            remote_source: None,
            saved_connection_id: None,
            agent: None,
            graphical: None,
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
        let mut rec = record("t1", Some("/home/user/data.csv"));
        rec.saved_connection_id = Some("Work/files".to_string());
        let plan = plan_from_record(&rec);
        assert_eq!(
            plan,
            RelaunchPlan::Session {
                session_id: "sess-a".to_string(),
                saved_connection_id: Some("Work/files".to_string()),
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
    /// through the SFTP/FTP session path, which a Docker session can never satisfy — and
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

    /// An agent-hosted record (#4114) relaunches by its agent session
    /// identity — not through the SFTP/FTP session path — from the persisted
    /// checkpoint.
    #[test]
    fn plan_for_an_agent_transfer_reattaches_by_agent_identity() {
        let agent = crate::files::transfer::persist::PersistedAgentTarget {
            agent_id: "agent-1".to_string(),
            remote_session_id: "remote-1".to_string(),
            definition_id: Some("def-a".to_string()),
        };
        let mut rec = record("t1", Some("/home/user/data.csv"));
        rec.agent = Some(agent.clone());
        assert_eq!(
            plan_from_record(&rec),
            RelaunchPlan::Agent {
                session_id: "sess-a".to_string(),
                agent,
                direction: TransferDirection::Download,
                remote_path: "/remote/data.csv".to_string(),
                local_path: "/home/user/data.csv".to_string(),
                offset: 4096,
                total: 8192,
            }
        );
    }

    /// A graphical side-channel record (#4205) relaunches through its VNC
    /// identity — even when it also names a saved connection or agent — and
    /// from the persisted checkpoint.
    #[test]
    fn plan_for_a_side_channel_transfer_reattaches_by_its_vnc_identity() {
        let target = crate::files::transfer::persist::PersistedGraphicalTarget {
            connection_id: "Lab/pi-desktop".to_string(),
            route: termihub_core::connection::FileSideChannelKind::Ssh,
            host: "lab-pi".to_string(),
            user: "pi".to_string(),
            agent_id: None,
        };
        let mut rec = record("t1", Some("/home/user/big.bin"));
        rec.direction = TransferDirection::Upload;
        rec.saved_connection_id = Some("Lab/pi-desktop".to_string());
        rec.graphical = Some(target.clone());
        assert_eq!(
            plan_from_record(&rec),
            RelaunchPlan::Graphical {
                target,
                direction: TransferDirection::Upload,
                remote_path: "/remote/data.csv".to_string(),
                local_path: "/home/user/big.bin".to_string(),
                offset: 4096,
                total: 8192,
            }
        );
    }

    /// A side-channel upload keeps its identity through the persisted queue,
    /// so a resume after a restart plans a graphical relaunch.
    #[test]
    fn decide_resume_relaunches_a_rehydrated_side_channel_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist.record_registration(
            "vnc-t",
            "rd-old",
            TransferDirection::Upload,
            "big.bin",
            "/home/pi/Desktop/big.bin",
            Some("/home/user/big.bin".to_string()),
            0,
        );
        persist.record_graphical_target(
            "vnc-t",
            crate::files::transfer::persist::PersistedGraphicalTarget {
                connection_id: "Lab/pi-desktop".to_string(),
                route: termihub_core::connection::FileSideChannelKind::Agent,
                host: "lab-pi".to_string(),
                user: "pi".to_string(),
                agent_id: Some("agent-1".to_string()),
            },
        );
        match decide_resume("vnc-t", &registry, &persist) {
            ResumeDecision::Relaunch(rec) => assert!(matches!(
                plan_from_record(&rec),
                RelaunchPlan::Graphical { .. }
            )),
            other => panic!("expected Relaunch, got {other:?}"),
        }
    }

    /// An agent-hosted record keeps its identity through the persisted queue,
    /// so a resume after a restart plans an agent relaunch.
    #[test]
    fn decide_resume_relaunches_a_rehydrated_agent_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist.record_registration(
            "agent-t",
            "sess-a",
            TransferDirection::Download,
            "data.csv",
            "/remote/data.csv",
            Some("/home/user/data.csv".to_string()),
            8192,
        );
        persist.record_agent_target(
            "agent-t",
            crate::files::transfer::persist::PersistedAgentTarget {
                agent_id: "agent-1".to_string(),
                remote_session_id: "remote-1".to_string(),
                definition_id: None,
            },
        );
        match decide_resume("agent-t", &registry, &persist) {
            ResumeDecision::Relaunch(rec) => assert!(matches!(
                plan_from_record(&rec),
                RelaunchPlan::Agent { ref agent, .. } if agent.agent_id == "agent-1"
            )),
            other => panic!("expected Relaunch, got {other:?}"),
        }
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

    /// A remote-to-remote copy that persisted its source endpoint (#3206)
    /// relaunches from both sessions, from the persisted checkpoint.
    #[test]
    fn plan_for_a_remote_to_remote_copy_relaunches_from_both_endpoints() {
        let mut rec = record("r2r", None);
        rec.session_id = "sess-dst".to_string();
        rec.remote_path = "/dst/data.csv".to_string();
        rec.remote_source = Some(crate::files::transfer::persist::PersistedRemoteSource {
            session_id: "sess-src".to_string(),
            path: "/src/data.csv".to_string(),
            saved_connection_id: Some("conn-src".to_string()),
            container_id: None,
            agent: None,
        });
        rec.saved_connection_id = Some("conn-dst".to_string());
        assert_eq!(
            plan_from_record(&rec),
            RelaunchPlan::RemoteCopy {
                src_session_id: "sess-src".to_string(),
                src_saved_connection_id: Some("conn-src".to_string()),
                src_container_id: None,
                src_agent: None,
                src_path: "/src/data.csv".to_string(),
                dst_session_id: "sess-dst".to_string(),
                dst_saved_connection_id: Some("conn-dst".to_string()),
                dst_container_id: None,
                dst_agent: None,
                dst_path: "/dst/data.csv".to_string(),
                offset: 4096,
                total: 8192,
            }
        );
    }

    /// A remote-to-remote copy with agent-hosted ends (#4115) keeps both
    /// session identities in its plan — the destination's on the record, the
    /// source's with its endpoint — and is never mistaken for an agent-hosted
    /// download/upload (it has no local endpoint).
    #[test]
    fn plan_for_an_agent_remote_copy_carries_both_agent_identities() {
        let agent = |id: &str| PersistedAgentTarget {
            agent_id: id.to_string(),
            remote_session_id: format!("{id}-session"),
            definition_id: Some(format!("{id}-def")),
        };
        let mut rec = record("r2r", None);
        rec.remote_path = "/dst/data.csv".to_string();
        rec.agent = Some(agent("dst-agent"));
        rec.remote_source = Some(crate::files::transfer::persist::PersistedRemoteSource {
            session_id: "sess-src".to_string(),
            path: "/src/data.csv".to_string(),
            saved_connection_id: None,
            container_id: None,
            agent: Some(agent("src-agent")),
        });
        match plan_from_record(&rec) {
            RelaunchPlan::RemoteCopy {
                src_agent,
                dst_agent,
                src_container_id,
                dst_container_id,
                ..
            } => {
                assert_eq!(src_agent, Some(agent("src-agent")));
                assert_eq!(dst_agent, Some(agent("dst-agent")));
                assert_eq!((src_container_id, dst_container_id), (None, None));
            }
            other => panic!("expected RemoteCopy, got {other:?}"),
        }
    }

    /// A remote-to-remote copy with Docker ends (#3586) keeps both container
    /// ids in its plan, so each end re-attaches to its exact container — it is
    /// never mistaken for a Docker download/upload (it has no local endpoint).
    #[test]
    fn plan_for_a_docker_remote_copy_carries_both_container_ids() {
        let mut rec = docker_record("r2r", None);
        rec.remote_path = "/dst/data.csv".to_string();
        rec.remote_source = Some(crate::files::transfer::persist::PersistedRemoteSource {
            session_id: "sess-src".to_string(),
            path: "/src/data.csv".to_string(),
            saved_connection_id: None,
            container_id: Some("src-container".to_string()),
            agent: None,
        });
        match plan_from_record(&rec) {
            RelaunchPlan::RemoteCopy {
                src_container_id,
                dst_container_id,
                src_path,
                ..
            } => {
                assert_eq!(src_container_id.as_deref(), Some("src-container"));
                assert_eq!(
                    dst_container_id,
                    rec.docker.as_ref().map(|d| d.container_id.clone())
                );
                assert_eq!(src_path, "/src/data.csv");
            }
            other => panic!("expected RemoteCopy, got {other:?}"),
        }
    }

    /// A remote-to-remote record rehydrated from the persisted queue plans a
    /// two-session relaunch.
    #[test]
    fn decide_resume_relaunches_a_rehydrated_remote_copy() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = TransferRegistry::new();
        let persist = TransferPersistenceManager::new_test(dir.path());
        persist.record_registration(
            "r2r",
            "sess-dst",
            TransferDirection::Upload,
            "data.csv",
            "/dst/data.csv",
            None,
            0,
        );
        persist.record_remote_source("r2r", "sess-src", "/src/data.csv", None);

        match decide_resume("r2r", &registry, &persist) {
            ResumeDecision::Relaunch(rec) => assert!(matches!(
                plan_from_record(&rec),
                RelaunchPlan::RemoteCopy { ref src_session_id, ref src_path, .. }
                    if src_session_id == "sess-src" && src_path == "/src/data.csv"
            )),
            other => panic!("expected Relaunch, got {other:?}"),
        }
    }

    #[test]
    fn plan_for_a_legacy_remote_to_remote_copy_is_unsupported() {
        // A remote→remote copy persisted before #3206 kept no local endpoint and
        // no source, so it cannot relaunch — it must Fail honestly, not hang.
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

    /// A relaunch that cannot re-source credentials unattended (#3876) keeps the
    /// row **paused** with the reason — built from metadata only, never
    /// carrying a credential.
    #[test]
    fn paused_progress_keeps_the_row_paused_with_a_reason_and_no_credentials() {
        let reason = super::super::relaunch_credentials::NEEDS_CREDENTIALS;
        let progress = paused_progress(&record("t1", Some("/l")), reason.to_string());
        assert_eq!(progress.state, TransferStateTag::Paused);
        assert_eq!(progress.message.as_deref(), Some(reason));
        assert_eq!(progress.transferred, 4096, "progress so far is kept");

        let json = serde_json::to_string(&progress).unwrap().to_lowercase();
        for needle in ["password", "passphrase", "secret", "privatekey"] {
            assert!(
                !json.contains(needle),
                "the paused event leaked a `{needle}`"
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

    // ── Terminal relaunch rows reach the authoritative store (#4387) ─────────
    //
    // The client reconcile poll is retired, so a relaunch that fails or cancels a
    // rehydrated row must fold its terminal state into the shared transfer store
    // directly — there is no engine and no later snapshot to heal it.

    fn app_with_store() -> (
        tauri::App<tauri::test::MockRuntime>,
        Arc<crate::transfers_projection::store::TransferStore>,
    ) {
        let app = tauri::test::mock_app();
        let store = Arc::new(crate::transfers_projection::store::TransferStore::new());
        app.manage(store.clone());
        (app, store)
    }

    #[test]
    fn a_failed_relaunch_folds_the_row_failed_into_the_store() {
        use crate::transfers_projection::store::TransferQueueState;
        let (app, store) = app_with_store();
        fail_row(
            app.handle(),
            &record("t1", Some("/l")),
            "session gone".into(),
        );
        let row = store.get("t1").expect("row folded");
        assert_eq!(row.state, TransferQueueState::Failed);
        assert_eq!(row.error.as_deref(), Some("session gone"));
    }

    #[test]
    fn a_cancelled_rehydrated_row_folds_cancelled_into_the_store() {
        use crate::transfers_projection::store::TransferQueueState;
        let (app, store) = app_with_store();
        cancel_row(app.handle(), &record("t1", Some("/l")));
        let row = store.get("t1").expect("row folded");
        assert_eq!(row.state, TransferQueueState::Cancelled);
    }
}
