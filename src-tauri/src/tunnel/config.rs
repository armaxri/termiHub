use serde::{Deserialize, Serialize};

use crate::run_location::RunLocation;

// `LocalForwardConfig`, `RemoteForwardConfig`, `DynamicForwardConfig`, and
// `TunnelStats` were lifted into core (#2185, #2198) so the shared forward
// engines run on the desktop or an agent (S3, part of #2139). Re-exported here
// so `TunnelType::Local(LocalForwardConfig)`,
// `TunnelType::Remote(RemoteForwardConfig)`,
// `TunnelType::Dynamic(DynamicForwardConfig)`, `TunnelState { stats }`, and
// every existing call site are unchanged.
pub use termihub_core::tunnel::config::{
    DynamicForwardConfig, LocalForwardConfig, RemoteForwardConfig, TunnelStats,
};
// `ReachableFrom` (who can reach an agent-hosted tunnel's listen socket) lives in
// core beside the forward engines. Re-exported here so `TunnelState` can carry
// the agent-reported vantage (#2199) and desktop call sites use the one type.
pub use termihub_core::tunnel::ReachableFrom;

/// The three SSH tunnel types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "config", rename_all = "camelCase")]
pub enum TunnelType {
    /// Local port forwarding: binds a local port and forwards to a remote target via SSH.
    Local(LocalForwardConfig),
    /// Remote port forwarding: binds a port on the SSH server and forwards to a local target.
    Remote(RemoteForwardConfig),
    /// Dynamic (SOCKS5) forwarding: binds a local port as a SOCKS5 proxy via SSH.
    Dynamic(DynamicForwardConfig),
}

/// A saved tunnel configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    /// Unique tunnel identifier.
    pub id: String,
    /// User-friendly name for this tunnel.
    pub name: String,
    /// ID of the saved SSH connection to use for this tunnel.
    pub ssh_connection_id: String,
    /// Tunnel type and its specific configuration.
    pub tunnel_type: TunnelType,
    /// Which machine hosts (runs the SSH client for) this tunnel.
    ///
    /// [`RunLocation::ThisComputer`] (the default) is today's behaviour — the
    /// forward runs on the desktop. [`RunLocation::Agent`] routes hosting to a
    /// remote agent through the S1 run-location resolver (S3, #2155). Defaulted
    /// on deserialize so tunnels saved before this field existed load as
    /// desktop-hosted, and so agent hosting stays opt-in.
    #[serde(default)]
    pub host: RunLocation,
    /// Whether to start this tunnel automatically when the app launches.
    #[serde(default)]
    pub auto_start: bool,
    /// Whether to reconnect automatically on disconnect.
    #[serde(default)]
    pub reconnect_on_disconnect: bool,
}

/// Current status of a tunnel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

/// Combined runtime state for a tunnel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    /// Tunnel ID this state belongs to.
    pub tunnel_id: String,
    /// Current status.
    pub status: TunnelStatus,
    /// Error message, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Live traffic statistics.
    pub stats: TunnelStats,
    /// For an agent-hosted tunnel: which agent forwards it (its agent id), as
    /// confirmed by the agent's report. `None` for desktop-hosted tunnels
    /// (#2199). The frontend resolves the id to a human agent name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_on: Option<String>,
    /// For an agent-hosted tunnel: the `host:port` the listen socket actually
    /// bound (on the agent for `-L`/`-D`, on the SSH server for `-R`), reported
    /// by the agent. `None` for desktop-hosted tunnels (#2199).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_address: Option<String>,
    /// For an agent-hosted tunnel: who can reach the listen socket, as the agent
    /// classified it at bind time. `None` for desktop-hosted tunnels (#2199).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable_from: Option<ReachableFrom>,
}

impl TunnelState {
    /// A desktop-hosted (or not-yet-resolved) tunnel state: no agent vantage.
    ///
    /// The common constructor for every non-agent path, so adding an agent-only
    /// field to the view model does not churn each call site.
    pub fn desktop(
        tunnel_id: String,
        status: TunnelStatus,
        error: Option<String>,
        stats: TunnelStats,
    ) -> Self {
        Self {
            tunnel_id,
            status,
            error,
            stats,
            bound_on: None,
            bound_address: None,
            reachable_from: None,
        }
    }
}

/// Top-level schema for the tunnels JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStore {
    pub version: String,
    pub tunnels: Vec<TunnelConfig>,
}

impl Default for TunnelStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            tunnels: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_config_local_serde_round_trip() {
        let config = TunnelConfig {
            id: "tun-1".to_string(),
            name: "Dev DB".to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 5432,
                remote_host: "db.internal".to_string(),
                remote_port: 5432,
            }),
            host: RunLocation::ThisComputer,
            auto_start: true,
            reconnect_on_disconnect: false,
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: TunnelConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "tun-1");
        assert_eq!(deserialized.name, "Dev DB");
        assert!(deserialized.auto_start);
        if let TunnelType::Local(local) = &deserialized.tunnel_type {
            assert_eq!(local.local_port, 5432);
            assert_eq!(local.remote_host, "db.internal");
        } else {
            panic!("Expected Local tunnel type");
        }
    }

    #[test]
    fn tunnel_config_remote_serde_round_trip() {
        let config = TunnelConfig {
            id: "tun-2".to_string(),
            name: "Expose Web".to_string(),
            ssh_connection_id: "conn-2".to_string(),
            tunnel_type: TunnelType::Remote(RemoteForwardConfig {
                remote_host: "0.0.0.0".to_string(),
                remote_port: 8080,
                local_host: "127.0.0.1".to_string(),
                local_port: 3000,
            }),
            host: RunLocation::ThisComputer,
            auto_start: false,
            reconnect_on_disconnect: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: TunnelConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "tun-2");
        assert!(deserialized.reconnect_on_disconnect);
        if let TunnelType::Remote(remote) = &deserialized.tunnel_type {
            assert_eq!(remote.remote_port, 8080);
            assert_eq!(remote.local_port, 3000);
        } else {
            panic!("Expected Remote tunnel type");
        }
    }

    #[test]
    fn tunnel_config_dynamic_serde_round_trip() {
        let config = TunnelConfig {
            id: "tun-3".to_string(),
            name: "SOCKS Proxy".to_string(),
            ssh_connection_id: "conn-3".to_string(),
            tunnel_type: TunnelType::Dynamic(DynamicForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 1080,
            }),
            host: RunLocation::ThisComputer,
            auto_start: false,
            reconnect_on_disconnect: false,
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: TunnelConfig = serde_json::from_str(&json).unwrap();
        if let TunnelType::Dynamic(dynamic) = &deserialized.tunnel_type {
            assert_eq!(dynamic.local_port, 1080);
        } else {
            panic!("Expected Dynamic tunnel type");
        }
    }

    #[test]
    fn tunnel_store_serde_round_trip() {
        let store = TunnelStore {
            version: "1".to_string(),
            tunnels: vec![TunnelConfig {
                id: "tun-1".to_string(),
                name: "Test".to_string(),
                ssh_connection_id: "conn-1".to_string(),
                tunnel_type: TunnelType::Local(LocalForwardConfig {
                    local_host: "127.0.0.1".to_string(),
                    local_port: 8080,
                    remote_host: "localhost".to_string(),
                    remote_port: 80,
                }),
                host: RunLocation::ThisComputer,
                auto_start: false,
                reconnect_on_disconnect: false,
            }],
        };
        let json = serde_json::to_string_pretty(&store).unwrap();
        let deserialized: TunnelStore = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.version, "1");
        assert_eq!(deserialized.tunnels.len(), 1);
    }

    #[test]
    fn tunnel_store_default_is_empty() {
        let store = TunnelStore::default();
        assert_eq!(store.version, "1");
        assert!(store.tunnels.is_empty());
    }

    #[test]
    fn tunnel_state_serde_round_trip() {
        let state = TunnelState::desktop(
            "tun-1".to_string(),
            TunnelStatus::Connected,
            None,
            TunnelStats {
                bytes_sent: 1024,
                bytes_received: 2048,
                active_connections: 2,
                total_connections: 10,
            },
        );
        let json = serde_json::to_string(&state).unwrap();
        let deserialized: TunnelState = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.status, TunnelStatus::Connected);
        assert!(deserialized.error.is_none());
        assert_eq!(deserialized.stats.bytes_sent, 1024);
        // Desktop tunnels carry no agent vantage, and it stays off the wire.
        assert!(deserialized.bound_on.is_none());
        assert!(deserialized.reachable_from.is_none());
        assert!(!json.contains("boundOn"));
        assert!(!json.contains("reachableFrom"));
    }

    #[test]
    fn tunnel_state_agent_vantage_round_trips_camel_case() {
        let state = TunnelState {
            tunnel_id: "tun-agent".to_string(),
            status: TunnelStatus::Connected,
            error: None,
            stats: TunnelStats::default(),
            bound_on: Some("build-box".to_string()),
            bound_address: Some("127.0.0.1:5432".to_string()),
            reachable_from: Some(ReachableFrom::AgentOnly),
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["boundOn"], "build-box");
        assert_eq!(json["boundAddress"], "127.0.0.1:5432");
        assert_eq!(json["reachableFrom"], "agentOnly");
        let back: TunnelState = serde_json::from_value(json).unwrap();
        assert_eq!(back.bound_on.as_deref(), Some("build-box"));
        assert_eq!(back.bound_address.as_deref(), Some("127.0.0.1:5432"));
        assert_eq!(back.reachable_from, Some(ReachableFrom::AgentOnly));
    }

    #[test]
    fn tunnel_state_error_included_when_set() {
        let state = TunnelState::desktop(
            "tun-1".to_string(),
            TunnelStatus::Error,
            Some("Connection refused".to_string()),
            TunnelStats::default(),
        );
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("Connection refused"));
        let deserialized: TunnelState = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.error.as_deref(), Some("Connection refused"));
    }

    #[test]
    fn tunnel_state_error_omitted_when_none() {
        let state = TunnelState::desktop(
            "tun-1".to_string(),
            TunnelStatus::Disconnected,
            None,
            TunnelStats::default(),
        );
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("error"));
    }

    #[test]
    fn auto_start_defaults_to_false() {
        let json = r#"{
            "id": "tun-1",
            "name": "Test",
            "sshConnectionId": "conn-1",
            "tunnelType": {
                "type": "dynamic",
                "config": { "localHost": "127.0.0.1", "localPort": 1080 }
            }
        }"#;
        let config: TunnelConfig = serde_json::from_str(json).unwrap();
        assert!(!config.auto_start);
        assert!(!config.reconnect_on_disconnect);
        // A config saved before the run-location field existed loads as
        // desktop-hosted, so agent hosting is opt-in (S3, #2155).
        assert_eq!(config.host, RunLocation::ThisComputer);
    }

    #[test]
    fn host_round_trips_and_defaults_to_this_computer() {
        // Explicit agent host round-trips through the tagged run-location shape.
        let config = TunnelConfig {
            id: "tun-agent".to_string(),
            name: "Agent DB".to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 5432,
                remote_host: "db.internal".to_string(),
                remote_port: 5432,
            }),
            host: RunLocation::Agent("build-box".to_string()),
            auto_start: false,
            reconnect_on_disconnect: false,
        };
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["host"]["kind"], "agent");
        assert_eq!(json["host"]["agentId"], "build-box");
        let back: TunnelConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.host, RunLocation::Agent("build-box".to_string()));

        // The serde default (no field in JSON) is desktop hosting.
        assert_eq!(RunLocation::default(), RunLocation::ThisComputer);
    }

    #[test]
    fn serde_produces_correct_json_shape() {
        let config = TunnelConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 8080,
                remote_host: "localhost".to_string(),
                remote_port: 80,
            }),
            host: RunLocation::ThisComputer,
            auto_start: false,
            reconnect_on_disconnect: false,
        };
        let json: serde_json::Value = serde_json::to_value(&config).unwrap();
        // Check camelCase renaming
        assert!(json.get("sshConnectionId").is_some());
        assert!(json.get("tunnelType").is_some());
        assert!(json.get("autoStart").is_some());
        // Check tagged enum format
        let tunnel_type = json.get("tunnelType").unwrap();
        assert_eq!(tunnel_type.get("type").unwrap(), "local");
        assert!(tunnel_type.get("config").is_some());
    }
}
