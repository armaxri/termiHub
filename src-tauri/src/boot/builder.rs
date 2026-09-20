//! Tauri builder assembly (ARCH-002 / TAURI-009, Slice C).
//!
//! The `tauri::Builder::default().plugin(..).manage(..)` prelude that used to sit
//! inline in [`crate::run`], extracted verbatim into [`build`]. It registers the
//! app-lifetime plugins and the eagerly-constructed managed state, conditionally
//! adds the single-instance plugin (release, non-portable only) and the
//! test-bridge plugin (test-bridge builds only), and installs the plugin
//! URI-scheme protocol. It stops before the terminal `.setup(..).invoke_handler(..)
//! .build(..).run(..)` chain, which stays in `run()` verbatim.
//!
//! `NetworkManager` is deliberately **not** managed here: it needs the resolved
//! config dir + `AppHandle` and is constructed fully-initialised inside `setup()`
//! (TAURI-001 / ARCH-011), like every other late-bound manager.

use std::sync::Arc;

use crate::terminal::xserver::{ConnectConsentRegistry, XServerManager};
use crate::utils::file_log::{self, FileLogReloadHandle};
use crate::utils::log_capture::SharedLogBuffer;
use crate::{app_tasks, commands, files, plugin_protocol, spawn, window};
use crate::{files::transfer::TransferRegistry, terminal::agent_cancel::AgentDeployCancellation};

/// Assemble the Tauri builder up to (but not including) the terminal
/// `.setup(..).invoke_handler(..).build(..).run(..)` chain, taking the
/// already-constructed managed values `run()` produced.
///
/// This is a pure statement move: every `.manage()` type is registered exactly
/// once with the same set as before, the single-instance plugin stays
/// `#[cfg(not(debug_assertions))]` + portable-gated, the test-bridge plugin stays
/// `#[cfg(feature = "test-bridge")]`, and the plugin URI-scheme protocol is
/// registered unchanged.
pub(crate) fn build(
    x_server_manager: &Arc<XServerManager>,
    x_server_consent_registry: &Arc<ConnectConsentRegistry>,
    log_buffer: SharedLogBuffer,
    file_reload_handle: Option<FileLogReloadHandle>,
) -> tauri::Builder<tauri::Wry> {
    // `mut` is only needed when the test-bridge plugin is conditionally added
    // below (feature = "test-bridge"); release builds never reassign `builder`.
    #[cfg_attr(not(feature = "test-bridge"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_cli::init())
        // Owned background-task registry (ARCH-007): app-lifetime spawn sites
        // register here so teardown can cancel + await them deterministically.
        .manage(app_tasks::AppTasks::new())
        .manage(TransferRegistry::new())
        .manage(files::watcher::FileWatchManager::new())
        // NetworkManager needs the resolved config dir + AppHandle, neither of
        // which exists here. It is therefore constructed fully-initialised inside
        // `setup()` (below) and `manage`d there, like every other late-bound
        // manager — avoiding a register-then-mutate step (TAURI-001 / ARCH-011).
        .manage(x_server_manager.clone())
        .manage(x_server_consent_registry.clone())
        .manage(spawn::handler::PendingSpawn::default())
        .manage(window::WindowManager::new())
        .manage(commands::connection_path::ProbeRegistry::default())
        .manage(commands::local_process::LocalProcessRegistry::default())
        // Stateless-UI projection substrate (#2149) + tunnel pilot (#2150): the
        // projector + intent dispatcher are constructed in `setup` (below), once
        // the tunnel manager exists to seed the `tunnels` region and serve the
        // `tunnel.*` intents. Wired beside the existing typed commands (strangler).
        .manage(AgentDeployCancellation::default())
        .manage(log_buffer)
        // Live file-log verbosity control (OBS-009): the reload handle captured
        // when the subscriber was built, or `None` if the log file could not be
        // opened this run.
        .manage(file_log::FileLogReload(file_reload_handle))
        // App-controlled origin for installed plugin files (#2251): serves
        // `<app-data>/plugins/<id>/<path>` over `plugin://localhost/<id>/<path>`
        // (macOS/Linux) / `http://plugin.localhost/...` (Windows), plus the wrapped
        // `/load/<id>/<path>` entry-point mode the sandbox worker `importScripts`.
        // This is what lets frontend plugin code load without a `blob:` `script-src`
        // allowance (#2266). Fails closed on any bad request (see `plugin_protocol`).
        .register_uri_scheme_protocol(plugin_protocol::PLUGIN_URI_SCHEME, plugin_protocol::handle);

    // Single-instance enforcement (per user) — findings PER-005 / SM-025.
    // A second launch of the app focuses the already-running window and exits,
    // so two copies can never clobber each other's shared config / last-session
    // files (neither store takes a cross-process lock; `last_session` is
    // last-writer-wins). Compiled out of debug builds entirely
    // (`#[cfg(not(debug_assertions))]`) so the parallel dev-checkout workflow can
    // keep running many debug copies at once — `scripts/dev.sh` produces a debug
    // build. Even in a release build it is skipped in portable mode: two portable
    // copies in different folders use different `data/` dirs and legitimately do
    // not clobber, so a bundle-id-keyed global lock would wrongly block them.
    #[cfg(not(debug_assertions))]
    {
        let app_mode = crate::utils::portable::detect_app_mode().unwrap_or_else(|e| {
            tracing::warn!("single-instance: app-mode detection failed, assuming installed: {e}");
            crate::utils::portable::AppMode::Installed
        });
        if crate::utils::single_instance::should_enforce_single_instance(
            &app_mode,
            cfg!(debug_assertions),
        ) {
            builder = builder.plugin(tauri_plugin_single_instance::init(
                crate::utils::single_instance::on_second_instance,
            ));
        }
    }

    // In test mode (TERMIHUB_TEST_BRIDGE_PORT set), inject the bridge globals into
    // the webview before boot so the in-app WebSocket client connects out to the
    // runner — the cross-platform test transport (issue #801). Test-bridge-only
    // (SEC-005): the whole block is compiled out of release builds.
    #[cfg(feature = "test-bridge")]
    if let Some(plugin) = crate::utils::test_bridge::test_bridge_plugin() {
        tracing::info!("Test bridge WebSocket transport enabled");
        builder = builder.plugin(plugin);
    }

    builder
}
