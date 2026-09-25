//! Route desktop network-tool invocations to a remote agent (#2190).
//!
//! Part of the stateless-UI / agent-empowerment S-track (S2, part of #2154).
//! When a network tool's run-location resolves to an agent — via the S1
//! [`RunLocationResolver`](crate::run_location::RunLocationResolver) — the desktop
//! does **not** run the local `termihub_core::network` path. It proxies the call
//! to the agent's existing `network.*` JSON-RPC methods and re-emits the results
//! as the *same* Tauri events the local path emits, so the frontend cannot tell
//! where a tool ran. This mirrors the embedded-server (#2214) and tunnel (#2187)
//! run-location wiring.
//!
//! The agent's `network.*` methods are **collect-and-return** — they gather every
//! result before replying — so a streaming desktop tool (port scan, ping,
//! traceroute) fans the agent's one batched reply back out as per-item events
//! followed by the completion event. The result surface is identical to the
//! local path because both sides serialize the same `termihub_core::network`
//! types (camelCase).
//!
//! Run-location is a **desktop-side preference**: nothing here is baked into the
//! payload sent to the agent — the agent is simply asked to run a network probe
//! from its own vantage.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::AppHandle;

use termihub_core::network::{PingResult, PortScanResult, TracerouteHop};

use crate::network::events;
use crate::run_location::Locality;
use crate::terminal::agent_manager::AgentRpcClient;

/// Run-location preference keys for the built-in network tools (#2190).
///
/// Each key identifies a tool **type** (not an instance) in the desktop-side
/// per-tool run-location preference map on [`NetworkManager`](super::NetworkManager).
pub mod tool {
    /// Ping session — agent-routable (`network.ping`).
    pub const PING: &str = "ping";
    /// Traceroute — agent-routable (`network.traceroute`).
    pub const TRACEROUTE: &str = "traceroute";
    /// TCP port scan — agent-routable (`network.port_scan`).
    pub const PORT_SCAN: &str = "port_scan";
    /// DNS lookup — agent-routable (`network.dns_lookup`).
    pub const DNS: &str = "dns";
    /// Wake-on-LAN — agent-routable (`network.wol`).
    pub const WOL: &str = "wol";
    /// HTTP monitor — **not** a `network.*` tool: it has no batched
    /// collect-and-return agent method. As of #2592 a monitor *can* run on an
    /// agent, but through the per-monitor `service.*` hosting path
    /// ([`NetworkManager::start_agent_monitor`](super::NetworkManager)), not this
    /// per-tool-type network-tool preference. This key stays desktop-only here so
    /// the network-tool selector never offers it an agent over the wrong path.
    pub const HTTP_MONITOR: &str = "http_monitor";
}

/// The [`Locality`] of a network tool (#2190).
///
/// Everything the agent exposes over `network.*` is [`Locality::LocalOrAgent`];
/// the HTTP monitor is [`Locality::DesktopOnly`] because the agent has no
/// HTTP-monitor method, so the resolver must never offer it an agent.
pub fn locality_for(tool: &str) -> Locality {
    match tool {
        tool::HTTP_MONITOR => Locality::DesktopOnly,
        _ => Locality::LocalOrAgent,
    }
}

/// Fallback count for an agent-routed ping given no explicit count (#2190).
///
/// The agent's `network.ping` collects every echo before replying, so an
/// unbounded (`count: None`) request would never return over a single blocking
/// RPC. Bound it to the conventional `ping -c 4` default when the caller gave no
/// count; an explicit count is always honoured.
pub const AGENT_PING_DEFAULT_COUNT: u32 = 4;

// ── Param builders (pure; snake_case, as the agent's serde structs parse) ─────

/// Build `network.port_scan` params.
pub fn port_scan_params(
    host: &str,
    ports: &str,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> Value {
    json!({
        "host": host,
        "ports": ports,
        "timeout_ms": timeout_ms,
        "concurrency": concurrency,
    })
}

/// Build `network.ping` params, bounding an absent count (see
/// [`AGENT_PING_DEFAULT_COUNT`]).
pub fn ping_params(host: &str, interval_ms: Option<u64>, count: Option<u32>) -> Value {
    json!({
        "host": host,
        "interval_ms": interval_ms,
        "count": count.unwrap_or(AGENT_PING_DEFAULT_COUNT),
    })
}

/// Build `network.traceroute` params.
pub fn traceroute_params(host: &str, max_hops: Option<u8>) -> Value {
    json!({ "host": host, "max_hops": max_hops })
}

/// Build `network.dns_lookup` params.
pub fn dns_params(hostname: &str, record_type: &str, server: Option<&str>) -> Value {
    json!({ "hostname": hostname, "record_type": record_type, "server": server })
}

/// Build `network.wol` params.
pub fn wol_params(mac: &str, broadcast: &str, port: u16) -> Value {
    json!({ "mac": mac, "broadcast": broadcast, "port": port })
}

// ── Dispatchers (blocking RPC + event re-emission) ────────────────────────────
//
// `AgentRpcClient::send_request` is blocking, so callers run these on a blocking
// thread (`spawn_blocking`). Emission is via the same event names/shapes the
// local desktop path uses, so results surface identically.

/// Proxy a port scan to the agent and fan its batched reply out as the same
/// `network-scan-*` events the local path emits.
pub fn dispatch_port_scan(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
    app: &AppHandle,
    task_id: &str,
    params: Value,
) {
    match client.send_request(
        agent_id,
        termihub_core::protocol::methods::NETWORK_PORT_SCAN,
        params,
    ) {
        Ok(reply) => {
            for r in parse_list::<PortScanResult>(&reply, "results") {
                events::emit_scan_result(app, task_id, &r);
            }
            events::emit_scan_complete(app, task_id, field(&reply, "summary"));
        }
        Err(e) => events::emit_error(app, events::name::SCAN_ERROR, task_id, &e.to_string()),
    }
}

/// Proxy a ping session to the agent and fan its batched reply out as the same
/// `network-ping-*` events the local path emits.
pub fn dispatch_ping(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
    app: &AppHandle,
    task_id: &str,
    params: Value,
) {
    match client.send_request(
        agent_id,
        termihub_core::protocol::methods::NETWORK_PING,
        params,
    ) {
        Ok(reply) => {
            for r in parse_list::<PingResult>(&reply, "results") {
                events::emit_ping_result(app, task_id, r);
            }
            // An agent ping is a fixed-count batch, so it always runs to
            // completion (never "canceled").
            events::emit_ping_complete(app, task_id, field(&reply, "stats"), false);
        }
        Err(e) => events::emit_error(app, events::name::PING_ERROR, task_id, &e.to_string()),
    }
}

/// Proxy a traceroute to the agent and fan its batched reply out as the same
/// `network-traceroute-*` events the local path emits.
pub fn dispatch_traceroute(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
    app: &AppHandle,
    task_id: &str,
    params: Value,
) {
    match client.send_request(
        agent_id,
        termihub_core::protocol::methods::NETWORK_TRACEROUTE,
        params,
    ) {
        Ok(reply) => {
            for hop in parse_list::<TracerouteHop>(&reply, "hops") {
                events::emit_traceroute_hop(app, task_id, hop);
            }
            events::emit_traceroute_complete(app, task_id);
        }
        Err(e) => events::emit_error(app, events::name::TRACEROUTE_ERROR, task_id, &e.to_string()),
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Deserialize `reply[key]` into a `Vec<T>`, defaulting to empty on any
/// missing/unparseable field so a malformed reply degrades to "no results"
/// rather than a panic.
fn parse_list<T: DeserializeOwned>(reply: &Value, key: &str) -> Vec<T> {
    reply
        .get(key)
        .and_then(|v| serde_json::from_value::<Vec<T>>(v.clone()).ok())
        .unwrap_or_default()
}

/// Extract `reply[key]` as an owned [`Value`], or `null` when absent.
fn field(reply: &Value, key: &str) -> Value {
    reply.get(key).cloned().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::protocol::methods::{
        NetworkDnsLookupParams, NetworkPingParams, NetworkPingResponse, NetworkPortScanParams,
        NetworkPortScanResponse, NetworkTracerouteParams, NetworkTracerouteResponse,
        NetworkWolParams,
    };

    // ── DUP-001: shared network.* request/response DTOs ──────────────────
    //
    // The desktop builds every `network.{port_scan,ping,traceroute,dns_lookup,
    // wol}` request from the shared `Network*Params` DTOs and parses the batched
    // reply into the shared `Network*Response` DTOs, instead of hand-building
    // `serde_json::json!` params and reading `Value["key"]`. These tests pin the
    // request wire bytes byte-for-byte against the pre-migration hand-built JSON
    // (a change here is a WIRE BREAK — the agent deserializes them) and prove the
    // reply parse against the exact shape the agent sends.
    //
    // The params are snake_case (`timeout_ms`, `interval_ms`, `record_type`,
    // `max_hops`), which the `Network*Params` field names reproduce with no serde
    // rename; absent optionals keep the key with a `null` value on both sides, so
    // the key set is identical. `serde_json::to_value` and `json!` both back an
    // object with a `BTreeMap` (no `preserve_order`), so key ordering matches too.

    #[test]
    fn port_scan_request_wire_matches_hand_built_json() {
        // Explicit optional values.
        let legacy = json!({
            "host": "host.example",
            "ports": "1-1024",
            "timeout_ms": 2000u64,
            "concurrency": 100usize,
        });
        let typed = serde_json::to_value(NetworkPortScanParams {
            host: "host.example".to_string(),
            ports: "1-1024".to_string(),
            timeout_ms: Some(2000),
            concurrency: Some(100),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed).unwrap(),
            serde_json::to_string(&legacy).unwrap(),
            "port_scan params wire diverged from the hand-built json!"
        );

        // Absent optionals → the key stays with a null value on both sides.
        let legacy_none = json!({
            "host": "h",
            "ports": "22",
            "timeout_ms": Option::<u64>::None,
            "concurrency": Option::<usize>::None,
        });
        let typed_none = serde_json::to_value(NetworkPortScanParams {
            host: "h".to_string(),
            ports: "22".to_string(),
            timeout_ms: None,
            concurrency: None,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed_none).unwrap(),
            serde_json::to_string(&legacy_none).unwrap(),
        );
    }

    #[test]
    fn ping_request_wire_matches_hand_built_json() {
        // The desktop always sends a bounded (present) count and an optional
        // interval; `count` is a bare number, `interval_ms` is null when absent.
        let legacy = json!({
            "host": "h",
            "interval_ms": 1000u64,
            "count": 4u32,
        });
        let typed = serde_json::to_value(NetworkPingParams {
            host: "h".to_string(),
            count: Some(4),
            interval_ms: Some(1000),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed).unwrap(),
            serde_json::to_string(&legacy).unwrap(),
            "ping params wire diverged from the hand-built json!"
        );

        let legacy_no_interval = json!({
            "host": "h",
            "interval_ms": Option::<u64>::None,
            "count": 10u32,
        });
        let typed_no_interval = serde_json::to_value(NetworkPingParams {
            host: "h".to_string(),
            count: Some(10),
            interval_ms: None,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed_no_interval).unwrap(),
            serde_json::to_string(&legacy_no_interval).unwrap(),
        );
    }

    #[test]
    fn traceroute_request_wire_matches_hand_built_json() {
        let legacy = json!({ "host": "h", "max_hops": 20u8 });
        let typed = serde_json::to_value(NetworkTracerouteParams {
            host: "h".to_string(),
            max_hops: Some(20),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed).unwrap(),
            serde_json::to_string(&legacy).unwrap(),
            "traceroute params wire diverged from the hand-built json!"
        );

        let legacy_none = json!({ "host": "h", "max_hops": Option::<u8>::None });
        let typed_none = serde_json::to_value(NetworkTracerouteParams {
            host: "h".to_string(),
            max_hops: None,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed_none).unwrap(),
            serde_json::to_string(&legacy_none).unwrap(),
        );
    }

    #[test]
    fn dns_request_wire_matches_hand_built_json() {
        let legacy = json!({
            "hostname": "example.com",
            "record_type": "A",
            "server": "1.1.1.1",
        });
        let typed = serde_json::to_value(NetworkDnsLookupParams {
            hostname: "example.com".to_string(),
            record_type: "A".to_string(),
            server: Some("1.1.1.1".to_string()),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed).unwrap(),
            serde_json::to_string(&legacy).unwrap(),
            "dns params wire diverged from the hand-built json!"
        );

        let legacy_none = json!({
            "hostname": "example.com",
            "record_type": "AAAA",
            "server": Option::<String>::None,
        });
        let typed_none = serde_json::to_value(NetworkDnsLookupParams {
            hostname: "example.com".to_string(),
            record_type: "AAAA".to_string(),
            server: None,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed_none).unwrap(),
            serde_json::to_string(&legacy_none).unwrap(),
        );
    }

    #[test]
    fn wol_request_wire_matches_hand_built_json() {
        let legacy = json!({
            "mac": "aa:bb:cc:dd:ee:ff",
            "broadcast": "255.255.255.255",
            "port": 9u16,
        });
        let typed = serde_json::to_value(NetworkWolParams {
            mac: "aa:bb:cc:dd:ee:ff".to_string(),
            broadcast: "255.255.255.255".to_string(),
            port: 9,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&typed).unwrap(),
            serde_json::to_string(&legacy).unwrap(),
            "wol params wire diverged from the hand-built json!"
        );
    }

    #[test]
    fn port_scan_response_parses_agent_reply() {
        // The exact `{results, summary}` shape `handle_port_scan` sends.
        let reply = json!({
            "results": [
                { "host": "10.0.0.1", "port": 22, "state": "open", "latencyMs": 3 }
            ],
            "summary": { "total": 1, "open": 1, "closed": 0, "filtered": 0, "elapsedMs": 5 }
        });
        let parsed: NetworkPortScanResponse = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].host, "10.0.0.1");
        assert_eq!(parsed.results[0].port, 22);
        assert_eq!(parsed.results[0].latency_ms, Some(3));
        assert_eq!(parsed.summary.total, 1);
        assert_eq!(parsed.summary.open, 1);
        assert_eq!(parsed.summary.elapsed_ms, 5);
    }

    #[test]
    fn ping_response_parses_agent_reply() {
        // The exact `{results, stats}` shape `handle_ping` sends.
        let reply = json!({
            "results": [
                { "seq": 0, "latencyMs": 12, "ttl": 56, "timedOut": false, "tcpFallback": false }
            ],
            "stats": {
                "sent": 1, "received": 1, "lossPercent": 0.0,
                "minMs": 12.0, "avgMs": 12.0, "maxMs": 12.0, "jitterMs": 0.0
            }
        });
        let parsed: NetworkPingResponse = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].seq, 0);
        assert_eq!(parsed.results[0].latency_ms, Some(12));
        assert_eq!(parsed.stats.sent, 1);
        assert_eq!(parsed.stats.received, 1);
    }

    #[test]
    fn traceroute_response_parses_agent_reply() {
        // The exact `{hops}` shape `handle_traceroute` sends.
        let reply = json!({
            "hops": [
                { "hop": 1, "host": "gw.local", "ip": "10.0.0.1", "rttMs": [1.0, 1.1, 1.2] }
            ]
        });
        let parsed: NetworkTracerouteResponse = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.hops.len(), 1);
        assert_eq!(parsed.hops[0].hop, 1);
        assert_eq!(parsed.hops[0].host.as_deref(), Some("gw.local"));
        assert_eq!(parsed.hops[0].ip.as_deref(), Some("10.0.0.1"));
        assert_eq!(parsed.hops[0].rtt_ms[0], Some(1.0));
    }

    #[test]
    fn http_monitor_is_desktop_only_every_other_tool_is_routable() {
        assert_eq!(locality_for(tool::HTTP_MONITOR), Locality::DesktopOnly);
        for t in [
            tool::PING,
            tool::TRACEROUTE,
            tool::PORT_SCAN,
            tool::DNS,
            tool::WOL,
        ] {
            assert_eq!(
                locality_for(t),
                Locality::LocalOrAgent,
                "{t} must be routable"
            );
        }
    }

    #[test]
    fn port_scan_params_are_snake_case() {
        let p = port_scan_params("host.example", "1-1024", Some(2000), Some(100));
        assert_eq!(p["host"], "host.example");
        assert_eq!(p["ports"], "1-1024");
        assert_eq!(p["timeout_ms"], 2000);
        assert_eq!(p["concurrency"], 100);
    }

    #[test]
    fn ping_params_bound_an_absent_count() {
        // No count → the agent gets the bounded default, so its collect-and-return
        // ping cannot run forever.
        let p = ping_params("host.example", Some(1000), None);
        assert_eq!(p["count"], AGENT_PING_DEFAULT_COUNT);
        assert_eq!(p["interval_ms"], 1000);
        // An explicit count is honoured verbatim.
        let p = ping_params("host.example", None, Some(10));
        assert_eq!(p["count"], 10);
    }

    #[test]
    fn traceroute_and_dns_and_wol_params_shape() {
        let t = traceroute_params("host.example", Some(20));
        assert_eq!(t["host"], "host.example");
        assert_eq!(t["max_hops"], 20);

        let d = dns_params("example.com", "A", Some("1.1.1.1"));
        assert_eq!(d["hostname"], "example.com");
        assert_eq!(d["record_type"], "A");
        assert_eq!(d["server"], "1.1.1.1");

        let w = wol_params("aa:bb:cc:dd:ee:ff", "255.255.255.255", 9);
        assert_eq!(w["mac"], "aa:bb:cc:dd:ee:ff");
        assert_eq!(w["broadcast"], "255.255.255.255");
        assert_eq!(w["port"], 9);
    }

    #[test]
    fn parse_list_tolerates_missing_and_bad_fields() {
        // Missing key → empty (no panic).
        let empty: Vec<PortScanResult> = parse_list(&json!({}), "results");
        assert!(empty.is_empty());

        // Well-formed agent reply (camelCase, as the shared core type serializes)
        // → parsed into the typed results the local path also emits.
        let reply = json!({
            "results": [
                { "host": "10.0.0.1", "port": 22, "state": "open", "latencyMs": 3 }
            ],
            "summary": { "total": 1, "open": 1, "closed": 0, "filtered": 0, "elapsedMs": 5 }
        });
        let parsed: Vec<PortScanResult> = parse_list(&reply, "results");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].host, "10.0.0.1");
        assert_eq!(parsed[0].port, 22);
        assert_eq!(parsed[0].latency_ms, Some(3));
        // `field` lifts the summary object out for the completion event.
        assert_eq!(field(&reply, "summary")["open"], 1);
        assert_eq!(field(&reply, "missing"), Value::Null);
    }
}
