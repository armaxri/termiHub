//! Windows X server (VcXsrv) provisioning subsystem.
//!
//! This subsystem makes a known-good VcXsrv install available on disk without
//! the user running any installer, then (in later phases) launches and
//! supervises it for SSH X11 forwarding. See the concept document
//! `docs/concepts/backlog/x-server-provisioning.html`.
//!
//! Phase 1 (#1048) ships [`acquire`] — resolve VcXsrv via
//! `cache → bundled → download → verify → extract`. Lifecycle (#1049) and
//! DISPLAY/auth (#1050) build on top of it.

pub mod acquire;
