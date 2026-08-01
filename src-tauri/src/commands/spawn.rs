//! Tauri commands for the CLI/context-menu spawn integration (#1372).
//!
//! Exposes the directory-mount container spawn resolution to the frontend: given
//! a spawn `location` and optional image / mount overrides, returns the Docker
//! settings + tab title the frontend uses to open a "new container" session with
//! the target directory bind-mounted, plus the target enumeration
//! ([`list_spawn_options`]) backing the interactive Session Picker (SI-3, #1366).

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::connection::config::SavedConnection;
use crate::connection::manager::ConnectionManager;
use crate::connection::shell_integration::{ShellEntry, ShellIntegrationSettings};
use crate::spawn::container::{self, ContainerSpawn};
use crate::spawn::handler::{self, PendingSpawn, ShellSpawn};
use crate::spawn::{SpawnKind, SpawnRequest};
use termihub_core::config::ContainerRuntime;

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
    saved_entry(settings, entry_id)
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
///
/// `runtime` pins Docker or Podman — the Session Picker's choice of section
/// (SI-3, #1366). Omitted (or unrecognised) leaves the pre-picker behaviour of
/// auto-detecting whichever runtime is installed.
#[tauri::command]
pub fn resolve_container_spawn(
    manager: State<'_, ConnectionManager>,
    location: Option<String>,
    entry_id: Option<String>,
    container_image: Option<String>,
    container_mount: Option<String>,
    runtime: Option<String>,
) -> Result<ContainerSpawn, String> {
    let settings = manager.get_settings();
    resolve_container_spawn_with(
        &settings.shell_integration,
        location,
        entry_id,
        container_image,
        container_mount,
        container_runtime_from_wire(runtime.as_deref()),
    )
}

/// Look up the entry addressed by `entry_id`, if any. An absent or unknown id
/// yields `None`, so the spawn falls through to the request values and then the
/// built-in defaults.
fn saved_entry<'a>(
    settings: &'a ShellIntegrationSettings,
    entry_id: Option<&str>,
) -> Option<&'a ShellEntry> {
    entry_id.and_then(|id| settings.entries.iter().find(|e| e.id == id))
}

/// Map the frontend's runtime token onto a [`ContainerRuntime`]. Anything else —
/// including no token at all — means "detect it", which is what every pre-picker
/// spawn did.
fn container_runtime_from_wire(token: Option<&str>) -> ContainerRuntime {
    match token.map(str::trim) {
        Some("docker") => ContainerRuntime::Docker,
        Some("podman") => ContainerRuntime::Podman,
        _ => ContainerRuntime::Auto,
    }
}

/// Pure resolution shared by the Tauri command and its tests: validate the
/// location, look up the saved per-entry preferences, and build the spawn.
fn resolve_container_spawn_with(
    settings: &ShellIntegrationSettings,
    location: Option<String>,
    entry_id: Option<String>,
    container_image: Option<String>,
    container_mount: Option<String>,
    runtime: ContainerRuntime,
) -> Result<ContainerSpawn, String> {
    if location.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("a spawn location is required for a container spawn".to_string());
    }
    let (saved_image, saved_mount) = saved_container_prefs(settings, entry_id.as_deref());
    // An explicitly requested runtime wins; otherwise fall back to the one the
    // entry remembered (#1561), and only then to detection.
    let runtime = match runtime {
        ContainerRuntime::Auto => saved_entry(settings, entry_id.as_deref())
            .map(|e| e.container_runtime.clone())
            .unwrap_or_default(),
        explicit => explicit,
    };
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
        runtime,
    ))
}

/// Resolve a local/WSL/SSH spawn into the correct backend session settings
/// (#1365 for local, #1511 for WSL/SSH).
///
/// The parallel of [`resolve_container_spawn`] for the "open a shell at the
/// target directory" path, dispatching on the spawn `kind`:
///
/// - **local** — the requested `location` becomes a local shell's
///   `startingDirectory` (folder → itself, file → parent, missing → home,
///   symlinks resolved).
/// - **wsl** — the resolved directory is converted to its `/mnt/` form and a
///   `wsl` session opens the distribution there (distribution from the saved WSL
///   connection referenced by `--connection`, else the system default distro).
/// - **ssh** — the saved SSH connection referenced by `--connection` is opened;
///   its settings are used verbatim and the target `location` is returned as
///   `cdPath` for the frontend to `cd` into after connect (SSH has no start cwd).
///
/// Returns an error string (surfaced as a toast) when an SSH/WSL spawn cannot be
/// resolved to a connection/distribution.
#[tauri::command]
pub fn resolve_shell_spawn(
    manager: State<'_, ConnectionManager>,
    location: Option<String>,
    connection: Option<String>,
    entry_id: Option<String>,
    kind: Option<String>,
    shell: Option<String>,
) -> Result<ShellSpawn, String> {
    let settings = manager.get_settings();
    let entry = saved_entry(&settings.shell_integration, entry_id.as_deref());
    // An explicitly requested kind/shell wins; otherwise fall back to whatever the
    // entry remembered (#1561), and only then to the pre-picker defaults. A
    // context-menu click carries no shell and (for an un-remembered entry) an
    // `auto` kind, so this is what makes a remembered choice take effect.
    let kind = kind
        .as_deref()
        .and_then(SpawnKind::from_wire)
        .filter(|k| !matches!(k, SpawnKind::Auto))
        .or_else(|| entry.map(|e| e.spawn_kind))
        .unwrap_or_default();
    let shell = shell.or_else(|| {
        entry
            .and_then(ShellEntry::resolved_shell)
            .map(str::to_string)
    });
    let request = SpawnRequest {
        location,
        connection,
        entry_id,
        kind,
        ..SpawnRequest::default()
    };
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let connections = all_saved_connections(&manager);
    resolve_shell_spawn_with(
        &request,
        &home,
        &connections,
        default_wsl_distribution().as_deref(),
        shell.as_deref(),
    )
}

/// Gather every saved connection (main store + external files) so a spawn's
/// `--connection <id>` can be resolved regardless of which file it lives in.
/// Mirrors the flattening in `load_connections_and_folders`.
fn all_saved_connections(manager: &ConnectionManager) -> Vec<SavedConnection> {
    let mut connections = manager.get_all().map(|f| f.connections).unwrap_or_default();
    for source in manager.load_external_sources() {
        connections.extend(source.connections);
    }
    connections
}

/// The system default WSL distribution (the first installed one), used when a
/// WSL spawn does not reference a saved WSL connection. Windows-only; `None`
/// elsewhere (a WSL spawn on a non-Windows host must name a connection).
fn default_wsl_distribution() -> Option<String> {
    #[cfg(windows)]
    {
        termihub_core::session::shell::detect_wsl_distros()
            .into_iter()
            .next()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Pure resolution shared by the Tauri command and its tests: dispatch on the
/// spawn `kind` and build the matching backend settings.
fn resolve_shell_spawn_with(
    req: &SpawnRequest,
    home: &Path,
    connections: &[SavedConnection],
    default_wsl_distro: Option<&str>,
    shell: Option<&str>,
) -> Result<ShellSpawn, String> {
    match req.kind {
        SpawnKind::Ssh => resolve_ssh_spawn(req, connections),
        SpawnKind::Wsl => {
            let distribution =
                resolve_wsl_distribution(req, connections, default_wsl_distro, shell)?;
            Ok(handler::build_wsl_spawn(req, home, &distribution))
        }
        // Local / Auto (and any unexpected kind) open a local shell — the #1365
        // path, unchanged.
        _ => Ok(handler::build_shell_spawn(req, home, shell)),
    }
}

/// Resolve the WSL distribution for a spawn: the explicitly picked distribution
/// (SI-3, #1366), else the saved WSL connection referenced by `--connection` (if
/// it names a non-empty distribution), else the system default distro. Errors
/// when none is available.
fn resolve_wsl_distribution(
    req: &SpawnRequest,
    connections: &[SavedConnection],
    default_wsl_distro: Option<&str>,
    picked: Option<&str>,
) -> Result<String, String> {
    // A distribution the user chose in the picker outranks every fallback.
    if let Some(distro) = picked.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(distro.to_string());
    }

    if let Some(id) = req
        .connection
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(conn) = connections.iter().find(|c| c.id == id) {
            if conn.config.type_id == "wsl" {
                if let Some(distro) = conn
                    .config
                    .settings
                    .get("distribution")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return Ok(distro.to_string());
                }
            }
        }
    }

    default_wsl_distro
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            "no WSL distribution available — install one, or point --connection at a saved WSL connection"
                .to_string()
        })
}

/// Resolve an SSH spawn to a saved SSH connection referenced by `--connection`.
/// Errors with a clear message when the id is missing, unknown, or not SSH.
fn resolve_ssh_spawn(
    req: &SpawnRequest,
    connections: &[SavedConnection],
) -> Result<ShellSpawn, String> {
    let id = req
        .connection
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "an SSH spawn requires a saved connection (--connection <id>)".to_string()
        })?;

    let conn = connections
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("SSH connection '{id}' not found"))?;

    if conn.config.type_id != "ssh" {
        return Err(format!(
            "connection '{id}' is not an SSH connection (type: {})",
            conn.config.type_id
        ));
    }

    Ok(handler::build_ssh_spawn(
        req.location.as_deref(),
        &conn.config.settings,
        &conn.name,
    ))
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

/// The spawn targets available on this host, as offered by the Session Picker
/// (SI-3, #1366).
///
/// Every list is "what exists right now" — the picker renders a section per
/// non-empty group, so an absent runtime simply drops its section rather than
/// showing a disabled one. `wsl_distros` is always empty off Windows (the picker
/// hides the WSL section there), and the image lists are only populated when the
/// matching runtime reports itself available, so a stopped daemon costs one
/// probe instead of a hanging `images` call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Local shells detected on this host (e.g. `"bash"`, `"zsh"`, `"pwsh"`).
    pub shells: Vec<String>,
    /// Installed WSL distributions. Always empty off Windows.
    pub wsl_distros: Vec<String>,
    /// Whether a usable Docker daemon responded.
    pub docker_available: bool,
    /// Local Docker images (`repository:tag`). Empty unless `docker_available`.
    pub docker_images: Vec<String>,
    /// Whether a usable Podman runtime responded.
    pub podman_available: bool,
    /// Local Podman images (`repository:tag`). Empty unless `podman_available`.
    pub podman_images: Vec<String>,
}

/// Enumerate the spawn targets the Session Picker can offer (SI-3, #1366).
///
/// Called when the picker opens, so it reflects the host's live state rather
/// than a cached snapshot: shells and WSL distributions come from the same
/// detection the connection editors use, and each container runtime is probed
/// for availability before its images are listed.
#[tauri::command]
pub fn list_spawn_options() -> SpawnOptions {
    let docker_available = crate::utils::docker_detect::is_docker_available();
    let podman_available = crate::utils::docker_detect::is_podman_available();
    SpawnOptions {
        shells: termihub_core::session::shell::detect_available_shells(),
        wsl_distros: wsl_distros(),
        docker_available,
        docker_images: if docker_available {
            crate::utils::docker_detect::list_docker_images()
        } else {
            Vec::new()
        },
        podman_available,
        podman_images: if podman_available {
            crate::utils::docker_detect::list_podman_images()
        } else {
            Vec::new()
        },
    }
}

/// Installed WSL distributions on Windows; an empty list everywhere else, where
/// WSL cannot exist and the picker omits the section entirely.
fn wsl_distros() -> Vec<String> {
    #[cfg(windows)]
    {
        termihub_core::session::shell::detect_wsl_distros()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::shell_integration::{
        PickedTarget, ShellEntry, ShellEntryVisibility, ShowForTargets,
    };

    // `list_spawn_options` reports whatever the host actually has, so the
    // assertions below cover the invariants that must hold on every machine and
    // every CI platform — never a concrete shell/image list, which would make
    // the suite depend on the runner's installed software.

    #[test]
    fn list_spawn_options_holds_its_invariants() {
        let options = list_spawn_options();

        // An unavailable runtime must never report images: the picker uses the
        // availability flag to decide whether to render the section at all.
        if !options.docker_available {
            assert!(options.docker_images.is_empty());
        }
        if !options.podman_available {
            assert!(options.podman_images.is_empty());
        }

        // WSL exists only on Windows; elsewhere the section must stay empty so
        // the picker hides it.
        #[cfg(not(windows))]
        assert!(options.wsl_distros.is_empty());
    }

    #[test]
    fn a_picked_podman_runtime_reaches_the_session_settings() {
        // Picking the Podman section must actually run Podman — auto-detection
        // would silently prefer Docker on a host that has both.
        let settings = ShellIntegrationSettings::default();
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            None,
            None,
            None,
            container_runtime_from_wire(Some("podman")),
        )
        .expect("resolves");
        assert_eq!(spawn.settings["runtime"], "podman");

        // No pick keeps the pre-#1366 auto-detection.
        let auto = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            None,
            None,
            None,
            container_runtime_from_wire(None),
        )
        .expect("resolves");
        assert_eq!(auto.settings["runtime"], "auto");
    }

    #[test]
    fn a_picked_shell_is_opened_instead_of_the_system_default() {
        // The picker's whole point is choosing a specific shell, so the pick has
        // to reach the backend settings rather than falling back to the default.
        let home = Path::new("/tmp");
        let req = SpawnRequest {
            kind: SpawnKind::Local,
            ..SpawnRequest::default()
        };

        let picked =
            resolve_shell_spawn_with(&req, home, &[], None, Some("zsh")).expect("resolves");
        assert_eq!(
            picked.settings.get("shell").and_then(|v| v.as_str()),
            Some("zsh")
        );

        // No pick (every pre-#1366 spawn) must not pin a shell at all.
        let default = resolve_shell_spawn_with(&req, home, &[], None, None).expect("resolves");
        assert!(default.settings.get("shell").is_none());

        // A blank pick means "no choice", not a shell literally named "".
        let blank = resolve_shell_spawn_with(&req, home, &[], None, Some("  ")).expect("resolves");
        assert!(blank.settings.get("shell").is_none());
    }

    #[test]
    fn a_picked_wsl_distribution_outranks_the_default() {
        let home = Path::new("/tmp");
        let req = SpawnRequest {
            kind: SpawnKind::Wsl,
            ..SpawnRequest::default()
        };

        let spawn = resolve_shell_spawn_with(&req, home, &[], Some("Ubuntu"), Some("Debian"))
            .expect("resolves");
        assert_eq!(
            spawn.settings.get("distribution").and_then(|v| v.as_str()),
            Some("Debian")
        );
    }

    #[test]
    fn spawn_options_serialize_camel_case() {
        // The frontend `SpawnOptions` type mirrors these keys; a rename here
        // would silently strand the picker on `undefined`.
        let json = serde_json::to_value(SpawnOptions::default()).expect("serializes");
        for key in [
            "shells",
            "wslDistros",
            "dockerAvailable",
            "dockerImages",
            "podmanAvailable",
            "podmanImages",
        ] {
            assert!(json.get(key).is_some(), "missing key {key}");
        }
    }

    /// Settings holding a single entry with a remembered target (#1561) — what
    /// the picker's "Remember this choice" writes.
    fn settings_with_remembered(id: &str, target: PickedTarget) -> ShellIntegrationSettings {
        let mut settings = settings_with_entry(id, None, None);
        settings.entries[0].remember(target);
        settings
    }

    #[test]
    fn a_remembered_runtime_is_used_when_the_request_names_none() {
        // A context-menu click carries no runtime, so without the entry fallback
        // a remembered Podman pick would silently auto-detect — and run Docker.
        let settings = settings_with_remembered(
            "open",
            PickedTarget::Container {
                runtime: ContainerRuntime::Podman,
                image: "alpine:3".to_string(),
                mount: "/workspace".to_string(),
            },
        );
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            Some("open".into()),
            None,
            None,
            ContainerRuntime::Auto,
        )
        .expect("resolves");

        assert_eq!(spawn.settings["runtime"], "podman");
        assert_eq!(spawn.settings["image"], "alpine:3");
    }

    #[test]
    fn an_explicit_runtime_outranks_the_remembered_one() {
        let settings = settings_with_remembered(
            "open",
            PickedTarget::Container {
                runtime: ContainerRuntime::Podman,
                image: "alpine:3".to_string(),
                mount: "/workspace".to_string(),
            },
        );
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            Some("open".into()),
            None,
            None,
            ContainerRuntime::Docker,
        )
        .expect("resolves");

        assert_eq!(spawn.settings["runtime"], "docker");
    }

    /// An unknown entry id must not resurrect a stale preference.
    #[test]
    fn an_unknown_entry_id_keeps_runtime_auto_detection() {
        let settings = settings_with_remembered(
            "open",
            PickedTarget::Container {
                runtime: ContainerRuntime::Podman,
                image: "alpine:3".to_string(),
                mount: "/workspace".to_string(),
            },
        );
        let spawn = resolve_container_spawn_with(
            &settings,
            Some("/proj".into()),
            Some("deleted".into()),
            None,
            None,
            ContainerRuntime::Auto,
        )
        .expect("resolves");

        assert_eq!(spawn.settings["runtime"], "auto");
    }

    /// The #1561 read-side, end to end at the pure layer: a context-menu click on
    /// a remembered local entry (`--kind local`, no `--shell`) must open the
    /// remembered shell rather than the system default.
    #[test]
    fn a_remembered_local_shell_is_opened_for_a_context_menu_click() {
        let settings = settings_with_remembered(
            "open",
            PickedTarget::Local {
                shell: "fish".to_string(),
            },
        );
        let entry = saved_entry(&settings, Some("open")).expect("entry exists");

        assert_eq!(entry.spawn_kind, SpawnKind::Local);

        let req = SpawnRequest {
            location: Some("/proj".into()),
            entry_id: Some("open".into()),
            kind: entry.spawn_kind,
            ..SpawnRequest::default()
        };
        let spawn = resolve_shell_spawn_with(
            &req,
            Path::new("/home/u"),
            &[],
            None,
            entry.resolved_shell(),
        )
        .expect("resolves");

        assert_eq!(spawn.settings["shell"], "fish");
    }

    /// A remembered WSL distro must reach the resolver as a bare distro name — the
    /// `wsl:` storage prefix must not leak into the session settings. Without a
    /// remembered distro this host has none, so the resolve would error.
    #[test]
    fn a_remembered_wsl_distro_is_opened_for_a_context_menu_click() {
        let settings = settings_with_remembered(
            "open",
            PickedTarget::Wsl {
                distro: "Ubuntu-22.04".to_string(),
            },
        );
        let entry = saved_entry(&settings, Some("open")).expect("entry exists");
        let req = SpawnRequest {
            location: Some("/proj".into()),
            entry_id: Some("open".into()),
            kind: entry.spawn_kind,
            ..SpawnRequest::default()
        };
        let spawn = resolve_shell_spawn_with(
            &req,
            Path::new("/home/u"),
            &[],
            // No default distro available: only the remembered pick can resolve.
            None,
            entry.resolved_shell(),
        )
        .expect("resolves from the remembered distro");

        assert_eq!(spawn.settings["distribution"], "Ubuntu-22.04");
    }

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
                spawn_kind: SpawnKind::Auto,
                shell: None,
                container_runtime: ContainerRuntime::Auto,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn requires_a_location() {
        let settings = ShellIntegrationSettings::default();
        assert!(resolve_container_spawn_with(
            &settings,
            None,
            None,
            None,
            None,
            ContainerRuntime::Auto
        )
        .is_err());
        assert!(resolve_container_spawn_with(
            &settings,
            Some("  ".into()),
            None,
            None,
            None,
            ContainerRuntime::Auto
        )
        .is_err());
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
            ContainerRuntime::Auto,
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
            ContainerRuntime::Auto,
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
            ContainerRuntime::Auto,
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
            ContainerRuntime::Auto,
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
            icon: None,
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
        let spawn =
            resolve_shell_spawn_with(&req, home, &[], Some("Ubuntu"), None).expect("resolves");
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
        let spawn =
            resolve_shell_spawn_with(&req, home, &conns, Some("Ubuntu"), None).expect("resolves");
        assert_eq!(spawn.settings["distribution"], "Debian");
    }

    #[test]
    fn wsl_spawn_without_any_distro_is_an_error() {
        // No connection and no default distro (e.g. a non-Windows host) → error.
        let home = Path::new("/home/user");
        let req = wsl_request(None, None);
        let err = resolve_shell_spawn_with(&req, home, &[], None, None).expect_err("no distro");
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
        let spawn = resolve_shell_spawn_with(&req, home, &conns, None, None).expect("resolves");
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
        let err = resolve_shell_spawn_with(&req, home, &[], None, None).expect_err("needs id");
        assert!(err.contains("--connection"), "err: {err}");
    }

    #[test]
    fn ssh_spawn_unknown_connection_is_an_error() {
        let home = Path::new("/home/user");
        let req = ssh_request(Some("/srv/app"), Some("nope"));
        let err = resolve_shell_spawn_with(&req, home, &[], None, None).expect_err("not found");
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
        let err = resolve_shell_spawn_with(&req, home, &conns, None, None).expect_err("wrong type");
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
        let spawn = resolve_shell_spawn_with(&req, home, &[], None, None).expect("resolves");
        assert_eq!(spawn.session_type, "local");
        assert_eq!(spawn.settings["startingDirectory"], "/home/user");
    }
}
