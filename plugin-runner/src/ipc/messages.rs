//! Control-frame payloads (MessagePack via `rmp-serde`).
//!
//! Every struct here is the payload of exactly one [`super::FrameKind`]. Field
//! additions must stay backward compatible within a protocol version (new
//! fields `#[serde(default)]`); anything else bumps
//! [`super::PROTOCOL_VERSION`].

use serde::{Deserialize, Serialize};
use termihub_plugin_api::{AbiVersion, PanicStrategy, PluginError, PluginStatus, Toolchain};

use crate::loader::LoadedPluginInfo;

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
    /// counts threads (which plugins need), so it is left to the seccomp
    /// filter of the Linux sandbox phase.
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
/// any plugin code. Phase 1 (#4182) applies none, so both lists are empty; the
/// per-OS sandbox phases fill them in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxReport {
    /// Layers that are enforced (e.g. `seatbelt`, `landlock`, `seccomp`).
    pub enforced: Vec<String>,
    /// Layers that were requested but are unavailable on this system.
    pub missing: Vec<String>,
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
