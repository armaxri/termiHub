//! The native plugin **library loader**, shared by the in-process host
//! (`termihub_core::plugin::PluginHost`) and the out-of-process
//! `termihub-plugin-runner` (#4182).
//!
//! It owns everything between "a path to a plugin's backend library" and "a
//! library whose entry points may be called": the verify-then-load digest pin
//! (CORE-034, [`pin`]), `dlopen`, the ABI version gate, the manifest mirror check
//! (PLG-002), `termihub_plugin_init`, and the toolchain rule (PLG-013, ADR-15).
//! Keeping it in one place means the runner enforces exactly the gates the host
//! always has — there is no second, drifting copy.
//!
//! The ordering is deliberate: nothing in the plugin is called before the ABI
//! gate passes, and no entry point beyond `plugin_init` is resolved before the
//! toolchain rule passes.

mod pin;

use std::path::{Path, PathBuf};

use libloading::{Library, Symbol};
use termihub_plugin_api::symbols::{
    PluginAbiVersionFn, PluginCreateBackendFn, PluginInitFn, PluginShutdownFn,
    SYMBOL_PLUGIN_ABI_VERSION, SYMBOL_PLUGIN_CREATE_BACKEND, SYMBOL_PLUGIN_INIT,
    SYMBOL_PLUGIN_SHUTDOWN,
};
use termihub_plugin_api::{
    AbiIncompatibility, AbiVersion, LoadedBackend, PluginBackend, PluginError, PluginHostBridge,
    PluginHostContext, PluginInfo, PluginOutputSender, PluginSessionConfig, Toolchain,
    ToolchainIncompatibility, ABI_1_1, CURRENT_PLUGIN_ABI_VERSION,
};

pub use pin::{PinnedLibrary, DIGEST_ALGORITHM};

/// Everything that can go wrong between a library path and a usable library.
///
/// `termihub_core::plugin::HostError` mirrors each variant one-to-one (same
/// message), so moving the loader here changed no user-visible error.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    /// The library bytes did not match the signed digest they were verified
    /// against, re-checked immediately before load (CORE-034).
    #[error("backend library `{path}` failed its pre-load integrity check")]
    LibraryDigestMismatch {
        /// The library path whose bytes did not match.
        path: PathBuf,
        /// The signed digest expected.
        expected: String,
        /// The digest actually computed from the on-disk file.
        actual: String,
    },

    /// The library changed while it was being loaded (#2796).
    #[error("backend library `{path}` changed while it was being loaded: {detail}")]
    LibraryChangedDuringLoad {
        /// The library path.
        path: PathBuf,
        /// What changed.
        detail: String,
    },

    /// The dynamic library could not be opened.
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
    #[error("{0}")]
    IncompatibleAbi(AbiIncompatibility),

    /// The manifest `apiVersion` does not mirror the library's ABI (PLG-002).
    #[error(
        "plugin manifest declares apiVersion `{manifest}` but its backend library was built \
         for ABI {library}; repackage the plugin so the two match"
    )]
    ManifestAbiMismatch {
        /// The manifest's declared `apiVersion`, verbatim.
        manifest: String,
        /// The ABI version the library reported.
        library: AbiVersion,
    },

    /// `termihub_plugin_abi_version` and `PluginInfo::api_version` disagree.
    #[error(
        "plugin library reports ABI {symbol} from termihub_plugin_abi_version but ABI {info} \
         in its plugin info; rebuild the plugin"
    )]
    InconsistentAbi {
        /// The version `termihub_plugin_abi_version` returned.
        symbol: AbiVersion,
        /// The version reported in `PluginInfo::api_version`.
        info: AbiVersion,
    },

    /// The plugin's `plugin_init` entry point reported a failure.
    #[error("plugin initialization failed: {0}")]
    Init(String),

    /// The plugin's recorded toolchain does not match the host's (PLG-013).
    #[error("{0}")]
    IncompatibleToolchain(ToolchainIncompatibility),

    /// An ABI 1.0 plugin cannot prove its toolchain and was not accepted.
    #[error(
        "plugin was built for ABI {abi}, which does not record its build toolchain, so termiHub \
         cannot verify it was built with a compatible compiler; rebuild it for ABI 1.1 or later, \
         or trust it again and explicitly accept the unverified toolchain"
    )]
    UnverifiedToolchain {
        /// The ABI version the plugin reported.
        abi: AbiVersion,
    },

    /// A plugin entry point unwound (panicked) across the FFI boundary.
    #[error("plugin panicked during `{0}`")]
    Panicked(&'static str),
}

impl LoadError {
    /// Whether this is a version incompatibility (ABI or toolchain) rather than
    /// a load error — the management layer shows the two differently.
    #[must_use]
    pub fn is_incompatible(&self) -> bool {
        matches!(
            self,
            LoadError::IncompatibleAbi(_) | LoadError::IncompatibleToolchain(_)
        )
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
    /// ABI version the plugin was built against (already checked compatible
    /// with this host, and consistent with the library's exported version).
    pub abi_version: AbiVersion,
    /// The build toolchain the plugin reported — `Some` only for a plugin whose
    /// ABI records it (1.1+); `None` for an ABI 1.0 plugin, which never wrote
    /// those fields and must not have them read.
    pub toolchain: Option<Toolchain>,
}

impl LoadedPluginInfo {
    fn from_ffi(info: &PluginInfo) -> Self {
        let abi_version = info.abi_version();
        Self {
            id: info.id.as_str().to_owned(),
            name: info.name.as_str().to_owned(),
            version: info.version.as_str().to_owned(),
            abi_version,
            // Read the appended 1.1 fields only when the plugin's ABI has them.
            toolchain: abi_version.supports(ABI_1_1).then(|| info.toolchain()),
        }
    }
}

/// Options for [`load_plugin_library`]. The default is the strictest load: no
/// digest binding, no manifest mirror check, and **no** acceptance of an
/// unverifiable toolchain.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackendLoadOptions<'a> {
    /// Signed digest the library bytes must match immediately before `dlopen`
    /// (CORE-034); `None` for an unsigned plugin.
    pub expected_digest: Option<&'a str>,
    /// The manifest `apiVersion` the library's ABI must mirror (PLG-002).
    pub manifest_api_version: Option<&'a str>,
    /// Whether the user explicitly accepted an **unverifiable build toolchain**
    /// for this exact library. Only an ABI 1.0 plugin needs it; it never relaxes
    /// the check for a plugin that does report a toolchain.
    pub accept_unverified_toolchain: bool,
}

/// An opened, gated plugin library plus its resolved entry points.
///
/// Dropping it calls the plugin's `termihub_plugin_shutdown` (panic-contained)
/// while the library is still mapped, then unmaps it. The `library` field is
/// declared **last** so it drops last.
pub struct PluginLibrary {
    info: LoadedPluginInfo,
    /// Resolved `plugin_create_backend`. Valid as long as `library` is loaded.
    create_backend: PluginCreateBackendFn,
    /// Resolved `plugin_shutdown`, called once on drop.
    shutdown: PluginShutdownFn,
    /// Held solely to keep the mapping alive (the resolved function pointers
    /// point into it) and to unmap on drop. **Must be the last field.**
    #[expect(
        dead_code,
        reason = "RAII: held only to keep the library mapped; unmapped on drop"
    )]
    library: Library,
}

// SAFETY: `libloading::Library` is `Send + Sync`; the resolved function pointers
// are plain `extern "C"` pointers into that library. The plugin ABI requires
// backends and their entry points to be callable from any thread (see
// `termihub_plugin_api`), so sharing a `PluginLibrary` across threads is sound.
unsafe impl Send for PluginLibrary {}
unsafe impl Sync for PluginLibrary {}

impl PluginLibrary {
    /// Metadata this plugin reported at load time.
    #[must_use]
    pub fn info(&self) -> &LoadedPluginInfo {
        &self.info
    }

    /// Whether this plugin's ABI includes an addition introduced in `since`.
    #[must_use]
    pub fn supports(&self, since: AbiVersion) -> bool {
        self.info.abi_version.supports(since)
    }

    /// Create a backend session, passing the ABI 1.1 host `context` **only**
    /// when this plugin's ABI supports 1.1 (a 1.0 plugin gets exactly the 1.0
    /// call). Ownership of `output` and `bridge` transfers to the plugin. The
    /// returned backend depends on this library staying loaded.
    pub fn create_backend_with_context(
        &self,
        config_json: &str,
        settings_json: &str,
        output: PluginOutputSender,
        bridge: PluginHostBridge,
        context: Option<&PluginHostContext>,
    ) -> Result<LoadedBackend, PluginError> {
        let config = match context {
            Some(context) if self.supports(ABI_1_1) => {
                PluginSessionConfig::with_context(config_json, settings_json, context)
            }
            _ => PluginSessionConfig::with_settings(config_json, settings_json),
        };
        let mut backend = PluginBackend {
            state: std::ptr::null_mut(),
            vtable: std::ptr::null(),
        };
        // SAFETY: `config` outlives the call; `output` and `bridge` ownership are
        // transferred to the plugin; `&mut backend` is a valid out-parameter. The
        // call is wrapped in `catch_unwind` so a panic inside the plugin's entry
        // point is contained rather than unwinding across the FFI boundary.
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

    /// Build a library handle for teardown-ordering tests without a real plugin.
    ///
    /// The `library` handle is the already-loaded process image (`dlopen(NULL)`
    /// / the current module), which loads nothing new and runs no initializers.
    /// The only observable effect on drop is `shutdown`. Never call
    /// `create_backend_with_context` on it.
    #[doc(hidden)]
    #[must_use]
    pub fn for_drop_order_test(info: LoadedPluginInfo, shutdown: PluginShutdownFn) -> Self {
        unsafe extern "C" fn unused_create_backend(
            _config: *const PluginSessionConfig,
            _output: PluginOutputSender,
            _bridge: PluginHostBridge,
            _out_backend: *mut PluginBackend,
        ) -> termihub_plugin_api::PluginStatus {
            termihub_plugin_api::PluginStatus::Other
        }

        #[cfg(unix)]
        let library: Library = libloading::os::unix::Library::this().into();
        #[cfg(windows)]
        let library: Library = match libloading::os::windows::Library::this() {
            Ok(lib) => lib.into(),
            Err(e) => panic!("handle to the current module: {e}"),
        };

        Self {
            info,
            create_backend: unused_create_backend,
            shutdown,
            library,
        }
    }
}

impl Drop for PluginLibrary {
    fn drop(&mut self) {
        // Give the plugin a chance to release process-wide resources before the
        // library unmaps. Contain any panic rather than unwinding across FFI.
        let shutdown = self.shutdown;
        // SAFETY: `shutdown` is a valid entry point in the still-loaded library.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { shutdown() }));
    }
}

/// Enforce the toolchain rule for a plugin that passed the ABI gate: exact
/// match when its ABI records a toolchain, explicit acceptance otherwise.
pub fn check_library_toolchain(
    info: &LoadedPluginInfo,
    host: &Toolchain,
    accept_unverified_toolchain: bool,
) -> Result<(), LoadError> {
    match &info.toolchain {
        Some(plugin) => plugin
            .check_host_compatibility(host)
            .map_err(LoadError::IncompatibleToolchain),
        None if accept_unverified_toolchain => Ok(()),
        None => Err(LoadError::UnverifiedToolchain {
            abi: info.abi_version,
        }),
    }
}

/// Decide whether a library that exported ABI `found` may be loaded by a host
/// at ABI `host`, and — when a manifest is being checked — whether the
/// manifest's `apiVersion` mirrors it.
pub fn check_library_abi(
    found: AbiVersion,
    host: AbiVersion,
    manifest_api_version: Option<&str>,
) -> Result<(), LoadError> {
    found
        .check_host_compatibility(host)
        .map_err(LoadError::IncompatibleAbi)?;
    if let Some(declared) = manifest_api_version {
        if AbiVersion::parse(declared) != Some(found) {
            return Err(LoadError::ManifestAbiMismatch {
                manifest: declared.to_owned(),
                library: found,
            });
        }
    }
    Ok(())
}

/// Render an exported symbol name (NUL-terminated byte string) for messages.
#[must_use]
pub fn symbol_name(sym: &[u8]) -> String {
    let trimmed = sym.strip_suffix(b"\0").unwrap_or(sym);
    String::from_utf8_lossy(trimmed).into_owned()
}

/// Open a plugin backend library, gate it, and resolve its entry points.
///
/// 1. Pin and verify the bytes when `expected_digest` is set (CORE-034).
/// 2. `dlopen`, then call `termihub_plugin_abi_version` and apply the ABI gate
///    (+ manifest mirror).
/// 3. Call `termihub_plugin_init`; the info must repeat the exported ABI; apply
///    the toolchain rule.
/// 4. Resolve `create_backend` and `shutdown`.
///
/// On any failure the (partially) opened library is dropped, so a rejected
/// plugin leaves nothing loaded.
pub fn load_plugin_library(
    library_path: &Path,
    options: &BackendLoadOptions<'_>,
) -> Result<PluginLibrary, LoadError> {
    let BackendLoadOptions {
        expected_digest,
        manifest_api_version,
        accept_unverified_toolchain,
    } = *options;
    // Re-check the exact bytes about to be loaded against the digest they were
    // verified with, through a handle held open across the load. Fails closed.
    let pinned = expected_digest
        .map(|expected| PinnedLibrary::open_verified(library_path, expected))
        .transpose()?;
    let open_path = match &pinned {
        Some(pin) => pin.load_path()?,
        None => library_path.to_owned(),
    };

    // SAFETY: opening an arbitrary library runs its initializers; this is the
    // irreducible unsafety of a plugin host. Failures are returned, not panicked.
    let library = unsafe { Library::new(&open_path) }.map_err(|source| LoadError::Open {
        path: library_path.to_owned(),
        source,
    })?;
    if let Some(pin) = pinned {
        // On failure `library` is dropped here (unloaded) before anything in it
        // is called.
        pin.confirm_after_load()?;
    }

    // --- 1. ABI version gate, before anything else is called. ---
    let found = {
        // SAFETY: resolving a symbol to its documented type alias; the pointer is
        // only used while `library` is alive.
        let abi_version: Symbol<PluginAbiVersionFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_ABI_VERSION)
                .map_err(|_| LoadError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_ABI_VERSION)))?
        };
        let abi_version_fn = *abi_version;
        // SAFETY: the entry point takes no arguments and returns a plain `u32`.
        // Contained in `catch_unwind` so a panicking plugin cannot unwind across
        // FFI and abort the process.
        let packed = std::panic::catch_unwind(|| unsafe { abi_version_fn() })
            .map_err(|_| LoadError::Panicked("plugin_abi_version"))?;
        AbiVersion::from_packed(packed)
    };
    check_library_abi(found, CURRENT_PLUGIN_ABI_VERSION, manifest_api_version)?;

    // --- 2. Read plugin metadata. ---
    let info = {
        // SAFETY: resolving `plugin_init` to its type alias.
        let init: Symbol<PluginInitFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_INIT)
                .map_err(|_| LoadError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_INIT)))?
        };
        let init_fn = *init;
        let mut info = PluginInfo::empty();
        // SAFETY: `&mut info` is a valid out-parameter the plugin fills in; on a
        // non-`Ok` status it leaves the empty placeholder untouched.
        let status = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            init_fn(&mut info)
        }))
        .map_err(|_| LoadError::Panicked("plugin_init"))?;
        status
            .into_result()
            .map_err(|e| LoadError::Init(e.to_string()))?;
        let loaded = LoadedPluginInfo::from_ffi(&info);
        // One authoritative version: the info must repeat the exported one.
        if loaded.abi_version != found {
            return Err(LoadError::InconsistentAbi {
                symbol: found,
                info: loaded.abi_version,
            });
        }
        // Toolchain rule (PLG-013): before any further entry point is resolved.
        check_library_toolchain(&loaded, &Toolchain::current(), accept_unverified_toolchain)?;
        loaded
    };

    // --- 3. Resolve the remaining entry points and detach them from the borrow. ---
    let create_backend: PluginCreateBackendFn = {
        // SAFETY: resolving `plugin_create_backend` to its type alias.
        let sym: Symbol<PluginCreateBackendFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_CREATE_BACKEND)
                .map_err(|_| LoadError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_CREATE_BACKEND)))?
        };
        *sym
    };
    let shutdown: PluginShutdownFn = {
        // SAFETY: resolving `plugin_shutdown` to its type alias.
        let sym: Symbol<PluginShutdownFn> = unsafe {
            library
                .get(SYMBOL_PLUGIN_SHUTDOWN)
                .map_err(|_| LoadError::MissingSymbol(symbol_name(SYMBOL_PLUGIN_SHUTDOWN)))?
        };
        *sym
    };

    Ok(PluginLibrary {
        info,
        create_backend,
        shutdown,
        library,
    })
}
