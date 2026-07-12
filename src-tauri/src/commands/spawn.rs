//! Tauri commands for the CLI/context-menu spawn integration (#1372).
//!
//! Exposes the directory-mount container spawn resolution to the frontend: given
//! a spawn `location` and optional image / mount overrides, returns the Docker
//! settings + tab title the frontend uses to open a "new container" session with
//! the target directory bind-mounted. The interactive picker that chooses "new
//! container" (SI-3) and the frontend session/tab wiring are out of scope here.

use crate::spawn::container::{self, ContainerSpawn};
use crate::spawn::SpawnRequest;

/// Resolve a directory-mount container spawn into Docker session settings.
///
/// Mirrors the CLI `termiHub spawn --location … [--container-image …]
/// [--container-mount …]` inputs. The returned [`ContainerSpawn`] carries the
/// camelCase Docker settings JSON (single bind of the resolved host directory →
/// mount, working directory set to the mount, `removeOnExit: false` so the
/// container is stopped-not-removed on close), a `"… (Spawned)"` tab title, and
/// `spawned: true` so the frontend can badge and track it separately from
/// configured Docker connections.
#[tauri::command]
pub fn resolve_container_spawn(
    location: Option<String>,
    container_image: Option<String>,
    container_mount: Option<String>,
) -> Result<ContainerSpawn, String> {
    if location.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("a spawn location is required for a container spawn".to_string());
    }
    let request = SpawnRequest {
        location,
        container_image,
        container_mount,
        ..SpawnRequest::default()
    };
    Ok(container::build_container_spawn(&request, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_location() {
        assert!(resolve_container_spawn(None, None, None).is_err());
        assert!(resolve_container_spawn(Some("  ".into()), None, None).is_err());
    }

    #[test]
    fn resolves_settings_for_a_location() {
        let spawn = resolve_container_spawn(Some("/proj".into()), Some("alpine".into()), None)
            .expect("resolves");
        assert!(spawn.spawned);
        assert_eq!(spawn.settings["image"], "alpine");
        assert_eq!(spawn.settings["removeOnExit"], false);
    }
}
