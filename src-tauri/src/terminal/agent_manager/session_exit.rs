//! Agent-hosted sessions that end on their own, with a known cause (#5732).
//!
//! When an agent-hosted Telnet / SSH session's server closes the connection,
//! the agent says so with a `connection.exit` that carries the backend's
//! `end_cause` (protocol 0.38.0). The I/O task records that cause in the
//! session's [`EndCauseSlot`] — registered by its [`RemoteProxy`] — and drops
//! the session's output route. The proxy's output stream then ends, and the
//! session manager emits `terminal-exit` with the proxy's
//! [`end_cause`](termihub_core::connection::ConnectionType::end_cause), so the
//! tab reads "connection closed by server" exactly like a direct session.
//!
//! A `connection.exit` **without** a cause (an agent older than 0.38.0, or a
//! session whose backend cannot tell) changes nothing here: the tab keeps
//! today's behaviour, and losing the agent link still reads "connection lost".
//!
//! [`RemoteProxy`]: crate::session::remote_proxy::RemoteProxy

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use tracing::{info, warn};

use termihub_core::connection::EndCauseSlot;
use termihub_core::protocol::methods::{ConnectionExitNotification, CONNECTION_EXIT};

use crate::terminal::backend::OutputSender;

/// Per-agent routes from a remote session id to its proxy's end-cause slot.
#[derive(Default)]
pub(crate) struct SessionExitRoutes {
    routes: HashMap<String, EndCauseSlot>,
}

impl SessionExitRoutes {
    /// Register the proxy's end-cause slot for `session_id`.
    pub(crate) fn register(&mut self, session_id: String, slot: EndCauseSlot) {
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
/// With an `end_cause`, the cause is recorded in the session's slot and the
/// session's output route is dropped, which ends the proxied session on the
/// desktop. Without one, nothing changes. A malformed payload is dropped (and
/// still counts as handled).
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
    let Some(cause) = n.end_cause else {
        return true;
    };
    info!(
        agent_id,
        remote_session_id = %n.session_id,
        ?cause,
        "agent session ended on its own"
    );
    // Record before the route drops: the session manager reads the cause
    // once the proxy's output stream ends.
    if let Some(slot) = routes.routes.remove(&n.session_id) {
        slot.record(cause);
    }
    session_outputs.remove(&n.session_id);
    true
}

#[cfg(test)]
#[path = "session_exit_tests.rs"]
mod tests;
