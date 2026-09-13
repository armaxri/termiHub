//! Canonical default parameter values for the built-in network tools.
//!
//! These constants are the single source of truth for every network tool's
//! default parameters. All three tool wrappers — the core [`Tool`](crate::tool)
//! adapters, the remote agent's JSON-RPC handlers, and the desktop's Tauri
//! commands — reference them so a default cannot silently drift between the
//! places a tool can run.

/// Default interval between ping echoes, in milliseconds.
pub const PING_INTERVAL_MS: u64 = 1000;

/// Default per-port connect timeout for a port scan, in milliseconds.
pub const PORT_SCAN_TIMEOUT_MS: u64 = 2000;

/// Default number of concurrent probes for a port scan.
pub const PORT_SCAN_CONCURRENCY: usize = 100;

/// Default per-host connect timeout for a ping sweep, in milliseconds.
pub const PING_SWEEP_TIMEOUT_MS: u64 = 1000;

/// Default number of concurrent probes for a ping sweep.
///
/// Matches the desktop UI's default (a subnet sweep touches far more hosts than
/// a port scan, so it runs at a lower fan-out than [`PORT_SCAN_CONCURRENCY`]).
pub const PING_SWEEP_CONCURRENCY: usize = 64;

/// Whether a ping sweep resolves reverse-DNS hostnames by default.
pub const PING_SWEEP_RESOLVE_HOSTNAMES: bool = true;

/// Default maximum number of hops for a traceroute.
pub const TRACEROUTE_MAX_HOPS: u8 = 30;

/// Default DNS record type for a lookup, as a textual token.
pub const DNS_DEFAULT_RECORD_TYPE: &str = "A";

/// Default UDP port for a Wake-on-LAN magic packet.
pub const WOL_PORT: u16 = 9;

/// Default broadcast address for a Wake-on-LAN magic packet.
pub const WOL_BROADCAST: &str = "255.255.255.255";
