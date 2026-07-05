//! Tauri command surface for X server provisioning (#1052).
//!
//! Four commands back the frontend (settings toggle, connect-time provisioning,
//! and the Open Connections "X Servers" section — #1053):
//!
//! | Command | Purpose |
//! | --- | --- |
//! | [`x_server_status`] | Current server state (absent / adopted / running). |
//! | [`x_server_ensure`] | Ensure a usable server, or return a typed error. |
//! | [`x_server_stop`] | Stop the termiHub-managed server. |
//! | [`x_server_install_dependency`] | Install/guide the platform X dependency. |
//!
//! Progress is reported via the [`X_SERVER_PROGRESS_EVENT`] event, whose payload
//! ([`XServerProgress`]) mirrors the agent-deploy progress shape. The lifecycle
//! itself lives in [`crate::terminal::xserver::manager`] (#1049).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::terminal::xserver::manager::XServerStatus as ManagedStatus;
use crate::terminal::xserver::{
    self, XServerError, XServerManager, XServerPlatform, XServerProgress, XServerStatusReport,
    X_SERVER_PROGRESS_EVENT,
};

/// Emit an X server provisioning progress event (best-effort).
fn emit_progress(app: &AppHandle, step: &str, message: &str, progress: f64) {
    let _ = app.emit(
        X_SERVER_PROGRESS_EVENT,
        XServerProgress {
            step: step.to_string(),
            message: message.to_string(),
            progress,
        },
    );
}

/// Report the current local X server status without side effects.
#[tauri::command]
pub fn x_server_status(manager: State<'_, Arc<XServerManager>>) -> XServerStatusReport {
    xserver::current_status(&manager)
}

/// Ensure a usable local X server for the current platform.
///
/// Returns a coherent status on success (adopted external or managed running),
/// or a typed, actionable [`XServerError`] the UI can act on.
#[tauri::command]
pub async fn x_server_ensure(
    app: AppHandle,
    manager: State<'_, Arc<XServerManager>>,
) -> Result<XServerStatusReport, XServerError> {
    emit_progress(&app, "detect", "Checking for a local X server…", -1.0);

    let result = xserver::ensure_off_reactor(&app, manager.inner().clone()).await;

    match &result {
        Ok(outcome) => emit_progress(
            &app,
            "ready",
            outcome
                .report
                .message
                .as_deref()
                .unwrap_or("X server ready."),
            1.0,
        ),
        Err(err) => emit_progress(&app, "failed", &err.to_string(), 1.0),
    }
    result.map(|outcome| outcome.report)
}

/// Stop the termiHub-managed X server, if one is running.
///
/// Adopted external servers are never stopped — termiHub only shuts down what it
/// started.
#[tauri::command]
pub fn x_server_stop(
    app: AppHandle,
    manager: State<'_, Arc<XServerManager>>,
) -> Result<(), XServerError> {
    if !matches!(manager.status(), ManagedStatus::Running { .. }) {
        return Ok(());
    }
    manager.stop();
    emit_progress(&app, "stopped", "X server stopped.", 1.0);
    Ok(())
}

/// Install (or guide the install of) the platform's X dependency.
///
/// The real installers are their own issues (#1048 VcXsrv, #1054 XQuartz); until
/// they land this returns the same typed guidance the orchestrator produces, so
/// the UI (#1053) has something concrete to show rather than a silent no-op.
#[tauri::command]
pub async fn x_server_install_dependency(app: AppHandle) -> Result<(), XServerError> {
    emit_progress(&app, "install", "Preparing X dependency install…", -1.0);
    let err = match XServerPlatform::current() {
        XServerPlatform::Windows => XServerError::windows_provisioning_unavailable(),
        XServerPlatform::MacOs => XServerError::xquartz_missing(),
        XServerPlatform::Linux => XServerError::linux_install_unsupported(),
    };
    emit_progress(&app, "failed", &err.to_string(), 1.0);
    Err(err)
}
