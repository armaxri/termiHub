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

use super::SessionManager;

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
}
