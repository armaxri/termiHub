//! Local X server provisioning for SSH X11 forwarding (epic #1047).
//!
//! Makes a usable local X server available and manages its lifecycle so remote
//! GUI apps can render as native windows. See the concept document
//! `docs/concepts/backlog/x-server-provisioning.html`.
//!
//! - [`acquire`] (#1048, Windows-only) resolves a known-good VcXsrv install on
//!   disk via `cache → bundled → download → verify → extract`.
//! - [`manager`] (#1049) owns the lifecycle of a single shared X server: adopt,
//!   spawn/supervise, reuse across sessions, idle shutdown.
//! - This module (#1052) adds the cross-platform [`ensure_x_server`]
//!   orchestrator, the [`XServerProvisionerImpl`] that bridges core's SSH connect
//!   path (which cannot depend on the desktop app layer) to it, and the Tauri
//!   command surface in [`crate::commands::xserver`].

#[cfg(windows)]
pub mod acquire;
pub mod auth;
pub mod manager;
mod orchestrator;
mod types;

use std::sync::Arc;

use async_trait::async_trait;
use tauri::{AppHandle, Manager};
use termihub_core::backends::ssh::x11::{ResolvedXServer, XServerProvisioner};

use crate::connection::manager::ConnectionManager;

pub use manager::XServerManager;
pub use orchestrator::{current_status, ensure_x_server, EnsureOutcome};
pub use types::{
    XServerError, XServerPlatform, XServerProgress, XServerStatusReport, X_SERVER_PROGRESS_EVENT,
};

/// Resolve whether automatic X server provisioning is enabled.
///
/// Reads the global `provideXServerAutomatically` setting; when unset it
/// defaults to `true` on Windows (the platform where the "app provides the
/// server" model applies) and `false` elsewhere.
pub fn resolve_provide_automatically(app: &AppHandle) -> bool {
    let default = cfg!(target_os = "windows");
    app.try_state::<ConnectionManager>()
        .map(|manager| {
            manager
                .get_settings()
                .provide_x_server_automatically
                .unwrap_or(default)
        })
        .unwrap_or(default)
}

/// The desktop-side [`XServerProvisioner`] registered into core at startup.
///
/// Core's SSH connect path calls [`ensure`](XServerProvisioner::ensure) before
/// starting X11 forwarding; this runs the orchestrator (off the async reactor,
/// since detection briefly blocks) and returns the managed server to forward to
/// — or `Ok(None)` to let core adopt a user-run server, or an actionable `Err`.
pub struct XServerProvisionerImpl {
    app: AppHandle,
    manager: Arc<XServerManager>,
}

impl XServerProvisionerImpl {
    /// Create a provisioner bound to the app handle and shared manager.
    pub fn new(app: AppHandle, manager: Arc<XServerManager>) -> Self {
        Self { app, manager }
    }
}

#[async_trait]
impl XServerProvisioner for XServerProvisionerImpl {
    async fn ensure(&self) -> Result<Option<ResolvedXServer>, String> {
        // Run the orchestrator (adopt / spawn / launch XQuartz / typed error) and
        // hand the connect path the server it resolved — managed or adopted —
        // together with its cookie, so the forwarder performs no second probe.
        // `Ok` always carries a resolved server; the "nothing usable" case is an
        // `Err`, and the "no provisioner registered" case is handled in core.
        ensure_off_reactor(&self.app, self.manager.clone())
            .await
            .map(|outcome| Some(outcome.resolved))
            .map_err(|e| e.to_string())
    }
}

/// Run [`ensure_x_server`] off the async reactor — detection does a brief
/// blocking TCP probe / filesystem scan. Shared by the provisioner and the
/// `x_server_ensure` command so the blocking-offload and settings resolution
/// live in one place.
pub(crate) async fn ensure_off_reactor(
    app: &AppHandle,
    manager: Arc<XServerManager>,
) -> Result<EnsureOutcome, XServerError> {
    let provide = resolve_provide_automatically(app);
    tokio::task::spawn_blocking(move || ensure_x_server(&manager, provide))
        .await
        .map_err(|e| XServerError::LaunchFailed {
            message: format!("X server provisioning task failed: {e}"),
        })?
}

/// Install the X server provisioner into core so the SSH connect path can reach
/// it. Call once at startup, after the manager is created.
pub fn init(app: &AppHandle, manager: Arc<XServerManager>) {
    let provisioner = Arc::new(XServerProvisionerImpl::new(app.clone(), manager));
    termihub_core::backends::ssh::x11::set_x_server_provisioner(provisioner);
}
