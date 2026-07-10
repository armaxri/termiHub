//! Shell-integration configuration model (#1367).
//!
//! Config-model foundation for the Shell Context Menu & CLI Spawn Integration
//! epic (#1363). This module owns the persisted settings shape
//! ([`ShellIntegrationSettings`] and friends), the **pure**, platform-independent
//! connection-type resolution priority ([`resolve_connection`]), and the
//! staleness comparison used by the status command ([`exe_path_matches`]).
//!
//! It performs **no** OS writes — actual per-OS registration (registry / desktop
//! files / Quick Actions) and file-manager detection land in later epic issues.

use serde::{Deserialize, Serialize};

/// Windows context-menu visibility for a shell-integration entry.
///
/// On non-Windows platforms this has no effect (each entry is a separate named
/// action); it is still resolved so the model is uniform across platforms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellEntryVisibility {
    /// Always shown in the context menu.
    #[default]
    Always,
    /// Shown only in the extended (Shift+Right-click) menu on Windows.
    Extended,
}

/// Which right-click targets an entry is offered for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShowForTargets {
    /// Right-click on a folder.
    pub folders: bool,
    /// Right-click on a file (opens a terminal in the parent directory).
    pub files: bool,
    /// Right-click on the folder background (empty space).
    pub folder_background: bool,
}

impl Default for ShowForTargets {
    fn default() -> Self {
        Self {
            folders: true,
            files: false,
            folder_background: false,
        }
    }
}

/// A single configurable "Open in termiHub" quick-access entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEntry {
    /// Stable identifier embedded in the registered command (`--entry-id`).
    pub id: String,
    /// Display name shown in the file-manager context menu.
    pub name: String,
    /// Saved connection this entry opens. `None` means the entry shows the
    /// interactive session picker instead of a fixed connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// Windows context-menu visibility (Always / Extended-only).
    #[serde(default)]
    pub visibility: ShellEntryVisibility,
    /// Which right-click targets this entry is registered for.
    #[serde(default)]
    pub show_for: ShowForTargets,
}

/// Fallback behaviour when no entry resolves a spawn request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellIntegrationFallback {
    /// Show the interactive session picker.
    #[default]
    Picker,
    /// Open the system default shell without prompting.
    SystemDefaultShell,
}

/// Linux per-file-manager install toggles.
///
/// These are Linux-only in effect; the fields exist on every platform so the
/// settings shape is uniform and forward-compatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinuxFileManagerToggles {
    /// Install Nautilus (GNOME) scripts.
    pub nautilus: bool,
    /// Install the KDE (Dolphin) service menu.
    pub kde: bool,
    /// Install the Thunar (XFCE) custom action.
    pub thunar: bool,
}

/// Persisted shell-integration settings.
///
/// Modelled on the existing `external_connection_files` pattern: a plain,
/// `#[serde(default)]`-driven struct so older `settings.json` files that predate
/// this feature deserialize cleanly (forward-compat).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShellIntegrationSettings {
    /// Configured quick-access entries, in display / priority order.
    pub entries: Vec<ShellEntry>,
    /// What to do when no entry resolves a request.
    pub fallback: ShellIntegrationFallback,
    /// Open spawned sessions in a new window instead of the running instance.
    pub open_in_new_window: bool,
    /// Whether the OS context-menu integration is currently registered.
    pub registered: bool,
    /// Absolute executable path recorded at registration time. Compared against
    /// the current executable to detect a stale registration (see
    /// [`exe_path_matches`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_exe_path: Option<String>,
    /// Linux per-file-manager install toggles.
    pub linux_file_managers: LinuxFileManagerToggles,
    /// Whether the user dismissed the first-launch install banner.
    pub first_launch_banner_dismissed: bool,
}

impl Default for ShellIntegrationSettings {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            fallback: ShellIntegrationFallback::default(),
            open_in_new_window: false,
            registered: false,
            registered_exe_path: None,
            linux_file_managers: LinuxFileManagerToggles::default(),
            first_launch_banner_dismissed: false,
        }
    }
}

/// The resolved connection selector for a spawn request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedConnection {
    /// Open the saved connection with this id.
    Connection(String),
    /// Show the interactive session picker.
    Picker,
    /// Open the system default shell.
    SystemDefaultShell,
}

/// Resolve the effective connection selector for a spawn request in strict
/// priority order:
///
/// 1. explicit `--connection <id>` override (`connection_override`)
/// 2. the entry addressed by `--entry-id` (`entry_id`), if it exists
/// 3. the first `Always`-visibility entry (the configured default)
/// 4. the `fallback` setting (picker or system default shell)
///
/// An entry with no `connection_id` is a picker entry and resolves to
/// [`ResolvedConnection::Picker`]. Pure and platform-independent so it is
/// exhaustively unit-testable.
pub fn resolve_connection(
    settings: &ShellIntegrationSettings,
    connection_override: Option<&str>,
    entry_id: Option<&str>,
) -> ResolvedConnection {
    // NOTE: stubbed for the TDD red phase — implemented in a follow-up commit.
    let _ = (settings, connection_override, entry_id);
    todo!("resolve_connection not yet implemented")
}

/// Compare the executable path recorded at registration against the current
/// executable path, returning `true` when they refer to the same binary.
///
/// A missing side never matches. On Windows the comparison is case-insensitive.
/// This is the primitive behind the status command's staleness flag. Pure so it
/// is unit-testable without touching the filesystem.
pub fn exe_path_matches(registered_exe_path: Option<&str>, current_exe_path: Option<&str>) -> bool {
    // NOTE: stubbed for the TDD red phase — implemented in a follow-up commit.
    let _ = (registered_exe_path, current_exe_path);
    todo!("exe_path_matches not yet implemented")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, connection: Option<&str>, visibility: ShellEntryVisibility) -> ShellEntry {
        ShellEntry {
            id: id.to_string(),
            name: format!("Entry {id}"),
            connection_id: connection.map(str::to_string),
            visibility,
            show_for: ShowForTargets::default(),
        }
    }

    fn settings_with(
        entries: Vec<ShellEntry>,
        fallback: ShellIntegrationFallback,
    ) -> ShellIntegrationSettings {
        ShellIntegrationSettings {
            entries,
            fallback,
            ..Default::default()
        }
    }

    // ── Resolution priority — all four precedence tiers ──────────────────

    #[test]
    fn tier1_explicit_connection_override_wins() {
        let settings = settings_with(
            vec![entry("e1", Some("saved-a"), ShellEntryVisibility::Always)],
            ShellIntegrationFallback::SystemDefaultShell,
        );
        // Override beats a matching entry-id and the default entry.
        let resolved = resolve_connection(&settings, Some("override-conn"), Some("e1"));
        assert_eq!(
            resolved,
            ResolvedConnection::Connection("override-conn".to_string())
        );
    }

    #[test]
    fn tier2_entry_id_selects_that_entry() {
        let settings = settings_with(
            vec![
                entry("e1", Some("saved-a"), ShellEntryVisibility::Always),
                entry("e2", Some("saved-b"), ShellEntryVisibility::Extended),
            ],
            ShellIntegrationFallback::Picker,
        );
        let resolved = resolve_connection(&settings, None, Some("e2"));
        assert_eq!(
            resolved,
            ResolvedConnection::Connection("saved-b".to_string())
        );
    }

    #[test]
    fn tier2_picker_entry_resolves_to_picker() {
        let settings = settings_with(
            vec![entry("pick", None, ShellEntryVisibility::Extended)],
            ShellIntegrationFallback::SystemDefaultShell,
        );
        let resolved = resolve_connection(&settings, None, Some("pick"));
        assert_eq!(resolved, ResolvedConnection::Picker);
    }

    #[test]
    fn tier2_unknown_entry_id_falls_through_to_default_entry() {
        let settings = settings_with(
            vec![entry("e1", Some("saved-a"), ShellEntryVisibility::Always)],
            ShellIntegrationFallback::Picker,
        );
        // Unknown entry-id → falls through to the first Always entry (tier 3).
        let resolved = resolve_connection(&settings, None, Some("does-not-exist"));
        assert_eq!(
            resolved,
            ResolvedConnection::Connection("saved-a".to_string())
        );
    }

    #[test]
    fn tier3_first_always_entry_is_the_default() {
        let settings = settings_with(
            vec![
                entry("e1", Some("saved-extended"), ShellEntryVisibility::Extended),
                entry("e2", Some("saved-default"), ShellEntryVisibility::Always),
                entry("e3", Some("saved-other"), ShellEntryVisibility::Always),
            ],
            ShellIntegrationFallback::Picker,
        );
        // No override, no entry-id → first Always entry (skips the Extended one).
        let resolved = resolve_connection(&settings, None, None);
        assert_eq!(
            resolved,
            ResolvedConnection::Connection("saved-default".to_string())
        );
    }

    #[test]
    fn tier4_fallback_picker_when_no_entry_matches() {
        let settings = settings_with(
            vec![entry("e1", Some("saved-a"), ShellEntryVisibility::Extended)],
            ShellIntegrationFallback::Picker,
        );
        // Only Extended entries → no Always default → fallback.
        let resolved = resolve_connection(&settings, None, None);
        assert_eq!(resolved, ResolvedConnection::Picker);
    }

    #[test]
    fn tier4_fallback_system_default_shell() {
        let settings = settings_with(Vec::new(), ShellIntegrationFallback::SystemDefaultShell);
        let resolved = resolve_connection(&settings, None, None);
        assert_eq!(resolved, ResolvedConnection::SystemDefaultShell);
    }

    // ── Staleness comparison ─────────────────────────────────────────────

    #[test]
    fn exe_path_matches_identical_paths() {
        assert!(exe_path_matches(
            Some("/opt/termihub/termiHub"),
            Some("/opt/termihub/termiHub")
        ));
    }

    #[test]
    fn exe_path_mismatch_when_moved() {
        assert!(!exe_path_matches(
            Some("/opt/termihub/termiHub"),
            Some("/home/user/Downloads/termiHub")
        ));
    }

    #[test]
    fn exe_path_no_match_when_registered_path_missing() {
        assert!(!exe_path_matches(None, Some("/opt/termihub/termiHub")));
    }

    #[test]
    fn exe_path_no_match_when_current_path_missing() {
        assert!(!exe_path_matches(Some("/opt/termihub/termiHub"), None));
    }

    // ── Settings serde round-trip + forward-compat ───────────────────────

    #[test]
    fn settings_round_trip() {
        let settings = ShellIntegrationSettings {
            entries: vec![
                entry("open", Some("saved-a"), ShellEntryVisibility::Always),
                entry("pick", None, ShellEntryVisibility::Extended),
            ],
            fallback: ShellIntegrationFallback::SystemDefaultShell,
            open_in_new_window: true,
            registered: true,
            registered_exe_path: Some("/opt/termihub/termiHub".to_string()),
            linux_file_managers: LinuxFileManagerToggles {
                nautilus: true,
                kde: false,
                thunar: true,
            },
            first_launch_banner_dismissed: true,
        };
        let json = serde_json::to_string(&settings).unwrap();
        let back: ShellIntegrationSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings, back);
    }

    #[test]
    fn empty_object_deserializes_to_defaults() {
        // Forward-compat: an empty object (all keys absent) yields defaults.
        let settings: ShellIntegrationSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, ShellIntegrationSettings::default());
        assert!(settings.entries.is_empty());
        assert_eq!(settings.fallback, ShellIntegrationFallback::Picker);
        assert!(!settings.registered);
        assert!(settings.registered_exe_path.is_none());
    }

    #[test]
    fn entry_defaults_applied_for_partial_json() {
        // An entry with only id + name gets default visibility / show_for.
        let json = r#"{"entries":[{"id":"e1","name":"Open in termiHub"}]}"#;
        let settings: ShellIntegrationSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.entries.len(), 1);
        let e = &settings.entries[0];
        assert!(e.connection_id.is_none());
        assert_eq!(e.visibility, ShellEntryVisibility::Always);
        assert!(e.show_for.folders);
        assert!(!e.show_for.files);
        assert!(!e.show_for.folder_background);
    }

    #[test]
    fn camel_case_field_names_in_json() {
        let settings = ShellIntegrationSettings {
            registered: true,
            registered_exe_path: Some("/opt/x".to_string()),
            open_in_new_window: true,
            first_launch_banner_dismissed: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("registeredExePath"));
        assert!(json.contains("openInNewWindow"));
        assert!(json.contains("firstLaunchBannerDismissed"));
        assert!(json.contains("linuxFileManagers"));
    }
}
