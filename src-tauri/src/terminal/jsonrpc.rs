//! JSON-RPC 2.0 client helpers for communicating with the termihub-agent.
//!
//! Messages are exchanged as newline-delimited JSON (NDJSON) lines over
//! an SSH exec channel running `termihub-agent --stdio`.

use std::io::{Read, Write};

use serde::Serialize;
use serde_json::Value;

/// An outgoing JSON-RPC 2.0 request.
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
    pub id: u64,
}

/// A parsed incoming JSON-RPC 2.0 message.
#[derive(Debug)]
pub enum JsonRpcMessage {
    /// A successful response with a result.
    Response { id: u64, result: Value },
    /// An error response.
    Error {
        id: u64,
        code: i64,
        message: String,
        data: Option<Value>,
    },
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
        let id = id_val
            .as_u64()
            .ok_or("Expected numeric id")?;

        if let Some(error) = obj.get("error") {
            let error_obj = error.as_object().ok_or("Expected error object")?;
            let code = error_obj
                .get("code")
                .and_then(|c| c.as_i64())
                .unwrap_or(-1);
            let message = error_obj
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            let data = error_obj.get("data").cloned();
            return Ok(JsonRpcMessage::Error {
                id,
                code,
                message,
                data,
            });
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

/// Serialize and write a JSON-RPC request as a single NDJSON line.
pub fn write_request(
    writer: &mut impl Write,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), std::io::Error> {
    let req = JsonRpcRequest {
        jsonrpc: "2.0",
        method: method.to_string(),
        params,
        id,
    };
    let mut line = serde_json::to_string(&req)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    line.push('\n');
    writer.write_all(line.as_bytes())?;
    writer.flush()
}

/// Read bytes one at a time until a newline is found, returning the line.
///
/// This is used during the handshake phase when the SSH channel is in
/// blocking mode. It avoids buffering issues that could occur with a
/// `BufReader` over a non-seekable channel.
pub fn read_line_blocking(reader: &mut impl Read) -> Result<String, std::io::Error> {
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        reader.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            break;
        }
        buf.push(byte[0]);
    }
    String::from_utf8(buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_request() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            method: "initialize".to_string(),
            params: serde_json::json!({"clientName": "termihub"}),
            id: 1,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"method\":\"initialize\""));
        assert!(json.contains("\"id\":1"));
    }

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
            JsonRpcMessage::Error {
                id,
                code,
                message,
                data,
            } => {
                assert_eq!(id, 2);
                assert_eq!(code, -32601);
                assert_eq!(message, "Method not found");
                assert!(data.is_none());
            }
            _ => panic!("Expected Error"),
        }
    }

    #[test]
    fn parse_notification() {
        let line =
            r#"{"jsonrpc":"2.0","method":"session.output","params":{"sessionId":"abc","data":"aGVsbG8="}}"#;
        match parse_message(line).unwrap() {
            JsonRpcMessage::Notification { method, params } => {
                assert_eq!(method, "session.output");
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
    fn read_line_from_mock() {
        let data = b"hello world\n";
        let mut cursor = std::io::Cursor::new(data.to_vec());
        let line = read_line_blocking(&mut cursor).unwrap();
        assert_eq!(line, "hello world");
    }

    #[test]
    fn write_request_format() {
        let mut buf = Vec::new();
        write_request(
            &mut buf,
            42,
            "session.create",
            serde_json::json!({"type": "shell"}),
        )
        .unwrap();
        let output = String::from_utf8(buf).unwrap();
        assert!(output.ends_with('\n'));
        let parsed: Value = serde_json::from_str(output.trim()).unwrap();
        assert_eq!(parsed["id"], 42);
        assert_eq!(parsed["method"], "session.create");
        assert_eq!(parsed["jsonrpc"], "2.0");
    }
}
