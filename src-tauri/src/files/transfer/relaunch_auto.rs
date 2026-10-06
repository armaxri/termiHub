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
//! from `create_connection`).
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

use super::persist::PersistedTransfer;
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
}

/// What a waiting transfer needs before its relaunch can succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WaitFor {
    /// One of these saved connections opened, or the store unlocked.
    Connections(Vec<String>),
    /// A session on this agent, for this definition when the transfer's
    /// session had one (#4114).
    AgentSession {
        agent_id: String,
        definition_id: Option<String>,
    },
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
            WaitFor::AgentSession {
                agent_id,
                definition_id,
            },
            WaitTrigger::AgentSessionOpened {
                agent_id: opened_agent,
                definition_id: opened_definition,
            },
        ) => {
            // An ad-hoc session (no definition) can only come back as itself,
            // so any session on its agent is worth a retry; the relaunch's
            // identity check still decides.
            agent_id == opened_agent
                && (definition_id.is_none() || definition_id == opened_definition)
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
/// open (#4114). Any other outcome, or a transfer with nothing to wait for,
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
        RelaunchBlocked::AgentSessionUnavailable => match &record.agent {
            Some(agent) => WaitFor::AgentSession {
                agent_id: agent.agent_id.clone(),
                definition_id: agent.definition_id.clone(),
            },
            None => return,
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
