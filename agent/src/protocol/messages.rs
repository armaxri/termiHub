// Notification type is not used in the stub but will be needed for
// session.output, session.exit, and session.error notifications in phase 7.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC 2.0 request (Desktop -> Agent).
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub id: Value,
}

/// A successful JSON-RPC 2.0 response (Agent -> Desktop).
#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub result: Value,
    pub id: Value,
}

impl JsonRpcResponse {
    pub fn new(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            result,
            id,
        }
    }
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcErrorData {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A JSON-RPC 2.0 error response (Agent -> Desktop).
#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: &'static str,
    pub error: JsonRpcErrorData,
    pub id: Value,
}

impl JsonRpcErrorResponse {
    pub fn new(id: Value, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            error: JsonRpcErrorData {
                code,
                message: message.into(),
                data: None,
            },
            id,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.error.data = Some(data);
        self
    }
}

/// A JSON-RPC 2.0 notification (Agent -> Desktop, no id).
#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0",
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
    fn deserialize_request() {
        let json_str = r#"{"jsonrpc":"2.0","method":"initialize","params":{"protocol_version":"0.1.0"},"id":1}"#;
        let req: JsonRpcRequest = serde_json::from_str(json_str).unwrap();
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.method, "initialize");
        assert_eq!(req.id, json!(1));
        assert_eq!(req.params["protocol_version"], "0.1.0");
    }

    #[test]
    fn deserialize_request_without_params() {
        let json_str = r#"{"jsonrpc":"2.0","method":"health.check","id":5}"#;
        let req: JsonRpcRequest = serde_json::from_str(json_str).unwrap();
        assert_eq!(req.method, "health.check");
        assert!(req.params.is_null());
    }

    #[test]
    fn serialize_success_response() {
        let resp = JsonRpcResponse::new(json!(1), json!({"status": "ok"}));
        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["result"]["status"], "ok");
        assert_eq!(parsed["id"], 1);
        // Should not have an "error" field
        assert!(parsed.get("error").is_none());
    }

    #[test]
    fn serialize_error_response() {
        let resp = JsonRpcErrorResponse::new(json!(2), -32601, "Method not found");
        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["error"]["code"], -32601);
        assert_eq!(parsed["error"]["message"], "Method not found");
        assert!(parsed["error"].get("data").is_none());
        assert_eq!(parsed["id"], 2);
    }

    #[test]
    fn serialize_error_response_with_data() {
        let resp = JsonRpcErrorResponse::new(json!(3), -32001, "Session not found")
            .with_data(json!({"session_id": "abc-123"}));
        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["error"]["data"]["session_id"], "abc-123");
    }

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
        // Notifications must NOT have an "id" field
        assert!(parsed.get("id").is_none());
    }

    #[test]
    fn response_round_trip_preserves_id_types() {
        // Integer id
        let resp = JsonRpcResponse::new(json!(42), json!({}));
        let s = serde_json::to_string(&resp).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["id"], 42);

        // String id
        let resp = JsonRpcResponse::new(json!("req-1"), json!({}));
        let s = serde_json::to_string(&resp).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["id"], "req-1");
    }
}
