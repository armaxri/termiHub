//! Directory-mount container spawn resolution (#1372).
//!
//! Turns a [`SpawnRequest`](super::SpawnRequest) that targets a "new container"
//! into a Docker/Podman session definition: the requested host directory is
//! bind-mounted into a fresh container, the interactive shell opens `cd`'d to
//! the mount, and the container is *stopped but not removed* when the session
//! closes (so the user can inspect or restart it).
//!
//! This module owns only the pure request → config mapping (image / mount
//! resolution and bind construction). Session creation and tab tracking live in
//! the session manager; the interactive picker that chooses "new container"
//! (SI-3) is out of scope.

use serde::Serialize;
use termihub_core::config::{ContainerRuntime, DockerConfig, VolumeMount};

use super::SpawnRequest;

/// Fallback image used when neither the request nor a saved per-entry
/// preference names one. A small, ubiquitous base image keeps the first-run
/// pull fast and predictable.
pub const DEFAULT_CONTAINER_IMAGE: &str = "ubuntu:22.04";

/// Default mount target inside the container when the request does not override
/// it. Matches the concept's `/workspace` convention.
pub const DEFAULT_MOUNT_TARGET: &str = "/workspace";

/// A resolved container spawn: the Docker settings JSON to hand to
/// `create_connection("docker", …)` plus a display title carrying the
/// "Spawned" marker for the tab badge.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSpawn {
    /// Docker backend settings (camelCase JSON) for the spawned session.
    pub settings: serde_json::Value,
    /// Human-readable tab title, e.g. `"Container: ubuntu:22.04 (Spawned)"`.
    pub title: String,
    /// Always `true` — distinguishes spawned containers from configured Docker
    /// connections so the frontend can badge and track them separately.
    pub spawned: bool,
}

/// Resolve the container image in priority order: an explicit
/// `--container-image` value from the request, then a saved per-entry
/// preference, then [`DEFAULT_CONTAINER_IMAGE`]. Blank values are ignored.
pub fn resolve_container_image(explicit: Option<&str>, saved_pref: Option<&str>) -> String {
    non_blank(explicit)
        .or(non_blank(saved_pref))
        .unwrap_or(DEFAULT_CONTAINER_IMAGE)
        .to_string()
}

/// Resolve the in-container mount target in priority order: an explicit
/// `--container-mount` value from the request, then a saved per-entry
/// preference, then [`DEFAULT_MOUNT_TARGET`]. Blank values are ignored.
pub fn resolve_mount_target(explicit: Option<&str>, saved_pref: Option<&str>) -> String {
    non_blank(explicit)
        .or(non_blank(saved_pref))
        .unwrap_or(DEFAULT_MOUNT_TARGET)
        .to_string()
}

/// Resolve the host directory to bind-mount from a spawn `location`.
///
/// A directory is used as-is; an existing file resolves to its parent directory
/// (so "open in termiHub" on a file mounts its folder). A path that does not
/// exist is returned unchanged so the caller/daemon surfaces a clear error.
pub fn resolve_host_directory(location: &str) -> String {
    let path = std::path::Path::new(location);
    if path.is_file() {
        if let Some(parent) = path.parent() {
            return parent.to_string_lossy().into_owned();
        }
    }
    location.to_string()
}

/// Build the [`DockerConfig`] for a directory-mount spawn: a single read-write
/// bind of `host_dir` → `mount`, the shell's working directory set to the mount
/// (so it opens `cd`'d there), and `remove_on_exit = false` so closing the
/// session stops — but does not remove — the container.
///
/// `runtime` pins the container runtime — the Session Picker's Docker/Podman
/// choice (SI-3, #1366). [`ContainerRuntime::Auto`] keeps the pre-picker
/// behaviour of detecting whichever runtime is present.
pub fn build_spawn_docker_config(
    host_dir: &str,
    image: &str,
    mount: &str,
    runtime: ContainerRuntime,
) -> DockerConfig {
    DockerConfig {
        image: image.to_string(),
        runtime,
        volumes: vec![VolumeMount {
            host_path: host_dir.to_string(),
            container_path: mount.to_string(),
            read_only: false,
        }],
        working_directory: Some(mount.to_string()),
        // Stop — but do not remove — the container when the session closes, so
        // the user can restart or inspect it afterwards (#1372).
        remove_on_exit: false,
        ..DockerConfig::default()
    }
}

/// Resolve a full [`ContainerSpawn`] from a spawn request and the optional saved
/// per-entry image / mount preferences. For each, the explicit request value
/// wins, then the saved preference, then the built-in default.
pub fn build_container_spawn(
    req: &SpawnRequest,
    saved_image_pref: Option<&str>,
    saved_mount_pref: Option<&str>,
    runtime: ContainerRuntime,
) -> ContainerSpawn {
    let image = resolve_container_image(req.container_image.as_deref(), saved_image_pref);
    let mount = resolve_mount_target(req.container_mount.as_deref(), saved_mount_pref);
    let host_dir = resolve_host_directory(req.location.as_deref().unwrap_or("."));

    let config = build_spawn_docker_config(&host_dir, &image, &mount, runtime);
    // Serializing the config yields the exact camelCase JSON the Docker
    // backend's `parse_docker_settings` consumes, so there is one source of
    // truth for the field shape.
    let settings = serde_json::to_value(&config).unwrap_or_else(|_| serde_json::json!({}));

    ContainerSpawn {
        settings,
        title: format!("Container: {image} (Spawned)"),
        spawned: true,
    }
}

/// Ignore blank/whitespace-only overrides so an empty CLI flag falls through to
/// the next resolution tier.
fn non_blank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req_with(location: Option<&str>, image: Option<&str>, mount: Option<&str>) -> SpawnRequest {
        SpawnRequest {
            location: location.map(str::to_string),
            container_image: image.map(str::to_string),
            container_mount: mount.map(str::to_string),
            ..SpawnRequest::default()
        }
    }

    // ── image resolution ──────────────────────────────────────────────────

    #[test]
    fn image_prefers_explicit_request_value() {
        assert_eq!(
            resolve_container_image(Some("alpine:3"), Some("saved:1")),
            "alpine:3"
        );
    }

    #[test]
    fn image_falls_back_to_saved_pref_then_default() {
        assert_eq!(resolve_container_image(None, Some("saved:1")), "saved:1");
        assert_eq!(resolve_container_image(None, None), DEFAULT_CONTAINER_IMAGE);
    }

    #[test]
    fn image_ignores_blank_overrides() {
        assert_eq!(
            resolve_container_image(Some("   "), Some("saved:1")),
            "saved:1"
        );
        assert_eq!(
            resolve_container_image(Some(""), None),
            DEFAULT_CONTAINER_IMAGE
        );
    }

    // ── mount resolution ──────────────────────────────────────────────────

    #[test]
    fn mount_defaults_to_workspace() {
        assert_eq!(resolve_mount_target(None, None), DEFAULT_MOUNT_TARGET);
        assert_eq!(resolve_mount_target(Some("  "), None), DEFAULT_MOUNT_TARGET);
    }

    #[test]
    fn mount_honours_explicit_value() {
        assert_eq!(resolve_mount_target(Some("/src"), None), "/src");
    }

    #[test]
    fn mount_prefers_explicit_then_saved_then_default() {
        // explicit > saved > default, mirroring image resolution.
        assert_eq!(resolve_mount_target(Some("/src"), Some("/saved")), "/src");
        assert_eq!(resolve_mount_target(None, Some("/saved")), "/saved");
        assert_eq!(resolve_mount_target(Some("  "), Some("/saved")), "/saved");
        assert_eq!(resolve_mount_target(None, None), DEFAULT_MOUNT_TARGET);
    }

    // ── host directory resolution ─────────────────────────────────────────

    #[test]
    fn host_dir_uses_directory_as_is() {
        let dir = std::env::temp_dir();
        let resolved = resolve_host_directory(&dir.to_string_lossy());
        assert_eq!(resolved, dir.to_string_lossy());
    }

    #[test]
    fn host_dir_resolves_file_to_parent() {
        let dir = std::env::temp_dir();
        let file = dir.join(format!("termihub-spawn-test-{}.txt", std::process::id()));
        std::fs::write(&file, b"x").expect("write temp file");
        let resolved = resolve_host_directory(&file.to_string_lossy());
        std::fs::remove_file(&file).ok();
        // Compare against the file's own parent (temp_dir may carry a trailing
        // separator on some platforms that `Path::parent` normalizes away).
        assert_eq!(resolved, file.parent().unwrap().to_string_lossy());
    }

    #[test]
    fn host_dir_nonexistent_returned_unchanged() {
        assert_eq!(
            resolve_host_directory("/no/such/path/xyzzy-1372"),
            "/no/such/path/xyzzy-1372"
        );
    }

    // ── docker config construction ────────────────────────────────────────

    #[test]
    fn spawn_config_mounts_dir_and_sets_working_dir() {
        let cfg = build_spawn_docker_config(
            "/home/user/proj",
            "alpine:3",
            "/workspace",
            ContainerRuntime::Auto,
        );
        assert_eq!(cfg.image, "alpine:3");
        assert_eq!(cfg.volumes.len(), 1);
        assert_eq!(cfg.volumes[0].host_path, "/home/user/proj");
        assert_eq!(cfg.volumes[0].container_path, "/workspace");
        assert!(!cfg.volumes[0].read_only, "spawn mount must be writable");
        assert_eq!(cfg.working_directory.as_deref(), Some("/workspace"));
    }

    #[test]
    fn spawn_config_stops_not_removes_on_exit() {
        let cfg = build_spawn_docker_config("/h", "img", "/workspace", ContainerRuntime::Auto);
        assert!(
            !cfg.remove_on_exit,
            "spawned containers are stopped, not removed, on close"
        );
    }

    // ── end-to-end request mapping ────────────────────────────────────────

    #[test]
    fn build_container_spawn_defaults_mount_and_image() {
        let req = req_with(Some("/home/user/app"), None, None);
        let spawn = build_container_spawn(&req, None, None, ContainerRuntime::Auto);
        assert!(spawn.spawned);
        assert!(spawn.title.contains("Spawned"), "title: {}", spawn.title);
        let vols = spawn
            .settings
            .get("volumes")
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(vols.len(), 1);
        assert_eq!(vols[0]["hostPath"], "/home/user/app");
        assert_eq!(vols[0]["containerPath"], DEFAULT_MOUNT_TARGET);
        assert_eq!(spawn.settings["workingDirectory"], DEFAULT_MOUNT_TARGET);
        assert_eq!(spawn.settings["removeOnExit"], false);
        assert_eq!(spawn.settings["image"], DEFAULT_CONTAINER_IMAGE);
    }

    #[test]
    fn build_container_spawn_honours_explicit_image_and_mount() {
        let req = req_with(Some("/data"), Some("node:20"), Some("/srv"));
        let spawn = build_container_spawn(&req, None, None, ContainerRuntime::Auto);
        assert_eq!(spawn.settings["image"], "node:20");
        assert_eq!(spawn.settings["workingDirectory"], "/srv");
        let vols = spawn
            .settings
            .get("volumes")
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(vols[0]["containerPath"], "/srv");
        assert!(spawn.title.contains("node:20"), "title: {}", spawn.title);
    }

    #[test]
    fn build_container_spawn_honours_saved_prefs_when_request_is_blank() {
        // No explicit request image/mount → the saved per-entry preferences are
        // used (the #1447 wiring), ahead of the built-in defaults.
        let req = req_with(Some("/data"), None, None);
        let spawn = build_container_spawn(
            &req,
            Some("saved:9"),
            Some("/saved"),
            ContainerRuntime::Auto,
        );
        assert_eq!(spawn.settings["image"], "saved:9");
        assert_eq!(spawn.settings["workingDirectory"], "/saved");
        let vols = spawn
            .settings
            .get("volumes")
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(vols[0]["containerPath"], "/saved");
    }

    #[test]
    fn build_container_spawn_explicit_beats_saved_prefs() {
        // Explicit request values win over the saved per-entry preferences.
        let req = req_with(Some("/data"), Some("node:20"), Some("/srv"));
        let spawn = build_container_spawn(
            &req,
            Some("saved:9"),
            Some("/saved"),
            ContainerRuntime::Auto,
        );
        assert_eq!(spawn.settings["image"], "node:20");
        assert_eq!(spawn.settings["workingDirectory"], "/srv");
    }

    #[test]
    fn build_container_spawn_settings_roundtrip_to_docker_config() {
        // The produced settings must parse back into a DockerConfig cleanly so
        // the Docker backend's `parse_docker_settings` accepts them verbatim.
        let req = req_with(Some("/proj"), Some("alpine"), Some("/workspace"));
        let spawn = build_container_spawn(&req, None, None, ContainerRuntime::Auto);
        let parsed: DockerConfig =
            serde_json::from_value(spawn.settings).expect("settings parse as DockerConfig");
        assert_eq!(parsed.image, "alpine");
        assert!(!parsed.remove_on_exit);
        assert_eq!(parsed.volumes.len(), 1);
        assert_eq!(parsed.working_directory.as_deref(), Some("/workspace"));
    }
}
