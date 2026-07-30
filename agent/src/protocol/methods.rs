// Fields deserialized from the protocol but not read by agent code
// are kept for protocol completeness and forward compatibility.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use termihub_core::config::{DockerConfig, EnvVar, SerialConfig, SshConfig, VolumeMount};
pub use termihub_core::connection::ConnectionTypeInfo;
use termihub_core::tunnel::config::{
    DynamicForwardConfig, LocalForwardConfig, RemoteForwardConfig, TunnelStats,
};
use termihub_core::tunnel::ReachableFrom;
// Used by shell/session modules on unix; re-exported for test access on all platforms.
#[allow(unused_imports)]
pub use termihub_core::config::ShellConfig;
pub use termihub_core::files::FileEntry;

// Type aliases for renamed types — minimises churn in consumer files.
pub type SerialSessionConfig = SerialConfig;
pub type DockerSessionConfig = DockerConfig;
pub type SshSessionConfig = SshConfig;
pub type DockerEnvVar = EnvVar;
pub type DockerVolumeMount = VolumeMount;

// ── initialize ──────────────────────────────────────────────────────

/// Runtime behaviour preferences sent by the desktop on connect.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    #[serde(default = "default_true")]
    pub enable_monitoring: bool,
    #[serde(default = "default_true")]
    pub enable_file_browser: bool,
    #[serde(default = "default_true")]
    pub enable_docker: bool,
    #[serde(default)]
    pub default_shell: Option<String>,
    #[serde(default)]
    pub starting_directory: String,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default)]
    pub verbose_tracing: bool,
    /// Ring-buffer size for persistent sessions in MiB (default: 1).
    #[serde(default = "default_persistent_buffer_mb")]
    pub persistent_scrollback_buffer_size_mb: u32,
}

fn default_true() -> bool {
    true
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_persistent_buffer_mb() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    pub client: String,
    pub client_version: String,
    /// Paths on the remote host to load as read-only external connection files.
    #[serde(default)]
    pub external_connection_files: Vec<String>,
    /// Runtime preferences from the desktop; applied on startup.
    #[serde(default)]
    pub agent_settings: AgentSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Available connection types from the registry.
    pub connection_types: Vec<ConnectionTypeInfo>,
    pub max_sessions: u32,
    pub available_shells: Vec<String>,
    pub available_serial_ports: Vec<String>,
    pub docker_available: bool,
    pub available_docker_images: Vec<String>,
    /// Whether system monitoring is supported on this host.
    pub monitoring_supported: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InitializeResult {
    pub protocol_version: String,
    pub agent_version: String,
    /// Agent-assigned id for this client connection.
    ///
    /// Lets the desktop recognise its own entry in an `agent.list_connections`
    /// snapshot so the connected-host update guard (#1349) can exclude itself.
    /// Added in protocol 0.3.0 (additive, backwards compatible).
    pub client_id: String,
    pub capabilities: Capabilities,
}

// ── agent.list_connections ───────────────────────────────────────────

/// Result of `agent.list_connections`: a snapshot of every client currently
/// connected to this agent process (see [`ConnectionInfo`]).
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionListResult {
    pub connections: Vec<ConnectionInfo>,
}

/// A single client connected to this agent process, as reported by
/// `agent.list_connections`. Mirrors the agent's internal `ConnectedClient`,
/// with the timestamp rendered as an ISO 8601 (RFC 3339) string for the wire.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionInfo {
    /// Agent-assigned id for this client connection.
    pub client_id: String,
    /// Client name reported in `initialize` (e.g. `"termihub-desktop"`).
    pub client: String,
    /// Client version reported in `initialize`.
    pub client_version: String,
    /// ISO 8601 timestamp of when the client completed `initialize`.
    pub connected_since: String,
}

// ── agent.settingsUpdate ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsUpdateParams {
    #[serde(flatten)]
    pub settings: AgentSettings,
}

// ── connection.types ────────────────────────────────────────────────

/// Result for the `connection.types` method.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionTypesResult {
    pub types: Vec<ConnectionTypeInfo>,
}

// ── session.create ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionCreateParams {
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    pub title: Option<String>,
    /// ID of the saved connection definition this session was created from, if any.
    /// Lets clients re-link an active session to its source definition after
    /// tab close, agent restart, or desktop restart.
    #[serde(default)]
    pub definition_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionCreateResult {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_id: Option<String>,
}

// ── session.list ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SessionListResult {
    pub sessions: Vec<SessionListEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionListEntry {
    pub session_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub created_at: String,
    pub last_activity: String,
    pub attached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_id: Option<String>,
}

// ── session.close ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionCloseParams {
    pub session_id: String,
}

// ── session.attach ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionAttachParams {
    pub session_id: String,
}

// ── session.detach ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionDetachParams {
    pub session_id: String,
}

// ── session.input ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionInputParams {
    pub session_id: String,
    /// Base64-encoded data.
    pub data: String,
}

// ── agent.forward.* (ssh-agent relay, #1727) ───────────────────────

/// Desktop → agent: reply bytes from the operator's local ssh-agent, tagged
/// with the forwarded stream they belong to.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentForwardDataParams {
    pub stream_id: String,
    /// Base64-encoded ssh-agent-protocol bytes.
    pub data: String,
}

/// Desktop → agent: a forwarded ssh-agent stream the desktop closed (its local
/// agent went away, or the conversation finished).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentForwardCloseParams {
    pub stream_id: String,
}

// ── session.resize ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionResizeParams {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

// ── session.getBuffer ───────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SessionGetBufferParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionGetBufferResult {
    pub session_id: String,
    /// Base64-encoded ring buffer contents.
    pub data: String,
}

// ── health.check ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct HealthCheckResult {
    pub status: String,
    pub uptime_secs: u64,
    pub active_sessions: u32,
}

// ── connections.create ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionCreateParams {
    pub name: String,
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub persistent: bool,
    pub folder_id: Option<String>,
    pub terminal_options: Option<serde_json::Value>,
    pub icon: Option<String>,
}

// ── connections.update ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionUpdateParams {
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub session_type: Option<String>,
    pub config: Option<serde_json::Value>,
    pub persistent: Option<bool>,
    /// Use JSON `null` to move to root, omit to leave unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub folder_id: Option<serde_json::Value>,
    /// Use JSON `null` to clear, omit to leave unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub terminal_options: Option<serde_json::Value>,
    /// Use JSON `null` to clear, omit to leave unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub icon: Option<serde_json::Value>,
}

// ── connections.delete ─────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionDeleteParams {
    pub id: String,
}

// ── connections.folders.create ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FolderCreateParams {
    pub name: String,
    pub parent_id: Option<String>,
}

// ── connections.folders.update ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FolderUpdateParams {
    pub id: String,
    pub name: Option<String>,
    /// Use JSON `null` to move to root, omit to leave unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_nullable")]
    pub parent_id: Option<serde_json::Value>,
    pub is_expanded: Option<bool>,
}

// ── connections.folders.delete ──────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FolderDeleteParams {
    pub id: String,
}

// ── Helper: distinguish absent field from explicit null ──────────────

/// Deserializes a field so that absent → `None`, explicit `null` → `Some(Value::Null)`,
/// and a present value → `Some(value)`. Standard `Option<Value>` collapses both
/// absent and null into `None`.
fn deserialize_optional_nullable<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(serde_json::Value::deserialize(deserializer)?))
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesListParams {
    /// Connection to scope the operation to. If absent, use local filesystem.
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilesListResult {
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesReadParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilesReadResult {
    /// Base64-encoded file content.
    pub data: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesWriteParams {
    pub connection_id: Option<String>,
    pub path: String,
    /// Base64-encoded content to write.
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesDeleteParams {
    pub connection_id: Option<String>,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesRenameParams {
    pub connection_id: Option<String>,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesStatParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesMkdirParams {
    pub connection_id: Option<String>,
    pub path: String,
}

/// Type alias for backward compatibility — stat results use the same shape
/// as [`FileEntry`] from the core crate.
pub type FilesStatResult = FileEntry;

// ── agent.shutdown ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct AgentShutdownParams {
    /// Optional reason: "update", "user", etc.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentShutdownResult {
    /// Number of sessions that were detached (left running in daemons).
    pub detached_sessions: u32,
}

// ── agent.request_deferred_update ───────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestDeferredUpdateParams {
    /// Absolute path (on the agent host) to the new agent binary to stage.
    /// Omit to apply an update the agent already staged itself (self-update).
    #[serde(default)]
    pub binary_path: Option<String>,
    /// Optional target version label (bookkeeping only).
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestDeferredUpdateResult {
    /// `true` if the update was applied immediately (agent was idle); `false`
    /// if it was deferred until the last session disconnects.
    pub applied: bool,
    /// Number of sessions still active (0 when applied immediately).
    pub active_sessions: u32,
}

// ── agent.request_update ────────────────────────────────────────────

/// Params for `agent.request_update` — a coordinated update (#1351, SI-5).
///
/// Same staging inputs as [`AgentRequestDeferredUpdateParams`], because the
/// binary swap itself *is* the deferred path: coordination decides when it is
/// polite to apply, not how. What this adds is the courtesy window — every other
/// host is told first and given a chance to leave cleanly.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestUpdateParams {
    /// Absolute path (on the agent host) to the new agent binary to stage.
    /// Omit to apply an update the agent already staged itself (self-update).
    #[serde(default)]
    pub binary_path: Option<String>,
    /// Optional target version label (bookkeeping only).
    #[serde(default)]
    pub version: Option<String>,
    /// How long other hosts get to disconnect before the update proceeds
    /// anyway. Omit for the default 10 s
    /// ([`ACK_TIMEOUT`](crate::update::ACK_TIMEOUT)); tests use a short window
    /// so they need not sit through it.
    #[serde(default)]
    pub ack_timeout_secs: Option<u64>,
}

/// Result of `agent.request_update`.
///
/// Reports the coordination outcome as well as the apply outcome, so the
/// initiating desktop can say *"3 hosts were notified, 1 was still connected"*
/// rather than only "done". `allAcked: false` is not an error — the update
/// proceeded — it means someone got the hard cut.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestUpdateResult {
    /// `true` if the update was applied immediately (agent was idle); `false`
    /// if it was deferred until the last session disconnects.
    pub applied: bool,
    /// Number of sessions still active (0 when applied immediately).
    pub active_sessions: u32,
    /// How many *other* hosts were sent the `agent.update_pending` notice.
    pub notified_clients: u32,
    /// `true` when every notified host disconnected inside the window (or there
    /// was nobody to notify); `false` when the window closed with hosts still
    /// attached, or when no host-wide view was available.
    pub all_acked: bool,
    /// `client_id`s still attached when the window closed. Empty on the happy
    /// path.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remaining_clients: Vec<String>,
}

// ── agent.update_pending (notification payload) ─────────────────────

/// JSON-RPC method name for the coordinated-update notice (#1351).
///
/// Broadcast (Agent → every *other* Desktop) when one host calls
/// `agent.request_update`. The receiving desktop surfaces the "being updated by
/// another host" notice, suspends its sessions, disconnects cleanly, and queues
/// an auto-reconnect to the new version.
///
/// Its delivery path is the only one in the agent that is **cross-worker**: the
/// per-process notification channel is single-consumer and can only ever reach
/// this worker's own client, so this travels through the registry daemon's
/// broadcast (ADR-11 / #1574) to reach the other hosts' workers.
pub const AGENT_UPDATE_PENDING: &str = "agent.update_pending";

/// Payload of an [`AGENT_UPDATE_PENDING`] notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePendingNotification {
    /// Version of the desktop client that requested the update, so the notice
    /// can name who is updating the agent. `"unknown"` when the requester's
    /// record could not be read.
    pub requested_by_version: String,
    /// How long the agent expects to be unavailable, for the notice's restart
    /// progress. An estimate, not a guarantee.
    pub estimated_restart_secs: u64,
}

// ── network.port_scan ───────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkPortScanParams {
    pub host: String,
    /// Port specification: "22", "80,443", "1-1024"
    pub ports: String,
    pub timeout_ms: Option<u64>,
    pub concurrency: Option<usize>,
}

pub use termihub_core::network::types::{
    OpenPort, PingResult, PingStats, PortScanResult, PortScanSummary, TracerouteHop,
};

#[derive(Debug, Clone, Serialize)]
pub struct NetworkPortScanResponse {
    pub results: Vec<PortScanResult>,
    pub summary: PortScanSummary,
}

// ── network.ping ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkPingParams {
    pub host: String,
    pub count: Option<u32>,
    pub interval_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkPingResponse {
    pub results: Vec<PingResult>,
    pub stats: PingStats,
}

// ── network.dns_lookup ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkDnsLookupParams {
    pub hostname: String,
    pub record_type: String,
    pub server: Option<String>,
}

// ── network.open_ports ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct NetworkOpenPortsResponse {
    pub ports: Vec<OpenPort>,
}

// ── network.traceroute ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkTracerouteParams {
    pub host: String,
    pub max_hops: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkTracerouteResponse {
    pub hops: Vec<TracerouteHop>,
}

// ── network.wol ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkWolParams {
    pub mac: String,
    #[serde(default = "default_broadcast")]
    pub broadcast: String,
    #[serde(default = "default_wol_port")]
    pub port: u16,
}

fn default_broadcast() -> String {
    "255.255.255.255".to_string()
}

fn default_wol_port() -> u16 {
    9
}

// ── monitoring.subscribe ────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct MonitoringSubscribeParams {
    /// `"self"` for the agent's own host, or a connection ID for a jump target.
    pub host: String,
    /// Collection interval in milliseconds (default: 2000).
    pub interval_ms: Option<u64>,
}

// ── monitoring.unsubscribe ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct MonitoringUnsubscribeParams {
    pub host: String,
}

// ── monitoring.data (notification payload) ──────────────────────────

/// System statistics sent as a `monitoring.data` notification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringData {
    /// `"self"` or connection ID identifying the monitored host.
    pub host: String,
    pub hostname: String,
    pub uptime_seconds: f64,
    pub load_average: [f64; 3],
    pub cpu_usage_percent: f64,
    pub memory_total_kb: u64,
    pub memory_available_kb: u64,
    pub memory_used_percent: f64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_used_percent: f64,
    pub os_info: String,
}

// ── agent.update_available (notification payload) ───────────────────

/// JSON-RPC method name for the agent self-update notification (#1355).
///
/// Emitted (Agent → Desktop) when the agent's background GitHub poll finds a
/// newer release; the desktop surfaces it as the self-update toast.
pub const AGENT_UPDATE_AVAILABLE: &str = "agent.update_available";

/// Payload of an [`AGENT_UPDATE_AVAILABLE`] notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailableNotification {
    /// The agent's currently running version (`CARGO_PKG_VERSION`).
    pub current_version: String,
    /// The newer version available on GitHub Releases (release tag semver).
    pub available_version: String,
    /// Download URL of the matching binary asset, when one is published for
    /// this platform.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    /// `true` once the binary has been downloaded and SHA-256-verified to the
    /// agent's staging path; `false` when only a newer version was detected.
    pub staged: bool,
}

// ── tunnel.* (agent-hosted forwarding, #2185) ───────────────────────
//
// An agent-hosted tunnel runs its SSH client and listen socket on the agent;
// the desktop keeps only control (start/stop/status over this RPC). Endpoint
// semantics: `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.

/// Which forwarding mode an agent-hosted tunnel runs.
///
/// **Local** (`ssh -L`), **remote** (`ssh -R`), and **dynamic** (`ssh -D`,
/// SOCKS5) are all implemented (#2185, #2198). Tagged so further variants can be
/// added additively without breaking the existing shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum TunnelForwardSpec {
    /// Local (`ssh -L`) forwarding: the listen socket binds on the agent and the
    /// target is resolved from the SSH server's network.
    Local(LocalForwardConfig),
    /// Remote (`ssh -R`) forwarding: the SSH server binds the listen socket and
    /// the target is resolved from the agent (the tunnel host).
    Remote(RemoteForwardConfig),
    /// Dynamic (`ssh -D`, SOCKS5) forwarding: the SOCKS proxy listen socket binds
    /// on the agent (loopback by default) and each connection's target is chosen
    /// by the SOCKS client and resolved from the SSH server's network.
    Dynamic(DynamicForwardConfig),
}

/// Params for `tunnel.start`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStartParams {
    /// The desktop's tunnel id, used as the key for later stop/status.
    pub tunnel_id: String,
    /// The SSH connection the agent opens to the "via" server (already resolved
    /// desktop-side, including any inline jump-host chain).
    pub ssh_config: SshSessionConfig,
    /// The forwarding mode and its configuration.
    pub forward: TunnelForwardSpec,
}

/// Result of `tunnel.start`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStartResult {
    /// The `host:port` the listen socket bound on the agent.
    pub bound_address: String,
    /// Who can reach the listen socket (loopback → agent-only).
    pub reachable_from: ReachableFrom,
}

/// Params for `tunnel.stop`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStopParams {
    /// The tunnel id to stop.
    pub tunnel_id: String,
}

/// Result of `tunnel.stop`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStopResult {
    /// Whether a running tunnel with that id was found and stopped.
    pub stopped: bool,
}

/// Params for `tunnel.status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusParams {
    /// The tunnel id to inspect.
    pub tunnel_id: String,
}

/// Result of `tunnel.status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusResult {
    /// Whether the tunnel is currently forwarding on this agent.
    pub running: bool,
    /// Live traffic counters (present only when running).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<TunnelStats>,
    /// The `host:port` the listen socket bound on the agent (present only when
    /// running).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_address: Option<String>,
    /// Who can reach the listen socket (present only when running).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable_from: Option<ReachableFrom>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Locks the `tunnel.start` wire contract against desktop/agent drift
    /// (#2185): the desktop builds this exact JSON — `forward` is the
    /// internally-tagged `TunnelForwardSpec::Local` shape (a `mode` discriminator
    /// plus the flattened local-forward fields). If either side changes the
    /// shape, this parse fails.
    #[test]
    fn tunnel_start_params_parse_the_desktop_wire_shape() {
        let wire = serde_json::json!({
            "tunnelId": "t-1",
            "sshConfig": {
                "host": "bastion.corp",
                "port": 22,
                "username": "dev",
                "authMethod": "password",
                "password": "secret",
                "keyPath": null,
                "shell": null
            },
            "forward": {
                "mode": "local",
                "localHost": "127.0.0.1",
                "localPort": 5432,
                "remoteHost": "db.internal",
                "remotePort": 5432
            }
        });
        let params: TunnelStartParams =
            serde_json::from_value(wire).expect("desktop tunnel.start shape must parse");
        assert_eq!(params.tunnel_id, "t-1");
        assert_eq!(params.ssh_config.host, "bastion.corp");
        let TunnelForwardSpec::Local(forward) = &params.forward else {
            panic!("expected a local forward spec");
        };
        assert_eq!(forward.local_host, "127.0.0.1");
        assert_eq!(forward.local_port, 5432);
        assert_eq!(forward.remote_host, "db.internal");
        assert_eq!(forward.remote_port, 5432);
    }

    /// The desktop routes an agent-hosted `-R` tunnel as `forward.mode ==
    /// "remote"` with the flattened remote-forward fields. Locks that wire shape
    /// against desktop/agent drift (the `-R` twin of the local test above).
    #[test]
    fn tunnel_start_params_parse_the_remote_wire_shape() {
        let wire = serde_json::json!({
            "tunnelId": "t-r",
            "sshConfig": {
                "host": "bastion.corp",
                "port": 22,
                "username": "dev",
                "authMethod": "password",
                "password": "secret",
                "keyPath": null,
                "shell": null
            },
            "forward": {
                "mode": "remote",
                "remoteHost": "0.0.0.0",
                "remotePort": 8080,
                "localHost": "127.0.0.1",
                "localPort": 3000
            }
        });
        let params: TunnelStartParams =
            serde_json::from_value(wire).expect("desktop remote tunnel.start shape must parse");
        assert_eq!(params.tunnel_id, "t-r");
        let TunnelForwardSpec::Remote(forward) = &params.forward else {
            panic!("expected a remote forward spec");
        };
        assert_eq!(forward.remote_host, "0.0.0.0");
        assert_eq!(forward.remote_port, 8080);
        assert_eq!(forward.local_host, "127.0.0.1");
        assert_eq!(forward.local_port, 3000);
    }

    /// The desktop routes an agent-hosted `-D` tunnel as `forward.mode ==
    /// "dynamic"` with the flattened dynamic-forward fields (just the SOCKS
    /// listen bind). Locks that wire shape against desktop/agent drift (the `-D`
    /// twin of the local/remote tests above, #2198).
    #[test]
    fn tunnel_start_params_parse_the_dynamic_wire_shape() {
        let wire = serde_json::json!({
            "tunnelId": "t-d",
            "sshConfig": {
                "host": "bastion.corp",
                "port": 22,
                "username": "dev",
                "authMethod": "password",
                "password": "secret",
                "keyPath": null,
                "shell": null
            },
            "forward": {
                "mode": "dynamic",
                "localHost": "127.0.0.1",
                "localPort": 1080
            }
        });
        let params: TunnelStartParams =
            serde_json::from_value(wire).expect("desktop dynamic tunnel.start shape must parse");
        assert_eq!(params.tunnel_id, "t-d");
        let TunnelForwardSpec::Dynamic(forward) = &params.forward else {
            panic!("expected a dynamic forward spec");
        };
        assert_eq!(forward.local_host, "127.0.0.1");
        assert_eq!(forward.local_port, 1080);
    }

    #[test]
    fn tunnel_start_result_serializes_camel_case() {
        let result = TunnelStartResult {
            bound_address: "127.0.0.1:5432".to_string(),
            reachable_from: ReachableFrom::AgentOnly,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["boundAddress"], "127.0.0.1:5432");
        assert_eq!(value["reachableFrom"], "agentOnly");
    }

    #[test]
    fn update_available_notification_serializes_camel_case() {
        let payload = UpdateAvailableNotification {
            current_version: "0.2.1".to_string(),
            available_version: "0.3.0".to_string(),
            download_url: Some("https://example.test/termihub-agent-linux-x64".to_string()),
            staged: true,
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["currentVersion"], "0.2.1");
        assert_eq!(value["availableVersion"], "0.3.0");
        assert_eq!(
            value["downloadUrl"],
            "https://example.test/termihub-agent-linux-x64"
        );
        assert_eq!(value["staged"], true);
    }

    #[test]
    fn update_available_notification_omits_absent_download_url() {
        let payload = UpdateAvailableNotification {
            current_version: "0.2.1".to_string(),
            available_version: "0.3.0".to_string(),
            download_url: None,
            staged: false,
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert!(value.get("downloadUrl").is_none());
        assert_eq!(value["staged"], false);
    }

    #[test]
    fn agent_update_pending_method_name() {
        assert_eq!(AGENT_UPDATE_PENDING, "agent.update_pending");
    }

    /// The desktop reads these keys; the notification is broadcast verbatim, so
    /// a casing slip here is invisible to the agent and fatal to the toast.
    #[test]
    fn update_pending_notification_serializes_camel_case() {
        let payload = UpdatePendingNotification {
            requested_by_version: "1.4.0".to_string(),
            estimated_restart_secs: 5,
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["requestedByVersion"], "1.4.0");
        assert_eq!(value["estimatedRestartSecs"], 5);
    }

    #[test]
    fn update_pending_notification_round_trips() {
        let payload = UpdatePendingNotification {
            requested_by_version: "1.4.0".to_string(),
            estimated_restart_secs: 5,
        };
        let back: UpdatePendingNotification =
            serde_json::from_value(serde_json::to_value(&payload).unwrap()).unwrap();
        assert_eq!(back, payload);
    }

    #[test]
    fn request_update_params_accept_camel_case() {
        let params: AgentRequestUpdateParams = serde_json::from_value(json!({
            "binaryPath": "/tmp/termihub-agent",
            "version": "0.4.0",
            "ackTimeoutSecs": 3,
        }))
        .unwrap();
        assert_eq!(params.binary_path.as_deref(), Some("/tmp/termihub-agent"));
        assert_eq!(params.version.as_deref(), Some("0.4.0"));
        assert_eq!(params.ack_timeout_secs, Some(3));
    }

    /// Every field is optional: `{}` means "apply what you already staged, with
    /// the default window" — the self-update path.
    #[test]
    fn request_update_params_are_all_optional() {
        let params: AgentRequestUpdateParams = serde_json::from_value(json!({})).unwrap();
        assert!(params.binary_path.is_none());
        assert!(params.version.is_none());
        assert!(params.ack_timeout_secs.is_none());
    }

    #[test]
    fn request_update_result_serializes_camel_case() {
        let result = AgentRequestUpdateResult {
            applied: true,
            active_sessions: 0,
            notified_clients: 2,
            all_acked: false,
            remaining_clients: vec!["b".to_string()],
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["applied"], true);
        assert_eq!(value["activeSessions"], 0);
        assert_eq!(value["notifiedClients"], 2);
        assert_eq!(value["allAcked"], false);
        assert_eq!(value["remainingClients"], json!(["b"]));
    }

    /// The happy path stays quiet: no `remainingClients` key rather than an
    /// empty array the desktop would have to special-case.
    #[test]
    fn request_update_result_omits_empty_remaining_clients() {
        let result = AgentRequestUpdateResult {
            applied: true,
            active_sessions: 0,
            notified_clients: 1,
            all_acked: true,
            remaining_clients: Vec::new(),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert!(value.get("remainingClients").is_none());
    }

    #[test]
    fn agent_update_available_method_name() {
        assert_eq!(AGENT_UPDATE_AVAILABLE, "agent.update_available");
    }

    #[test]
    fn initialize_params_serde() {
        let json = json!({
            "protocolVersion": "0.1.0",
            "client": "termihub-desktop",
            "clientVersion": "0.1.0"
        });
        let params: InitializeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.protocol_version, "0.1.0");
        assert_eq!(params.client, "termihub-desktop");
        assert!(params.external_connection_files.is_empty());
    }

    #[test]
    fn initialize_params_with_external_files() {
        let json = json!({
            "protocolVersion": "0.2.0",
            "client": "termihub-desktop",
            "clientVersion": "1.0.0",
            "externalConnectionFiles": [
                "/home/pi/team-connections.json",
                "/opt/shared-connections.json"
            ]
        });
        let params: InitializeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.external_connection_files.len(), 2);
        assert_eq!(
            params.external_connection_files[0],
            "/home/pi/team-connections.json"
        );
        assert_eq!(
            params.external_connection_files[1],
            "/opt/shared-connections.json"
        );
    }

    #[test]
    fn initialize_result_serializes() {
        use termihub_core::connection::schema::SettingsSchema;
        use termihub_core::connection::Capabilities as CoreCapabilities;

        let result = InitializeResult {
            protocol_version: "0.2.0".to_string(),
            agent_version: "0.1.0".to_string(),
            client_id: "client-1".to_string(),
            capabilities: Capabilities {
                connection_types: vec![ConnectionTypeInfo {
                    type_id: "local".to_string(),
                    display_name: "Local Shell".to_string(),
                    icon: "terminal".to_string(),
                    schema: SettingsSchema { groups: vec![] },
                    capabilities: CoreCapabilities {
                        monitoring: false,
                        file_browser: false,
                        graphical: false,
                        resize: true,
                        persistent: false,
                        terminal: true,
                    },
                }],
                max_sessions: 20,
                monitoring_supported: false,
                available_shells: vec!["/bin/bash".to_string(), "/bin/zsh".to_string()],
                available_serial_ports: vec!["/dev/ttyUSB0".to_string()],
                docker_available: false,
                available_docker_images: vec![],
            },
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["protocol_version"], "0.2.0");
        assert_eq!(v["capabilities"]["maxSessions"], 20);
        assert_eq!(v["capabilities"]["connectionTypes"][0]["typeId"], "local");
        assert_eq!(v["capabilities"]["availableShells"][0], "/bin/bash");
        assert_eq!(v["capabilities"]["availableSerialPorts"][0], "/dev/ttyUSB0");
        assert_eq!(v["capabilities"]["dockerAvailable"], false);
        assert!(v["capabilities"]["availableDockerImages"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_create_params_shell() {
        let json = json!({
            "type": "shell",
            "config": {
                "shell": "/bin/bash",
                "cols": 120,
                "rows": 40,
                "env": {"TERM": "xterm-256color"}
            },
            "title": "Build session"
        });
        let params: SessionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_type, "shell");
        assert_eq!(params.title, Some("Build session".to_string()));

        // Verify the config can be further parsed as ShellConfig
        let shell_cfg: ShellConfig = serde_json::from_value(params.config).unwrap();
        assert_eq!(shell_cfg.shell, Some("/bin/bash".to_string()));
        assert_eq!(shell_cfg.cols, 120);
        assert_eq!(shell_cfg.rows, 40);
    }

    #[test]
    fn session_create_params_serial() {
        let json = json!({
            "type": "serial",
            "config": {
                "port": "/dev/ttyUSB0",
                "baudRate": 9600
            },
            "title": "Serial monitor"
        });
        let params: SessionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_type, "serial");

        let serial_cfg: SerialSessionConfig = serde_json::from_value(params.config).unwrap();
        assert_eq!(serial_cfg.port, "/dev/ttyUSB0");
        assert_eq!(serial_cfg.baud_rate, 9600);
        // Defaults
        assert_eq!(serial_cfg.data_bits, 8);
        assert_eq!(serial_cfg.stop_bits, 1);
        assert_eq!(serial_cfg.parity, "none");
    }

    #[test]
    fn session_create_result_serializes() {
        let result = SessionCreateResult {
            session_id: "abc-123".to_string(),
            title: "Build session".to_string(),
            session_type: "shell".to_string(),
            status: "running".to_string(),
            created_at: "2026-02-14T10:30:00Z".to_string(),
            definition_id: None,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["session_id"], "abc-123");
        assert_eq!(v["type"], "shell");
        assert_eq!(v["status"], "running");
        assert!(v.get("definition_id").is_none());
    }

    #[test]
    fn session_create_params_with_definition_id() {
        let json = json!({
            "type": "shell",
            "config": {"shell": "/bin/bash"},
            "title": "Build",
            "definition_id": "def-42"
        });
        let params: SessionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.definition_id.as_deref(), Some("def-42"));
    }

    #[test]
    fn session_create_params_definition_id_absent() {
        let json = json!({"type": "shell"});
        let params: SessionCreateParams = serde_json::from_value(json).unwrap();
        assert!(params.definition_id.is_none());
    }

    #[test]
    fn session_create_result_with_definition_id_serializes() {
        let result = SessionCreateResult {
            session_id: "abc-123".to_string(),
            title: "Build session".to_string(),
            session_type: "shell".to_string(),
            status: "running".to_string(),
            created_at: "2026-02-14T10:30:00Z".to_string(),
            definition_id: Some("def-42".to_string()),
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["definition_id"], "def-42");
    }

    #[test]
    fn session_list_entry_with_definition_id_serializes() {
        let entry = SessionListEntry {
            session_id: "s1".to_string(),
            title: "T".to_string(),
            session_type: "shell".to_string(),
            status: "running".to_string(),
            created_at: "2026-02-14T10:30:00Z".to_string(),
            last_activity: "2026-02-14T10:30:00Z".to_string(),
            attached: false,
            definition_id: Some("def-7".to_string()),
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["definition_id"], "def-7");
    }

    #[test]
    fn session_list_result_serializes() {
        let result = SessionListResult {
            sessions: vec![SessionListEntry {
                session_id: "abc-123".to_string(),
                title: "Test".to_string(),
                session_type: "shell".to_string(),
                status: "running".to_string(),
                created_at: "2026-02-14T10:30:00Z".to_string(),
                last_activity: "2026-02-14T12:00:00Z".to_string(),
                attached: false,
                definition_id: None,
            }],
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(v["sessions"][0]["attached"], false);
    }

    #[test]
    fn session_close_params_serde() {
        let json = json!({"session_id": "abc-123"});
        let params: SessionCloseParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
    }

    #[test]
    fn health_check_result_serializes() {
        let result = HealthCheckResult {
            status: "ok".to_string(),
            uptime_secs: 86400,
            active_sessions: 3,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["uptime_secs"], 86400);
        assert_eq!(v["active_sessions"], 3);
    }

    #[test]
    fn shell_config_defaults() {
        let json = json!({});
        let cfg: ShellConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.shell.is_none());
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn serial_config_defaults() {
        let json = json!({"port": "/dev/ttyUSB0"});
        let cfg: SerialSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.baud_rate, 115200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, "none");
        assert_eq!(cfg.flow_control, "none");
    }

    #[test]
    fn session_attach_params_serde() {
        let json = json!({"session_id": "abc-123"});
        let params: SessionAttachParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
    }

    #[test]
    fn session_detach_params_serde() {
        let json = json!({"session_id": "abc-123"});
        let params: SessionDetachParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
    }

    #[test]
    fn session_input_params_serde() {
        let json = json!({"session_id": "abc-123", "data": "aGVsbG8="});
        let params: SessionInputParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
        assert_eq!(params.data, "aGVsbG8=");
    }

    #[test]
    fn session_resize_params_serde() {
        let json = json!({"session_id": "abc-123", "cols": 120, "rows": 40});
        let params: SessionResizeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.session_id, "abc-123");
        assert_eq!(params.cols, 120);
        assert_eq!(params.rows, 40);
    }

    #[test]
    fn connection_create_params_serde() {
        let json = json!({
            "name": "Build Shell",
            "type": "shell",
            "config": {"shell": "/bin/bash"},
            "persistent": true,
            "folder_id": "folder-1"
        });
        let params: ConnectionCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Build Shell");
        assert_eq!(params.session_type, "shell");
        assert!(params.persistent);
        assert_eq!(params.folder_id, Some("folder-1".to_string()));
    }

    #[test]
    fn connection_create_params_defaults() {
        let json = json!({"name": "Temp", "type": "shell"});
        let params: ConnectionCreateParams = serde_json::from_value(json).unwrap();
        assert!(!params.persistent);
        assert_eq!(params.folder_id, None);
    }

    #[test]
    fn connection_update_params_serde() {
        let json = json!({
            "id": "conn-1",
            "name": "New Name",
            "persistent": true,
            "folder_id": null
        });
        let params: ConnectionUpdateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "conn-1");
        assert_eq!(params.name, Some("New Name".to_string()));
        assert_eq!(params.persistent, Some(true));
        assert!(params.folder_id.is_some()); // present but null
        assert!(params.folder_id.unwrap().is_null());
    }

    #[test]
    fn connection_update_params_minimal() {
        let json = json!({"id": "conn-1"});
        let params: ConnectionUpdateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "conn-1");
        assert!(params.name.is_none());
        assert!(params.session_type.is_none());
        assert!(params.config.is_none());
        assert!(params.persistent.is_none());
        assert!(params.folder_id.is_none());
    }

    #[test]
    fn connection_delete_params_serde() {
        let json = json!({"id": "conn-123"});
        let params: ConnectionDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "conn-123");
    }

    #[test]
    fn folder_create_params_serde() {
        let json = json!({"name": "Project A", "parent_id": "folder-0"});
        let params: FolderCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Project A");
        assert_eq!(params.parent_id, Some("folder-0".to_string()));
    }

    #[test]
    fn folder_create_params_root() {
        let json = json!({"name": "Root Folder"});
        let params: FolderCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.name, "Root Folder");
        assert_eq!(params.parent_id, None);
    }

    #[test]
    fn folder_update_params_serde() {
        let json = json!({
            "id": "folder-1",
            "name": "Renamed",
            "parent_id": null,
            "is_expanded": true
        });
        let params: FolderUpdateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "folder-1");
        assert_eq!(params.name, Some("Renamed".to_string()));
        assert!(params.parent_id.is_some());
        assert!(params.parent_id.unwrap().is_null());
        assert_eq!(params.is_expanded, Some(true));
    }

    #[test]
    fn folder_delete_params_serde() {
        let json = json!({"id": "folder-123"});
        let params: FolderDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.id, "folder-123");
    }

    #[test]
    fn docker_session_config_defaults() {
        let json = json!({"image": "ubuntu:22.04"});
        let cfg: DockerSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.image, "ubuntu:22.04");
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.shell.is_none());
        assert!(cfg.env_vars.is_empty());
        assert!(cfg.volumes.is_empty());
        assert!(cfg.working_directory.is_none());
        assert!(cfg.remove_on_exit);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn docker_session_config_full() {
        let json = json!({
            "image": "ubuntu:22.04",
            "shell": "/bin/bash",
            "cols": 120,
            "rows": 40,
            "envVars": [{"key": "FOO", "value": "bar"}],
            "volumes": [{"hostPath": "/host", "containerPath": "/mnt", "readOnly": true}],
            "workingDirectory": "/app",
            "removeOnExit": false,
            "env": {"TERM": "xterm-256color"}
        });
        let cfg: DockerSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.shell, Some("/bin/bash".to_string()));
        assert_eq!(cfg.cols, 120);
        assert_eq!(cfg.rows, 40);
        assert_eq!(cfg.env_vars.len(), 1);
        assert_eq!(cfg.env_vars[0].key, "FOO");
        assert_eq!(cfg.env_vars[0].value, "bar");
        assert_eq!(cfg.volumes.len(), 1);
        assert!(cfg.volumes[0].read_only);
        assert_eq!(cfg.volumes[0].host_path, "/host");
        assert_eq!(cfg.volumes[0].container_path, "/mnt");
        assert_eq!(cfg.working_directory, Some("/app".to_string()));
        assert!(!cfg.remove_on_exit);
    }

    #[test]
    fn docker_env_var_serde() {
        let env = DockerEnvVar {
            key: "K".to_string(),
            value: "V".to_string(),
        };
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["key"], "K");
        assert_eq!(v["value"], "V");
    }

    #[test]
    fn docker_volume_mount_serde() {
        let vol = DockerVolumeMount {
            host_path: "/host".to_string(),
            container_path: "/container".to_string(),
            read_only: false,
        };
        let v = serde_json::to_value(&vol).unwrap();
        assert_eq!(v["hostPath"], "/host");
        assert_eq!(v["containerPath"], "/container");
        assert!(!v["readOnly"].as_bool().unwrap());
    }

    #[test]
    fn ssh_session_config_defaults() {
        let json = json!({"host": "build.internal", "username": "dev", "authMethod": "agent"});
        let cfg: SshSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.host, "build.internal");
        assert_eq!(cfg.username, "dev");
        assert_eq!(cfg.auth_method, "agent");
        assert_eq!(cfg.port, 22);
        assert!(cfg.password.is_none());
        assert!(cfg.key_path.is_none());
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn ssh_session_config_full() {
        let json = json!({
            "host": "build.internal",
            "username": "deploy",
            "authMethod": "key",
            "port": 2222,
            "password": "secret",
            "keyPath": "/home/user/.ssh/id_ed25519",
            "shell": "/bin/bash",
            "cols": 120,
            "rows": 40,
            "env": {"TERM": "xterm-256color"}
        });
        let cfg: SshSessionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.host, "build.internal");
        assert_eq!(cfg.username, "deploy");
        assert_eq!(cfg.auth_method, "key");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.password.as_deref(), Some("secret"));
        assert_eq!(cfg.key_path.as_deref(), Some("/home/user/.ssh/id_ed25519"));
        assert_eq!(cfg.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(cfg.cols, 120);
        assert_eq!(cfg.rows, 40);
        assert_eq!(cfg.env.get("TERM").unwrap(), "xterm-256color");
    }

    // ── File browsing types ────────────────────────────────────────

    #[test]
    fn file_entry_serializes_camel_case() {
        let entry = FileEntry {
            name: "readme.md".to_string(),
            path: "/home/user/readme.md".to_string(),
            is_directory: false,
            size: 1024,
            modified: "2026-02-20T10:00:00Z".to_string(),
            permissions: Some("rw-r--r--".to_string()),
            writable: None,
            is_symlink: true,
            symlink_target: Some("/home/user/target.md".to_string()),
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["name"], "readme.md");
        assert_eq!(v["isDirectory"], false);
        assert!(v.get("is_directory").is_none());
        assert_eq!(v["size"], 1024);
        assert_eq!(v["modified"], "2026-02-20T10:00:00Z");
        assert_eq!(v["permissions"], "rw-r--r--");
        assert_eq!(v["isSymlink"], true);
        assert_eq!(v["symlinkTarget"], "/home/user/target.md");
        assert!(v.get("is_symlink").is_none());
        assert!(v.get("symlink_target").is_none());
    }

    #[test]
    fn file_entry_null_permissions() {
        let entry = FileEntry {
            name: "file.txt".to_string(),
            path: "/file.txt".to_string(),
            is_directory: false,
            size: 0,
            modified: String::new(),
            permissions: None,
            writable: None,
            is_symlink: false,
            symlink_target: None,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v["permissions"].is_null());
    }

    #[test]
    fn files_list_params_serde() {
        let json = json!({"path": "/home"});
        let params: FilesListParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/home");
        assert!(params.connection_id.is_none());

        let json = json!({"connection_id": "conn-1", "path": "/tmp"});
        let params: FilesListParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-1".to_string()));
        assert_eq!(params.path, "/tmp");
    }

    #[test]
    fn files_list_result_serializes() {
        let result = FilesListResult {
            entries: vec![FileEntry {
                name: "dir".to_string(),
                path: "/dir".to_string(),
                is_directory: true,
                size: 4096,
                modified: "2026-01-01T00:00:00Z".to_string(),
                permissions: Some("rwxr-xr-x".to_string()),
                writable: None,
                is_symlink: false,
                symlink_target: None,
            }],
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 1);
        assert_eq!(v["entries"][0]["isDirectory"], true);
    }

    #[test]
    fn files_read_params_serde() {
        let json = json!({"path": "/etc/hosts"});
        let params: FilesReadParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/etc/hosts");
        assert!(params.connection_id.is_none());
    }

    #[test]
    fn files_read_result_serializes() {
        let result = FilesReadResult {
            data: "aGVsbG8=".to_string(),
            size: 5,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["data"], "aGVsbG8=");
        assert_eq!(v["size"], 5);
    }

    #[test]
    fn files_write_params_serde() {
        let json = json!({"path": "/tmp/out.txt", "data": "aGVsbG8="});
        let params: FilesWriteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/tmp/out.txt");
        assert_eq!(params.data, "aGVsbG8=");
        assert!(params.connection_id.is_none());
    }

    #[test]
    fn files_delete_params_serde() {
        let json = json!({"path": "/tmp/old", "isDirectory": true});
        let params: FilesDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.path, "/tmp/old");
        assert!(params.is_directory);
        assert!(params.connection_id.is_none());
    }

    #[test]
    fn files_rename_params_serde() {
        let json = json!({"old_path": "/a.txt", "new_path": "/b.txt"});
        let params: FilesRenameParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.old_path, "/a.txt");
        assert_eq!(params.new_path, "/b.txt");
    }

    #[test]
    fn files_stat_params_serde() {
        let json = json!({"connection_id": "conn-42", "path": "/var/log"});
        let params: FilesStatParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-42".to_string()));
        assert_eq!(params.path, "/var/log");
    }

    #[test]
    fn files_stat_result_serializes_camel_case() {
        let result = FilesStatResult {
            name: "log".to_string(),
            path: "/var/log".to_string(),
            is_directory: true,
            size: 4096,
            modified: "2026-02-20T10:00:00Z".to_string(),
            permissions: Some("rwxr-xr-x".to_string()),
            writable: None,
            is_symlink: false,
            symlink_target: None,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["isDirectory"], true);
        assert!(v.get("is_directory").is_none());
        assert_eq!(v["name"], "log");
    }

    // ── Monitoring types ─────────────────────────────────────────

    #[test]
    fn monitoring_subscribe_params_serde() {
        let json = json!({"host": "self", "interval_ms": 5000});
        let params: MonitoringSubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.host, "self");
        assert_eq!(params.interval_ms, Some(5000));
    }

    #[test]
    fn monitoring_subscribe_params_defaults() {
        let json = json!({"host": "conn-123"});
        let params: MonitoringSubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.host, "conn-123");
        assert_eq!(params.interval_ms, None);
    }

    #[test]
    fn monitoring_unsubscribe_params_serde() {
        let json = json!({"host": "self"});
        let params: MonitoringUnsubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.host, "self");
    }

    #[test]
    fn monitoring_data_serializes_camel_case() {
        let data = MonitoringData {
            host: "self".to_string(),
            hostname: "raspberrypi".to_string(),
            uptime_seconds: 12345.67,
            load_average: [0.15, 0.10, 0.05],
            cpu_usage_percent: 78.5,
            memory_total_kb: 16384000,
            memory_available_kb: 12000000,
            memory_used_percent: 25.0,
            disk_total_kb: 50000000,
            disk_used_kb: 20000000,
            disk_used_percent: 42.0,
            os_info: "Linux 5.15.0".to_string(),
        };
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(v["host"], "self");
        assert_eq!(v["hostname"], "raspberrypi");
        assert_eq!(v["uptimeSeconds"], 12345.67);
        assert_eq!(v["cpuUsagePercent"], 78.5);
        assert_eq!(v["memoryTotalKb"], 16384000);
        assert_eq!(v["memoryAvailableKb"], 12000000);
        assert_eq!(v["memoryUsedPercent"], 25.0);
        assert_eq!(v["diskTotalKb"], 50000000);
        assert_eq!(v["diskUsedKb"], 20000000);
        assert_eq!(v["diskUsedPercent"], 42.0);
        assert_eq!(v["osInfo"], "Linux 5.15.0");
        // Verify camelCase (no snake_case keys)
        assert!(v.get("uptime_seconds").is_none());
        assert!(v.get("cpu_usage_percent").is_none());
        assert!(v.get("memory_total_kb").is_none());
    }

    // ── agent.shutdown types ─────────────────────────────────────────

    #[test]
    fn agent_shutdown_params_with_reason() {
        let json = json!({"reason": "update"});
        let params: AgentShutdownParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.reason, Some("update".to_string()));
    }

    #[test]
    fn agent_shutdown_params_empty() {
        let json = json!({});
        let params: AgentShutdownParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.reason, None);
    }

    #[test]
    fn agent_shutdown_result_serializes() {
        let result = AgentShutdownResult {
            detached_sessions: 3,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["detached_sessions"], 3);
    }
}
