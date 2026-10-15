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
    check_host_platform, host_target_triple, native_trust_binding,
    native_trust_binding_with_snapshot, resolve_filesystem_paths_for_host, validate_package,
    AckAcceptances, AckStatus, InstallOptions, InstalledPlugin, NativeAck, NativeTrustSnapshot,
    NativeTrustStore, PluginAccessDiff, PluginHost, PluginManager, PluginManagerError,
    PluginManifest, ResolvedFilesystemPath, SignerChange, TrustAssessment, TrustBinding,
    TrustLevel, TrustedPublisher, VersionChange, NATIVE_TRUST_DISCLOSURE,
};

/// Event emitted whenever the installed-plugin set or a plugin's state changes.
/// The frontend re-fetches [`list_plugins`] on receipt.
pub const EVENT_PLUGINS_CHANGED: &str = "plugin-changed";

/// Emit the plugin-changed event, ignoring transport errors (a missing window
/// listener must never fail the command).
fn emit_changed(app: &AppHandle) {
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
    // Reflect a trust / enable / revoke at once in the sandbox status (#4188)
    // rather than on the publisher's next tick.
    crate::plugin_sandbox_projection::publish(app);
}

/// List every installed plugin with its current state.
#[tauri::command]
pub fn list_plugins(manager: State<'_, PluginManager>) -> Result<Vec<InstalledPlugin>, String> {
    manager.list().map_err(|e| e.to_string())
}

/// A package's install preview (#3507): its trusted manifest plus whether it
/// ships a native library for this computer's platform (PLG-011).
///
/// Unlike [`validate_plugin`], a multi-platform package that lacks this host's
/// target triple is **not** an error here: the install dialog shows it with a
/// friendly "not available for this computer" explanation and the list of
/// platforms it does support. Installing it is still refused by the manager.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PluginPackagePreview {
    /// The package's validated manifest.
    #[cfg_attr(test, ts(type = "import(\"./PluginManifest\").PluginManifest"))]
    pub manifest: PluginManifest,
    /// This host's Rust target triple (e.g. `aarch64-apple-darwin`).
    pub host_platform: String,
    /// Whether the package can be installed on this host's platform.
    pub platform_supported: bool,
    /// The manifest's `${home}`/`${config}` `filesystemPaths` entries with the
    /// folder each resolves to on this computer (#4533), so the install dialog
    /// shows the real folder next to the declared form. Omitted when none.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(
        test,
        ts(
            optional,
            type = "Array<import(\"./ResolvedFilesystemPath\").ResolvedFilesystemPath>"
        )
    )]
    pub resolved_filesystem_paths: Vec<ResolvedFilesystemPath>,
    /// The installed copy's version when a plugin with this id is already
    /// installed — an update, downgrade or re-install (#4418). Omitted for a
    /// fresh install.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub installed_version: Option<String>,
    /// What this package changes in the access the installed copy requests
    /// (#4418): permissions, resolved filesystem folders and connection policy
    /// added or removed, from the same canonical access a native trust
    /// acknowledgment binds to. Present (and possibly empty) whenever
    /// `installedVersion` is; omitted for a fresh install.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        test,
        ts(optional, type = "import(\"./PluginAccessDiff\").PluginAccessDiff")
    )]
    pub access_diff: Option<PluginAccessDiff>,
}

/// Build the [`PluginPackagePreview`] for an already-validated manifest,
/// comparing its access against `installed` (the manifest of the copy it would
/// replace) when there is one.
fn package_preview(
    manifest: PluginManifest,
    installed: Option<&PluginManifest>,
) -> PluginPackagePreview {
    let platform_supported = check_host_platform(&manifest).is_ok();
    let resolved_filesystem_paths = resolve_filesystem_paths_for_host(&manifest.filesystem_paths);
    PluginPackagePreview {
        installed_version: installed.map(|i| i.version.clone()),
        access_diff: installed.map(|i| PluginAccessDiff::between(i, &manifest)),
        manifest,
        host_platform: host_target_triple().to_owned(),
        platform_supported,
        resolved_filesystem_paths,
    }
}

/// The manifest of the installed plugin `id`, if one is installed with a
/// manifest that still validates. A plugin listed under a placeholder manifest
/// (#4392) has no access to compare against, so it reads as a fresh install.
fn installed_manifest(manager: &PluginManager, id: &str) -> Option<PluginManifest> {
    manager
        .get(id)
        .ok()
        .filter(|p| !p.invalid_manifest)
        .map(|p| p.manifest)
}

/// [`preview_plugin`] against an explicit manager.
fn preview_package(
    path: &std::path::Path,
    manager: &PluginManager,
) -> Result<PluginPackagePreview, String> {
    let manifest = validate_package(path).map_err(|e| e.to_string())?;
    let installed = installed_manifest(manager, &manifest.id);
    Ok(package_preview(manifest, installed.as_ref()))
}

/// Validate a `.termihub-plugin` package at `path` for the install dialog,
/// returning its manifest and this host's platform support (#3507). A malformed
/// or incompatible package is an error; a package merely lacking this platform
/// is not (see [`PluginPackagePreview`]).
///
/// When a plugin with the same id is installed, the preview also carries its
/// version and the access diff against it (#4418), so the dialog shows what an
/// update adds or removes.
#[tauri::command]
pub fn preview_plugin(
    path: String,
    manager: State<'_, PluginManager>,
) -> Result<PluginPackagePreview, String> {
    preview_package(std::path::Path::new(&path), &manager)
}

/// This host's Rust target triple, used by the UI to mark "this computer" in a
/// plugin's supported-platform list (#3507).
#[tauri::command]
pub fn get_plugin_host_platform() -> String {
    host_target_triple().to_owned()
}

/// The trust state of a package, flattened for the install dialog's provenance
/// banner. Built from a core [`TrustAssessment`].
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PluginTrustInfo {
    /// `"untrusted"` | `"signed"` | `"verified"` | `"tampered"`.
    #[cfg_attr(
        test,
        ts(type = "\"untrusted\" | \"signed\" | \"verified\" | \"tampered\"")
    )]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallPluginResult {
    /// The plugin was installed.
    Installed {
        /// The installed plugin record (boxed: it dwarfs the other variant).
        #[cfg_attr(test, ts(type = "import(\"./InstalledPlugin\").InstalledPlugin"))]
        plugin: Box<InstalledPlugin>,
    },
    /// Nothing was changed; re-issue the install with `confirm_version_change`
    /// once the user has confirmed replacing `installed_version` with
    /// `incoming_version`.
    ConfirmationRequired {
        /// Both versions and the kind of change, for the confirm dialog.
        #[cfg_attr(
            test,
            ts(type = "import(\"./PluginVersionChange\").PluginVersionChange")
        )]
        change: VersionChange,
    },
    /// Nothing was changed: the package is signed by a different key than the
    /// installed copy, is unsigned where the installed copy was signed, or the
    /// installed copy's signer is unknown (#3489). Re-issue the install with
    /// `confirm_signer_change` — and, when `version` is present, also
    /// `confirm_version_change` — once the user has explicitly agreed.
    SignerConfirmationRequired {
        /// Both signer fingerprints and the kind of change.
        #[cfg_attr(test, ts(type = "import(\"./PluginSignerChange\").PluginSignerChange"))]
        signer: SignerChange,
        /// A version change for the same install that also still needs
        /// confirmation, so both can be asked in one prompt.
        #[cfg_attr(
            test,
            ts(type = "import(\"./PluginVersionChange\").PluginVersionChange | null")
        )]
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

/// How a recorded native-plugin trust acknowledgment relates to the plugin as
/// it is installed now (#4294). Only `current` means the plugin may load; the
/// Settings row shows every other state as "needs re-approval", never trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum NativeAckState {
    /// Same library and exactly the approved access.
    Current,
    /// The library changed since the user trusted it.
    LibraryChanged,
    /// The manifest requests different access than the user approved.
    AccessChanged,
    /// Recorded before termiHub bound trust to the approved access.
    AccessNotRecorded,
    /// The installed plugin's library or manifest cannot be read.
    Unavailable,
}

impl From<AckStatus> for NativeAckState {
    fn from(status: AckStatus) -> Self {
        match status {
            AckStatus::Current => Self::Current,
            AckStatus::LibraryChanged => Self::LibraryChanged,
            AckStatus::AccessChanged => Self::AccessChanged,
            AckStatus::AccessNotRecorded => Self::AccessNotRecorded,
        }
    }
}

/// One recorded native-plugin trust acknowledgment, flattened for the settings
/// surface. Mirrors core `NativeAck` plus the plugin id it keys and how it
/// compares with the installed plugin.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct NativeAckInfo {
    /// The plugin id this acknowledgment is for.
    pub id: String,
    /// SHA-256 (hex) of the backend library the acknowledgment is bound to.
    pub library_sha256: String,
    /// RFC 3339-ish timestamp the acknowledgment was recorded.
    pub acknowledged_at: String,
    /// Whether the user explicitly accepted an unverifiable build toolchain
    /// (native ABI 1.0 plugins, #3576).
    pub unverified_toolchain_accepted: bool,
    /// Whether the user explicitly accepted reduced sandbox isolation on this
    /// system (`reducedIsolationAccepted`, #4188).
    pub reduced_isolation_accepted: bool,
    /// Whether the acknowledgment still covers the installed plugin (#4294).
    pub state: NativeAckState,
    /// Access the installed manifest requests that the user did not approve:
    /// permission names, folder paths, and `connection policy` when that
    /// changed. Everything requested when the approved access is unknown.
    pub added_access: Vec<String>,
}

impl NativeAckInfo {
    /// Flatten `ack` for plugin `id`, compared with the installed plugin's
    /// `binding` (an error when it cannot be read — never shown as current).
    fn new<E>(id: String, ack: NativeAck, binding: Result<TrustBinding, E>) -> Self {
        let (state, added_access) = match binding {
            Ok(binding) => (
                ack.status(&binding).into(),
                binding.access.added_since(ack.approved_access.as_ref()),
            ),
            Err(_) => (NativeAckState::Unavailable, Vec::new()),
        };
        Self {
            id,
            library_sha256: ack.library_sha256,
            acknowledged_at: ack.acknowledged_at,
            unverified_toolchain_accepted: ack.unverified_toolchain_accepted,
            reduced_isolation_accepted: ack.reduced_isolation_accepted,
            state,
            added_access,
        }
    }
}

/// The native-plugin trust state for the Settings surface (SEC-002 / PLG-006 /
/// ARCH-008): the global default-off switch, the informed-consent disclosure to
/// show, and the per-plugin acknowledgments recorded so far.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct NativePluginTrust {
    /// Whether native plugins are enabled globally. `false` by default and
    /// whenever the store cannot be read (fail closed).
    pub enabled: bool,
    /// The plain-language disclosure the UI must show before enabling/trusting a
    /// native plugin: they run in a sandboxed process (#4188, ADR-19).
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
        .map(|(id, ack)| {
            let binding = native_trust_binding(manager.root(), &id);
            NativeAckInfo::new(id, ack, binding)
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

/// Why [`acknowledge_native_plugin`] refused, as a machine-readable code
/// (#4419).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum NativeTrustAckErrorCode {
    /// The request carried no trust binding, or one in an old or malformed
    /// format. Never treated as a match.
    BindingMissing,
    /// The plugin on disk no longer matches the binding the user was shown —
    /// its library or the access it requests changed since the row rendered.
    /// The UI re-fetches and shows the current state.
    BindingChanged,
    /// Any other failure (unreadable plugin, store write, load).
    Failed,
}

/// The typed error [`acknowledge_native_plugin`] returns: the structured
/// `{ code, message }` IPC envelope (#4419).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct NativeTrustAckError {
    /// What went wrong.
    pub code: NativeTrustAckErrorCode,
    /// A human-readable explanation for the toast.
    pub message: String,
}

impl NativeTrustAckError {
    fn failed(e: impl std::fmt::Display) -> Self {
        Self {
            code: NativeTrustAckErrorCode::Failed,
            message: e.to_string(),
        }
    }
}

/// Check the binding the trust surface rendered against the plugin on disk
/// (#4419). The comparison is exact; a missing or malformed rendered binding
/// is refused, never treated as a match.
fn check_rendered_binding(
    rendered: Option<&NativeTrustSnapshot>,
    on_disk: &NativeTrustSnapshot,
) -> Result<(), NativeTrustAckError> {
    let Some(rendered) = rendered.filter(|r| r.is_well_formed()) else {
        return Err(NativeTrustAckError {
            code: NativeTrustAckErrorCode::BindingMissing,
            message: "termiHub could not tell which build of this plugin you reviewed. \
                      Review it again before trusting it."
                .to_owned(),
        });
    };
    if rendered.library_sha256 != on_disk.library_sha256 {
        return Err(NativeTrustAckError {
            code: NativeTrustAckErrorCode::BindingChanged,
            message: "This plugin's library changed since it was shown. \
                      Review the current build before trusting it."
                .to_owned(),
        });
    }
    if rendered.access_digest != on_disk.access_digest {
        return Err(NativeTrustAckError {
            code: NativeTrustAckErrorCode::BindingChanged,
            message: "The access this plugin asks for changed since it was shown. \
                      Review it again before trusting it."
                .to_owned(),
        });
    }
    Ok(())
}

/// Read plugin `id`'s binding from disk, check it against the `rendered`
/// one, and record the acknowledgment for exactly that binding (#4419).
fn record_acknowledgment(
    plugins_root: &std::path::Path,
    id: &str,
    rendered: Option<&NativeTrustSnapshot>,
    acceptances: AckAcceptances,
) -> Result<(), NativeTrustAckError> {
    // One manifest read and one library hash: the binding checked is the
    // binding recorded.
    let (binding, on_disk) = native_trust_binding_with_snapshot(plugins_root, id)
        .map_err(NativeTrustAckError::failed)?;
    check_rendered_binding(rendered, &on_disk)?;
    NativeTrustStore::load(plugins_root)
        .acknowledge_with(id, &binding, acceptances)
        .map_err(NativeTrustAckError::failed)
}

/// Acknowledge trust for the native plugin `id`, binding the acknowledgment to the
/// exact backend library and the access its installed manifest requests
/// (#4294), then load it.
///
/// `binding` is the [`NativeTrustSnapshot`] the trust surface rendered
/// (`InstalledPlugin::trust_snapshot`). The acknowledgment is recorded only
/// when the plugin on disk still produces exactly that snapshot (#4419); a
/// changed library or access is refused with
/// [`NativeTrustAckErrorCode::BindingChanged`], and a missing or old-format
/// binding with [`NativeTrustAckErrorCode::BindingMissing`], so consent never
/// binds to bytes or access the user was not shown.
///
/// Fails when the plugin has no backend library (not a native plugin) or its
/// library cannot be read. After recording the acknowledgment it re-runs the
/// enable/load path so the now-trusted plugin activates, and returns the refreshed
/// [`InstalledPlugin`]. Emits [`EVENT_PLUGINS_CHANGED`].
///
/// `accept_unverified_toolchain` records the user's explicit acceptance that the
/// plugin's build toolchain cannot be verified — only meaningful for a plugin
/// built for native ABI 1.0, which the host otherwise refuses (#3576, ADR-15).
/// Absent means `false`; the host never uses it to relax the exact toolchain
/// check of a plugin that does report its toolchain.
///
/// `accept_reduced_isolation` records the user's explicit acceptance that this
/// system cannot apply every OS sandbox layer to the plugin
/// (`reducedIsolationAccepted`, #4188). Absent means `false`: a plugin whose
/// runner reports reduced isolation then stays unloaded.
#[tauri::command]
pub fn acknowledge_native_plugin(
    id: String,
    binding: Option<NativeTrustSnapshot>,
    accept_unverified_toolchain: Option<bool>,
    accept_reduced_isolation: Option<bool>,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, NativeTrustAckError> {
    record_acknowledgment(
        manager.root(),
        &id,
        binding.as_ref(),
        AckAcceptances {
            unverified_toolchain: accept_unverified_toolchain.unwrap_or(false),
            reduced_isolation: accept_reduced_isolation.unwrap_or(false),
        },
    )?;
    // Drive the load path now that the plugin is trusted (re-runs on_enable →
    // host.load, which now passes the gate).
    let plugin = manager.enable(&id).map_err(NativeTrustAckError::failed)?;
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
    use termihub_core::plugin::{
        ApprovedAccess, PluginPermission, SignerChangeKind, VersionChangeKind,
    };

    /// A binding to library `hash` with `permissions` approved.
    fn binding(hash: &str, permissions: Vec<PluginPermission>) -> TrustBinding {
        TrustBinding {
            library_sha256: hash.into(),
            access: ApprovedAccess {
                permissions,
                ..ApprovedAccess::default()
            },
        }
    }

    fn ack_for(binding: &TrustBinding) -> NativeAck {
        NativeAck {
            library_sha256: binding.library_sha256.clone(),
            acknowledged_at: "t".into(),
            unverified_toolchain_accepted: false,
            reduced_isolation_accepted: false,
            approved_access: Some(binding.access.clone()),
        }
    }

    /// PLG2-002 (#4294): the Settings surface learns whether a recorded
    /// acknowledgment still covers the installed plugin, and what was added.
    #[test]
    fn ack_info_reports_whether_the_ack_is_current() {
        let approved = binding("h", vec![PluginPermission::Terminal]);
        let info = |installed: Result<TrustBinding, ()>, ack: NativeAck| {
            NativeAckInfo::new("p".into(), ack, installed)
        };

        let current = info(Ok(approved.clone()), ack_for(&approved));
        assert_eq!(current.state, NativeAckState::Current);
        assert!(current.added_access.is_empty());

        let rebuilt = info(
            Ok(binding("h2", vec![PluginPermission::Terminal])),
            ack_for(&approved),
        );
        assert_eq!(rebuilt.state, NativeAckState::LibraryChanged);

        let wider = info(
            Ok(binding(
                "h",
                vec![PluginPermission::Terminal, PluginPermission::Network],
            )),
            ack_for(&approved),
        );
        assert_eq!(wider.state, NativeAckState::AccessChanged);
        assert_eq!(wider.added_access, vec!["network".to_owned()]);

        let mut legacy = ack_for(&approved);
        legacy.approved_access = None;
        let legacy = info(Ok(approved.clone()), legacy);
        assert_eq!(legacy.state, NativeAckState::AccessNotRecorded);
        assert_eq!(legacy.added_access, vec!["terminal".to_owned()]);

        let gone = info(Err(()), ack_for(&approved));
        assert_eq!(gone.state, NativeAckState::Unavailable);

        let json = serde_json::to_value(&wider).unwrap();
        assert_eq!(json["state"], "accessChanged");
        assert_eq!(json["addedAccess"][0], "network");
    }

    /// Install native plugin `p` under `root` with `permissions` and library
    /// `bytes`, the way the manager lays it out.
    fn install_native(root: &std::path::Path, permissions: &str, bytes: &[u8]) {
        let dir = root.join("p");
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        let lib = format!(
            "{}p{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        );
        std::fs::write(dir.join("backend").join(lib), bytes).unwrap();
        let manifest = format!(
            r#"{{
                "id": "p", "name": "P", "version": "1.0.0", "author": "a",
                "description": "d", "license": "MIT", "apiVersion": "1.1",
                "platforms": ["linux", "macos", "windows"],
                "permissions": {permissions},
                "extensions": {{ "terminalBackend": {{
                    "connectionType": "p", "displayName": "P", "configSchema": {{}}
                }} }}
            }}"#
        );
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
    }

    /// What the Settings row renders for `p` right now.
    fn rendered(root: &std::path::Path) -> NativeTrustSnapshot {
        native_trust_binding_with_snapshot(root, "p").unwrap().1
    }

    fn ack(
        root: &std::path::Path,
        binding: Option<&NativeTrustSnapshot>,
    ) -> Result<(), NativeTrustAckError> {
        record_acknowledgment(root, "p", binding, AckAcceptances::default())
    }

    fn recorded(root: &std::path::Path) -> bool {
        NativeTrustStore::load(root)
            .acknowledgments()
            .iter()
            .any(|(id, _)| id == "p")
    }

    /// #4419: a binding that matches what is on disk is recorded.
    #[test]
    fn acknowledging_the_rendered_binding_records_it() {
        let tmp = tempfile::TempDir::new().unwrap();
        install_native(tmp.path(), r#"["terminal"]"#, b"v1");
        let shown = rendered(tmp.path());
        ack(tmp.path(), Some(&shown)).unwrap();
        let store = NativeTrustStore::load(tmp.path());
        let binding = native_trust_binding(tmp.path(), "p").unwrap();
        assert_eq!(store.ack_status("p", &binding), Some(AckStatus::Current));
    }

    /// #4419: the library changing between render and click is refused.
    #[test]
    fn a_library_changed_after_render_is_refused() {
        let tmp = tempfile::TempDir::new().unwrap();
        install_native(tmp.path(), r#"["terminal"]"#, b"v1");
        let shown = rendered(tmp.path());
        install_native(tmp.path(), r#"["terminal"]"#, b"v2 - swapped");
        let err = ack(tmp.path(), Some(&shown)).unwrap_err();
        assert_eq!(err.code, NativeTrustAckErrorCode::BindingChanged);
        assert!(err.message.contains("library"), "{}", err.message);
        assert!(!recorded(tmp.path()), "nothing may be recorded");
    }

    /// #4419: the access changing between render and click is refused.
    #[test]
    fn access_changed_after_render_is_refused() {
        let tmp = tempfile::TempDir::new().unwrap();
        install_native(tmp.path(), r#"["terminal"]"#, b"v1");
        let shown = rendered(tmp.path());
        install_native(tmp.path(), r#"["terminal", "network"]"#, b"v1");
        let err = ack(tmp.path(), Some(&shown)).unwrap_err();
        assert_eq!(err.code, NativeTrustAckErrorCode::BindingChanged);
        assert!(err.message.contains("access"), "{}", err.message);
        assert!(!recorded(tmp.path()));
    }

    /// #4419: any mismatch is refused — the comparison is exact.
    #[test]
    fn a_mismatched_binding_is_refused() {
        let tmp = tempfile::TempDir::new().unwrap();
        install_native(tmp.path(), r#"["terminal"]"#, b"v1");
        let shown = rendered(tmp.path());
        let other = termihub_core::plugin::sha256_digest(b"other");
        let mut wrong_lib = shown.clone();
        wrong_lib.library_sha256 = other.clone();
        let mut wrong_access = shown.clone();
        wrong_access.access_digest =
            format!("{}{other}", termihub_core::plugin::ACCESS_DIGEST_PREFIX);
        for bad in [wrong_lib, wrong_access] {
            let err = ack(tmp.path(), Some(&bad)).unwrap_err();
            assert_eq!(err.code, NativeTrustAckErrorCode::BindingChanged);
        }
        assert!(!recorded(tmp.path()));
    }

    /// #4419: a missing or old-format binding is refused, never a match.
    #[test]
    fn a_missing_or_old_format_binding_is_refused() {
        let tmp = tempfile::TempDir::new().unwrap();
        install_native(tmp.path(), r#"["terminal"]"#, b"v1");
        let shown = rendered(tmp.path());
        let bare = shown
            .access_digest
            .strip_prefix(termihub_core::plugin::ACCESS_DIGEST_PREFIX)
            .unwrap()
            .to_owned();
        let old_format = NativeTrustSnapshot {
            access_digest: bare,
            ..shown.clone()
        };
        for binding in [None, Some(&old_format)] {
            let err = ack(tmp.path(), binding).unwrap_err();
            assert_eq!(err.code, NativeTrustAckErrorCode::BindingMissing);
        }
        assert!(!recorded(tmp.path()));
        // The wire form is the `{ code, message }` envelope.
        let json = serde_json::to_value(ack(tmp.path(), None).unwrap_err()).unwrap();
        assert_eq!(json["code"], "binding_missing");
        assert!(json["message"].is_string());
    }

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

    fn backend_manifest(libraries: &str) -> PluginManifest {
        serde_json::from_str(&format!(
            r#"{{
                "id": "echo", "name": "Echo", "version": "1.0.0", "author": "a",
                "description": "d", "license": "MIT", "apiVersion": "1.0",
                "platforms": ["linux", "macos", "windows"], "permissions": ["terminal"],
                "extensions": {{ "terminalBackend": {{
                    "connectionType": "echo", "displayName": "Echo", "configSchema": {{}}
                    {libraries}
                }} }}
            }}"#
        ))
        .unwrap()
    }

    #[test]
    fn preview_marks_a_package_without_the_host_triple_unsupported() {
        let manifest = backend_manifest(
            r#", "libraries": { "riscv64gc-unknown-linux-gnu": "backend/riscv64gc-unknown-linux-gnu/libecho.so" }"#,
        );
        let preview = package_preview(manifest, None);
        assert!(!preview.platform_supported);
        assert_eq!(preview.host_platform, host_target_triple());

        let json = serde_json::to_value(&preview).unwrap();
        assert_eq!(json["platformSupported"], false);
        assert_eq!(json["hostPlatform"], host_target_triple());
        assert!(
            json["manifest"]["extensions"]["terminalBackend"]["libraries"]
                ["riscv64gc-unknown-linux-gnu"]
                .is_string()
        );
    }

    #[test]
    fn preview_marks_host_and_legacy_packages_supported() {
        let host = host_target_triple();
        let with_host = backend_manifest(&format!(
            r#", "libraries": {{ "{host}": "backend/{host}/lib" }}"#
        ));
        assert!(package_preview(with_host, None).platform_supported);
        assert!(package_preview(backend_manifest(""), None).platform_supported);
        assert_eq!(get_plugin_host_platform(), host);
    }

    /// Pack an unsigned theme plugin `acme-tool` at `version` requesting
    /// `permissions` and `filesystem_paths`, returning the package path.
    fn pack_access(
        tmp: &std::path::Path,
        version: &str,
        permissions: serde_json::Value,
        filesystem_paths: serde_json::Value,
    ) -> std::path::PathBuf {
        let src = tmp.join(format!("src-{version}"));
        std::fs::create_dir_all(src.join("themes")).unwrap();
        std::fs::write(src.join("themes/dark.json"), "{}").unwrap();
        let manifest = serde_json::json!({
            "id": "acme-tool", "name": "Acme Tool", "version": version,
            "author": "t", "description": "d", "license": "MIT", "apiVersion": "1.0",
            "platforms": ["linux", "macos", "windows"], "permissions": permissions,
            "filesystemPaths": filesystem_paths,
            "extensions": { "theme": { "themes": [
                { "id": "dark", "name": "Dark", "file": "themes/dark.json" }
            ] } }
        });
        std::fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
        let out = tmp.join(format!("out-{version}"));
        std::fs::create_dir_all(&out).unwrap();
        termihub_core::plugin::pack_plugin(&src, &out).unwrap()
    }

    /// #4418: the install preview carries the installed version and the access
    /// diff against it on an update or re-install, and neither on a fresh one.
    #[test]
    fn preview_carries_the_access_diff_against_the_installed_copy() {
        use serde_json::json;
        let tmp = tempfile::TempDir::new().unwrap();
        let mgr = PluginManager::new(tmp.path().join("plugins"));
        let v1 = pack_access(tmp.path(), "1.0.0", json!(["ui", "network"]), json!([]));

        let fresh = preview_package(&v1, &mgr).unwrap();
        assert!(fresh.installed_version.is_none() && fresh.access_diff.is_none());
        let json = serde_json::to_value(&fresh).unwrap();
        assert!(json.get("installedVersion").is_none());
        assert!(json.get("accessDiff").is_none());

        let opts = InstallOptions {
            accept_untrusted: true,
            ..InstallOptions::default()
        };
        mgr.install_with(&v1, opts).unwrap();

        // Re-installing the same version: compared, and nothing changed.
        let same = preview_package(&v1, &mgr).unwrap();
        assert_eq!(same.installed_version.as_deref(), Some("1.0.0"));
        assert!(same.access_diff.as_ref().unwrap().is_empty());

        let v2 = pack_access(
            tmp.path(),
            "2.0.0",
            json!(["ui", "filesystem"]),
            json!(["/srv/acme/"]),
        );
        let update = preview_package(&v2, &mgr).unwrap();
        assert_eq!(update.installed_version.as_deref(), Some("1.0.0"));
        let diff = update.access_diff.as_ref().unwrap();
        assert!(diff.adds_access());
        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(json["installedVersion"], "1.0.0");
        assert_eq!(
            json["accessDiff"]["added"]["permissions"],
            json!(["filesystem"])
        );
        assert_eq!(
            json["accessDiff"]["added"]["filesystemPaths"],
            json!([{ "declared": "/srv/acme/", "folder": "/srv/acme" }])
        );
        assert_eq!(
            json["accessDiff"]["removed"]["permissions"],
            json!(["network"])
        );
        assert!(json["accessDiff"]["connectionPolicy"].is_null());
    }
}
