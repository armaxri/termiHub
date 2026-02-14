use std::collections::HashMap;
use std::fmt;

use chrono::Utc;
use tokio::sync::Mutex;

use crate::io::stdio::NotificationSender;
use crate::protocol::methods::SerialSessionConfig;
use crate::serial::backend::SerialBackend;
use crate::session::types::{SessionInfo, SessionSnapshot, SessionStatus, SessionType};

/// Maximum number of concurrent sessions the agent supports.
pub const MAX_SESSIONS: u32 = 20;

/// Errors that can occur during session creation.
#[derive(Debug)]
pub enum SessionCreateError {
    /// The maximum number of sessions has been reached.
    LimitReached,
    /// The provided configuration is invalid.
    InvalidConfig(String),
    /// The backend failed to start.
    BackendFailed(String),
}

impl fmt::Display for SessionCreateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitReached => write!(f, "Session limit reached (max {MAX_SESSIONS})"),
            Self::InvalidConfig(msg) => write!(f, "Invalid configuration: {msg}"),
            Self::BackendFailed(msg) => write!(f, "Backend failed: {msg}"),
        }
    }
}

/// In-memory session manager.
///
/// Tracks sessions in a `HashMap` protected by a `tokio::sync::Mutex`
/// so it can be shared across async tasks.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionInfo>>,
    notification_tx: NotificationSender,
}

impl SessionManager {
    pub fn new(notification_tx: NotificationSender) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            notification_tx,
        }
    }

    /// Create a new session.
    ///
    /// For serial sessions, this opens the serial port and starts the
    /// background reader thread. Shell sessions remain stubs for now.
    pub async fn create(
        &self,
        session_type: SessionType,
        title: String,
        config: serde_json::Value,
    ) -> Result<SessionSnapshot, SessionCreateError> {
        let mut sessions = self.sessions.lock().await;

        if sessions.len() >= MAX_SESSIONS as usize {
            return Err(SessionCreateError::LimitReached);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();

        let serial_backend = if session_type == SessionType::Serial {
            let serial_config: SerialSessionConfig = serde_json::from_value(config.clone())
                .map_err(|e| SessionCreateError::InvalidConfig(e.to_string()))?;
            let backend = SerialBackend::new(
                id.clone(),
                &serial_config,
                self.notification_tx.clone(),
            )
            .map_err(|e| SessionCreateError::BackendFailed(e.to_string()))?;
            Some(backend)
        } else {
            None
        };

        let info = SessionInfo {
            id: id.clone(),
            title,
            session_type,
            status: SessionStatus::Running,
            config,
            created_at: now,
            last_activity: now,
            attached: false,
            serial_backend,
        };

        let snapshot = info.snapshot();
        sessions.insert(id, info);
        Ok(snapshot)
    }

    /// List all sessions as read-only snapshots.
    pub async fn list(&self) -> Vec<SessionSnapshot> {
        let sessions = self.sessions.lock().await;
        sessions.values().map(|s| s.snapshot()).collect()
    }

    /// Close (remove) a session by ID.
    ///
    /// Closes any active backend before removing the session.
    /// Returns `true` if the session was found and removed, `false` otherwise.
    pub async fn close(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut info) = sessions.remove(session_id) {
            if let Some(ref mut backend) = info.serial_backend {
                backend.close();
            }
            true
        } else {
            false
        }
    }

    /// Close all sessions. Called during agent shutdown.
    pub async fn close_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for (_, mut info) in sessions.drain() {
            if let Some(ref mut backend) = info.serial_backend {
                backend.close();
            }
        }
    }

    /// Attach a client to an existing session.
    ///
    /// For serial sessions, replays the buffer and starts forwarding
    /// live output as notifications.
    pub async fn attach(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        if info.status != SessionStatus::Running {
            return Err("Session not running".to_string());
        }

        info.attached = true;
        info.last_activity = Utc::now();

        if let Some(ref backend) = info.serial_backend {
            backend.attach().map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    /// Detach the client from a session.
    pub async fn detach(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        info.attached = false;
        info.last_activity = Utc::now();

        if let Some(ref backend) = info.serial_backend {
            backend.detach();
        }

        Ok(())
    }

    /// Write input data to a session's backend.
    pub async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let info = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        info.last_activity = Utc::now();

        if let Some(ref backend) = info.serial_backend {
            backend.write_input(data).map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    /// Return the number of sessions with status `Running`.
    pub async fn active_count(&self) -> u32 {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .filter(|s| s.status == SessionStatus::Running)
            .count() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_notification_tx() -> NotificationSender {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        tx
    }

    #[tokio::test]
    async fn create_and_list() {
        let mgr = SessionManager::new(test_notification_tx());
        let snapshot = mgr
            .create(
                SessionType::Shell,
                "Test shell".to_string(),
                json!({"shell": "/bin/bash"}),
            )
            .await
            .unwrap();

        assert_eq!(snapshot.title, "Test shell");
        assert_eq!(snapshot.session_type, SessionType::Shell);
        assert_eq!(snapshot.status, SessionStatus::Running);
        assert!(!snapshot.attached);

        let list = mgr.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, snapshot.id);
    }

    #[tokio::test]
    async fn close_existing_session() {
        let mgr = SessionManager::new(test_notification_tx());
        // Use Shell type since serial requires a real port
        let snapshot = mgr
            .create(
                SessionType::Shell,
                "Shell test".to_string(),
                json!({"shell": "/bin/bash"}),
            )
            .await
            .unwrap();

        assert!(mgr.close(&snapshot.id).await);
        assert!(mgr.list().await.is_empty());
    }

    #[tokio::test]
    async fn close_nonexistent_returns_false() {
        let mgr = SessionManager::new(test_notification_tx());
        assert!(!mgr.close("nonexistent-id").await);
    }

    #[tokio::test]
    async fn active_count() {
        let mgr = SessionManager::new(test_notification_tx());
        assert_eq!(mgr.active_count().await, 0);

        mgr.create(SessionType::Shell, "s1".to_string(), json!({}))
            .await
            .unwrap();
        mgr.create(SessionType::Shell, "s2".to_string(), json!({}))
            .await
            .unwrap();

        assert_eq!(mgr.active_count().await, 2);
    }

    #[tokio::test]
    async fn session_limit_enforced() {
        let mgr = SessionManager::new(test_notification_tx());

        for i in 0..MAX_SESSIONS {
            let result = mgr
                .create(SessionType::Shell, format!("session-{i}"), json!({}))
                .await;
            assert!(result.is_ok(), "Session {i} should succeed");
        }

        let result = mgr
            .create(SessionType::Shell, "overflow".to_string(), json!({}))
            .await;
        assert!(
            matches!(result, Err(SessionCreateError::LimitReached)),
            "Should hit session limit"
        );
    }

    #[tokio::test]
    async fn create_sets_timestamps() {
        let mgr = SessionManager::new(test_notification_tx());
        let before = Utc::now();
        let snapshot = mgr
            .create(SessionType::Shell, "ts-test".to_string(), json!({}))
            .await
            .unwrap();
        let after = Utc::now();

        assert!(snapshot.created_at >= before && snapshot.created_at <= after);
        assert_eq!(snapshot.created_at, snapshot.last_activity);
    }

    #[tokio::test]
    async fn create_generates_unique_ids() {
        let mgr = SessionManager::new(test_notification_tx());
        let a = mgr
            .create(SessionType::Shell, "a".to_string(), json!({}))
            .await
            .unwrap();
        let b = mgr
            .create(SessionType::Shell, "b".to_string(), json!({}))
            .await
            .unwrap();
        assert_ne!(a.id, b.id);
    }

    #[tokio::test]
    async fn attach_not_found() {
        let mgr = SessionManager::new(test_notification_tx());
        let result = mgr.attach("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn detach_not_found() {
        let mgr = SessionManager::new(test_notification_tx());
        let result = mgr.detach("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn write_input_not_found() {
        let mgr = SessionManager::new(test_notification_tx());
        let result = mgr.write_input("nonexistent", b"hello").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn attach_and_detach_shell_session() {
        let mgr = SessionManager::new(test_notification_tx());
        let snapshot = mgr
            .create(SessionType::Shell, "test".to_string(), json!({}))
            .await
            .unwrap();

        // Attach succeeds (shell sessions have no backend, so it's a no-op)
        mgr.attach(&snapshot.id).await.unwrap();
        let list = mgr.list().await;
        assert!(list[0].attached);

        // Detach succeeds
        mgr.detach(&snapshot.id).await.unwrap();
        let list = mgr.list().await;
        assert!(!list[0].attached);
    }

    #[tokio::test]
    async fn close_all_clears_sessions() {
        let mgr = SessionManager::new(test_notification_tx());
        mgr.create(SessionType::Shell, "s1".to_string(), json!({}))
            .await
            .unwrap();
        mgr.create(SessionType::Shell, "s2".to_string(), json!({}))
            .await
            .unwrap();
        assert_eq!(mgr.list().await.len(), 2);

        mgr.close_all().await;
        assert!(mgr.list().await.is_empty());
    }
}
