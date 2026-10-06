//! Re-attaching relaunched graphical side-channel transfers (#4205).
//!
//! A VNC session's uploads (`remote_desktop_upload`, #4192) and the downloads
//! and uploads of its "Browse remote files" side channel (#4193) run over that
//! session's file side channel: SFTP on the VNC SSH tunnel's own session, or
//! the hosting agent's host-level file service. The graphical session id does
//! not survive a restart, and the side channel lives only as long as its
//! session, so such a transfer records the channel's **identity** instead
//! ([`PersistedGraphicalTarget`]): the saved VNC connection the session was
//! opened from, the route kind, the file host and account, and — for the
//! agent route — the agent. Never a secret: the VNC and SSH credentials stay
//! in the connection and the credential store.
//!
//! # What a relaunch does
//!
//! 1. **Find the live graphical sessions of the saved connection** and resolve
//!    each one's side channel (`remote_desktop_file_channel`).
//! 2. **Check the identity.** Only a channel that reaches the same file host,
//!    as the same account, by the same route (through the same agent) is used:
//!    a connection edited to tunnel through another machine never receives the
//!    rest of a partial file that lives on the first one. A mismatch fails the
//!    row with a message saying so.
//! 3. **Resume from the persisted offset** through the carrier's executor —
//!    `run_sftp_transfer` for the SSH route, `run_ranged_transfer` for the
//!    agent route — whose resume gate byte-verifies the destination and the
//!    source fingerprint before appending (and restarts from zero otherwise).
//!
//! # Waiting for the session
//!
//! A relaunch never opens a VNC session itself. When no session of the
//! connection is open yet — always the case right after a restart — or its
//! side channel is not `ready` (the tunnel or agent is still coming up), the
//! row stays **paused** with [`GRAPHICAL_SESSION_UNAVAILABLE`] and waits on
//! [`WaitTrigger::GraphicalSessionActive`](super::relaunch_auto::WaitTrigger):
//! once a session of that connection becomes active, the relaunch runs again
//! by itself. **Resume** re-runs it at any time; the persisted record is kept
//! either way. The resumed transfer is queued under the **new** graphical
//! session id, so closing that session cancels it like any other upload of it.

use std::future::Future;
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use termihub_core::connection::{FileSideChannel, FileSideChannelKind};

use super::persist::PersistedGraphicalTarget;
use super::relaunch_credentials::RelaunchBlocked;
use crate::session::graphical_file_channel::{AgentFiles, RemoteDesktopFileChannel};
use crate::session::graphical_manager::GraphicalSessionManager;
use crate::session::graphical_upload::{AgentRequests, UploadCarrier};
use crate::terminal::agent_manager::AgentRpcClient;

/// The reason a relaunched side-channel transfer stays paused while no
/// session of its VNC connection has a ready file channel.
pub(crate) const GRAPHICAL_SESSION_UNAVAILABLE: &str =
    "VNC session unavailable — reconnect to resume";

/// The identity of a resolved side channel, as a relaunch compares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SideChannelIdentity {
    pub route: FileSideChannelKind,
    pub host: String,
    pub user: String,
    pub agent_id: Option<String>,
}

impl SideChannelIdentity {
    /// The identity of `channel`, reached through `agent_id` on the agent
    /// route.
    pub(crate) fn of(channel: &FileSideChannel, agent_id: Option<&str>) -> Self {
        Self {
            route: channel.kind,
            host: channel.host.clone(),
            user: channel.user.clone(),
            agent_id: match channel.kind {
                FileSideChannelKind::Agent => agent_id.map(str::to_string),
                FileSideChannelKind::Ssh => None,
            },
        }
    }

    /// What a transfer over this channel records, for the saved connection
    /// `connection_id`.
    pub(crate) fn to_persisted(&self, connection_id: &str) -> PersistedGraphicalTarget {
        PersistedGraphicalTarget {
            connection_id: connection_id.to_string(),
            route: self.route,
            host: self.host.clone(),
            user: self.user.clone(),
            agent_id: self.agent_id.clone(),
        }
    }

    fn describe(route: FileSideChannelKind, user: &str, host: &str) -> String {
        let at = if user.is_empty() {
            host.to_string()
        } else {
            format!("{user}@{host}")
        };
        match route {
            FileSideChannelKind::Ssh => format!("{at} (SSH tunnel)"),
            FileSideChannelKind::Agent => format!("{at} (agent)"),
        }
    }
}

/// What a transfer over `carrier` (resolved as `channel`) of a graphical
/// session opened from the saved connection `connection_id` records (#4205).
/// `None` for a session not opened from a saved connection: nothing could
/// find it again after a restart, so such a transfer is not persisted.
pub(crate) fn side_channel_target(
    connection_id: Option<&str>,
    channel: &FileSideChannel,
    carrier: &UploadCarrier,
) -> Option<PersistedGraphicalTarget> {
    let connection_id = connection_id.filter(|id| !id.is_empty())?;
    let agent = carrier.agent();
    let agent_id = agent.as_ref().map(|files| files.agent_id());
    Some(SideChannelIdentity::of(channel, agent_id).to_persisted(connection_id))
}

/// Why `live` is not the side channel `persisted` was recorded on, or `None`
/// when it is. An account is compared only when both sides know it.
pub(crate) fn identity_mismatch(
    persisted: &PersistedGraphicalTarget,
    live: &SideChannelIdentity,
) -> Option<String> {
    let same_user =
        persisted.user.is_empty() || live.user.is_empty() || persisted.user == live.user;
    let same_agent = match persisted.route {
        FileSideChannelKind::Agent => {
            persisted.agent_id.is_some() && persisted.agent_id == live.agent_id
        }
        FileSideChannelKind::Ssh => true,
    };
    if persisted.route == live.route
        && !persisted.host.is_empty()
        && persisted.host == live.host
        && same_user
        && same_agent
    {
        return None;
    }
    Some(format!(
        "Cannot resume: the VNC connection's files now go to {}, not {} — the partial \
         file is not continued on a different host. Cancel it and upload again.",
        SideChannelIdentity::describe(live.route, &live.user, &live.host),
        SideChannelIdentity::describe(persisted.route, &persisted.user, &persisted.host),
    ))
}

/// The side channel of one live graphical session, as a relaunch sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LiveSideChannel {
    /// The channel is ready: files can move over it.
    Ready(SideChannelIdentity),
    /// A route exists but its host refused for now (the tunnel or agent is
    /// still coming up, …): worth waiting for.
    Degraded {
        identity: SideChannelIdentity,
        message: String,
    },
    /// The session has no file side channel (turned off, view-only, no
    /// route): waiting does not help.
    Refused(String),
}

impl LiveSideChannel {
    /// Classify a resolved `remote_desktop_file_channel` answer.
    pub(crate) fn of(channel: &RemoteDesktopFileChannel) -> Self {
        match channel {
            RemoteDesktopFileChannel::Ready {
                channel, agent_id, ..
            } => Self::Ready(SideChannelIdentity::of(channel, agent_id.as_deref())),
            RemoteDesktopFileChannel::Degraded {
                channel,
                agent_id,
                message,
            } => Self::Degraded {
                identity: SideChannelIdentity::of(channel, agent_id.as_deref()),
                message: message.clone(),
            },
            RemoteDesktopFileChannel::Unavailable { reason } => Self::Refused(
                crate::commands::remote_desktop::unavailable_message(*reason),
            ),
        }
    }
}

/// Resolve the carrier a relaunched side-channel transfer resumes over from
/// the `live` sessions of its saved connection: the first `ready` channel
/// whose identity matches, opened with `open`.
///
/// No session, or only a matching channel that is degraded, keeps the row
/// paused ([`RelaunchBlocked::GraphicalSessionUnavailable`]) — the session is
/// worth waiting for. Otherwise the row fails with the reason: a channel to a
/// different host, a session without file transfer, or a carrier that cannot
/// be opened.
pub(crate) async fn resolve_graphical_target<T, C, F, Fut>(
    persisted: &PersistedGraphicalTarget,
    live: Vec<(LiveSideChannel, T)>,
    open: F,
) -> Result<C, RelaunchBlocked>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<C, String>>,
{
    let mut waiting = false;
    let mut failure: Option<String> = None;
    for (channel, target) in live {
        match channel {
            LiveSideChannel::Ready(identity) => {
                if let Some(mismatch) = identity_mismatch(persisted, &identity) {
                    tracing::debug!(
                        connection = %persisted.connection_id,
                        "graphical side channel leads elsewhere; not resuming there"
                    );
                    failure.get_or_insert(mismatch);
                    continue;
                }
                match open(target).await {
                    Ok(carrier) => return Ok(carrier),
                    Err(e) => {
                        failure.get_or_insert(format!("Cannot resume over the VNC session: {e}"));
                    }
                }
            }
            LiveSideChannel::Degraded { identity, message } => {
                match identity_mismatch(persisted, &identity) {
                    Some(mismatch) => {
                        failure.get_or_insert(mismatch);
                    }
                    None => {
                        tracing::debug!(
                            connection = %persisted.connection_id,
                            %message,
                            "graphical side channel degraded; waiting"
                        );
                        waiting = true;
                    }
                }
            }
            LiveSideChannel::Refused(message) => {
                failure.get_or_insert(format!("Cannot resume: {message}"));
            }
        }
    }
    match failure {
        Some(message) if !waiting => Err(RelaunchBlocked::Failed(message)),
        _ => Err(RelaunchBlocked::GraphicalSessionUnavailable),
    }
}

/// Resolve the live graphical session and carrier a relaunched side-channel
/// transfer resumes over (see the module docs): the new graphical session id
/// and its carrier.
pub(crate) async fn resolve_live_graphical_target(
    app_handle: &AppHandle,
    persisted: &PersistedGraphicalTarget,
) -> Result<(String, UploadCarrier), RelaunchBlocked> {
    let (Some(graphical), Some(agents)) = (
        app_handle.try_state::<GraphicalSessionManager>(),
        app_handle.try_state::<Arc<dyn AgentRpcClient>>(),
    ) else {
        return Err(RelaunchBlocked::GraphicalSessionUnavailable);
    };
    let rpc: Arc<dyn AgentRpcClient> = agents.inner().clone();
    let mut live = Vec::new();
    for session_id in graphical
        .sessions_for_saved_connection(&persisted.connection_id)
        .await
    {
        let files: Arc<dyn AgentFiles> = Arc::new(rpc.clone());
        // A session closed meanwhile is simply not a candidate.
        if let Ok((channel, ssh)) = graphical
            .file_channel_with_session(&session_id, Some(files))
            .await
        {
            live.push((LiveSideChannel::of(&channel), (session_id, channel, ssh)));
        }
    }
    resolve_graphical_target(persisted, live, |(session_id, channel, ssh)| {
        let requests: Arc<dyn AgentRequests> = Arc::new(rpc.clone());
        async move {
            crate::commands::remote_desktop::upload_carrier(channel, ssh, requests)
                .await
                .map(|(carrier, _, _)| (session_id, carrier))
                .map_err(|e| e.to_string())
        }
    })
    .await
}

#[cfg(test)]
#[path = "relaunch_graphical_tests.rs"]
mod tests;
