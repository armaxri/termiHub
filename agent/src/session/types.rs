use chrono::{DateTime, Utc};
use serde::Serialize;

#[cfg(unix)]
use crate::docker::backend::DockerBackend;
use crate::serial::backend::SerialBackend;
#[cfg(unix)]
use crate::shell::backend::ShellBackend;

/// The type of session running on the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Shell,
    Serial,
    Docker,
}

impl SessionType {
    /// Parse a session type from the protocol string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "shell" => Some(Self::Shell),
            "serial" => Some(Self::Serial),
            "docker" => Some(Self::Docker),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Serial => "serial",
            Self::Docker => "docker",
        }
    }
}

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

/// Internal session model tracking a single terminal session.
///
/// Not `Clone` because `SerialBackend` contains a thread handle and
/// mutex-protected serial port. Use `snapshot()` for read-only copies.
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub session_type: SessionType,
    pub status: SessionStatus,
    #[allow(dead_code)]
    pub config: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub attached: bool,
    /// Handle to the serial backend, if this is a serial session.
    pub serial_backend: Option<SerialBackend>,
    /// Handle to the shell backend, if this is a shell session (Unix only).
    #[cfg(unix)]
    pub shell_backend: Option<ShellBackend>,
    /// Handle to the Docker backend, if this is a Docker session (Unix only).
    #[cfg(unix)]
    pub docker_backend: Option<DockerBackend>,
}

/// Read-only snapshot of session state, returned from list/create.
#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    pub id: String,
    pub title: String,
    pub session_type: SessionType,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub attached: bool,
}

impl SessionInfo {
    /// Create a read-only snapshot of this session's state.
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            id: self.id.clone(),
            title: self.title.clone(),
            session_type: self.session_type.clone(),
            status: self.status.clone(),
            created_at: self.created_at,
            last_activity: self.last_activity,
            attached: self.attached,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_type_from_str() {
        assert_eq!(SessionType::from_str("shell"), Some(SessionType::Shell));
        assert_eq!(SessionType::from_str("serial"), Some(SessionType::Serial));
        assert_eq!(SessionType::from_str("unknown"), None);
        assert_eq!(SessionType::from_str(""), None);
    }

    #[test]
    fn session_type_as_str_round_trip() {
        assert_eq!(
            SessionType::from_str(SessionType::Shell.as_str()),
            Some(SessionType::Shell)
        );
        assert_eq!(
            SessionType::from_str(SessionType::Serial.as_str()),
            Some(SessionType::Serial)
        );
    }

    #[test]
    fn session_status_as_str() {
        assert_eq!(SessionStatus::Running.as_str(), "running");
        assert_eq!(SessionStatus::Exited.as_str(), "exited");
    }

    #[test]
    fn session_type_serializes_lowercase() {
        let v = serde_json::to_value(SessionType::Shell).unwrap();
        assert_eq!(v, "shell");
        let v = serde_json::to_value(SessionType::Serial).unwrap();
        assert_eq!(v, "serial");
    }

    #[test]
    fn session_type_docker_from_str() {
        assert_eq!(SessionType::from_str("docker"), Some(SessionType::Docker));
    }

    #[test]
    fn session_type_docker_as_str_round_trip() {
        assert_eq!(
            SessionType::from_str(SessionType::Docker.as_str()),
            Some(SessionType::Docker)
        );
    }

    #[test]
    fn session_type_docker_serializes_lowercase() {
        let v = serde_json::to_value(SessionType::Docker).unwrap();
        assert_eq!(v, "docker");
    }
}
