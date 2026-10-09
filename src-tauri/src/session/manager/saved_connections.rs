//! Which saved connection a live session was opened for (#3876).
//!
//! A transfer records the saved connection behind its session, so a relaunch
//! after a restart — when that session id is long gone — can find a session
//! the user reopened for the same connection, or re-source the connection's
//! secret from the credential store. The frontend names the saved connection
//! when it creates a session (`create_connection`'s `savedConnectionId`); an
//! ad-hoc session has none.
//!
//! Only ids are kept, never settings or secrets. Entries of sessions that have
//! ended are dropped whenever a session is bound or looked up, so the map never
//! outgrows the live sessions by more than the ones that ended since.
//!
//! # Session-opened side effects (#4301)
//!
//! Opening a session has two side effects beyond the session itself: the
//! binding above, and the transfer-resume triggers — transfers paused waiting
//! for this saved connection (#3883) or for a session on this agent (#4114)
//! resume once it is open. [`SessionManager::on_session_opened`] does both, so
//! every creation path shares them: the `create_connection` command, the
//! backend reconnect redrive (which re-creates a resilient tab's session from
//! its retained request) and persistent sessions. It also stamps the saved
//! connection on the tab's retained request, so the next redrive can carry it.

use std::sync::Arc;

use serde_json::Value;

use super::SessionManager;
use crate::files::transfer::relaunch_auto::WaitTrigger;

/// Receives the transfer-resume triggers of a newly opened session. Boot
/// installs one that resumes the waiting transfers
/// ([`crate::files::transfer::relaunch_auto::spawn_resume_waiting`]).
pub(crate) type SessionOpenedHook = Arc<dyn Fn(WaitTrigger) + Send + Sync>;

/// Where a session came from: the identity its side effects key on (#4301).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SessionOrigin {
    /// The saved connection the session was opened for; `None` when ad hoc.
    pub(crate) saved_connection_id: Option<String>,
    /// The agent hosting the session; `None` for a direct session.
    pub(crate) agent_id: Option<String>,
    /// The saved agent definition an agent-hosted session was opened from.
    pub(crate) agent_definition_id: Option<String>,
}

impl SessionOrigin {
    /// The origin of a session opened with these request fields. An empty
    /// saved-connection id counts as none, and the agent definition is read
    /// from the settings only for an agent-hosted session.
    pub(crate) fn new(
        saved_connection_id: Option<&str>,
        agent_id: Option<&str>,
        settings: &Value,
    ) -> Self {
        Self {
            saved_connection_id: saved_connection_id
                .filter(|id| !id.is_empty())
                .map(String::from),
            agent_id: agent_id.map(String::from),
            agent_definition_id: agent_id.and_then(|_| agent_definition_id(settings)),
        }
    }

    /// The transfer-resume triggers opening a session of this origin fires.
    pub(crate) fn resume_triggers(&self) -> Vec<WaitTrigger> {
        let connection = self
            .saved_connection_id
            .clone()
            .map(WaitTrigger::ConnectionOpened);
        let agent = self
            .agent_id
            .clone()
            .map(|agent_id| WaitTrigger::AgentSessionOpened {
                agent_id,
                definition_id: self.agent_definition_id.clone(),
            });
        connection.into_iter().chain(agent).collect()
    }
}

/// The saved agent definition id the frontend placed in an agent-hosted
/// session's settings (top level or under `config`), as the agent proxy reads
/// it.
pub(crate) fn agent_definition_id(settings: &Value) -> Option<String> {
    let config = settings.get("config");
    ["definitionId", "definition_id"]
        .iter()
        .find_map(|key| {
            config
                .and_then(|c| c.get(*key))
                .or_else(|| settings.get(*key))
        })
        .and_then(Value::as_str)
        .map(String::from)
}

impl SessionManager {
    /// Record that `session_id` was opened for the saved connection
    /// `connection_id`, dropping the bindings of sessions that have ended.
    pub async fn bind_saved_connection(&self, session_id: &str, connection_id: &str) {
        let sessions = self.sessions.lock().await;
        let mut bindings = self
            .saved_connections
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bindings.retain(|id, _| sessions.contains_key(id));
        bindings.insert(session_id.to_string(), connection_id.to_string());
    }

    /// The saved connection `session_id` was opened for, if any.
    pub fn saved_connection_of(&self, session_id: &str) -> Option<String> {
        self.saved_connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    /// The live sessions opened for the saved connection `connection_id`,
    /// sorted by id. Drops the bindings of sessions that have ended.
    pub async fn sessions_for_saved_connection(&self, connection_id: &str) -> Vec<String> {
        let sessions = self.sessions.lock().await;
        let mut bindings = self
            .saved_connections
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bindings.retain(|id, _| sessions.contains_key(id));
        let mut ids: Vec<String> = bindings
            .iter()
            .filter(|(_, conn)| conn.as_str() == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Install where newly opened sessions' transfer-resume triggers go
    /// (#4301), replacing any earlier hook.
    pub(crate) fn set_session_opened_hook(&self, hook: SessionOpenedHook) {
        *self
            .session_opened_hook
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(hook);
    }

    /// Record where `session_id` came from without firing its resume
    /// triggers: bind it to its saved connection and stamp that connection on
    /// its tab's retained request, so the next redrive carries it (#4301).
    pub async fn bind_session_origin(&self, session_id: &str, origin: &SessionOrigin) {
        if let Some(connection_id) = origin.saved_connection_id.as_deref() {
            self.bind_saved_connection(session_id, connection_id).await;
        }
        if let Some(tab_id) = self.tab_id_for(session_id) {
            self.retained_requests
                .set_saved_connection(&tab_id, origin.saved_connection_id.as_deref());
        }
    }

    /// The side effects of a session being opened, shared by every creation
    /// path (#4301): bind it to its origin ([`Self::bind_session_origin`]),
    /// then fire its transfer-resume triggers — its file browser is ready, so
    /// transfers waiting for its saved connection (#3883) or its agent (#4114)
    /// resume.
    pub async fn on_session_opened(&self, session_id: &str, origin: &SessionOrigin) {
        self.bind_session_origin(session_id, origin).await;
        let hook = self
            .session_opened_hook
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(hook) = hook {
            for trigger in origin.resume_triggers() {
                hook(trigger);
            }
        }
    }
}
