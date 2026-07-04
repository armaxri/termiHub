//! Local X server provisioning (Windows: VcXsrv).
//!
//! This module owns the lifecycle of a single shared local X server used for
//! SSH X11 forwarding. On Windows it spawns and supervises a bundled/downloaded
//! `vcxsrv.exe`; on other platforms it degrades to a report-only no-op that
//! adopts whatever X server the system already provides.
//!
//! The actual VcXsrv binary is resolved by the acquisition module (issue #1048);
//! this manager takes an injectable resolver so it stays independently testable
//! and buildable while that work lands in parallel.

pub mod manager;

pub use manager::XServerManager;
