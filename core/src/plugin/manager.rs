//! The plugin **management layer**: installed-plugin state and the on-disk
//! layout.
//!
//! Where [`super::package`] and [`super::manifest`] define the *format*
//! contract, [`PluginManager`] owns what is actually installed on this machine:
//! it scans `<app-data>/plugins/`, installs and uninstalls packages, and
//! persists each plugin's enabled/disabled state and settings (concept impl
//! §12, "Migration Path" step 1). It performs **no** code loading — no dynamic
//! libraries, no theme/JS registration. Enabling or disabling a plugin flips
//! persisted state and calls a [`PluginLifecycleHook`] seam that a later
//! plugin-host issue implements; the default hook is a no-op, which is what lets
//! this layer merge independently.
//!
//! # On-disk layout
//!
//! ```text
//! <app-data>/plugins/
//! ├── plugin-state.json      # per-plugin enabled/disabled + install time
//! ├── plugin-settings.json   # per-plugin user configuration
//! ├── <id-a>/                # one directory per installed plugin (extracted)
//! │   ├── manifest.json
//! │   └── …
//! └── <id-b>/
//!     └── manifest.json
//! ```
//!
//! The two JSON files live alongside the per-plugin directories; scanning only
//! considers sub*directories*, so they are skipped naturally.
//!
//! # Concurrency
//!
//! Install and uninstall (and the state/settings mutations behind
//! enable/disable) are serialized by an internal mutex so two concurrent
//! operations cannot race on the same directory or clobber each other's
//! read-modify-write of the state files (concept "Edge Cases").

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use super::manifest::{is_valid_plugin_id, parse_manifest, ApiCompatibility, PluginManifest};
use super::package::{
    check_package_size, read_entry_bounded, validate_package, PluginPackageError,
    MANIFEST_FILE_NAME, MAX_DECOMPRESSED_ENTRY_BYTES, MAX_DECOMPRESSED_TOTAL_BYTES,
};
use super::security::{assess_trust, TrustAssessment, TrustLevel};
use super::signature::{self, VerifiedArchive};
use super::trust_store::{TrustStore, TrustStoreError, TrustedPublisher};

/// File holding per-plugin enabled/disabled state and install timestamps.
const STATE_FILE_NAME: &str = "plugin-state.json";
/// File holding per-plugin user settings.
const SETTINGS_FILE_NAME: &str = "plugin-settings.json";

/// The lifecycle state of an installed plugin, as surfaced to the frontend.
///
/// JSON values are the lowercase names from the plugin-system concept:
/// `installed` / `active` / `disabled` / `error` / `incompatible`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginState {
    /// Extracted and enabled, but not yet loaded into a running host. This is
    /// the resting state for an enabled plugin in this foundation layer, which
    /// does no loading — a later host issue promotes it to [`Active`].
    ///
    /// [`Active`]: PluginState::Active
    Installed,
    /// Loaded and running. Only a later plugin-host issue can produce this; the
    /// management layer never assigns it on its own.
    Active,
    /// The user has turned the plugin off; it stays extracted but is not loaded.
    Disabled,
    /// The plugin is enabled but failed — e.g. its lifecycle hook returned an
    /// error. [`InstalledPlugin::error_message`] carries the detail.
    Error,
    /// The plugin's declared `apiVersion` is not compatible with this host, so
    /// it must not be loaded even though it is enabled.
    Incompatible,
}

/// One installed plugin: its trusted manifest plus the management-layer state
/// this crate tracks for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// The plugin's validated `manifest.json`.
    pub manifest: PluginManifest,
    /// The plugin's current lifecycle state.
    pub state: PluginState,
    /// Human-readable detail when [`state`](InstalledPlugin::state) is
    /// [`PluginState::Error`]; `null`/absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// When the plugin was installed, as milliseconds since the Unix epoch.
    pub installed_at: u64,
}

/// The seam through which a later plugin-*host* issue actually loads and unloads
/// plugin code.
///
/// The management layer calls these hooks around the enable/disable/uninstall
/// bookkeeping; the default [`NoopLifecycleHook`] does nothing, which is what
/// lets this layer ship and merge before any host exists. A hook error on
/// enable is surfaced as [`PluginState::Error`] rather than failing the whole
/// operation — the plugin stays enabled but is reported as errored.
pub trait PluginLifecycleHook: Send + Sync {
    /// Called after a plugin is enabled (or on install of an enabled plugin).
    fn on_enable(&self, _plugin: &InstalledPlugin) -> Result<(), String> {
        Ok(())
    }
    /// Called before a plugin is disabled.
    fn on_disable(&self, _id: &str) -> Result<(), String> {
        Ok(())
    }
    /// Called before a plugin's directory is removed (the "shutdown hook").
    fn on_uninstall(&self, _id: &str) -> Result<(), String> {
        Ok(())
    }
}

/// The default no-op [`PluginLifecycleHook`] used until a real host is wired in.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopLifecycleHook;

impl PluginLifecycleHook for NoopLifecycleHook {}

/// Everything that can go wrong in the management layer.
#[derive(Debug, Error)]
pub enum PluginManagerError {
    /// A filesystem operation failed.
    #[error("plugin storage I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// Validating the package to install failed (bad format, incompatible API,
    /// …). Wraps the format-layer error.
    #[error(transparent)]
    Package(#[from] PluginPackageError),

    /// No installed plugin has the given id.
    #[error("no installed plugin with id `{0}`")]
    NotFound(String),

    /// The package archive could not be extracted.
    #[error("failed to extract plugin package: {0}")]
    Extract(String),

    /// A package entry has an unsafe path (absolute or `..`-escaping) — a
    /// zip-slip attempt. The install is refused.
    #[error("plugin package contains an unsafe entry path: `{0}`")]
    UnsafePath(String),

    /// A requested plugin file path escapes the plugin directory.
    #[error("path `{0}` escapes the plugin directory")]
    PathTraversal(String),

    /// A state or settings file could not be (de)serialized.
    #[error("plugin state store error: {0}")]
    Store(String),

    /// The package is from an unverified (unsigned) source and the caller did not
    /// explicitly accept the risk, so installation was refused before extraction
    /// (concept security gate). See [`PluginManager::assess_trust`].
    #[error("plugin is from an untrusted source and the risk was not accepted")]
    UntrustedSourceNotAccepted,

    /// The package carries a signature that did not verify — treated as tampering.
    /// Installation is refused with no override (concept: `Tampered` hard-block).
    #[error("plugin signature is invalid; the package may have been tampered with")]
    SignatureTampered,

    /// The publisher trust store could not be read or written.
    #[error("plugin trust store error: {0}")]
    TrustStore(#[from] TrustStoreError),
}

/// Per-plugin record persisted in `plugin-state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStateRecord {
    /// Whether the user has the plugin enabled.
    enabled: bool,
    /// Install time in milliseconds since the Unix epoch.
    installed_at: u64,
}

/// The whole `plugin-state.json` document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StateStore {
    /// Records keyed by plugin id.
    #[serde(default)]
    plugins: BTreeMap<String, PluginStateRecord>,
}

/// The whole `plugin-settings.json` document: per-plugin free-form settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SettingsStore {
    /// Settings objects keyed by plugin id.
    #[serde(default)]
    plugins: BTreeMap<String, Map<String, Value>>,
}

/// Owns the installed-plugin directory and its state; the entry point for the
/// Tauri command layer.
pub struct PluginManager {
    /// The `<app-data>/plugins/` root.
    root: PathBuf,
    /// Serializes install/uninstall/state mutations against each other.
    lock: Mutex<()>,
    /// The loading seam; a no-op until a host issue supplies a real one.
    hook: Arc<dyn PluginLifecycleHook>,
}

impl PluginManager {
    /// Create a manager rooted at `plugins_root` (`<app-data>/plugins/`), using
    /// the no-op lifecycle hook.
    ///
    /// The directory is created lazily on first write; it does not need to exist
    /// yet.
    pub fn new(plugins_root: impl Into<PathBuf>) -> Self {
        Self::with_hook(plugins_root, Arc::new(NoopLifecycleHook))
    }

    /// Create a manager with an explicit [`PluginLifecycleHook`] — used by the
    /// later plugin-host issue to wire in real loading.
    pub fn with_hook(plugins_root: impl Into<PathBuf>, hook: Arc<dyn PluginLifecycleHook>) -> Self {
        Self {
            root: plugins_root.into(),
            lock: Mutex::new(()),
            hook,
        }
    }

    /// The `<app-data>/plugins/` root this manager owns.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Validate a `.termihub-plugin` package without installing it, returning
    /// its trusted manifest. Thin pass-through to [`validate_package`] so the
    /// command surface has a single entry point.
    pub fn validate(&self, package_path: &Path) -> Result<PluginManifest, PluginPackageError> {
        validate_package(package_path)
    }

    /// Scan the plugins root and return every installed plugin, sorted by id.
    ///
    /// Each sub*directory* with a readable, valid `manifest.json` becomes an
    /// [`InstalledPlugin`]; its state is derived from API compatibility and the
    /// persisted enabled/disabled flag. Directories whose manifest is missing or
    /// invalid are skipped (they were never installed through this manager, or
    /// were corrupted) rather than aborting the whole scan.
    pub fn list(&self) -> Result<Vec<InstalledPlugin>, PluginManagerError> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let state = self.read_state_store()?;
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let dir = entry.path();
            let manifest = match read_manifest(&dir) {
                Some(m) => m,
                None => continue,
            };
            out.push(self.installed_plugin_from(manifest, &state, &dir));
        }
        out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        Ok(out)
    }

    /// Look up a single installed plugin by id.
    pub fn get(&self, id: &str) -> Result<InstalledPlugin, PluginManagerError> {
        let dir = self.plugin_dir(id);
        let manifest =
            read_manifest(&dir).ok_or_else(|| PluginManagerError::NotFound(id.into()))?;
        let state = self.read_state_store()?;
        Ok(self.installed_plugin_from(manifest, &state, &dir))
    }

    /// Assess how much a `.termihub-plugin` package can be trusted before
    /// installing it: open it, verify any embedded signature, and consult the
    /// publisher trust store (concept "States & Sequences").
    ///
    /// Reports [`TrustLevel::Verified`](super::TrustLevel::Verified) for a signed
    /// package whose key is trusted, [`TrustLevel::Signed`](super::TrustLevel::Signed)
    /// for a valid but unknown key (offer trust-on-first-use),
    /// [`TrustLevel::Untrusted`](super::TrustLevel::Untrusted) for an unsigned one
    /// (the `accept_untrusted` gate), and
    /// [`TrustLevel::Tampered`](super::TrustLevel::Tampered) for an invalid
    /// signature (blocked). A trust store that cannot be read degrades safely to
    /// bundled-only, so a corrupt file never makes an untrusted key read trusted.
    #[must_use]
    pub fn assess_trust(&self, package_path: &Path) -> TrustAssessment {
        let store =
            TrustStore::load(&self.root).unwrap_or_else(|_| TrustStore::bundled_only(&self.root));
        assess_trust(package_path, &store)
    }

    /// Every trusted publisher key (bundled and user-pinned), for the Trusted
    /// Publishers settings group.
    pub fn trusted_publishers(&self) -> Result<Vec<TrustedPublisher>, PluginManagerError> {
        Ok(TrustStore::load(&self.root)?.list())
    }

    /// Pin a publisher key into the trust store (a manual add from Settings, or a
    /// direct trust-on-first-use accept outside an install).
    pub fn pin_publisher(
        &self,
        key_id: &str,
        public_key: &str,
        label: &str,
    ) -> Result<(), PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = TrustStore::load(&self.root)?;
        store.pin(key_id, public_key, label)?;
        Ok(())
    }

    /// Revoke (remove) a user-pinned publisher key. Bundled keys cannot be
    /// revoked; an unknown key id is a no-op. Does not uninstall already-installed
    /// plugins — it only affects future install/update gates.
    pub fn revoke_publisher(&self, key_id: &str) -> Result<(), PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = TrustStore::load(&self.root)?;
        store.revoke(key_id)?;
        Ok(())
    }

    /// Install a plugin from a `.termihub-plugin` package.
    ///
    /// Validates the package (format + API compatibility), extracts it into
    /// `plugins/<id>/` (replacing any prior install of the same id), records it
    /// as enabled, and runs the enable hook. Serialized against other
    /// install/uninstall operations.
    ///
    /// The install is gated on the package's assessed trust (concept security
    /// flowchart):
    ///
    /// * **Tampered** (invalid signature) → refused with
    ///   [`PluginManagerError::SignatureTampered`], no override;
    /// * **Untrusted** (unsigned) → requires `accept_untrusted = true`, else
    ///   [`PluginManagerError::UntrustedSourceNotAccepted`];
    /// * **Signed** (valid, unknown key) → installed; if `trust_publisher` is
    ///   `true` the signing key is pinned to the trust store (trust-on-first-use);
    /// * **Verified** (valid, trusted key) → installed with no risk gate.
    ///
    /// All gates are checked **before** anything is extracted.
    pub fn install(
        &self,
        package_path: &Path,
        accept_untrusted: bool,
        trust_publisher: bool,
    ) -> Result<InstalledPlugin, PluginManagerError> {
        // Reject an oversize (compressed) package up front, before trust
        // assessment opens and reads the archive. The compressed-size gate used to
        // live only inside `validate_package`, which runs *after* the trust gate —
        // so trust assessment would decompress an unbounded archive first (#2046).
        // Per-entry decompression is separately bounded while reading.
        check_package_size(package_path)?;

        // Trust gate (concept security flowchart): assessed before touching the
        // package. A tampered signature is a hard block; an unsigned package needs
        // the risk accepted; signed/verified proceed.
        let assessment = self.assess_trust(package_path);
        if assessment.is_blocked() {
            return Err(PluginManagerError::SignatureTampered);
        }
        if matches!(assessment.level, TrustLevel::Untrusted) && !accept_untrusted {
            return Err(PluginManagerError::UntrustedSourceNotAccepted);
        }

        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());

        let manifest = validate_package(package_path)?;
        let id = manifest.id.clone();
        let dest = self.plugin_dir(&id);

        // Trust-on-first-use: pin the signing key when the user opted in on a
        // signed-but-unknown package, labelling it with the manifest's author
        // (concept mockup — the pinned key is shown under the plugin's author).
        // Done before extraction so a pin failure aborts before anything lands.
        if trust_publisher {
            if let TrustLevel::Signed { key_id } = &assessment.level {
                if let Some(public_key) = &assessment.public_key {
                    let mut store = TrustStore::load(&self.root)?;
                    store.pin(key_id, public_key, &manifest.author)?;
                }
            }
        }

        std::fs::create_dir_all(&self.root)?;

        // Extract into a staging directory on the same filesystem, then swap it
        // into place, so a failed extraction never leaves a half-written plugin
        // dir behind.
        //
        // The trust gate above assessed a *separate* open of the package; the
        // extractor re-opens the path and must bind the bytes it writes to what was
        // verified, or a swap between the two opens (verify-then-use TOCTOU) would
        // land unsigned/attacker bytes on disk (#2045). For a signed/verified
        // package we hand the extractor the signer's fingerprint it must still see;
        // an unsigned (accepted-risk) package has no signature to bind to.
        let expected_key_id = match &assessment.level {
            TrustLevel::Verified { .. } | TrustLevel::Signed { .. } => assessment.key_id.as_deref(),
            TrustLevel::Untrusted | TrustLevel::Tampered => None,
        };
        let staging = self.root.join(format!(".staging-{id}"));
        if staging.exists() {
            std::fs::remove_dir_all(&staging)?;
        }
        let extract_result = extract_package(package_path, &staging, expected_key_id);
        if let Err(e) = extract_result {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        std::fs::rename(&staging, &dest)?;

        // Record enabled state with the install timestamp.
        let mut state = self.read_state_store()?;
        state.plugins.insert(
            id.clone(),
            PluginStateRecord {
                enabled: true,
                installed_at: now_millis(),
            },
        );
        self.write_state_store(&state)?;

        let mut plugin = self.installed_plugin_from(manifest, &state, &dest);
        if let Err(msg) = self.hook.on_enable(&plugin) {
            plugin.state = PluginState::Error;
            plugin.error_message = Some(msg);
        }
        Ok(plugin)
    }

    /// Uninstall a plugin by id: run its shutdown hook, remove its directory,
    /// and drop its persisted state and settings. Serialized against other
    /// install/uninstall operations. Idempotent-ish: a missing directory is a
    /// [`PluginManagerError::NotFound`].
    pub fn uninstall(&self, id: &str) -> Result<(), PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());

        let dir = self.plugin_dir(id);
        if !dir.exists() {
            return Err(PluginManagerError::NotFound(id.into()));
        }

        // Shutdown hook first (no-op today); a hook failure must not strand the
        // plugin on disk, so we log-and-continue rather than abort.
        let _ = self.hook.on_uninstall(id);

        std::fs::remove_dir_all(&dir)?;

        let mut state = self.read_state_store()?;
        state.plugins.remove(id);
        self.write_state_store(&state)?;

        let mut settings = self.read_settings_store()?;
        settings.plugins.remove(id);
        self.write_settings_store(&settings)?;

        Ok(())
    }

    /// Enable a plugin, persisting the flag and running the enable hook. Returns
    /// the refreshed [`InstalledPlugin`].
    pub fn enable(&self, id: &str) -> Result<InstalledPlugin, PluginManagerError> {
        self.set_enabled(id, true)
    }

    /// Disable a plugin, persisting the flag and running the disable hook.
    pub fn disable(&self, id: &str) -> Result<InstalledPlugin, PluginManagerError> {
        self.set_enabled(id, false)
    }

    /// Auto-disable every installed plugin that has become **incompatible** with
    /// the current host plugin-API version while it was still enabled, and return
    /// the ids that were disabled so the caller can notify the user.
    ///
    /// This is the concept's "App update changes the plugin API version →
    /// incompatible plugins are auto-disabled with a notification" behavior: run
    /// it at startup after a host upgrade. An incompatible plugin is never loaded
    /// regardless (its derived state is [`PluginState::Incompatible`]); this also
    /// flips the *persisted* enabled flag off so the plugin does not silently
    /// re-activate if a later host once again supports its API version. Idempotent:
    /// a second run finds nothing to disable.
    pub fn reconcile_compatibility(&self) -> Result<Vec<String>, PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());

        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut state = self.read_state_store()?;
        let mut disabled = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(manifest) = read_manifest(&entry.path()) else {
                continue;
            };
            if manifest.api_compatibility() != ApiCompatibility::Incompatible {
                continue;
            }
            if let Some(record) = state.plugins.get_mut(&manifest.id) {
                if record.enabled {
                    record.enabled = false;
                    disabled.push(manifest.id.clone());
                }
            }
        }
        if !disabled.is_empty() {
            self.write_state_store(&state)?;
        }
        disabled.sort();
        Ok(disabled)
    }

    /// Load every installed plugin whose persisted state is **enabled and
    /// compatible**, through the same lifecycle-hook `on_enable` path a fresh
    /// enable uses. Call this once at startup, after the host is wired in.
    ///
    /// The management layer restores each plugin's persisted enabled flag during
    /// its scan but does **no** loading, so without this an already-enabled
    /// plugin sits un-loaded until the user toggles it off/on — its
    /// connection type never gets registered, and a persisted connection of that
    /// type cannot resolve after a restart. This drives the host's load path for
    /// each enabled plugin so its `ConnectionType` is registered automatically.
    ///
    /// Only plugins the scan resolves to [`PluginState::Installed`] (enabled *and*
    /// compatible) are loaded: disabled plugins are skipped, and an incompatible
    /// plugin is never loaded regardless of its flag (run
    /// [`reconcile_compatibility`](Self::reconcile_compatibility) first to
    /// auto-disable ones that became incompatible). A plugin whose load **fails**
    /// surfaces as [`PluginState::Error`] in the returned vector rather than
    /// aborting startup — it stays installed and enabled, and is retried on the
    /// next launch or an explicit re-enable.
    ///
    /// Returns every plugin it attempted to load, each with its state reflecting
    /// the outcome ([`PluginState::Installed`] on success,
    /// [`PluginState::Error`] on failure), so the caller can notify the user of
    /// any that failed.
    pub fn load_enabled_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());

        let mut attempted = Vec::new();
        for mut plugin in self.list()? {
            // `list()` resolves an enabled+compatible plugin to `Installed`, a
            // disabled one to `Disabled`, and an incompatible one to
            // `Incompatible`. Only the first should be loaded — this naturally
            // honors both the persisted flag and API compatibility.
            if plugin.state != PluginState::Installed {
                continue;
            }
            if let Err(msg) = self.hook.on_enable(&plugin) {
                plugin.state = PluginState::Error;
                plugin.error_message = Some(msg);
            }
            attempted.push(plugin);
        }
        Ok(attempted)
    }

    fn set_enabled(&self, id: &str, enabled: bool) -> Result<InstalledPlugin, PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());

        let dir = self.plugin_dir(id);
        let manifest =
            read_manifest(&dir).ok_or_else(|| PluginManagerError::NotFound(id.into()))?;

        let mut state = self.read_state_store()?;
        let record = state
            .plugins
            .entry(id.to_string())
            .or_insert_with(|| PluginStateRecord {
                enabled,
                installed_at: now_millis(),
            });
        record.enabled = enabled;
        self.write_state_store(&state)?;

        let mut plugin = self.installed_plugin_from(manifest, &state, &dir);

        // Run the loading seam. Compatibility is decided before the hook: an
        // incompatible plugin must not be loaded regardless of the flag.
        if plugin.state != PluginState::Incompatible {
            let hook_result = if enabled {
                self.hook.on_enable(&plugin)
            } else {
                self.hook.on_disable(id)
            };
            if let Err(msg) = hook_result {
                plugin.state = PluginState::Error;
                plugin.error_message = Some(msg);
            }
        }
        Ok(plugin)
    }

    /// Return a plugin's stored settings (the raw persisted object, empty if the
    /// user has set none). Schema defaults live in the manifest and are applied
    /// by the caller.
    pub fn get_settings(&self, id: &str) -> Result<Map<String, Value>, PluginManagerError> {
        if !self.plugin_dir(id).exists() {
            return Err(PluginManagerError::NotFound(id.into()));
        }
        let settings = self.read_settings_store()?;
        Ok(settings.plugins.get(id).cloned().unwrap_or_default())
    }

    /// Replace a plugin's stored settings with `values`.
    pub fn update_settings(
        &self,
        id: &str,
        values: Map<String, Value>,
    ) -> Result<(), PluginManagerError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());

        if !self.plugin_dir(id).exists() {
            return Err(PluginManagerError::NotFound(id.into()));
        }
        let mut settings = self.read_settings_store()?;
        settings.plugins.insert(id.to_string(), values);
        self.write_settings_store(&settings)?;
        Ok(())
    }

    /// Read a file from inside an installed plugin's directory. `relative` is a
    /// path *within* `plugins/<id>/`; absolute or `..`-escaping paths are
    /// refused. This is the helper the (later) theme/JS loaders use to pull
    /// asset bytes out of an installed plugin.
    pub fn read_file(&self, id: &str, relative: &str) -> Result<Vec<u8>, PluginManagerError> {
        // `id` reaches this method from the renderer over IPC (the
        // `read_plugin_file` command), so it is untrusted. Re-validate it with
        // the same slug rule enforced at manifest time before it is joined into
        // a filesystem path — otherwise a traversing id (`..`, separators) would
        // escape the plugin root and turn this into an arbitrary-file read.
        if !is_valid_plugin_id(id) {
            return Err(PluginManagerError::PathTraversal(id.into()));
        }
        let dir = self.plugin_dir(id);
        if !dir.exists() {
            return Err(PluginManagerError::NotFound(id.into()));
        }
        let safe = safe_relative(relative)
            .ok_or_else(|| PluginManagerError::PathTraversal(relative.into()))?;
        let full = dir.join(safe);
        Ok(std::fs::read(full)?)
    }

    // --- internal helpers -------------------------------------------------

    /// Absolute directory for a plugin id. The id is validated at manifest time
    /// to a filesystem-safe slug, so it cannot contain separators.
    fn plugin_dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// Build an [`InstalledPlugin`], deriving its state from API compatibility
    /// and the persisted enabled flag.
    fn installed_plugin_from(
        &self,
        manifest: PluginManifest,
        state: &StateStore,
        dir: &Path,
    ) -> InstalledPlugin {
        let record = state.plugins.get(&manifest.id);
        let enabled = record.map(|r| r.enabled).unwrap_or(true);
        let installed_at = record
            .map(|r| r.installed_at)
            .unwrap_or_else(|| dir_install_time(dir));

        let plugin_state = if manifest.api_compatibility() == ApiCompatibility::Incompatible {
            PluginState::Incompatible
        } else if enabled {
            // Enabled but not loaded — this layer does no loading, so an enabled
            // plugin rests at `installed` until a host promotes it to `active`.
            PluginState::Installed
        } else {
            PluginState::Disabled
        };

        InstalledPlugin {
            manifest,
            state: plugin_state,
            error_message: None,
            installed_at,
        }
    }

    fn state_path(&self) -> PathBuf {
        self.root.join(STATE_FILE_NAME)
    }

    fn settings_path(&self) -> PathBuf {
        self.root.join(SETTINGS_FILE_NAME)
    }

    fn read_state_store(&self) -> Result<StateStore, PluginManagerError> {
        read_json_or_default(&self.state_path())
    }

    fn write_state_store(&self, store: &StateStore) -> Result<(), PluginManagerError> {
        write_json_atomic(&self.root, &self.state_path(), store)
    }

    fn read_settings_store(&self) -> Result<SettingsStore, PluginManagerError> {
        read_json_or_default(&self.settings_path())
    }

    fn write_settings_store(&self, store: &SettingsStore) -> Result<(), PluginManagerError> {
        write_json_atomic(&self.root, &self.settings_path(), store)
    }
}

/// Current time as milliseconds since the Unix epoch (0 if the clock predates
/// the epoch, which cannot happen in practice).
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Best-effort install time for a plugin directory that has no state record
/// (e.g. dropped in by hand): its created time, falling back to modified, then
/// to now.
fn dir_install_time(dir: &Path) -> u64 {
    let meta = match std::fs::metadata(dir) {
        Ok(m) => m,
        Err(_) => return now_millis(),
    };
    meta.created()
        .or_else(|_| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_millis)
}

/// Read and validate `manifest.json` from a plugin directory, or `None` if it
/// is missing, unreadable, unparseable, or fails semantic validation.
fn read_manifest(dir: &Path) -> Option<PluginManifest> {
    let json = std::fs::read_to_string(dir.join(MANIFEST_FILE_NAME)).ok()?;
    let manifest = parse_manifest(&json).ok()?;
    manifest.validate().ok()?;
    Some(manifest)
}

/// Sanitize a caller-supplied relative path to one that stays inside a plugin
/// directory. Returns `None` for absolute paths, roots, or any `..` component.
fn safe_relative(relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            // Reject anything that could escape or re-root the path.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
            Component::CurDir => {}
        }
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

/// Extract a validated `.termihub-plugin` (ZIP) into `dest`, creating it.
///
/// Every entry path is resolved through `enclosed_name`, which yields `None` for
/// any path that would escape the destination (zip-slip); such an entry aborts
/// the extraction with [`PluginManagerError::UnsafePath`].
///
/// # Binding extraction to the verified signature (TOCTOU)
///
/// The install trust gate verifies the signature on a *separate, earlier* open of
/// the package path; this extractor re-opens the path, so on its own it would
/// write whatever the file holds *now* — a verify-then-use gap where the loaded
/// library need not be the signed one (#2045). To close it, extraction re-verifies
/// the signature against **this** freshly-opened archive and binds every byte it
/// writes to the signed digest map:
///
/// * `expected_key_id = Some(k)` — the gate approved a signature from key `k`.
///   This archive must present a valid signature from that same key, and each
///   extracted entry's SHA-256 must match the signed map (and the signed set must
///   be exactly present). Any deviation — tampered content, a different signer, a
///   dropped signature, a missing signed entry — is
///   [`PluginManagerError::SignatureTampered`].
/// * `expected_key_id = None` — the gate accepted the package as *unsigned*
///   (accepted-risk install); there is nothing to bind to, so only the zip-slip
///   check applies, as before.
fn extract_package(
    package_path: &Path,
    dest: &Path,
    expected_key_id: Option<&str>,
) -> Result<(), PluginManagerError> {
    extract_package_with_limits(
        package_path,
        dest,
        expected_key_id,
        MAX_DECOMPRESSED_ENTRY_BYTES,
        MAX_DECOMPRESSED_TOTAL_BYTES,
    )
}

/// [`extract_package`] with explicit decompression limits, so the zip-bomb guard
/// on the extraction path can be exercised in tests with tiny fixtures.
fn extract_package_with_limits(
    package_path: &Path,
    dest: &Path,
    expected_key_id: Option<&str>,
    per_entry_limit: u64,
    total_limit: u64,
) -> Result<(), PluginManagerError> {
    let file = std::fs::File::open(package_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| PluginManagerError::Extract(e.to_string()))?;

    // Re-verify against this open archive and resolve the digest map the written
    // bytes must match. `Some(map)` means "bind every entry to this"; `None` means
    // an unsigned, accepted-risk package with nothing to bind.
    let signed_files: Option<BTreeMap<String, String>> =
        match signature::verify_signed_archive(&mut archive)
            .map_err(|e| PluginManagerError::Extract(e.to_string()))?
        {
            VerifiedArchive::Signed(verified) => {
                // The signer must be exactly the key the trust gate approved — this
                // rejects a swap to a *different* (even validly-signed) package
                // between verification and extraction.
                match expected_key_id {
                    Some(k) if k == verified.identity.key_id => Some(verified.files),
                    _ => return Err(PluginManagerError::SignatureTampered),
                }
            }
            // A present-but-invalid signature is tampering regardless of the gate.
            VerifiedArchive::Tampered(_) => return Err(PluginManagerError::SignatureTampered),
            VerifiedArchive::Unsigned => {
                // The gate verified a signature but the archive now presents none:
                // a signed → unsigned swap between verify and extract.
                if expected_key_id.is_some() {
                    return Err(PluginManagerError::SignatureTampered);
                }
                None
            }
        };

    std::fs::create_dir_all(dest)?;

    // Signed entries still owed an extraction — drained as we see them, so a signed
    // entry absent from the archive at extract time is caught as tampering.
    let mut unseen: BTreeSet<&String> = signed_files
        .as_ref()
        .map(|m| m.keys().collect())
        .unwrap_or_default();

    let mut remaining = total_limit;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| PluginManagerError::Extract(e.to_string()))?;
        let raw_name = entry.name().to_string();
        let safe = entry
            .enclosed_name()
            .ok_or_else(|| PluginManagerError::UnsafePath(raw_name.clone()))?;
        let out_path = dest.join(safe);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Bound decompression: an over-budget entry aborts extraction (surfaced as
        // `PluginManagerError::Io`) instead of exhausting memory/disk (#2046).
        let mut buf = Vec::new();
        read_entry_bounded(&mut entry, per_entry_limit, &mut remaining, &mut buf)?;

        // Bind the exact bytes about to be written to the signed digest map. The
        // signature entry itself is not part of the signed set, so skip it.
        if let Some(files) = &signed_files {
            if raw_name != signature::SIGNATURE_FILE_NAME {
                let actual = signature::sha256_digest(&buf);
                match files.get(&raw_name) {
                    Some(expected) if *expected == actual => {
                        unseen.remove(&raw_name);
                    }
                    _ => return Err(PluginManagerError::SignatureTampered),
                }
            }
        }

        let mut out = std::fs::File::create(&out_path)?;
        std::io::Write::write_all(&mut out, &buf)?;
    }

    // Every signed entry must have actually been written.
    if !unseen.is_empty() {
        return Err(PluginManagerError::SignatureTampered);
    }

    Ok(())
}

/// Read a JSON document, returning `T::default()` when the file does not exist.
fn read_json_or_default<T>(path: &Path) -> Result<T, PluginManagerError>
where
    T: serde::de::DeserializeOwned + Default,
{
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| PluginManagerError::Store(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(PluginManagerError::Io(e)),
    }
}

/// Serialize `value` to `path` atomically: write a sibling temp file, then
/// rename it over the target so a crash mid-write cannot corrupt the store.
fn write_json_atomic<T: Serialize>(
    root: &Path,
    path: &Path,
    value: &T,
) -> Result<(), PluginManagerError> {
    std::fs::create_dir_all(root)?;
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| PluginManagerError::Store(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn manifest_json(id: &str, api_version: &str) -> String {
        format!(
            r#"{{
                "id": "{id}",
                "name": "Test Plugin",
                "version": "1.0.0",
                "author": "tester",
                "description": "A plugin for tests",
                "license": "MIT",
                "apiVersion": "{api_version}",
                "platforms": ["linux", "macos", "windows"],
                "permissions": ["terminal"],
                "extensions": {{
                    "theme": {{
                        "themes": [
                            {{ "id": "dark", "name": "Dark", "file": "themes/dark.json" }}
                        ]
                    }}
                }}
            }}"#
        )
    }

    /// Build a `.termihub-plugin` package on disk with the given manifest and
    /// extra files.
    fn make_package(dir: &Path, manifest: &str, extra: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join("plugin.termihub-plugin");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        zip.start_file(MANIFEST_FILE_NAME, opts).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        for (name, bytes) in extra {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    /// A manager rooted in a fresh temp dir, returned with the temp dir so it
    /// outlives the manager.
    fn manager() -> (PluginManager, TempDir) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");
        (PluginManager::new(root), tmp)
    }

    #[test]
    fn list_is_empty_when_root_absent() {
        let (mgr, _t) = manager();
        assert!(mgr.list().unwrap().is_empty());
    }

    #[test]
    fn install_then_list_and_get() {
        let (mgr, tmp) = manager();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("my-theme", "1.0"),
            &[("themes/dark.json", b"{\"bg\":\"#000\"}")],
        );

        let installed = mgr.install(&pkg, true, false).unwrap();
        assert_eq!(installed.manifest.id, "my-theme");
        assert_eq!(installed.state, PluginState::Installed);
        assert!(installed.installed_at > 0);

        // Extracted to plugins/<id>/ with its files.
        let plugin_dir = mgr.root().join("my-theme");
        assert!(plugin_dir.join(MANIFEST_FILE_NAME).exists());
        assert!(plugin_dir.join("themes/dark.json").exists());

        let list = mgr.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].manifest.id, "my-theme");

        let got = mgr.get("my-theme").unwrap();
        assert_eq!(got.manifest.id, "my-theme");
    }

    #[test]
    fn install_replaces_previous_version() {
        let (mgr, tmp) = manager();
        let pkg1 = make_package(
            tmp.path(),
            &manifest_json("dup", "1.0"),
            &[("old.txt", b"old")],
        );
        mgr.install(&pkg1, true, false).unwrap();
        assert!(mgr.root().join("dup/old.txt").exists());

        // Reinstall with different contents; the old file must be gone.
        let tmp2 = TempDir::new().unwrap();
        let pkg2 = make_package(
            tmp2.path(),
            &manifest_json("dup", "1.0"),
            &[("new.txt", b"new")],
        );
        mgr.install(&pkg2, true, false).unwrap();
        assert!(mgr.root().join("dup/new.txt").exists());
        assert!(!mgr.root().join("dup/old.txt").exists());
        assert_eq!(mgr.list().unwrap().len(), 1);
    }

    #[test]
    fn uninstall_removes_dir_state_and_settings() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("gone", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        let mut s = Map::new();
        s.insert("k".into(), Value::from("v"));
        mgr.update_settings("gone", s).unwrap();

        mgr.uninstall("gone").unwrap();
        assert!(!mgr.root().join("gone").exists());
        assert!(mgr.list().unwrap().is_empty());
        // Settings and state records are dropped.
        assert!(!mgr
            .read_settings_store()
            .unwrap()
            .plugins
            .contains_key("gone"));
        assert!(!mgr.read_state_store().unwrap().plugins.contains_key("gone"));
    }

    #[test]
    fn uninstall_unknown_is_not_found() {
        let (mgr, _t) = manager();
        assert!(matches!(
            mgr.uninstall("nope"),
            Err(PluginManagerError::NotFound(_))
        ));
    }

    #[test]
    fn disable_then_enable_persists() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("toggle", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        let disabled = mgr.disable("toggle").unwrap();
        assert_eq!(disabled.state, PluginState::Disabled);
        // Persisted across a fresh scan.
        assert_eq!(mgr.get("toggle").unwrap().state, PluginState::Disabled);
        assert_eq!(mgr.list().unwrap()[0].state, PluginState::Disabled);

        let enabled = mgr.enable("toggle").unwrap();
        assert_eq!(enabled.state, PluginState::Installed);
        assert_eq!(mgr.get("toggle").unwrap().state, PluginState::Installed);
    }

    #[test]
    fn enable_unknown_is_not_found() {
        let (mgr, _t) = manager();
        assert!(matches!(
            mgr.enable("ghost"),
            Err(PluginManagerError::NotFound(_))
        ));
    }

    #[test]
    fn settings_round_trip() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("cfg", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        // Empty by default.
        assert!(mgr.get_settings("cfg").unwrap().is_empty());

        let mut values = Map::new();
        values.insert("namespace".into(), Value::from("prod"));
        values.insert("retries".into(), Value::from(3));
        mgr.update_settings("cfg", values.clone()).unwrap();

        let read_back = mgr.get_settings("cfg").unwrap();
        assert_eq!(read_back, values);

        // Survives a fresh manager over the same root.
        let mgr2 = PluginManager::new(mgr.root());
        assert_eq!(mgr2.get_settings("cfg").unwrap(), values);
    }

    #[test]
    fn settings_of_unknown_plugin_is_not_found() {
        let (mgr, _t) = manager();
        assert!(matches!(
            mgr.get_settings("nope"),
            Err(PluginManagerError::NotFound(_))
        ));
        assert!(matches!(
            mgr.update_settings("nope", Map::new()),
            Err(PluginManagerError::NotFound(_))
        ));
    }

    #[test]
    fn incompatible_api_version_surfaces_as_state() {
        // Install a compatible plugin, then hand-edit its manifest to an
        // incompatible API version — simulating a host upgrade under a plugin
        // that was installed while still compatible.
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("legacy", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        let manifest_path = mgr.root().join("legacy").join(MANIFEST_FILE_NAME);
        let bumped = manifest_json("legacy", "2.0");
        std::fs::write(&manifest_path, bumped).unwrap();

        assert_eq!(mgr.get("legacy").unwrap().state, PluginState::Incompatible);
        assert_eq!(mgr.list().unwrap()[0].state, PluginState::Incompatible);
    }

    #[test]
    fn install_refuses_incompatible_package() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("future", "2.0"), &[]);
        assert!(matches!(
            mgr.install(&pkg, true, false),
            Err(PluginManagerError::Package(
                PluginPackageError::IncompatibleApiVersion { .. }
            ))
        ));
        // Nothing was extracted.
        assert!(!mgr.root().join("future").exists());
    }

    #[test]
    fn read_file_returns_bytes_and_blocks_traversal() {
        let (mgr, tmp) = manager();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("assets", "1.0"),
            &[("themes/dark.json", b"{\"bg\":\"#111\"}")],
        );
        mgr.install(&pkg, true, false).unwrap();

        let bytes = mgr.read_file("assets", "themes/dark.json").unwrap();
        assert_eq!(bytes, b"{\"bg\":\"#111\"}");

        for bad in ["../secret", "/etc/passwd", "themes/../../escape", ""] {
            assert!(
                matches!(
                    mgr.read_file("assets", bad),
                    Err(PluginManagerError::PathTraversal(_))
                ),
                "path {bad:?} should be refused"
            );
        }
    }

    #[test]
    fn read_file_blocks_traversing_id() {
        let (mgr, tmp) = manager();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("assets", "1.0"),
            &[("themes/dark.json", b"{\"bg\":\"#111\"}")],
        );
        mgr.install(&pkg, true, false).unwrap();

        // A secret file living *outside* the plugin root that a traversing id
        // would otherwise reach.
        let secret = mgr.root().parent().unwrap().join("secret.json");
        std::fs::write(&secret, b"top secret").unwrap();

        // The `id` argument comes straight from the renderer over IPC and must
        // be validated with the same slug rule as at manifest time: anything
        // containing path separators, `..`, or non-slug characters is refused
        // before it is joined into a filesystem path.
        for bad_id in [
            "..",
            "../secret",
            "../../etc",
            "assets/../..",
            "/etc",
            "foo/bar",
            "as..sets",
            "",
        ] {
            assert!(
                matches!(
                    mgr.read_file(bad_id, "secret.json"),
                    Err(PluginManagerError::PathTraversal(_))
                ),
                "id {bad_id:?} should be refused"
            );
        }

        // The valid id still resolves normally.
        let bytes = mgr.read_file("assets", "themes/dark.json").unwrap();
        assert_eq!(bytes, b"{\"bg\":\"#111\"}");
    }

    #[test]
    fn extraction_rejects_zip_slip() {
        // A package whose entry tries to escape via `..`. `enclosed_name`
        // returns None for it, so install fails with UnsafePath and writes
        // nothing outside the plugin dir.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("evil.termihub-plugin");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        zip.start_file(MANIFEST_FILE_NAME, opts).unwrap();
        zip.write_all(manifest_json("evil", "1.0").as_bytes())
            .unwrap();
        // Escaping entry.
        zip.start_file("../escaped.txt", opts).unwrap();
        zip.write_all(b"pwned").unwrap();
        zip.finish().unwrap();

        let (mgr, _t) = manager();
        let result = mgr.install(&path, true, false);
        assert!(
            matches!(result, Err(PluginManagerError::UnsafePath(_))),
            "got: {result:?}"
        );
        assert!(!mgr.root().join("evil").exists());
        assert!(!tmp.path().join("escaped.txt").exists());
    }

    #[test]
    fn scan_skips_dirs_without_valid_manifest() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("real", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        // A stray directory with no manifest, and one with garbage.
        std::fs::create_dir_all(mgr.root().join("stray")).unwrap();
        std::fs::create_dir_all(mgr.root().join("broken")).unwrap();
        std::fs::write(mgr.root().join("broken").join(MANIFEST_FILE_NAME), "{ bad").unwrap();

        let list = mgr.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].manifest.id, "real");
    }

    #[test]
    fn lifecycle_hook_error_surfaces_as_error_state() {
        struct FailingHook;
        impl PluginLifecycleHook for FailingHook {
            fn on_enable(&self, _plugin: &InstalledPlugin) -> Result<(), String> {
                Err("boom".into())
            }
        }

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");
        let mgr = PluginManager::with_hook(root, Arc::new(FailingHook));
        let pkg = make_package(tmp.path(), &manifest_json("hooked", "1.0"), &[]);

        // Install runs on_enable, which fails: state is Error with the message.
        let installed = mgr.install(&pkg, true, false).unwrap();
        assert_eq!(installed.state, PluginState::Error);
        assert_eq!(installed.error_message.as_deref(), Some("boom"));

        // But the plugin is on disk and enabled; a plain scan (no hook) reports
        // it as installed.
        assert!(mgr.root().join("hooked").exists());
    }

    #[test]
    fn install_refuses_untrusted_source_without_acceptance() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("untrusted", "1.0"), &[]);

        // Every package is unsigned → untrusted; installing without accepting
        // the risk is refused before anything is extracted.
        assert!(matches!(
            mgr.install(&pkg, false, false),
            Err(PluginManagerError::UntrustedSourceNotAccepted)
        ));
        assert!(!mgr.root().join("untrusted").exists());

        // The trust assessment surfaces the warning the UI shows.
        let trust = mgr.assess_trust(&pkg);
        assert!(trust.requires_acceptance());
        assert!(!trust.warning.is_empty());

        // Accepting the risk installs it.
        let installed = mgr.install(&pkg, true, false).unwrap();
        assert_eq!(installed.manifest.id, "untrusted");
        assert!(mgr.root().join("untrusted").exists());
    }

    /// Sign an on-disk package in place, returning the key that signed it.
    fn sign(pkg: &Path) -> crate::plugin::SigningKeyFile {
        let key = crate::plugin::generate_keypair("Test Publisher");
        crate::plugin::sign_package(pkg, &key).unwrap();
        key
    }

    #[test]
    fn install_verified_key_needs_no_acceptance() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("verified", "1.0"), &[]);
        let key = sign(&pkg);
        // Pin the key so the package assesses as Verified.
        mgr.pin_publisher(&key.key_id, &key.public_key, "Test Publisher")
            .unwrap();

        assert_eq!(
            mgr.assess_trust(&pkg).level,
            TrustLevel::Verified {
                publisher: "Test Publisher".into()
            }
        );
        // Installs with neither accept_untrusted nor trust_publisher.
        let installed = mgr.install(&pkg, false, false).unwrap();
        assert_eq!(installed.manifest.id, "verified");
        assert!(mgr.root().join("verified").exists());
    }

    #[test]
    fn install_signed_unknown_pins_key_on_trust() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("signed", "1.0"), &[]);
        let key = sign(&pkg);

        // Signed-but-unknown: installs without accept_untrusted, and pins the key
        // when the user opts in — after which it re-assesses as Verified.
        assert!(matches!(
            mgr.assess_trust(&pkg).level,
            TrustLevel::Signed { .. }
        ));
        let installed = mgr.install(&pkg, false, true).unwrap();
        assert_eq!(installed.manifest.id, "signed");

        assert!(mgr
            .trusted_publishers()
            .unwrap()
            .iter()
            .any(|p| p.key_id == key.key_id));
        assert!(matches!(
            mgr.assess_trust(&pkg).level,
            TrustLevel::Verified { .. }
        ));
    }

    #[test]
    fn install_signed_unknown_without_trust_does_not_pin() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("once", "1.0"), &[]);
        let key = sign(&pkg);

        // Install once without pinning — allowed, but the key is not trusted.
        mgr.install(&pkg, false, false).unwrap();
        assert!(!mgr
            .trusted_publishers()
            .unwrap()
            .iter()
            .any(|p| p.key_id == key.key_id));
    }

    #[test]
    fn install_blocks_tampered_package_with_no_override() {
        use crate::plugin::{
            generate_keypair, sha256_digest, sign_digests, signing_key_from_base64,
        };
        let (mgr, tmp) = manager();

        // A valid manifest, but a signature.json whose digest is over different
        // bytes than the actual manifest → digest mismatch → Tampered.
        let key = generate_keypair("Attacker");
        let signing_key = signing_key_from_base64(&key.private_key).unwrap();
        let digests =
            std::iter::once((MANIFEST_FILE_NAME.to_owned(), sha256_digest(b"different"))).collect();
        let sig = sign_digests(&signing_key, digests, "t".into());
        let sig_json = serde_json::to_vec(&sig).unwrap();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("evil", "1.0"),
            &[("signature.json", &sig_json)],
        );

        assert_eq!(mgr.assess_trust(&pkg).level, TrustLevel::Tampered);
        // Blocked even with both flags set — a tampered signature has no override.
        assert!(matches!(
            mgr.install(&pkg, true, true),
            Err(PluginManagerError::SignatureTampered)
        ));
        assert!(!mgr.root().join("evil").exists());
    }

    /// Read a single entry's bytes from a `.termihub-plugin` on disk.
    fn read_zip_entry(pkg: &Path, name: &str) -> Vec<u8> {
        let file = std::fs::File::open(pkg).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        buf
    }

    #[test]
    fn extract_binds_signed_package_and_writes_verified_bytes() {
        // The happy path: extracting a signed package whose bytes match the
        // signer the trust gate approved writes every entry to disk.
        let tmp = TempDir::new().unwrap();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("bound", "1.0"),
            &[("backend/lib.so", b"\x7fELF-GOOD")],
        );
        let key = sign(&pkg);

        let dest = tmp.path().join("out");
        extract_package(&pkg, &dest, Some(&key.key_id)).unwrap();
        assert!(dest.join(MANIFEST_FILE_NAME).exists());
        assert_eq!(
            std::fs::read(dest.join("backend/lib.so")).unwrap(),
            b"\x7fELF-GOOD"
        );
    }

    #[test]
    fn extract_rejects_content_altered_between_verify_and_extract() {
        // Regression for #2045 (verify-then-use TOCTOU): the trust gate verified a
        // signed package under `key`, then the package file was swapped for one
        // whose backend bytes differ from what was signed (its old signature.json
        // reused). Extraction must re-bind to the signed digest map and refuse,
        // never landing the attacker's bytes on disk.
        let tmp = TempDir::new().unwrap();
        let good = make_package(
            tmp.path(),
            &manifest_json("toctou", "1.0"),
            &[("backend/lib.so", b"GOOD-BYTES")],
        );
        let key = sign(&good);
        let sig_json = read_zip_entry(&good, signature::SIGNATURE_FILE_NAME);

        // The swapped-in archive: same manifest, ATTACKER backend bytes, but the
        // original signature.json (signed over the GOOD bytes) reused verbatim.
        let evil_dir = tmp.path().join("evil");
        std::fs::create_dir_all(&evil_dir).unwrap();
        let tampered = make_package(
            &evil_dir,
            &manifest_json("toctou", "1.0"),
            &[
                ("backend/lib.so", b"ATTACKER-BYTES"),
                (signature::SIGNATURE_FILE_NAME, &sig_json),
            ],
        );

        let dest = tmp.path().join("out");
        let err = extract_package(&tampered, &dest, Some(&key.key_id)).unwrap_err();
        assert!(matches!(err, PluginManagerError::SignatureTampered));
        // Nothing signed-but-mismatched was written.
        assert!(!dest.join("backend/lib.so").exists());
    }

    #[test]
    fn extract_rejects_swap_to_a_different_signer() {
        // The gate approved signer A; the file was swapped for a package validly
        // signed by a *different* key B. Even though B's signature is internally
        // valid, extraction must refuse — the bytes are not the ones the gate
        // trusted.
        let tmp = TempDir::new().unwrap();
        let approved = make_package(tmp.path(), &manifest_json("signer", "1.0"), &[]);
        let key_a = sign(&approved);

        let other_dir = tmp.path().join("other");
        std::fs::create_dir_all(&other_dir).unwrap();
        let other = make_package(&other_dir, &manifest_json("signer", "1.0"), &[]);
        let key_b = sign(&other);
        assert_ne!(key_a.key_id, key_b.key_id);

        let dest = tmp.path().join("out");
        let err = extract_package(&other, &dest, Some(&key_a.key_id)).unwrap_err();
        assert!(matches!(err, PluginManagerError::SignatureTampered));
        assert!(!dest.join(MANIFEST_FILE_NAME).exists());
    }

    #[test]
    fn extract_rejects_signed_to_unsigned_swap() {
        // The gate verified a signature; the file was swapped for an unsigned
        // package. A signature the gate saw must still be present at extract time.
        let tmp = TempDir::new().unwrap();
        let unsigned = make_package(tmp.path(), &manifest_json("dropped", "1.0"), &[]);
        let dest = tmp.path().join("out");
        let err = extract_package(&unsigned, &dest, Some("sha256:approved")).unwrap_err();
        assert!(matches!(err, PluginManagerError::SignatureTampered));
        assert!(!dest.join(MANIFEST_FILE_NAME).exists());
    }

    #[test]
    fn extract_rejects_an_entry_over_the_decompression_budget() {
        // A package entry whose decompressed size exceeds the per-entry cap is
        // rejected while extracting, not read into memory — the extraction-path
        // half of the zip-bomb guard (#2046). Unsigned + `None` so the signature
        // binding does not short-circuit before the read.
        let tmp = TempDir::new().unwrap();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("bomb", "1.0"),
            &[("bomb.bin", &[0u8; 4096])],
        );
        let dest = tmp.path().join("out");
        let err = extract_package_with_limits(&pkg, &dest, None, 64, 1_000_000).unwrap_err();
        assert!(
            matches!(&err, PluginManagerError::Io(e) if e.kind() == std::io::ErrorKind::InvalidData),
            "expected an InvalidData io error, got: {err:?}"
        );
    }

    #[test]
    fn extract_rejects_when_total_budget_is_exhausted() {
        // Every entry is under the per-entry cap, but their sum blows the whole-
        // package budget — the running total must catch it on the extract path.
        let tmp = TempDir::new().unwrap();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("many", "1.0"),
            &[("a.bin", &[0u8; 400]), ("b.bin", &[0u8; 400])],
        );
        let dest = tmp.path().join("out");
        let err = extract_package_with_limits(&pkg, &dest, None, 10_000, 600).unwrap_err();
        assert!(
            matches!(&err, PluginManagerError::Io(e) if e.kind() == std::io::ErrorKind::InvalidData),
            "expected an InvalidData io error, got: {err:?}"
        );
    }

    #[test]
    fn extract_accepts_content_within_the_budget() {
        // Content comfortably under both budgets still extracts — the guard does
        // not reject legitimate packages.
        let tmp = TempDir::new().unwrap();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("ok", "1.0"),
            &[("backend/lib.so", b"\x7fELF-small")],
        );
        let dest = tmp.path().join("out");
        extract_package_with_limits(&pkg, &dest, None, 1_000_000, 1_000_000)
            .expect("content within budget must extract");
        assert_eq!(
            std::fs::read(dest.join("backend/lib.so")).unwrap(),
            b"\x7fELF-small"
        );
    }

    #[test]
    fn install_verified_signed_package_with_files_lands_on_disk() {
        // End-to-end: a signed package with real backend bytes, whose key is
        // trusted, still installs as Verified and lands every file — the binding
        // does not break the happy path.
        let (mgr, tmp) = manager();
        let pkg = make_package(
            tmp.path(),
            &manifest_json("verified-files", "1.0"),
            &[("backend/lib.so", b"\x7fELF-REAL")],
        );
        let key = sign(&pkg);
        mgr.pin_publisher(&key.key_id, &key.public_key, "Test Publisher")
            .unwrap();
        assert_eq!(
            mgr.assess_trust(&pkg).level,
            TrustLevel::Verified {
                publisher: "Test Publisher".into()
            }
        );

        let installed = mgr.install(&pkg, false, false).unwrap();
        assert_eq!(installed.manifest.id, "verified-files");
        let dir = mgr.root().join("verified-files");
        assert!(dir.join(MANIFEST_FILE_NAME).exists());
        assert_eq!(
            std::fs::read(dir.join("backend/lib.so")).unwrap(),
            b"\x7fELF-REAL"
        );
    }

    #[test]
    fn revoke_returns_signed_to_unknown() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("rev", "1.0"), &[]);
        let key = sign(&pkg);
        mgr.pin_publisher(&key.key_id, &key.public_key, "Pub")
            .unwrap();
        assert!(matches!(
            mgr.assess_trust(&pkg).level,
            TrustLevel::Verified { .. }
        ));

        // Revoking drops the package back to Signed (unknown).
        mgr.revoke_publisher(&key.key_id).unwrap();
        assert!(matches!(
            mgr.assess_trust(&pkg).level,
            TrustLevel::Signed { .. }
        ));
    }

    #[test]
    fn reconcile_disables_incompatible_after_api_bump() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("legacy", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        // Simulate a host upgrade under the plugin: its manifest now targets an
        // incompatible API version.
        let manifest_path = mgr.root().join("legacy").join(MANIFEST_FILE_NAME);
        std::fs::write(&manifest_path, manifest_json("legacy", "2.0")).unwrap();

        // Reconcile auto-disables it and reports it for notification.
        let disabled = mgr.reconcile_compatibility().unwrap();
        assert_eq!(disabled, vec!["legacy".to_string()]);
        // The persisted enabled flag is now off.
        assert!(!mgr.read_state_store().unwrap().plugins["legacy"].enabled);
        // Idempotent: a second run finds nothing (already disabled).
        assert!(mgr.reconcile_compatibility().unwrap().is_empty());
    }

    #[test]
    fn load_enabled_plugins_loads_enabled_and_skips_disabled_and_incompatible() {
        // A hook that records the ids it is asked to load, so we can assert the
        // startup path fires `on_enable` for exactly the enabled+compatible ones.
        #[derive(Default)]
        struct RecordingHook {
            enabled: Mutex<Vec<String>>,
        }
        impl PluginLifecycleHook for RecordingHook {
            fn on_enable(&self, plugin: &InstalledPlugin) -> Result<(), String> {
                self.enabled
                    .lock()
                    .unwrap()
                    .push(plugin.manifest.id.clone());
                Ok(())
            }
        }

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");

        // Session 1: install three plugins with a plain (no-op) manager, then
        // disable one and bump another to an incompatible API version — the state
        // a previous session would persist.
        {
            let mgr = PluginManager::new(&root);
            for id in ["keep-on", "turn-off", "too-new"] {
                let pkg_dir = TempDir::new().unwrap();
                let pkg = make_package(pkg_dir.path(), &manifest_json(id, "1.0"), &[]);
                mgr.install(&pkg, true, false).unwrap();
            }
            mgr.disable("turn-off").unwrap();
            // Make "too-new" incompatible by rewriting its manifest.
            let manifest_path = root.join("too-new").join(MANIFEST_FILE_NAME);
            std::fs::write(&manifest_path, manifest_json("too-new", "2.0")).unwrap();
        }

        // Session 2 (simulated restart): a manager with the recording hook. The
        // startup load must fire on_enable for the enabled+compatible plugin only.
        let hook = Arc::new(RecordingHook::default());
        let mgr2 = PluginManager::with_hook(&root, hook.clone());
        let loaded = mgr2.load_enabled_plugins().unwrap();

        assert_eq!(
            hook.enabled.lock().unwrap().as_slice(),
            &["keep-on".to_string()],
            "only the enabled, compatible plugin should be loaded"
        );
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].manifest.id, "keep-on");
        assert_eq!(loaded[0].state, PluginState::Installed);
        assert!(loaded[0].error_message.is_none());
    }

    #[test]
    fn load_enabled_plugins_surfaces_a_failure_as_error_without_aborting() {
        // Fails to load one specific plugin; every other load succeeds.
        struct FailFor(&'static str);
        impl PluginLifecycleHook for FailFor {
            fn on_enable(&self, plugin: &InstalledPlugin) -> Result<(), String> {
                if plugin.manifest.id == self.0 {
                    Err("boom".into())
                } else {
                    Ok(())
                }
            }
        }

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");
        {
            let mgr = PluginManager::new(&root);
            for id in ["broken", "healthy"] {
                let pkg_dir = TempDir::new().unwrap();
                let pkg = make_package(pkg_dir.path(), &manifest_json(id, "1.0"), &[]);
                mgr.install(&pkg, true, false).unwrap();
            }
        }

        let mgr2 = PluginManager::with_hook(&root, Arc::new(FailFor("broken")));
        let loaded = mgr2.load_enabled_plugins().unwrap();

        // Both enabled+compatible plugins were attempted; the failing one surfaces
        // as Error with its message, the other loads cleanly — startup carried on.
        let broken = loaded.iter().find(|p| p.manifest.id == "broken").unwrap();
        assert_eq!(broken.state, PluginState::Error);
        assert_eq!(broken.error_message.as_deref(), Some("boom"));
        let healthy = loaded.iter().find(|p| p.manifest.id == "healthy").unwrap();
        assert_eq!(healthy.state, PluginState::Installed);
        assert!(healthy.error_message.is_none());
    }

    #[test]
    fn reconcile_leaves_compatible_plugins_enabled() {
        let (mgr, tmp) = manager();
        let pkg = make_package(tmp.path(), &manifest_json("fine", "1.0"), &[]);
        mgr.install(&pkg, true, false).unwrap();

        assert!(mgr.reconcile_compatibility().unwrap().is_empty());
        assert!(mgr.read_state_store().unwrap().plugins["fine"].enabled);
        assert_eq!(mgr.get("fine").unwrap().state, PluginState::Installed);
    }
}
