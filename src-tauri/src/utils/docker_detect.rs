use std::process::Command;

/// Check if Docker is available and running.
pub fn is_docker_available() -> bool {
    Command::new("docker")
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
    let output = Command::new("docker")
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
}
