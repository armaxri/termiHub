//! Built-in network diagnostic tools shared between the termiHub desktop and
//! remote agent.
//!
//! All diagnostic logic lives here so both the Tauri desktop backend and the
//! remote agent can call these functions directly. Transport / event-streaming
//! concerns stay in the consumer crates.
//!
//! # Available tools
//!
//! | Module | Tool |
//! |---|---|
//! | [`port_scan`] | TCP connect scanner |
//! | [`ping`] | ICMP ping (with TCP fallback) |
//! | [`dns`] | DNS record lookup |
//! | [`traceroute`] | Hop-by-hop traceroute |
//! | [`wol`] | Wake-on-LAN magic packet |
//! | [`open_ports`] | Local listening ports |

pub mod dns;
pub mod error;
pub mod open_ports;
pub mod ping;
pub mod port_scan;
pub mod traceroute;
pub mod types;
pub mod wol;

pub use error::NetworkError;
pub use types::{
    DnsRecord, DnsRecordType, DnsResult, OpenPort, PingResult, PingStats, PortScanResult,
    PortScanSummary, PortState, Protocol, TracerouteHop, WolDevice,
};
