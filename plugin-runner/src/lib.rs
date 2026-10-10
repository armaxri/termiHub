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
//! # The `runner` feature (ADR-19, #4373)
//!
//! Everything that loads a plugin into the calling process (`dlopen` +
//! `plugin_init`: `loader::load_plugin_library`, `loader::PreparedLibrary`,
//! `loader::PluginLibrary`) or confines the calling process (`sandbox::apply`
//! and the per-OS layers behind it) is compiled only with the `runner`
//! feature. It is on by default for the binary; termihub-core depends on the
//! library with `default-features = false`, so "the host never loads a plugin
//! in-process" is enforced by the compiler rather than by convention.
//!
//! The runner binary itself (`src/main.rs`) loads exactly one plugin and
//! proxies the frozen 1.x C ABI over [`ipc`]; the plugin is not rebuilt and the
//! ABI is not bumped.

// TOOL-010: enforce the "no `.unwrap()`/`.expect()`/`panic!` in production Rust"
// policy (see `.claude/CLAUDE.md` -> Rust). Denied for non-test builds; test code
// (`#[cfg(test)]` modules and `tests/` crates) is exempt via `not(test)`.
// scripts/internal/check-crate-policy.mjs fails CI if a crate root drops it.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

#[cfg(windows)]
pub mod appcontainer;
pub mod ipc;
pub mod loader;
#[cfg(windows)]
pub mod process;
pub mod sandbox;
#[cfg(windows)]
mod win;
