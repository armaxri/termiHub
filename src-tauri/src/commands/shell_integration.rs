//! Tauri commands for the shell-integration config model (#1367) and OS
//! context-menu registration (#1368).

use tauri::State;

use crate::connection::manager::ConnectionManager;
use crate::connection::settings::AppSettings;
use crate::connection::shell_integration::{
    self, ShellIntegrationSettings, ShellIntegrationStatus,
};
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
/// mode (where staleness is expected), and the file managers detected on the
/// host (Linux: Nautilus / Dolphin / Thunar with versions; macOS/Windows: the
/// native manager).
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

/// Replace the shell-integration settings on `settings` and report whether the
/// OS registration must be refreshed afterwards.
///
/// Re-registration only runs when the integration **was** registered and the
/// incoming settings keep it registered — editing entries while registered
/// should keep the OS context-menu items in sync. Turning registration off is
/// handled by [`uninstall_shell_integration`], not here, so a `registered:
/// false` payload never triggers a registry write.
fn stage_shell_integration(settings: &mut AppSettings, new_si: ShellIntegrationSettings) -> bool {
    let re_register = settings.shell_integration.registered && new_si.registered;
    settings.shell_integration = new_si;
    re_register
}

/// Persist the shell-integration settings and, when currently registered,
/// refresh the OS context-menu registration so it reflects the edited entries.
///
/// The settings UI calls this for every mutation (entry add/edit/reorder/delete,
/// fallback + window-behaviour radios, Linux per-manager toggles, and the
/// first-launch banner dismissal). Returns the recomputed status so the UI can
/// surface the staleness banner without a second round-trip.
#[tauri::command]
pub fn save_shell_integration_settings(
    manager: State<'_, ConnectionManager>,
    shell_integration: ShellIntegrationSettings,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    let re_register = stage_shell_integration(&mut settings, shell_integration);
    if re_register {
        registry::register(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    }
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    Ok(current_status(&manager))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::shell_integration::{ShellEntry, ShellEntryVisibility, ShowForTargets};

    fn entry(id: &str) -> ShellEntry {
        ShellEntry {
            id: id.to_string(),
            name: "Open in termiHub".to_string(),
            connection_id: None,
            visibility: ShellEntryVisibility::Always,
            show_for: ShowForTargets::default(),
            container_image: None,
            container_mount: None,
        }
    }

    #[test]
    fn stage_replaces_entries_and_gates_reregistration() {
        // Was registered, stays registered → re-register to keep the OS in sync.
        let mut settings = AppSettings::default();
        settings.shell_integration.registered = true;
        let mut new_si = ShellIntegrationSettings {
            registered: true,
            entries: vec![entry("a")],
            ..ShellIntegrationSettings::default()
        };
        assert!(stage_shell_integration(&mut settings, new_si.clone()));
        assert_eq!(settings.shell_integration.entries, vec![entry("a")]);

        // Not previously registered → never touches the registry.
        let mut fresh = AppSettings::default();
        assert!(!stage_shell_integration(&mut fresh, new_si.clone()));

        // Payload turns registration off → no registry write (uninstall owns that).
        let mut on = AppSettings::default();
        on.shell_integration.registered = true;
        new_si.registered = false;
        assert!(!stage_shell_integration(&mut on, new_si));
    }
}
