//! [`Tool`] wrappers over the built-in [`crate::network`] diagnostics.
//!
//! Each wrapper decodes a JSON params object, calls the existing core network
//! function, streams per-result records through the [`ToolHost`], and returns
//! the run's aggregate. Behaviour is identical to calling the network function
//! directly — the trait only adds the uniform host and cancellation plumbing.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{Tool, ToolError, ToolEvent, ToolHost};
use crate::network::types::DnsRecordType;
use crate::network::{dns, open_ports, ping, ping_sweep, port_scan, traceroute, wol};

/// Decode a tool's params, mapping a serde failure onto [`ToolError::InvalidParams`].
fn decode<T: for<'de> Deserialize<'de>>(tool: &str, params: Value) -> Result<T, ToolError> {
    serde_json::from_value(params).map_err(|e| ToolError::InvalidParams {
        tool: tool.to_string(),
        reason: e.to_string(),
    })
}

/// Serialize a tool's aggregate result, mapping a failure onto
/// [`ToolError::Execution`].
fn aggregate(value: impl serde::Serialize) -> Result<Value, ToolError> {
    serde_json::to_value(value).map_err(|e| ToolError::Execution(e.to_string()))
}

// ── ping ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PingParams {
    host: String,
    #[serde(default = "default_ping_interval")]
    interval_ms: u64,
    #[serde(default)]
    count: Option<u32>,
}

fn default_ping_interval() -> u64 {
    1000
}

/// ICMP ping (with TCP fallback), streaming one `result` event per echo.
pub struct PingTool;

#[async_trait]
impl Tool for PingTool {
    fn tool_id(&self) -> &str {
        "ping"
    }
    fn display_name(&self) -> &str {
        "Ping"
    }
    async fn run(
        &self,
        params: Value,
        host: Arc<dyn ToolHost>,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let p: PingParams = decode(self.tool_id(), params)?;
        let sink = host.clone();
        let stats = ping::ping_stream(
            &p.host,
            p.interval_ms,
            p.count,
            move |r| sink.emit(ToolEvent::new("result", r)),
            cancel,
        )
        .await?;
        aggregate(stats)
    }
}

// ── port scan ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortScanParams {
    host: String,
    ports: String,
    #[serde(default = "default_scan_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_scan_concurrency")]
    concurrency: usize,
}

fn default_scan_timeout() -> u64 {
    2000
}
fn default_scan_concurrency() -> usize {
    100
}

/// TCP connect port scanner, streaming one `result` event per probed port.
pub struct PortScanTool;

#[async_trait]
impl Tool for PortScanTool {
    fn tool_id(&self) -> &str {
        "port_scan"
    }
    fn display_name(&self) -> &str {
        "Port Scan"
    }
    async fn run(
        &self,
        params: Value,
        host: Arc<dyn ToolHost>,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let p: PortScanParams = decode(self.tool_id(), params)?;
        let port_list = port_scan::parse_port_spec(&p.ports).map_err(|e| {
            ToolError::InvalidParams {
                tool: "port_scan".to_string(),
                reason: e.to_string(),
            }
        })?;
        let sink = host.clone();
        let summary = port_scan::scan_ports(
            &p.host,
            &port_list,
            p.timeout_ms,
            p.concurrency,
            move |r| sink.emit(ToolEvent::new("result", r)),
            cancel,
        )
        .await?;
        aggregate(summary)
    }
}

// ── ping sweep ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PingSweepParams {
    targets: Vec<String>,
    #[serde(default = "default_sweep_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_scan_concurrency")]
    concurrency: usize,
    #[serde(default)]
    resolve_hostnames: bool,
}

fn default_sweep_timeout() -> u64 {
    1000
}

/// Subnet / IP-range ping sweep, streaming one `result` event per responding host.
pub struct PingSweepTool;

#[async_trait]
impl Tool for PingSweepTool {
    fn tool_id(&self) -> &str {
        "ping_sweep"
    }
    fn display_name(&self) -> &str {
        "Ping Sweep"
    }
    async fn run(
        &self,
        params: Value,
        host: Arc<dyn ToolHost>,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let p: PingSweepParams = decode(self.tool_id(), params)?;
        let sink = host.clone();
        let summary = ping_sweep::ping_sweep(
            &p.targets,
            p.timeout_ms,
            p.concurrency,
            p.resolve_hostnames,
            move |r| sink.emit(ToolEvent::new("result", r)),
            cancel,
        )
        .await?;
        aggregate(summary)
    }
}

// ── traceroute ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TracerouteParams {
    host: String,
    #[serde(default = "default_max_hops")]
    max_hops: u8,
}

fn default_max_hops() -> u8 {
    30
}

/// Hop-by-hop traceroute, streaming one `hop` event per hop.
pub struct TracerouteTool;

#[async_trait]
impl Tool for TracerouteTool {
    fn tool_id(&self) -> &str {
        "traceroute"
    }
    fn display_name(&self) -> &str {
        "Traceroute"
    }
    async fn run(
        &self,
        params: Value,
        host: Arc<dyn ToolHost>,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let p: TracerouteParams = decode(self.tool_id(), params)?;
        let sink = host.clone();
        traceroute::traceroute(
            &p.host,
            p.max_hops,
            move |h| sink.emit(ToolEvent::new("hop", h)),
            cancel,
        )
        .await?;
        Ok(json!({}))
    }
}

// ── DNS lookup ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DnsParams {
    hostname: String,
    #[serde(default = "default_record_type")]
    record_type: String,
    #[serde(default)]
    server: Option<String>,
}

fn default_record_type() -> String {
    "A".to_string()
}

/// DNS record lookup (one-shot; returns the whole [`DnsResult`]).
pub struct DnsTool;

#[async_trait]
impl Tool for DnsTool {
    fn tool_id(&self) -> &str {
        "dns"
    }
    fn display_name(&self) -> &str {
        "DNS Lookup"
    }
    async fn run(
        &self,
        params: Value,
        _host: Arc<dyn ToolHost>,
        _cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let p: DnsParams = decode(self.tool_id(), params)?;
        let record_type = parse_record_type(&p.record_type)?;
        let result = dns::dns_lookup(&p.hostname, record_type, p.server.as_deref()).await?;
        aggregate(result)
    }
}

/// Parse a textual DNS record type into its [`DnsRecordType`] variant.
fn parse_record_type(s: &str) -> Result<DnsRecordType, ToolError> {
    match s.to_uppercase().as_str() {
        "A" => Ok(DnsRecordType::A),
        "AAAA" => Ok(DnsRecordType::Aaaa),
        "MX" => Ok(DnsRecordType::Mx),
        "CNAME" => Ok(DnsRecordType::Cname),
        "NS" => Ok(DnsRecordType::Ns),
        "TXT" => Ok(DnsRecordType::Txt),
        "SRV" => Ok(DnsRecordType::Srv),
        "SOA" => Ok(DnsRecordType::Soa),
        "PTR" => Ok(DnsRecordType::Ptr),
        "ANY" => Ok(DnsRecordType::Any),
        other => Err(ToolError::InvalidParams {
            tool: "dns".to_string(),
            reason: format!("Unknown DNS record type: {other}"),
        }),
    }
}

// ── open ports ────────────────────────────────────────────────────────────

/// Local listening ports (one-shot; returns the list under `ports`).
pub struct OpenPortsTool;

#[async_trait]
impl Tool for OpenPortsTool {
    fn tool_id(&self) -> &str {
        "open_ports"
    }
    fn display_name(&self) -> &str {
        "Open Ports"
    }
    async fn run(
        &self,
        _params: Value,
        _host: Arc<dyn ToolHost>,
        _cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let ports = open_ports::list_open_ports()?;
        aggregate(json!({ "ports": ports }))
    }
}

// ── Wake-on-LAN ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WolParams {
    mac: String,
    broadcast: String,
    #[serde(default = "default_wol_port")]
    port: u16,
}

fn default_wol_port() -> u16 {
    9
}

/// Send a Wake-on-LAN magic packet (one-shot; returns `{}`).
pub struct WolTool;

#[async_trait]
impl Tool for WolTool {
    fn tool_id(&self) -> &str {
        "wol"
    }
    fn display_name(&self) -> &str {
        "Wake-on-LAN"
    }
    async fn run(
        &self,
        params: Value,
        _host: Arc<dyn ToolHost>,
        _cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let p: WolParams = decode(self.tool_id(), params)?;
        wol::send_magic_packet(&p.mac, &p.broadcast, p.port)?;
        Ok(json!({}))
    }
}

/// Every built-in network diagnostic as a boxed [`Tool`], in a stable order.
///
/// Used by [`ToolRegistry::with_builtin_network_tools`](super::ToolRegistry::with_builtin_network_tools)
/// to populate a registry on both the desktop and the agent from one source.
pub fn builtin_network_tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(PingTool),
        Arc::new(PingSweepTool),
        Arc::new(PortScanTool),
        Arc::new(TracerouteTool),
        Arc::new(DnsTool),
        Arc::new(OpenPortsTool),
        Arc::new(WolTool),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::CollectingHost;

    #[test]
    fn builtin_set_covers_every_network_tool() {
        let ids: Vec<String> = builtin_network_tools()
            .iter()
            .map(|t| t.tool_id().to_string())
            .collect();
        for expected in [
            "ping",
            "ping_sweep",
            "port_scan",
            "traceroute",
            "dns",
            "open_ports",
            "wol",
        ] {
            assert!(ids.contains(&expected.to_string()), "missing tool {expected}");
        }
    }

    #[tokio::test]
    async fn wol_invalid_mac_is_invalid_params_or_network_error() {
        // A malformed MAC must fail without touching the network — proving the
        // params reach the wrapped `wol` function unchanged.
        let tool = WolTool;
        let host = CollectingHost::new();
        let err = tool
            .run(
                json!({ "mac": "not-a-mac", "broadcast": "255.255.255.255" }),
                host,
                CancellationToken::new(),
            )
            .await
            .expect_err("malformed MAC must error");
        // The wrapped function reports it as a NetworkError::InvalidParameter.
        assert!(matches!(err, ToolError::Network(_)));
    }

    #[tokio::test]
    async fn missing_required_param_is_invalid_params() {
        let tool = PingTool;
        let host = CollectingHost::new();
        // `host` field is required; an empty object must be rejected pre-flight.
        let err = tool
            .run(json!({}), host, CancellationToken::new())
            .await
            .expect_err("missing host must error");
        match err {
            ToolError::InvalidParams { tool, .. } => assert_eq!(tool, "ping"),
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn open_ports_runs_and_returns_a_list() {
        // Local, network-free: exercises a full one-shot round trip through the
        // trait and confirms the aggregate shape.
        let tool = OpenPortsTool;
        let host = CollectingHost::new();
        let result = tool
            .run(json!({}), host.clone(), CancellationToken::new())
            .await
            .expect("open_ports must succeed locally");
        assert!(result["ports"].is_array());
        // One-shot tools stream nothing.
        assert!(host.take().is_empty());
    }

    #[test]
    fn dns_record_type_parsing() {
        assert!(matches!(parse_record_type("a"), Ok(DnsRecordType::A)));
        assert!(matches!(parse_record_type("AAAA"), Ok(DnsRecordType::Aaaa)));
        assert!(parse_record_type("nonsense").is_err());
    }
}
