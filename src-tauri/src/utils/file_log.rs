//! Persistent application log file (#1570).
//!
//! termiHub historically kept its log only in memory: the [`LogCaptureLayer`]
//! ring buffer feeds the in-app LogViewer, and the `fmt` layer writes to stdout
//! — which is discarded for a bundled desktop app. The moment the process was
//! gone, so was every trace of what it had been doing. A post-mortem of the
//! 2026-07-17 shutdown had to be reconstructed entirely from Apple's unified
//! log and jetsam snapshots because termiHub itself left nothing behind.
//!
//! This module adds the missing durable sink: a rotating, hard-capped log file
//! in the platform's conventional location.
//!
//! # Design notes
//!
//! **Why not `tauri-plugin-log`?** The issue suggested it, but the app already
//! owns a full `tracing` pipeline (filter + fmt + ring buffer). The plugin
//! builds a second, parallel logging system on the `log` crate; every event
//! would need bridging and the two would drift. Adding one more `Layer` to the
//! registry that already exists is both smaller and keeps a single source of
//! truth.
//!
//! **The writer itself is shared with the agent** (#4319, audit DUP2-006): the
//! size-rotating, count-capped [`RotatingLogFile`] and the `russh` WARN clamp
//! live in [`termihub_core::diagnostics::file_log`], which also explains why
//! they are synchronous and size-based rather than `tracing-appender`'s. This
//! module owns only where the desktop's log lives, its file name, and the
//! desktop's level controls. The desktop runs as a single instance, so it keeps
//! one `termihub.log` family rather than per-process files; the shared writer
//! still follows its live path if a second (portable or dev) instance rotates
//! it.

use std::io;
use std::path::{Path, PathBuf};

use termihub_core::diagnostics::file_log::{self as shared, RUSSH_CLAMP};
pub use termihub_core::diagnostics::file_log::RotatingLogFile;
use tracing_subscriber::{reload, EnvFilter, Registry};

use super::portable::detect_app_mode;

/// The app's bundle identifier, matching `tauri.conf.json`.
///
/// Used to build the platform log directory. Kept in sync with the bundle id by
/// [`tests::log_dir_matches_platform_convention`].
const BUNDLE_ID: &str = "com.termihub.app";

/// Base name of the current log file (`termihub.log`).
const LOG_STEM: &str = "termihub";

/// Size at which the current log file is rotated away.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Total number of log files kept: the current one plus `MAX_FILES - 1`
/// archives. Together with [`MAX_FILE_BYTES`] this bounds on-disk usage at
/// 15 MiB.
const MAX_FILES: usize = 3;

/// Environment variable overriding the file sink's filter directive for one
/// launch, e.g. `TERMIHUB_FILE_LOG=debug`. The file keeps INFO and above by
/// default — stricter than the ring buffer, which keeps termiHub's crates at
/// DEBUG for the LogViewer — and `RUST_LOG` is deliberately *not* honored here,
/// so what lands on disk does not depend on how the app happened to be
/// launched. Overrides keep the shared [`RUSSH_CLAMP`].
const FILE_LOG_ENV: &str = "TERMIHUB_FILE_LOG";

/// Log-level names selectable from the in-app Settings control (OBS-009),
/// ordered least→most verbose. `"off"` disables the file sink entirely; the
/// others map to the matching `tracing` level. Kept in sync with the frontend
/// `AppSettings.fileLogLevel` union.
pub const SELECTABLE_FILE_LOG_LEVELS: &[&str] = &["off", "error", "warn", "info", "debug", "trace"];

/// Build a file-sink filter directive from a simple level name (OBS-009).
///
/// Returns `None` for an unrecognized level. Every level except `"off"` keeps
/// the [`RUSSH_CLAMP`], so raising verbosity from the UI can never leak russh's
/// per-packet cipher logs into the durable, user-shared file — the same safety
/// property [`file_env_filter_with`] enforces for the env-var override. `"off"`
/// silences the file entirely, russh included.
///
/// Case- and whitespace-insensitive, so a stored `" Debug "` still resolves.
pub fn directive_for_level(level: &str) -> Option<String> {
    let level = level.trim().to_ascii_lowercase();
    if !SELECTABLE_FILE_LOG_LEVELS.contains(&level.as_str()) {
        return None;
    }
    if level == "off" {
        Some("off".to_string())
    } else {
        Some(format!("{level},{RUSSH_CLAMP}"))
    }
}

/// Build an [`EnvFilter`] for a selectable level name, or `None` if unrecognized.
///
/// This is the resolution used both at startup (for a persisted level) and by
/// the `set_file_log_level` command's live reload.
pub fn env_filter_for_level(level: &str) -> Option<EnvFilter> {
    let directive = directive_for_level(level)?;
    EnvFilter::try_new(directive).ok()
}

/// Build the [`EnvFilter`] for the file sink, honoring (in priority order):
///
/// 1. the [`FILE_LOG_ENV`] env var — an explicit directive, the startup
///    override for a support case that needs a bespoke filter;
/// 2. `persisted_level` — the level chosen in Settings (OBS-009), resolved via
///    [`directive_for_level`] (so it carries the [`RUSSH_CLAMP`]);
/// 3. the shared INFO default ([`shared::DEFAULT_FILE_DIRECTIVE`]).
///
/// The env-var branch prepends [`RUSSH_CLAMP`], so a directive
/// that names `russh` explicitly still wins while one that does not stays
/// clamped. An unrecognized `persisted_level` falls through to the default.
pub fn file_env_filter_with(persisted_level: Option<&str>) -> EnvFilter {
    if let Ok(directive) = std::env::var(FILE_LOG_ENV) {
        if !directive.trim().is_empty() {
            return shared::file_env_filter(Some(&directive));
        }
    }
    persisted_level
        .and_then(env_filter_for_level)
        .unwrap_or_else(|| shared::file_env_filter(None))
}

/// Reload handle for the file sink's per-layer [`EnvFilter`] (OBS-009).
///
/// Lets the `set_file_log_level` command swap the file verbosity live —
/// [`reload::Handle::reload`] rebuilds tracing's interest cache so the change
/// takes effect without a restart. The `S` type is [`Registry`] because the
/// filtered file layer is attached directly onto the registry in `lib.rs`, which
/// is what keeps this handle type nameable and storable as Tauri state.
pub type FileLogReloadHandle = reload::Handle<EnvFilter, Registry>;

/// Managed Tauri state wrapping the file-filter reload handle.
///
/// `None` when the log file could not be opened at startup: the level control
/// still persists the choice (applied on the next successful launch) but has
/// nothing live to reload.
pub struct FileLogReload(pub Option<FileLogReloadHandle>);

/// Name of the log subdirectory inside the portable `data/` directory.
const PORTABLE_LOG_SUBDIR: &str = "logs";

/// Resolve the directory the application log is written to.
///
/// In portable mode (#4065) this is `<portable data dir>/logs`, so a portable
/// launch — from a USB stick, say — leaves nothing in the host's profile. Every
/// other durable artifact derived from this directory (session transcripts in
/// `sessions/`, local crash reports, the diagnostics bundle) follows it.
/// Portable detection runs here directly because the subscriber is initialized
/// before the Tauri app (and any `AppHandle`) exists.
///
/// Otherwise it follows each platform's own convention — see
/// [`platform_log_dir`].
///
/// An explicit [`LOG_DIR_ENV`] override wins over both: it lets an isolated
/// instance (the system-test harness, which already isolates the config with
/// `TERMIHUB_CONFIG_DIR`) keep its log, transcripts and crash reports out of the
/// user's real log directory.
///
/// Returns `None` when no directory can be resolved, in which case file logging
/// is skipped rather than guessed at.
pub fn log_dir() -> Option<PathBuf> {
    let override_dir = std::env::var_os(LOG_DIR_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let portable_data_dir = detect_app_mode()
        .ok()
        .and_then(|mode| mode.data_dir().map(Path::to_path_buf));
    resolve_log_dir(
        override_dir,
        portable_data_dir.as_deref(),
        platform_log_dir(),
    )
}

/// Environment variable that overrides the log directory (see [`log_dir`]).
pub const LOG_DIR_ENV: &str = "TERMIHUB_LOG_DIR";

/// Pick the log directory from explicit inputs: an explicit override wins, then
/// the portable `data/` directory, otherwise the platform directory. Split out
/// from [`log_dir`] so the precedence is testable without a real portable
/// install or a process-wide environment variable.
fn resolve_log_dir(
    override_dir: Option<PathBuf>,
    portable_data_dir: Option<&Path>,
    platform: Option<PathBuf>,
) -> Option<PathBuf> {
    if override_dir.is_some() {
        return override_dir;
    }
    match portable_data_dir {
        Some(data_dir) => Some(data_dir.join(PORTABLE_LOG_SUBDIR)),
        None => platform,
    }
}

/// The installed-mode log directory.
///
/// Follows each platform's own convention rather than inventing one — notably
/// on macOS this is `~/Library/Logs/<bundle-id>/`, which is where the #1570
/// investigator looked and found nothing. These paths match Tauri's own
/// `app_log_dir()` resolution, but are computed here because the subscriber is
/// initialized before the Tauri app exists.
///
/// - macOS: `~/Library/Logs/com.termihub.app`
/// - Windows: `%LOCALAPPDATA%\com.termihub.app\logs`
/// - Linux: `$XDG_DATA_HOME/com.termihub.app/logs` (i.e. `~/.local/share/...`)
fn platform_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library").join("Logs").join(BUNDLE_ID))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|d| d.join(BUNDLE_ID).join("logs"))
    }
}

/// Full path of the current (un-rotated) log file, for reporting to the user.
pub fn log_file_path() -> Option<PathBuf> {
    log_dir().map(|d| shared::generation_path(&d, LOG_STEM, 0))
}

/// Every log file of termiHub's own app-log family in `dir` — `termihub.log`,
/// its archives, and any `termihub-…` per-process file — live files first.
/// Never the `sessions/` transcripts that live beside them (OBS-010
/// diagnostics export).
pub fn existing_log_files_in(dir: &Path) -> Vec<PathBuf> {
    shared::family_files(dir, LOG_STEM)
}

/// Open the log file at the platform's conventional location ([`log_dir`])
/// with the default size and count caps.
pub fn open_default_log() -> io::Result<RotatingLogFile> {
    let dir = log_dir().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "could not resolve a platform log directory",
        )
    })?;
    RotatingLogFile::new(dir, LOG_STEM, MAX_FILE_BYTES, MAX_FILES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn portable_mode_puts_the_log_under_the_portable_data_dir() {
        // Regression for #4065: a portable launch must not write its log (or
        // the transcripts / crash reports beside it) into the host's profile.
        let data_dir = Path::new("/media/usb/termiHub/data");
        let platform = Some(PathBuf::from(
            "/home/user/.local/share/com.termihub.app/logs",
        ));

        let dir = resolve_log_dir(None, Some(data_dir), platform.clone())
            .expect("a portable data dir always resolves a log dir");

        assert_eq!(dir, data_dir.join("logs"));
        assert!(
            dir.starts_with(data_dir),
            "portable log dir {dir:?} must stay inside the portable data dir"
        );
        assert_ne!(
            Some(dir),
            platform,
            "portable mode must not use the profile"
        );
    }

    #[test]
    fn portable_mode_ignores_an_unresolvable_platform_dir() {
        // A host without a resolvable profile base must not disable the log in
        // portable mode: the portable folder is all it needs.
        let data_dir = Path::new("/media/usb/termiHub/data");
        assert_eq!(
            resolve_log_dir(None, Some(data_dir), None),
            Some(data_dir.join("logs"))
        );
    }

    #[test]
    fn installed_mode_uses_the_platform_log_dir() {
        let platform = Some(PathBuf::from(
            "/home/user/.local/share/com.termihub.app/logs",
        ));
        assert_eq!(resolve_log_dir(None, None, platform.clone()), platform);
        assert_eq!(resolve_log_dir(None, None, None), None);
    }

    #[test]
    fn an_explicit_override_wins_over_portable_and_platform() {
        let isolated = PathBuf::from("/tmp/termihub-app-config-x/logs");
        let platform = Some(PathBuf::from(
            "/home/user/.local/share/com.termihub.app/logs",
        ));
        assert_eq!(
            resolve_log_dir(
                Some(isolated.clone()),
                Some(Path::new("/media/usb/termiHub/data")),
                platform.clone()
            ),
            Some(isolated.clone())
        );
        assert_eq!(
            resolve_log_dir(Some(isolated.clone()), None, None),
            Some(isolated)
        );
    }

    #[test]
    fn log_dir_follows_the_detected_app_mode() {
        // `log_dir()` is the composition of override + detection + resolution;
        // whatever the test process sees, the two must agree.
        let expected = match std::env::var_os(LOG_DIR_ENV).filter(|v| !v.is_empty()) {
            Some(dir) => Some(PathBuf::from(dir)),
            None => match detect_app_mode().expect("app mode resolves on test hosts") {
                crate::utils::portable::AppMode::Portable { data_dir } => {
                    Some(data_dir.join("logs"))
                }
                crate::utils::portable::AppMode::Installed => platform_log_dir(),
            },
        };
        assert_eq!(log_dir(), expected);
    }

    #[test]
    fn log_dir_matches_platform_convention() {
        let dir =
            platform_log_dir().expect("a platform log directory should resolve on test hosts");

        assert!(
            dir.ends_with(BUNDLE_ID) || dir.ends_with(Path::new(BUNDLE_ID).join("logs")),
            "log dir {dir:?} must be namespaced by the bundle id"
        );

        #[cfg(target_os = "macos")]
        assert!(
            dir.ends_with(Path::new("Library").join("Logs").join(BUNDLE_ID)),
            "macOS must use ~/Library/Logs/<bundle-id>, got {dir:?}"
        );

        #[cfg(not(target_os = "macos"))]
        assert!(
            dir.ends_with(Path::new(BUNDLE_ID).join("logs")),
            "non-macOS platforms must use <local-data>/<bundle-id>/logs, got {dir:?}"
        );
    }

    #[test]
    fn directive_for_level_maps_known_levels_and_clamps_russh() {
        // Every non-off level carries the russh clamp (safety, not just noise).
        assert_eq!(
            directive_for_level("error").as_deref(),
            Some("error,russh=warn")
        );
        assert_eq!(
            directive_for_level("info").as_deref(),
            Some("info,russh=warn")
        );
        assert_eq!(
            directive_for_level("debug").as_deref(),
            Some("debug,russh=warn")
        );
        assert_eq!(
            directive_for_level("trace").as_deref(),
            Some("trace,russh=warn")
        );
        // "off" silences everything, russh included.
        assert_eq!(directive_for_level("off").as_deref(), Some("off"));
        // Case- and whitespace-insensitive so a stored value still resolves.
        assert_eq!(
            directive_for_level(" Debug ").as_deref(),
            Some("debug,russh=warn")
        );
        // Unknown levels are rejected rather than guessed at.
        assert_eq!(directive_for_level("verbose"), None);
        assert_eq!(directive_for_level(""), None);
    }

    #[test]
    fn env_filter_for_level_accepts_known_and_rejects_unknown() {
        assert!(env_filter_for_level("debug").is_some());
        assert!(env_filter_for_level("off").is_some());
        assert!(env_filter_for_level("nonsense").is_none());
    }

    #[test]
    fn a_persisted_debug_level_admits_app_debug_but_still_clamps_russh() {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Layer as _;

        // OBS-009: raising the file level to DEBUG must surface termiHub's own
        // debug detail (the point of the control) while russh stays clamped —
        // packet-level SSH internals must never reach the user-shared file.
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), LOG_STEM, 1 << 20, 3).unwrap();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(log.clone())
                .with_filter(env_filter_for_level("debug").unwrap()),
        );
        crate::utils::log_capture::test_support::with_scoped_subscriber(subscriber, || {
            tracing::debug!(target: "termihub_lib::session", "app debug detail");
            tracing::debug!(target: "russh", "packet cipher internals");
        });

        let contents = read(&dir.path().join("termihub.log"));
        assert!(
            contents.contains("app debug detail"),
            "app DEBUG must reach the file at debug level, got: {contents:?}"
        );
        assert!(
            !contents.contains("packet cipher internals"),
            "russh DEBUG must stay clamped even when the file level is raised to debug"
        );
    }

    /// Whether `filter` admits an app-level DEBUG event into the file, without
    /// touching the process environment (global, and would race other tests).
    fn app_debug_reaches_file(filter: EnvFilter) -> bool {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Layer as _;

        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), LOG_STEM, 1 << 20, 3).unwrap();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(log.clone())
                .with_filter(filter),
        );
        crate::utils::log_capture::test_support::with_scoped_subscriber(subscriber, || {
            tracing::debug!(target: "termihub_lib::session", "app debug detail");
        });
        read(&dir.path().join("termihub.log")).contains("app debug detail")
    }

    #[test]
    fn file_env_filter_with_persisted_level_raises_the_default() {
        // No persisted level → the INFO default keeps app DEBUG out of the file.
        assert!(
            !app_debug_reaches_file(file_env_filter_with(None)),
            "the default file level must not admit DEBUG"
        );
        // A persisted "debug" raises the file to admit app DEBUG (OBS-009).
        assert!(
            app_debug_reaches_file(file_env_filter_with(Some("debug"))),
            "a persisted debug level must admit app DEBUG"
        );
        // An unrecognized persisted level falls back to the INFO default.
        assert!(
            !app_debug_reaches_file(file_env_filter_with(Some("bogus"))),
            "an unrecognized persisted level must fall back to the default"
        );
    }

    #[test]
    fn file_log_reload_handle_swaps_the_filter_live() {
        // Validates the `FileLogReloadHandle` alias (S = Registry) and the live
        // reload path the `set_file_log_level` command drives. `_layer` must stay
        // alive so the handle's shared state is not dropped before the reload.
        // A successful reload rebuilds the global interest cache; pin the
        // registry so that rebuild cannot silence other tests' capture.
        crate::utils::log_capture::test_support::pin_multi_dispatcher_registry();
        let (_layer, handle): (_, FileLogReloadHandle) =
            reload::Layer::new(env_filter_for_level("info").unwrap());
        assert!(
            handle
                .reload(env_filter_for_level("debug").unwrap())
                .is_ok(),
            "reloading to a valid level must succeed"
        );
    }

    #[test]
    fn log_file_path_sits_inside_the_log_dir() {
        let path = log_file_path().unwrap();
        assert_eq!(path.file_name().unwrap(), "termihub.log");
        assert_eq!(path.parent().unwrap(), log_dir().unwrap());
    }

    #[test]
    fn file_filter_keeps_info_and_drops_debug() {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Layer as _;

        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), LOG_STEM, 1 << 20, 3).unwrap();

        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(log.clone())
                .with_filter(file_env_filter_with(None)),
        );
        crate::utils::log_capture::test_support::with_scoped_subscriber(subscriber, || {
            tracing::info!(target: "termihub_lib::session", "session opened");
            tracing::debug!(target: "termihub_lib::session", "per-keystroke noise");
        });

        let contents = read(&dir.path().join("termihub.log"));
        assert!(
            contents.contains("session opened"),
            "INFO must reach the file, got: {contents:?}"
        );
        assert!(
            !contents.contains("per-keystroke noise"),
            "DEBUG must not reach the file — it is what drowns a readable log; got: {contents:?}"
        );
    }
}
