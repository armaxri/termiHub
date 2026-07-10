//! Tauri commands for the shell-integration config model (#1367).

use tauri::State;

use crate::connection::manager::ConnectionManager;
use crate::connection::shell_integration::{self, ShellIntegrationStatus};
use crate::utils::portable::detect_app_mode;

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
    let settings = manager.get_settings();
    let current_exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    // Portable mode is best-effort: if detection fails, assume installed.
    let portable = detect_app_mode()
        .map(|mode| mode.is_portable())
        .unwrap_or(false);
    let detected = shell_integration::detect_file_managers();

    Ok(shell_integration::build_status(
        &settings.shell_integration,
        current_exe.as_deref(),
        portable,
        detected,
    ))
}
