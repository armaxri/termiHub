//! Control-frame payloads (MessagePack via `rmp-serde`).
//!
//! Every struct here is the payload of exactly one [`super::FrameKind`]. Field
//! additions must stay backward compatible within a protocol version (new
//! fields `#[serde(default)]`); anything else bumps
//! [`super::PROTOCOL_VERSION`].

use serde::{Deserialize, Serialize};
use termihub_plugin_api::{AbiVersion, PanicStrategy, PluginError, PluginStatus, Toolchain};

use crate::loader::LoadedPluginInfo;
use crate::sandbox::SandboxPolicy;

/// Runner → host, first frame: who is speaking and which protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    /// The runner's crate version.
    pub runner_version: String,
    /// The protocol version the runner speaks ([`super::PROTOCOL_VERSION`]).
    pub protocol_version: u32,
    /// The runner's process id (diagnostics only — never trusted for identity).
    pub pid: u32,
}

/// Host → runner: what to load and how. Sent once, after [`Hello`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Configure {
    /// Absolute path of the plugin's backend library (UTF-8).
    pub library_path: String,
    /// Signed `sha256:` digest the library must match at load (CORE-034);
    /// `None` for a legacy unsigned plugin.
    pub expected_digest: Option<String>,
    /// The manifest `apiVersion` the library's ABI must mirror (PLG-002).
    pub manifest_api_version: Option<String>,
    /// Whether the hash-bound trust acknowledgement accepted an unverifiable
    /// (ABI 1.0) toolchain for this exact library.
    pub accept_unverified_toolchain: bool,
    /// The host-trusted plugin id (manifest), used as the log tag.
    pub plugin_id: String,
    /// The application version handed to ABI 1.1 plugins.
    pub host_version: String,
    /// Process resource limits the runner applies to itself before it loads
    /// any plugin code (#4184). Chosen by the host, never by the manifest.
    /// Absent (an older host) means no limits.
    #[serde(default)]
    pub limits: ResourceLimits,
    /// The OS sandbox the runner applies to itself after pinning the library
    /// and before `dlopen` (#4186). Chosen by the host from the plugin's
    /// folders, never by the manifest. Absent (an older host, or a test
    /// harness) means no confinement.
    #[serde(default)]
    pub sandbox: Option<SandboxPolicy>,
}

/// Process resource limits for a runner (#4184, concept "Crash isolation and
/// restart policy"). The runner applies them with `setrlimit` after the
/// handshake and before the plugin library is mapped, so they bind every byte
/// of plugin code. Each limit only ever lowers the inherited one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceLimits {
    /// Cap on the runner's address space in bytes (`RLIMIT_AS`, Linux only:
    /// macOS does not enforce it, so the host polls the runner's resident size
    /// there instead). `None` leaves it unlimited.
    #[serde(default)]
    pub address_space_bytes: Option<u64>,
    /// Cap on open file descriptors (`RLIMIT_NOFILE`). `None` leaves it as
    /// inherited.
    #[serde(default)]
    pub max_open_files: Option<u64>,
    /// Forbid starting child processes. Enforced with `RLIMIT_NPROC = 0` on
    /// macOS, where it counts processes only. On Linux `RLIMIT_NPROC` also
    /// counts threads (which plugins need), so there the OS sandbox's seccomp
    /// filter forbids child processes whenever the sandbox is on (#4185).
    #[serde(default)]
    pub forbid_child_processes: bool,
}

impl ResourceLimits {
    /// Default address-space cap: 512 MiB.
    pub const DEFAULT_ADDRESS_SPACE_BYTES: u64 = 512 * 1024 * 1024;
    /// Default open-file cap.
    pub const DEFAULT_MAX_OPEN_FILES: u64 = 256;

    /// The concept's defaults: 512 MiB of address space, 256 descriptors, no
    /// child processes.
    #[must_use]
    pub const fn plugin_defaults() -> Self {
        Self {
            address_space_bytes: Some(Self::DEFAULT_ADDRESS_SPACE_BYTES),
            max_open_files: Some(Self::DEFAULT_MAX_OPEN_FILES),
            forbid_child_processes: true,
        }
    }
}

/// Runner → host: which confinement layers the runner applied before loading
/// any plugin code (names: [`crate::sandbox::layer`]). Empty lists mean nothing
/// is enforced (no policy, or no sandbox phase for this platform yet); see
/// [`crate::sandbox::Isolation`] for how the host reads it. A runner whose
/// setup failed sends `failed` and exits without loading the plugin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxReport {
    /// Layers that are enforced (e.g. `seatbelt`, `landlock`, `seccomp`).
    pub enforced: Vec<String>,
    /// Layers that were requested but are unavailable on this system.
    pub missing: Vec<String>,
    /// Why setting the sandbox up failed, if it did (`SandboxSetupFailed`).
    #[serde(default)]
    pub failed: Option<String>,
}

/// The build toolchain as it crosses the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireToolchain {
    /// `"<release> (<commit-hash>)"`, or empty when unknown.
    pub rustc: String,
    /// [`PanicStrategy`] wire value.
    pub panic_strategy: u32,
}

/// Runner → host: the plugin loaded and passed every gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Loaded {
    /// Stable plugin identifier the library reported.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// The plugin's own version.
    pub version: String,
    /// Packed ABI version (`AbiVersion::to_packed`).
    pub abi_version: u32,
    /// The plugin's build toolchain (ABI 1.1+ only).
    pub toolchain: Option<WireToolchain>,
}

impl Loaded {
    /// Copy a loader result onto the wire.
    #[must_use]
    pub fn from_info(info: &LoadedPluginInfo) -> Self {
        Self {
            id: info.id.clone(),
            name: info.name.clone(),
            version: info.version.clone(),
            abi_version: info.abi_version.to_packed(),
            toolchain: info.toolchain.as_ref().map(|t| WireToolchain {
                rustc: t.rustc.clone(),
                panic_strategy: t.panic_strategy.to_wire(),
            }),
        }
    }

    /// Rebuild the host-side info. The runner already enforced the ABI gate and
    /// toolchain rule; the host re-checks the ABI anyway (untrusted peer).
    #[must_use]
    pub fn into_info(self) -> LoadedPluginInfo {
        LoadedPluginInfo {
            id: self.id,
            name: self.name,
            version: self.version,
            abi_version: AbiVersion::from_packed(self.abi_version),
            toolchain: self.toolchain.map(|t| Toolchain {
                rustc: t.rustc,
                panic_strategy: PanicStrategy::from_wire(t.panic_strategy),
            }),
        }
    }
}

/// Runner → host: the plugin was refused or failed to load. The runner exits
/// after sending it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoadFailed {
    /// Whether this is a version incompatibility (ABI / toolchain) rather than
    /// a load error, so the management layer picks the right state.
    pub incompatible: bool,
    /// The loader's message, verbatim.
    pub message: String,
}

/// Host → runner: create a backend session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSession {
    /// Host-assigned id, unique for the runner's lifetime.
    pub session_id: u32,
    /// The per-connection settings JSON.
    pub config_json: String,
    /// The plugin-level settings JSON (PLG-008).
    pub settings_json: String,
    /// The plugin's private data directory (ABI 1.1 host context), already
    /// created by the host; empty when there is none (an ABI 1.0 plugin, whose
    /// ABI is only known after `Loaded`).
    pub data_dir: String,
    /// How long the runner waits for the host's answer to one
    /// `open_connection` bridge call, in milliseconds: the session's connect
    /// timeout plus slack (#4183). `0` selects the runner's default.
    #[serde(default)]
    pub connect_deadline_ms: u64,
}

/// A plugin error as it crosses the wire: the ABI status code plus the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    /// [`PluginStatus`] discriminant.
    pub status: i32,
    /// Human-readable detail.
    pub message: String,
}

impl WireError {
    /// Encode a plugin error.
    #[must_use]
    pub fn from_error(err: &PluginError) -> Self {
        Self {
            status: PluginStatus::from_error(err) as i32,
            message: err.to_string(),
        }
    }

    /// Rebuild a [`PluginError`]; unknown codes become [`PluginError::Other`].
    #[must_use]
    pub fn into_error(self) -> PluginError {
        const CHANNEL_CLOSED: i32 = PluginStatus::ChannelClosed as i32;
        const NOT_ALIVE: i32 = PluginStatus::NotAlive as i32;
        const INVALID_CONFIG: i32 = PluginStatus::InvalidConfig as i32;
        const IO: i32 = PluginStatus::Io as i32;
        const PANIC: i32 = PluginStatus::Panic as i32;
        const PERMISSION_DENIED: i32 = PluginStatus::PermissionDenied as i32;
        const RESOURCE_LIMIT: i32 = PluginStatus::ResourceLimit as i32;
        match self.status {
            CHANNEL_CLOSED => PluginError::ChannelClosed,
            NOT_ALIVE => PluginError::NotAlive,
            INVALID_CONFIG => PluginError::InvalidConfig(self.message),
            IO => PluginError::Io(self.message),
            PANIC => PluginError::Panicked,
            PERMISSION_DENIED => PluginError::PermissionDenied,
            RESOURCE_LIMIT => PluginError::ResourceLimit,
            _ => PluginError::Other(self.message),
        }
    }
}

/// Runner → host: `create_backend` failed for this session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionFailed {
    /// The session that failed to start.
    pub session_id: u32,
    /// Why.
    pub error: WireError,
}

/// Host → runner: resize a session's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resize {
    /// The session.
    pub session_id: u32,
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
}

/// A frame that names just one session (`SessionCreated`, `Close`, `Closed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRef {
    /// The session.
    pub session_id: u32,
}

/// Host → runner: set a cancellation flag (ABI 1.1 `is_cancelled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cancel {
    /// One session, or `None` for the whole plugin (unload / shutdown).
    pub session_id: Option<u32>,
}

/// Runner → host: a queued `write_input` / `resize` failed inside the plugin.
/// The host side of those calls is asynchronous, so the error arrives later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionError {
    /// The session.
    pub session_id: u32,
    /// Which operation failed (`write_input`, `resize`).
    pub operation: String,
    /// Why.
    pub error: WireError,
}

/// Runner → host: a session's `is_alive` changed (pushed on change).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alive {
    /// The session.
    pub session_id: u32,
    /// The new liveness.
    pub alive: bool,
}

/// Runner → host: one plugin log line from the ABI 1.1 services callback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Log {
    /// The session whose services handle logged, if any.
    pub session_id: Option<u32>,
    /// `PluginLogLevel` wire value.
    pub level: u32,
    /// The message, at most `MAX_LOG_MESSAGE_BYTES` (8 KiB). The host
    /// re-checks the bound and sanitises it (untrusted peer).
    pub message: String,
    /// Whether the runner cut the plugin's message to the bound.
    pub truncated: bool,
}

/// `Ping` / `Pong` payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heartbeat {
    /// Echoed back unchanged.
    pub nonce: u64,
}

// ---------------------------------------------------------------------------
// Capability bridge over IPC (#4183, plugin OS-sandbox phase 2)
// ---------------------------------------------------------------------------

/// Runner → host: one capability-bridge call a plugin made through the 1.x
/// `PluginHostBridge`. The host checks it against the session's permissions
/// exactly as the in-process bridge does and answers with a [`BridgeReply`]
/// carrying the same `request_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeRequest {
    /// Runner-chosen id, unique among the runner's outstanding requests.
    pub request_id: u64,
    /// The session whose bridge the plugin called (its permission scope).
    pub session_id: u32,
    /// What the plugin asked for.
    pub op: BridgeOp,
}

/// The bridge operations of the frozen 1.x ABI
/// (`termihub_plugin_api::PluginHostBridgeVTable`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeOp {
    /// `open_connection(host, port)` — `network` permission + connection policy.
    OpenConnection {
        /// Host name or address, as the plugin passed it.
        host: String,
        /// TCP port.
        port: u16,
    },
    /// `read_file(path)`, one chunk at `offset` (a file larger than one frame
    /// is read in several requests; the runner reassembles it).
    ReadFile {
        /// The path, as the plugin passed it (resolved by the host scope).
        path: String,
        /// Byte offset of the chunk.
        offset: u64,
    },
    /// `write_file(path, data, mode)`. A write larger than one frame is sent
    /// as the requested `mode` followed by `Append` chunks.
    WriteFile {
        /// The path, as the plugin passed it (resolved by the host scope).
        path: String,
        /// The bytes to write.
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
        /// `termihub_plugin_api::PluginWriteMode` discriminant.
        mode: i32,
    },
    /// `stat_path(path)`.
    Stat {
        /// The path, as the plugin passed it (resolved by the host scope).
        path: String,
    },
    /// `list_dir(path)`, one page. A listing larger than one frame is paged
    /// (#4220): the first request carries `cursor: 0`, and each later one the
    /// `next_cursor` of the previous [`BridgeResult::Entries`]; the runner
    /// reassembles the pages.
    ListDir {
        /// The path, as the plugin passed it (resolved by the host scope).
        path: String,
        /// `0` starts a listing; otherwise the host-issued continuation cursor.
        #[serde(default)]
        cursor: u64,
    },
}

impl BridgeOp {
    /// The ABI callback name, for logs and denial events.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            BridgeOp::OpenConnection { .. } => "open_connection",
            BridgeOp::ReadFile { .. } => "read_file",
            BridgeOp::WriteFile { .. } => "write_file",
            BridgeOp::Stat { .. } => "stat_path",
            BridgeOp::ListDir { .. } => "list_dir",
        }
    }
}

/// How the connection behind a [`BridgeResult::Connection`] reaches the
/// runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamTransport {
    /// The host passed the connected socket itself along with the reply
    /// (`SCM_RIGHTS` on Unix): the runner drives it directly.
    HandlePassed,
    /// The host keeps the socket and relays its bytes as `StreamData` /
    /// `StreamWrite` frames (the fallback where a handle cannot be passed).
    Proxy,
}

/// The outcome of one [`BridgeRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeResult {
    /// The call failed or was refused: a `PluginStatus` discriminant
    /// (already downgraded for the plugin's ABI by the host).
    Status {
        /// `PluginStatus` discriminant.
        status: i32,
    },
    /// `open_connection` succeeded.
    Connection {
        /// Host-assigned id, used by `BridgeRelease` and the stream frames.
        conn_id: u64,
        /// How the connection is delivered.
        transport: StreamTransport,
    },
    /// One `read_file` chunk.
    Data {
        /// The chunk's bytes.
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
        /// Whether the file ends after this chunk.
        eof: bool,
    },
    /// `write_file` succeeded.
    Written,
    /// `stat_path` succeeded.
    Metadata {
        /// Whether anything exists at the path.
        exists: bool,
        /// Whether it is a directory.
        is_dir: bool,
        /// File size in bytes.
        len: u64,
    },
    /// `list_dir` succeeded: one page of entry names (lossy UTF-8), host
    /// order.
    Entries {
        /// The entry names.
        names: Vec<String>,
        /// `0` when this page ends the listing; otherwise the cursor that
        /// requests the next page (#4220).
        #[serde(default)]
        next_cursor: u64,
    },
}

/// Host → runner: the answer to a [`BridgeRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeReply {
    /// The request this answers.
    pub request_id: u64,
    /// The outcome.
    pub result: BridgeResult,
}

/// A frame that names one bridge connection (`BridgeRelease`, `StreamClosed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnRef {
    /// The connection.
    pub conn_id: u64,
}

/// Proxied connection bytes (`StreamData` host → runner, `StreamWrite`
/// runner → host).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamChunk {
    /// The connection.
    pub conn_id: u64,
    /// The bytes.
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

/// Flow-control credit for a proxied connection: `StreamAck` (runner → host,
/// the plugin consumed `bytes` of `StreamData`) and `StreamWriteAck` (host →
/// runner, `bytes` of `StreamWrite` reached the socket, or the write failed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamAck {
    /// The connection.
    pub conn_id: u64,
    /// Bytes acknowledged.
    pub bytes: u32,
    /// `StreamWriteAck` only: the socket write failed; later writes fail too.
    #[serde(default)]
    pub failed: bool,
}
