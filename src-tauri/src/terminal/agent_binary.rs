//! Agent binary resolution: cache → bundled → download.
//!
//! When the desktop needs to deploy the agent to a remote host, this module
//! figures out where to get the binary from:
//!
//! 1. **Local cache** — `~/.cache/termihub/agent-binaries/<version>/termihub-agent-<arch>`
//! 2. **Bundled resource** — shipped inside the Tauri app bundle
//! 3. **GitHub Releases download** — fetched on demand and cached locally

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tracing::{debug, info, warn};

/// GitHub repository for release downloads.
const GITHUB_REPO: &str = "ArneBK/termiHub";

/// Map a `uname -m` architecture string to the artifact suffix we use.
///
/// Returns `None` for unsupported architectures.
pub fn artifact_name_for_arch(uname_arch: &str) -> Option<&'static str> {
    match uname_arch {
        "x86_64" | "amd64" => Some("linux-x64"),
        "aarch64" | "arm64" => Some("linux-arm64"),
        "armv7l" | "armhf" => Some("linux-armv7"),
        _ => None,
    }
}

/// Return the cache directory for agent binaries.
///
/// Defaults to `~/.cache/termihub/agent-binaries/` on Linux/macOS,
/// or the platform-appropriate cache directory via `dirs::cache_dir()`.
pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("termihub")
        .join("agent-binaries")
}

/// Return the expected path for a cached binary of a given version and arch.
pub fn cached_binary_path(version: &str, arch_suffix: &str) -> PathBuf {
    cache_dir()
        .join(version)
        .join(format!("termihub-agent-{arch_suffix}"))
}

/// Look for a cached binary. Returns `Some(path)` if it exists and is non-empty.
pub fn find_cached_binary(version: &str, arch_suffix: &str) -> Option<PathBuf> {
    let path = cached_binary_path(version, arch_suffix);
    if path.is_file() {
        // Sanity check: non-empty
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > 0 {
                debug!("Found cached agent binary: {}", path.display());
                return Some(path);
            }
        }
    }
    None
}

/// Look for a bundled binary in the Tauri resource directory.
///
/// The binary is expected at `resources/termihub-agent-<arch_suffix>` inside
/// the app bundle.
pub fn find_bundled_binary(app_handle: &tauri::AppHandle, arch_suffix: &str) -> Option<PathBuf> {
    use tauri::Manager;

    let resource_dir = app_handle.path().resource_dir().ok()?;
    let binary_name = format!("termihub-agent-{arch_suffix}");
    let path = resource_dir.join(&binary_name);

    if path.is_file() {
        debug!("Found bundled agent binary: {}", path.display());
        Some(path)
    } else {
        debug!(
            "No bundled agent binary at {} (checked {})",
            binary_name,
            path.display()
        );
        None
    }
}

/// Build the GitHub Releases download URL for a given version and arch suffix.
pub fn release_download_url(version: &str, arch_suffix: &str) -> String {
    format!(
        "https://github.com/{GITHUB_REPO}/releases/download/v{version}/termihub-agent-{arch_suffix}"
    )
}

/// Download the agent binary from GitHub Releases and cache it locally.
///
/// `progress_cb` is called with `(bytes_downloaded, total_bytes)` — total may
/// be 0 if the server doesn't send Content-Length.
pub fn download_agent_binary<F>(version: &str, arch_suffix: &str, progress_cb: F) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    let url = release_download_url(version, arch_suffix);
    info!("Downloading agent binary from {}", url);

    let response = reqwest::blocking::Client::new()
        .get(&url)
        .send()
        .context("Failed to start download")?;

    if !response.status().is_success() {
        bail!("Download failed: HTTP {} for {}", response.status(), url);
    }

    let total_size = response.content_length().unwrap_or(0);
    let bytes = response.bytes().context("Failed to read response body")?;

    progress_cb(bytes.len() as u64, total_size);

    // Write to cache
    let dest = cached_binary_path(version, arch_suffix);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create cache dir: {}", parent.display()))?;
    }

    let mut file = fs::File::create(&dest)
        .with_context(|| format!("Failed to create cache file: {}", dest.display()))?;
    file.write_all(&bytes)?;

    info!(
        "Agent binary cached at {} ({} bytes)",
        dest.display(),
        bytes.len()
    );

    Ok(dest)
}

/// Resolve the agent binary through the cache → bundled → download chain.
///
/// Returns the local path to the binary, ready to be uploaded via SFTP.
pub fn resolve_agent_binary<F>(
    app_handle: &tauri::AppHandle,
    version: &str,
    arch_suffix: &str,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    // 1. Check local cache
    if let Some(path) = find_cached_binary(version, arch_suffix) {
        info!("Using cached agent binary: {}", path.display());
        return Ok(path);
    }

    // 2. Check bundled resources
    if let Some(path) = find_bundled_binary(app_handle, arch_suffix) {
        info!("Using bundled agent binary: {}", path.display());
        // Copy to cache for future use
        let cache_path = cached_binary_path(version, arch_suffix);
        if let Some(parent) = cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = fs::copy(&path, &cache_path) {
            warn!("Failed to cache bundled binary: {}", e);
        }
        return Ok(path);
    }

    // 3. Download from GitHub Releases
    info!(
        "No cached or bundled binary found, downloading v{} for {}",
        version, arch_suffix
    );
    download_agent_binary(version, arch_suffix, progress_cb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_name_x86_64() {
        assert_eq!(artifact_name_for_arch("x86_64"), Some("linux-x64"));
        assert_eq!(artifact_name_for_arch("amd64"), Some("linux-x64"));
    }

    #[test]
    fn artifact_name_aarch64() {
        assert_eq!(artifact_name_for_arch("aarch64"), Some("linux-arm64"));
        assert_eq!(artifact_name_for_arch("arm64"), Some("linux-arm64"));
    }

    #[test]
    fn artifact_name_armv7() {
        assert_eq!(artifact_name_for_arch("armv7l"), Some("linux-armv7"));
        assert_eq!(artifact_name_for_arch("armhf"), Some("linux-armv7"));
    }

    #[test]
    fn artifact_name_unknown() {
        assert_eq!(artifact_name_for_arch("mips"), None);
        assert_eq!(artifact_name_for_arch(""), None);
    }

    #[test]
    fn cache_dir_is_under_termihub() {
        let dir = cache_dir();
        assert!(
            dir.ends_with("termihub/agent-binaries"),
            "Expected path ending with termihub/agent-binaries, got: {}",
            dir.display()
        );
    }

    #[test]
    fn cached_binary_path_structure() {
        let path = cached_binary_path("0.1.0", "linux-x64");
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("0.1.0"), "Path should contain version");
        assert!(
            path_str.ends_with("termihub-agent-linux-x64"),
            "Path should end with binary name, got: {path_str}"
        );
    }

    #[test]
    fn find_cached_binary_nonexistent() {
        assert!(find_cached_binary("99.99.99", "linux-x64").is_none());
    }

    #[test]
    fn find_cached_binary_with_tempdir() {
        let tmpdir = tempfile::tempdir().unwrap();
        let version_dir = tmpdir.path().join("0.1.0");
        fs::create_dir_all(&version_dir).unwrap();
        let binary_path = version_dir.join("termihub-agent-linux-x64");
        fs::write(&binary_path, b"fake-binary-content").unwrap();

        // This won't find it because cache_dir() points elsewhere,
        // but we can verify the path construction is correct
        let expected = cached_binary_path("0.1.0", "linux-x64");
        assert!(expected.to_string_lossy().contains("0.1.0"));
    }

    #[test]
    fn release_download_url_format() {
        let url = release_download_url("0.1.0", "linux-x64");
        assert_eq!(
            url,
            "https://github.com/ArneBK/termiHub/releases/download/v0.1.0/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn release_download_url_arm64() {
        let url = release_download_url("1.2.3", "linux-arm64");
        assert!(url.contains("v1.2.3"));
        assert!(url.contains("linux-arm64"));
    }
}
