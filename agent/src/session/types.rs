// The Exited variant and config field are not used in the stub but
// will be needed in phase 7 when real PTY/serial backends are added.
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::Serialize;

/// The type of session running on the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Shell,
    Serial,
}

impl SessionType {
    /// Parse a session type from the protocol string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "shell" => Some(Self::Shell),
            "serial" => Some(Self::Serial),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Serial => "serial",
        }
    }
}

/// Current status of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
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
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub session_type: SessionType,
    pub status: SessionStatus,
    pub config: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub attached: bool,
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
}
