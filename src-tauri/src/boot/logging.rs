//! Logging / tracing initialization (ARCH-002 / TAURI-009, Slice B).
//!
//! The subscriber-assembly block that used to live inline at the top of
//! [`crate::run`], extracted verbatim into [`init_tracing`]. This is a pure
//! statement move: the ring buffer, the durable file sink, the reloadable
//! per-layer filter, and the subscriber layer-attachment order are all
//! byte-identical to the former inline code.
//!
//! **Layer-attachment order is load-bearing and must not change.** The file
//! layer is attached first so the reloadable per-layer filter's `S` type is
//! `Registry` (see [`crate::utils::file_log::FileLogReloadHandle`]) — which is
//! what lets the reload handle be stored as Tauri managed state — then the
//! global `default_env_filter`, then the `fmt` layer, then the capture layer.

use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

use crate::connection::settings::SettingsStorage;
use crate::utils::file_log::{self, FileLogReloadHandle};
use crate::utils::log_capture::{
    create_log_buffer, default_env_filter, LogCaptureLayer, SharedLogBuffer,
};

/// The pieces the assembled tracing subscriber hands back to [`crate::run`]:
/// the values it must thread into the Tauri builder's managed state, the
/// capture layer's app-handle slot, and the durable file-log status used for
/// the startup log lines.
pub(crate) struct TracingInit {
    /// The in-memory ring buffer backing the LogViewer; managed as state.
    pub(crate) log_buffer: SharedLogBuffer,
    /// The reloadable file-log filter handle (`None` if the log file could not
    /// be opened this run); managed via [`file_log::FileLogReload`].
    pub(crate) file_reload_handle: Option<FileLogReloadHandle>,
    /// The `AppHandle` slot the capture layer emits through; filled by
    /// [`super::init_platform_and_capture`] once the app exists.
    pub(crate) app_handle_slot: Arc<Mutex<Option<AppHandle>>>,
    /// Whether the durable application log file opened; drives the startup
    /// `info!`/`warn!` lines emitted right after `.init()`.
    pub(crate) file_log_status: std::io::Result<()>,
}

/// Build and install the global tracing subscriber, returning the values
/// [`crate::run`] threads into the builder.
///
/// This is a verbatim move of the former inline block: it constructs the ring
/// buffer + capture layer, reads the persisted file-log verbosity, opens the
/// durable log file (best-effort), and initializes the subscriber with the
/// exact layer-attachment order documented on this module. It does **not**
/// emit the startup log lines or install the panic hook — those stay in
/// `run()` so they still run, in order, after `.init()` returns.
pub(crate) fn init_tracing() -> TracingInit {
    let log_buffer = create_log_buffer();
    let capture_layer = LogCaptureLayer::new(log_buffer.clone());
    let app_handle_slot = capture_layer.app_handle_slot();

    // Durable application log (#1570). A bundled desktop app has nowhere for the
    // `fmt` layer's stdout to go and the ring buffer dies with the process, so
    // without this sink the app leaves no evidence of what it was doing. Kept
    // best-effort: an unwritable log directory must never stop the app booting,
    // so the failure is recorded and startup continues.
    // File-log verbosity persisted from the in-app control (OBS-009), read
    // best-effort before the Tauri app (and its path resolver) exist — the
    // standalone resolver detects portable mode itself. `TERMIHUB_FILE_LOG` still
    // wins at startup (handled inside `file_env_filter_with`); an absent or
    // unreadable settings file simply leaves the level at the INFO default.
    let persisted_file_log_level: Option<String> = SettingsStorage::new_standalone()
        .ok()
        .and_then(|s| s.load_with_recovery().ok())
        .and_then(|r| r.data.file_log_level);

    let (file_layer, file_reload_handle, file_log_status) =
        match file_log::RotatingLogFile::with_defaults() {
            Ok(writer) => {
                // Reloadable per-layer filter so the Settings control can change
                // the file verbosity live, without a restart (OBS-009).
                let (filter, handle) = tracing_subscriber::reload::Layer::new(
                    file_log::file_env_filter_with(persisted_file_log_level.as_deref()),
                );
                let layer = tracing_subscriber::fmt::layer()
                    // No terminal on the other end of a file: escape codes would
                    // just make it unreadable.
                    .with_ansi(false)
                    .with_writer(writer)
                    .with_filter(filter);
                (Some(layer), Some(handle), Ok(()))
            }
            Err(e) => (None, None, Err(e)),
        };

    tracing_subscriber::registry()
        // The file layer is attached first so its reloadable per-layer filter's
        // `S` type is `Registry` (see `file_log::FileLogReloadHandle`) — which is
        // what lets the handle be stored as Tauri state. Attachment order does
        // not change the global `default_env_filter` envelope, which still caps
        // every sink, so this is behavior-preserving.
        .with(file_layer)
        .with(default_env_filter())
        .with(tracing_subscriber::fmt::layer())
        .with(capture_layer)
        .init();

    TracingInit {
        log_buffer,
        file_reload_handle,
        app_handle_slot,
        file_log_status,
    }
}
