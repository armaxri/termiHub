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
}

/// The transfers paused for credentials, by transfer id, each with the saved
/// connection ids its relaunch needs.
#[derive(Debug, Default)]
pub(crate) struct CredentialWaits {
    waiting: Mutex<HashMap<String, Vec<String>>>,
}

impl CredentialWaits {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<String>>> {
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
            .any(|connections| matches_trigger(connections, trigger))
    }
}

/// Whether a transfer needing `connections` can resume on `trigger`.
fn matches_trigger(connections: &[String], trigger: &WaitTrigger) -> bool {
    match trigger {
        WaitTrigger::StoreUnlocked => true,
        WaitTrigger::ConnectionOpened(id) => connections.iter().any(|c| c == id),
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
/// waits for its connection to open or the store to unlock. Any other outcome,
/// or a transfer with no saved connection, does not wait.
pub(crate) fn note_blocked(
    waits: &CredentialWaits,
    record: &PersistedTransfer,
    blocked: &RelaunchBlocked,
) {
    if *blocked != RelaunchBlocked::NeedsCredentials {
        return;
    }
    let connections = saved_connections(record);
    if !connections.is_empty() {
        waits.lock().insert(record.transfer_id.clone(), connections);
    }
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
        .filter(|(_, connections)| matches_trigger(connections, trigger))
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
