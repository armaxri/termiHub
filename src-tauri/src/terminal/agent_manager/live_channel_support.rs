//! Raw agent-channel JSON-RPC helpers shared by the live agent tests: the
//! local-sshd reconnect tests (`russh_reconnect_tests`, Unix) and the Windows
//! SSH-host lane (`windows_ssh_host_tests`, #3684).

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::Value;

use super::{read_handshake_line, serialize_request};
use crate::terminal::jsonrpc;

/// Drive a single JSON-RPC request over the raw agent channel and return its
/// matching response `result` (ignoring interleaved notifications). This is
/// the redrive's `connection.create`/`attach` path exercised over the real
/// re-established transport.
pub(super) async fn channel_rpc(
    channel: &mut russh::Channel<russh::client::Msg>,
    request_id: &mut u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    *request_id += 1;
    let id = *request_id;
    let line = serialize_request(id, method, params)?;
    channel
        .data(line.as_bytes())
        .await
        .map_err(|e| format!("write {method}: {e}"))?;
    let mut buf = String::new();
    loop {
        let resp = read_handshake_line(channel, "test-agent", &mut buf)
            .await
            .ok_or_else(|| format!("channel closed before {method} response"))?;
        if resp.is_empty() {
            continue;
        }
        match jsonrpc::parse_message(&resp) {
            Ok(jsonrpc::JsonRpcMessage::Response { id: rid, result }) if rid == id => {
                return Ok(result)
            }
            Ok(jsonrpc::JsonRpcMessage::Error {
                id: rid, message, ..
            }) if rid == id => return Err(message),
            _ => continue,
        }
    }
}

/// Read `connection.output` notifications off the channel until one decodes to
/// text containing `needle`, or the deadline passes. Proves the session is
/// genuinely usable (input → PTY echo → notification), not merely created.
///
/// Only the Unix local-sshd reconnect tests (`russh_reconnect_tests`, itself
/// `cfg(all(test, unix))`) use it, so it is Unix-only to keep the Windows
/// build free of dead code.
#[cfg(unix)]
pub(super) async fn wait_for_output(
    channel: &mut russh::Channel<russh::client::Msg>,
    needle: &str,
    deadline: Instant,
) -> bool {
    let mut buf = String::new();
    while Instant::now() < deadline {
        let read = tokio::time::timeout(
            Duration::from_millis(500),
            read_handshake_line(channel, "test-agent", &mut buf),
        )
        .await;
        match read {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                    jsonrpc::parse_message(&line)
                {
                    if method == "connection.output" {
                        if let Some(data) = params["data"].as_str() {
                            if let Ok(bytes) = B64.decode(data) {
                                if String::from_utf8_lossy(&bytes).contains(needle) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            Ok(None) => return false, // channel closed
            Err(_) => continue,       // read timeout — re-check the deadline
        }
    }
    false
}

/// Read `connection.output` notifications off the channel, tracking the highest
/// `TICK=<n>` counter value seen, and return it once `want(max)` holds — else the
/// last-seen max (or `None`) at the deadline.
///
/// The counter loop prints `TICK=$i`; only *executed* output (`TICK=0`,
/// `TICK=1`, …) carries a digit, while the one-time keystroke echo of the
/// command line contains the literal `TICK=$i` (no digit) — so the echoed
/// command can never be mistaken for a counter value.
pub(super) async fn read_counter_until(
    channel: &mut russh::Channel<russh::client::Msg>,
    want: impl Fn(u64) -> bool,
    deadline: Instant,
) -> Option<u64> {
    let mut buf = String::new();
    let mut max: Option<u64> = None;
    while Instant::now() < deadline {
        let read = tokio::time::timeout(
            Duration::from_millis(500),
            read_handshake_line(channel, "test-agent", &mut buf),
        )
        .await;
        match read {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                    jsonrpc::parse_message(&line)
                {
                    if method == "connection.output" {
                        if let Some(data) = params["data"].as_str() {
                            if let Ok(bytes) = B64.decode(data) {
                                let text = String::from_utf8_lossy(&bytes);
                                for tail in text.split("TICK=").skip(1) {
                                    let digits: String =
                                        tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                                    if let Ok(v) = digits.parse::<u64>() {
                                        max = Some(max.map_or(v, |m| m.max(v)));
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(m) = max {
                    if want(m) {
                        return Some(m);
                    }
                }
            }
            Ok(None) => return max, // channel closed
            Err(_) => continue,     // read timeout — re-check the deadline
        }
    }
    max
}
