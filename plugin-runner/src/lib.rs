//! Shared library half of `termihub-plugin-runner` (#4182, plugin OS-sandbox
//! phase 1, concept `docs/concepts/backlog/plugin-os-sandbox.html`).
//!
//! * [`loader`] — open, verify and gate a native plugin library. Used by the
//!   in-process host in `termihub-core` *and* by the runner binary, so both
//!   enforce the identical sequence (digest pin → ABI gate → manifest mirror →
//!   `plugin_init` → toolchain rule).
//! * [`ipc`] — the length-delimited frame protocol between the host and a
//!   runner process.
//! * [`sandbox`] — the OS-neutral sandbox policy and report, and the per-OS
//!   confinement the runner applies to itself before `dlopen` (#4186).
//!
//! The runner binary itself (`src/main.rs`) loads exactly one plugin and
//! proxies the frozen 1.x C ABI over [`ipc`]; the plugin is not rebuilt and the
//! ABI is not bumped.

pub mod ipc;
pub mod loader;
pub mod sandbox;
