//! Single source of truth for the built-in network-tool Tauri events (DUP-027).
//!
//! The desktop surfaces streaming network diagnostics (port scan, ping,
//! traceroute, ping sweep) to the frontend as Tauri events. Those results reach
//! the frontend down **two** backend paths that must be indistinguishable:
//!
//! - the **local** path — [`crate::commands::network`] runs the
//!   [`termihub_core::network`] function directly and emits per-result events;
//! - the **agent-proxy** path — [`crate::network::agent_tools`] proxies the tool
//!   to a remote agent's `network.*` RPC and re-emits its batched reply as the
//!   *same* events.
//!
//! Before this module each path re-declared every event name and payload shape
//! inline, so the two copies had to be kept byte-identical by hand. The event
//! **names** and **payload shapes** now live here once; both paths emit through
//! these helpers, so the wire contract cannot drift between them.
//!
//! This shaping is Tauri-specific (it needs an [`AppHandle`]), so it lives in the
//! desktop crate rather than in the transport-agnostic `termihub_core::network`.
//! The payload builders are pure and unit-tested to lock the exact wire shape.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use termihub_core::network::PortScanResult;

/// Event names for the built-in network tools. Single-sourced so the frontend
/// listener names and both backend emit paths cannot diverge.
pub mod name {
    /// Port scan: one per probed port — `{ taskId, host, port, state, latencyMs? }`.
    pub const SCAN_RESULT: &str = "network-scan-result";
    /// Port scan completion — `{ taskId, summary }`.
    pub const SCAN_COMPLETE: &str = "network-scan-complete";
    /// Port scan failure — `{ taskId, error }`.
    pub const SCAN_ERROR: &str = "network-scan-error";

    /// Ping: one per echo — `{ taskId, result }`.
    pub const PING_RESULT: &str = "network-ping-result";
    /// Ping completion — `{ taskId, stats, canceled }`.
    pub const PING_COMPLETE: &str = "network-ping-complete";
    /// Ping failure — `{ taskId, error }`.
    pub const PING_ERROR: &str = "network-ping-error";

    /// Ping sweep: one per responding host — `{ taskId, host, latencyMs?, hostname? }`.
    pub const SWEEP_RESULT: &str = "network-sweep-result";
    /// Ping sweep completion — `{ taskId, summary, canceled }`.
    pub const SWEEP_COMPLETE: &str = "network-sweep-complete";
    /// Ping sweep failure — `{ taskId, error }`.
    pub const SWEEP_ERROR: &str = "network-sweep-error";

    /// Traceroute: one per hop — `{ taskId, hop }`.
    pub const TRACEROUTE_HOP: &str = "network-traceroute-hop";
    /// Traceroute completion — `{ taskId }`.
    pub const TRACEROUTE_COMPLETE: &str = "network-traceroute-complete";
    /// Traceroute failure — `{ taskId, error }`.
    pub const TRACEROUTE_ERROR: &str = "network-traceroute-error";
}

// ── Pure payload builders (unit-tested; the wire shape lives here) ────────────

/// `network-scan-result` payload — a single probed port.
pub fn scan_result_payload(task_id: &str, result: &PortScanResult) -> Value {
    json!({
        "taskId": task_id,
        "host": result.host,
        "port": result.port,
        "state": result.state,
        "latencyMs": result.latency_ms,
    })
}

/// `network-scan-complete` payload — the run summary.
pub fn scan_complete_payload(task_id: &str, summary: impl Serialize) -> Value {
    json!({ "taskId": task_id, "summary": summary })
}

/// `network-ping-result` payload — a single echo.
pub fn ping_result_payload(task_id: &str, result: impl Serialize) -> Value {
    json!({ "taskId": task_id, "result": result })
}

/// `network-ping-complete` payload — the aggregate stats plus cancellation flag.
pub fn ping_complete_payload(task_id: &str, stats: impl Serialize, canceled: bool) -> Value {
    json!({ "taskId": task_id, "stats": stats, "canceled": canceled })
}

/// `network-sweep-result` payload — a single responding host.
pub fn sweep_result_payload(
    task_id: &str,
    host: impl Serialize,
    latency_ms: impl Serialize,
    hostname: impl Serialize,
) -> Value {
    json!({
        "taskId": task_id,
        "host": host,
        "latencyMs": latency_ms,
        "hostname": hostname,
    })
}

/// `network-sweep-complete` payload — the run summary plus cancellation flag.
pub fn sweep_complete_payload(task_id: &str, summary: impl Serialize, canceled: bool) -> Value {
    json!({ "taskId": task_id, "summary": summary, "canceled": canceled })
}

/// `network-traceroute-hop` payload — a single hop.
pub fn traceroute_hop_payload(task_id: &str, hop: impl Serialize) -> Value {
    json!({ "taskId": task_id, "hop": hop })
}

/// `network-traceroute-complete` payload — carries only the task id.
pub fn traceroute_complete_payload(task_id: &str) -> Value {
    json!({ "taskId": task_id })
}

/// The shared `{ taskId, error }` payload used by every network-tool `*-error`
/// event.
pub fn error_payload(task_id: &str, error: &str) -> Value {
    json!({ "taskId": task_id, "error": error })
}

// ── Thin emit wrappers (used by both the local and agent-proxy paths) ─────────

/// Emit `network-scan-result` for a single probed port.
pub fn emit_scan_result(app: &AppHandle, task_id: &str, result: &PortScanResult) {
    let _ = app.emit(name::SCAN_RESULT, scan_result_payload(task_id, result));
}

/// Emit `network-scan-complete` with the run summary.
pub fn emit_scan_complete(app: &AppHandle, task_id: &str, summary: impl Serialize) {
    let _ = app.emit(name::SCAN_COMPLETE, scan_complete_payload(task_id, summary));
}

/// Emit `network-ping-result` for a single echo.
pub fn emit_ping_result(app: &AppHandle, task_id: &str, result: impl Serialize) {
    let _ = app.emit(name::PING_RESULT, ping_result_payload(task_id, result));
}

/// Emit `network-ping-complete` with the aggregate stats and cancellation flag.
pub fn emit_ping_complete(app: &AppHandle, task_id: &str, stats: impl Serialize, canceled: bool) {
    let _ = app.emit(
        name::PING_COMPLETE,
        ping_complete_payload(task_id, stats, canceled),
    );
}

/// Emit `network-sweep-result` for a single responding host.
pub fn emit_sweep_result(
    app: &AppHandle,
    task_id: &str,
    host: impl Serialize,
    latency_ms: impl Serialize,
    hostname: impl Serialize,
) {
    let _ = app.emit(
        name::SWEEP_RESULT,
        sweep_result_payload(task_id, host, latency_ms, hostname),
    );
}

/// Emit `network-sweep-complete` with the run summary and cancellation flag.
pub fn emit_sweep_complete(
    app: &AppHandle,
    task_id: &str,
    summary: impl Serialize,
    canceled: bool,
) {
    let _ = app.emit(
        name::SWEEP_COMPLETE,
        sweep_complete_payload(task_id, summary, canceled),
    );
}

/// Emit `network-traceroute-hop` for a single hop.
pub fn emit_traceroute_hop(app: &AppHandle, task_id: &str, hop: impl Serialize) {
    let _ = app.emit(name::TRACEROUTE_HOP, traceroute_hop_payload(task_id, hop));
}

/// Emit `network-traceroute-complete`.
pub fn emit_traceroute_complete(app: &AppHandle, task_id: &str) {
    let _ = app.emit(
        name::TRACEROUTE_COMPLETE,
        traceroute_complete_payload(task_id),
    );
}

/// Emit one of the network-tool `*-error` events with the shared error payload.
///
/// The event name is passed explicitly (from [`name`]) so a caller emits the
/// error variant matching the tool it was running.
pub fn emit_error(app: &AppHandle, event: &str, task_id: &str, error: &str) {
    let _ = app.emit(event, error_payload(task_id, error));
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::network::{PortScanSummary, PortState};

    #[test]
    fn scan_result_shape_is_stable() {
        let r = PortScanResult {
            host: "10.0.0.1".into(),
            port: 22,
            state: PortState::Open,
            latency_ms: Some(3),
        };
        let p = scan_result_payload("task-1", &r);
        assert_eq!(p["taskId"], "task-1");
        assert_eq!(p["host"], "10.0.0.1");
        assert_eq!(p["port"], 22);
        assert_eq!(p["state"], "open"); // PortState serializes camelCase
        assert_eq!(p["latencyMs"], 3);
        // Exactly these keys — a stray/renamed field would break the frontend.
        let obj = p.as_object().unwrap();
        assert_eq!(obj.len(), 5);
        assert!(["taskId", "host", "port", "state", "latencyMs"]
            .iter()
            .all(|k| obj.contains_key(*k)));
    }

    #[test]
    fn scan_complete_shape_is_stable() {
        let summary = PortScanSummary {
            total: 2,
            open: 1,
            closed: 1,
            filtered: 0,
            elapsed_ms: 5,
        };
        let p = scan_complete_payload("task-2", &summary);
        assert_eq!(p["taskId"], "task-2");
        assert_eq!(p["summary"]["total"], 2);
        assert_eq!(p["summary"]["open"], 1);
        assert_eq!(p["summary"]["elapsedMs"], 5);
        // The agent path passes the summary as an opaque `Value`; it must shape
        // identically to the typed local path.
        let via_value = scan_complete_payload("task-2", json!({ "total": 2, "open": 1 }));
        assert_eq!(via_value["summary"]["total"], 2);
    }

    #[test]
    fn ping_result_and_complete_shapes_are_stable() {
        let p = ping_result_payload("t", json!({ "seq": 1, "latencyMs": 4 }));
        assert_eq!(p["taskId"], "t");
        assert_eq!(p["result"]["seq"], 1);

        let done = ping_complete_payload("t", json!({ "sent": 4, "received": 4 }), false);
        assert_eq!(done["taskId"], "t");
        assert_eq!(done["stats"]["sent"], 4);
        assert_eq!(done["canceled"], false);
        let obj = done.as_object().unwrap();
        assert_eq!(obj.len(), 3);
    }

    #[test]
    fn sweep_shapes_are_stable() {
        let p = sweep_result_payload("t", "10.0.0.5", Some(7u64), Some("host.lan"));
        assert_eq!(p["taskId"], "t");
        assert_eq!(p["host"], "10.0.0.5");
        assert_eq!(p["latencyMs"], 7);
        assert_eq!(p["hostname"], "host.lan");

        let done = sweep_complete_payload("t", json!({ "total": 3, "up": 1 }), true);
        assert_eq!(done["summary"]["total"], 3);
        assert_eq!(done["canceled"], true);
    }

    #[test]
    fn traceroute_shapes_are_stable() {
        let hop = traceroute_hop_payload("t", json!({ "ttl": 1, "host": "gw" }));
        assert_eq!(hop["taskId"], "t");
        assert_eq!(hop["hop"]["ttl"], 1);

        let done = traceroute_complete_payload("t");
        assert_eq!(done["taskId"], "t");
        assert_eq!(done.as_object().unwrap().len(), 1);
    }

    #[test]
    fn error_shape_is_stable() {
        let p = error_payload("t", "boom");
        assert_eq!(p["taskId"], "t");
        assert_eq!(p["error"], "boom");
        assert_eq!(p.as_object().unwrap().len(), 2);
    }
}
