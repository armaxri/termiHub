use std::collections::HashMap;

use chrono::Utc;
use tokio::sync::Mutex;

use crate::session::types::{SessionInfo, SessionStatus, SessionType};

/// Maximum number of concurrent sessions the agent supports.
pub const MAX_SESSIONS: u32 = 20;

/// In-memory session manager.
///
/// Tracks sessions in a `HashMap` protected by a `tokio::sync::Mutex`
/// so it can be shared across async tasks.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionInfo>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Create a new session and return its info.
    ///
    /// Returns `None` if the session limit has been reached.
    pub async fn create(
        &self,
        session_type: SessionType,
        title: String,
        config: serde_json::Value,
    ) -> Option<SessionInfo> {
        let mut sessions = self.sessions.lock().await;

        if sessions.len() >= MAX_SESSIONS as usize {
            return None;
        }

        let now = Utc::now();
        let info = SessionInfo {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            session_type,
            status: SessionStatus::Running,
            config,
            created_at: now,
            last_activity: now,
            attached: false,
        };

        sessions.insert(info.id.clone(), info.clone());
        Some(info)
    }

    /// List all sessions.
    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().await;
        sessions.values().cloned().collect()
    }

    /// Close (remove) a session by ID.
    ///
    /// Returns `true` if the session was found and removed, `false` otherwise.
    pub async fn close(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(session_id).is_some()
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

    #[tokio::test]
    async fn create_and_list() {
        let mgr = SessionManager::new();
        let info = mgr
            .create(
                SessionType::Shell,
                "Test shell".to_string(),
                json!({"shell": "/bin/bash"}),
            )
            .await
            .unwrap();

        assert_eq!(info.title, "Test shell");
        assert_eq!(info.session_type, SessionType::Shell);
        assert_eq!(info.status, SessionStatus::Running);
        assert!(!info.attached);

        let list = mgr.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, info.id);
    }

    #[tokio::test]
    async fn close_existing_session() {
        let mgr = SessionManager::new();
        let info = mgr
            .create(
                SessionType::Serial,
                "Serial test".to_string(),
                json!({"port": "/dev/ttyUSB0"}),
            )
            .await
            .unwrap();

        assert!(mgr.close(&info.id).await);
        assert!(mgr.list().await.is_empty());
    }

    #[tokio::test]
    async fn close_nonexistent_returns_false() {
        let mgr = SessionManager::new();
        assert!(!mgr.close("nonexistent-id").await);
    }

    #[tokio::test]
    async fn active_count() {
        let mgr = SessionManager::new();
        assert_eq!(mgr.active_count().await, 0);

        mgr.create(SessionType::Shell, "s1".to_string(), json!({}))
            .await;
        mgr.create(SessionType::Shell, "s2".to_string(), json!({}))
            .await;

        assert_eq!(mgr.active_count().await, 2);
    }

    #[tokio::test]
    async fn session_limit_enforced() {
        let mgr = SessionManager::new();

        // Create MAX_SESSIONS sessions
        for i in 0..MAX_SESSIONS {
            let result = mgr
                .create(
                    SessionType::Shell,
                    format!("session-{i}"),
                    json!({}),
                )
                .await;
            assert!(result.is_some(), "Session {i} should succeed");
        }

        // The next one should fail
        let result = mgr
            .create(SessionType::Shell, "overflow".to_string(), json!({}))
            .await;
        assert!(result.is_none(), "Should hit session limit");
    }

    #[tokio::test]
    async fn create_sets_timestamps() {
        let mgr = SessionManager::new();
        let before = Utc::now();
        let info = mgr
            .create(SessionType::Shell, "ts-test".to_string(), json!({}))
            .await
            .unwrap();
        let after = Utc::now();

        assert!(info.created_at >= before && info.created_at <= after);
        assert_eq!(info.created_at, info.last_activity);
    }

    #[tokio::test]
    async fn create_generates_unique_ids() {
        let mgr = SessionManager::new();
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
}
