//! Tauri commands for the shell-integration config model (#1367) and OS
//! context-menu registration (#1368).

use tauri::State;

use crate::connection::manager::ConnectionManager;
use crate::connection::shell_integration::{self, ShellIntegrationStatus};
use crate::spawn::registry;
use crate::utils::portable::detect_app_mode;

/// Build the current shell-integration status from persisted settings + runtime
/// facts (executable path, portable mode, detected file managers).
fn current_status(manager: &ConnectionManager) -> ShellIntegrationStatus {
    let settings = manager.get_settings();
    let current_exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    // Portable mode is best-effort: if detection fails, assume installed.
    let portable = detect_app_mode()
        .map(|mode| mode.is_portable())
        .unwrap_or(false);
    let detected = registry::detect_file_managers();

    shell_integration::build_status(
        &settings.shell_integration,
        current_exe.as_deref(),
        portable,
        detected,
    )
}

/// Report the current shell-integration registration status.
///
/// Combines the persisted settings with runtime facts: whether the integration
/// is registered, whether the executable path recorded at registration still
/// matches the current executable (staleness), whether the app runs in portable
/// mode (where staleness is expected), and the detected file managers (stubbed
/// empty until per-OS detection lands).
#[tauri::command]
pub fn get_shell_integration_status(
    manager: State<'_, ConnectionManager>,
) -> Result<ShellIntegrationStatus, String> {
    Ok(current_status(&manager))
}

/// Register the configured entries as OS file-manager context-menu items and
/// persist the updated registration status.
///
/// Windows writes user-level (HKCU) Explorer registry keys (#1368); no elevation
/// is required. On platforms without registration support the underlying call
/// returns a clear "unsupported on this platform" error and settings are left
/// unchanged. Returns the refreshed status.
#[tauri::command]
pub fn install_shell_integration(
    manager: State<'_, ConnectionManager>,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    registry::register(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    Ok(current_status(&manager))
}

/// Remove all OS file-manager context-menu registrations and persist the
/// updated registration status. Returns the refreshed status.
#[tauri::command]
pub fn uninstall_shell_integration(
    manager: State<'_, ConnectionManager>,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    registry::unregister(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    Ok(current_status(&manager))
}
