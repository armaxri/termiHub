//! Shared SSH tunnel forwarding substrate (S3, #2185, part of #2139).
//!
//! The tunnel forwarders were originally desktop-only. This module lifts the
//! reusable engine into core so the identical forwarder runs on the desktop
//! **or** on a remote agent — per the settled endpoint semantics, only the
//! machine that hosts the tunnel (the "tunnel host") moves; SSH's own
//! local/remote/dynamic meanings are invariant. See
//! `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.
//!
//! Currently lifted: the **local** (`ssh -L`), **remote** (`ssh -R`), and
//! **dynamic** (`ssh -D`, SOCKS5) engines plus the shared channel-opener seam
//! and stats. The desktop `tunnel` module re-exports these so existing call
//! sites are unchanged; the agent uses them to forward on the agent (#2198
//! completed the trilogy with `-D`).

pub mod channel;
pub mod config;
pub mod dynamic_forward;
pub mod local_forward;
pub mod remote_forward;

pub use channel::{ChannelOpener, SshChannelOpener};
pub use config::{DynamicForwardConfig, LocalForwardConfig, RemoteForwardConfig, TunnelStats};
pub use dynamic_forward::DynamicForwarder;
pub use local_forward::{ForwarderStats, LocalForwarder};
pub use remote_forward::RemoteForwarder;

use serde::{Deserialize, Serialize};

/// Who can reach an agent-hosted tunnel's listen socket.
///
/// Per the endpoint-semantics concept, the listen socket's home depends on the
/// mode. An agent-hosted **local**/**dynamic** forward binds on the agent: a
/// loopback bind is reachable only from the agent itself; a widened bind (the
/// agent's LAN address or `0.0.0.0`) is reachable from the agent's network. An
/// agent-hosted **remote** (`-R`) forward instead binds on the **SSH server** —
/// SSH's own semantics are invariant, only the tunnel host moves — so its listen
/// socket lives on the server's network, not the agent's. The desktop surfaces
/// this as the "reachability" warning + badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReachableFrom {
    /// Loopback bind on the agent — only processes on the agent can connect.
    AgentOnly,
    /// Widened bind — reachable from the agent's LAN (and thus, potentially,
    /// the desktop) at the agent's address.
    AgentLan,
    /// The listen socket lives on the **SSH server** (an `-R` remote forward):
    /// reachable per the server's own network and `GatewayPorts` policy, never
    /// from the agent or the desktop directly. Only the forward *target* is
    /// resolved from the tunnel host (the agent).
    SshServer,
}

/// Classify an agent-hosted listen socket's reachability from its bind host.
///
/// A loopback bind (`127.0.0.0/8`, `::1`, or the `localhost` hostname) is
/// [`ReachableFrom::AgentOnly`]; anything else (a concrete LAN address or the
/// wildcard `0.0.0.0` / `::`) is [`ReachableFrom::AgentLan`]. This is the
/// loopback-safe default: the bind is never silently widened, so the caller
/// warns rather than exposing a port.
pub fn classify_reachability(bind_host: &str) -> ReachableFrom {
    let host = bind_host.trim();
    let is_loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if is_loopback {
        ReachableFrom::AgentOnly
    } else {
        ReachableFrom::AgentLan
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_binds_are_agent_only() {
        assert_eq!(classify_reachability("127.0.0.1"), ReachableFrom::AgentOnly);
        assert_eq!(classify_reachability("::1"), ReachableFrom::AgentOnly);
        assert_eq!(classify_reachability("localhost"), ReachableFrom::AgentOnly);
        assert_eq!(classify_reachability("127.5.6.7"), ReachableFrom::AgentOnly);
    }

    #[test]
    fn widened_binds_are_agent_lan() {
        assert_eq!(classify_reachability("0.0.0.0"), ReachableFrom::AgentLan);
        assert_eq!(classify_reachability("::"), ReachableFrom::AgentLan);
        assert_eq!(
            classify_reachability("192.168.1.10"),
            ReachableFrom::AgentLan
        );
        // A non-loopback hostname is treated as reachable (conservative — we do
        // not resolve it, so we cannot prove it is loopback).
        assert_eq!(
            classify_reachability("build-box.local"),
            ReachableFrom::AgentLan
        );
    }

    #[test]
    fn reachable_from_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(ReachableFrom::AgentOnly).unwrap(),
            serde_json::json!("agentOnly")
        );
        assert_eq!(
            serde_json::to_value(ReachableFrom::AgentLan).unwrap(),
            serde_json::json!("agentLan")
        );
        assert_eq!(
            serde_json::to_value(ReachableFrom::SshServer).unwrap(),
            serde_json::json!("sshServer")
        );
    }
}
