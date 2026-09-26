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
// TOOL-010: enforce the "no `.unwrap()`/`.expect()`/`panic!` in production Rust"
// policy (see `.claude/CLAUDE.md` → Rust). Denied for non-test builds; test code
// (`#[cfg(test)]` modules and `tests/` crates) is exempt via `not(test)`.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod backend;
pub mod capabilities;
pub mod error;
pub mod ffi;
pub mod info;
pub mod output;
pub mod symbols;
pub mod version;

pub use backend::{LoadedBackend, PluginBackend, PluginBackendVTable, PluginTerminalBackend};
pub use capabilities::{
    HostTcpStream, PluginFileMetadata, PluginHostBridge, PluginHostBridgeVTable, PluginTcpStream,
    PluginTcpStreamVTable, PluginWriteMode, StreamDropGuard,
};
pub use error::{PluginError, PluginStatus};
pub use ffi::{FfiByteSlice, FfiOwnedBytes, FfiStr, FfiString};
pub use info::{PluginInfo, PluginSessionConfig};
pub use output::PluginOutputSender;
pub use version::{AbiIncompatibility, AbiVersion};

/// The native plugin ABI version this crate defines — **frozen at 1.0**.
///
/// This is the **single authoritative** plugin-contract version (PLG-002): a
/// plugin exports it from `termihub_plugin_abi_version` (as
/// [`AbiVersion::to_packed`]) and reports the same value in
/// [`PluginInfo::api_version`]; a plugin manifest's `apiVersion` must mirror it
/// exactly. The host loads a plugin iff the majors match and the plugin's minor
/// does not exceed this one ([`AbiVersion::check_host_compatibility`]).
///
/// # Bumping it
///
/// * **Minor** — only for purely additive changes that follow the append-only
///   rule in [`version`] (append a host-owned vtable entry or out-parameter
///   field, add an optional exported symbol, add an enum variant the host
///   gates with [`PluginStatus::for_peer`]). Older-minor plugins keep loading.
/// * **Major** — anything else: reordering, removing, retyping or resizing an
///   existing field, symbol or variant, or changing its meaning. Every
///   installed plugin stops loading until rebuilt, so a major bump is a
///   maintainer decision, not a routine change.
///
/// Update the layout-freeze test (`plugin-api/tests/abi_layout.rs`) in the same
/// change — it exists to make an accidental break fail CI.
///
/// # History
///
/// Before the 1.0 freeze (#3367, maintainer decision 2026-09-26) the ABI was a
/// single `u32` counter checked by exact equality and bumped for every layout
/// change (`2` #2018 host bridge, `3` #2024 bridge filesystem ops, `4` #2030
/// `PluginStatus::ResourceLimit`). Those values decode as ABI `0.x`, so a
/// pre-freeze plugin is refused as an unsupported major.
pub const CURRENT_PLUGIN_ABI_VERSION: AbiVersion = AbiVersion::new(1, 0);
