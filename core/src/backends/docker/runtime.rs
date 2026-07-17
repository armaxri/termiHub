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
}
