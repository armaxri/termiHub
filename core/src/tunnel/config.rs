//! Shared configuration and stats types for the tunnel forwarders (#2185).
//!
//! These are the pure data types the local-forward engine consumes and
//! reports. They live in core so the same forwarder runs on the desktop and on
//! an agent (S3, part of #2139); the desktop `tunnel::config` module re-exports
//! them so existing call sites are unchanged.

use serde::{Deserialize, Serialize};

/// Configuration for local port forwarding (ssh -L).
///
/// The listen socket binds on the tunnel host (`local_host:local_port`); each
/// accepted connection is forwarded to `remote_host:remote_port` resolved from
/// the SSH server's network. On an agent-hosted tunnel the "local" side is the
/// agent — see `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalForwardConfig {
    /// Local address to bind (e.g. "127.0.0.1").
    pub local_host: String,
    /// Local port to listen on.
    pub local_port: u16,
    /// Remote host to connect to (from the SSH server's perspective).
    pub remote_host: String,
    /// Remote port to connect to.
    pub remote_port: u16,
}

/// Configuration for remote port forwarding (ssh -R).
///
/// The listen socket binds on the **SSH server** (`remote_host:remote_port`);
/// each incoming connection is forwarded to `local_host:local_port` resolved
/// from the tunnel host's network. On an agent-hosted tunnel the "local" side is
/// the agent — the target is reached from the agent, not the desktop. See
/// `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteForwardConfig {
    /// Address on the SSH server to bind.
    pub remote_host: String,
    /// Port on the SSH server to listen on.
    pub remote_port: u16,
    /// Local host to forward connections to (resolved from the tunnel host).
    pub local_host: String,
    /// Local port to forward connections to (resolved from the tunnel host).
    pub local_port: u16,
}

/// Live traffic statistics for an active tunnel.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStats {
    /// Total bytes sent through the tunnel.
    pub bytes_sent: u64,
    /// Total bytes received through the tunnel.
    pub bytes_received: u64,
    /// Number of currently active connections through the tunnel.
    pub active_connections: u32,
    /// Total connections made since the tunnel started.
    pub total_connections: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_forward_config_round_trips_camel_case() {
        let config = LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 5432,
            remote_host: "db.internal".to_string(),
            remote_port: 5432,
        };
        let json = serde_json::to_value(&config).unwrap();
        assert!(json.get("localHost").is_some());
        assert!(json.get("remotePort").is_some());
        let back: LocalForwardConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn remote_forward_config_round_trips_camel_case() {
        let config = RemoteForwardConfig {
            remote_host: "0.0.0.0".to_string(),
            remote_port: 8080,
            local_host: "127.0.0.1".to_string(),
            local_port: 3000,
        };
        let json = serde_json::to_value(&config).unwrap();
        assert!(json.get("remoteHost").is_some());
        assert!(json.get("localPort").is_some());
        let back: RemoteForwardConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn tunnel_stats_default_is_zero() {
        let stats = TunnelStats::default();
        assert_eq!(stats.bytes_sent, 0);
        assert_eq!(stats.active_connections, 0);
    }
}
