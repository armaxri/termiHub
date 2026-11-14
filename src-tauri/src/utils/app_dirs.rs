//! Every directory termiHub itself writes to, resolved for the app mode (#5764).
//!
//! In installed mode each location is the platform's own convention (Tauri's
//! path resolver, `dirs`, the OS temp dir). In portable mode every one of them
//! lives inside the portable `data/` directory, so a portable copy leaves no
//! file in the host user's profile:
//!
//! | Location                        | Portable path              |
//! | ------------------------------- | -------------------------- |
//! | Config (connections, settings)  | `data/`                    |
//! | Logs, transcripts, crash reports| `data/logs/`               |
//! | Caches (plugin downloads, drag-out staging) | `data/cache/`  |
//! | Agent binary cache              | `data/cache/agent-binaries/` |
//! | Web view data (Windows, Linux)  | `data/webview/`            |
//! | Temporary / staging files       | `data/tmp/` (emptied at start and exit) |
//!
//! The config and log directories are resolved by
//! [`super::config_paths`] / [`super::file_log`]; this module owns the rest and
//! is the single list ([`AppOwnedDir::ALL`]) a test walks to prove nothing is
//! left outside the portable root.
//!
//! macOS cannot move WKWebView's data folder (`data_directory` is unsupported
//! there). In portable mode the main and secondary windows therefore use a
//! non-persistent (in-memory) web data store instead, see
//! [`use_ephemeral_webview_store`]. termiHub's frontend keeps no state in web
//! storage, so nothing is lost by that.

use std::path::{Path, PathBuf};

use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};

use super::portable::AppMode;

/// Portable subdirectory for logs, session transcripts and crash reports.
pub const LOGS_SUBDIR: &str = "logs";
/// Portable subdirectory for caches (Tauri's `app_cache_dir()`).
pub const CACHE_SUBDIR: &str = "cache";
/// Subdirectory of the cache root that holds downloaded agent binaries.
pub const AGENT_BINARIES_SUBDIR: &str = "agent-binaries";
/// Portable subdirectory for the web view's data (Tauri's
/// `app_local_data_dir()`, which Windows and Linux use as the webview data dir).
pub const WEBVIEW_SUBDIR: &str = "webview";
/// Portable subdirectory for temporary and staging files.
pub const TEMP_SUBDIR: &str = "tmp";

/// One directory termiHub writes to on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppOwnedDir {
    /// Config files (connections, settings, workspaces, credentials).
    Config,
    /// Log file, session transcripts and crash reports.
    Logs,
    /// Tauri's app cache dir: plugin downloads/updates, drag-out staging.
    Cache,
    /// Downloaded remote-agent binaries.
    AgentBinaryCache,
    /// WebView2 / WebKitGTK user data folder.
    WebviewData,
    /// Temporary and staging files (VS Code edit copies, X server cookies,
    /// RDP clipboard files).
    Temp,
}

impl AppOwnedDir {
    /// Every app-owned location. A new write location must be added here so
    /// the portable-root test covers it.
    pub const ALL: [AppOwnedDir; 6] = [
        AppOwnedDir::Config,
        AppOwnedDir::Logs,
        AppOwnedDir::Cache,
        AppOwnedDir::AgentBinaryCache,
        AppOwnedDir::WebviewData,
        AppOwnedDir::Temp,
    ];

    /// Where this location lives inside the portable `data/` directory.
    pub fn portable_path(self, data_dir: &Path) -> PathBuf {
        match self {
            AppOwnedDir::Config => data_dir.to_path_buf(),
            AppOwnedDir::Logs => data_dir.join(LOGS_SUBDIR),
            AppOwnedDir::Cache => data_dir.join(CACHE_SUBDIR),
            AppOwnedDir::AgentBinaryCache => {
                data_dir.join(CACHE_SUBDIR).join(AGENT_BINARIES_SUBDIR)
            }
            AppOwnedDir::WebviewData => data_dir.join(WEBVIEW_SUBDIR),
            AppOwnedDir::Temp => data_dir.join(TEMP_SUBDIR),
        }
    }
}

/// The `app > appDirectoriesOverride` Tauri config for `mode`.
///
/// Portable mode points Tauri's cache, log and local-data directories into the
/// portable `data/` directory. That moves everything that resolves through
/// `app_cache_dir()` (plugin downloads/updates, drag-out staging) and the
/// webview data folder on Windows and Linux, which Tauri takes from
/// `app_local_data_dir()`. The config and data directories are left alone:
/// startup resolves the config directory itself (`ConfigDirOverride`), with
/// its own fallbacks. Installed mode returns `None` (platform defaults).
pub fn directories_override(mode: &AppMode) -> Option<AppDirectoriesOverride> {
    let data_dir = mode.data_dir()?;
    Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
        config: None,
        data: None,
        local_data: Some(AppOwnedDir::WebviewData.portable_path(data_dir)),
        cache: Some(AppOwnedDir::Cache.portable_path(data_dir)),
        log: Some(AppOwnedDir::Logs.portable_path(data_dir)),
    }))
}

/// Whether the web views must use a non-persistent (in-memory) data store.
///
/// True only for portable mode on macOS: WKWebView ignores `data_directory`
/// and would otherwise write into `~/Library/WebKit/<bundle-id>`.
pub fn use_ephemeral_webview_store(mode: &AppMode) -> bool {
    ephemeral_webview_store_for(mode, cfg!(target_os = "macos"))
}

/// Pure core of [`use_ephemeral_webview_store`], taking the platform
/// explicitly so both platforms' answers are testable on any host.
fn ephemeral_webview_store_for(mode: &AppMode, is_macos: bool) -> bool {
    is_macos && mode.is_portable()
}

/// The agent binary cache directory for `mode`.
///
/// Portable: `data/cache/agent-binaries/`. Installed: unchanged from before,
/// `<os cache>/termihub/agent-binaries/` (`os_cache` is `dirs::cache_dir()`;
/// `/tmp` when it cannot be resolved).
pub fn agent_binary_cache_dir(mode: &AppMode, os_cache: Option<PathBuf>) -> PathBuf {
    match mode.data_dir() {
        Some(data_dir) => AppOwnedDir::AgentBinaryCache.portable_path(data_dir),
        None => os_cache
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("termihub")
            .join(AGENT_BINARIES_SUBDIR),
    }
}

/// The portable temp directory, or `None` in installed mode (where the OS temp
/// directory is used and never cleaned by termiHub).
pub fn portable_temp_dir(mode: &AppMode) -> Option<PathBuf> {
    mode.data_dir()
        .map(|data_dir| AppOwnedDir::Temp.portable_path(data_dir))
}

/// Route termiHub's temp/staging files for `mode` (call once at boot).
///
/// In portable mode this empties `data/tmp/` (left-overs of a run that did not
/// exit cleanly; the data-dir lock guarantees no other process uses it) and
/// publishes it to core's [`termihub_core::config::app_temp_dir`]. A no-op in
/// installed mode.
pub fn publish_app_temp_dir(mode: &AppMode) {
    if let Some(data_dir) = mode.data_dir() {
        for dir in AppOwnedDir::ALL {
            tracing::debug!(kind = ?dir, path = %dir.portable_path(data_dir).display(), "Portable app dir");
        }
    }
    if let Some(dir) = portable_temp_dir(mode) {
        purge_dir(&dir);
        termihub_core::config::set_app_temp_dir(dir);
    }
}

/// Empty the portable temp directory at exit. A no-op in installed mode.
pub fn clean_app_temp_dir(mode: &AppMode) {
    if let Some(dir) = portable_temp_dir(mode) {
        purge_dir(&dir);
    }
}

/// Remove `dir` and everything below it, best effort: a file still held open
/// (e.g. by a running VS Code on Windows) is left for the next start.
fn purge_dir(dir: &Path) {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => tracing::debug!(dir = %dir.display(), "Emptied portable temp directory"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!(dir = %dir.display(), "Could not empty portable temp directory: {e}")
        }
    }
}

#[cfg(test)]
#[path = "app_dirs_tests.rs"]
mod tests;
