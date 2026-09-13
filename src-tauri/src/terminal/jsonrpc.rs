//! JSON-RPC 2.0 message parsing for communicating with the termihub-agent.
//!
//! Messages are exchanged as newline-delimited JSON (NDJSON) lines over
//! an SSH exec channel running `termihub-agent --stdio`.

use serde_json::Value;

/// A parsed incoming JSON-RPC 2.0 message.
#[derive(Debug)]
pub enum JsonRpcMessage {
    /// A successful response with a result.
    Response { id: u64, result: Value },
    /// An error response.
    Error { id: u64, message: String },
    /// A server-initiated notification (no id).
    Notification { method: String, params: Value },
}

/// Parse a single NDJSON line into a `JsonRpcMessage`.
///
/// Distinguishes between response, error, and notification by the
/// presence of `id`, `result`, `error`, and `method` fields.
pub fn parse_message(line: &str) -> Result<JsonRpcMessage, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("Invalid JSON: {}", e))?;

    let obj = v.as_object().ok_or("Expected JSON object")?;

    if let Some(id_val) = obj.get("id") {
        let id = id_val.as_u64().ok_or("Expected numeric id")?;

        if let Some(error) = obj.get("error") {
            let error_obj = error.as_object().ok_or("Expected error object")?;
            let message = error_obj
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            return Ok(JsonRpcMessage::Error { id, message });
        }

        let result = obj.get("result").cloned().unwrap_or(Value::Null);
        return Ok(JsonRpcMessage::Response { id, result });
    }

    // No id — must be a notification
    let method = obj
        .get("method")
        .and_then(|m| m.as_str())
        .ok_or("Notification missing method")?
        .to_string();
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    Ok(JsonRpcMessage::Notification { method, params })
}

/// Outcome of inspecting a message received while waiting for the response to
/// a specific request id (used during the `initialize` handshake).
#[derive(Debug, PartialEq)]
pub enum HandshakeOutcome {
    /// The successful response to our request — carries the `result` value.
    Response(Value),
    /// An error response to our request — carries the error message.
    Rejected(String),
    /// A notification that arrived before our response. It is not the init
    /// response, but it must not be lost: the caller buffers it and replays it
    /// once `initialize` completes (#1660). Previously these were dropped, so an
    /// agent notification emitted during the handshake window (e.g. a staged
    /// `agent.update_available` sent on attach) was silently discarded.
    Buffer { method: String, params: Value },
    /// Some other message (a reply for a different id) that arrived before our
    /// response. Skip it and keep waiting.
    Skip,
}

/// Decide how to handle `msg` while waiting for the response to `request_id`.
///
/// The agent may emit notifications before it answers `initialize` — for
/// example, output from a session it recovered on startup, or an
/// `agent.update_available` notice for a staged update. Those must not be
/// mistaken for the initialize response (which previously surfaced as
/// "Unexpected response to initialize" and failed the connection), but they
/// also must not be dropped: they are returned as [`HandshakeOutcome::Buffer`]
/// so the caller can replay them once init completes (#1660).
pub fn classify_handshake_message(msg: JsonRpcMessage, request_id: u64) -> HandshakeOutcome {
    match msg {
        JsonRpcMessage::Response { id, result } if id == request_id => {
            HandshakeOutcome::Response(result)
        }
        JsonRpcMessage::Error { id, message } if id == request_id => {
            HandshakeOutcome::Rejected(message)
        }
        JsonRpcMessage::Notification { method, params } => {
            HandshakeOutcome::Buffer { method, params }
        }
        _ => HandshakeOutcome::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_response() {
        let line = r#"{"jsonrpc":"2.0","result":{"version":"0.1.0"},"id":1}"#;
        match parse_message(line).unwrap() {
            JsonRpcMessage::Response { id, result } => {
                assert_eq!(id, 1);
                assert_eq!(result["version"], "0.1.0");
            }
            _ => panic!("Expected Response"),
        }
    }

    #[test]
    fn parse_error() {
        let line =
            r#"{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":2}"#;
        match parse_message(line).unwrap() {
            JsonRpcMessage::Error { id, message } => {
                assert_eq!(id, 2);
                assert_eq!(message, "Method not found");
            }
            _ => panic!("Expected Error"),
        }
    }

    #[test]
    fn parse_notification() {
        let line = r#"{"jsonrpc":"2.0","method":"connection.output","params":{"sessionId":"abc","data":"aGVsbG8="}}"#;
        match parse_message(line).unwrap() {
            JsonRpcMessage::Notification { method, params } => {
                assert_eq!(method, "connection.output");
                assert_eq!(params["sessionId"], "abc");
            }
            _ => panic!("Expected Notification"),
        }
    }

    #[test]
    fn parse_invalid_json() {
        let result = parse_message("not json");
        assert!(result.is_err());
    }

    #[test]
    fn classify_accepts_matching_response() {
        let msg = JsonRpcMessage::Response {
            id: 1,
            result: serde_json::json!({"ok": true}),
        };
        match classify_handshake_message(msg, 1) {
            HandshakeOutcome::Response(result) => assert_eq!(result["ok"], true),
            other => panic!("Expected Response, got {other:?}"),
        }
    }

    #[test]
    fn classify_rejects_matching_error() {
        let msg = JsonRpcMessage::Error {
            id: 1,
            message: "bad params".into(),
        };
        assert_eq!(
            classify_handshake_message(msg, 1),
            HandshakeOutcome::Rejected("bad params".to_string())
        );
    }

    #[test]
    fn classify_buffers_notification_before_response() {
        // Regression for #1660: a notification arriving before the agent answers
        // `initialize` must not be mistaken for the initialize response, but it
        // must also not be dropped — it is buffered for replay after init. This
        // covers both a recovered-session `connection.output` and an
        // `agent.update_available` notice staged on attach.
        let msg = JsonRpcMessage::Notification {
            method: "agent.update_available".into(),
            params: serde_json::json!({"availableVersion": "1.2.3", "staged": true}),
        };
        assert_eq!(
            classify_handshake_message(msg, 1),
            HandshakeOutcome::Buffer {
                method: "agent.update_available".into(),
                params: serde_json::json!({"availableVersion": "1.2.3", "staged": true}),
            }
        );
    }

    #[test]
    fn classify_skips_reply_for_other_id() {
        let msg = JsonRpcMessage::Response {
            id: 2,
            result: Value::Null,
        };
        assert_eq!(classify_handshake_message(msg, 1), HandshakeOutcome::Skip);
    }
}
