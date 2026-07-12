//! Spawn core: CLI-driven "open in termiHub" rendezvous (#1364).
//!
//! Foundation for the Shell Context Menu & CLI Spawn Integration epic (#1363).
//!
//! A `termiHub spawn ...` invocation (from a file-manager context menu or a
//! terminal) is detected from the raw process arguments *before* Tauri
//! initialises, turned into a [`SpawnRequest`], and forwarded over a per-user
//! platform IPC channel to an already-running instance. If no instance is
//! reachable, the request is handed back to the caller, which launches as the
//! running instance and handles the request itself.
//!
//! This module owns the wire types, the CLI parser, and the pre-init command
//! classifier. The transport lives in [`ipc_server`] and [`ipc_client`].

use serde::{Deserialize, Serialize};

#[cfg(not(any(unix, windows)))]
compile_error!("spawn IPC requires a Unix or Windows target");

pub mod container;
pub mod ipc_client;
pub mod ipc_server;
pub mod registry;

#[cfg(test)]
mod tests;

/// A request to open a new session, originating from an external
/// `termiHub spawn` invocation.
///
/// All fields are optional so partially-specified requests round-trip cleanly;
/// resolution of the effective connection type happens downstream (out of scope
/// for #1364).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnRequest {
    /// Filesystem path (folder or file) the session should open at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Identifier of the context-menu entry that triggered the spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    /// Explicit connection id override (highest-priority resolution).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    /// Open in a fresh window instead of attaching to the running instance.
    #[serde(default)]
    pub new_window: bool,
    /// Force the interactive session picker.
    #[serde(default)]
    pub pick: bool,
    /// Docker/Podman image to use for a "new container" spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_image: Option<String>,
    /// Mount target path inside the container (default resolved downstream).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_mount: Option<String>,
}

/// Outcome status returned by the running instance for a [`SpawnRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpawnStatus {
    /// The running instance accepted the request.
    Accepted,
    /// The request could not be handled.
    Error,
}

/// Response sent back to the spawning process over the IPC channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnResponse {
    /// Outcome status.
    pub status: SpawnStatus,
    /// Human-readable detail, present on error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SpawnResponse {
    /// Build an accepted response.
    pub fn accepted() -> Self {
        Self {
            status: SpawnStatus::Accepted,
            message: None,
        }
    }

    /// Build an error response carrying a detail message.
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: SpawnStatus::Error,
            message: Some(message.into()),
        }
    }
}

/// Callback invoked by the IPC server for each received [`SpawnRequest`].
pub type SpawnHandler = std::sync::Arc<dyn Fn(SpawnRequest) -> SpawnResponse + Send + Sync>;

/// A pre-init CLI command recognised from the raw process arguments.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// `termiHub spawn ...` — forward or launch-and-handle a spawn request.
    Spawn(SpawnRequest),
    /// `termiHub install-shell-integration` (stub until SI-5/6/7).
    InstallShellIntegration,
    /// `termiHub uninstall-shell-integration` (stub until SI-5/6/7).
    UninstallShellIntegration,
    /// No recognised spawn subcommand — proceed with a normal launch.
    None,
}

/// Classify the process arguments (with the program name already stripped) into
/// a pre-init [`Command`]. Pure and side-effect-free so it is unit-testable.
pub fn classify_command(args: &[String]) -> Command {
    match args.first().map(String::as_str) {
        Some("spawn") => Command::Spawn(parse_spawn_args(&args[1..])),
        Some("install-shell-integration") => Command::InstallShellIntegration,
        Some("uninstall-shell-integration") => Command::UninstallShellIntegration,
        _ => Command::None,
    }
}

/// Parse the flags following `spawn` into a [`SpawnRequest`].
///
/// Both `--flag value` and `--flag=value` forms are accepted. Unknown flags and
/// stray positional arguments are ignored so the parser never fails — a spawn
/// invocation should degrade gracefully rather than abort before the app can
/// surface an error to the user.
pub fn parse_spawn_args(args: &[String]) -> SpawnRequest {
    let mut req = SpawnRequest::default();
    let mut i = 0;
    while i < args.len() {
        let raw = args[i].as_str();
        let (key, inline) = match raw.split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (raw, None),
        };
        // Value flags map to a slot to fill; boolean flags are handled inline
        // and yield no slot.
        let slot: Option<&mut Option<String>> = match key {
            "--new-window" => {
                req.new_window = true;
                None
            }
            "--pick" => {
                req.pick = true;
                None
            }
            "--location" => Some(&mut req.location),
            "--entry-id" => Some(&mut req.entry_id),
            "--connection" => Some(&mut req.connection),
            "--container-image" => Some(&mut req.container_image),
            "--container-mount" => Some(&mut req.container_mount),
            _ => None,
        };
        if let Some(slot) = slot {
            // Take an inline `--flag=value`, else the next argument.
            *slot = inline.or_else(|| {
                i += 1;
                args.get(i).cloned()
            });
        }
        i += 1;
    }
    req
}

/// Platform IPC address of the per-user spawn rendezvous.
///
/// On Windows this is a named pipe (`\\.\pipe\termihub-spawn-{username}`); on
/// Unix it is a filesystem path to a domain socket
/// (`{runtime_dir}/termihub-spawn-{uid}.sock`).
#[derive(Debug, Clone)]
pub struct SpawnEndpoint {
    address: String,
}

impl SpawnEndpoint {
    /// Resolve the rendezvous address for the current user.
    pub fn for_current_user() -> anyhow::Result<Self> {
        Ok(Self {
            address: default_address()?,
        })
    }

    /// Platform address string (pipe name on Windows, socket path on Unix).
    pub(crate) fn address(&self) -> &str {
        &self.address
    }

    /// Unique per-process endpoint used by tests to avoid collisions.
    #[cfg(test)]
    pub fn for_test(tag: &str) -> Self {
        Self {
            address: test_address(tag),
        }
    }
}

impl std::fmt::Display for SpawnEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.address)
    }
}

#[cfg(windows)]
fn default_address() -> anyhow::Result<String> {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    Ok(format!(r"\\.\pipe\termihub-spawn-{user}"))
}

#[cfg(unix)]
fn default_address() -> anyhow::Result<String> {
    let dir = dirs::runtime_dir().unwrap_or_else(std::env::temp_dir);
    // SAFETY: `getuid` is always successful and has no preconditions.
    let uid = unsafe { libc::getuid() };
    Ok(dir
        .join(format!("termihub-spawn-{uid}.sock"))
        .to_string_lossy()
        .into_owned())
}

#[cfg(all(test, windows))]
fn test_address(tag: &str) -> String {
    format!(r"\\.\pipe\termihub-spawn-test-{}-{tag}", std::process::id())
}

#[cfg(all(test, unix))]
fn test_address(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "termihub-spawn-test-{}-{tag}.sock",
            std::process::id()
        ))
        .to_string_lossy()
        .into_owned()
}

/// Attempt to forward a spawn request to an already-running instance,
/// blocking on a short-lived current-thread runtime.
///
/// Returns `Ok` if a running instance accepted the request, `Err` if none is
/// reachable (in which case the caller should launch and handle it locally).
pub fn forward_to_running_instance(
    endpoint: &SpawnEndpoint,
    req: &SpawnRequest,
) -> anyhow::Result<SpawnResponse> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;
    runtime.block_on(ipc_client::send(endpoint, req))
}
