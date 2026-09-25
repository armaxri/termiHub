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

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use serde::Serialize;
use serde_json::{Map, Value};
use termihub_core::plugin::{
    native_library_hash, InstalledPlugin, NativeTrustStore, PluginHost, PluginManager,
    PluginManifest, TrustAssessment, TrustLevel, TrustedPublisher, NATIVE_TRUST_DISCLOSURE,
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

/// One recorded native-plugin trust acknowledgment, flattened for the settings
/// surface. Mirrors core `NativeAck` plus the plugin id it keys.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAckInfo {
    /// The plugin id this acknowledgment is for.
    pub id: String,
    /// SHA-256 (hex) of the backend library the acknowledgment is bound to.
    pub library_sha256: String,
    /// RFC 3339-ish timestamp the acknowledgment was recorded.
    pub acknowledged_at: String,
}

/// The native-plugin trust state for the Settings surface (SEC-002 / PLG-006 /
/// ARCH-008): the global default-off switch, the informed-consent disclosure to
/// show, and the per-plugin acknowledgments recorded so far.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePluginTrust {
    /// Whether native (in-process) plugins are enabled globally. `false` by
    /// default and whenever the store cannot be read (fail closed).
    pub enabled: bool,
    /// The plain-language disclosure the UI must show before enabling/trusting a
    /// native plugin (in-process, full privileges, no OS sandbox).
    pub disclosure: String,
    /// Every recorded per-plugin acknowledgment, sorted by plugin id.
    pub acknowledged: Vec<NativeAckInfo>,
}

/// Return the native-plugin trust state: the global switch, the disclosure, and
/// the recorded per-plugin acknowledgments.
#[tauri::command]
pub fn get_native_plugin_trust(manager: State<'_, PluginManager>) -> NativePluginTrust {
    let store = NativeTrustStore::load(manager.root());
    let acknowledged = store
        .acknowledgments()
        .into_iter()
        .map(|(id, ack)| NativeAckInfo {
            id,
            library_sha256: ack.library_sha256,
            acknowledged_at: ack.acknowledged_at,
        })
        .collect();
    NativePluginTrust {
        enabled: store.is_native_enabled(),
        disclosure: NATIVE_TRUST_DISCLOSURE.to_owned(),
        acknowledged,
    }
}

/// Turn the global native-plugin switch on or off.
///
/// Persists the flag, then re-drives the enabled plugins through the load path so
/// the change takes effect **live**: enabling loads every acknowledged native
/// plugin; disabling tears every native plugin back down (each is unloaded and
/// then refused by the gate). Emits [`EVENT_PLUGINS_CHANGED`].
#[tauri::command]
pub fn set_native_plugins_enabled(
    enabled: bool,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<(), String> {
    let mut store = NativeTrustStore::load(manager.root());
    store
        .set_native_enabled(enabled)
        .map_err(|e| e.to_string())?;
    // Re-evaluate every enabled plugin against the new global state. A native
    // plugin that is now disabled is unloaded; a newly-permitted one loads.
    let _ = manager.load_enabled_plugins().map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(())
}

/// Acknowledge trust for the native plugin `id`, binding the acknowledgment to the
/// exact backend library currently on disk, then load it.
///
/// Fails when the plugin has no backend library (not a native plugin) or its
/// library cannot be read. After recording the acknowledgment it re-runs the
/// enable/load path so the now-trusted plugin activates, and returns the refreshed
/// [`InstalledPlugin`]. Emits [`EVENT_PLUGINS_CHANGED`].
#[tauri::command]
pub fn acknowledge_native_plugin(
    id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, String> {
    // Bind consent to the exact library bytes on disk.
    let hash = native_library_hash(manager.root(), &id).map_err(|e| e.to_string())?;
    let mut store = NativeTrustStore::load(manager.root());
    store.acknowledge(&id, hash).map_err(|e| e.to_string())?;
    // Drive the load path now that the plugin is trusted (re-runs on_enable →
    // host.load, which now passes the gate).
    let plugin = manager.enable(&id).map_err(|e| e.to_string())?;
    emit_changed(&app);
    Ok(plugin)
}

/// Revoke the trust acknowledgment for the native plugin `id` and unload it
/// immediately, so its in-process code stops at once. The plugin stays installed;
/// it will not load again until re-acknowledged. Emits [`EVENT_PLUGINS_CHANGED`].
#[tauri::command]
pub fn revoke_native_plugin_trust(
    id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
    host: State<'_, Arc<PluginHost>>,
) -> Result<(), String> {
    let mut store = NativeTrustStore::load(manager.root());
    store.revoke(&id).map_err(|e| e.to_string())?;
    // Tear down any live instance so revoked trust stops the code immediately.
    host.unload(&id);
    emit_changed(&app);
    Ok(())
}

/// Read a file from inside an installed plugin's directory (theme JSON, JS
/// entry point, …). `path` is relative to `plugins/<id>/`; traversal is
/// refused.
///
/// Returns the file bytes base64-encoded (standard alphabet, padded) rather than
/// serde's default JSON number-array for `Vec<u8>` (~4x wire bloat plus a
/// per-byte JS array allocation); the frontend decodes them in
/// `src/services/api.ts`. Byte-for-byte faithful; empty input → empty string
/// (PERF-002).
#[tauri::command]
pub fn read_plugin_file(
    id: String,
    path: String,
    manager: State<'_, PluginManager>,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = manager.read_file(&id, &path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
