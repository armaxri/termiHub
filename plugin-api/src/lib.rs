//! # termihub-plugin-api
//!
//! The **stable ABI contract** for termiHub native terminal-backend plugins.
//!
//! termiHub can be extended with terminal backends distributed as native dynamic
//! libraries (`.dll` / `.so` / `.dylib`). Such backends need direct system
//! access (PTYs, sockets, serial ports) that a JavaScript plugin cannot provide.
//! This crate is the shared dependency compiled into **both** the host and every
//! plugin, and it defines the boundary between them. Its stability is the whole
//! point: a plugin built against version *N* of this crate must keep working
//! against a host built against the same major ABI version.
//!
//! ## Why the ABI is hand-rolled and `#[repr(C)]`
//!
//! Rust has **no stable ABI**. The layout of `String`, `&[u8]`, `dyn Trait` fat
//! pointers, and most `enum`s can change between compiler versions and even
//! builds. The plugin-system concept sketched returning
//! `*mut dyn PluginTerminalBackend` across `extern "C"`; that is undefined
//! behavior, because the `dyn` fat pointer's vtable layout is not guaranteed to
//! match between the host and a separately-compiled plugin. See
//! [`backend`] for the full rationale.
//!
//! Instead, everything that crosses the boundary is either:
//!
//! * a `#[repr(C)]` struct of FFI-safe fields ([`ffi`], [`info`]), or
//! * an **opaque handle** (`*mut c_void`) plus a `#[repr(C)]` vtable / callback
//!   of `extern "C"` function pointers ([`backend::PluginBackendVTable`],
//!   [`output::PluginOutputSender`]).
//!
//! No `dyn` pointer, `String`, or allocator ever crosses. Owned resources carry
//! their own destructor function pointer, so each side frees what it allocated.
//! This is the second approach the originating issue sanctioned (a hand-written
//! opaque-handle C ABI); it was chosen over the `abi_stable` crate to keep this
//! foundational, every-plugin-links-it crate free of a heavy dependency and its
//! version-pinning constraints, and because the acceptance criterion — proving
//! FFI-safety via `improper_ctypes` — maps directly onto hand-written
//! `extern "C"` signatures (see [`symbols`]).
//!
//! ## Writing a plugin
//!
//! Depend on this crate, implement [`PluginTerminalBackend`] for your session
//! type, and export the four entry points documented in [`symbols`]. A minimal
//! in-process round trip:
//!
//! ```
//! use std::sync::mpsc;
//! use termihub_plugin_api::{
//!     LoadedBackend, PluginBackend, PluginError, PluginOutputSender,
//!     PluginTerminalBackend,
//! };
//!
//! // A trivial backend that echoes input to the host's output channel.
//! struct EchoBackend {
//!     output: PluginOutputSender,
//!     alive: std::sync::atomic::AtomicBool,
//! }
//!
//! impl PluginTerminalBackend for EchoBackend {
//!     fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
//!         self.output.send(data)
//!     }
//!     fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
//!         Ok(())
//!     }
//!     fn close(&self) -> Result<(), PluginError> {
//!         self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
//!         Ok(())
//!     }
//!     fn is_alive(&self) -> bool {
//!         self.alive.load(std::sync::atomic::Ordering::SeqCst)
//!     }
//! }
//!
//! // Host side: wire an output channel and hand the sender to the plugin.
//! let (tx, rx) = mpsc::channel::<Vec<u8>>();
//! let output = PluginOutputSender::from_sender(tx);
//!
//! // Plugin side: build the backend and expose it via the FFI-safe handle.
//! let backend = PluginBackend::from_boxed(Box::new(EchoBackend {
//!     output,
//!     alive: std::sync::atomic::AtomicBool::new(true),
//! }));
//!
//! // Host side: adopt the handle and drive it through the safe wrapper.
//! let loaded = unsafe { LoadedBackend::from_raw(backend) };
//! assert!(loaded.is_alive());
//! loaded.write_input(b"hello").unwrap();
//! assert_eq!(rx.recv().unwrap(), b"hello".to_vec());
//! loaded.close().unwrap();
//! assert!(!loaded.is_alive());
//! ```

#![deny(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

pub mod backend;
pub mod capabilities;
pub mod error;
pub mod ffi;
pub mod info;
pub mod output;
pub mod symbols;

pub use backend::{LoadedBackend, PluginBackend, PluginBackendVTable, PluginTerminalBackend};
pub use capabilities::{
    HostTcpStream, PluginFileMetadata, PluginHostBridge, PluginTcpStream, PluginTcpStreamVTable,
    PluginWriteMode, StreamDropGuard,
};
pub use error::{PluginError, PluginStatus};
pub use ffi::{FfiByteSlice, FfiOwnedBytes, FfiStr, FfiString};
pub use info::{PluginInfo, PluginSessionConfig};
pub use output::PluginOutputSender;

/// The plugin ABI version this crate defines.
///
/// A plugin reports the value it was built against (via its
/// `termihub_plugin_abi_version` / `plugin_init` entry points); the host refuses
/// to load a plugin whose value is incompatible with its own. Bump this whenever
/// the ABI changes in a way that breaks previously-built plugins — it is the
/// machine-readable half of this crate's compatibility promise.
///
/// Bumped to `2` in #2018: `plugin_create_backend` gained a
/// [`PluginHostBridge`](capabilities::PluginHostBridge) parameter through which
/// the host mediates and permission-checks network/filesystem access at runtime.
///
/// Bumped to `3` in #2024: the [`PluginHostBridge`](capabilities::PluginHostBridge)
/// vtable grew mediated filesystem `write_file` (create / truncate / append),
/// `stat_path`, and `list_dir` callbacks — a layout change that breaks plugins
/// built against version `2`.
///
/// **Not** bumped for #2028 (per-session connection limits and a configurable
/// connect timeout): that policy is enforced entirely host-side. The mediated
/// stream gained an optional host-side drop guard
/// ([`StreamDropGuard`](capabilities::StreamDropGuard)), but it lives behind the
/// stream's opaque `state` pointer, so no vtable or `#[repr(C)]` layout changed
/// and version-`3` plugins stay compatible.
///
/// Bumped to `4` in #2030: [`PluginStatus`] gained a host-returnable
/// [`ResourceLimit`](error::PluginStatus::ResourceLimit) variant so a plugin can
/// tell a connection-ceiling refusal apart from a genuine permission denial.
/// Because the host can now hand back a status discriminant a version-`3` plugin
/// cannot decode, and the load-time gate matches the ABI version exactly, older
/// plugins are rejected rather than fed an unknown value.
pub const CURRENT_PLUGIN_API_VERSION: u32 = 4;
