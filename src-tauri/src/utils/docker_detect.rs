//! Docker / Podman availability and image probes.
//!
//! Every probe spawns through [`no_window_command`] so the GUI-subsystem app
//! never flashes a console window on Windows (#3814).

use termihub_core::util::no_window::no_window_command;

/// Check if Docker is available and running.
pub fn is_docker_available() -> bool {
    no_window_command("docker")
        .args(["info"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// List locally available Docker images as "repository:tag" strings.
///
/// Filters out images with `<none>` repository or tag.
pub fn list_docker_images() -> Vec<String> {
    let output = no_window_command("docker")
        .args(["images", "--format", "{{.Repository}}:{{.Tag}}"])
        .output();

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|line| !line.contains("<none>"))
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

/// Check if Podman is available and running.
pub fn is_podman_available() -> bool {
    no_window_command("podman")
        .args(["info"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// List locally available Podman images as "repository:tag" strings.
///
/// Filters out images with `<none>` repository or tag.
pub fn list_podman_images() -> Vec<String> {
    let output = no_window_command("podman")
        .args(["images", "--format", "{{.Repository}}:{{.Tag}}"])
        .output();

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|line| !line.contains("<none>"))
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_available_returns_bool() {
        // Should not panic regardless of whether Docker is installed
        let _available = is_docker_available();
    }

    #[test]
    fn list_images_returns_vec() {
        // Should not panic regardless of whether Docker is installed
        let images = list_docker_images();
        // If Docker is not available, we get an empty vec
        assert!(images.len() < 100_000, "Unreasonably many images detected");
    }

    #[test]
    fn podman_available_returns_bool() {
        // Should not panic regardless of whether Podman is installed
        let _available = is_podman_available();
    }

    #[test]
    fn list_podman_images_returns_vec() {
        // Should not panic regardless of whether Podman is installed
        let images = list_podman_images();
        // If Podman is not available, we get an empty vec
        assert!(images.len() < 100_000, "Unreasonably many images detected");
    }
}
