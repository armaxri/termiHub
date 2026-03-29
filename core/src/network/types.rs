//! Serializable result types for all network diagnostic tools.

use serde::{Deserialize, Serialize};

// ── Port Scanner ─────────────────────────────────────────────────────────────

/// The reachability state of a scanned port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortState {
    /// A connection was established; the port is open.
    Open,
    /// The connection was refused; the port is closed.
    Closed,
    /// The connection timed out; a firewall may be filtering the port.
    Filtered,
}

/// Result for a single port probe.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortScanResult {
    pub port: u16,
    pub state: PortState,
    /// Round-trip latency in milliseconds for open ports.
    pub latency_ms: Option<u64>,
}

/// Summary emitted when a port scan completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortScanSummary {
    pub total: u32,
    pub open: u32,
    pub closed: u32,
    pub filtered: u32,
    pub elapsed_ms: u64,
}

// ── Ping ─────────────────────────────────────────────────────────────────────

/// Result for a single ICMP/TCP ping echo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    /// Sequence number (starts at 1).
    pub seq: u32,
    /// Round-trip time in milliseconds. `None` when the packet timed out.
    pub latency_ms: Option<u64>,
    /// IP time-to-live from the reply. `None` on timeout or TCP fallback.
    pub ttl: Option<u8>,
    /// `true` when no reply was received within the timeout window.
    pub timed_out: bool,
    /// `true` when TCP connect fallback was used instead of ICMP.
    pub tcp_fallback: bool,
}

/// Aggregate statistics for a completed ping session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingStats {
    pub sent: u32,
    pub received: u32,
    pub loss_percent: f64,
    pub min_ms: f64,
    pub avg_ms: f64,
    pub max_ms: f64,
    pub jitter_ms: f64,
}

// ── DNS Lookup ───────────────────────────────────────────────────────────────

/// DNS record types supported by the lookup tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DnsRecordType {
    A,
    Aaaa,
    Mx,
    Cname,
    Ns,
    Txt,
    Srv,
    Soa,
    Ptr,
    Any,
}

/// A single DNS resource record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    pub record_type: DnsRecordType,
    pub name: String,
    pub value: String,
    pub ttl: u32,
}

/// Result of a DNS lookup including timing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResult {
    pub records: Vec<DnsRecord>,
    pub query_ms: u64,
}

// ── Traceroute ───────────────────────────────────────────────────────────────

/// A single hop in a traceroute.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteHop {
    /// TTL value at this hop (1-based).
    pub hop: u8,
    /// Reverse-DNS hostname of the router, if resolved.
    pub host: Option<String>,
    /// IP address of the router. `None` when the hop did not respond (`* * *`).
    pub ip: Option<String>,
    /// Three probe round-trip times in milliseconds.
    pub rtt_ms: [Option<f64>; 3],
}

// ── Open Ports ───────────────────────────────────────────────────────────────

/// IP protocol family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Protocol {
    Tcp,
    Udp,
}

/// A single listening port on the local machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPort {
    pub protocol: Protocol,
    pub local_addr: String,
    /// Owning process ID, if available.
    pub pid: Option<u32>,
    /// Owning process name, if available.
    pub process: Option<String>,
}

// ── Wake-on-LAN ──────────────────────────────────────────────────────────────

/// A saved Wake-on-LAN device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolDevice {
    pub id: String,
    pub name: String,
    pub mac: String,
    pub broadcast: String,
    pub port: u16,
}
