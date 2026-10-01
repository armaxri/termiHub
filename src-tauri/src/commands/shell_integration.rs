//! Tauri commands for the shell-integration config model (#1367) and OS
//! context-menu registration (#1368).

use tauri::{AppHandle, State};

use crate::connection::manager::ConnectionManager;
use crate::connection::settings::AppSettings;
use crate::connection::shell_integration::{
    self, DetectedFileManager, PickedTarget, ShellIntegrationSettings, ShellIntegrationStatus,
};
use crate::spawn::registry;
use crate::utils::errors::TerminalError;
use crate::utils::portable::{detect_app_mode, AppMode};

/// Map an OS context-menu registration failure into a typed [`TerminalError`]
/// (ARCH-006 / TAURI-008 / ERR-008 Phase 2), preserving the exact anyhow chain
/// text (`{:#}`) the command previously surfaced as a raw `String`. The failure
/// is a generic backend-operation failure with no more specific variant, so it
/// maps to [`TerminalError::InternalError`].
fn registration_error(e: &anyhow::Error) -> TerminalError {
    TerminalError::InternalError(format!("{e:#}"))
}

/// Map a settings-persistence failure into a typed [`TerminalError`], preserving
/// the exact message text (`Display`) the command previously surfaced as a raw
/// `String`. Maps to [`TerminalError::InternalError`] — a settings-store write
/// failure has no more specific existing variant.
fn persist_error(e: impl std::fmt::Display) -> TerminalError {
    TerminalError::InternalError(e.to_string())
}

/// Build the current shell-integration status from persisted settings + runtime
/// facts (executable path, portable mode, detected file managers).
fn current_status(manager: &ConnectionManager) -> ShellIntegrationStatus {
    let settings = manager.get_settings();
    status_from_runtime(
        &settings.shell_integration,
        std::env::current_exe().ok().as_deref(),
        detect_app_mode(),
        registry::detect_file_managers(),
    )
}

/// Fold the raw runtime facts into a [`ShellIntegrationStatus`]: the current
/// executable (when resolvable) is compared against the recorded
/// `registered_exe_path` for staleness, and portable mode is reported so the UI
/// can exempt it — a portable binary travels with its `data/` directory, so a
/// moved executable is expected there rather than an error.
///
/// Portable detection is best-effort: if it fails, assume an installed app (not
/// portable), so a genuinely moved installed binary still surfaces as stale.
/// Split from [`current_status`] so the staleness wiring is unit-testable
/// without touching the real executable path.
fn status_from_runtime(
    settings: &ShellIntegrationSettings,
    current_exe: Option<&std::path::Path>,
    app_mode: anyhow::Result<AppMode>,
    detected: Vec<DetectedFileManager>,
) -> ShellIntegrationStatus {
    let current_exe = current_exe.map(|p| p.to_string_lossy().into_owned());
    let portable = app_mode.map(|mode| mode.is_portable()).unwrap_or(false);
    shell_integration::build_status(settings, current_exe.as_deref(), portable, detected)
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
) -> Result<ShellIntegrationStatus, TerminalError> {
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
) -> Result<ShellIntegrationStatus, TerminalError> {
    let mut settings = manager.get_settings();
    registry::register(&mut settings.shell_integration).map_err(|e| registration_error(&e))?;
    manager.save_settings(settings).map_err(persist_error)?;
    fold_settings(&app);
    Ok(current_status(&manager))
}

/// Remove all OS file-manager context-menu registrations and persist the
/// updated registration status. Returns the refreshed status.
#[tauri::command]
pub fn uninstall_shell_integration(
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<ShellIntegrationStatus, TerminalError> {
    let mut settings = manager.get_settings();
    registry::unregister(&mut settings.shell_integration).map_err(|e| registration_error(&e))?;
    manager.save_settings(settings).map_err(persist_error)?;
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
) -> Result<ShellIntegrationStatus, TerminalError> {
    let mut settings = manager.get_settings();
    let re_register = stage_shell_integration(&mut settings, shell_integration);
    if re_register {
        registry::register(&mut settings.shell_integration).map_err(|e| registration_error(&e))?;
    }
    manager.save_settings(settings).map_err(persist_error)?;
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
) -> Result<ShellIntegrationStatus, TerminalError> {
    let mut settings = manager.get_settings();
    if !stage_remembered_choice(&mut settings, &entry_id, target) {
        return Ok(current_status(&manager));
    }
    if settings.shell_integration.registered {
        registry::register(&mut settings.shell_integration).map_err(|e| registration_error(&e))?;
    }
    manager.save_settings(settings).map_err(persist_error)?;
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

    // ── Staleness wiring (#4010) ─────────────────────────────────────────────
    //
    // `status_from_runtime` is what `get_shell_integration_status` and every
    // mutating command return: it compares the recorded `registered_exe_path`
    // with the current executable and carries the portable flag the UI uses to
    // exempt a moved portable binary from the "reinstall" banner.

    fn registered_at(path: &str) -> ShellIntegrationSettings {
        ShellIntegrationSettings {
            registered: true,
            registered_exe_path: Some(path.to_string()),
            ..ShellIntegrationSettings::default()
        }
    }

    fn portable_mode() -> anyhow::Result<AppMode> {
        Ok(AppMode::Portable {
            data_dir: std::path::PathBuf::from("/media/usb/termiHub/data"),
        })
    }

    #[test]
    fn registered_at_the_current_exe_is_not_stale() {
        let status = status_from_runtime(
            &registered_at("/opt/termihub/termiHub"),
            Some(std::path::Path::new("/opt/termihub/termiHub")),
            Ok(AppMode::Installed),
            Vec::new(),
        );
        assert!(status.registered);
        assert!(status.exe_path_matches);
        assert!(!status.stale);
        assert!(!status.portable);
        assert_eq!(
            status.current_exe_path.as_deref(),
            Some("/opt/termihub/termiHub")
        );
    }

    #[test]
    fn registered_at_a_moved_exe_is_stale() {
        let status = status_from_runtime(
            &registered_at("/opt/termihub/termiHub"),
            Some(std::path::Path::new("/home/user/Apps/termiHub")),
            Ok(AppMode::Installed),
            Vec::new(),
        );
        assert!(!status.exe_path_matches);
        assert!(
            status.stale,
            "an installed binary that moved needs re-registration"
        );
        assert!(!status.portable);
        assert_eq!(
            status.registered_exe_path.as_deref(),
            Some("/opt/termihub/termiHub")
        );
        assert_eq!(
            status.current_exe_path.as_deref(),
            Some("/home/user/Apps/termiHub")
        );
    }

    /// The portable exemption: a moved portable binary is still reported stale
    /// (the registration really does point at the old path), but the status
    /// carries `portable` so the settings UI presents it as expected instead of
    /// raising the "Executable moved" banner.
    #[test]
    fn moved_portable_exe_is_stale_but_flagged_portable() {
        let status = status_from_runtime(
            &registered_at("/media/old-usb/termiHub/termiHub"),
            Some(std::path::Path::new("/media/usb/termiHub/termiHub")),
            portable_mode(),
            Vec::new(),
        );
        assert!(status.stale);
        assert!(status.portable);
    }

    #[test]
    fn portable_detection_failure_assumes_installed() {
        // A failed detection must not hide a genuinely moved installed binary.
        let status = status_from_runtime(
            &registered_at("/opt/termihub/termiHub"),
            Some(std::path::Path::new("/somewhere/else/termiHub")),
            Err(anyhow::anyhow!("cannot resolve executable directory")),
            Vec::new(),
        );
        assert!(status.stale);
        assert!(!status.portable);
    }

    #[test]
    fn unresolvable_current_exe_is_stale_when_registered_only() {
        // No current executable never matches the recorded path…
        let registered = status_from_runtime(
            &registered_at("/opt/termihub/termiHub"),
            None,
            Ok(AppMode::Installed),
            Vec::new(),
        );
        assert!(registered.current_exe_path.is_none());
        assert!(!registered.exe_path_matches);
        assert!(registered.stale);

        // …but an unregistered integration is never stale.
        let unregistered = status_from_runtime(
            &ShellIntegrationSettings::default(),
            None,
            Ok(AppMode::Installed),
            Vec::new(),
        );
        assert!(!unregistered.stale);
    }

    #[test]
    fn detected_file_managers_pass_through_unchanged() {
        let managers = vec![DetectedFileManager {
            id: "thunar".to_string(),
            name: "Thunar".to_string(),
            detected: true,
            version: Some("4.18.4".to_string()),
        }];
        let status = status_from_runtime(
            &ShellIntegrationSettings::default(),
            None,
            Ok(AppMode::Installed),
            managers.clone(),
        );
        assert_eq!(status.detected_file_managers, managers);
    }

    // ── Typed error envelope (ARCH-006 / TAURI-008 / ERR-008 Phase 2) ─────────
    //
    // These guard the String → TerminalError retype: the human message text the
    // commands surfaced before must survive verbatim as the error payload (only
    // the typed variant's classifying prefix is added, matching every other
    // typed command and the #3168 envelope).

    #[test]
    fn registration_error_preserves_the_anyhow_chain_text() {
        let src = anyhow::anyhow!("unsupported on this platform").context("failed to register");
        let mapped = registration_error(&src);
        assert!(matches!(mapped, TerminalError::InternalError(_)));

        // The full `{:#}` anyhow chain the command produced before survives verbatim.
        let expected_chain = format!("{src:#}");
        assert!(
            mapped.to_string().contains(&expected_chain),
            "human message must be preserved, got {mapped}"
        );
        assert!(mapped.to_string().contains("unsupported on this platform"));
        assert_eq!(
            mapped.to_string(),
            format!("Internal error: {expected_chain}")
        );
    }

    #[test]
    fn persist_error_preserves_the_message_text() {
        let src = anyhow::anyhow!("Failed to persist settings");
        let mapped = persist_error(&src);
        assert!(matches!(mapped, TerminalError::InternalError(_)));

        // The exact `Display` text the command produced before survives verbatim.
        assert!(
            mapped.to_string().contains("Failed to persist settings"),
            "human message must be preserved, got {mapped}"
        );
        assert_eq!(
            mapped.to_string(),
            "Internal error: Failed to persist settings"
        );
    }
}
