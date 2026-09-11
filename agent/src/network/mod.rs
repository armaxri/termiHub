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
        results_clone
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(r);
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

    // Drain the shared accumulator instead of reclaiming sole ownership: a
    // straggler scan task holding an `Arc` clone must never panic the agent
    // (WA-RS-002 / ERR-005). A poisoned lock degrades to its inner Vec.
    let results = std::mem::take(&mut *results.lock().unwrap_or_else(|e| e.into_inner()));
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
        results_clone
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(r);
    };

    let stats: PingStats = ping::ping_stream(&params.host, interval_ms, count, on_result, cancel)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Drain the shared accumulator; never reclaim sole `Arc` ownership on a
    // path where a spawned task may still hold a clone (WA-RS-002 / ERR-005).
    let results = std::mem::take(&mut *results.lock().unwrap_or_else(|e| e.into_inner()));
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
        hops_clone.lock().unwrap_or_else(|e| e.into_inner()).push(h);
    };

    traceroute::traceroute(&params.host, max_hops, on_hop, cancel)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Drain the shared accumulator; never reclaim sole `Arc` ownership on a
    // path where a spawned task may still hold a clone (WA-RS-002 / ERR-005).
    let hops = std::mem::take(&mut *hops.lock().unwrap_or_else(|e| e.into_inner()));
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
