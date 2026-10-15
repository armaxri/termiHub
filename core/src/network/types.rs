//! Serializable result types for all network diagnostic tools.
//!
//! The frontend DTOs (`src/types/network.ts`) are generated from these via
//! ts-rs (audit DUP-030, #3802). `u64` fields are mapped to `number`. `Option`
//! fields serialize as `null` when unset, so they are typed `field?: T | null`
//! via `ts(optional = nullable)` (#3821) and consumers must treat `null` and
//! `undefined` alike.
//!
//! Latencies (`latency_ms`) are fractional milliseconds (`f64`, microsecond
//! precision) so sub-millisecond LAN round trips survive the wire (#4542). A
//! peer that predates this still reads them: an older agent sends whole
//! numbers, which deserialize into `f64` unchanged, and an agent rounds back to
//! whole numbers for an older desktop with [`round_latency_for_legacy_client`].

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::entry_extra::{EntryExtra, StoreEntry};

// ── Latency ──────────────────────────────────────────────────────────────────

/// A measured round trip as fractional milliseconds, rounded to whole
/// microseconds (#4542) — fine enough for a LAN reply (`0.42` ms) without
/// carrying float noise like `0.41966700000000004` onto the wire.
pub fn duration_to_latency_ms(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 1_000_000.0).round() / 1000.0
}

/// Rewrite a serialized result's `latencyMs` as whole milliseconds, for a
/// desktop that predates fractional latencies (#4542).
///
/// Such a desktop deserializes `latencyMs` as an unsigned integer and rejects
/// `0.42` outright, so an agent applies this to every streamed result unless
/// the desktop advertised `clientCapabilities.fractionalLatency`. Rounds to
/// nearest (a 0.6 ms reply reads 1 ms, as before #4542), clamps negatives to 0
/// and leaves `null`, integers and payloads without the key untouched.
pub fn round_latency_for_legacy_client(payload: &mut Value) {
    let Some(latency) = payload.get_mut("latencyMs") else {
        return;
    };
    if latency.is_u64() {
        return;
    }
    if let Some(ms) = latency.as_f64() {
        // `as` saturates: NaN → 0, negatives → 0, huge → u64::MAX.
        *latency = Value::from(ms.round() as u64);
    }
}

// ── Port Scanner ─────────────────────────────────────────────────────────────

/// The reachability state of a scanned port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PortScanResult {
    /// The target host this probe was made against. Carried in the result so
    /// callers iterating multiple targets (e.g. CIDR ranges) can group output
    /// by host.
    pub host: String,
    pub port: u16,
    pub state: PortState,
    /// Round-trip latency in (fractional) milliseconds for open ports.
    #[cfg_attr(test, ts(optional = nullable, type = "number | null"))]
    pub latency_ms: Option<f64>,
}

/// Summary emitted when a port scan completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PortScanSummary {
    pub total: u32,
    pub open: u32,
    pub closed: u32,
    pub filtered: u32,
    #[cfg_attr(test, ts(type = "number"))]
    pub elapsed_ms: u64,
}

// ── Ping ─────────────────────────────────────────────────────────────────────

/// Result for a single ICMP/TCP ping echo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    /// Sequence number (starts at 1).
    pub seq: u32,
    /// Round-trip time in (fractional) milliseconds. `None` when the packet
    /// timed out.
    #[cfg_attr(test, ts(optional = nullable, type = "number | null"))]
    pub latency_ms: Option<f64>,
    /// IP time-to-live (IPv4) or hop limit (IPv6) from the echo reply.
    ///
    /// `None` on timeout, on TCP fallback (a TCP connect exposes no TTL), and
    /// when the platform's ICMP socket strips the IP header (Linux unprivileged
    /// datagram sockets, and IPv6 everywhere).
    #[cfg_attr(test, ts(optional = nullable))]
    pub ttl: Option<u8>,
    /// `true` when no reply was received within the timeout window.
    pub timed_out: bool,
    /// `true` when TCP connect fallback was used instead of ICMP.
    pub tcp_fallback: bool,
}

/// Aggregate statistics for a completed ping session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PingSweepResult {
    /// The probed address (an IP string, or the original hostname token).
    pub host: String,
    /// Round-trip time in (fractional) milliseconds for the reply.
    #[cfg_attr(test, ts(optional = nullable, type = "number | null"))]
    pub latency_ms: Option<f64>,
    /// Best-effort reverse-DNS hostname for the address, if resolvable.
    #[cfg_attr(test, ts(optional = nullable))]
    pub hostname: Option<String>,
}

/// Summary emitted when a ping sweep completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PingSweepSummary {
    /// Total number of hosts probed.
    pub total: u32,
    /// Hosts that responded.
    pub up: u32,
    /// Hosts that did not respond within the timeout.
    pub down: u32,
    #[cfg_attr(test, ts(type = "number"))]
    pub elapsed_ms: u64,
}

// ── DNS Lookup ───────────────────────────────────────────────────────────────

/// DNS record types supported by the lookup tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    pub record_type: DnsRecordType,
    pub name: String,
    pub value: String,
    pub ttl: u32,
}

/// Result of a DNS lookup including timing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct DnsResult {
    pub records: Vec<DnsRecord>,
    #[cfg_attr(test, ts(type = "number"))]
    pub query_ms: u64,
}

// ── Traceroute ───────────────────────────────────────────────────────────────

/// A single hop in a traceroute.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct TracerouteHop {
    /// TTL value at this hop (1-based).
    pub hop: u8,
    /// Reverse-DNS hostname of the router, if resolved.
    #[cfg_attr(test, ts(optional = nullable))]
    pub host: Option<String>,
    /// IP address of the router. `None` when the hop did not respond (`* * *`).
    #[cfg_attr(test, ts(optional = nullable))]
    pub ip: Option<String>,
    /// Three probe round-trip times in milliseconds.
    pub rtt_ms: [Option<f64>; 3],
}

// ── Open Ports ───────────────────────────────────────────────────────────────

/// IP protocol family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[cfg_attr(test, ts(rename = "PortProtocol"))]
#[serde(rename_all = "UPPERCASE")]
pub enum Protocol {
    Tcp,
    Udp,
}

/// A single listening port on the local machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct OpenPort {
    pub protocol: Protocol,
    pub local_addr: String,
    /// Owning process ID, if available.
    #[cfg_attr(test, ts(optional = nullable))]
    pub pid: Option<u32>,
    /// Owning process name, if available.
    #[cfg_attr(test, ts(optional = nullable))]
    pub process: Option<String>,
}

// ── Wake-on-LAN ──────────────────────────────────────────────────────────────

/// A saved Wake-on-LAN device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct WolDevice {
    pub id: String,
    pub name: String,
    pub mac: String,
    pub broadcast: String,
    pub port: u16,
    /// Unknown fields of this entry in `wol-devices.json`, kept verbatim so an
    /// older build's save does not erase them (#3951). Not part of the
    /// generated TS type; see [`crate::util::entry_extra`].
    #[serde(flatten, default)]
    #[cfg_attr(test, ts(skip))]
    pub extra: EntryExtra,
}

impl StoreEntry for WolDevice {
    fn entry_id(&self) -> &str {
        &self.id
    }
    fn entry_extra_mut(&mut self) -> &mut EntryExtra {
        &mut self.extra
    }
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

    // ── Fractional latency (#4542) ──────────────────────────────────────────

    use serde_json::json;

    #[test]
    fn duration_to_latency_ms_has_microsecond_precision() {
        assert_eq!(duration_to_latency_ms(Duration::from_micros(420)), 0.42);
        assert_eq!(duration_to_latency_ms(Duration::from_nanos(1_500)), 0.002);
        assert_eq!(duration_to_latency_ms(Duration::from_secs(2)), 2000.0);
        assert_eq!(duration_to_latency_ms(Duration::ZERO), 0.0);
    }

    #[test]
    fn ping_result_round_trips_a_fractional_latency() {
        let r = PingResult {
            seq: 1,
            latency_ms: Some(0.42),
            ttl: Some(64),
            timed_out: false,
            tcp_fallback: false,
        };
        let wire = serde_json::to_value(&r).unwrap();
        assert_eq!(wire["latencyMs"], json!(0.42));
        let back: PingResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back.latency_ms, Some(0.42));
    }

    #[test]
    fn results_from_an_older_agent_with_integer_latency_still_parse() {
        // An agent from before #4542 sends whole milliseconds.
        let ping: PingResult = serde_json::from_value(json!({
            "seq": 3, "latencyMs": 12, "ttl": 56, "timedOut": false, "tcpFallback": false
        }))
        .unwrap();
        assert_eq!(ping.latency_ms, Some(12.0));

        let sweep: PingSweepResult =
            serde_json::from_value(json!({ "host": "10.0.0.1", "latencyMs": 1, "hostname": null }))
                .unwrap();
        assert_eq!(sweep.latency_ms, Some(1.0));

        let scan: PortScanResult = serde_json::from_value(json!({
            "host": "10.0.0.1", "port": 22, "state": "open", "latencyMs": 3
        }))
        .unwrap();
        assert_eq!(scan.latency_ms, Some(3.0));

        let timed_out: PingResult = serde_json::from_value(json!({
            "seq": 4, "latencyMs": null, "timedOut": true, "tcpFallback": false
        }))
        .unwrap();
        assert_eq!(timed_out.latency_ms, None);
    }

    /// Mirror of the result type a desktop from before #4542 deserializes.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyPingResult {
        latency_ms: Option<u64>,
    }

    #[test]
    fn a_legacy_desktop_rejects_fractional_latency_unless_rounded() {
        let r = PingResult {
            seq: 1,
            latency_ms: Some(0.6),
            ttl: None,
            timed_out: false,
            tcp_fallback: false,
        };
        let mut wire = serde_json::to_value(&r).unwrap();
        assert!(serde_json::from_value::<LegacyPingResult>(wire.clone()).is_err());

        round_latency_for_legacy_client(&mut wire);
        let legacy: LegacyPingResult = serde_json::from_value(wire).unwrap();
        assert_eq!(legacy.latency_ms, Some(1));
    }

    #[test]
    fn legacy_rounding_rounds_to_nearest_and_leaves_other_shapes_alone() {
        let mut v = json!({ "latencyMs": 0.42 });
        round_latency_for_legacy_client(&mut v);
        assert_eq!(v, json!({ "latencyMs": 0 }));

        let mut v = json!({ "latencyMs": 1.5 });
        round_latency_for_legacy_client(&mut v);
        assert_eq!(v, json!({ "latencyMs": 2 }));

        let mut v = json!({ "latencyMs": -0.4 });
        round_latency_for_legacy_client(&mut v);
        assert_eq!(v, json!({ "latencyMs": 0 }));

        for untouched in [
            json!({ "latencyMs": 7 }),
            json!({ "latencyMs": null }),
            json!({ "hop": 1, "rttMs": 0.5 }),
            json!("not an object"),
        ] {
            let mut v = untouched.clone();
            round_latency_for_legacy_client(&mut v);
            assert_eq!(v, untouched);
        }
    }
}
