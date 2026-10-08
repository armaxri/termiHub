//! Shared library half of `termihub-plugin-runner` (#4182, plugin OS-sandbox
//! phase 1, concept `docs/concepts/implemented/plugin-os-sandbox.html`).
//!
//! * [`loader`] — open, verify and gate a native plugin library: the runner
//!   binary's load sequence (digest pin → ABI gate → manifest mirror →
//!   `plugin_init` → toolchain rule). termiHub itself never loads a plugin
//!   (ADR-19); its tests reuse the loader as an in-process baseline only.
//! * [`ipc`] — the length-delimited frame protocol between the host and a
//!   runner process, and the channel it rides on (a `socketpair` on Unix, a
//!   private named pipe on Windows).
//! * `process` (Windows) — starting a runner inside a kill-on-close job object
//!   with an explicit inherited-handle list; Unix spawns through `std`.
//! * `appcontainer` (Windows) — the per-plugin Less-Privileged AppContainer
//!   the host starts the runner in, and its folder grants (#4187).
//! * [`sandbox`] — the OS-neutral sandbox policy and report, and the per-OS
//!   confinement the runner applies to itself before `dlopen` (#4186).
//!
//! The runner binary itself (`src/main.rs`) loads exactly one plugin and
//! proxies the frozen 1.x C ABI over [`ipc`]; the plugin is not rebuilt and the
//! ABI is not bumped.

#[cfg(windows)]
pub mod appcontainer;
pub mod ipc;
pub mod loader;
#[cfg(windows)]
pub mod process;
pub mod sandbox;
#[cfg(windows)]
mod win;
