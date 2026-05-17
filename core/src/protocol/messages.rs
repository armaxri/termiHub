//! JSON-RPC 2.0 notification type for the termiHub protocol.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC 2.0 notification (Agent -> Desktop, no id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            method: method.into(),
            params,
        }
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
}
