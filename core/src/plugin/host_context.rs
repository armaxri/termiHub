//! Host side of the ABI 1.1 **host context** (PLG-014, #3576): the per-plugin
//! data directory and the target-tagged log pipeline behind the
//! [`PluginHostContext`](termihub_plugin_api::PluginHostContext) a native
//! backend receives.
//!
//! The context itself — services table, cancellation flag — lives in the
//! plugin's runner process (ADR-19); the runner forwards every log line over
//! IPC and the host emits it here ([`emit_runner_log`]). Plugin-supplied data
//! is untrusted: the log level is a validated `u32`, the message is bounded to
//! [`MAX_LOG_MESSAGE_BYTES`], decoded lossily and stripped of control
//! characters, and every line is **rate-limited per plugin** by a
//! [`PluginLogLimiter`](super::log_rate_limit::PluginLogLimiter) shared by
//! every session of the plugin (see [`super::log_rate_limit`]): excess lines
//! are dropped and reported by one summary line per window.

use std::path::{Path, PathBuf};

use termihub_plugin_api::{PluginLogLevel, MAX_LOG_MESSAGE_BYTES};

use super::log_rate_limit::{emit_suppression_summary, PluginLogLimiter};
use super::manifest::is_valid_plugin_id;

/// The `tracing` target every plugin log line is emitted under. A `tracing`
/// target must be a compile-time constant, so the plugin id is folded into the
/// message as a `[<id>]` prefix (the same pattern as frontend log forwarding).
pub const PLUGIN_LOG_TARGET: &str = "plugin";

/// Name of the directory under the plugins root that holds every plugin's
/// private data directory. It starts with `.`, which a plugin id (a
/// `[a-z0-9-]` slug) never does, so it can never collide with an installed
/// plugin's directory, and the manager's scan skips it (it has no manifest).
pub const PLUGIN_DATA_DIR_NAME: &str = ".data";

/// Marker appended to a log message the host truncated.
const TRUNCATED_MARKER: &str = " …[truncated]";

/// Emit one log line a plugin runner forwarded (#4182): the plugin-wide rate
/// limit (shared by every session of the plugin, so more sessions add no
/// budget),
/// sanitisation (control characters, invalid UTF-8, truncation marker) and the
/// host-trusted `[<id>]` tag. `bytes` must already be bounded to
/// [`MAX_LOG_MESSAGE_BYTES`]; an invalid `level` is dropped.
pub(crate) fn emit_runner_log(
    limiter: &PluginLogLimiter,
    plugin_id: &str,
    level: u32,
    bytes: &[u8],
    truncated: bool,
) {
    let Some(level) = PluginLogLevel::from_wire(level) else {
        return;
    };
    let admission = limiter.admit(plugin_id);
    if let Some(count) = admission.summary {
        emit_suppression_summary(plugin_id, count);
    }
    if admission.emit {
        let bounded = &bytes[..bytes.len().min(MAX_LOG_MESSAGE_BYTES)];
        emit_plugin_log(level, plugin_id, &sanitize_log_message(bounded, truncated));
    }
}

/// Turn untrusted plugin log bytes into one safe log line: invalid UTF-8 is
/// replaced, every control character (newlines included, so a message cannot
/// forge extra log lines) becomes a space, and a truncation marker is appended
/// when the plugin's message was longer than the bound.
pub(crate) fn sanitize_log_message(bytes: &[u8], truncated: bool) -> String {
    let mut text: String = String::from_utf8_lossy(bytes)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if truncated {
        text.push_str(TRUNCATED_MARKER);
    }
    text
}

/// Compose the final log line: the host-trusted plugin id tag, then the text.
pub(crate) fn compose_plugin_log(plugin_id: &str, text: &str) -> String {
    format!("[{plugin_id}] {text}")
}

fn emit_plugin_log(level: PluginLogLevel, plugin_id: &str, text: &str) {
    let line = compose_plugin_log(plugin_id, text);
    match level {
        PluginLogLevel::Error => tracing::error!(target: PLUGIN_LOG_TARGET, "{line}"),
        PluginLogLevel::Warn => tracing::warn!(target: PLUGIN_LOG_TARGET, "{line}"),
        PluginLogLevel::Info => tracing::info!(target: PLUGIN_LOG_TARGET, "{line}"),
        PluginLogLevel::Debug => tracing::debug!(target: PLUGIN_LOG_TARGET, "{line}"),
        PluginLogLevel::Trace => tracing::trace!(target: PLUGIN_LOG_TARGET, "{line}"),
    }
}

/// Why a plugin data directory could not be prepared.
#[derive(Debug, thiserror::Error)]
pub enum PluginDataDirError {
    /// The id is not a valid plugin id, so it cannot name a directory.
    #[error("`{0}` is not a valid plugin id for a data directory")]
    InvalidId(String),
    /// A path component is a symlink (or not a directory), which could point
    /// the data directory outside the plugins root.
    #[error("plugin data path `{0}` is not a real directory")]
    NotADirectory(PathBuf),
    /// The resolved directory escaped the data root.
    #[error("plugin data directory `{0}` escapes the plugins data root")]
    Escapes(PathBuf),
    /// The path is not valid UTF-8, so it cannot cross the ABI as a string.
    #[error("plugin data directory `{0}` is not valid UTF-8")]
    NotUtf8(PathBuf),
    /// Creating or resolving the directory failed.
    #[error("could not prepare plugin data directory `{path}`: {source}")]
    Io {
        /// The path being prepared.
        path: PathBuf,
        /// The underlying error.
        source: std::io::Error,
    },
}

/// Create (if needed) and return plugin `id`'s private data directory,
/// `<plugins_root>/.data/<id>`, as a UTF-8 string.
///
/// The directory survives plugin updates (installs replace `<plugins_root>/<id>`
/// only) and is removed on uninstall. It is **path-contained**: `id` must be a
/// valid plugin id (a `[a-z0-9-]` slug — no separators, no `..`), neither
/// `.data` nor `<id>` may be a symlink, and the canonical result must stay under
/// the canonical data root. On Unix the directory is private to the user (0700).
pub fn prepare_plugin_data_dir(
    plugins_root: &Path,
    id: &str,
) -> Result<String, PluginDataDirError> {
    if !is_valid_plugin_id(id) {
        return Err(PluginDataDirError::InvalidId(id.to_owned()));
    }
    let data_root = plugins_root.join(PLUGIN_DATA_DIR_NAME);
    let dir = data_root.join(id);
    for path in [&data_root, &dir] {
        ensure_real_dir(path)?;
    }
    let io = |path: &Path| {
        let path = path.to_owned();
        move |source| PluginDataDirError::Io { path, source }
    };
    let canonical_root = data_root.canonicalize().map_err(io(&data_root))?;
    let canonical = dir.canonicalize().map_err(io(&dir))?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err(PluginDataDirError::Escapes(canonical));
    }
    canonical
        .to_str()
        .map(str::to_owned)
        .ok_or(PluginDataDirError::NotUtf8(canonical.clone()))
}

/// Create `path` as a private directory if absent; refuse a symlink or a
/// non-directory in its place.
fn ensure_real_dir(path: &Path) -> Result<(), PluginDataDirError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(PluginDataDirError::NotADirectory(path.to_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_private_dir(path),
        Err(source) => Err(PluginDataDirError::Io {
            path: path.to_owned(),
            source,
        }),
    }
}

fn create_private_dir(path: &Path) -> Result<(), PluginDataDirError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|source| PluginDataDirError::Io {
            path: path.to_owned(),
            source,
        })
}

/// Remove plugin `id`'s data directory, if any (on uninstall). Refuses an
/// invalid id and never follows a symlink out of the data root: a symlinked
/// entry is unlinked, not traversed.
pub fn remove_plugin_data_dir(plugins_root: &Path, id: &str) -> std::io::Result<()> {
    if !is_valid_plugin_id(id) {
        return Ok(());
    }
    let dir = plugins_root.join(PLUGIN_DATA_DIR_NAME).join(id);
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&dir),
        Ok(_) => std::fs::remove_file(&dir),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
#[path = "host_context_tests.rs"]
mod tests;
