//! Session types for the generic connection-based session manager.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::daemon::client::DaemonClient;
use termihub_core::connection::ConnectionType;

/// Current status of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    #[allow(dead_code)]
    Exited,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
        }
    }
}

/// How the connection is hosted within the agent.
pub enum SessionBackend {
    /// Connection running in a daemon subprocess with ring-buffer replay.
    ///
    /// Used for persistent connection types (SSH, Docker, etc.). The daemon
    /// survives agent restarts and is reconnectable on both unix (Unix domain
    /// socket) and windows (named pipe).
    Daemon(DaemonClient),

    /// Connection running in-process.
    ///
    /// Used for non-persistent connection types.
    InProcess {
        connection: Box<dyn ConnectionType>,
        /// Handle for the background output-forwarding task.
        output_task: Option<tokio::task::JoinHandle<()>>,
    },

    /// No-op stub backend for testing. All operations succeed silently.
    #[cfg(test)]
    Stub,
}

/// Internal session model tracking a single terminal connection.
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    /// Connection type identifier (e.g., `"local"`, `"ssh"`, `"serial"`).
    pub type_id: String,
    pub status: SessionStatus,
    /// Stored for session recovery and state persistence.
    #[allow(dead_code)]
    pub settings: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub attached: bool,
    pub backend: SessionBackend,
    /// ID of the saved connection definition this session was created from.
    /// Lets clients re-link an active session to its source definition
    /// (e.g. to derive the persistent connection ID for reattach).
    pub definition_id: Option<String>,
}

/// Read-only snapshot of session state, returned from list/create.
#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    pub id: String,
    pub title: String,
    pub type_id: String,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub attached: bool,
    pub definition_id: Option<String>,
}

impl SessionInfo {
    /// Create a read-only snapshot of this session's state.
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            id: self.id.clone(),
            title: self.title.clone(),
            type_id: self.type_id.clone(),
            status: self.status.clone(),
            created_at: self.created_at,
            last_activity: self.last_activity,
            attached: self.attached,
            definition_id: self.definition_id.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_status_as_str() {
        assert_eq!(SessionStatus::Running.as_str(), "running");
        assert_eq!(SessionStatus::Exited.as_str(), "exited");
    }

    #[test]
    fn session_status_serializes_lowercase() {
        let v = serde_json::to_value(SessionStatus::Running).unwrap();
        assert_eq!(v, "running");
        let v = serde_json::to_value(SessionStatus::Exited).unwrap();
        assert_eq!(v, "exited");
    }
}
