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

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use termihub_core::network::defaults;
use termihub_core::network::types::{OpenPort, PingSweepResult, PingSweepSummary};
use termihub_core::protocol::methods::{
    NetworkDnsLookupParams, NetworkPingParams, NetworkPingResponse, NetworkPortScanParams,
    NetworkPortScanResponse, NetworkTracerouteParams, NetworkTracerouteResponse, NetworkWolParams,
};
use termihub_core::tool::ToolEvent;

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
    /// Open (listening) ports — agent-routable (`network.open_ports`, PROD-033).
    /// Routed to an agent it lists the **agent host's** listening ports.
    pub const OPEN_PORTS: &str = "open_ports";
    /// Ping sweep — agent-routable through the generic `tool.run` substrate
    /// (core `ToolRegistry` id `ping_sweep`, PROD-033); there is no dedicated
    /// `network.*` method for it.
    pub const PING_SWEEP: &str = "ping_sweep";
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
/// Everything the agent runs — over `network.*` or `tool.run` — is
/// [`Locality::LocalOrAgent`]; the HTTP monitor is [`Locality::DesktopOnly`]
/// on this per-tool-type path because it has no batched agent method (a monitor
/// is agent-hosted per monitor via `service.*` instead), so the resolver must
/// never offer it an agent here.
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

// ── Param builders (pure; return the shared `core::protocol::methods` DTOs) ────
//
// DUP-001: the desktop and agent share one definition of every `network.*`
// request shape. The builders return the typed param DTO; callers serialize it
// (`serde_json::to_value`) into the `Value` the RPC client sends. The wire bytes
// are pinned byte-for-byte against the old hand-built `json!` in this module's
// tests — the param field names are snake_case with no serde rename, exactly the
// shape the agent deserializes.

/// Build `network.port_scan` params.
pub fn port_scan_params(
    host: &str,
    ports: &str,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> NetworkPortScanParams {
    NetworkPortScanParams {
        host: host.to_string(),
        ports: ports.to_string(),
        timeout_ms,
        concurrency,
    }
}

/// Build `network.ping` params, bounding an absent count (see
/// [`AGENT_PING_DEFAULT_COUNT`]).
pub fn ping_params(host: &str, interval_ms: Option<u64>, count: Option<u32>) -> NetworkPingParams {
    NetworkPingParams {
        host: host.to_string(),
        count: Some(count.unwrap_or(AGENT_PING_DEFAULT_COUNT)),
        interval_ms,
    }
}

/// Build `network.traceroute` params.
pub fn traceroute_params(host: &str, max_hops: Option<u8>) -> NetworkTracerouteParams {
    NetworkTracerouteParams {
        host: host.to_string(),
        max_hops,
    }
}

/// Build `network.dns_lookup` params.
pub fn dns_params(
    hostname: &str,
    record_type: &str,
    server: Option<&str>,
) -> NetworkDnsLookupParams {
    NetworkDnsLookupParams {
        hostname: hostname.to_string(),
        record_type: record_type.to_string(),
        server: server.map(str::to_string),
    }
}

/// Build `network.wol` params.
pub fn wol_params(mac: &str, broadcast: &str, port: u16) -> NetworkWolParams {
    NetworkWolParams {
        mac: mac.to_string(),
        broadcast: broadcast.to_string(),
        port,
    }
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
    params: NetworkPortScanParams,
) {
    let params = match serde_json::to_value(&params) {
        Ok(params) => params,
        Err(e) => {
            events::emit_error(app, events::name::SCAN_ERROR, task_id, &e.to_string());
            return;
        }
    };
    match client.send_request(
        agent_id,
        termihub_core::protocol::methods::NETWORK_PORT_SCAN,
        params,
    ) {
        // Parse the batched reply into the shared `NetworkPortScanResponse` DTO
        // instead of reading `reply["results"]`/`reply["summary"]` by hand
        // (DUP-001); a malformed reply surfaces as a scan error.
        Ok(reply) => match serde_json::from_value::<NetworkPortScanResponse>(reply) {
            Ok(resp) => {
                for r in &resp.results {
                    events::emit_scan_result(app, task_id, r);
                }
                events::emit_scan_complete(app, task_id, resp.summary);
            }
            Err(e) => events::emit_error(app, events::name::SCAN_ERROR, task_id, &e.to_string()),
        },
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
    params: NetworkPingParams,
) {
    let params = match serde_json::to_value(&params) {
        Ok(params) => params,
        Err(e) => {
            events::emit_error(app, events::name::PING_ERROR, task_id, &e.to_string());
            return;
        }
    };
    match client.send_request(
        agent_id,
        termihub_core::protocol::methods::NETWORK_PING,
        params,
    ) {
        // Parse into the shared `NetworkPingResponse` DTO (DUP-001).
        Ok(reply) => match serde_json::from_value::<NetworkPingResponse>(reply) {
            Ok(resp) => {
                for r in resp.results {
                    events::emit_ping_result(app, task_id, r);
                }
                // An agent ping is a fixed-count batch, so it always runs to
                // completion (never "canceled").
                events::emit_ping_complete(app, task_id, resp.stats, false);
            }
            Err(e) => events::emit_error(app, events::name::PING_ERROR, task_id, &e.to_string()),
        },
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
    params: NetworkTracerouteParams,
) {
    let params = match serde_json::to_value(&params) {
        Ok(params) => params,
        Err(e) => {
            events::emit_error(app, events::name::TRACEROUTE_ERROR, task_id, &e.to_string());
            return;
        }
    };
    match client.send_request(
        agent_id,
        termihub_core::protocol::methods::NETWORK_TRACEROUTE,
        params,
    ) {
        // Parse into the shared `NetworkTracerouteResponse` DTO (DUP-001).
        Ok(reply) => match serde_json::from_value::<NetworkTracerouteResponse>(reply) {
            Ok(resp) => {
                for hop in resp.hops {
                    events::emit_traceroute_hop(app, task_id, hop);
                }
                events::emit_traceroute_complete(app, task_id);
            }
            Err(e) => {
                events::emit_error(app, events::name::TRACEROUTE_ERROR, task_id, &e.to_string())
            }
        },
        Err(e) => events::emit_error(app, events::name::TRACEROUTE_ERROR, task_id, &e.to_string()),
    }
}

// ── Open ports (`network.open_ports`, PROD-033) ───────────────────────────────

/// The `network.open_ports` reply: `{ ports: [OpenPort] }`.
///
/// Parsed with a desktop-local mirror of the agent's `NetworkOpenPortsResponse`
/// (that shared DTO is serialize-only); both sides use the same
/// `termihub_core::network::types::OpenPort`, so the element shape is shared.
#[derive(Debug, Deserialize)]
struct OpenPortsReply {
    ports: Vec<OpenPort>,
}

/// Parse a `network.open_ports` reply into the port list the local path
/// returns (a bare array — the frontend cannot tell where it ran).
pub fn parse_open_ports_reply(reply: Value) -> Result<Vec<OpenPort>, serde_json::Error> {
    serde_json::from_value::<OpenPortsReply>(reply).map(|r| r.ports)
}

/// Proxy an open-ports listing to the agent (blocking; run on a blocking
/// thread). Lists the **agent host's** listening ports.
pub fn dispatch_open_ports(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
) -> Result<Vec<OpenPort>, String> {
    let reply = client
        .send_request(
            agent_id,
            termihub_core::protocol::methods::NETWORK_OPEN_PORTS,
            json!({}),
        )
        .map_err(|e| e.to_string())?;
    parse_open_ports_reply(reply).map_err(|e| e.to_string())
}

// ── Ping sweep (`tool.run` → `ping_sweep`, PROD-033) ──────────────────────────

/// The core `ToolRegistry` id the agent runs a ping sweep under.
pub const PING_SWEEP_TOOL_ID: &str = "ping_sweep";

/// Build the camelCase `ping_sweep` tool params (`targets`, `timeoutMs`,
/// `concurrency`, `resolveHostnames`) shared by `tool.run` and the streaming
/// `tool.start` (#3353).
///
/// The desktop expands the target spec itself, so the agent receives the
/// concrete address list, and fills absent optionals with the same defaults the
/// local path uses so both vantages probe identically.
pub fn ping_sweep_tool_params(
    targets: &[String],
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    resolve_hostnames: Option<bool>,
) -> Value {
    json!({
        "targets": targets,
        "timeoutMs": timeout_ms.unwrap_or(defaults::PING_SWEEP_TIMEOUT_MS),
        "concurrency": concurrency.unwrap_or(defaults::PING_SWEEP_CONCURRENCY),
        "resolveHostnames": resolve_hostnames.unwrap_or(defaults::PING_SWEEP_RESOLVE_HOSTNAMES),
    })
}

/// Build the `tool.run` params for an agent ping sweep.
///
/// The sweep has no dedicated `network.*` method; it runs through the agent's
/// generic `tool.run`, whose params are `{ toolId, params }` wrapping
/// [`ping_sweep_tool_params`].
pub fn ping_sweep_tool_run_params(
    targets: &[String],
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    resolve_hostnames: Option<bool>,
) -> Value {
    json!({
        "toolId": PING_SWEEP_TOOL_ID,
        "params": ping_sweep_tool_params(targets, timeout_ms, concurrency, resolve_hostnames),
    })
}

// ── Streaming tool params (`tool.start`, #3353) ───────────────────────────────
//
// The core `ToolRegistry` tools take camelCase params. Absent optionals get the
// local path's defaults, so a streamed agent run probes exactly like a local one.

/// `port_scan` tool params.
pub fn port_scan_tool_params(
    host: &str,
    ports: &str,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> Value {
    json!({
        "host": host,
        "ports": ports,
        "timeoutMs": timeout_ms.unwrap_or(defaults::PORT_SCAN_TIMEOUT_MS),
        "concurrency": concurrency.unwrap_or(defaults::PORT_SCAN_CONCURRENCY),
    })
}

/// `ping` tool params. Unlike the collect-and-return [`ping_params`], an absent
/// count is kept: a streamed ping runs until Stop, exactly like a local one
/// (bounded only by the agent's per-run lifetime cap).
pub fn ping_tool_params(host: &str, interval_ms: Option<u64>, count: Option<u32>) -> Value {
    json!({
        "host": host,
        "intervalMs": interval_ms.unwrap_or(defaults::PING_INTERVAL_MS),
        "count": count,
    })
}

/// `traceroute` tool params.
pub fn traceroute_tool_params(host: &str, max_hops: Option<u8>) -> Value {
    json!({
        "host": host,
        "maxHops": max_hops.unwrap_or(defaults::TRACEROUTE_MAX_HOPS),
    })
}

/// The collected `tool.run` reply: `{ events: [{kind, payload}], result }`.
#[derive(Debug, Deserialize)]
struct ToolRunReply {
    events: Vec<ToolEvent>,
    result: Value,
}

/// Parse a `tool.run` ping-sweep reply into the per-host results (the `result`
/// events) and the run summary (the aggregate).
pub fn parse_ping_sweep_reply(
    reply: Value,
) -> Result<(Vec<PingSweepResult>, PingSweepSummary), serde_json::Error> {
    let reply: ToolRunReply = serde_json::from_value(reply)?;
    let results = reply
        .events
        .into_iter()
        .filter(|e| e.kind == "result")
        .map(|e| serde_json::from_value::<PingSweepResult>(e.payload))
        .collect::<Result<Vec<_>, _>>()?;
    let summary: PingSweepSummary = serde_json::from_value(reply.result)?;
    Ok((results, summary))
}

/// Proxy a ping sweep to the agent's `tool.run` and fan its batched reply out
/// as the same `network-sweep-*` events the local path emits.
///
/// The agent run is collect-and-return, so it cannot be stopped mid-flight; a
/// Stop issued meanwhile is honoured by reporting the completion as canceled.
pub fn dispatch_ping_sweep(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
    app: &AppHandle,
    task_id: &str,
    params: Value,
    cancel: &CancellationToken,
) {
    match client.send_request(agent_id, termihub_core::protocol::methods::TOOL_RUN, params) {
        Ok(reply) => match parse_ping_sweep_reply(reply) {
            Ok((results, summary)) => {
                for r in results {
                    events::emit_sweep_result(app, task_id, r.host, r.latency_ms, r.hostname);
                }
                events::emit_sweep_complete(app, task_id, summary, cancel.is_cancelled());
            }
            Err(e) => events::emit_error(app, events::name::SWEEP_ERROR, task_id, &e.to_string()),
        },
        Err(e) => events::emit_error(app, events::name::SWEEP_ERROR, task_id, &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            tool::OPEN_PORTS,
            tool::PING_SWEEP,
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
        // The builder returns the shared DTO; its serialized wire is snake_case.
        let p = serde_json::to_value(port_scan_params(
            "host.example",
            "1-1024",
            Some(2000),
            Some(100),
        ))
        .unwrap();
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
        assert_eq!(p.count, Some(AGENT_PING_DEFAULT_COUNT));
        assert_eq!(p.interval_ms, Some(1000));
        // An explicit count is honoured verbatim.
        let p = ping_params("host.example", None, Some(10));
        assert_eq!(p.count, Some(10));
    }

    #[test]
    fn traceroute_and_dns_and_wol_params_shape() {
        let t = traceroute_params("host.example", Some(20));
        assert_eq!(t.host, "host.example");
        assert_eq!(t.max_hops, Some(20));

        let d = dns_params("example.com", "A", Some("1.1.1.1"));
        assert_eq!(d.hostname, "example.com");
        assert_eq!(d.record_type, "A");
        assert_eq!(d.server.as_deref(), Some("1.1.1.1"));

        let w = wol_params("aa:bb:cc:dd:ee:ff", "255.255.255.255", 9);
        assert_eq!(w.mac, "aa:bb:cc:dd:ee:ff");
        assert_eq!(w.broadcast, "255.255.255.255");
        assert_eq!(w.port, 9);
    }

    // ── PROD-033: open ports + ping sweep via the agent ─────────────────

    #[test]
    fn open_ports_reply_parses_agent_shape_into_bare_list() {
        // The exact `{ports}` shape `handle_open_ports` sends; the desktop
        // returns the bare array, matching the local `network_open_ports`.
        let reply = json!({
            "ports": [
                { "protocol": "TCP", "localAddr": "0.0.0.0:22", "pid": 1, "process": "sshd" },
                { "protocol": "UDP", "localAddr": "[::]:53", "pid": null, "process": null }
            ]
        });
        let ports = parse_open_ports_reply(reply).unwrap();
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].local_addr, "0.0.0.0:22");
        assert_eq!(ports[0].pid, Some(1));
        assert_eq!(ports[1].process, None);

        // Re-serialized, it is exactly what the local path hands the frontend.
        let wire = serde_json::to_value(&ports).unwrap();
        assert!(wire.is_array());
        assert_eq!(wire[0]["localAddr"], "0.0.0.0:22");
    }

    #[test]
    fn open_ports_reply_rejects_a_bare_array() {
        // The agent wraps the list under `ports`; a bare array is a contract
        // break and must surface as an error, not an empty list.
        assert!(parse_open_ports_reply(json!([])).is_err());
    }

    #[test]
    fn ping_sweep_tool_run_params_wire_shape() {
        let targets = vec!["10.0.0.1".to_string(), "10.0.0.2".to_string()];
        let p = ping_sweep_tool_run_params(&targets, Some(250), Some(8), Some(false));
        assert_eq!(
            p,
            json!({
                "toolId": "ping_sweep",
                "params": {
                    "targets": ["10.0.0.1", "10.0.0.2"],
                    "timeoutMs": 250,
                    "concurrency": 8,
                    "resolveHostnames": false,
                }
            })
        );

        // Absent optionals fall back to the local path's defaults.
        let d = ping_sweep_tool_run_params(&targets, None, None, None);
        assert_eq!(d["params"]["timeoutMs"], defaults::PING_SWEEP_TIMEOUT_MS);
        assert_eq!(d["params"]["concurrency"], defaults::PING_SWEEP_CONCURRENCY);
        assert_eq!(
            d["params"]["resolveHostnames"],
            defaults::PING_SWEEP_RESOLVE_HOSTNAMES
        );
    }

    #[test]
    fn streaming_tool_params_are_camel_case_with_local_defaults() {
        assert_eq!(
            port_scan_tool_params("h", "1-1024", None, Some(8)),
            json!({
                "host": "h",
                "ports": "1-1024",
                "timeoutMs": defaults::PORT_SCAN_TIMEOUT_MS,
                "concurrency": 8,
            })
        );
        // A streamed ping keeps an absent count (runs until Stop).
        assert_eq!(
            ping_tool_params("h", None, None),
            json!({ "host": "h", "intervalMs": defaults::PING_INTERVAL_MS, "count": null })
        );
        assert_eq!(ping_tool_params("h", Some(500), Some(3))["count"], 3);
        assert_eq!(
            traceroute_tool_params("h", None),
            json!({ "host": "h", "maxHops": defaults::TRACEROUTE_MAX_HOPS })
        );
        let targets = vec!["10.0.0.1".to_string()];
        assert_eq!(
            ping_sweep_tool_run_params(&targets, None, None, None)["params"],
            ping_sweep_tool_params(&targets, None, None, None)
        );
    }

    #[test]
    fn ping_sweep_reply_parses_tool_run_shape() {
        // The exact `{events, result}` shape the agent's `tool.run` sends.
        let reply = json!({
            "events": [
                { "kind": "result",
                  "payload": { "host": "10.0.0.1", "latencyMs": 2, "hostname": "gw.lan" } },
                { "kind": "result",
                  "payload": { "host": "10.0.0.7", "latencyMs": null, "hostname": null } }
            ],
            "result": { "total": 254, "up": 2, "down": 252, "elapsedMs": 1234 }
        });
        let (results, summary) = parse_ping_sweep_reply(reply).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].host, "10.0.0.1");
        assert_eq!(results[0].latency_ms, Some(2));
        assert_eq!(results[0].hostname.as_deref(), Some("gw.lan"));
        assert_eq!(summary.total, 254);
        assert_eq!(summary.up, 2);
        assert_eq!(summary.down, 252);
        assert_eq!(summary.elapsed_ms, 1234);
    }

    #[test]
    fn ping_sweep_reply_ignores_non_result_events() {
        let reply = json!({
            "events": [ { "kind": "progress", "payload": { "done": 1 } } ],
            "result": { "total": 1, "up": 0, "down": 1, "elapsedMs": 5 }
        });
        let (results, summary) = parse_ping_sweep_reply(reply).unwrap();
        assert!(results.is_empty());
        assert_eq!(summary.down, 1);
    }

    #[test]
    fn ping_sweep_reply_rejects_malformed_summary() {
        let reply = json!({ "events": [], "result": { "ports": [] } });
        assert!(parse_ping_sweep_reply(reply).is_err());
    }
}
