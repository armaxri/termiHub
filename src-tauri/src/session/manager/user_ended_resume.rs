//! Resume a tab's agent session after the user's agent Disconnect (#5953).
//!
//! A user Disconnect *detaches* the agent's sessions: they keep running on the
//! agent host and are listed again on the next connect. It also ends the
//! hosted tabs and scrubs their retained requests (#4309, #4459), so nothing
//! remembered which session a tab showed — and the tab's Reconnect started a
//! second session beside the first, which kept running unattached.
//!
//! [`UserEndedAgentSessions`] keeps that one non-secret fact per ended tab —
//! its agent and the agent's session id — and the tab's next connect through
//! [`SessionManager::create_connection`] re-attaches the session while the
//! agent still runs it, held by no other desktop. Otherwise the connect starts
//! a new session as before. The frontend asks
//! [`SessionManager::take_resumed_session`] which of the two happened, to
//! repaint the session's own scrollback and say "session resumed".

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tracing::{info, warn};

use super::SessionManager;
use crate::session::remote_proxy::RemoteProxy;

/// The agent sessions of user-ended tabs, and the desktop sessions that
/// resumed one.
#[derive(Clone, Default)]
pub(crate) struct UserEndedAgentSessions {
    /// `tab_id → (agent_id, agent session id)`.
    parked: Arc<StdMutex<HashMap<String, (String, String)>>>,
    /// Desktop session ids whose connect resumed a parked session, until the
    /// frontend takes the flag.
    resumed: Arc<StdMutex<HashSet<String>>>,
}

impl UserEndedAgentSessions {
    fn park(&self, tab_id: &str, agent_id: String, remote_session_id: String) {
        self.parked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(tab_id.to_string(), (agent_id, remote_session_id));
    }

    /// The session parked for `tab_id` on `agent_id`, removed. A session
    /// parked on another agent stays parked.
    fn take(&self, tab_id: &str, agent_id: &str) -> Option<String> {
        let mut parked = self
            .parked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match parked.get(tab_id) {
            Some((aid, _)) if aid == agent_id => parked.remove(tab_id).map(|(_, sid)| sid),
            _ => None,
        }
    }

    fn mark_resumed(&self, session_id: &str) {
        self.resumed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id.to_string());
    }

    fn take_resumed(&self, session_id: &str) -> bool {
        self.resumed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)
    }
}

/// A resumed agent session, ready for `create_connection` to register.
pub(super) struct ResumedAgentSession {
    pub(super) proxy: RemoteProxy,
    pub(super) remote_session_id: String,
}

impl SessionManager {
    /// Remember which agent session the user-ended `tab_id` showed, before its
    /// retained request is scrubbed (#5953). A no-op for a tab with no agent
    /// session on record.
    pub(crate) fn park_user_ended_agent_session(&self, tab_id: &str) {
        let Some(request) = self.retained_request(tab_id) else {
            return;
        };
        if let (Some(agent_id), Some(remote_session_id)) =
            (request.agent_id.clone(), request.agent_session_id.clone())
        {
            self.user_ended_agent_sessions
                .park(tab_id, agent_id, remote_session_id);
        }
    }

    /// Whether the connect that opened `session_id` resumed the tab's own agent
    /// session rather than starting a new one (#5953). One-shot.
    pub fn take_resumed_session(&self, session_id: &str) -> bool {
        self.user_ended_agent_sessions.take_resumed(session_id)
    }

    pub(super) fn mark_resumed_session(&self, session_id: &str) {
        self.user_ended_agent_sessions.mark_resumed(session_id);
    }

    /// Re-attach the agent session parked for `tab_id` on `agent_id`, if the
    /// agent still runs it unattached. `None` means: start a new session.
    ///
    /// While the agent is not connected the session stays parked, so the
    /// attempt after the agent is back can resume it.
    pub(super) async fn resume_user_ended_agent_session(
        &self,
        tab_id: &str,
        agent_id: &str,
        remote_settings: &Value,
    ) -> Option<ResumedAgentSession> {
        let remote_session_id = self.user_ended_agent_sessions.take(tab_id, agent_id)?;
        let client = self.agent_client();
        if !client.is_connected(agent_id) {
            self.user_ended_agent_sessions
                .park(tab_id, agent_id.to_string(), remote_session_id);
            return None;
        }
        // `list_sessions` parks on the agent's reply: blocking pool.
        let aid = agent_id.to_string();
        let listed = tokio::task::spawn_blocking(move || client.list_sessions(&aid)).await;
        let resumable = matches!(&listed, Ok(Ok(sessions)) if sessions.iter().any(|s| {
            s.session_id == remote_session_id && s.status == "running" && !s.attached
        }));
        if !resumable {
            info!(
                tab_id,
                agent_id, remote_session_id, "User-ended agent session is gone; starting a new one"
            );
            return None;
        }
        match RemoteProxy::resume_existing(
            agent_id,
            &remote_session_id,
            self.agent_client(),
            remote_settings,
        )
        .await
        {
            Ok(proxy) => {
                info!(
                    tab_id,
                    agent_id, remote_session_id, "Resumed user-ended agent session"
                );
                Some(ResumedAgentSession {
                    proxy,
                    remote_session_id,
                })
            }
            Err(e) => {
                warn!(
                    tab_id,
                    agent_id,
                    remote_session_id,
                    error = %e,
                    "Could not resume user-ended agent session; starting a new one"
                );
                None
            }
        }
    }
}
