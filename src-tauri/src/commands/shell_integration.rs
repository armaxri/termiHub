//! Tauri commands for the shell-integration config model (#1367) and OS
//! context-menu registration (#1368).

use tauri::{AppHandle, State};

use crate::connection::manager::ConnectionManager;
use crate::connection::settings::AppSettings;
use crate::connection::shell_integration::{
    self, PickedTarget, ShellIntegrationSettings, ShellIntegrationStatus,
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

/// Reflect the just-persisted `AppSettings` document — including the updated
/// `shell_integration` block — into the shared `SettingsStore` server-side, so
/// the `settings` projection region mirrors a shell-integration change at the
/// source (#2407, hardening #2227's reducer-removal).
///
/// The analog of the `save_settings` fold (#2386): every shell-integration
/// command below persists through the `ConnectionManager` authority and then
/// calls this, so the region reflects install / uninstall / edit / remembered-
/// choice outcomes without depending on the frontend's follow-up `settings.patch`
/// dispatch. Best-effort and non-fatal — it is a no-op when the store or manager
/// is unmanaged (see [`fold_settings_from_manager`]). `AppHandle` is Tauri-
/// injected, so this adds nothing to the JS invoke surface.
fn fold_settings(app: &AppHandle) {
    crate::settings_projection::projection::fold_settings_from_manager(app);
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
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    registry::register(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    fold_settings(&app);
    Ok(current_status(&manager))
}

/// Remove all OS file-manager context-menu registrations and persist the
/// updated registration status. Returns the refreshed status.
#[tauri::command]
pub fn uninstall_shell_integration(
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    registry::unregister(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    fold_settings(&app);
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
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
    shell_integration: ShellIntegrationSettings,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    let re_register = stage_shell_integration(&mut settings, shell_integration);
    if re_register {
        registry::register(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    }
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    fold_settings(&app);
    Ok(current_status(&manager))
}

/// Save a picked target onto the entry addressed by `entry_id`, returning whether
/// an entry actually changed. An unknown id is a no-op — the entry may have been
/// deleted between the context-menu click and the picker's confirm.
fn stage_remembered_choice(
    settings: &mut AppSettings,
    entry_id: &str,
    target: PickedTarget,
) -> bool {
    match settings
        .shell_integration
        .entries
        .iter_mut()
        .find(|e| e.id == entry_id)
    {
        Some(entry) => {
            entry.remember(target);
            true
        }
        None => false,
    }
}

/// Persist the Session Picker's "Remember this choice" (#1561): save the picked
/// target onto the triggering entry so a later context-menu click opens it
/// directly instead of prompting again.
///
/// Re-registers when the integration is currently registered, because the entry's
/// remembered kind is part of the command line the OS surface invokes
/// (`--kind <token>`) — without that the OS would keep calling the pre-choice
/// command. Returns the recomputed status, mirroring
/// [`save_shell_integration_settings`].
#[tauri::command]
pub fn remember_spawn_choice(
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
    entry_id: String,
    target: PickedTarget,
) -> Result<ShellIntegrationStatus, String> {
    let mut settings = manager.get_settings();
    if !stage_remembered_choice(&mut settings, &entry_id, target) {
        return Ok(current_status(&manager));
    }
    if settings.shell_integration.registered {
        registry::register(&mut settings.shell_integration).map_err(|e| format!("{e:#}"))?;
    }
    manager.save_settings(settings).map_err(|e| e.to_string())?;
    fold_settings(&app);
    Ok(current_status(&manager))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::shell_integration::{ShellEntry, ShellEntryVisibility, ShowForTargets};
    use crate::spawn::SpawnKind;
    use termihub_core::config::ContainerRuntime;

    fn entry(id: &str) -> ShellEntry {
        ShellEntry {
            id: id.to_string(),
            name: "Open in termiHub".to_string(),
            connection_id: None,
            visibility: ShellEntryVisibility::Always,
            show_for: ShowForTargets::default(),
            container_image: None,
            container_mount: None,
            spawn_kind: SpawnKind::Auto,
            shell: None,
            container_runtime: ContainerRuntime::Auto,
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

    // ── Remember this choice (#1561) ─────────────────────────────────────────

    #[test]
    fn stage_remembered_choice_writes_the_picked_target_onto_the_entry() {
        let mut settings = AppSettings::default();
        settings.shell_integration.entries = vec![entry("a"), entry("b")];

        assert!(stage_remembered_choice(
            &mut settings,
            "b",
            PickedTarget::Container {
                runtime: ContainerRuntime::Podman,
                image: "alpine:3".to_string(),
                mount: "/workspace".to_string(),
            },
        ));

        let b = &settings.shell_integration.entries[1];
        assert_eq!(b.spawn_kind, SpawnKind::Container);
        assert_eq!(b.container_runtime, ContainerRuntime::Podman);
        assert_eq!(b.container_image.as_deref(), Some("alpine:3"));
        assert_eq!(b.container_mount.as_deref(), Some("/workspace"));

        // The choice must land on the addressed entry only.
        assert_eq!(settings.shell_integration.entries[0], entry("a"));
    }

    /// The entry can be deleted between the context-menu click and the picker's
    /// confirm. That must be a quiet no-op, not an error or an invented entry.
    #[test]
    fn stage_remembered_choice_ignores_an_unknown_entry() {
        let mut settings = AppSettings::default();
        settings.shell_integration.entries = vec![entry("a")];

        assert!(!stage_remembered_choice(
            &mut settings,
            "gone",
            PickedTarget::Local {
                shell: "zsh".to_string()
            },
        ));

        assert_eq!(settings.shell_integration.entries, vec![entry("a")]);
    }
}
