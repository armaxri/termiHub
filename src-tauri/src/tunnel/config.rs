use serde::{Deserialize, Serialize};

use crate::agent_service::Reason;
use crate::connection::id_changes::ConnectionIdRemap;
use termihub_core::util::entry_extra::{EntryExtra, StoreEntry};
use termihub_core::util::service_cause::ServiceCause;
use termihub_core::util::service_host::ServiceHost;

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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "type", content = "config", rename_all = "camelCase")]
pub enum TunnelType {
    /// Local port forwarding: binds a local port and forwards to a remote target via SSH.
    Local(
        #[cfg_attr(test, ts(type = "import(\"./LocalForwardConfig\").LocalForwardConfig"))]
        LocalForwardConfig,
    ),
    /// Remote port forwarding: binds a port on the SSH server and forwards to a local target.
    Remote(
        #[cfg_attr(
            test,
            ts(type = "import(\"./RemoteForwardConfig\").RemoteForwardConfig")
        )]
        RemoteForwardConfig,
    ),
    /// Dynamic (SOCKS5) forwarding: binds a local port as a SOCKS5 proxy via SSH.
    Dynamic(
        #[cfg_attr(
            test,
            ts(type = "import(\"./DynamicForwardConfig\").DynamicForwardConfig")
        )]
        DynamicForwardConfig,
    ),
}

/// A saved tunnel configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    /// Unique tunnel identifier.
    pub id: String,
    /// User-friendly name for this tunnel.
    pub name: String,
    /// Optional short description the user wrote (#5770), shown muted under
    /// the name in the sidebar. Absent when unset, so older files round-trip
    /// unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    /// ID of the saved SSH connection to use for this tunnel.
    pub ssh_connection_id: String,
    /// Tunnel type and its specific configuration.
    pub tunnel_type: TunnelType,
    /// Which machine hosts (runs the SSH client for) this tunnel.
    ///
    /// Absent or "this computer": the forward runs on the desktop. An agent
    /// hosts it over the agent RPC (S3, #2155). Kept verbatim when this build
    /// cannot read it, and the tunnel is then not started (#6028).
    #[serde(default, skip_serializing_if = "ServiceHost::is_absent")]
    #[cfg_attr(test, ts(optional, type = "import(\"./RunLocation\").RunLocation"))]
    pub host: ServiceHost,
    /// Whether to start this tunnel automatically when the app launches.
    #[serde(default)]
    pub auto_start: bool,
    /// Whether to start this tunnel whenever a terminal session for its SSH
    /// connection (`ssh_connection_id`) connects — the per-connection
    /// `LocalForward`/`RemoteForward`/`DynamicForward` binding of PROD-023.
    ///
    /// Independent of [`auto_start`](Self::auto_start) (app launch). Defaulted on
    /// deserialize so tunnels saved before this field existed load unchanged, as
    /// not bound to their connection's sessions.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub start_with_connection: bool,
    /// Whether to reconnect automatically on disconnect.
    #[serde(default)]
    pub reconnect_on_disconnect: bool,
    /// For a chained **companion** tunnel — the desktop-hosted hop created by
    /// "Chain a hop to this computer" (#2597) — the id of its agent-hosted
    /// **parent**. `None` for a normal, unchained tunnel and for the parent
    /// itself.
    ///
    /// The link is stored on one side only: the companion points at its parent,
    /// and the parent's side of the link (`companionId`) is *derived* from this
    /// field, so the pairing has a single source of truth and cannot drift.
    /// Defaulted on deserialize and skipped when absent, so tunnels saved before
    /// chaining existed round-trip byte-for-byte unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub companion_of: Option<String>,
    /// Unknown fields of this entry in `tunnels.json`, kept verbatim so this
    /// build's save does not erase what a newer one wrote (#6028).
    #[serde(flatten, default)]
    #[cfg_attr(test, ts(skip))]
    pub extra: EntryExtra,
}

impl StoreEntry for TunnelConfig {
    fn entry_id(&self) -> &str {
        &self.id
    }
    fn entry_extra_mut(&mut self) -> &mut EntryExtra {
        &mut self.extra
    }
}

/// Current status of a tunnel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum TunnelStatus {
    Disconnected,
    /// Will start by itself when its agent is connected or the credential
    /// store is unlocked (#6028).
    Waiting,
    Connecting,
    Connected,
    Reconnecting,
    /// Stopped by the user; its agent has not confirmed it yet (#6028).
    Stopping,
    Error,
    /// Its agent is offline or does not answer: it may still run there (#6028).
    NotReachable,
    /// Its SSH connection was deleted (#2850): the tunnel is kept but cannot
    /// start until it is edited to use another SSH connection.
    MissingConnection,
}

/// Map a [`TunnelStatus`] onto the canonical
/// [`SessionStatus`](termihub_core::connection::lifecycle::SessionStatus) (SM-020
/// slice 0, additive — not yet wired into any runtime path). Total: `Error` maps
/// to the canonical terminal [`Failed`](termihub_core::connection::lifecycle::SessionStatus::Failed)
/// (the tunnel carries the message in its own `error` field); every other variant
/// has an exact canonical twin. Defined here rather than in `core` because `core`
/// cannot name the desktop-defined [`TunnelStatus`] (dependency direction + orphan
/// rules).
impl From<TunnelStatus> for termihub_core::connection::lifecycle::SessionStatus {
    fn from(status: TunnelStatus) -> Self {
        use termihub_core::connection::lifecycle::SessionStatus;
        match status {
            TunnelStatus::Disconnected => SessionStatus::Disconnected,
            TunnelStatus::Connecting => SessionStatus::Connecting,
            TunnelStatus::Connected => SessionStatus::Connected,
            TunnelStatus::Reconnecting => SessionStatus::Reconnecting,
            TunnelStatus::Error => SessionStatus::Failed,
            // No live session this desktop knows of.
            TunnelStatus::Waiting | TunnelStatus::Stopping | TunnelStatus::NotReachable => {
                SessionStatus::Disconnected
            }
            // A resting, not-running state: nothing failed at runtime, the
            // tunnel just cannot start until it is repointed (#2850).
            TunnelStatus::MissingConnection => SessionStatus::Disconnected,
        }
    }
}

#[cfg(test)]
mod tunnel_status_map_tests {
    use super::TunnelStatus;
    use termihub_core::connection::lifecycle::SessionStatus;

    #[test]
    fn maps_every_tunnel_status_to_canonical() {
        // Total: every TunnelStatus variant has a canonical target.
        let cases = [
            (TunnelStatus::Disconnected, SessionStatus::Disconnected),
            (TunnelStatus::Connecting, SessionStatus::Connecting),
            (TunnelStatus::Connected, SessionStatus::Connected),
            (TunnelStatus::Reconnecting, SessionStatus::Reconnecting),
            (TunnelStatus::Error, SessionStatus::Failed),
            (TunnelStatus::Waiting, SessionStatus::Disconnected),
            (TunnelStatus::Stopping, SessionStatus::Disconnected),
            (TunnelStatus::NotReachable, SessionStatus::Disconnected),
            (TunnelStatus::MissingConnection, SessionStatus::Disconnected),
        ];
        for (input, expected) in cases {
            assert_eq!(SessionStatus::from(input), expected);
        }
    }
}

/// Combined runtime state for a tunnel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    /// Tunnel ID this state belongs to.
    pub tunnel_id: String,
    /// Current status.
    pub status: TunnelStatus,
    /// Why it failed, or what a waiting, stopping or not reachable one is
    /// waiting for (#6028).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<String>,
    /// What the row can offer about it (#6063).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "import(\"./ServiceCause\").ServiceCause"))]
    pub cause: Option<ServiceCause>,
    /// Live traffic statistics.
    #[cfg_attr(test, ts(type = "import(\"./TunnelStats\").TunnelStats"))]
    pub stats: TunnelStats,
    /// For an agent-hosted tunnel: which agent forwards it (its agent id), as
    /// confirmed by the agent's report. `None` for desktop-hosted tunnels
    /// (#2199). The frontend resolves the id to a human agent name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub bound_on: Option<String>,
    /// For an agent-hosted tunnel: the `host:port` the listen socket actually
    /// bound (on the agent for `-L`/`-D`, on the SSH server for `-R`), reported
    /// by the agent. `None` for desktop-hosted tunnels (#2199).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub bound_address: Option<String>,
    /// For an agent-hosted tunnel: who can reach the listen socket, as the agent
    /// classified it at bind time. `None` for desktop-hosted tunnels (#2199).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "import(\"./ReachableFrom\").ReachableFrom"))]
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
        reason: Option<Reason>,
        stats: TunnelStats,
    ) -> Self {
        Self {
            tunnel_id,
            status,
            cause: reason.as_ref().and_then(|reason| reason.cause),
            error: reason.map(|reason| reason.text),
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
    /// Unknown top-level keys, preserved verbatim for forward compatibility
    /// (PER2-002).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl TunnelStore {
    /// Re-point every tunnel's SSH connection (`sshConnectionId`) along `remap`
    /// (#3596). Every tunnel's id is a saved desktop connection's — an
    /// agent-hosted tunnel's too: the desktop resolves it and hands the agent an
    /// inline config. Returns whether any tunnel changed.
    pub fn follow_connection_id_changes(&mut self, remap: &ConnectionIdRemap) -> bool {
        remap.apply_all(self.tunnels.iter_mut().map(|t| &mut t.ssh_connection_id))
    }

    /// Add `tunnel`, or replace the tunnel with its id. Returns whether a stored
    /// tunnel now runs on another machine than before (#6028).
    ///
    /// A replaced tunnel keeps its unknown fields, and its stored host when the
    /// incoming copy has none. A new one keeps the unknown fields it came with:
    /// the Undo of a delete and a Duplicate send back what was stored.
    pub fn upsert(&mut self, mut tunnel: TunnelConfig) -> bool {
        let Some(stored) = self.tunnels.iter_mut().find(|t| t.id == tunnel.id) else {
            self.tunnels.push(tunnel);
            return false;
        };
        tunnel.host.keep_if_absent(&stored.host);
        tunnel.extra = std::mem::take(&mut stored.extra);
        let moved = tunnel.host.choice() != stored.host.choice();
        *stored = tunnel;
        moved
    }

    /// The schema version this build reads and writes. The single source of
    /// truth for the store's version: the default document and the unified
    /// backup (PROD-068) both take it from here, so a bump is picked up
    /// everywhere at once.
    pub const CURRENT_VERSION: u32 = 1;
}

impl Default for TunnelStore {
    fn default() -> Self {
        Self {
            version: Self::CURRENT_VERSION.to_string(),
            tunnels: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// `tunnels.json` joins the shared schema-version gate (PER2-002): a newer
/// file is refused instead of reset, and a corrupt one is salvaged per tunnel.
impl crate::utils::migrate::VersionedStore for TunnelStore {
    const STORE_NAME: &'static str = "tunnels.json";
    const CURRENT_VERSION: u32 = TunnelStore::CURRENT_VERSION;

    fn salvage(value: serde_json::Value, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, TunnelConfig>(value, file_name, "tunnels")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::util::service_host::HostChoice;

    /// #5770: the description is optional and backward compatible — a file
    /// without one loads as none and saves without the key; a set one
    /// round-trips.
    #[test]
    fn tunnel_description_is_optional_and_round_trips() {
        let json = r#"{"id":"t","name":"db","sshConnectionId":"c","tunnelType":{"type":"dynamic",
            "config":{"localHost":"127.0.0.1","localPort":1080}},"autoStart":false,
            "reconnectOnDisconnect":false}"#;
        let mut tunnel: TunnelConfig = serde_json::from_str(json).unwrap();
        assert_eq!(tunnel.description, None);
        assert!(!serde_json::to_string(&tunnel)
            .unwrap()
            .contains("description"));

        tunnel.description = Some("Reaches the prod DB".to_string());
        let back: TunnelConfig =
            serde_json::from_str(&serde_json::to_string(&tunnel).unwrap()).unwrap();
        assert_eq!(back.description.as_deref(), Some("Reaches the prod DB"));
    }

    #[test]
    fn tunnel_config_local_serde_round_trip() {
        let config = TunnelConfig {
            description: None,
            id: "tun-1".to_string(),
            name: "Dev DB".to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 5432,
                remote_host: "db.internal".to_string(),
                remote_port: 5432,
            }),
            host: ServiceHost::this_computer(),
            auto_start: true,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: None,
            extra: Default::default(),
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
            description: None,
            id: "tun-2".to_string(),
            name: "Expose Web".to_string(),
            ssh_connection_id: "conn-2".to_string(),
            tunnel_type: TunnelType::Remote(RemoteForwardConfig {
                remote_host: "0.0.0.0".to_string(),
                remote_port: 8080,
                local_host: "127.0.0.1".to_string(),
                local_port: 3000,
            }),
            host: ServiceHost::this_computer(),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: true,
            companion_of: None,
            extra: Default::default(),
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
            description: None,
            id: "tun-3".to_string(),
            name: "SOCKS Proxy".to_string(),
            ssh_connection_id: "conn-3".to_string(),
            tunnel_type: TunnelType::Dynamic(DynamicForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 1080,
            }),
            host: ServiceHost::this_computer(),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: None,
            extra: Default::default(),
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
            extra: Default::default(),
            tunnels: vec![TunnelConfig {
                description: None,
                id: "tun-1".to_string(),
                name: "Test".to_string(),
                ssh_connection_id: "conn-1".to_string(),
                tunnel_type: TunnelType::Local(LocalForwardConfig {
                    local_host: "127.0.0.1".to_string(),
                    local_port: 8080,
                    remote_host: "localhost".to_string(),
                    remote_port: 80,
                }),
                host: ServiceHost::this_computer(),
                auto_start: false,
                start_with_connection: false,
                reconnect_on_disconnect: false,
                companion_of: None,
                extra: Default::default(),
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
            cause: None,
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
            Some("Connection refused".into()),
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
        assert!(!config.start_with_connection);
        assert!(!config.reconnect_on_disconnect);
        // A config saved before the run-location field existed loads as
        // desktop-hosted, so agent hosting is opt-in (S3, #2155).
        assert_eq!(config.host.choice(), HostChoice::ThisComputer);
    }

    #[test]
    fn host_round_trips_and_defaults_to_this_computer() {
        // Explicit agent host round-trips through the tagged run-location shape.
        let config = TunnelConfig {
            description: None,
            id: "tun-agent".to_string(),
            name: "Agent DB".to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 5432,
                remote_host: "db.internal".to_string(),
                remote_port: 5432,
            }),
            host: ServiceHost::agent("build-box"),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: None,
            extra: Default::default(),
        };
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["host"]["kind"], "agent");
        assert_eq!(json["host"]["agentId"], "build-box");
        let back: TunnelConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.host.choice(), HostChoice::Agent("build-box"));

        // The serde default (no field in JSON) is desktop hosting.
        assert_eq!(ServiceHost::default().choice(), HostChoice::ThisComputer);
    }

    #[test]
    fn companion_of_round_trips_and_defaults_to_none() {
        // A companion carries its parent's id; it round-trips as camelCase
        // `companionOf`.
        let companion = TunnelConfig {
            description: None,
            id: "tun-companion".to_string(),
            name: "hop on this computer".to_string(),
            ssh_connection_id: "conn-agent".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 5432,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 5432,
            }),
            host: ServiceHost::this_computer(),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: Some("tun-parent".to_string()),
            extra: Default::default(),
        };
        let json = serde_json::to_value(&companion).unwrap();
        assert_eq!(json["companionOf"], "tun-parent");
        let back: TunnelConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.companion_of.as_deref(), Some("tun-parent"));

        // Absent on an unchained tunnel: it defaults to `None` and stays off the
        // wire, so pre-chaining `tunnels.json` files round-trip unchanged.
        let plain = r#"{
            "id": "tun-1",
            "name": "Test",
            "sshConnectionId": "conn-1",
            "tunnelType": {
                "type": "dynamic",
                "config": { "localHost": "127.0.0.1", "localPort": 1080 }
            }
        }"#;
        let config: TunnelConfig = serde_json::from_str(plain).unwrap();
        assert_eq!(config.companion_of, None);
        let reserialized = serde_json::to_string(&config).unwrap();
        assert!(!reserialized.contains("companionOf"));
    }

    #[test]
    fn serde_produces_correct_json_shape() {
        let config = TunnelConfig {
            description: None,
            id: "test".to_string(),
            name: "Test".to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 8080,
                remote_host: "localhost".to_string(),
                remote_port: 80,
            }),
            host: ServiceHost::this_computer(),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: None,
            extra: Default::default(),
        };
        let json: serde_json::Value = serde_json::to_value(&config).unwrap();
        // Check camelCase renaming
        assert!(json.get("sshConnectionId").is_some());
        assert!(json.get("tunnelType").is_some());
        assert!(json.get("autoStart").is_some());
        assert!(json.get("startWithConnection").is_some());
        // Check tagged enum format
        let tunnel_type = json.get("tunnelType").unwrap();
        assert_eq!(tunnel_type.get("type").unwrap(), "local");
        assert!(tunnel_type.get("config").is_some());
    }

    #[test]
    fn tunnels_follow_connection_id_changes_simultaneously() {
        let tunnel = |id: &str, conn: &str| TunnelConfig {
            description: None,
            id: id.to_string(),
            name: id.to_string(),
            ssh_connection_id: conn.to_string(),
            tunnel_type: TunnelType::Dynamic(DynamicForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 1080,
            }),
            host: ServiceHost::this_computer(),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: None,
            extra: Default::default(),
        };
        let mut store = TunnelStore {
            tunnels: vec![tunnel("t1", "Work/a"), tunnel("t2", "b"), tunnel("t3", "x")],
            ..TunnelStore::default()
        };
        let changes = [
            crate::connection::id_changes::ConnectionIdChange::new("Work/a", "b"),
            crate::connection::id_changes::ConnectionIdChange::new("b", "c"),
        ];

        assert!(store.follow_connection_id_changes(&ConnectionIdRemap::new(&changes)));

        let ids: Vec<&str> = store
            .tunnels
            .iter()
            .map(|t| t.ssh_connection_id.as_str())
            .collect();
        assert_eq!(ids, ["b", "c", "x"]);
        assert!(!store.follow_connection_id_changes(&ConnectionIdRemap::new(&[])));
    }

    // ── Saving a tunnel (#6028) ─────────────────────────────────────────────

    fn stored_tunnel(json: serde_json::Value) -> TunnelConfig {
        let mut tunnel = serde_json::json!({
            "id": "t", "name": "t", "sshConnectionId": "c", "autoStart": false,
            "reconnectOnDisconnect": false,
            "tunnelType": {"type": "dynamic", "config": {"localHost": "127.0.0.1", "localPort": 1}},
        });
        tunnel
            .as_object_mut()
            .unwrap()
            .extend(json.as_object().unwrap().clone());
        serde_json::from_value(tunnel).unwrap()
    }

    fn store_of(tunnel: TunnelConfig) -> TunnelStore {
        TunnelStore {
            tunnels: vec![tunnel],
            ..TunnelStore::default()
        }
    }

    #[test]
    fn a_save_keeps_unknown_fields_and_a_host_the_editor_did_not_send() {
        let host = serde_json::json!({"kind": "cluster", "clusterId": "a"});
        let mut store = store_of(stored_tunnel(
            serde_json::json!({"host": host, "future": {"deep": 1}}),
        ));
        assert!(!store.upsert(stored_tunnel(
            serde_json::json!({"name": "renamed", "future": "from the editor"})
        )));
        let saved = serde_json::to_value(&store.tunnels[0]).unwrap();
        assert_eq!(saved["name"], "renamed");
        assert_eq!(saved["host"], host);
        assert_eq!(saved["future"], serde_json::json!({"deep": 1}));
    }

    #[test]
    fn a_restored_or_copied_tunnel_keeps_the_unknown_fields_it_came_with() {
        let mut store = TunnelStore::default();
        assert!(!store.upsert(stored_tunnel(serde_json::json!({"future": 1}))));
        assert_eq!(
            serde_json::to_value(&store.tunnels[0]).unwrap()["future"],
            1
        );
    }

    #[test]
    fn only_another_machine_counts_as_moved() {
        let agent = serde_json::json!({"host": {"kind": "agent", "agentId": "a"}});
        let here = serde_json::json!({"host": {"kind": "thisComputer"}});
        let cases = [
            (serde_json::json!({}), here.clone(), false),
            (here.clone(), agent.clone(), true),
            (agent.clone(), agent.clone(), false),
            (agent.clone(), here, true),
            (agent, serde_json::json!({"name": "x"}), false),
            (
                serde_json::json!({"host": {"kind": "agent", "agentId": "a"}}),
                serde_json::json!({"host": {"kind": "agent", "agentId": "b"}}),
                true,
            ),
        ];
        for (before, after, moved) in cases {
            let mut store = store_of(stored_tunnel(before.clone()));
            assert_eq!(
                store.upsert(stored_tunnel(after.clone())),
                moved,
                "{before} -> {after}"
            );
        }
    }
}
