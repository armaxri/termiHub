//! Tauri commands for the CLI/context-menu spawn integration (#1372).
//!
//! Exposes the directory-mount container spawn resolution to the frontend: given
//! a spawn `location` and optional image / mount overrides, returns the Docker
//! settings + tab title the frontend uses to open a "new container" session with
//! the target directory bind-mounted. The interactive picker that chooses "new
//! container" (SI-3) and the frontend session/tab wiring are out of scope here.

use tauri::State;

use crate::connection::manager::ConnectionManager;
use crate::connection::shell_integration::ShellIntegrationSettings;
use crate::spawn::container::{self, ContainerSpawn};
use crate::spawn::handler::{self, PendingSpawn, ShellSpawn};
use crate::spawn::{SpawnKind, SpawnRequest};

/// The saved per-entry container preferences (image + mount target) looked up
/// for a spawn's `--entry-id`, if any.
type SavedContainerPrefs = (Option<String>, Option<String>);

/// Look up the saved per-entry container image / mount preferences for the entry
/// addressed by `entry_id`. An absent or unknown id yields no preference, so the
/// spawn falls through to the request value and then the built-in defaults.
fn saved_container_prefs(
    settings: &ShellIntegrationSettings,
    entry_id: Option<&str>,
) -> SavedContainerPrefs {
    entry_id
        .and_then(|id| settings.entries.iter().find(|e| e.id == id))
        .map(|e| (e.container_image.clone(), e.container_mount.clone()))
        .unwrap_or((None, None))
}

/// Resolve a directory-mount container spawn into Docker session settings,
/// honoring any saved per-entry image / mount preference (#1447).
///
/// Mirrors the CLI `termiHub spawn --entry-id … --location … [--container-image
/// …] [--container-mount …]` inputs. Image and mount are each resolved in strict
/// priority order: explicit request value > the saved per-entry preference (the
/// entry addressed by `entry_id`) > the built-in default. The returned
/// [`ContainerSpawn`] carries the camelCase Docker settings JSON (single bind of
/// the resolved host directory to the mount, working directory set to the mount,
/// `removeOnExit: false` so the container is stopped-not-removed on close), a
/// `"… (Spawned)"` tab title, and `spawned: true` so the frontend can badge and
/// track them separately from configured Docker connections.
#[tauri::command]
pub fn resolve_container_spawn(
    manager: State<'_, ConnectionManager>,
    location: Option<String>,
    entry_id: Option<String>,
    container_image: Option<String>,
    container_mount: Option<String>,
) -> Result<ContainerSpawn, String> {
    let settings = manager.get_settings();
    resolve_container_spawn_with(
        &settings.shell_integration,
        location,
        entry_id,
        container_image,
        container_mount,
    )
}

/// Pure resolution shared by the Tauri command and its tests: validate the
/// location, look up the saved per-entry preferences, and build the spawn.
fn resolve_container_spawn_with(
    settings: &ShellIntegrationSettings,
    location: Option<String>,
    entry_id: Option<String>,
    container_image: Option<String>,
    container_mount: Option<String>,
) -> Result<ContainerSpawn, String> {
    if location.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("a spawn location is required for a container spawn".to_string());
    }
    let (saved_image, saved_mount) = saved_container_prefs(settings, entry_id.as_deref());
    let request = SpawnRequest {
        location,
        entry_id,
        container_image,
        container_mount,
        ..SpawnRequest::default()
    };
    Ok(container::build_container_spawn(
        &request,
        saved_image.as_deref(),
        saved_mount.as_deref(),
    ))
}

/// Resolve a local/WSL/SSH spawn into local-shell session settings (#1365, SI-2).
///
/// The parallel of [`resolve_container_spawn`] for the "open a shell at the
/// target directory" path. The requested `location` is resolved to a working
/// directory (folder → itself, file → parent, missing → the home directory,
/// symlinks resolved) which becomes the shell's `startingDirectory`; a WSL-kind
/// spawn converts that directory to its `/mnt/` path. The returned [`ShellSpawn`]
/// carries the camelCase local-shell settings, a `"… (Spawned)"` tab title,
/// `spawned: true`, and a `missing` flag the frontend surfaces as a warning.
#[tauri::command]
pub fn resolve_shell_spawn(
    location: Option<String>,
    connection: Option<String>,
    entry_id: Option<String>,
    kind: Option<String>,
) -> ShellSpawn {
    let kind = kind
        .as_deref()
        .and_then(SpawnKind::from_wire)
        .unwrap_or_default();
    let request = SpawnRequest {
        location,
        connection,
        entry_id,
        kind,
        ..SpawnRequest::default()
    };
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    handler::build_shell_spawn(&request, &home)
}

/// Drain the cold-start pending spawn, if any (#1365).
///
/// A spawn handed to a freshly-launched instance before the UI is ready is
/// parked in [`PendingSpawn`] (no event listener exists yet); the frontend calls
/// this once its `spawn-request` subscription is registered to pick it up and
/// process it through the same path as a live event.
#[tauri::command]
pub fn take_pending_spawn(pending: State<'_, PendingSpawn>) -> Option<SpawnRequest> {
    handler::take_pending_spawn(&pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::shell_integration::{ShellEntry, ShellEntryVisibility, ShowForTargets};

    fn settings_with_entry(
        id: &str,
        image: Option<&str>,
        mount: Option<&str>,
    ) -> ShellIntegrationSettings {
        ShellIntegrationSettings {
            entries: vec![ShellEntry {
                id: id.to_string(),
                name: "Open in termiHub".to_string(),
                connection_id: None,
                visibility: ShellEntryVisibility::Always,
                show_for: ShowForTargets::default(),
                container_image: image.map(str::to_string),
                container_mount: mount.map(str::to_string),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn requires_a_location() {
        let settings = ShellIntegrationSettings::default();
        assert!(resolve_container_spawn_with(&settings, None, None, None, None).is_err());
        assert!(
            resolve_container_spawn_with(&settings, Some("  ".into()), None, None, None).is_err()
        );
    }

    #[test]
    fn resolves_settings_for_a_location() {
        let settings = ShellIntegrationSettings::default();
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            None,
            Some("alpine".into()),
            None,
        )
        .expect("resolves");
        assert!(spawn.spawned);
        assert_eq!(spawn.settings["image"], "alpine");
        assert_eq!(spawn.settings["removeOnExit"], false);
    }

    #[test]
    fn saved_entry_preference_is_honored_when_no_explicit_value() {
        // The entry's saved image/mount are used when the request omits them.
        let settings = settings_with_entry("e1", Some("saved:9"), Some("/saved"));
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            Some("e1".into()),
            None,
            None,
        )
        .expect("resolves");
        assert_eq!(spawn.settings["image"], "saved:9");
        assert_eq!(spawn.settings["workingDirectory"], "/saved");
    }

    #[test]
    fn explicit_request_value_beats_saved_entry_preference() {
        let settings = settings_with_entry("e1", Some("saved:9"), Some("/saved"));
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            Some("e1".into()),
            Some("node:20".into()),
            Some("/srv".into()),
        )
        .expect("resolves");
        assert_eq!(spawn.settings["image"], "node:20");
        assert_eq!(spawn.settings["workingDirectory"], "/srv");
    }

    #[test]
    fn unknown_entry_id_falls_back_to_defaults() {
        let settings = settings_with_entry("e1", Some("saved:9"), Some("/saved"));
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            Some("does-not-exist".into()),
            None,
            None,
        )
        .expect("resolves");
        assert_eq!(spawn.settings["image"], container::DEFAULT_CONTAINER_IMAGE);
        assert_eq!(
            spawn.settings["workingDirectory"],
            container::DEFAULT_MOUNT_TARGET
        );
    }

    // ---- WSL / SSH shell-spawn resolution (#1511) --------------------------

    use crate::terminal::backend::ConnectionConfig;

    fn saved_conn(
        id: &str,
        name: &str,
        type_id: &str,
        settings: serde_json::Value,
    ) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: name.to_string(),
            config: ConnectionConfig {
                type_id: type_id.to_string(),
                settings,
            },
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }
    }

    fn wsl_request(location: Option<&str>, connection: Option<&str>) -> SpawnRequest {
        SpawnRequest {
            location: location.map(str::to_string),
            connection: connection.map(str::to_string),
            kind: SpawnKind::Wsl,
            ..SpawnRequest::default()
        }
    }

    fn ssh_request(location: Option<&str>, connection: Option<&str>) -> SpawnRequest {
        SpawnRequest {
            location: location.map(str::to_string),
            connection: connection.map(str::to_string),
            kind: SpawnKind::Ssh,
            ..SpawnRequest::default()
        }
    }

    #[test]
    fn wsl_spawn_uses_default_distro_and_mount_path() {
        // No --connection → the system default distro; a Windows home converts to
        // its /mnt/ form (location None falls back to the home dir).
        let home = Path::new(r"C:\Users\foo");
        let req = wsl_request(None, None);
        let spawn = resolve_shell_spawn_with(&req, home, &[], Some("Ubuntu")).expect("resolves");
        assert_eq!(spawn.session_type, "wsl");
        assert_eq!(spawn.settings["distribution"], "Ubuntu");
        assert_eq!(spawn.settings["startingDirectory"], "/mnt/c/Users/foo");
        assert!(spawn.cd_path.is_none());
    }

    #[test]
    fn wsl_spawn_prefers_saved_connection_distribution() {
        // A --connection pointing at a saved WSL connection wins over the default.
        let home = Path::new(r"C:\Users\foo");
        let conns = vec![saved_conn(
            "Work/Debian box",
            "Debian box",
            "wsl",
            serde_json::json!({ "distribution": "Debian" }),
        )];
        let req = wsl_request(None, Some("Work/Debian box"));
        let spawn = resolve_shell_spawn_with(&req, home, &conns, Some("Ubuntu")).expect("resolves");
        assert_eq!(spawn.settings["distribution"], "Debian");
    }

    #[test]
    fn wsl_spawn_without_any_distro_is_an_error() {
        // No connection and no default distro (e.g. a non-Windows host) → error.
        let home = Path::new("/home/user");
        let req = wsl_request(None, None);
        let err = resolve_shell_spawn_with(&req, home, &[], None).expect_err("no distro");
        assert!(err.contains("WSL distribution"), "err: {err}");
    }

    #[test]
    fn ssh_spawn_maps_to_saved_connection_settings_and_cd_path() {
        let home = Path::new("/home/user");
        let ssh_settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "me",
        });
        let conns = vec![saved_conn("Prod/Web", "Web", "ssh", ssh_settings.clone())];
        let req = ssh_request(Some("/srv/app"), Some("Prod/Web"));
        let spawn = resolve_shell_spawn_with(&req, home, &conns, None).expect("resolves");
        assert_eq!(spawn.session_type, "ssh");
        assert_eq!(spawn.settings, ssh_settings);
        assert_eq!(spawn.cd_path.as_deref(), Some("/srv/app"));
        assert_eq!(spawn.title, "Web (Spawned)");
        assert!(spawn.spawned);
    }

    #[test]
    fn ssh_spawn_without_connection_id_is_an_error() {
        let home = Path::new("/home/user");
        let req = ssh_request(Some("/srv/app"), None);
        let err = resolve_shell_spawn_with(&req, home, &[], None).expect_err("needs id");
        assert!(err.contains("--connection"), "err: {err}");
    }

    #[test]
    fn ssh_spawn_unknown_connection_is_an_error() {
        let home = Path::new("/home/user");
        let req = ssh_request(Some("/srv/app"), Some("nope"));
        let err = resolve_shell_spawn_with(&req, home, &[], None).expect_err("not found");
        assert!(err.contains("not found"), "err: {err}");
    }

    #[test]
    fn ssh_spawn_rejects_a_non_ssh_connection() {
        let home = Path::new("/home/user");
        let conns = vec![saved_conn(
            "Local/Home",
            "Home",
            "local",
            serde_json::json!({ "shell": "bash" }),
        )];
        let req = ssh_request(Some("/srv/app"), Some("Local/Home"));
        let err = resolve_shell_spawn_with(&req, home, &conns, None).expect_err("wrong type");
        assert!(err.contains("not an SSH connection"), "err: {err}");
    }

    #[test]
    fn local_spawn_is_unchanged_by_the_dispatcher() {
        // A local/auto kind still opens a local shell with a startingDirectory.
        let home = Path::new("/home/user");
        let req = SpawnRequest {
            location: None,
            kind: SpawnKind::Local,
            ..SpawnRequest::default()
        };
        let spawn = resolve_shell_spawn_with(&req, home, &[], None).expect("resolves");
        assert_eq!(spawn.session_type, "local");
        assert_eq!(spawn.settings["startingDirectory"], "/home/user");
    }
}
