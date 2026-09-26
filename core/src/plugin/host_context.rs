//! Host side of the ABI 1.1 **host context** (PLG-014, #3576): the per-plugin
//! data directory, the target-tagged log callback, and the cancellation signal a
//! native backend receives through
//! [`PluginHostContext`](termihub_plugin_api::PluginHostContext).
//!
//! # FFI safety of the callbacks
//!
//! The services table below is called by plugin code, from any plugin thread,
//! for as long as the plugin keeps a handle. Every callback therefore:
//!
//! * tolerates a null context (returns a failure status / `false`, never
//!   dereferences it);
//! * runs its body inside [`std::panic::catch_unwind`], so no host panic can
//!   unwind into plugin frames;
//! * treats plugin-supplied data as untrusted — the log level is a validated
//!   `u32`, the message is read only up to [`MAX_LOG_MESSAGE_BYTES`], decoded
//!   lossily and stripped of control characters;
//! * is **rate-limited per plugin** by a [`PluginLogLimiter`] shared by every
//!   session of the plugin (see [`super::log_rate_limit`]): excess lines are
//!   dropped with an `Ok` status and reported by one summary line per window.
//!
//! The context is an [`Arc`]'d [`ServicesState`] whose strong count is the
//! handle count: `retain`/`release` map to `Arc::increment_strong_count` /
//! `decrement_strong_count`, so the state lives exactly as long as the last
//! handle (host or plugin) and is freed by the host's own allocator.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use termihub_plugin_api::{
    FfiStr, PluginHostServices, PluginHostServicesVTable, PluginLogLevel, PluginStatus,
    MAX_LOG_MESSAGE_BYTES,
};

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

/// Shared state behind one session's services handles.
pub(crate) struct ServicesState {
    /// The host-trusted plugin id (from the manifest), used as the log tag —
    /// the plugin cannot choose it.
    plugin_id: String,
    /// Set when this session is torn down.
    session_cancelled: AtomicBool,
    /// Set when the whole plugin is unloaded; shared by all its sessions.
    plugin_shutdown: Arc<AtomicBool>,
    /// The plugin-wide log rate limiter; shared by all its sessions so opening
    /// more sessions does not raise the plugin's log budget.
    log_limiter: Arc<PluginLogLimiter>,
}

impl ServicesState {
    /// Create the state for one session of plugin `plugin_id`, observing the
    /// plugin-wide `plugin_shutdown` flag and charging its log lines to the
    /// plugin-wide `log_limiter`.
    pub(crate) fn new(
        plugin_id: String,
        plugin_shutdown: Arc<AtomicBool>,
        log_limiter: Arc<PluginLogLimiter>,
    ) -> Arc<Self> {
        Arc::new(Self {
            plugin_id,
            session_cancelled: AtomicBool::new(false),
            plugin_shutdown,
            log_limiter,
        })
    }

    /// Cancel this session (sticky).
    pub(crate) fn cancel(&self) {
        self.session_cancelled.store(true, Ordering::SeqCst);
    }

    /// Whether this session or its plugin has been cancelled.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.session_cancelled.load(Ordering::SeqCst) || self.plugin_shutdown.load(Ordering::SeqCst)
    }

    /// Build a new FFI handle owning one reference on `state`.
    pub(crate) fn handle(state: &Arc<Self>) -> PluginHostServices {
        let ctx = Arc::into_raw(Arc::clone(state)).cast_mut().cast::<c_void>();
        // SAFETY: `ctx` carries the one strong reference just leaked, which the
        // handle adopts and `services_release` gives back; every callback in
        // `SERVICES_VTABLE` interprets `ctx` as exactly an `Arc<ServicesState>`
        // pointer and is safe to call from any thread.
        unsafe { PluginHostServices::from_raw(ctx, &SERVICES_VTABLE) }
    }
}

/// The host's services table — a static, so its address is stable for the
/// process lifetime (plugins may keep handles past any one session).
static SERVICES_VTABLE: PluginHostServicesVTable = PluginHostServicesVTable {
    retain: services_retain,
    release: services_release,
    log: services_log,
    is_cancelled: services_is_cancelled,
};

/// Borrow the state behind a services `ctx`, or `None` for null.
///
/// # Safety
///
/// A non-null `ctx` must be a pointer from [`ServicesState::handle`] on which
/// the caller holds a live reference.
unsafe fn state<'a>(ctx: *mut c_void) -> Option<&'a ServicesState> {
    // SAFETY: caller contract; `as_ref` handles null.
    unsafe { ctx.cast::<ServicesState>().cast_const().as_ref() }
}

unsafe extern "C" fn services_retain(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: the caller holds a live reference on `ctx`, an
        // `Arc<ServicesState>` pointer, so incrementing is valid.
        unsafe { Arc::increment_strong_count(ctx.cast::<ServicesState>().cast_const()) };
    });
}

unsafe extern "C" fn services_release(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: releases exactly the reference the caller owns; the last
        // release drops the state with the host's allocator.
        unsafe { Arc::decrement_strong_count(ctx.cast::<ServicesState>().cast_const()) };
    });
}

unsafe extern "C" fn services_is_cancelled(ctx: *mut c_void) -> bool {
    std::panic::catch_unwind(|| {
        // SAFETY: the caller holds a live reference on `ctx` (or it is null).
        unsafe { state(ctx) }.is_none_or(ServicesState::is_cancelled)
    })
    // A panic here should be impossible; report "cancelled" so a plugin winds
    // down rather than running on after a host fault.
    .unwrap_or(true)
}

unsafe extern "C" fn services_log(ctx: *mut c_void, level: u32, message: FfiStr) -> PluginStatus {
    std::panic::catch_unwind(|| {
        // SAFETY: the caller holds a live reference on `ctx` (or it is null).
        let Some(state) = (unsafe { state(ctx) }) else {
            return PluginStatus::Other;
        };
        let Some(level) = PluginLogLevel::from_wire(level) else {
            return PluginStatus::InvalidConfig;
        };
        // Rate limit before touching the message: a dropped line costs no read,
        // no allocation. Dropped lines still report `Ok` (documented in the
        // plugin API) — a plugin cannot usefully react to a dropped log line.
        let admission = state.log_limiter.admit(&state.plugin_id);
        if let Some(count) = admission.summary {
            emit_suppression_summary(&state.plugin_id, count);
        }
        if !admission.emit {
            return PluginStatus::Ok;
        }
        // Read at most MAX_LOG_MESSAGE_BYTES of the plugin's buffer, never past.
        let bounded = message.len.min(MAX_LOG_MESSAGE_BYTES);
        let bytes: &[u8] = if bounded == 0 || message.ptr.is_null() {
            &[]
        } else {
            // SAFETY: the plugin promises `ptr` is valid for `len` bytes for the
            // call; we read a prefix of that range only.
            unsafe { std::slice::from_raw_parts(message.ptr, bounded) }
        };
        let text = sanitize_log_message(bytes, message.len > MAX_LOG_MESSAGE_BYTES);
        emit_plugin_log(level, &state.plugin_id, &text);
        PluginStatus::Ok
    })
    .unwrap_or(PluginStatus::Panic)
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
