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
//! ([`XServerProgress`]) mirrors the agent-deploy progress shape.

use tauri::{AppHandle, Emitter, State};

use crate::terminal::xserver::{
    self, XServerError, XServerManager, XServerPlatform, XServerProgress, XServerStatus,
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
pub fn x_server_status(manager: State<'_, XServerManager>) -> XServerStatus {
    xserver::current_status(&manager)
}

/// Ensure a usable local X server for the current platform.
///
/// Returns a coherent status on success (adopted external or managed running),
/// or a typed, actionable [`XServerError`] the UI can act on.
#[tauri::command]
pub async fn x_server_ensure(
    app: AppHandle,
    manager: State<'_, XServerManager>,
) -> Result<XServerStatus, XServerError> {
    emit_progress(&app, "detect", "Checking for a local X server…", -1.0);

    let provide = xserver::resolve_provide_automatically(&app);
    let manager = manager.inner().clone();
    let result = tokio::task::spawn_blocking(move || xserver::ensure_x_server(&manager, provide))
        .await
        .map_err(|e| XServerError::LaunchFailed {
            message: format!("X server provisioning task failed: {e}"),
        })?;

    match &result {
        Ok(status) => emit_progress(
            &app,
            "ready",
            status.message.as_deref().unwrap_or("X server ready."),
            1.0,
        ),
        Err(err) => emit_progress(&app, "failed", &err.to_string(), 1.0),
    }
    result
}

/// Stop the termiHub-managed X server, if one is running.
///
/// Adopted external servers are never stopped — termiHub only shuts down what it
/// started.
#[tauri::command]
pub fn x_server_stop(app: AppHandle, manager: State<'_, XServerManager>) -> Result<(), XServerError> {
    if !manager.has_managed_server() {
        return Ok(());
    }
    manager.stop();
    emit_progress(&app, "stopped", "X server stopped.", 1.0);
    Ok(())
}

/// Install (or guide the install of) the platform's X dependency.
///
/// The actual installers are their own issues — Windows VcXsrv acquisition
/// (#1048) and macOS XQuartz install (#1054). Until they land this returns a
/// typed, actionable error carrying the manual install guidance, so the UI
/// (#1053) has something concrete to show rather than a silent no-op.
#[tauri::command]
pub async fn x_server_install_dependency(app: AppHandle) -> Result<(), XServerError> {
    emit_progress(&app, "install", "Preparing X dependency install…", -1.0);
    let err = match XServerPlatform::current() {
        XServerPlatform::Windows => XServerError::ProvisioningUnavailable {
            message: "Automatic VcXsrv download is not yet available in this build. Install \
                VcXsrv manually and start it on display :0."
                .to_string(),
        },
        XServerPlatform::MacOs => XServerError::DependencyMissing {
            message: "Automated XQuartz install is not yet available. Install it manually, then \
                reconnect."
                .to_string(),
            dependency: "XQuartz".to_string(),
            install_hint: Some(
                "Download XQuartz from https://www.xquartz.org, then log out and back in."
                    .to_string(),
            ),
            install_command: Some("brew install --cask xquartz".to_string()),
        },
        XServerPlatform::Linux => XServerError::Unsupported {
            message: "termiHub never installs an X server on Linux. Install your distribution's \
                Xorg or XWayland package via your package manager."
                .to_string(),
        },
    };
    emit_progress(&app, "failed", &err.to_string(), 1.0);
    Err(err)
}
