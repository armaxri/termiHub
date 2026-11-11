//! Mirroring an **agent-side** reconnect loop into the region (#5396).
//!
//! An agent-hosted serial session reopens its port on the agent host, in
//! place, after the USB adapter drops. The agent runs the loop on the shared
//! reconnect policy and reports each step with a `connection.reconnect`
//! notification. These folds put those steps on the tab's region entry, so the
//! existing reconnect strip shows the attempt, the countdown and the reason,
//! and its Stop works:
//!
//! - **waiting / connecting** → `Reconnecting`, with the agent's attempt and
//!   backoff window as the entry's `reconnect` state. The tab is marked as
//!   agent-driven, so the backend timer never arms a desktop redrive for it
//!   ([`SessionLifecycleStore::agent_owns_reconnect`]). The live session's
//!   re-attach id is kept: it is the same session.
//! - **reconnected** → `Connected`.
//! - **gave up** → `Failed` with the reason, sticky like an agent transport
//!   give-up (#4713), so the session's exit right after does not relabel it.
//!
//! Each step carries a sequence number that only grows per agent session; a
//! step at or below the last applied one is dropped, so a late or replayed
//! step never undoes a newer one.

use termihub_core::protocol::methods::SessionReconnectStatus;
use termihub_core::reconnect_backoff::{ReconnectPhase, ReconnectState, INITIAL_RECONNECT_STATE};

use super::{apply_connect_failed, Inner, SessionLifecycleStore, SessionStatus};

/// Forget a tab's agent-side loop and its sequence (a fresh connect, a removal).
pub(super) fn forget(inner: &mut Inner, session_id: &str) {
    inner.agent_reconnecting.remove(session_id);
    inner.agent_reconnect_seq.remove(session_id);
}

/// Whether the tab is live enough for an agent-side loop to take it over:
/// connecting, connected or already reconnecting. An ended or evicted tab is
/// left alone.
fn is_live(inner: &Inner, session_id: &str) -> bool {
    inner.sessions.get(session_id).is_some_and(|s| {
        matches!(
            s.status,
            SessionStatus::Connecting | SessionStatus::Connected | SessionStatus::Reconnecting
        )
    })
}

/// Whether the tab is reconnecting through its agent-side loop.
fn in_agent_loop(inner: &Inner, session_id: &str) -> bool {
    inner.agent_reconnecting.contains(session_id)
        && inner
            .sessions
            .get(session_id)
            .is_some_and(|s| s.status == SessionStatus::Reconnecting)
}

impl SessionLifecycleStore {
    /// Fold one step of the agent-side reconnect loop of the tab `session_id`
    /// (see the module docs). Returns whether it changed the tab.
    pub fn agent_session_reconnect(
        &self,
        session_id: &str,
        seq: u64,
        status: &SessionReconnectStatus,
    ) -> bool {
        let mut inner = self.lock();
        let last = inner.agent_reconnect_seq.get(session_id).copied();
        if last.is_some_and(|last| seq <= last) {
            return false;
        }
        if !inner.sessions.contains_key(session_id) {
            return false;
        }
        inner
            .agent_reconnect_seq
            .insert(session_id.to_string(), seq);
        match status {
            SessionReconnectStatus::Waiting {
                attempt,
                delay_ms,
                reason,
            } => fold_running(
                &mut inner,
                session_id,
                ReconnectState {
                    phase: ReconnectPhase::Waiting,
                    attempt: *attempt,
                    delay_ms: *delay_ms,
                },
                reason.clone(),
            ),
            SessionReconnectStatus::Connecting { attempt, reason } => fold_running(
                &mut inner,
                session_id,
                ReconnectState {
                    phase: ReconnectPhase::Connecting,
                    attempt: *attempt,
                    delay_ms: 0,
                },
                reason.clone(),
            ),
            SessionReconnectStatus::Reconnected => {
                if !in_agent_loop(&inner, session_id) {
                    return false;
                }
                inner.dirty.insert(session_id.to_string());
                inner.agent_reconnecting.remove(session_id);
                if let Some(entry) = inner.sessions.get_mut(session_id) {
                    entry.status = SessionStatus::Connected;
                    entry.reconnect = INITIAL_RECONNECT_STATE;
                    entry.end_reason = None;
                    entry.error = None;
                    entry.reconnect_error = None;
                }
                true
            }
            SessionReconnectStatus::GaveUp { reason } => {
                if !in_agent_loop(&inner, session_id) {
                    return false;
                }
                apply_connect_failed(&mut inner, session_id, reason.clone());
                // Final until the user acts (#4713): the session's exit right
                // after must not relabel the tab or arm a desktop redrive.
                inner.agent_gave_up.insert(session_id.to_string());
                true
            }
        }
    }

    /// Whether the tab's `Reconnecting` loop runs on its agent (#5396). The
    /// backend timer arms no redrive for such a tab, and its Stop closes the
    /// agent session instead.
    pub fn agent_owns_reconnect(&self, session_id: &str) -> bool {
        in_agent_loop(&self.lock(), session_id)
    }

    /// The backend session id of a tab whose loop runs on its agent (#5396):
    /// the session a Stop must close so the agent stops reopening. `None` for
    /// any other tab.
    pub fn agent_reconnect_session(&self, session_id: &str) -> Option<String> {
        let inner = self.lock();
        if !in_agent_loop(&inner, session_id) {
            return None;
        }
        inner
            .sessions
            .get(session_id)
            .and_then(|s| s.backend_session_id.clone())
    }
}

/// Fold a running step (waiting / connecting) onto a live tab.
fn fold_running(
    inner: &mut Inner,
    session_id: &str,
    reconnect: ReconnectState,
    reason: Option<String>,
) -> bool {
    if !is_live(inner, session_id) {
        return false;
    }
    inner.dirty.insert(session_id.to_string());
    inner.agent_reconnecting.insert(session_id.to_string());
    if let Some(entry) = inner.sessions.get_mut(session_id) {
        entry.status = SessionStatus::Reconnecting;
        entry.reconnect = reconnect;
        entry.end_reason = None;
        entry.error = None;
        entry.reconnect_error = reason;
        entry.exit = None;
        // The agent session lives on; its re-attach id stays valid.
    }
    true
}

#[cfg(test)]
#[path = "agent_reconnect_tests.rs"]
mod tests;
