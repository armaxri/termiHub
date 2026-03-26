//! Network diagnostic handlers for the agent JSON-RPC protocol.
//!
//! These are thin wrappers around `termihub_core::network` that adapt the
//! core functions to synchronous JSON-RPC responses.  HTTP monitoring is
//! intentionally excluded — it is a desktop-only feature.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio_util::sync::CancellationToken;

use termihub_core::network::types::{
    DnsRecordType, DnsResult, PingResult, PortScanResult, TracerouteHop,
};
use termihub_core::network::{dns, open_ports, ping, port_scan, traceroute, wol};

use crate::protocol::methods::{
    NetworkDnsLookupParams, NetworkOpenPortsResponse, NetworkPingParams, NetworkPingResponse,
    NetworkPortScanParams, NetworkPortScanResponse, NetworkTracerouteParams,
    NetworkTracerouteResponse, NetworkWolParams, PingStats,
};

/// Run a port scan synchronously — collects all results before returning.
pub async fn handle_port_scan(params: NetworkPortScanParams) -> Result<NetworkPortScanResponse> {
    let port_list = port_scan::parse_port_spec(&params.ports)
        .map_err(|e| anyhow::anyhow!("Invalid port spec: {e}"))?;

    let timeout_ms = params.timeout_ms.unwrap_or(2000);
    let concurrency = params.concurrency.unwrap_or(100);
    let cancel = CancellationToken::new();

    let results: Arc<Mutex<Vec<PortScanResult>>> = Arc::new(Mutex::new(Vec::new()));
    let results_clone = results.clone();

    let on_result = move |r: PortScanResult| {
        results_clone.lock().unwrap().push(r);
    };

    let summary = port_scan::scan_ports(
        &params.host,
        &port_list,
        timeout_ms,
        concurrency,
        on_result,
        cancel,
    )
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    let results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();
    Ok(NetworkPortScanResponse { results, summary })
}

/// Run a ping session with a fixed count, collecting all results.
pub async fn handle_ping(params: NetworkPingParams) -> Result<NetworkPingResponse> {
    let count = params.count;
    let interval_ms = params.interval_ms.unwrap_or(1000);
    let cancel = CancellationToken::new();

    let results: Arc<Mutex<Vec<PingResult>>> = Arc::new(Mutex::new(Vec::new()));
    let results_clone = results.clone();

    let on_result = move |r: PingResult| {
        results_clone.lock().unwrap().push(r);
    };

    let stats: PingStats = ping::ping_stream(&params.host, interval_ms, count, on_result, cancel)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let results = Arc::try_unwrap(results).unwrap().into_inner().unwrap();
    Ok(NetworkPingResponse { results, stats })
}

/// Perform a DNS lookup.
pub async fn handle_dns_lookup(params: NetworkDnsLookupParams) -> Result<DnsResult> {
    let record_type = parse_record_type(&params.record_type)?;
    dns::dns_lookup(&params.hostname, record_type, params.server.as_deref())
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// List open/listening ports on the agent host.
pub fn handle_open_ports() -> Result<NetworkOpenPortsResponse> {
    let ports = open_ports::list_open_ports().map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(NetworkOpenPortsResponse { ports })
}

/// Run a traceroute to the given host.
pub async fn handle_traceroute(
    params: NetworkTracerouteParams,
) -> Result<NetworkTracerouteResponse> {
    let max_hops = params.max_hops.unwrap_or(30);
    let cancel = CancellationToken::new();

    let hops: Arc<Mutex<Vec<TracerouteHop>>> = Arc::new(Mutex::new(Vec::new()));
    let hops_clone = hops.clone();

    let on_hop = move |h: TracerouteHop| {
        hops_clone.lock().unwrap().push(h);
    };

    traceroute::traceroute(&params.host, max_hops, on_hop, cancel)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let hops = Arc::try_unwrap(hops).unwrap().into_inner().unwrap();
    Ok(NetworkTracerouteResponse { hops })
}

/// Send a Wake-on-LAN magic packet.
pub fn handle_wol(params: NetworkWolParams) -> Result<()> {
    wol::send_magic_packet(&params.mac, &params.broadcast, params.port)
        .map_err(|e| anyhow::anyhow!("{e}"))
}

fn parse_record_type(s: &str) -> Result<DnsRecordType> {
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
        _ => anyhow::bail!("Unknown DNS record type: {s}"),
    }
}
