//! Local X server provisioning for SSH X11 forwarding.
//!
//! Makes a usable local X server available and manages its lifecycle so remote
//! GUI apps can render as native windows. See the concept document
//! `docs/concepts/backlog/x-server-provisioning.html`.
//!
//! - [`acquire`] (#1048, Windows-only) resolves a known-good VcXsrv install on
//!   disk via `cache → bundled → download → verify → extract`, without the user
//!   running any installer.
//! - [`manager`] (#1049) owns the lifecycle of a single shared X server: adopt an
//!   existing server or spawn/supervise VcXsrv, reuse it across sessions, and
//!   shut it down cleanly. It is cross-platform: on non-Windows hosts it degrades
//!   to a report-only no-op that adopts the system's existing X server, which
//!   also keeps the lifecycle logic unit-tested on every platform.
//!
//! DISPLAY/cookie provisioning (#1050) and the orchestrator/UI (#1052/#1053)
//! build on top of these.

#[cfg(windows)]
pub mod acquire;
pub mod manager;

pub use manager::XServerManager;
