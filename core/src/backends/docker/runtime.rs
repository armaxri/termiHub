//! Container-runtime endpoint resolution and daemon identification.
//!
//! `bollard::Docker::connect_with_local_defaults()` only ever looks at
//! `DOCKER_HOST` and then the platform default socket (`/var/run/docker.sock`
//! on Unix). It never reads the **Docker CLI contexts**
//! (`~/.docker/config.json` → `currentContext` → `~/.docker/contexts/meta/`),
//! which is where the real Docker Desktop endpoint lives on macOS and Windows.
//!
//! On a host that also runs Podman, `podman-mac-helper` symlinks
//! `/var/run/docker.sock` at the Podman machine socket, so
//! `connect_with_local_defaults()` silently targets Podman even though the
//! Docker CLI (and the user) are on the `desktop-linux` Docker context. This
//! module resolves the endpoint the Docker CLI itself would use, and
//! identifies whether a connected daemon is actually Podman, so the backend
//! can honour an explicit `Docker` selection instead of silently running
//! Podman. See issue #1600.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The endpoint the Docker CLI would use for the active context, resolved
/// **without** falling back to the platform default socket.
///
/// Resolution order mirrors the Docker CLI:
/// 1. `DOCKER_HOST` — an explicit override always wins.
/// 2. The active Docker CLI context (`DOCKER_CONTEXT` env, otherwise
///    `config.json` → `currentContext`) endpoint from
///    `contexts/meta/<id>/meta.json`.
///
/// Returns `None` when neither is set (or the active context is `default`),
/// meaning the caller should fall back to bollard's platform default socket.
pub(super) fn resolve_docker_endpoint() -> Option<String> {
    if let Some(host) = non_empty_env("DOCKER_HOST") {
        return Some(host);
    }
    let docker_dir = docker_config_dir()?;
    docker_endpoint_from_dir(&docker_dir)
}

/// Read an environment variable, treating empty as unset.
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Locate the Docker CLI config directory (`$DOCKER_CONFIG` or `~/.docker`).
fn docker_config_dir() -> Option<PathBuf> {
    if let Some(dir) = non_empty_env("DOCKER_CONFIG") {
        return Some(PathBuf::from(dir));
    }
    // `HOME` on Unix; `USERPROFILE` on Windows.
    let home = non_empty_env("HOME").or_else(|| non_empty_env("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".docker"))
}

/// Resolve the active context's Docker endpoint from a Docker config directory.
///
/// Split out from [`resolve_docker_endpoint`] so it can be unit-tested against
/// a fixture directory tree without touching real environment or `$HOME`.
fn docker_endpoint_from_dir(docker_dir: &Path) -> Option<String> {
    let context = active_context(docker_dir)?;
    // The `default` context always maps to the platform default socket, which
    // bollard already handles — signal a fall-through with `None`.
    if context.is_empty() || context == "default" {
        return None;
    }
    let meta_path = docker_dir
        .join("contexts")
        .join("meta")
        .join(context_id(&context))
        .join("meta.json");
    let data = std::fs::read_to_string(meta_path).ok()?;
    let meta: ContextMeta = serde_json::from_str(&data).ok()?;
    meta.endpoints
        .get("docker")
        .map(|e| e.host.clone())
        .filter(|h| !h.is_empty())
}

/// Determine the active context name (`DOCKER_CONTEXT` env, else
/// `config.json` → `currentContext`).
fn active_context(docker_dir: &Path) -> Option<String> {
    if let Some(ctx) = non_empty_env("DOCKER_CONTEXT") {
        return Some(ctx);
    }
    let data = std::fs::read_to_string(docker_dir.join("config.json")).ok()?;
    let config: DockerConfigFile = serde_json::from_str(&data).ok()?;
    config.current_context.filter(|c| !c.is_empty())
}

/// The Docker CLI stores each context under a directory named after the
/// lowercase hex SHA-256 digest of the context name.
fn context_id(name: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(name.as_bytes()))
}

/// Relevant subset of `~/.docker/config.json`.
#[derive(Debug, Deserialize)]
struct DockerConfigFile {
    #[serde(rename = "currentContext")]
    current_context: Option<String>,
}

/// Relevant subset of `contexts/meta/<id>/meta.json`.
#[derive(Debug, Deserialize)]
struct ContextMeta {
    #[serde(rename = "Endpoints", default)]
    endpoints: HashMap<String, ContextEndpoint>,
}

#[derive(Debug, Deserialize)]
struct ContextEndpoint {
    #[serde(rename = "Host", default)]
    host: String,
}

/// Whether a daemon `/version` response identifies the daemon as Podman.
///
/// Podman's Docker-compatible API reports a component named `Podman Engine`
/// (and a platform like `linux/arm64/fedora-43`), whereas Docker reports an
/// `Engine` component and a `Docker Desktop …` / `Docker Engine …` platform.
/// Matching `podman` (case-insensitively) in either field is a stable signal
/// across Podman versions.
pub(super) fn version_is_podman(version: &bollard::system::Version) -> bool {
    let component_hit = version
        .components
        .as_ref()
        .map(|comps| comps.iter().any(|c| contains_podman(&c.name)))
        .unwrap_or(false);
    let platform_hit = version
        .platform
        .as_ref()
        .map(|p| contains_podman(&p.name))
        .unwrap_or(false);
    component_hit || platform_hit
}

fn contains_podman(s: &str) -> bool {
    s.to_ascii_lowercase().contains("podman")
}

/// Resolve the local API socket of the running Podman **machine** on macOS.
///
/// On macOS (and Windows) Podman runs inside a VM, so there is no native
/// `/run/.../podman.sock`; the machine instead exposes a Docker-compatible API
/// on a per-user Unix socket under the user's private temp directory:
///
/// ```text
/// $TMPDIR/podman/<machine>-api.sock
/// ```
///
/// e.g. `/var/folders/…/T/podman/podman-machine-default-api.sock`. This is the
/// same endpoint the `podman` Docker CLI context points at, and the one
/// reported by `podman machine inspect` → `ConnectionInfo.PodmanSocket.Path`.
/// The path is per-user and non-deterministic (macOS randomises `$TMPDIR`), so
/// it cannot be a fixed constant — we read `$TMPDIR` and look for the socket.
///
/// Returns `None` when `$TMPDIR` is unset or no machine API socket is present
/// (typically: no Podman machine has been started). Reading the socket rather
/// than shelling out to `podman machine inspect` keeps resolution fast and
/// dependency-free, mirroring the config-based Docker context resolution added
/// for #1600.
#[cfg(target_os = "macos")]
pub(super) fn podman_machine_socket() -> Option<String> {
    let tmpdir = non_empty_env("TMPDIR")?;
    podman_machine_socket_in(Path::new(&tmpdir))
}

/// Pure helper for [`podman_machine_socket`]: find a Podman machine API socket
/// under `<tmpdir>/podman/`. Split out so it can be unit-tested against a
/// fixture directory without depending on the real `$TMPDIR` or a running
/// Podman machine.
///
/// Prefers the default machine's socket (`podman-machine-default-api.sock`);
/// otherwise falls back to any single `*-api.sock` present (covering a
/// non-default machine name), picking the lexicographically first for
/// determinism.
///
/// Compiled on macOS (where it is used) and in test builds on every platform,
/// so the resolution logic is covered by the cross-platform CI test lane.
#[cfg(any(target_os = "macos", test))]
fn podman_machine_socket_in(tmpdir: &Path) -> Option<String> {
    let dir = tmpdir.join("podman");

    // Prefer the default machine's API socket when it exists.
    let default = dir.join("podman-machine-default-api.sock");
    if default.exists() {
        return Some(format!("unix://{}", default.display()));
    }

    // Otherwise fall back to any single machine API socket (non-default name).
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("-api.sock"))
        })
        .collect();
    candidates.sort();
    candidates
        .into_iter()
        .next()
        .map(|path| format!("unix://{}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::SystemVersionPlatform;
    use bollard::system::{Version, VersionComponents};
    use std::fs;
    use tempfile::TempDir;

    /// Build a fixture `.docker` directory with the given `currentContext` and
    /// a single named context whose Docker endpoint is `host`.
    fn write_context_fixture(dir: &Path, current: &str, name: &str, host: &str) {
        fs::write(
            dir.join("config.json"),
            format!(r#"{{"currentContext":"{current}"}}"#),
        )
        .unwrap();
        let meta_dir = dir.join("contexts").join("meta").join(context_id(name));
        fs::create_dir_all(&meta_dir).unwrap();
        fs::write(
            meta_dir.join("meta.json"),
            format!(r#"{{"Name":"{name}","Endpoints":{{"docker":{{"Host":"{host}"}}}}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn resolves_active_context_endpoint() {
        // Regression for #1600: the desktop-linux context endpoint must be
        // resolved rather than the platform default socket (which a Podman
        // install may have hijacked).
        let tmp = TempDir::new().unwrap();
        let host = "unix:///Users/arne/.docker/run/docker.sock";
        write_context_fixture(tmp.path(), "desktop-linux", "desktop-linux", host);

        assert_eq!(docker_endpoint_from_dir(tmp.path()), Some(host.to_string()));
    }

    #[test]
    fn default_context_falls_through_to_none() {
        // The `default` context is the platform default socket, which bollard
        // already handles — resolution must defer to it.
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("config.json"),
            r#"{"currentContext":"default"}"#,
        )
        .unwrap();
        assert_eq!(docker_endpoint_from_dir(tmp.path()), None);
    }

    #[test]
    fn missing_config_falls_through_to_none() {
        // A host with no Docker CLI config (common Linux Docker install) must
        // keep working via the default socket.
        let tmp = TempDir::new().unwrap();
        assert_eq!(docker_endpoint_from_dir(tmp.path()), None);
    }

    #[test]
    fn missing_context_meta_falls_through_to_none() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("config.json"),
            r#"{"currentContext":"desktop-linux"}"#,
        )
        .unwrap();
        // No contexts/meta tree written.
        assert_eq!(docker_endpoint_from_dir(tmp.path()), None);
    }

    #[test]
    fn context_id_is_sha256_hex_of_name() {
        // Matches `printf desktop-linux | shasum -a 256`.
        assert_eq!(
            context_id("desktop-linux"),
            "fe9c6bd7a66301f49ca9b6a70b217107cd1284598bfc254700c989b916da791e"
        );
    }

    #[test]
    fn empty_endpoint_host_is_ignored() {
        let tmp = TempDir::new().unwrap();
        write_context_fixture(tmp.path(), "ctx", "ctx", "");
        assert_eq!(docker_endpoint_from_dir(tmp.path()), None);
    }

    fn version_with(component: Option<&str>, platform: Option<&str>) -> Version {
        Version {
            components: component.map(|name| {
                vec![VersionComponents {
                    name: name.to_string(),
                    version: "1.0".to_string(),
                    details: None,
                }]
            }),
            platform: platform.map(|name| SystemVersionPlatform {
                name: name.to_string(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn detects_podman_from_component_name() {
        let v = version_with(Some("Podman Engine"), Some("linux/arm64/fedora-43"));
        assert!(version_is_podman(&v));
    }

    #[test]
    fn does_not_flag_docker_engine_as_podman() {
        let v = version_with(Some("Engine"), Some("Docker Desktop 4.78.0 (229452)"));
        assert!(!version_is_podman(&v));
    }

    #[test]
    fn detects_podman_from_platform_when_components_absent() {
        let v = version_with(None, Some("linux/amd64/podman"));
        assert!(version_is_podman(&v));
    }

    /// Create an empty file at `path`, making parent directories as needed.
    /// Stands in for the machine API socket (a Unix socket is also a file entry
    /// on disk, so `Path::exists()` and `read_dir` treat our fixture the same).
    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn resolves_default_podman_machine_socket() {
        // Regression for #1622: on macOS the machine API socket lives at
        // `$TMPDIR/podman/podman-machine-default-api.sock`; it must be resolved
        // rather than returning `None` (which fails explicit runtime: Podman).
        let tmp = TempDir::new().unwrap();
        let sock = tmp
            .path()
            .join("podman")
            .join("podman-machine-default-api.sock");
        touch(&sock);

        assert_eq!(
            podman_machine_socket_in(tmp.path()),
            Some(format!("unix://{}", sock.display()))
        );
    }

    #[test]
    fn resolves_non_default_machine_socket() {
        // A user with a custom-named machine still resolves via the single
        // `*-api.sock` fallback.
        let tmp = TempDir::new().unwrap();
        let sock = tmp
            .path()
            .join("podman")
            .join("podman-machine-work-api.sock");
        touch(&sock);

        assert_eq!(
            podman_machine_socket_in(tmp.path()),
            Some(format!("unix://{}", sock.display()))
        );
    }

    #[test]
    fn prefers_default_machine_socket_over_others() {
        let tmp = TempDir::new().unwrap();
        let default = tmp
            .path()
            .join("podman")
            .join("podman-machine-default-api.sock");
        touch(&default);
        touch(
            &tmp.path()
                .join("podman")
                .join("podman-machine-work-api.sock"),
        );

        assert_eq!(
            podman_machine_socket_in(tmp.path()),
            Some(format!("unix://{}", default.display()))
        );
    }

    #[test]
    fn no_socket_when_machine_dir_absent() {
        // No Podman machine started (or no Podman installed): no `podman/` dir,
        // so resolution yields `None` and the caller reports the machine as
        // unavailable rather than picking a wrong socket.
        let tmp = TempDir::new().unwrap();
        assert_eq!(podman_machine_socket_in(tmp.path()), None);
    }

    #[test]
    fn no_socket_when_dir_has_no_api_sock() {
        // The machine dir exists (gvproxy sockets, logs) but no API socket —
        // e.g. a stopped machine. Must not match a non-API socket.
        let tmp = TempDir::new().unwrap();
        touch(
            &tmp.path()
                .join("podman")
                .join("podman-machine-default-gvproxy.sock"),
        );
        touch(&tmp.path().join("podman").join("gvproxy.log"));
        assert_eq!(podman_machine_socket_in(tmp.path()), None);
    }
}
