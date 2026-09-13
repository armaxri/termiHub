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
    /// The target host this probe was made against. Carried in the result so
    /// callers iterating multiple targets (e.g. CIDR ranges) can group output
    /// by host.
    pub host: String,
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

// ── Ping Sweep ─────────────────────────────────────────────────────────────────

/// A host that responded during a ping sweep.
///
/// Only responding (up) hosts are streamed as results; non-responders are
/// tallied into [`PingSweepSummary::down`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingSweepResult {
    /// The probed address (an IP string, or the original hostname token).
    pub host: String,
    /// Round-trip time in milliseconds for the reply.
    pub latency_ms: Option<u64>,
    /// Best-effort reverse-DNS hostname for the address, if resolvable.
    pub hostname: Option<String>,
}

/// Summary emitted when a ping sweep completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingSweepSummary {
    /// Total number of hosts probed.
    pub total: u32,
    /// Hosts that responded.
    pub up: u32,
    /// Hosts that did not respond within the timeout.
    pub down: u32,
    pub elapsed_ms: u64,
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

/// Error returned when a string cannot be parsed into a [`DnsRecordType`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseDnsRecordTypeError {
    /// The unrecognized input token.
    pub input: String,
}

impl std::fmt::Display for ParseDnsRecordTypeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown DNS record type: {}", self.input)
    }
}

impl std::error::Error for ParseDnsRecordTypeError {}

impl std::str::FromStr for DnsRecordType {
    type Err = ParseDnsRecordTypeError;

    /// Parse a textual DNS record type (case-insensitive) into its
    /// [`DnsRecordType`] variant. This is the single canonical parser shared by
    /// every network-tool wrapper.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_uppercase().as_str() {
            "A" => Ok(Self::A),
            "AAAA" => Ok(Self::Aaaa),
            "MX" => Ok(Self::Mx),
            "CNAME" => Ok(Self::Cname),
            "NS" => Ok(Self::Ns),
            "TXT" => Ok(Self::Txt),
            "SRV" => Ok(Self::Srv),
            "SOA" => Ok(Self::Soa),
            "PTR" => Ok(Self::Ptr),
            "ANY" => Ok(Self::Any),
            _ => Err(ParseDnsRecordTypeError {
                input: s.to_string(),
            }),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_record_type_from_str_is_case_insensitive() {
        assert_eq!("a".parse::<DnsRecordType>(), Ok(DnsRecordType::A));
        assert_eq!("AAAA".parse::<DnsRecordType>(), Ok(DnsRecordType::Aaaa));
        assert_eq!("Cname".parse::<DnsRecordType>(), Ok(DnsRecordType::Cname));
        assert_eq!("any".parse::<DnsRecordType>(), Ok(DnsRecordType::Any));
    }

    #[test]
    fn dns_record_type_from_str_rejects_unknown() {
        let err = "nonsense".parse::<DnsRecordType>().unwrap_err();
        assert_eq!(err.input, "nonsense");
        assert!(err.to_string().contains("nonsense"));
    }
}
