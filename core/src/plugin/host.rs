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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use libloading::{Library, Symbol};
use termihub_plugin_api::symbols::{
    PluginAbiVersionFn, PluginCreateBackendFn, PluginInitFn, PluginShutdownFn,
    SYMBOL_PLUGIN_ABI_VERSION, SYMBOL_PLUGIN_CREATE_BACKEND, SYMBOL_PLUGIN_INIT,
    SYMBOL_PLUGIN_SHUTDOWN,
};
use termihub_plugin_api::{
    LoadedBackend, PluginBackend, PluginError, PluginInfo, PluginOutputSender, PluginSessionConfig,
    CURRENT_PLUGIN_API_VERSION,
};

use crate::connection::ConnectionTypeRegistry;

use super::connection::PluginConnectionType;
use super::manager::InstalledPlugin;

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
    /// `config_json` and the host-owned `output` sink, returning a safe
    /// [`LoadedBackend`] wrapper on success. The returned backend borrows nothing
    /// from `config_json` (the plugin copies what it needs before the call
    /// returns), but it *does* depend on this library staying loaded — callers
    /// must keep an `Arc<LoadedLibrary>` alive for the backend's lifetime.
    pub fn create_backend(
        &self,
        config_json: &str,
        output: PluginOutputSender,
    ) -> Result<LoadedBackend, PluginError> {
        let config = PluginSessionConfig::new(config_json);
        let mut backend = PluginBackend {
            state: std::ptr::null_mut(),
            vtable: std::ptr::null(),
        };
        // SAFETY: `config` outlives the call; `output` ownership is transferred to
        // the plugin; `&mut backend` is a valid out-parameter. The plugin writes a
        // valid `PluginBackend` on `Ok`.
        let status = unsafe { (self.create_backend)(&config, output, &mut backend) };
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
        // SAFETY: the plugin's abi-version entry point takes no arguments and
        // returns a plain `u32`.
        unsafe { abi_version() }
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
        let mut info = PluginInfo::empty();
        // SAFETY: `&mut info` is a valid out-parameter the plugin fills in; on a
        // non-`Ok` status it leaves the empty placeholder untouched.
        let status = unsafe { init(&mut info) };
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

/// A record of one loaded plugin: the connection type it registered and the
/// library backing it.
struct HostEntry {
    connection_type: String,
    #[allow(dead_code)] // Held to keep the library loaded for the plugin's lifetime.
    library: Arc<LoadedLibrary>,
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
        }
    }

    /// The shared connection-type registry this host feeds.
    #[must_use]
    pub fn registry(&self) -> &Arc<Mutex<ConnectionTypeRegistry>> {
        &self.registry
    }

    /// Whether a plugin id is currently loaded.
    #[must_use]
    pub fn is_loaded(&self, id: &str) -> bool {
        self.loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
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
        let Some(backend) = plugin.manifest.extensions.terminal_backend.as_ref() else {
            return Ok(());
        };

        let id = plugin.manifest.id.clone();
        // Replace any prior load of the same id.
        self.unload(&id);

        let plugin_dir = self.root.join(&id);
        let lib_path = find_backend_library(&plugin_dir)?;
        let library = load_backend_library(&lib_path)?;

        let connection_type = backend.connection_type.clone();
        let display_name = backend.display_name.clone();
        let lib_for_factory = Arc::clone(&library);
        let ct_for_factory = connection_type.clone();
        let dn_for_factory = display_name.clone();

        {
            let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            registry.register(
                &connection_type,
                &display_name,
                "puzzle",
                Box::new(move || {
                    Box::new(PluginConnectionType::new(
                        Arc::clone(&lib_for_factory),
                        ct_for_factory.clone(),
                        dn_for_factory.clone(),
                    ))
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
        Ok(())
    }

    /// Unload a plugin: unregister its connection type and drop the host's
    /// reference to the library. The library unmaps once every session created
    /// from it has also been dropped. A no-op if the id is not loaded.
    pub fn unload(&self, id: &str) {
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

    fn on_uninstall(&self, id: &str) -> Result<(), String> {
        self.host.unload(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
