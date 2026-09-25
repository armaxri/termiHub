//! JSON-RPC request/response DTOs and method-name constants for the termiHub
//! desktop↔agent protocol.
//!
//! This is the single shared home for the wire types (DUP-001) and the method
//! names (DUP-002): both the agent (dispatch side) and the desktop (`src-tauri`,
//! call side) depend on `termihub-core`, so the structs and the `&str` method
//! constants are defined once here and referenced from both. The agent crate
//! re-exports this module (`termihub_agent::protocol::methods`) for backwards
//! compatibility with existing `crate::protocol::methods::*` paths.
//!
//! The serialized wire shape is authoritative — the serde attributes here are
//! the contract. See `docs/remote-protocol.md`.

use crate::config::{DockerConfig, EnvVar, SerialConfig, SshConfig, VolumeMount};
pub use crate::connection::ConnectionTypeInfo;
use crate::monitoring::{KillSignal, ProcessInfo, SystemStats};
use crate::service::ServiceStatus;
#[cfg(feature = "ssh")]
use crate::tunnel::config::{
    DynamicForwardConfig, LocalForwardConfig, RemoteForwardConfig, TunnelStats,
};
#[cfg(feature = "ssh")]
use crate::tunnel::ReachableFrom;
use serde::{Deserialize, Serialize};
use serde_json::Value;
// Re-exported for shell/session modules and test access on all platforms.
pub use crate::config::ShellConfig;
pub use crate::files::FileEntry;

// Type aliases for renamed types — minimises churn in consumer files.
pub type SerialSessionConfig = SerialConfig;
pub type DockerSessionConfig = DockerConfig;
pub type SshSessionConfig = SshConfig;
pub type DockerEnvVar = EnvVar;
pub type DockerVolumeMount = VolumeMount;

// ── Method-name constants (DUP-002) ──────────────────────────────────
//
// Single source of truth for the JSON-RPC method strings, referenced by the
// agent dispatch (registration) and the desktop call sites so the two cannot
// drift. The values are the exact wire strings; `method_name_values_are_stable`
// locks each one. Notification method names (agent → desktop) live here too, so
// emitters and listeners share one spelling.
//
// `AGENT_UPDATE_PENDING` and `AGENT_UPDATE_AVAILABLE` are defined further down
// alongside their notification payloads.

/// Handshake method establishing protocol version and capabilities.
pub const INITIALIZE: &str = "initialize";

// Live session lifecycle (transient sessions on the agent).
pub const CONNECTION_CREATE: &str = "connection.create";
pub const CONNECTION_LIST: &str = "connection.list";
pub const CONNECTION_ATTACH: &str = "connection.attach";
pub const CONNECTION_DETACH: &str = "connection.detach";
pub const CONNECTION_WRITE: &str = "connection.write";
pub const CONNECTION_RESIZE: &str = "connection.resize";
pub const CONNECTION_CLOSE: &str = "connection.close";
pub const CONNECTION_TYPES: &str = "connection.types";
pub const SESSION_GET_BUFFER: &str = "session.getBuffer";

// Connection-scoped file browsing.
pub const CONNECTION_FILES_LIST: &str = "connection.files.list";
pub const CONNECTION_FILES_READ: &str = "connection.files.read";
pub const CONNECTION_FILES_WRITE: &str = "connection.files.write";
pub const CONNECTION_FILES_DELETE: &str = "connection.files.delete";
pub const CONNECTION_FILES_RENAME: &str = "connection.files.rename";
pub const CONNECTION_FILES_STAT: &str = "connection.files.stat";
pub const CONNECTION_FILES_MKDIR: &str = "connection.files.mkdir";
pub const CONNECTION_FILES_SET_PERMISSIONS: &str = "connection.files.set_permissions";
pub const CONNECTION_FILES_SET_OWNER: &str = "connection.files.set_owner";
pub const CONNECTION_FILES_CREATE_SYMLINK: &str = "connection.files.create_symlink";
pub const CONNECTION_FILES_COPY: &str = "connection.files.copy";

// Connection-scoped system monitoring.
pub const CONNECTION_MONITORING_SUBSCRIBE: &str = "connection.monitoring.subscribe";
pub const CONNECTION_MONITORING_UNSUBSCRIBE: &str = "connection.monitoring.unsubscribe";

// Connection-scoped process listing + termination (PROD-0028).
pub const CONNECTION_PROCESSES_LIST: &str = "connection.processes.list";
pub const CONNECTION_PROCESSES_KILL: &str = "connection.processes.kill";

// Saved connection & folder CRUD (agent-hosted connection store).
pub const CONNECTIONS_LIST: &str = "connections.list";
pub const CONNECTIONS_CREATE: &str = "connections.create";
pub const CONNECTIONS_UPDATE: &str = "connections.update";
pub const CONNECTIONS_DELETE: &str = "connections.delete";
pub const CONNECTIONS_FOLDERS_CREATE: &str = "connections.folders.create";
pub const CONNECTIONS_FOLDERS_UPDATE: &str = "connections.folders.update";
pub const CONNECTIONS_FOLDERS_DELETE: &str = "connections.folders.delete";

// Agent lifecycle / coordination.
pub const HEALTH_CHECK: &str = "health.check";
pub const AGENT_LIST_CONNECTIONS: &str = "agent.list_connections";
pub const AGENT_SHUTDOWN: &str = "agent.shutdown";
pub const AGENT_SETTINGS_UPDATE: &str = "agent.settingsUpdate";
pub const AGENT_REQUEST_UPDATE: &str = "agent.request_update";
pub const AGENT_REQUEST_DEFERRED_UPDATE: &str = "agent.request_deferred_update";

// ssh-agent relay (#1727). `data`/`close` are used both as desktop→agent
// requests and as agent→desktop notifications; `open` is notification-only.
pub const AGENT_FORWARD_OPEN: &str = "agent.forward.open";
pub const AGENT_FORWARD_DATA: &str = "agent.forward.data";
pub const AGENT_FORWARD_CLOSE: &str = "agent.forward.close";

// Network diagnostics.
pub const NETWORK_PORT_SCAN: &str = "network.port_scan";
pub const NETWORK_PING: &str = "network.ping";
pub const NETWORK_DNS_LOOKUP: &str = "network.dns_lookup";
pub const NETWORK_OPEN_PORTS: &str = "network.open_ports";
pub const NETWORK_TRACEROUTE: &str = "network.traceroute";
pub const NETWORK_WOL: &str = "network.wol";

// Agent-hosted tunnel forwarding (#2185).
pub const TUNNEL_START: &str = "tunnel.start";
pub const TUNNEL_STOP: &str = "tunnel.stop";
pub const TUNNEL_STATUS: &str = "tunnel.status";

// Agent-hosted embedded servers / tool substrate (#2192, #2148).
pub const SERVICE_LIST: &str = "service.list";
pub const SERVICE_START: &str = "service.start";
pub const SERVICE_STOP: &str = "service.stop";
pub const SERVICE_PAUSE: &str = "service.pause";
pub const SERVICE_RESUME: &str = "service.resume";
pub const SERVICE_STATUS: &str = "service.status";
pub const TOOL_LIST: &str = "tool.list";
pub const TOOL_RUN: &str = "tool.run";

// Notification methods (agent → desktop; no id, no response).
pub const CONNECTION_OUTPUT: &str = "connection.output";
pub const CONNECTION_EXIT: &str = "connection.exit";
pub const CONNECTION_MONITORING_DATA: &str = "connection.monitoring.data";

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionListResult {
    pub connections: Vec<ConnectionInfo>,
}

/// A single client connected to this agent process, as reported by
/// `agent.list_connections`. Mirrors the agent's internal `ConnectedClient`,
/// with the timestamp rendered as an ISO 8601 (RFC 3339) string for the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTypesResult {
    pub types: Vec<ConnectionTypeInfo>,
}

// ── session.create ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreateParams {
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// ID of the saved connection definition this session was created from, if any.
    /// Lets clients re-link an active session to its source definition after
    /// tab close, agent restart, or desktop restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListResult {
    pub sessions: Vec<SessionListEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCloseParams {
    pub session_id: String,
}

// ── session.attach ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionAttachParams {
    pub session_id: String,
}

// ── session.detach ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDetachParams {
    pub session_id: String,
}

// ── session.input ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInputParams {
    pub session_id: String,
    /// Base64-encoded data.
    pub data: String,
}

// ── agent.forward.* (ssh-agent relay, #1727) ───────────────────────

/// Desktop → agent: reply bytes from the operator's local ssh-agent, tagged
/// with the forwarded stream they belong to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentForwardDataParams {
    pub stream_id: String,
    /// Base64-encoded ssh-agent-protocol bytes.
    pub data: String,
}

/// Desktop → agent: a forwarded ssh-agent stream the desktop closed (its local
/// agent went away, or the conversation finished).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentForwardCloseParams {
    pub stream_id: String,
}

// ── session.resize ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionDeleteParams {
    pub id: String,
}

// ── connections.folders.create ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDeleteParams {
    pub id: String,
}

// ── connections.* result definitions (agent → desktop wire) ──────────
//
// The agent returns these from `connections.list` / `connections.create` /
// `connections.update` (and `connections.folders.*`). They ARE the wire shape:
// the agent serializes them directly (re-exported as `ConnectionSnapshot` /
// `FolderSnapshot`) and the desktop deserializes them, so both sides share one
// definition (DUP-001). The field names are snake_case ON PURPOSE — that is the
// wire — so do NOT add `#[serde(rename_all = "camelCase")]`: it would change the
// bytes the agent emits and the desktop parses. The desktop re-serializes these
// to its camelCase Tauri→frontend DTOs (`AgentDefinitionInfo` / `AgentFolderInfo`)
// via `From`. Wire bytes are pinned by tests on both sides.

/// A saved connection definition as reported by the agent over the wire.
///
/// `#[serde(default)]` on the optional fields lets the desktop parse a minimal
/// entry (missing `config`/`persistent`/`folder_id`) exactly as the old
/// hand-parser did; `skip_serializing_if` keeps `terminal_options`/`icon`/
/// `source_file` off the wire when absent (byte-identical to the pre-DUP-001
/// `ConnectionSnapshot`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionDefinition {
    pub id: String,
    pub name: String,
    /// Session type: "shell", "serial", "docker", "ssh", "local", etc.
    pub session_type: String,
    /// Session-specific configuration (shell path, serial params, etc.).
    #[serde(default)]
    pub config: Value,
    /// Whether sessions created from this definition are persistent.
    #[serde(default)]
    pub persistent: bool,
    /// Parent folder id, or `None` for a root-level definition.
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Terminal appearance/behaviour overrides (font, color, cursor, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_options: Option<Value>,
    /// Custom icon name (lucide-react PascalCase or "lab:camelCase").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Source file path on the remote host, or `None` for the primary store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
}

/// A folder as reported by the agent over the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDefinition {
    pub id: String,
    pub name: String,
    /// Parent folder id, or `None` for a root-level folder.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Whether this folder is expanded in the UI.
    #[serde(default)]
    pub is_expanded: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesListParams {
    /// Connection to scope the operation to. If absent, use local filesystem.
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesListResult {
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesReadParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesReadResult {
    /// Base64-encoded file content.
    pub data: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesWriteParams {
    pub connection_id: Option<String>,
    pub path: String,
    /// Base64-encoded content to write.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesDeleteParams {
    pub connection_id: Option<String>,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesRenameParams {
    pub connection_id: Option<String>,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesStatParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesMkdirParams {
    pub connection_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesSetPermissionsParams {
    pub connection_id: Option<String>,
    pub path: String,
    /// The low 12 bits of a Unix mode (e.g. `0o755`).
    pub mode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesSetOwnerParams {
    pub connection_id: Option<String>,
    pub path: String,
    /// New owner user id, or `None`/absent to leave it unchanged.
    #[serde(default)]
    pub uid: Option<u32>,
    /// New owner group id, or `None`/absent to leave it unchanged.
    #[serde(default)]
    pub gid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesCreateSymlinkParams {
    pub connection_id: Option<String>,
    /// The path the link points at (stored verbatim; may be relative/dangling).
    pub target: String,
    /// The path of the new link to create.
    pub link_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesCopyParams {
    pub connection_id: Option<String>,
    /// Source path (same backend as `dest`).
    pub src: String,
    /// Destination path (same backend as `src`).
    pub dest: String,
}

/// Type alias for backward compatibility — stat results use the same shape
/// as [`FileEntry`] from the core crate.
pub type FilesStatResult = FileEntry;

// ── connection.processes.* (PROD-0028) ──────────────────────────────

/// Params for `connection.processes.list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessesListParams {
    /// Connection/session to scope the operation to. `None` = the agent's own
    /// host (local sessions).
    pub connection_id: Option<String>,
}

/// Result of `connection.processes.list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessesListResult {
    pub processes: Vec<ProcessInfo>,
}

/// Params for `connection.processes.kill`.
///
/// Targets the exact numeric `pid` — never a name match — with one of the two
/// supported signals ([`KillSignal`], serialized `"term"` / `"kill"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessKillParams {
    /// Connection/session to scope the operation to. `None` = the agent's own
    /// host (local sessions).
    pub connection_id: Option<String>,
    /// Exact process id to terminate.
    pub pid: u32,
    /// Signal to deliver (SIGTERM or SIGKILL).
    pub signal: KillSignal,
}

// ── agent.shutdown ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentShutdownParams {
    /// Optional reason: "update", "user", etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentShutdownResult {
    /// Number of sessions that were detached (left running in daemons).
    pub detached_sessions: u32,
}

// ── agent.request_deferred_update ───────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestDeferredUpdateParams {
    /// Absolute path (on the agent host) to the new agent binary to stage.
    /// Omit to apply an update the agent already staged itself (self-update).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    /// Optional target version label (bookkeeping only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Expected lowercase-hex SHA-256 digest of the binary at `binary_path`,
    /// computed by the initiator (the desktop hashes the bytes it uploads). The
    /// agent re-verifies the staged bytes against this immediately before the
    /// swap (AGT-004). Sent whenever `binary_path` is; omitted for a self-staged
    /// "Apply Now", where the agent uses the digest it recorded at download.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestUpdateParams {
    /// Absolute path (on the agent host) to the new agent binary to stage.
    /// Omit to apply an update the agent already staged itself (self-update).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    /// Optional target version label (bookkeeping only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Expected lowercase-hex SHA-256 digest of the binary at `binary_path`,
    /// computed by the initiator (the desktop hashes the bytes it uploads). The
    /// agent re-verifies the staged bytes against this immediately before the
    /// swap (AGT-004). Sent whenever `binary_path` is; omitted for a self-staged
    /// "Apply Now", where the agent uses the digest it recorded at download.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
    /// How long other hosts get to disconnect before the update proceeds
    /// anyway. Omit for the default 10 s
    /// (`ACK_TIMEOUT` in the agent's `update` module); tests use a short window
    /// so they need not sit through it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ack_timeout_secs: Option<u64>,
}

/// Result of `agent.request_update`.
///
/// Reports the coordination outcome as well as the apply outcome, so the
/// initiating desktop can say *"3 hosts were notified, 1 was still connected"*
/// rather than only "done". `allAcked: false` is not an error — the update
/// proceeded — it means someone got the hard cut.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPortScanParams {
    pub host: String,
    /// Port specification: "22", "80,443", "1-1024"
    pub ports: String,
    pub timeout_ms: Option<u64>,
    pub concurrency: Option<usize>,
}

pub use crate::network::types::{
    OpenPort, PingResult, PingStats, PortScanResult, PortScanSummary, TracerouteHop,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPortScanResponse {
    pub results: Vec<PortScanResult>,
    pub summary: PortScanSummary,
}

// ── network.ping ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPingParams {
    pub host: String,
    pub count: Option<u32>,
    pub interval_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPingResponse {
    pub results: Vec<PingResult>,
    pub stats: PingStats,
}

// ── network.dns_lookup ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkTracerouteParams {
    pub host: String,
    pub max_hops: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkTracerouteResponse {
    pub hops: Vec<TracerouteHop>,
}

// ── network.wol ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkWolParams {
    pub mac: String,
    #[serde(default = "default_broadcast")]
    pub broadcast: String,
    #[serde(default = "default_wol_port")]
    pub port: u16,
}

fn default_broadcast() -> String {
    crate::network::defaults::WOL_BROADCAST.to_string()
}

fn default_wol_port() -> u16 {
    crate::network::defaults::WOL_PORT
}

// ── monitoring.subscribe ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoringSubscribeParams {
    /// `"self"` for the agent's own host, or a connection ID for a jump target.
    pub host: String,
    /// Collection interval in milliseconds (default: 2000).
    pub interval_ms: Option<u64>,
}

// ── monitoring.unsubscribe ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoringUnsubscribeParams {
    pub host: String,
}

// ── monitoring.data (notification payload) ──────────────────────────

/// System statistics sent as a `monitoring.data` notification.
///
/// This is the core [`SystemStats`] field set plus the monitored `host`
/// identifier. The stats are flattened so the wire shape stays a flat object
/// (`{host, hostname, uptimeSeconds, …}`), while the field set is defined once
/// on [`SystemStats`] rather than hand-maintained here (DUP-015).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringData {
    /// `"self"` or connection ID identifying the monitored host.
    pub host: String,
    /// The collected system statistics, flattened into this object.
    #[serde(flatten)]
    pub stats: SystemStats,
}

impl MonitoringData {
    /// Build a notification payload from a monitored host id and its stats.
    pub fn new(host: String, stats: SystemStats) -> Self {
        Self { host, stats }
    }
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
#[cfg(feature = "ssh")]
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
#[cfg(feature = "ssh")]
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
#[cfg(feature = "ssh")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStartResult {
    /// The `host:port` the listen socket bound on the agent.
    pub bound_address: String,
    /// Who can reach the listen socket (loopback → agent-only).
    pub reachable_from: ReachableFrom,
}

/// Params for `tunnel.stop`.
#[cfg(feature = "ssh")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStopParams {
    /// The tunnel id to stop.
    pub tunnel_id: String,
}

/// Result of `tunnel.stop`.
#[cfg(feature = "ssh")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStopResult {
    /// Whether a running tunnel with that id was found and stopped.
    pub stopped: bool,
}

/// Params for `tunnel.status`.
#[cfg(feature = "ssh")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusParams {
    /// The tunnel id to inspect.
    pub tunnel_id: String,
}

/// Result of `tunnel.status`.
#[cfg(feature = "ssh")]
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

// ── service.* (agent-hosted embedded servers, #2192) ────────────────
//
// An agent-hosted embedded server (HTTP/FTP/TFTP) runs its listen socket on the
// agent; the desktop keeps only control (start/stop/status over this RPC). The
// agent creates the server from its `ServiceRegistry` by `service_id`, keyed for
// later stop/status by the desktop-chosen `instance_id`.

/// Params for `service.start`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStartParams {
    /// The desktop's instance id, used as the key for later stop/status.
    pub instance_id: String,
    /// Which registered service type to start (e.g. `"http_server"`).
    pub service_id: String,
    /// The service's config JSON (an `EmbeddedServerConfig` for the servers).
    pub config: Value,
}

/// Result of `service.start`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStartResult {
    /// The service's lifecycle status once started.
    pub status: ServiceStatus,
    /// The latest status payload streamed on the service's event channel, if any
    /// (the `ServerState` for the embedded servers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
}

/// Params for `service.stop`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStopParams {
    /// The instance id to stop.
    pub instance_id: String,
}

/// Result of `service.stop`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStopResult {
    /// Whether a running instance with that id was found and stopped.
    pub stopped: bool,
}

/// Params for `service.pause` (#2607).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePauseParams {
    /// The instance id to pause in place.
    pub instance_id: String,
}

/// Result of `service.pause` (#2607).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePauseResult {
    /// Whether a running instance with that id was found and paused.
    pub paused: bool,
}

/// Params for `service.resume` (#2607).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResumeParams {
    /// The instance id to resume in place.
    pub instance_id: String,
}

/// Result of `service.resume` (#2607).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResumeResult {
    /// Whether a running instance with that id was found and resumed.
    pub resumed: bool,
}

/// Params for `service.status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusParams {
    /// The instance id to inspect.
    pub instance_id: String,
}

/// Result of `service.status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusResult {
    /// Whether the instance is currently hosted on this agent.
    pub running: bool,
    /// The service's lifecycle status (present only when running).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ServiceStatus>,
    /// The latest status payload streamed on its event channel (present only when
    /// running, and only once at least one event has been emitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
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
    #[cfg(feature = "ssh")]
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

    // ── connections.* result DTOs (DUP-001) ─────────────────────────────

    /// The `ConnectionDefinition` wire bytes must stay snake_case and in a stable
    /// field order — the agent serializes this type directly and the desktop
    /// parses it. Changing any key or the order is a WIRE BREAK.
    #[test]
    fn connection_definition_serializes_to_stable_snake_case_wire() {
        let def = ConnectionDefinition {
            id: "conn-1".to_string(),
            name: "Build Shell".to_string(),
            session_type: "shell".to_string(),
            config: json!({ "shell": "/bin/bash" }),
            persistent: true,
            folder_id: Some("folder-1".to_string()),
            terminal_options: None,
            icon: None,
            source_file: None,
        };
        // `serde_json` (no `preserve_order`) emits struct fields in declaration
        // order; optional None fields are skipped. This is byte-identical to the
        // pre-DUP-001 `ConnectionSnapshot`.
        assert_eq!(
            serde_json::to_string(&def).unwrap(),
            r#"{"id":"conn-1","name":"Build Shell","session_type":"shell","config":{"shell":"/bin/bash"},"persistent":true,"folder_id":"folder-1"}"#
        );
    }

    /// Present optional fields (`terminal_options`, `icon`, `source_file`) appear
    /// on the wire in declaration order.
    #[test]
    fn connection_definition_serializes_present_optionals() {
        let def = ConnectionDefinition {
            id: "ext-1".to_string(),
            name: "Team".to_string(),
            session_type: "local".to_string(),
            config: Value::Null,
            persistent: false,
            folder_id: None,
            terminal_options: Some(json!({ "fontSize": 14 })),
            icon: Some("Terminal".to_string()),
            source_file: Some("/home/pi/team.json".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&def).unwrap(),
            r#"{"id":"ext-1","name":"Team","session_type":"local","config":null,"persistent":false,"folder_id":null,"terminal_options":{"fontSize":14},"icon":"Terminal","source_file":"/home/pi/team.json"}"#
        );
    }

    /// A full snake_case reply deserializes into `ConnectionDefinition`.
    #[test]
    fn connection_definition_parses_full_snake_case_reply() {
        let wire = json!({
            "id": "conn-abc",
            "name": "Build Shell",
            "session_type": "shell",
            "config": { "shell": "/bin/bash" },
            "persistent": true,
            "folder_id": "folder-1",
            "source_file": "/home/pi/team.json"
        });
        let def: ConnectionDefinition = serde_json::from_value(wire).unwrap();
        assert_eq!(def.id, "conn-abc");
        assert_eq!(def.session_type, "shell");
        assert!(def.persistent);
        assert_eq!(def.folder_id.as_deref(), Some("folder-1"));
        assert_eq!(def.source_file.as_deref(), Some("/home/pi/team.json"));
    }

    /// A minimal reply (only the required fields) parses with defaulted optionals
    /// — matching the old hand-parser's `unwrap_or`/`Value::Null` behaviour.
    #[test]
    fn connection_definition_parses_minimal_reply() {
        let wire = json!({ "id": "conn-1", "name": "Test", "session_type": "serial" });
        let def: ConnectionDefinition = serde_json::from_value(wire).unwrap();
        assert_eq!(def.config, Value::Null);
        assert!(!def.persistent);
        assert_eq!(def.folder_id, None);
        assert_eq!(def.terminal_options, None);
        assert_eq!(def.source_file, None);
    }

    /// A missing required field (`session_type`) fails to parse — the typed
    /// equivalent of the old parser returning `None`, so the desktop drops the
    /// entry (`filter_map(... .ok())`).
    #[test]
    fn connection_definition_rejects_missing_required_field() {
        let wire = json!({ "id": "conn-1", "name": "Test" });
        assert!(serde_json::from_value::<ConnectionDefinition>(wire).is_err());
    }

    /// `FolderDefinition` wire bytes stay snake_case and stably ordered.
    #[test]
    fn folder_definition_serializes_to_stable_snake_case_wire() {
        let folder = FolderDefinition {
            id: "folder-abc".to_string(),
            name: "Production".to_string(),
            parent_id: Some("folder-root".to_string()),
            is_expanded: true,
        };
        assert_eq!(
            serde_json::to_string(&folder).unwrap(),
            r#"{"id":"folder-abc","name":"Production","parent_id":"folder-root","is_expanded":true}"#
        );
    }

    /// A minimal folder reply parses with defaulted `parent_id`/`is_expanded`.
    #[test]
    fn folder_definition_parses_minimal_reply() {
        let wire = json!({ "id": "folder-1", "name": "Root" });
        let folder: FolderDefinition = serde_json::from_value(wire).unwrap();
        assert_eq!(folder.parent_id, None);
        assert!(!folder.is_expanded);
    }

    /// The desktop routes an agent-hosted `-R` tunnel as `forward.mode ==
    /// "remote"` with the flattened remote-forward fields. Locks that wire shape
    /// against desktop/agent drift (the `-R` twin of the local test above).
    #[cfg(feature = "ssh")]
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
    #[cfg(feature = "ssh")]
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

    #[cfg(feature = "ssh")]
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

    // ── service.* (agent-hosted embedded servers, #2192) ────────────

    /// Locks the `service.start` wire contract against desktop/agent drift
    /// (#2192): the desktop builds this exact JSON — `config` is the
    /// camelCase `EmbeddedServerConfig` shape carried opaquely. If either side
    /// changes the shape, this parse fails.
    #[test]
    fn service_start_params_parse_the_desktop_wire_shape() {
        let wire = json!({
            "instanceId": "srv-1",
            "serviceId": "http_server",
            "config": {
                "id": "srv-1",
                "name": "Docs",
                "serverType": "http",
                "rootDirectory": "/srv/docs",
                "bindHost": "0.0.0.0",
                "port": 8080,
                "readOnly": true,
                "directoryListing": true
            }
        });
        let params: ServiceStartParams =
            serde_json::from_value(wire).expect("desktop service.start shape must parse");
        assert_eq!(params.instance_id, "srv-1");
        assert_eq!(params.service_id, "http_server");
        assert_eq!(params.config["serverType"], "http");
        assert_eq!(params.config["port"], 8080);
    }

    #[test]
    fn service_start_result_serializes_camel_case_and_omits_absent_state() {
        let result = ServiceStartResult {
            status: ServiceStatus::Running,
            state: None,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["status"]["state"], "running");
        assert!(value.get("state").is_none());
    }

    #[test]
    fn service_status_result_running_carries_status_and_state() {
        let result = ServiceStatusResult {
            running: true,
            status: Some(ServiceStatus::Running),
            state: Some(json!({ "serverId": "srv-1", "status": "running" })),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["running"], true);
        assert_eq!(value["status"]["state"], "running");
        assert_eq!(value["state"]["serverId"], "srv-1");
    }

    #[test]
    fn service_status_result_not_running_omits_optional_fields() {
        let result = ServiceStatusResult {
            running: false,
            status: None,
            state: None,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["running"], false);
        assert!(value.get("status").is_none());
        assert!(value.get("state").is_none());
    }

    #[test]
    fn service_stop_result_serializes_camel_case() {
        let value = serde_json::to_value(ServiceStopResult { stopped: true }).unwrap();
        assert_eq!(value["stopped"], true);
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
        use crate::connection::schema::SettingsSchema;
        use crate::connection::Capabilities as CoreCapabilities;

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
                        tunneling: false,
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
    fn files_set_permissions_params_serde() {
        let json = json!({"connection_id": "conn-1", "path": "/a.sh", "mode": 493});
        let params: FilesSetPermissionsParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-1".to_string()));
        assert_eq!(params.path, "/a.sh");
        // 493 == 0o755
        assert_eq!(params.mode, 0o755);
    }

    #[test]
    fn files_set_owner_params_serde() {
        // Both ids present.
        let json = json!({"connection_id": "conn-1", "path": "/a", "uid": 1000, "gid": 1000});
        let params: FilesSetOwnerParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-1".to_string()));
        assert_eq!(params.path, "/a");
        assert_eq!(params.uid, Some(1000));
        assert_eq!(params.gid, Some(1000));

        // Absent ids default to None (change only the specified side).
        let json = json!({"path": "/a", "gid": 20});
        let params: FilesSetOwnerParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.uid, None);
        assert_eq!(params.gid, Some(20));
    }

    #[test]
    fn files_create_symlink_params_serde() {
        let json = json!({"connection_id": "conn-1", "target": "/real", "link_path": "/link"});
        let params: FilesCreateSymlinkParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-1".to_string()));
        assert_eq!(params.target, "/real");
        assert_eq!(params.link_path, "/link");
    }

    #[test]
    fn files_copy_params_serde() {
        let json = json!({"connection_id": "conn-1", "src": "/a", "dest": "/b"});
        let params: FilesCopyParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.connection_id, Some("conn-1".to_string()));
        assert_eq!(params.src, "/a");
        assert_eq!(params.dest, "/b");
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
        // Built from a core `SystemStats` (DUP-015): the flattened stats must
        // still serialize as a flat camelCase object identical to the previous
        // hand-maintained shape — `host` plus every `SystemStats` field.
        let data = MonitoringData::new(
            "self".to_string(),
            SystemStats {
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
                swap_total_kb: 2_000_000,
                swap_used_kb: 500_000,
                swap_used_percent: 25.0,
                net_rx_bytes_per_sec: 1024.0,
                net_tx_bytes_per_sec: 2048.0,
                per_core_cpu_percent: vec![50.0, 90.0],
            },
        );
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(v["host"], "self");
        assert_eq!(v["hostname"], "raspberrypi");
        assert_eq!(v["uptimeSeconds"], 12345.67);
        assert_eq!(v["loadAverage"], json!([0.15, 0.10, 0.05]));
        assert_eq!(v["cpuUsagePercent"], 78.5);
        assert_eq!(v["memoryTotalKb"], 16384000);
        assert_eq!(v["memoryAvailableKb"], 12000000);
        assert_eq!(v["memoryUsedPercent"], 25.0);
        assert_eq!(v["diskTotalKb"], 50000000);
        assert_eq!(v["diskUsedKb"], 20000000);
        assert_eq!(v["diskUsedPercent"], 42.0);
        assert_eq!(v["osInfo"], "Linux 5.15.0");
        assert_eq!(v["swapTotalKb"], 2_000_000);
        assert_eq!(v["swapUsedKb"], 500_000);
        assert_eq!(v["swapUsedPercent"], 25.0);
        assert_eq!(v["netRxBytesPerSec"], 1024.0);
        assert_eq!(v["netTxBytesPerSec"], 2048.0);
        assert_eq!(v["perCoreCpuPercent"], json!([50.0, 90.0]));
        // The flattened stats must not appear under a nested `stats` key.
        assert!(v.get("stats").is_none());
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

    // ── Method-name constants (DUP-002) ─────────────────────────────
    //
    // These lock every shared method constant to its exact wire string. A
    // rename that would break the desktop↔agent contract fails here rather
    // than silently on the wire.
    #[test]
    fn method_name_values_are_stable() {
        assert_eq!(INITIALIZE, "initialize");
        assert_eq!(CONNECTION_CREATE, "connection.create");
        assert_eq!(CONNECTION_LIST, "connection.list");
        assert_eq!(CONNECTION_ATTACH, "connection.attach");
        assert_eq!(CONNECTION_DETACH, "connection.detach");
        assert_eq!(CONNECTION_WRITE, "connection.write");
        assert_eq!(CONNECTION_RESIZE, "connection.resize");
        assert_eq!(CONNECTION_CLOSE, "connection.close");
        assert_eq!(CONNECTION_TYPES, "connection.types");
        assert_eq!(SESSION_GET_BUFFER, "session.getBuffer");
        assert_eq!(CONNECTION_FILES_LIST, "connection.files.list");
        assert_eq!(CONNECTION_FILES_READ, "connection.files.read");
        assert_eq!(CONNECTION_FILES_WRITE, "connection.files.write");
        assert_eq!(CONNECTION_FILES_DELETE, "connection.files.delete");
        assert_eq!(CONNECTION_FILES_RENAME, "connection.files.rename");
        assert_eq!(CONNECTION_FILES_STAT, "connection.files.stat");
        assert_eq!(CONNECTION_FILES_MKDIR, "connection.files.mkdir");
        assert_eq!(
            CONNECTION_FILES_SET_PERMISSIONS,
            "connection.files.set_permissions"
        );
        assert_eq!(CONNECTION_FILES_SET_OWNER, "connection.files.set_owner");
        assert_eq!(
            CONNECTION_FILES_CREATE_SYMLINK,
            "connection.files.create_symlink"
        );
        assert_eq!(CONNECTION_FILES_COPY, "connection.files.copy");
        assert_eq!(
            CONNECTION_MONITORING_SUBSCRIBE,
            "connection.monitoring.subscribe"
        );
        assert_eq!(
            CONNECTION_MONITORING_UNSUBSCRIBE,
            "connection.monitoring.unsubscribe"
        );
        assert_eq!(CONNECTION_PROCESSES_LIST, "connection.processes.list");
        assert_eq!(CONNECTION_PROCESSES_KILL, "connection.processes.kill");
        assert_eq!(CONNECTIONS_LIST, "connections.list");
        assert_eq!(CONNECTIONS_CREATE, "connections.create");
        assert_eq!(CONNECTIONS_UPDATE, "connections.update");
        assert_eq!(CONNECTIONS_DELETE, "connections.delete");
        assert_eq!(CONNECTIONS_FOLDERS_CREATE, "connections.folders.create");
        assert_eq!(CONNECTIONS_FOLDERS_UPDATE, "connections.folders.update");
        assert_eq!(CONNECTIONS_FOLDERS_DELETE, "connections.folders.delete");
        assert_eq!(HEALTH_CHECK, "health.check");
        assert_eq!(AGENT_LIST_CONNECTIONS, "agent.list_connections");
        assert_eq!(AGENT_SHUTDOWN, "agent.shutdown");
        assert_eq!(AGENT_SETTINGS_UPDATE, "agent.settingsUpdate");
        assert_eq!(AGENT_REQUEST_UPDATE, "agent.request_update");
        assert_eq!(
            AGENT_REQUEST_DEFERRED_UPDATE,
            "agent.request_deferred_update"
        );
        assert_eq!(AGENT_FORWARD_OPEN, "agent.forward.open");
        assert_eq!(AGENT_FORWARD_DATA, "agent.forward.data");
        assert_eq!(AGENT_FORWARD_CLOSE, "agent.forward.close");
        assert_eq!(NETWORK_PORT_SCAN, "network.port_scan");
        assert_eq!(NETWORK_PING, "network.ping");
        assert_eq!(NETWORK_DNS_LOOKUP, "network.dns_lookup");
        assert_eq!(NETWORK_OPEN_PORTS, "network.open_ports");
        assert_eq!(NETWORK_TRACEROUTE, "network.traceroute");
        assert_eq!(NETWORK_WOL, "network.wol");
        assert_eq!(TUNNEL_START, "tunnel.start");
        assert_eq!(TUNNEL_STOP, "tunnel.stop");
        assert_eq!(TUNNEL_STATUS, "tunnel.status");
        assert_eq!(SERVICE_LIST, "service.list");
        assert_eq!(SERVICE_START, "service.start");
        assert_eq!(SERVICE_STOP, "service.stop");
        assert_eq!(SERVICE_PAUSE, "service.pause");
        assert_eq!(SERVICE_RESUME, "service.resume");
        assert_eq!(SERVICE_STATUS, "service.status");
        assert_eq!(TOOL_LIST, "tool.list");
        assert_eq!(TOOL_RUN, "tool.run");
        assert_eq!(CONNECTION_OUTPUT, "connection.output");
        assert_eq!(CONNECTION_EXIT, "connection.exit");
        assert_eq!(CONNECTION_MONITORING_DATA, "connection.monitoring.data");
        assert_eq!(AGENT_UPDATE_PENDING, "agent.update_pending");
        assert_eq!(AGENT_UPDATE_AVAILABLE, "agent.update_available");
    }

    /// Exact-JSON round-trip proving the `connection.create` request params keep
    /// their wire keys (`type` rename, `definition_id`) after the move to core.
    #[test]
    fn session_create_params_exact_json_round_trip() {
        let wire = json!({
            "type": "local",
            "config": { "shell": "/bin/bash", "cols": 80, "rows": 24 },
            "title": "Build",
            "definition_id": "def-1"
        });
        let params: SessionCreateParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(params.session_type, "local");
        assert_eq!(params.definition_id.as_deref(), Some("def-1"));
        // The config is carried opaquely and preserved verbatim.
        assert_eq!(params.config, wire["config"]);
    }

    /// Exact-JSON round-trip for the `connection.create` response, proving the
    /// `type`/`session_id` keys and the `definition_id` omit-when-none rule.
    #[test]
    fn session_create_result_exact_json_round_trip() {
        let result = SessionCreateResult {
            session_id: "s-1".to_string(),
            title: "Build".to_string(),
            session_type: "local".to_string(),
            status: "running".to_string(),
            created_at: "2026-02-14T10:30:00Z".to_string(),
            definition_id: None,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(
            v,
            json!({
                "session_id": "s-1",
                "title": "Build",
                "type": "local",
                "status": "running",
                "created_at": "2026-02-14T10:30:00Z"
            })
        );
    }

    // ── agent_manager request/response wire (DUP-001) ───────────────────
    //
    // The desktop's `agent_manager` builds these requests and parses these
    // replies. Each request test compares `to_value(<Params>)` byte-for-byte with
    // the exact `serde_json::json!` the module built before the migration — a
    // change here is a WIRE BREAK, since the agent deserializes the params. Each
    // reply test proves the shared result DTO deserializes the exact agent reply.
    //
    // The wire carries a JSON object, whose key order is not significant; the RPC
    // client serializes the params `Value` on the way out. So each test compares
    // `to_value(<Params>)` with the legacy `json!` `Value` (both maps), which pins
    // the key set and every value while staying order-independent.

    #[test]
    fn session_create_params_serialize_matches_hand_built_json() {
        // Both optionals present — the desktop sends `title` + `definition_id`.
        let legacy = json!({
            "type": "shell",
            "config": { "shell": "/bin/bash" },
            "title": "Build",
            "definition_id": "def-1",
        });
        let typed = SessionCreateParams {
            session_type: "shell".to_string(),
            config: json!({ "shell": "/bin/bash" }),
            title: Some("Build".to_string()),
            definition_id: Some("def-1".to_string()),
        };
        assert_eq!(serde_json::to_value(&typed).unwrap(), legacy);

        // Both optionals absent — the old builder omitted the keys entirely, so
        // `skip_serializing_if` must keep them out (a `null` key would be a break).
        let legacy_min = json!({ "type": "serial", "config": {} });
        let typed_min = SessionCreateParams {
            session_type: "serial".to_string(),
            config: json!({}),
            title: None,
            definition_id: None,
        };
        assert_eq!(serde_json::to_value(&typed_min).unwrap(), legacy_min);
    }

    #[test]
    fn session_lifecycle_params_serialize_matches_hand_built_json() {
        let legacy = json!({ "session_id": "s-1" });
        assert_eq!(
            serde_json::to_value(SessionAttachParams {
                session_id: "s-1".to_string()
            })
            .unwrap(),
            legacy,
        );
        assert_eq!(
            serde_json::to_value(SessionDetachParams {
                session_id: "s-1".to_string()
            })
            .unwrap(),
            legacy,
        );
        assert_eq!(
            serde_json::to_value(SessionCloseParams {
                session_id: "s-1".to_string()
            })
            .unwrap(),
            legacy,
        );
    }

    #[test]
    fn agent_shutdown_params_serialize_matches_hand_built_json() {
        // Absent reason → `{}` (the old builder started from `json!({})` and only
        // inserted `reason` when present).
        assert_eq!(
            serde_json::to_value(AgentShutdownParams { reason: None }).unwrap(),
            json!({}),
        );
        assert_eq!(
            serde_json::to_value(AgentShutdownParams {
                reason: Some("update".to_string())
            })
            .unwrap(),
            json!({ "reason": "update" }),
        );
    }

    #[test]
    fn agent_shutdown_result_parses_agent_reply() {
        let reply = json!({ "detached_sessions": 3 });
        let parsed: AgentShutdownResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.detached_sessions, 3);
    }

    #[test]
    fn session_create_result_parses_agent_reply() {
        let reply = json!({
            "session_id": "s-9",
            "title": "Build",
            "type": "shell",
            "status": "running",
            "created_at": "2026-02-14T10:30:00Z",
            "definition_id": "def-1",
        });
        let parsed: SessionCreateResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.session_id, "s-9");
        assert_eq!(parsed.session_type, "shell");
        assert_eq!(parsed.status, "running");
        assert_eq!(parsed.definition_id.as_deref(), Some("def-1"));
    }

    #[test]
    fn session_list_result_parses_agent_reply() {
        let reply = json!({
            "sessions": [{
                "session_id": "s-1",
                "title": "Build",
                "type": "shell",
                "status": "running",
                "created_at": "2026-02-14T10:30:00Z",
                "last_activity": "2026-02-14T12:00:00Z",
                "attached": true,
            }],
        });
        let parsed: SessionListResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].session_id, "s-1");
        assert!(parsed.sessions[0].attached);
        assert_eq!(parsed.sessions[0].definition_id, None);
    }

    #[test]
    fn connection_list_result_parses_agent_reply() {
        let reply = json!({
            "connections": [{
                "client_id": "c-1",
                "client": "termihub-desktop",
                "client_version": "0.1.0",
                "connected_since": "2026-02-14T10:30:00Z",
            }],
        });
        let parsed: ConnectionListResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.connections.len(), 1);
        assert_eq!(parsed.connections[0].client_id, "c-1");
        assert_eq!(parsed.connections[0].client, "termihub-desktop");
        assert_eq!(parsed.connections[0].client_version, "0.1.0");
        assert_eq!(
            parsed.connections[0].connected_since,
            "2026-02-14T10:30:00Z"
        );
    }

    // ── agent-update request/response wire (DUP-001) ────────────────────
    //
    // The desktop commands (request_agent_update / request_agent_deferred_update /
    // the coordinated-deploy path) build these requests and parse these replies.
    // The old builders inserted `binaryPath`/`version` only when present, so the
    // params must omit the absent keys (skip_serializing_if) to stay byte-identical.

    #[test]
    fn request_deferred_update_params_serialize_matches_hand_built_json() {
        assert_eq!(
            serde_json::to_value(AgentRequestDeferredUpdateParams {
                binary_path: Some("/tmp/agent".to_string()),
                version: Some("0.4.0".to_string()),
                expected_sha256: Some("a".repeat(64)),
            })
            .unwrap(),
            json!({ "binaryPath": "/tmp/agent", "version": "0.4.0", "expectedSha256": "a".repeat(64) }),
        );
        // Self-update "Apply Now": no staging inputs → `{}`.
        assert_eq!(
            serde_json::to_value(AgentRequestDeferredUpdateParams {
                binary_path: None,
                version: None,
                expected_sha256: None,
            })
            .unwrap(),
            json!({}),
        );
    }

    #[test]
    fn request_update_params_serialize_matches_hand_built_json() {
        // The desktop only ever sends `binaryPath`/`version`; `ackTimeoutSecs`
        // stays absent, so it must not appear on the wire.
        assert_eq!(
            serde_json::to_value(AgentRequestUpdateParams {
                binary_path: Some("/tmp/agent".to_string()),
                version: Some("0.4.0".to_string()),
                expected_sha256: Some("b".repeat(64)),
                ack_timeout_secs: None,
            })
            .unwrap(),
            json!({ "binaryPath": "/tmp/agent", "version": "0.4.0", "expectedSha256": "b".repeat(64) }),
        );
        assert_eq!(
            serde_json::to_value(AgentRequestUpdateParams {
                binary_path: None,
                version: None,
                expected_sha256: None,
                ack_timeout_secs: None,
            })
            .unwrap(),
            json!({}),
        );
    }

    #[test]
    fn request_deferred_update_result_parses_agent_reply() {
        let reply = json!({ "applied": false, "activeSessions": 2 });
        let parsed: AgentRequestDeferredUpdateResult = serde_json::from_value(reply).unwrap();
        assert!(!parsed.applied);
        assert_eq!(parsed.active_sessions, 2);
    }

    #[test]
    fn request_update_result_parses_agent_reply() {
        let reply = json!({
            "applied": false,
            "activeSessions": 1,
            "notifiedClients": 3,
            "allAcked": false,
            "remainingClients": ["host-b"],
        });
        let parsed: AgentRequestUpdateResult = serde_json::from_value(reply).unwrap();
        assert!(!parsed.applied);
        assert_eq!(parsed.active_sessions, 1);
        assert_eq!(parsed.notified_clients, 3);
        assert!(!parsed.all_acked);
        assert_eq!(parsed.remaining_clients, vec!["host-b".to_string()]);

        // The happy path omits `remainingClients`; `#[serde(default)]` fills it.
        let happy = json!({
            "applied": true,
            "activeSessions": 0,
            "notifiedClients": 0,
            "allAcked": true,
        });
        let parsed: AgentRequestUpdateResult = serde_json::from_value(happy).unwrap();
        assert!(parsed.remaining_clients.is_empty());
    }

    // ── remote_proxy reply DTOs (DUP-001) ───────────────────────────────
    //
    // The desktop's remote_proxy parses these agent replies into the shared
    // result DTOs. Each test proves the DTO deserializes the exact wire the agent
    // serializes (round-tripping through the agent-side `Serialize`).

    #[test]
    fn files_list_result_parses_agent_reply() {
        let reply = json!({
            "entries": [{
                "name": "dir",
                "path": "/dir",
                "isDirectory": true,
                "size": 4096,
                "modified": "2026-01-01T00:00:00Z",
                "permissions": "rwxr-xr-x",
                "isSymlink": false,
            }],
        });
        let parsed: FilesListResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].name, "dir");
        assert!(parsed.entries[0].is_directory);
    }

    #[test]
    fn files_read_result_parses_agent_reply() {
        let reply = json!({ "data": "ZGF0YQ==", "size": 4 });
        let parsed: FilesReadResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.data, "ZGF0YQ==");
        assert_eq!(parsed.size, 4);
    }

    #[test]
    fn processes_list_result_parses_agent_reply() {
        // Round-trip through the agent-side Serialize so the fixture matches the
        // exact `ProcessInfo` wire without hand-writing its field set.
        let wire = serde_json::to_value(ProcessesListResult { processes: vec![] }).unwrap();
        assert_eq!(wire, json!({ "processes": [] }));
        let parsed: ProcessesListResult = serde_json::from_value(wire).unwrap();
        assert!(parsed.processes.is_empty());
    }

    // ── agent_manager I/O-task + definition/folder builders (DUP-001) ────
    //
    // The desktop I/O task builds the session.* / agent.forward.* write requests,
    // and the manager builds the connections.* delete / folders.create+delete
    // requests. Each test pins the wire byte-for-byte against the old json!.

    #[test]
    fn session_write_resize_forward_params_match_hand_built_json() {
        assert_eq!(
            serde_json::to_value(SessionInputParams {
                session_id: "s-1".to_string(),
                data: "aGk=".to_string(),
            })
            .unwrap(),
            json!({ "session_id": "s-1", "data": "aGk=" }),
        );
        assert_eq!(
            serde_json::to_value(SessionResizeParams {
                session_id: "s-1".to_string(),
                cols: 120,
                rows: 40,
            })
            .unwrap(),
            json!({ "session_id": "s-1", "cols": 120, "rows": 40 }),
        );
        assert_eq!(
            serde_json::to_value(AgentForwardDataParams {
                stream_id: "str-1".to_string(),
                data: "aGk=".to_string(),
            })
            .unwrap(),
            json!({ "stream_id": "str-1", "data": "aGk=" }),
        );
        assert_eq!(
            serde_json::to_value(AgentForwardCloseParams {
                stream_id: "str-1".to_string(),
            })
            .unwrap(),
            json!({ "stream_id": "str-1" }),
        );
    }

    #[test]
    fn definition_folder_builder_params_match_hand_built_json() {
        assert_eq!(
            serde_json::to_value(ConnectionDeleteParams {
                id: "def-1".to_string()
            })
            .unwrap(),
            json!({ "id": "def-1" }),
        );
        assert_eq!(
            serde_json::to_value(FolderDeleteParams {
                id: "f-1".to_string()
            })
            .unwrap(),
            json!({ "id": "f-1" }),
        );
        // `parent_id` stays a JSON `null` when absent (root folder).
        assert_eq!(
            serde_json::to_value(FolderCreateParams {
                name: "Prod".to_string(),
                parent_id: None,
            })
            .unwrap(),
            json!({ "name": "Prod", "parent_id": null }),
        );
        assert_eq!(
            serde_json::to_value(FolderCreateParams {
                name: "Prod".to_string(),
                parent_id: Some("root".to_string()),
            })
            .unwrap(),
            json!({ "name": "Prod", "parent_id": "root" }),
        );
    }
}
