//! Network diagnostic handlers for the agent JSON-RPC protocol.
//!
//! Each `network.*` method is a thin adapter over the shared core
//! [`ToolRegistry`](termihub_core::tool::ToolRegistry): the handler decodes the
//! snake_case `Network*Params`, runs the matching core [`Tool`] through a
//! [`CollectingHost`], then re-shapes the collected `{events, aggregate}` back
//! into the method's existing response (`{results, stats}` / typed result).
//! This is the same execution path `tool.run` drives, so the agent keeps a
//! single tool implementation instead of a hand-rolled accumulator per method
//! (DUP-027). The wire shape of every `network.*` method is unchanged.
//!
//! HTTP monitoring is intentionally excluded — it is a desktop-only feature.

pub mod streaming;

use std::sync::OnceLock;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use termihub_core::network::defaults;
use termihub_core::network::types::{
    DnsResult, OpenPort, PingResult, PortScanResult, PortScanSummary, TracerouteHop,
};
use termihub_core::tool::{CollectingHost, ToolEvent, ToolRegistry};

use crate::protocol::methods::{
    NetworkDnsLookupParams, NetworkOpenPortsResponse, NetworkPingParams, NetworkPingResponse,
    NetworkPortScanParams, NetworkPortScanResponse, NetworkTracerouteParams,
    NetworkTracerouteResponse, NetworkWolParams, PingStats,
};

// `Arc`/`Mutex` are referenced only by the unit tests below (which model the
// collection path the handlers previously hand-rolled), so gate the import on
// `cfg(test)` — the adapters themselves no longer accumulate by hand.
#[cfg(test)]
use std::sync::{Arc, Mutex};

/// Process-wide registry of the built-in network tools.
///
/// The tools are stateless singletons, so one shared registry is built once and
/// reused for every `network.*` call — the same set `tool.run` dispatches to.
fn registry() -> &'static ToolRegistry {
    static REGISTRY: OnceLock<ToolRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ToolRegistry::with_builtin_network_tools)
}

/// Run a core tool to completion, collecting its streamed events, and return
/// `(events, aggregate)`.
///
/// This is the single execution path shared by every `network.*` handler: it
/// mirrors how `tool.run` collects a whole run before responding (the NDJSON
/// transport is request/response, not streaming).
async fn run_tool(tool_id: &str, params: Value) -> Result<(Vec<ToolEvent>, Value)> {
    let host = CollectingHost::new();
    let aggregate = registry()
        .run(tool_id, params, host.clone(), CancellationToken::new())
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((host.take(), aggregate))
}

/// Deserialize each collected event payload back into its result type.
fn from_events<T>(events: Vec<ToolEvent>) -> Result<Vec<T>>
where
    T: serde::de::DeserializeOwned,
{
    events
        .into_iter()
        .map(|e| serde_json::from_value(e.payload).map_err(|err| anyhow::anyhow!("{err}")))
        .collect()
}

/// Run a port scan synchronously — collects all results before returning.
pub async fn handle_port_scan(params: NetworkPortScanParams) -> Result<NetworkPortScanResponse> {
    let tool_params = json!({
        "host": params.host,
        "ports": params.ports,
        "timeoutMs": params.timeout_ms.unwrap_or(defaults::PORT_SCAN_TIMEOUT_MS),
        "concurrency": params.concurrency.unwrap_or(defaults::PORT_SCAN_CONCURRENCY),
    });
    let (events, aggregate) = run_tool("port_scan", tool_params).await?;
    let results = from_events::<PortScanResult>(events)?;
    let summary: PortScanSummary =
        serde_json::from_value(aggregate).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(NetworkPortScanResponse { results, summary })
}

/// Run a ping session with a fixed count, collecting all results.
pub async fn handle_ping(params: NetworkPingParams) -> Result<NetworkPingResponse> {
    let tool_params = json!({
        "host": params.host,
        "intervalMs": params.interval_ms.unwrap_or(defaults::PING_INTERVAL_MS),
        "count": params.count,
    });
    let (events, aggregate) = run_tool("ping", tool_params).await?;
    let results = from_events::<PingResult>(events)?;
    let stats: PingStats = serde_json::from_value(aggregate).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(NetworkPingResponse { results, stats })
}

/// Perform a DNS lookup.
pub async fn handle_dns_lookup(params: NetworkDnsLookupParams) -> Result<DnsResult> {
    let tool_params = json!({
        "hostname": params.hostname,
        "recordType": params.record_type,
        "server": params.server,
    });
    let (_events, aggregate) = run_tool("dns", tool_params).await?;
    serde_json::from_value(aggregate).map_err(|e| anyhow::anyhow!("{e}"))
}

/// List open/listening ports on the agent host.
pub async fn handle_open_ports() -> Result<NetworkOpenPortsResponse> {
    let (_events, aggregate) = run_tool("open_ports", json!({})).await?;
    let ports: Vec<OpenPort> =
        serde_json::from_value(aggregate.get("ports").cloned().unwrap_or(Value::Null))
            .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(NetworkOpenPortsResponse { ports })
}

/// Run a traceroute to the given host.
pub async fn handle_traceroute(
    params: NetworkTracerouteParams,
) -> Result<NetworkTracerouteResponse> {
    let tool_params = json!({
        "host": params.host,
        "maxHops": params.max_hops.unwrap_or(defaults::TRACEROUTE_MAX_HOPS),
    });
    let (events, _aggregate) = run_tool("traceroute", tool_params).await?;
    let hops = from_events::<TracerouteHop>(events)?;
    Ok(NetworkTracerouteResponse { hops })
}

/// Send a Wake-on-LAN magic packet.
pub async fn handle_wol(params: NetworkWolParams) -> Result<()> {
    let tool_params = json!({
        "mac": params.mac,
        "broadcast": params.broadcast,
        "port": params.port,
    });
    run_tool("wol", tool_params).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drain the shared accumulator exactly the way the handlers do, then
    /// return it. This is the collection path under test — no `Arc::try_unwrap`.
    fn drain<T>(acc: &Arc<Mutex<Vec<T>>>) -> Vec<T> {
        std::mem::take(&mut *acc.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// The regression: even if a spawned task still holds a clone of the `Arc`
    /// when the results are collected, draining must return the accumulated
    /// values without panicking. The old
    /// `Arc::try_unwrap(...).unwrap().into_inner().unwrap()` would panic here
    /// because the strong count is > 1 (WA-RS-002 / ERR-005).
    #[test]
    fn drain_does_not_panic_with_residual_arc_clone() {
        let acc: Arc<Mutex<Vec<u16>>> = Arc::new(Mutex::new(Vec::new()));
        let straggler = acc.clone(); // a task that has not dropped its clone yet
        acc.lock().unwrap().extend([22u16, 80, 443]);

        assert_eq!(Arc::strong_count(&acc), 2, "a clone is still alive");
        let collected = drain(&acc);

        assert_eq!(collected, vec![22, 80, 443]);
        // The surviving clone is now an empty shared buffer, not a panic.
        assert!(straggler.lock().unwrap().is_empty());
    }

    /// A poisoned lock must degrade to its inner value, never crash the agent.
    #[test]
    fn drain_tolerates_poisoned_lock() {
        let acc: Arc<Mutex<Vec<u16>>> = Arc::new(Mutex::new(vec![1, 2, 3]));
        let poison = acc.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();

        assert!(acc.is_poisoned());
        assert_eq!(drain(&acc), vec![1, 2, 3]);
    }

    /// Exercise the real port-scan handler end to end: every requested port
    /// yields exactly one result (open or closed), and collection returns them
    /// all without panicking.
    #[tokio::test]
    async fn handle_port_scan_collects_all_results() {
        let params = NetworkPortScanParams {
            host: "127.0.0.1".to_string(),
            ports: "9,13".to_string(),
            timeout_ms: Some(200),
            concurrency: Some(4),
        };

        let resp = handle_port_scan(params).await.expect("scan should succeed");

        assert_eq!(resp.results.len(), 2, "one result per requested port");
        assert_eq!(resp.summary.total, 2);
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::*;

    /// A streaming tool routed through the core registry adapter reproduces the
    /// existing `{results, summary}` wire shape byte-for-byte (DUP-027).
    #[tokio::test]
    async fn port_scan_adapter_wire_shape() {
        let params = NetworkPortScanParams {
            host: "127.0.0.1".to_string(),
            ports: "9,13".to_string(),
            timeout_ms: Some(200),
            concurrency: Some(4),
        };
        let resp = handle_port_scan(params).await.expect("scan should succeed");
        let wire = serde_json::to_value(&resp).expect("serialize response");

        let results = wire["results"].as_array().expect("results array");
        assert_eq!(results.len(), 2, "one result per requested port");
        for r in results {
            let obj = r.as_object().expect("result object");
            assert!(obj.contains_key("host"));
            assert!(obj.contains_key("port"));
            assert!(obj.contains_key("state"));
            // camelCase field name preserved on the wire.
            assert!(obj.contains_key("latencyMs"));
        }

        let summary = wire["summary"].as_object().expect("summary object");
        assert_eq!(summary["total"], 2);
        for key in ["total", "open", "closed", "filtered", "elapsedMs"] {
            assert!(summary.contains_key(key), "summary missing {key}");
        }
    }

    /// A one-shot tool routed through the adapter reproduces the existing
    /// `{ports}` wire shape.
    #[tokio::test]
    async fn open_ports_adapter_wire_shape() {
        let resp = handle_open_ports()
            .await
            .expect("open_ports should succeed");
        let wire = serde_json::to_value(&resp).expect("serialize response");
        assert!(wire["ports"].is_array(), "expected ports array: {wire}");
    }
}
