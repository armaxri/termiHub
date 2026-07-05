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
/// macOS runs a guided, consent-based XQuartz install (#1054): Homebrew when
/// present, otherwise actionable download guidance. Windows VcXsrv acquisition
/// (#1048) and Linux (never installs) still return their typed guidance so the
/// UI (#1053) has something concrete to show.
#[tauri::command]
pub async fn x_server_install_dependency(app: AppHandle) -> Result<(), XServerError> {
    emit_progress(&app, "install", "Preparing X dependency install…", -1.0);
    match XServerPlatform::current() {
        XServerPlatform::MacOs => finish(
            &app,
            xserver::macos::install_xquartz().await,
            "XQuartz is ready.",
        ),
        XServerPlatform::Windows => finish(
            &app,
            Err(XServerError::windows_provisioning_unavailable()),
            "",
        ),
        XServerPlatform::Linux => finish(&app, Err(XServerError::linux_install_unsupported()), ""),
    }
}

/// Emit the terminal progress event for an install `result` and return it, so the
/// success/failure tail is written once. Mirrors the `Ok/Err => emit` shape
/// [`x_server_ensure`] already uses.
fn finish(
    app: &AppHandle,
    result: Result<(), XServerError>,
    ok_message: &str,
) -> Result<(), XServerError> {
    match &result {
        Ok(()) => emit_progress(app, "ready", ok_message, 1.0),
        Err(err) => emit_progress(app, "failed", &err.to_string(), 1.0),
    }
    result
}
