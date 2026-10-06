//! Automatic resume of relaunched transfers paused for credentials (#3883).
//!
//! A relaunched SFTP, FTP or remote-to-remote transfer whose secret cannot be
//! re-sourced unattended stays **paused** with "Needs credentials — open the
//! connection to resume" (#3876, [`super::relaunch_credentials`]). Such a
//! transfer is put on a wait list with the saved connection(s) it needs, and
//! resumes by itself when one of two things happens:
//!
//! - a session is opened for one of those saved connections
//!   ([`WaitTrigger::ConnectionOpened`], from `create_connection`), or
//! - the credential store is unlocked ([`WaitTrigger::StoreUnlocked`]).
//!
//! A relaunched **agent-hosted** transfer whose agent session is not live yet
//! (#4114, [`super::relaunch_agent`]) waits the same way, for a session opened
//! on its agent from its saved definition ([`WaitTrigger::AgentSessionOpened`],
//! from `create_connection`). A remote-to-remote copy with **two** agent ends
//! waits on both identities (#4158): a session opening for either end retries
//! it, and the relaunch's resolution of both ends decides — if the other end
//! is still not live, the row pauses again and keeps waiting on both.
//!
//! A relaunched **graphical side-channel** transfer whose VNC session is not
//! open yet (#4205, [`super::relaunch_graphical`]) waits for a graphical
//! session of its saved VNC connection to become active
//! ([`WaitTrigger::GraphicalSessionActive`], from `remote_desktop_connect`,
//! which returns once the session is active).
//!
//! The resume goes through the normal resume path
//! ([`super::relaunch::resume_or_relaunch`]) inside the unattended scope
//! (#3527), so it never prompts. If the secret is still missing, the relaunch
//! pauses the row again with the same reason and puts it back on the list.
//!
//! Only transfers on the list resume. A row is added only when its relaunch was
//! blocked for credentials, and it leaves the list when the user resumes,
//! pauses or cancels it. A transfer that already has a live handle (it runs,
//! or the user paused it after it ran again) is never resumed from here. The
//! list is in memory only; after a restart every row is an ordinary paused row
//! again.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use termihub_core::backends::ssh::unattended::run_unattended;
use tracing::debug;

use super::persist::{PersistedAgentTarget, PersistedTransfer};
use super::persist_manager::TransferPersistenceManager;
use super::registry::TransferRegistry;
use super::relaunch_credentials::RelaunchBlocked;
use crate::session::manager::SessionManager;

/// What can let a transfer paused for credentials resume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WaitTrigger {
    /// A session was opened for this saved connection.
    ConnectionOpened(String),
    /// The credential store was unlocked.
    StoreUnlocked,
    /// An agent-hosted session was opened on `agent_id`, from the saved
    /// agent definition `definition_id` when it has one (#4114).
    AgentSessionOpened {
        agent_id: String,
        definition_id: Option<String>,
    },
    /// A graphical (VNC) session of this saved connection became active
    /// (#4205).
    GraphicalSessionActive(String),
}

/// What a waiting transfer needs before its relaunch can succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WaitFor {
    /// One of these saved connections opened, or the store unlocked.
    Connections(Vec<String>),
    /// A session on one of these agent ends (#4114): one for an agent-hosted
    /// transfer, one or two for a remote-to-remote copy (#4115, #4158).
    AgentSession(Vec<AgentEnd>),
    /// An active graphical session of this saved VNC connection (#4205).
    GraphicalSession(String),
}

/// One agent end a waiting transfer needs: a session on this agent, for this
/// definition when the transfer's session had one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentEnd {
    agent_id: String,
    definition_id: Option<String>,
}

impl AgentEnd {
    fn from_persisted(agent: &PersistedAgentTarget) -> Self {
        Self {
            agent_id: agent.agent_id.clone(),
            definition_id: agent.definition_id.clone(),
        }
    }

    /// Whether a session opened on `agent_id` from `definition_id` may be
    /// this end. An ad-hoc session (no definition) can only come back as
    /// itself, so any session on its agent is worth a retry; the relaunch's
    /// identity check still decides.
    fn matches(&self, agent_id: &str, definition_id: &Option<String>) -> bool {
        self.agent_id == agent_id
            && (self.definition_id.is_none() || &self.definition_id == definition_id)
    }
}

/// The transfers paused waiting to resume on their own, by transfer id, each
/// with what its relaunch needs: saved connections (credentials, #3883) or an
/// agent session (#4114).
#[derive(Debug, Default)]
pub(crate) struct CredentialWaits {
    waiting: Mutex<HashMap<String, WaitFor>>,
}

impl CredentialWaits {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WaitFor>> {
        self.waiting.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether `transfer_id` waits for credentials.
    #[cfg(test)]
    pub(crate) fn contains(&self, transfer_id: &str) -> bool {
        self.lock().contains_key(transfer_id)
    }

    /// Take `transfer_id` off the list: the user resumed, paused or cancelled
    /// it, so nothing may resume it on its own.
    pub(crate) fn forget(&self, transfer_id: &str) {
        self.lock().remove(transfer_id);
    }

    /// Whether any transfer waits for `trigger`.
    fn any_for(&self, trigger: &WaitTrigger) -> bool {
        self.lock()
            .values()
            .any(|wait| matches_trigger(wait, trigger))
    }
}

/// Whether a transfer waiting for `wait` can resume on `trigger`.
fn matches_trigger(wait: &WaitFor, trigger: &WaitTrigger) -> bool {
    match (wait, trigger) {
        (WaitFor::Connections(_), WaitTrigger::StoreUnlocked) => true,
        (WaitFor::Connections(connections), WaitTrigger::ConnectionOpened(id)) => {
            connections.iter().any(|c| c == id)
        }
        (
            WaitFor::AgentSession(ends),
            WaitTrigger::AgentSessionOpened {
                agent_id,
                definition_id,
            },
        ) => ends.iter().any(|end| end.matches(agent_id, definition_id)),
        (WaitFor::GraphicalSession(waiting), WaitTrigger::GraphicalSessionActive(opened)) => {
            waiting == opened
        }
        _ => false,
    }
}

/// The saved connections a record's relaunch needs: its own and, for a
/// remote-to-remote copy, its source's.
fn saved_connections(record: &PersistedTransfer) -> Vec<String> {
    let source = record
        .remote_source
        .as_ref()
        .and_then(|s| s.saved_connection_id.clone());
    let mut ids: Vec<String> = record
        .saved_connection_id
        .clone()
        .into_iter()
        .chain(source)
        .collect();
    ids.dedup();
    ids
}

/// Record the outcome of a blocked relaunch: a transfer paused for credentials
/// waits for its connection to open or the store to unlock; an agent-hosted
/// transfer whose session is not live waits for a matching agent session to
/// open (#4114); a graphical side-channel transfer waits for a session of its
/// VNC connection to become active (#4205). Any other outcome, or a transfer with nothing to wait for,
/// does not wait.
pub(crate) fn note_blocked(
    waits: &CredentialWaits,
    record: &PersistedTransfer,
    blocked: &RelaunchBlocked,
) {
    let wait = match blocked {
        RelaunchBlocked::NeedsCredentials => {
            let connections = saved_connections(record);
            if connections.is_empty() {
                return;
            }
            WaitFor::Connections(connections)
        }
        // A remote-to-remote copy may be waiting on its source's agent too
        // (#4115). With two agent ends it waits on both (#4158): the relaunch
        // does not say which end was missing, and whichever one opens, the
        // retry re-resolves both and pauses again if the other is still down.
        RelaunchBlocked::AgentSessionUnavailable => {
            let source = record
                .remote_source
                .as_ref()
                .and_then(|source| source.agent.as_ref());
            let mut ends: Vec<AgentEnd> = record
                .agent
                .iter()
                .chain(source)
                .map(AgentEnd::from_persisted)
                .collect();
            ends.dedup();
            if ends.is_empty() {
                return;
            }
            WaitFor::AgentSession(ends)
        }
        // A side-channel transfer waits for its VNC connection (#4205).
        RelaunchBlocked::GraphicalSessionUnavailable => match &record.graphical {
            Some(graphical) if !graphical.connection_id.is_empty() => {
                WaitFor::GraphicalSession(graphical.connection_id.clone())
            }
            _ => return,
        },
        RelaunchBlocked::Failed(_) => return,
    };
    waits.lock().insert(record.transfer_id.clone(), wait);
}

/// Take the transfers `trigger` resumes off the list and return their ids.
///
/// A transfer that has a live handle is not waiting any more (it runs, or the
/// user paused it after it ran again), so it is dropped from the list and not
/// returned: resuming it would undo the user's pause.
pub(crate) fn due(
    waits: &CredentialWaits,
    trigger: &WaitTrigger,
    registry: &TransferRegistry,
) -> Vec<String> {
    let mut waiting = waits.lock();
    let matched: Vec<String> = waiting
        .iter()
        .filter(|(_, wait)| matches_trigger(wait, trigger))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &matched {
        waiting.remove(id);
    }
    matched
        .into_iter()
        .filter(|id| registry.get(id).is_none())
        .collect()
}

/// Resume, in the background, every transfer paused for credentials that
/// `trigger` lets continue. Cheap when nothing waits for it.
pub(crate) fn spawn_resume_waiting(app_handle: &AppHandle, trigger: WaitTrigger) {
    let Some(persist) = app_handle.try_state::<TransferPersistenceManager>() else {
        return;
    };
    if !persist.credential_waits().any_for(&trigger) {
        return;
    }
    let app = app_handle.clone();
    // Not app-owned (#3105): each relaunch spawns its own transfer task.
    tauri::async_runtime::spawn(async move { resume_waiting(&app, &trigger).await });
}

/// Resume the transfers `trigger` lets continue through the normal resume
/// path, unattended so nothing prompts.
async fn resume_waiting(app: &AppHandle, trigger: &WaitTrigger) {
    let (Some(persist), Some(registry), Some(manager)) = (
        app.try_state::<TransferPersistenceManager>(),
        app.try_state::<TransferRegistry>(),
        app.try_state::<SessionManager>(),
    ) else {
        return;
    };
    for transfer_id in due(persist.credential_waits(), trigger, &registry) {
        debug!(
            transfer_id,
            ?trigger,
            "auto-resuming a transfer paused for credentials"
        );
        run_unattended(super::relaunch::resume_or_relaunch(
            &transfer_id,
            &registry,
            &manager,
            app,
        ))
        .await;
    }
}

#[cfg(test)]
#[path = "relaunch_auto_tests.rs"]
mod tests;
