//! The native plugin **host loader** (#1995).
//!
//! Where [`super::manager::PluginManager`] owns what is *installed*, this module
//! owns what is *loaded*: it opens a plugin's backend dynamic library
//! (`.dll` / `.so` / `.dylib`) with [`libloading`], resolves the stable-ABI
//! entry symbols defined by [`termihub_plugin_api`], validates the reported ABI
//! version, and keeps the loaded library alive for as long as any session it
//! produced. A loaded backend is exposed to the rest of termiHub as an ordinary
//! [`ConnectionType`](crate::connection::ConnectionType) (see
//! [`super::connection::PluginConnectionType`]), registered into the shared
//! [`ConnectionTypeRegistry`].
//!
//! # ABI soundness
//!
//! The original plugin-system concept sketched returning
//! `*mut dyn PluginTerminalBackend` across `extern "C"`. A Rust `dyn Trait` fat
//! pointer has **no stable ABI** across separately-compiled dynamic libraries, so
//! that sketch is undefined behavior. This loader instead speaks only the
//! hand-rolled, `#[repr(C)]` opaque-handle ABI established by
//! [`termihub_plugin_api`] (#1990): the plugin returns an opaque state pointer
//! plus a `#[repr(C)]` vtable of `extern "C"` function pointers, which the host
//! drives through the crate's safe
//! [`LoadedBackend`](termihub_plugin_api::LoadedBackend) wrapper.
//!
//! # Keeping the library alive
//!
//! Every backend a plugin creates dispatches through function pointers that live
//! *inside* the loaded library (the vtable and the backend `state`). Unloading
//! the library while a session is live would leave those pointers dangling —
//! undefined behavior. So [`LoadedLibrary`] is reference-counted
//! ([`Arc`]): each live [`PluginConnectionType`] holds a clone, and the
//! underlying `libloading::Library` is only dropped (unloaded) once the host's
//! registration **and** every session created from it are gone.
//!
//! [`PluginConnectionType`]: super::connection::PluginConnectionType

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use libloading::{Library, Symbol};
use termihub_plugin_api::symbols::{
    PluginAbiVersionFn, PluginCreateBackendFn, PluginInitFn, PluginShutdownFn,
    SYMBOL_PLUGIN_ABI_VERSION, SYMBOL_PLUGIN_CREATE_BACKEND, SYMBOL_PLUGIN_INIT,
    SYMBOL_PLUGIN_SHUTDOWN,
};
use termihub_plugin_api::{
    LoadedBackend, PluginBackend, PluginError, PluginHostBridge, PluginInfo, PluginOutputSender,
    PluginSessionConfig, CURRENT_PLUGIN_API_VERSION,
};

use crate::connection::ConnectionTypeRegistry;

use super::capabilities::ConnectionPolicy;
use super::connection::PluginConnectionType;
use super::manager::InstalledPlugin;
use super::security::{PermissionError, PermissionSet, RecoveryAction, RestartTracker};

/// Everything that can go wrong while loading a plugin's backend library.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// No file with the current platform's dynamic-library extension was found
    /// under the plugin's `backend/` directory.
    #[error("no backend library found in `{0}`")]
    LibraryNotFound(PathBuf),

    /// The dynamic library could not be opened (missing dependency, wrong
    /// architecture, corrupt file, …).
    #[error("failed to open plugin library `{path}`: {source}")]
    Open {
        /// The library path that failed to open.
        path: PathBuf,
        /// The underlying `libloading` error.
        source: libloading::Error,
    },

    /// A required exported symbol was missing from the library.
    #[error("plugin library is missing the required symbol `{0}`")]
    MissingSymbol(String),

    /// The library reported an ABI version this host cannot load.
    #[error("plugin ABI version mismatch: host supports {expected}, plugin built against {found}")]
    IncompatibleAbi {
        /// ABI version this host supports ([`CURRENT_PLUGIN_API_VERSION`]).
        expected: u32,
        /// ABI version the plugin reported.
        found: u32,
    },

    /// The plugin's `plugin_init` entry point reported a failure.
    #[error("plugin initialization failed: {0}")]
    Init(String),

    /// The plugin's declared permissions are inconsistent with what it provides
    /// (e.g. a terminal backend without the `terminal` permission), so it is
    /// refused rather than loaded with a capability it never requested.
    #[error("plugin permission check failed: {0}")]
    Permission(#[from] PermissionError),

    /// A plugin entry point unwound (panicked) across the FFI boundary. The host
    /// contains the unwind and refuses the plugin rather than letting it abort
    /// the process.
    #[error("plugin panicked during `{0}`")]
    Panicked(&'static str),
}

impl HostError {
    /// Whether this failure is specifically an ABI/version incompatibility, as
    /// opposed to a load or initialization error. The management layer maps the
    /// two to different plugin states.
    #[must_use]
    pub fn is_incompatible(&self) -> bool {
        matches!(self, HostError::IncompatibleAbi { .. })
    }
}

/// Metadata a loaded plugin reported through `plugin_init`, copied out of the
/// FFI-owned [`PluginInfo`] into owned Rust strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedPluginInfo {
    /// Stable plugin identifier the library reported.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// The plugin's own semantic version.
    pub version: String,
    /// ABI version the plugin was built against.
    pub api_version: u32,
}

impl LoadedPluginInfo {
    fn from_ffi(info: &PluginInfo) -> Self {
        Self {
            id: info.id.as_str().to_owned(),
            name: info.name.as_str().to_owned(),
            version: info.version.as_str().to_owned(),
            api_version: info.api_version,
        }
    }
}

/// A loaded plugin backend library plus its resolved entry points.
///
/// Reference-counted via [`Arc`] so it outlives every session it produces (see
/// the module docs). The `library` field is declared **last** so it is dropped
/// last: [`Drop`] calls the plugin's `shutdown` entry point while the library is
/// still mapped, then the library unloads.
pub struct LoadedLibrary {
    info: LoadedPluginInfo,
    /// Resolved `plugin_create_backend`. Valid as long as `library` is loaded.
    create_backend: PluginCreateBackendFn,
    /// Resolved `plugin_shutdown`, called once on drop.
    shutdown: PluginShutdownFn,
    /// The open library. Never read directly — held solely to keep the mapping
    /// alive (the resolved function pointers point into it) and to unmap on drop.
    /// **Must be the last field** so it is dropped last, after [`Drop`] runs.
    #[allow(dead_code)]
    library: Library,
}

// SAFETY: `libloading::Library` is `Send + Sync`; the resolved function pointers
// are plain `extern "C"` pointers into that library. The plugin ABI requires
// backends and their entry points to be callable from any thread (see
// `termihub_plugin_api`), so sharing a `LoadedLibrary` across threads is sound.
unsafe impl Send for LoadedLibrary {}
unsafe impl Sync for LoadedLibrary {}

impl LoadedLibrary {
    /// Metadata this plugin reported at load time.
    #[must_use]
    pub fn info(&self) -> &LoadedPluginInfo {
        &self.info
    }

    /// Create a new backend session from this plugin.
    ///
    /// Calls the plugin's `create_backend` entry point with the borrowed
    /// `config_json`, the host-owned `output` sink, and the host capability
    /// `bridge`, returning a safe [`LoadedBackend`] wrapper on success. The
    /// `bridge` is the plugin's permission-checked route to network/filesystem
    /// access (#2018); ownership of it transfers to the plugin. The returned
    /// backend borrows nothing from `config_json` (the plugin copies what it needs
    /// before the call returns), but it *does* depend on this library staying
    /// loaded — callers must keep an `Arc<LoadedLibrary>` alive for the backend's
    /// lifetime.
    pub fn create_backend(
        &self,
        config_json: &str,
        output: PluginOutputSender,
        bridge: PluginHostBridge,
    ) -> Result<LoadedBackend, PluginError> {
        let config = PluginSessionConfig::new(config_json);
        let mut backend = PluginBackend {
            state: std::ptr::null_mut(),
            vtable: std::ptr::null(),
        };
        // SAFETY: `config` outlives the call; `output` and `bridge` ownership are
        // transferred to the plugin; `&mut backend` is a valid out-parameter. The
        // plugin writes a valid `PluginBackend` on `Ok`. The call is wrapped in
        // `catch_unwind` so a panic inside the plugin's entry point is contained
        // rather than unwinding across the FFI boundary (undefined behavior) — a
        // misbehaving plugin must not crash the host (concept "Error recovery").
        let create_backend = self.create_backend;
        let status = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            create_backend(&config, output, bridge, &mut backend)
        }))
        .map_err(|_| PluginError::Panicked)?;
        status.into_result()?;
        // SAFETY: on `Ok` the plugin has written a live backend produced by the
        // same library, whose ownership now transfers to the wrapper.
        Ok(unsafe { LoadedBackend::from_raw(backend) })
    }
}

impl Drop for LoadedLibrary {
    fn drop(&mut self) {
        // Give the plugin a chance to release process-wide resources before the
        // library unmaps. Contain any panic rather than unwinding across FFI.
        let shutdown = self.shutdown;
        // SAFETY: `shutdown` is a valid entry point in the still-loaded library.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { shutdown() }));
    }
}

/// Locate the backend dynamic library inside a plugin directory.
///
/// Looks in `<plugin_dir>/backend/` for the first file whose extension matches
/// the current platform's dynamic-library extension
/// ([`std::env::consts::DLL_EXTENSION`] — `dll` / `so` / `dylib`). A package may
/// ship all three; this picks the one this OS can load.
pub fn find_backend_library(plugin_dir: &Path) -> Result<PathBuf, HostError> {
    let backend_dir = plugin_dir.join("backend");
    let ext = std::env::consts::DLL_EXTENSION;
    let entries = std::fs::read_dir(&backend_dir)
        .map_err(|_| HostError::LibraryNotFound(backend_dir.clone()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            return Ok(path);
        }
    }
    Err(HostError::LibraryNotFound(backend_dir))
}

/// Open a plugin backend library, validate its ABI version, and resolve its
/// entry points.
///
/// The sequence is deliberately ordered so nothing calls into the plugin before
/// the ABI check passes:
///
/// 1. `dlopen` the library.
/// 2. Resolve and call `termihub_plugin_abi_version`; reject a mismatch.
/// 3. Resolve and call `termihub_plugin_init` to read [`PluginInfo`].
/// 4. Resolve `create_backend` and `shutdown` for later use.
///
/// On any failure the (partially) opened library is dropped, so a rejected
/// plugin leaves nothing loaded.
pub fn load_backend_library(library_path: &Path) -> Result<Arc<LoadedLibrary>, HostError> {
    // SAFETY: opening an arbitrary library runs its initializers; this is the
    // irreducible unsafety of a plugin host. Failures are returned, not panicked.
    let library = unsafe { Library::new(library_path) }.map_err(|source| HostError::Open {
        path: library_path.to_owned(),
        source,
    })?;

    // --- 1. ABI version gate, before anything else is called. ---
    let found = {
        // SAFETY: resolving a symbol to its documented type alias; the pointer is
        // only used while `library` is alive.
        let abi_version: Symbol<PluginAbiVersionFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_ABI_VERSION)
                .map_err(|_| HostError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_ABI_VERSION)))?
        };
        // Copy out the plain `extern "C"` fn pointer (`Copy`, `UnwindSafe`) so the
        // `catch_unwind` closure does not capture the `Symbol` borrow.
        let abi_version_fn = *abi_version;
        // SAFETY: the plugin's abi-version entry point takes no arguments and
        // returns a plain `u32`. Contained in `catch_unwind` so a panicking plugin
        // cannot unwind across FFI and abort the host.
        std::panic::catch_unwind(|| unsafe { abi_version_fn() })
            .map_err(|_| HostError::Panicked("plugin_abi_version"))?
    };
    if found != CURRENT_PLUGIN_API_VERSION {
        return Err(HostError::IncompatibleAbi {
            expected: CURRENT_PLUGIN_API_VERSION,
            found,
        });
    }

    // --- 2. Read plugin metadata. ---
    let info = {
        // SAFETY: resolving `plugin_init` to its type alias.
        let init: Symbol<PluginInitFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_INIT)
                .map_err(|_| HostError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_INIT)))?
        };
        let init_fn = *init;
        let mut info = PluginInfo::empty();
        // SAFETY: `&mut info` is a valid out-parameter the plugin fills in; on a
        // non-`Ok` status it leaves the empty placeholder untouched. Contained in
        // `catch_unwind` so a panic in `plugin_init` cannot unwind across FFI.
        let status = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            init_fn(&mut info)
        }))
        .map_err(|_| HostError::Panicked("plugin_init"))?;
        status
            .into_result()
            .map_err(|e| HostError::Init(e.to_string()))?;
        LoadedPluginInfo::from_ffi(&info)
    };

    // --- 3. Resolve the remaining entry points and detach them from the borrow. ---
    // We store the raw function pointers alongside the owned `Library` so they
    // stay valid for the library's whole lifetime.
    let create_backend: PluginCreateBackendFn = {
        // SAFETY: resolving `plugin_create_backend` to its type alias.
        let sym: Symbol<PluginCreateBackendFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_CREATE_BACKEND)
                .map_err(|_| HostError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_CREATE_BACKEND)))?
        };
        *sym
    };
    let shutdown: PluginShutdownFn = {
        // SAFETY: resolving `plugin_shutdown` to its type alias.
        let sym: Symbol<PluginShutdownFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_SHUTDOWN)
                .map_err(|_| HostError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_SHUTDOWN)))?
        };
        *sym
    };

    Ok(Arc::new(LoadedLibrary {
        info,
        create_backend,
        shutdown,
        library,
    }))
}

/// Render a NUL-terminated symbol constant as a printable name for errors.
fn symbol_name(sym: &[u8]) -> String {
    String::from_utf8_lossy(sym.strip_suffix(b"\0").unwrap_or(sym)).into_owned()
}

/// Pick a registry key for a plugin's declared connection type that does not
/// collide with anything already registered.
///
/// If `desired` is free it is used unchanged (the first registrant of a name
/// wins). Otherwise it is suffixed with the plugin `id` — and, in the vanishingly
/// unlikely event that is *also* taken, with a numeric counter — so a second
/// plugin declaring the same `connectionType`, or one colliding with a built-in,
/// still registers under a distinct, stable id (concept "Edge Cases").
fn disambiguate_type_id(
    desired: &str,
    plugin_id: &str,
    registry: &ConnectionTypeRegistry,
) -> String {
    if !registry.has_type(desired) {
        return desired.to_string();
    }
    let suffixed = format!("{desired}-{plugin_id}");
    if !registry.has_type(&suffixed) {
        return suffixed;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{suffixed}-{n}");
        if !registry.has_type(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// A record of one loaded plugin: the connection type it registered and the
/// library backing it.
struct HostEntry {
    connection_type: String,
    #[allow(dead_code)] // Held to keep the library loaded for the plugin's lifetime.
    library: Arc<LoadedLibrary>,
}

/// The result of driving [`PluginHost::note_failure`]: what the host decided to
/// do with a plugin after a runtime failure, following the concept's recovery
/// policy (auto-restart up to [`MAX_RESTART_ATTEMPTS`], then auto-disable).
///
/// [`MAX_RESTART_ATTEMPTS`]: super::security::MAX_RESTART_ATTEMPTS
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// The plugin should be reloaded; the restart budget is not yet exhausted.
    /// The caller re-enables the plugin (or the host reloads it) to retry.
    Restart,
    /// The restart budget is exhausted; the host has unloaded the plugin and it
    /// should be persisted as disabled and surfaced to the user.
    Disabled,
}

/// The runtime plugin host: loads backend libraries and registers the resulting
/// connection types into a shared [`ConnectionTypeRegistry`].
///
/// This is the object a [`super::PluginLifecycleHook`] drives — enabling a
/// plugin [`load`](PluginHost::load)s it, disabling/uninstalling it
/// [`unload`](PluginHost::unload)s it. The `<app-data>/plugins/` root is used to
/// find each plugin's directory by id.
pub struct PluginHost {
    root: PathBuf,
    registry: Arc<Mutex<ConnectionTypeRegistry>>,
    loaded: Mutex<HashMap<String, HostEntry>>,
    /// Ids the host has successfully activated, so the management layer can
    /// promote them to [`PluginState::Active`](super::PluginState). This is a
    /// superset of [`loaded`](Self::loaded): a **frontend-only** plugin (theme /
    /// JS parser / widget, no `terminalBackend` library) is active once its
    /// [`load`](Self::load) succeeds even though it registers no connection type,
    /// so it is tracked here but not in `loaded`.
    active: Mutex<HashSet<String>>,
    /// Per-plugin error-recovery counters (concept "Error recovery state
    /// machine"). Keyed by plugin id; created lazily on first failure.
    recovery: Mutex<HashMap<String, RestartTracker>>,
}

impl PluginHost {
    /// Create a host rooted at `plugins_root` that registers loaded plugin
    /// connection types into `registry`.
    pub fn new(
        plugins_root: impl Into<PathBuf>,
        registry: Arc<Mutex<ConnectionTypeRegistry>>,
    ) -> Self {
        Self {
            root: plugins_root.into(),
            registry,
            loaded: Mutex::new(HashMap::new()),
            active: Mutex::new(HashSet::new()),
            recovery: Mutex::new(HashMap::new()),
        }
    }

    /// The shared connection-type registry this host feeds.
    #[must_use]
    pub fn registry(&self) -> &Arc<Mutex<ConnectionTypeRegistry>> {
        &self.registry
    }

    /// Whether a plugin id currently has a loaded **backend library**. A
    /// frontend-only plugin (no `terminalBackend`) is never "loaded" in this
    /// sense even when active — use [`is_active`](Self::is_active) for the
    /// activation state the management layer promotes on.
    #[must_use]
    pub fn is_loaded(&self, id: &str) -> bool {
        self.loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
    }

    /// Whether a plugin id is currently **active** — its [`load`](Self::load)
    /// succeeded and it has not since been unloaded. Unlike
    /// [`is_loaded`](Self::is_loaded) this is `true` for a frontend-only plugin
    /// (theme / JS, no backend library) too. The management layer queries this
    /// to promote an enabled, compatible plugin to
    /// [`PluginState::Active`](super::PluginState).
    #[must_use]
    pub fn is_active(&self, id: &str) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id)
    }

    /// Load a plugin's backend and register its connection type.
    ///
    /// A plugin that declares **no** `terminalBackend` extension has no native
    /// library to load, so this is a no-op success (its themes/JS are handled by
    /// other loaders). If a backend *is* declared, the library is opened,
    /// ABI-checked, and its connection type registered. Re-loading an
    /// already-loaded id unloads the previous instance first.
    ///
    /// The [`HostError`] is returned for the caller to map to a plugin state; an
    /// [`HostError::is_incompatible`] failure is a version problem, everything
    /// else is a load error.
    pub fn load(&self, plugin: &InstalledPlugin) -> Result<(), HostError> {
        // Enforce the permission model before any library is opened: a plugin
        // whose declared extensions need a capability it did not request (e.g. a
        // terminal backend without the `terminal` permission, or `filesystem`
        // without declared paths) is refused. This surfaces as
        // `PluginState::Error` — graceful degradation, not a crash.
        let permissions = PermissionSet::from_manifest(&plugin.manifest);
        permissions.check_consistency(&plugin.manifest.extensions)?;

        let Some(backend) = plugin.manifest.extensions.terminal_backend.as_ref() else {
            // Frontend-only plugin (theme / JS parser / widget): there is no
            // native library to open, but activation still succeeded — the
            // frontend loaders pick it up once its state is `Active`. Record it
            // as active so the management layer promotes it (#2234).
            self.active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(plugin.manifest.id.clone());
            return Ok(());
        };

        let id = plugin.manifest.id.clone();
        // Replace any prior load of the same id.
        self.unload(&id);

        let plugin_dir = self.root.join(&id);
        let lib_path = find_backend_library(&plugin_dir)?;
        let library = load_backend_library(&lib_path)?;

        // Translate the plugin's declared `configSchema` into the form schema the
        // dynamic connection editor renders (#1999). Derived once here and cloned
        // into every instance the factory produces.
        let settings_schema =
            super::connection::config_schema_to_settings_schema(&backend.config_schema);

        // Two plugins may declare the same `connectionType`, and a plugin may even
        // collide with a built-in. Disambiguate against whatever is already
        // registered by suffixing this one with the plugin id (concept "Edge
        // Cases"); the first registrant keeps the plain id.
        let connection_type = {
            let registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            disambiguate_type_id(&backend.connection_type, &id, &registry)
        };
        let display_name = if connection_type == backend.connection_type {
            backend.display_name.clone()
        } else {
            format!("{} ({})", backend.display_name, plugin.manifest.name)
        };

        let lib_for_factory = Arc::clone(&library);
        let ct_for_factory = connection_type.clone();
        let dn_for_factory = display_name.clone();
        let schema_for_factory = settings_schema;
        // Each session created for this plugin carries its own permission scope,
        // so a host-mediated capability (filesystem path resolution, network, …)
        // can enforce it per session.
        let perms_for_factory = permissions.clone();
        // Resolve the session connection policy (concurrency ceiling + connect
        // timeout) from the manifest once at load time; every session gets it
        // (#2028).
        let policy_for_factory =
            ConnectionPolicy::from_manifest(plugin.manifest.connection_policy.as_ref());

        {
            let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            registry.register(
                &connection_type,
                &display_name,
                "puzzle",
                Box::new(move || {
                    Box::new(
                        PluginConnectionType::new(
                            Arc::clone(&lib_for_factory),
                            ct_for_factory.clone(),
                            dn_for_factory.clone(),
                            schema_for_factory.clone(),
                            perms_for_factory.clone(),
                        )
                        .with_connection_policy(policy_for_factory),
                    )
                }),
            );
        }

        self.loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id,
                HostEntry {
                    connection_type,
                    library,
                },
            );
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(plugin.manifest.id.clone());
        // A clean (re)load means the plugin is healthy again: reset any prior
        // recovery counter so a future, unrelated failure gets a full budget.
        self.clear_recovery(&plugin.manifest.id);
        Ok(())
    }

    /// Unload a plugin: unregister its connection type and drop the host's
    /// reference to the library. The library unmaps once every session created
    /// from it has also been dropped. A no-op if the id is not loaded.
    pub fn unload(&self, id: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        let entry = self
            .loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(entry) = entry {
            self.registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .unregister(&entry.connection_type);
            // `entry.library` (Arc) drops here; the OS unloads the library once
            // the last outstanding session Arc also drops.
        }
    }

    /// Record a runtime failure of a loaded plugin and apply the recovery policy
    /// (concept "Error recovery state machine").
    ///
    /// The plugin's restart counter is advanced. While the restart budget
    /// ([`MAX_RESTART_ATTEMPTS`]) is not exhausted this returns
    /// [`RecoveryOutcome::Restart`] — the caller reloads the plugin (e.g. via the
    /// manager's enable path) to retry. Once the budget is exhausted the host
    /// **unloads** the plugin and returns [`RecoveryOutcome::Disabled`], so the
    /// caller persists it as disabled and notifies the user. A failing plugin can
    /// therefore never spin forever.
    ///
    /// [`MAX_RESTART_ATTEMPTS`]: super::security::MAX_RESTART_ATTEMPTS
    pub fn note_failure(&self, id: &str) -> RecoveryOutcome {
        let action = {
            let mut recovery = self.recovery.lock().unwrap_or_else(|e| e.into_inner());
            recovery.entry(id.to_string()).or_default().record_failure()
        };
        match action {
            RecoveryAction::Restart => RecoveryOutcome::Restart,
            RecoveryAction::Disable => {
                // Budget exhausted: stop the plugin. It stays installed but is not
                // loaded until the user re-enables it (which also clears the
                // counter via `clear_recovery`).
                self.unload(id);
                RecoveryOutcome::Disabled
            }
        }
    }

    /// Clear a plugin's recovery counter — called when it is (re-)enabled or
    /// loads cleanly, so a later, unrelated failure starts from a full budget.
    pub fn clear_recovery(&self, id: &str) {
        self.recovery
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
}

/// A [`super::PluginLifecycleHook`] that drives a [`PluginHost`], so enabling or
/// disabling a plugin in the [`super::PluginManager`] actually loads or unloads
/// its native backend.
///
/// A load failure is surfaced to the manager as an error message (→
/// [`PluginState::Error`](super::PluginState)); the plugin stays installed and
/// enabled but reports the failure, and the host continues normally.
pub struct HostLifecycleHook {
    host: Arc<PluginHost>,
}

impl HostLifecycleHook {
    /// Wrap a [`PluginHost`] as a lifecycle hook.
    pub fn new(host: Arc<PluginHost>) -> Self {
        Self { host }
    }
}

impl super::manager::PluginLifecycleHook for HostLifecycleHook {
    fn on_enable(&self, plugin: &InstalledPlugin) -> Result<(), String> {
        self.host.load(plugin).map_err(|e| e.to_string())
    }

    fn on_disable(&self, id: &str) -> Result<(), String> {
        self.host.unload(id);
        Ok(())
    }

    fn is_active(&self, id: &str) -> bool {
        self.host.is_active(id)
    }

    fn on_uninstall(&self, id: &str) -> Result<(), String> {
        self.host.unload(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::PluginState;

    /// A host wired to a fresh, empty registry over a temp plugins root.
    fn test_host() -> (PluginHost, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().unwrap();
        let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
        (PluginHost::new(tmp.path().to_path_buf(), registry), tmp)
    }

    /// Build an [`InstalledPlugin`] from a manifest JSON string (Installed state).
    fn installed(manifest_json: &str) -> InstalledPlugin {
        let manifest = super::super::manifest::parse_manifest(manifest_json).expect("parses");
        InstalledPlugin {
            manifest,
            state: PluginState::Installed,
            error_message: None,
            installed_at: 0,
        }
    }

    fn manifest_json(permissions: &str, fs_paths: &str) -> String {
        let fs_line = if fs_paths.is_empty() {
            String::new()
        } else {
            format!("\"filesystemPaths\": {fs_paths},")
        };
        format!(
            r#"{{
                "id": "host-sec",
                "name": "Host Sec",
                "version": "1.0.0",
                "author": "tester",
                "description": "host security test",
                "license": "MIT",
                "apiVersion": "1.0",
                "platforms": ["linux", "macos", "windows"],
                "permissions": {permissions},
                {fs_line}
                "extensions": {{
                    "terminalBackend": {{
                        "connectionType": "host-sec",
                        "displayName": "Host Sec",
                        "configSchema": {{}}
                    }}
                }}
            }}"#
        )
    }

    #[test]
    fn load_refuses_terminal_backend_without_terminal_permission() {
        let (host, _t) = test_host();
        // Terminal backend but only the `network` permission → refused before any
        // library is opened. Graceful: the manager maps this to Error state.
        let plugin = installed(&manifest_json(r#"["network"]"#, ""));
        let err = host.load(&plugin).unwrap_err();
        assert!(
            matches!(
                err,
                HostError::Permission(PermissionError::TerminalWithoutPermission)
            ),
            "got {err:?}"
        );
        assert!(!host.is_loaded("host-sec"));
    }

    #[test]
    fn load_refuses_filesystem_permission_without_paths() {
        let (host, _t) = test_host();
        let plugin = installed(&manifest_json(r#"["terminal", "filesystem"]"#, ""));
        let err = host.load(&plugin).unwrap_err();
        assert!(
            matches!(
                err,
                HostError::Permission(PermissionError::FilesystemWithoutPaths)
            ),
            "got {err:?}"
        );
    }

    #[test]
    fn note_failure_restarts_up_to_budget_then_disables() {
        let (host, _t) = test_host();
        // Nothing is loaded, so `unload` on disable is a harmless no-op; we are
        // exercising the recovery counter the host keeps per plugin.
        for _ in 0..super::super::security::MAX_RESTART_ATTEMPTS {
            assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Restart);
        }
        assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Disabled);
        // Latches disabled.
        assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Disabled);

        // Clearing (as a re-enable would) restores the full budget.
        host.clear_recovery("crashy");
        assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Restart);
    }

    use crate::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
    use crate::errors::SessionError;
    use crate::files::FileBrowser;
    use crate::monitoring::MonitoringProvider;

    /// A do-nothing connection type, just enough for the registry to register it
    /// so [`disambiguate_type_id`] sees an occupied key.
    struct StubConnection;

    #[async_trait::async_trait]
    impl ConnectionType for StubConnection {
        fn type_id(&self) -> &str {
            "stub"
        }
        fn display_name(&self) -> &str {
            "Stub"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
            }
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            false
        }
        fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> OutputReceiver {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    fn register_stub(registry: &mut ConnectionTypeRegistry, type_id: &str) {
        registry.register(
            type_id,
            type_id,
            "puzzle",
            Box::new(|| Box::new(StubConnection)),
        );
    }

    #[test]
    fn disambiguate_leaves_a_free_id_unchanged() {
        let registry = ConnectionTypeRegistry::new();
        assert_eq!(
            disambiguate_type_id("echo", "echo-backend", &registry),
            "echo"
        );
    }

    #[test]
    fn disambiguate_suffixes_a_taken_id_with_the_plugin_id() {
        let mut registry = ConnectionTypeRegistry::new();
        register_stub(&mut registry, "echo");
        assert_eq!(
            disambiguate_type_id("echo", "second-plugin", &registry),
            "echo-second-plugin"
        );
    }

    #[test]
    fn disambiguate_appends_a_counter_when_even_the_suffix_is_taken() {
        let mut registry = ConnectionTypeRegistry::new();
        register_stub(&mut registry, "echo");
        register_stub(&mut registry, "echo-p");
        assert_eq!(disambiguate_type_id("echo", "p", &registry), "echo-p-2");
    }

    #[test]
    fn symbol_name_strips_trailing_nul() {
        assert_eq!(symbol_name(SYMBOL_PLUGIN_INIT), "termihub_plugin_init");
        assert_eq!(symbol_name(b"foo\0"), "foo");
        assert_eq!(symbol_name(b"bar"), "bar");
    }

    #[test]
    fn find_backend_library_missing_dir_is_error() {
        let tmp = tempfile::TempDir::new().unwrap();
        let err = find_backend_library(tmp.path()).unwrap_err();
        assert!(matches!(err, HostError::LibraryNotFound(_)));
    }

    #[test]
    fn find_backend_library_picks_current_platform_extension() {
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = tmp.path().join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        // Ship all three platform artifacts; the loader must pick this OS's.
        std::fs::write(backend.join("plugin.dll"), b"").unwrap();
        std::fs::write(backend.join("libplugin.so"), b"").unwrap();
        std::fs::write(backend.join("libplugin.dylib"), b"").unwrap();
        // A non-library file must be ignored.
        std::fs::write(backend.join("README.md"), b"").unwrap();

        let found = find_backend_library(tmp.path()).unwrap();
        let ext = found.extension().and_then(|e| e.to_str()).unwrap();
        assert_eq!(ext, std::env::consts::DLL_EXTENSION);
    }

    #[test]
    fn open_nonexistent_library_is_open_error() {
        let missing = Path::new("/definitely/not/a/real/plugin.so");
        // `LoadedLibrary` is not `Debug`, so match rather than `unwrap_err`.
        match load_backend_library(missing) {
            Err(err @ HostError::Open { .. }) => assert!(!err.is_incompatible()),
            Err(other) => panic!("expected Open error, got {other:?}"),
            Ok(_) => panic!("expected loading a nonexistent library to fail"),
        }
    }

    #[test]
    fn incompatible_abi_error_is_flagged() {
        let err = HostError::IncompatibleAbi {
            expected: 1,
            found: 99,
        };
        assert!(err.is_incompatible());
        // A load error is not an incompatibility.
        assert!(!HostError::MissingSymbol("x".into()).is_incompatible());
    }
}
