//! Tauri commands for the plugin **management layer** (#1992).
//!
//! Thin wrappers over [`termihub_core::plugin::PluginManager`]: they expose
//! install / uninstall / enable / disable / scan and the settings + file-read
//! helpers to the frontend, and emit a [`EVENT_PLUGINS_CHANGED`] event whenever
//! the installed-plugin set or a plugin's state changes so the UI can refresh.
//!
//! This is deliberately the *command surface only* — no code loading. Actual
//! loading of themes / JS / native backends is delegated to later issues through
//! the manager's `PluginLifecycleHook` seam. The [`PluginManager`] itself is
//! created once at startup and shared as managed state.

use tauri::{AppHandle, Emitter, State};

use serde_json::{Map, Value};
use termihub_core::plugin::{InstalledPlugin, PluginManager, PluginManifest};

/// Event emitted whenever the installed-plugin set or a plugin's state changes.
/// The frontend re-fetches [`list_plugins`] on receipt.
pub const EVENT_PLUGINS_CHANGED: &str = "plugin-changed";

/// Emit the plugin-changed event, ignoring transport errors (a missing window
/// listener must never fail the command).
fn emit_changed(app: &AppHandle) {
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
}

/// List every installed plugin with its current state.
#[tauri::command]
pub fn list_plugins(manager: State<'_, PluginManager>) -> Result<Vec<InstalledPlugin>, String> {
    manager.list().map_err(|e| e.to_string())
}

/// Validate a `.termihub-plugin` package at `path` without installing it,
/// returning its trusted manifest (which carries the declared permissions the
/// UI shows in the install prompt). An incompatible or malformed package is an
/// error.
#[tauri::command]
pub fn validate_plugin(
    path: String,
    manager: State<'_, PluginManager>,
) -> Result<PluginManifest, String> {
    manager
        .validate(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

/// Install a plugin from the `.termihub-plugin` package at `path`. Emits
/// [`EVENT_PLUGINS_CHANGED`] on success.
///
/// Every package is from an unverified source (termiHub has no plugin-signing
/// substrate), so the install dialog shows an untrusted-source warning and the
/// user's confirmation is passed as `accept_untrusted`. Without it the manager
/// refuses the install before extracting anything.
#[tauri::command]
pub fn install_plugin(
    path: String,
    accept_untrusted: bool,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, String> {
    let installed = manager
        .install(std::path::Path::new(&path), accept_untrusted)
        .map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(installed)
}

/// Uninstall the plugin with the given id. Emits [`EVENT_PLUGINS_CHANGED`].
#[tauri::command]
pub fn uninstall_plugin(
    id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<(), String> {
    manager.uninstall(&id).map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(())
}

/// Enable the plugin with the given id, persisting the flag. Emits
/// [`EVENT_PLUGINS_CHANGED`].
#[tauri::command]
pub fn enable_plugin(
    id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, String> {
    let plugin = manager.enable(&id).map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(plugin)
}

/// Disable the plugin with the given id, persisting the flag. Emits
/// [`EVENT_PLUGINS_CHANGED`].
#[tauri::command]
pub fn disable_plugin(
    id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, String> {
    let plugin = manager.disable(&id).map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(plugin)
}

/// Return a plugin's stored settings as a JSON object (empty when unset).
#[tauri::command]
pub fn get_plugin_settings(
    id: String,
    manager: State<'_, PluginManager>,
) -> Result<Map<String, Value>, String> {
    manager.get_settings(&id).map_err(|e| e.to_string())
}

/// Replace a plugin's stored settings with `settings`.
#[tauri::command]
pub fn update_plugin_settings(
    id: String,
    settings: Map<String, Value>,
    manager: State<'_, PluginManager>,
) -> Result<(), String> {
    manager
        .update_settings(&id, settings)
        .map_err(|e| e.to_string())
}

/// Read a file from inside an installed plugin's directory (theme JSON, JS
/// entry point, …). `path` is relative to `plugins/<id>/`; traversal is
/// refused. Returns the raw bytes; text consumers decode as UTF-8.
#[tauri::command]
pub fn read_plugin_file(
    id: String,
    path: String,
    manager: State<'_, PluginManager>,
) -> Result<Vec<u8>, String> {
    manager.read_file(&id, &path).map_err(|e| e.to_string())
}
