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

use serde::Serialize;
use serde_json::{Map, Value};
use termihub_core::plugin::{
    InstalledPlugin, PluginManager, PluginManifest, TrustAssessment, TrustLevel, TrustedPublisher,
};

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

/// The trust state of a package, flattened for the install dialog's provenance
/// banner. Built from a core [`TrustAssessment`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrustInfo {
    /// `"untrusted"` | `"signed"` | `"verified"` | `"tampered"`.
    pub level: String,
    /// User-facing warning (empty for a verified publisher).
    pub warning: String,
    /// The signing key's `sha256:` fingerprint for a signed/verified package.
    pub key_id: Option<String>,
    /// The trusted publisher's label (verified only).
    pub publisher: Option<String>,
    /// Base64 of the signing public key (signed/verified) — carried so the UI can
    /// round-trip it back on a trust-on-first-use pin without re-reading the file.
    pub public_key: Option<String>,
    /// Whether the dialog must surface a trust affordance (risk ack for unsigned,
    /// trust-on-first-use for signed).
    pub requires_acceptance: bool,
    /// Whether installation is hard-blocked (tampered) with no override.
    pub is_blocked: bool,
}

impl From<TrustAssessment> for PluginTrustInfo {
    fn from(a: TrustAssessment) -> Self {
        let (level, publisher) = match &a.level {
            TrustLevel::Untrusted => ("untrusted", None),
            TrustLevel::Tampered => ("tampered", None),
            TrustLevel::Signed { .. } => ("signed", None),
            TrustLevel::Verified { publisher } => ("verified", Some(publisher.clone())),
        };
        PluginTrustInfo {
            level: level.to_owned(),
            warning: a.warning.clone(),
            key_id: a.key_id.clone(),
            publisher,
            public_key: a.public_key.clone(),
            requires_acceptance: a.requires_acceptance(),
            is_blocked: a.is_blocked(),
        }
    }
}

/// Assess the trust of a `.termihub-plugin` package (open it, verify its
/// signature, consult the trust store) so the install dialog can render the
/// right provenance banner before the user commits.
#[tauri::command]
pub fn assess_plugin_trust(
    path: String,
    manager: State<'_, PluginManager>,
) -> Result<PluginTrustInfo, String> {
    Ok(manager.assess_trust(std::path::Path::new(&path)).into())
}

/// Install a plugin from the `.termihub-plugin` package at `path`. Emits
/// [`EVENT_PLUGINS_CHANGED`] on success.
///
/// The install is gated on the package's assessed trust (see
/// [`assess_plugin_trust`]): a tampered signature is hard-blocked; an unsigned
/// package requires `accept_untrusted`; a signed-but-unknown package installs and
/// pins the key when `trust_publisher` is set (trust-on-first-use); a verified
/// publisher installs with no risk gate.
#[tauri::command]
pub fn install_plugin(
    path: String,
    accept_untrusted: bool,
    trust_publisher: bool,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, String> {
    let installed = manager
        .install(
            std::path::Path::new(&path),
            accept_untrusted,
            trust_publisher,
        )
        .map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(installed)
}

/// List every trusted publisher key (bundled and user-pinned) for the Trusted
/// Publishers settings group.
#[tauri::command]
pub fn list_trusted_publishers(
    manager: State<'_, PluginManager>,
) -> Result<Vec<TrustedPublisher>, String> {
    manager.trusted_publishers().map_err(|e| e.to_string())
}

/// Revoke (remove) a user-pinned publisher key by its `keyId`. Bundled keys
/// cannot be revoked. Emits [`EVENT_PLUGINS_CHANGED`] so any open provenance
/// banner re-assesses.
#[tauri::command]
pub fn revoke_trusted_publisher(
    key_id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<(), String> {
    manager
        .revoke_publisher(&key_id)
        .map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(())
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
