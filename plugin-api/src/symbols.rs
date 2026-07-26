//! The exported-symbol contract every plugin dynamic library must satisfy, plus
//! a compile-time proof that the boundary is FFI-safe.
//!
//! A plugin `cdylib` must export exactly these four `unsafe extern "C"` symbols.
//! The host loader resolves them by the [`SYMBOL_*`](self) names and calls them
//! through the matching function-pointer type aliases.
//!
//! ```ignore
//! use termihub_plugin_api::*;
//!
//! #[no_mangle]
//! pub extern "C" fn termihub_plugin_abi_version() -> u32 {
//!     CURRENT_PLUGIN_API_VERSION
//! }
//!
//! #[no_mangle]
//! pub unsafe extern "C" fn termihub_plugin_init(out_info: *mut PluginInfo) -> PluginStatus {
//!     if out_info.is_null() {
//!         return PluginStatus::Other;
//!     }
//!     unsafe {
//!         out_info.write(PluginInfo::new(
//!             "k8s-exec", "Kubernetes Exec", "1.2.0", CURRENT_PLUGIN_API_VERSION,
//!         ));
//!     }
//!     PluginStatus::Ok
//! }
//!
//! #[no_mangle]
//! pub unsafe extern "C" fn termihub_plugin_create_backend(
//!     config: *const PluginSessionConfig,
//!     output: PluginOutputSender,
//!     bridge: PluginHostBridge,
//!     out_backend: *mut PluginBackend,
//! ) -> PluginStatus {
//!     // parse `(*config).config_json`, spawn the session — routing any network or
//!     // filesystem access through `bridge` so the host enforces this plugin's
//!     // declared permissions — then:
//!     let backend = PluginBackend::from_boxed(Box::new(my_backend));
//!     unsafe { out_backend.write(backend); }
//!     PluginStatus::Ok
//! }
//!
//! #[no_mangle]
//! pub extern "C" fn termihub_plugin_shutdown() {}
//! ```

use crate::backend::PluginBackend;
use crate::capabilities::PluginHostBridge;
use crate::error::PluginStatus;
use crate::info::{PluginInfo, PluginSessionConfig};
use crate::output::PluginOutputSender;

/// Symbol name (NUL-terminated for `libloading::Library::get`) of the ABI-version
/// entry point.
pub const SYMBOL_PLUGIN_ABI_VERSION: &[u8] = b"termihub_plugin_abi_version\0";
/// Symbol name of the initialization / metadata entry point.
pub const SYMBOL_PLUGIN_INIT: &[u8] = b"termihub_plugin_init\0";
/// Symbol name of the backend-factory entry point.
pub const SYMBOL_PLUGIN_CREATE_BACKEND: &[u8] = b"termihub_plugin_create_backend\0";
/// Symbol name of the shutdown entry point.
pub const SYMBOL_PLUGIN_SHUTDOWN: &[u8] = b"termihub_plugin_shutdown\0";

/// Type of [`SYMBOL_PLUGIN_ABI_VERSION`]: returns the ABI version the plugin was
/// built against. The host compares it to [`crate::CURRENT_PLUGIN_API_VERSION`]
/// before calling anything else.
pub type PluginAbiVersionFn = unsafe extern "C" fn() -> u32;

/// Type of [`SYMBOL_PLUGIN_INIT`]: fills `out_info` with the plugin's metadata.
/// Ownership of the strings in `*out_info` transfers to the host.
pub type PluginInitFn = unsafe extern "C" fn(out_info: *mut PluginInfo) -> PluginStatus;

/// Type of [`SYMBOL_PLUGIN_CREATE_BACKEND`]: creates a session backend from the
/// borrowed `config`, taking ownership of `output` and the host capability
/// `bridge`, and writes the resulting [`PluginBackend`] into `out_backend`.
///
/// The `bridge` ([`PluginHostBridge`]) is the plugin's only sanctioned route to
/// network/filesystem access: operations run through it are permission-checked by
/// the host at runtime (#2018). Ownership of `bridge` transfers to the plugin,
/// which stores it in its backend and drops it with the session.
pub type PluginCreateBackendFn = unsafe extern "C" fn(
    config: *const PluginSessionConfig,
    output: PluginOutputSender,
    bridge: PluginHostBridge,
    out_backend: *mut PluginBackend,
) -> PluginStatus;

/// Type of [`SYMBOL_PLUGIN_SHUTDOWN`]: called once before the library is
/// unloaded, for process-wide cleanup.
pub type PluginShutdownFn = unsafe extern "C" fn();

/// Compile-time proof that the exported ABI surface is FFI-safe.
///
/// The `#[deny(...)]` below turns any `improper_ctypes*` finding into a hard
/// build error, so this module fails to compile if a type in one of the exported
/// signatures ever stops being FFI-safe. The functions are never called; they
/// exist purely so the lint runs over their signatures.
#[deny(improper_ctypes, improper_ctypes_definitions)]
#[allow(dead_code)]
mod ffi_safety_check {
    use super::*;
    use crate::ffi::FfiByteSlice;

    // Exported entry points, exactly matching the type aliases above.
    unsafe extern "C" fn _abi_version() -> u32 {
        crate::CURRENT_PLUGIN_API_VERSION
    }
    unsafe extern "C" fn _init(_out: *mut PluginInfo) -> PluginStatus {
        PluginStatus::Ok
    }
    unsafe extern "C" fn _create(
        _config: *const PluginSessionConfig,
        _output: PluginOutputSender,
        _bridge: PluginHostBridge,
        _out: *mut PluginBackend,
    ) -> PluginStatus {
        PluginStatus::Ok
    }
    unsafe extern "C" fn _shutdown() {}

    // Vtable callback shapes.
    unsafe extern "C" fn _write_input(
        _s: *mut core::ffi::c_void,
        _d: FfiByteSlice,
    ) -> PluginStatus {
        PluginStatus::Ok
    }
    unsafe extern "C" fn _is_alive(_s: *mut core::ffi::c_void) -> bool {
        true
    }

    // Assert the aliases accept the definitions (another layer of the same check).
    const _: PluginAbiVersionFn = _abi_version;
    const _: PluginInitFn = _init;
    const _: PluginCreateBackendFn = _create;
    const _: PluginShutdownFn = _shutdown;
    const _: unsafe extern "C" fn(*mut core::ffi::c_void, FfiByteSlice) -> PluginStatus =
        _write_input;
    const _: unsafe extern "C" fn(*mut core::ffi::c_void) -> bool = _is_alive;
}
