//! X server provisioning subsystem (epic #1047, issue #1052).
//!
//! Ties together the cross-platform [`ensure_x_server`] orchestrator, the
//! [`XServerManager`] lifecycle-state seam, and the [`XServerProvisionerImpl`]
//! that bridges core's SSH connect path (which cannot depend on the desktop app
//! layer) to this orchestrator. The Tauri command surface lives in
//! [`crate::commands::xserver`].

mod manager;
mod orchestrator;
mod types;

use std::sync::Arc;

use async_trait::async_trait;
use tauri::{AppHandle, Manager};
use termihub_core::backends::ssh::x11::{ManagedXServer, XServerProvisioner};

use crate::connection::manager::ConnectionManager;

pub use manager::XServerManager;
pub use orchestrator::{current_status, ensure_x_server};
pub use types::{
    XServerError, XServerPlatform, XServerProgress, XServerStatus, X_SERVER_PROGRESS_EVENT,
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
/// starting X11 forwarding; this implementation runs the orchestrator (off the
/// async reactor, since detection briefly blocks) and returns the managed server
/// to forward to — or `Ok(None)` to let core adopt a user-run server, or an
/// actionable `Err` message.
pub struct XServerProvisionerImpl {
    app: AppHandle,
    manager: XServerManager,
}

impl XServerProvisionerImpl {
    /// Create a provisioner bound to the app handle and shared manager.
    pub fn new(app: AppHandle, manager: XServerManager) -> Self {
        Self { app, manager }
    }
}

#[async_trait]
impl XServerProvisioner for XServerProvisionerImpl {
    async fn ensure(&self) -> Result<Option<ManagedXServer>, String> {
        let provide = resolve_provide_automatically(&self.app);
        let manager = self.manager.clone();

        // Detection does a short blocking TCP probe / filesystem scan; keep it
        // off the async reactor.
        let result = tokio::task::spawn_blocking(move || ensure_x_server(&manager, provide))
            .await
            .map_err(|e| format!("X server provisioning task failed: {e}"))?;

        match result {
            // A managed server (once #1049 spawns one) is forwarded to directly;
            // an adopted external server yields `None` so core detection finds it.
            Ok(_status) => {
                use termihub_core::backends::ssh::x11::ManagedXServerSource;
                Ok(self.manager.managed_server())
            }
            Err(err) => Err(err.to_string()),
        }
    }
}

/// Install the X server provisioner into core so the SSH connect path can reach
/// it, and return the manager to register as Tauri state. Call once at startup.
pub fn init(app: &AppHandle, manager: XServerManager) {
    let provisioner = Arc::new(XServerProvisionerImpl::new(app.clone(), manager));
    termihub_core::backends::ssh::x11::set_x_server_provisioner(provisioner);
}
