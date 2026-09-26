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
    native_library_hash, InstallOptions, InstalledPlugin, NativeTrustStore, PluginHost,
    PluginManager, PluginManagerError, PluginManifest, SignerChange, TrustAssessment, TrustLevel,
    TrustedPublisher, VersionChange, NATIVE_TRUST_DISCLOSURE,
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

/// The result of [`install_plugin`]: either the plugin was installed, or the
/// install would replace the installed copy with an older / different /
/// uncomparable version and needs the user's explicit confirmation first
/// (PLG-012). Serialized with a `status` tag so the frontend can switch on it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallPluginResult {
    /// The plugin was installed.
    Installed {
        /// The installed plugin record (boxed: it dwarfs the other variant).
        plugin: Box<InstalledPlugin>,
    },
    /// Nothing was changed; re-issue the install with `confirm_version_change`
    /// once the user has confirmed replacing `installed_version` with
    /// `incoming_version`.
    ConfirmationRequired {
        /// Both versions and the kind of change, for the confirm dialog.
        change: VersionChange,
    },
    /// Nothing was changed: the package is signed by a different key than the
    /// installed copy, is unsigned where the installed copy was signed, or the
    /// installed copy's signer is unknown (#3489). Re-issue the install with
    /// `confirm_signer_change` — and, when `version` is present, also
    /// `confirm_version_change` — once the user has explicitly agreed.
    SignerConfirmationRequired {
        /// Both signer fingerprints and the kind of change.
        signer: SignerChange,
        /// A version change for the same install that also still needs
        /// confirmation, so both can be asked in one prompt.
        version: Option<VersionChange>,
    },
}

/// Map the manager's install result onto the command result: an unconfirmed
/// version change becomes a typed [`InstallPluginResult::ConfirmationRequired`]
/// rather than an error string; every other error stays an error.
fn install_outcome(
    result: Result<InstalledPlugin, PluginManagerError>,
) -> Result<InstallPluginResult, String> {
    match result {
        Ok(plugin) => Ok(InstallPluginResult::Installed {
            plugin: Box::new(plugin),
        }),
        Err(PluginManagerError::VersionChangeUnconfirmed(change)) => {
            Ok(InstallPluginResult::ConfirmationRequired { change: *change })
        }
        Err(PluginManagerError::SignerChangeUnconfirmed { signer, version }) => {
            Ok(InstallPluginResult::SignerConfirmationRequired {
                signer: *signer,
                version: version.map(|v| *v),
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Install a plugin from the `.termihub-plugin` package at `path`. Emits
/// [`EVENT_PLUGINS_CHANGED`] on success.
///
/// The install is gated on the package's assessed trust (see
/// [`assess_plugin_trust`]): a tampered signature is hard-blocked; an unsigned
/// package requires `accept_untrusted`; a signed-but-unknown package installs and
/// pins the key when `trust_publisher` is set (trust-on-first-use); a verified
/// publisher installs with no risk gate.
///
/// It is also version-gated (PLG-012): replacing an installed plugin with an
/// older version, a different build of the same version, or an uncomparable
/// version returns [`InstallPluginResult::ConfirmationRequired`] (nothing
/// changed) unless `confirm_version_change` is `true`.
///
/// And it is signer-gated (#3489): replacing a plugin signed by one key with a
/// package signed by another, or with an unsigned package, returns
/// [`InstallPluginResult::SignerConfirmationRequired`] (nothing changed) unless
/// `confirm_signer_change` is `true`.
#[tauri::command]
pub fn install_plugin(
    path: String,
    accept_untrusted: bool,
    trust_publisher: bool,
    confirm_version_change: Option<bool>,
    confirm_signer_change: Option<bool>,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstallPluginResult, String> {
    let result = install_outcome(manager.install_with(
        std::path::Path::new(&path),
        InstallOptions {
            accept_untrusted,
            trust_publisher,
            confirm_version_change: confirm_version_change.unwrap_or(false),
            confirm_signer_change: confirm_signer_change.unwrap_or(false),
        },
    ))?;
    if matches!(result, InstallPluginResult::Installed { .. }) {
        emit_changed(&app);
    }
    Ok(result)
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

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::plugin::{SignerChangeKind, VersionChangeKind};

    fn downgrade() -> VersionChange {
        VersionChange {
            plugin_id: "acme-tool".into(),
            plugin_name: "Acme Tool".into(),
            installed_version: Some("1.4.0".into()),
            incoming_version: "1.2.0".into(),
            kind: VersionChangeKind::Downgrade,
        }
    }

    #[test]
    fn unconfirmed_version_change_is_a_typed_result_not_an_error() {
        let result = install_outcome(Err(PluginManagerError::VersionChangeUnconfirmed(Box::new(
            downgrade(),
        ))))
        .unwrap();
        let InstallPluginResult::ConfirmationRequired { change } = &result else {
            panic!("expected ConfirmationRequired, got {result:?}");
        };
        assert_eq!(change, &downgrade());

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["status"], "confirmationRequired");
        assert_eq!(json["change"]["installedVersion"], "1.4.0");
        assert_eq!(json["change"]["incomingVersion"], "1.2.0");
        assert_eq!(json["change"]["kind"], "downgrade");
        assert_eq!(json["change"]["pluginName"], "Acme Tool");
    }

    #[test]
    fn other_install_errors_stay_errors() {
        let err = install_outcome(Err(PluginManagerError::UntrustedSourceNotAccepted)).unwrap_err();
        assert!(err.contains("untrusted"), "{err}");
    }

    #[test]
    fn install_then_downgrade_round_trips_through_the_command_mapping() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mgr = PluginManager::new(tmp.path().join("plugins"));
        let make = |version: &str| {
            let src = tmp.path().join(format!("src-{version}"));
            std::fs::create_dir_all(src.join("themes")).unwrap();
            std::fs::write(src.join("themes/dark.json"), "{}").unwrap();
            let manifest = serde_json::json!({
                "id": "acme-tool", "name": "Acme Tool", "version": version,
                "author": "t", "description": "d", "license": "MIT", "apiVersion": "1.0",
                "platforms": ["linux", "macos", "windows"], "permissions": [],
                "extensions": { "theme": { "themes": [
                    { "id": "dark", "name": "Dark", "file": "themes/dark.json" }
                ] } }
            });
            std::fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
            let out = tmp.path().join(format!("out-{version}"));
            std::fs::create_dir_all(&out).unwrap();
            termihub_core::plugin::pack_plugin(&src, &out).unwrap()
        };
        let opts = |confirm| InstallOptions {
            accept_untrusted: true,
            trust_publisher: false,
            confirm_version_change: confirm,
            confirm_signer_change: false,
        };

        let first = install_outcome(mgr.install_with(&make("1.4.0"), opts(false))).unwrap();
        assert!(matches!(first, InstallPluginResult::Installed { .. }));

        let older = make("1.2.0");
        let refused = install_outcome(mgr.install_with(&older, opts(false))).unwrap();
        assert!(matches!(
            refused,
            InstallPluginResult::ConfirmationRequired { .. }
        ));
        assert_eq!(mgr.get("acme-tool").unwrap().manifest.version, "1.4.0");

        let confirmed = install_outcome(mgr.install_with(&older, opts(true))).unwrap();
        assert!(matches!(confirmed, InstallPluginResult::Installed { .. }));
        assert_eq!(mgr.get("acme-tool").unwrap().manifest.version, "1.2.0");
    }

    fn key_changed() -> SignerChange {
        SignerChange {
            plugin_id: "acme-tool".into(),
            plugin_name: "Acme Tool".into(),
            installed_key_id: Some("sha256:aaaa".into()),
            incoming_key_id: Some("sha256:bbbb".into()),
            kind: SignerChangeKind::KeyChanged,
        }
    }

    #[test]
    fn unconfirmed_signer_change_is_a_typed_result_carrying_both_changes() {
        let result = install_outcome(Err(PluginManagerError::SignerChangeUnconfirmed {
            signer: Box::new(key_changed()),
            version: Some(Box::new(downgrade())),
        }))
        .unwrap();
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["status"], "signerConfirmationRequired");
        assert_eq!(json["signer"]["kind"], "keyChanged");
        assert_eq!(json["signer"]["installedKeyId"], "sha256:aaaa");
        assert_eq!(json["signer"]["incomingKeyId"], "sha256:bbbb");
        assert_eq!(json["version"]["kind"], "downgrade");

        let signer_only = install_outcome(Err(PluginManagerError::SignerChangeUnconfirmed {
            signer: Box::new(key_changed()),
            version: None,
        }))
        .unwrap();
        let json = serde_json::to_value(&signer_only).unwrap();
        assert!(json["version"].is_null());
    }

    #[test]
    fn signed_then_different_key_round_trips_through_the_command_mapping() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mgr = PluginManager::new(tmp.path().join("plugins"));
        let make = |version: &str, key: &termihub_core::plugin::SigningKeyFile| {
            let src = tmp.path().join(format!("src-{version}"));
            std::fs::create_dir_all(src.join("themes")).unwrap();
            std::fs::write(src.join("themes/dark.json"), "{}").unwrap();
            let manifest = serde_json::json!({
                "id": "acme-tool", "name": "Acme Tool", "version": version,
                "author": "t", "description": "d", "license": "MIT", "apiVersion": "1.0",
                "platforms": ["linux", "macos", "windows"], "permissions": [],
                "extensions": { "theme": { "themes": [
                    { "id": "dark", "name": "Dark", "file": "themes/dark.json" }
                ] } }
            });
            std::fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
            let out = tmp.path().join(format!("out-{version}"));
            std::fs::create_dir_all(&out).unwrap();
            let pkg = termihub_core::plugin::pack_plugin(&src, &out).unwrap();
            termihub_core::plugin::sign_package(&pkg, key).unwrap();
            pkg
        };
        let key_a = termihub_core::plugin::generate_keypair("A");
        let key_b = termihub_core::plugin::generate_keypair("B");
        let opts = |confirm_signer| InstallOptions {
            accept_untrusted: false,
            trust_publisher: false,
            confirm_version_change: false,
            confirm_signer_change: confirm_signer,
        };

        let first = install_outcome(mgr.install_with(&make("1.0.0", &key_a), opts(false)));
        assert!(matches!(first, Ok(InstallPluginResult::Installed { .. })));

        let other = make("1.1.0", &key_b);
        let refused = install_outcome(mgr.install_with(&other, opts(false))).unwrap();
        let InstallPluginResult::SignerConfirmationRequired { signer, version } = &refused else {
            panic!("expected SignerConfirmationRequired, got {refused:?}");
        };
        assert_eq!(signer.kind, SignerChangeKind::KeyChanged);
        assert_eq!(
            signer.installed_key_id.as_deref(),
            Some(key_a.key_id.as_str())
        );
        assert!(version.is_none());
        assert_eq!(mgr.get("acme-tool").unwrap().manifest.version, "1.0.0");

        let confirmed = install_outcome(mgr.install_with(&other, opts(true))).unwrap();
        assert!(matches!(confirmed, InstallPluginResult::Installed { .. }));
        assert_eq!(mgr.get("acme-tool").unwrap().manifest.version, "1.1.0");
    }
}
