//! JSON-RPC 2.0 notification type for the termiHub protocol.

use std::any::Any;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// An opaque guard carried alongside a notification and dropped with it.
pub type ReleaseGuard = Arc<dyn Any + Send + Sync>;

/// A JSON-RPC 2.0 notification (Agent -> Desktop, no id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
    /// Never serialized: a guard released when the notification is dropped —
    /// once the transport wrote it, or discarded it because the connection
    /// closed. The agent hangs a session's output credit here, so bytes queued
    /// for the transport are counted until they actually leave (#4439).
    #[serde(skip)]
    release: Option<ReleaseGuard>,
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            method: method.into(),
            params,
            release: None,
        }
    }

    /// Attach a guard that is dropped together with this notification.
    #[must_use]
    pub fn with_release_guard(mut self, guard: ReleaseGuard) -> Self {
        self.release = Some(guard);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serialize_notification() {
        let notif = JsonRpcNotification::new(
            "session.output",
            json!({"session_id": "abc", "data": "aGVsbG8="}),
        );
        let json_str = serde_json::to_string(&notif).unwrap();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["method"], "session.output");
        assert_eq!(parsed["params"]["session_id"], "abc");
        assert!(parsed.get("id").is_none());
    }

    #[test]
    fn release_guard_is_not_serialized_and_drops_with_the_notification() {
        let guard: Arc<()> = Arc::new(());
        let notif = JsonRpcNotification::new("x", json!({}))
            .with_release_guard(guard.clone() as ReleaseGuard);
        assert_eq!(Arc::strong_count(&guard), 2);
        let parsed: Value = serde_json::to_value(&notif).unwrap();
        assert!(parsed.get("release").is_none());
        drop(notif);
        assert_eq!(Arc::strong_count(&guard), 1);
    }
}
