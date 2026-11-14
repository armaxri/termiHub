//! Agent-hosted sessions that end on their own, with a known cause (#5732)
//! or a real process exit status (#5742).
//!
//! When an agent-hosted Telnet / SSH session's server closes the connection,
//! the agent says so with a `connection.exit` that carries the backend's
//! `end_cause` (protocol 0.38.0). When a shell on the agent exits (the user
//! typed `exit`), the exit carries the shell's real `exit_status` (0.39.0).
//! The I/O task records either in the session's [`SessionEndSlot`] —
//! registered by its [`RemoteProxy`] — and drops the session's output route.
//! The proxy's output stream then ends, and the session manager emits
//! `terminal-exit` with the proxy's
//! [`end_cause`](termihub_core::connection::ConnectionType::end_cause) and
//! [`exit_code`](termihub_core::connection::ConnectionType::exit_code): the
//! tab reads "connection closed by server" exactly like a direct session, or
//! "[Process exited with code N]" — a process exit, never reconnected.
//!
//! A `connection.exit` with **neither** (an agent older than 0.38.0, whose
//! `exit_code` is always `0`, or a session whose backend cannot tell) changes
//! nothing here: the tab keeps today's behaviour, and losing the agent link
//! still reads "connection lost".
//!
//! [`RemoteProxy`]: crate::session::remote_proxy::RemoteProxy

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use tracing::{info, warn};

use termihub_core::connection::{EndCauseSlot, SessionEndCause};
use termihub_core::protocol::methods::{ConnectionExitNotification, CONNECTION_EXIT};

use crate::terminal::backend::OutputSender;

/// How an agent-hosted session ended on its own, shared by its
/// [`RemoteProxy`] and the agent's I/O task: why its link ended (#5732) and
/// its process's real exit status (#5742).
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionEndSlot {
    cause: EndCauseSlot,
    exit_status: Arc<Mutex<Option<i32>>>,
}

impl SessionEndSlot {
    /// An empty slot.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Record what the agent's `connection.exit` said.
    pub(crate) fn record(&self, cause: Option<SessionEndCause>, exit_status: Option<i32>) {
        if let Some(cause) = cause {
            self.cause.record(cause);
        }
        if let Some(code) = exit_status {
            *self
                .exit_status
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(code);
        }
    }

    /// Why the session's link ended, if the agent said.
    pub(crate) fn end_cause(&self) -> Option<SessionEndCause> {
        self.cause.get()
    }

    /// The session's real process exit status, if the agent reported one.
    pub(crate) fn exit_status(&self) -> Option<i32> {
        *self
            .exit_status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Per-agent routes from a remote session id to its proxy's end slot.
#[derive(Default)]
pub(crate) struct SessionExitRoutes {
    routes: HashMap<String, SessionEndSlot>,
}

impl SessionExitRoutes {
    /// Register the proxy's end slot for `session_id`.
    pub(crate) fn register(&mut self, session_id: String, slot: SessionEndSlot) {
        self.routes.insert(session_id, slot);
    }

    /// Drop the route of a session that is gone.
    pub(crate) fn remove(&mut self, session_id: &str) {
        self.routes.remove(session_id);
    }

    /// Keep only the sessions in `live_ids` (reconnect reconciliation).
    pub(crate) fn retain(&mut self, live_ids: &HashSet<String>) {
        self.routes.retain(|id, _| live_ids.contains(id));
    }
}

/// Route a `connection.exit` notification, returning `true` if it was one.
///
/// With an `end_cause` or a real `exit_status`, both are recorded in the
/// session's slot and the session's output route is dropped, which ends the
/// proxied session on the desktop. With neither, nothing changes — the legacy
/// `exit_code` alone is never read, since an older agent sends `0` for every
/// end. A malformed payload is dropped (and still counts as handled).
pub(crate) fn route_session_exit_notification(
    routes: &mut SessionExitRoutes,
    session_outputs: &mut HashMap<String, OutputSender>,
    agent_id: &str,
    method: &str,
    params: &Value,
) -> bool {
    if method != CONNECTION_EXIT {
        return false;
    }
    let n = match serde_json::from_value::<ConnectionExitNotification>(params.clone()) {
        Ok(n) => n,
        Err(e) => {
            warn!(agent_id, "malformed connection.exit dropped: {e}");
            return true;
        }
    };
    if n.end_cause.is_none() && n.exit_status.is_none() {
        return true;
    }
    info!(
        agent_id,
        remote_session_id = %n.session_id,
        cause = ?n.end_cause,
        exit_status = ?n.exit_status,
        "agent session ended on its own"
    );
    // Record before the route drops: the session manager reads the cause and
    // the status once the proxy's output stream ends.
    if let Some(slot) = routes.routes.remove(&n.session_id) {
        slot.record(n.end_cause, n.exit_status);
    }
    session_outputs.remove(&n.session_id);
    true
}

#[cfg(test)]
#[path = "session_exit_tests.rs"]
mod tests;
