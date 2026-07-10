//! Agent binary resolution: cache → bundled → download.
//!
//! When the desktop needs to deploy the agent to a remote host, this module
//! figures out where to get the binary from:
//!
//! 1. **Local cache** — `~/.cache/termihub/agent-binaries/<version>/termihub-agent-<arch>`
//! 2. **Bundled resource** — shipped inside the Tauri app bundle
//! 3. **GitHub Releases download** — fetched on demand and cached locally

use std::fs;
use std::path::PathBuf;

use anyhow::Result;
use tracing::{debug, info, warn};

use crate::utils::download::download_to_file;
use crate::utils::fs::is_nonempty_file;

/// GitHub repository for release downloads.
const GITHUB_REPO: &str = "armaxri/termiHub";

/// Map a remote OS string and architecture string to the artifact suffix we use.
///
/// The OS string may come from `uname -s` (Linux, macOS, or a MinGW/MSYS/Cygwin
/// shell on Windows) or from Windows environment probing (`%OS%` → `Windows_NT`).
/// The architecture string may come from `uname -m` (e.g. `"x86_64"`) or from
/// `%PROCESSOR_ARCHITECTURE%` (e.g. `"AMD64"`), so the Windows branch matches
/// case-insensitively.
///
/// Returns `None` for unsupported OS/architecture combinations.
pub fn artifact_name_for_os_arch(uname_os: &str, uname_arch: &str) -> Option<&'static str> {
    // Windows must be checked before the Linux fallback so a MinGW/MSYS/Cygwin
    // host (whose `uname -s` is e.g. `"MINGW64_NT-10.0"`) is not misdetected.
    if is_windows_os(uname_os) {
        return match uname_arch.to_ascii_lowercase().as_str() {
            "x86_64" | "amd64" => Some("windows-x64"),
            "aarch64" | "arm64" => Some("windows-arm64"),
            _ => None,
        };
    }
    match uname_os {
        "Darwin" => match uname_arch {
            "x86_64" | "amd64" => Some("macos-x64"),
            "aarch64" | "arm64" => Some("macos-arm64"),
            _ => None,
        },
        _ => match uname_arch {
            "x86_64" | "amd64" => Some("linux-x64"),
            "aarch64" | "arm64" => Some("linux-arm64"),
            "armv7l" | "armhf" => Some("linux-armv7"),
            _ => None,
        },
    }
}

/// Returns `true` if an OS string identifies a Windows host.
///
/// Recognizes the `uname -s` output of MinGW/MSYS/Cygwin shells
/// (e.g. `"MINGW64_NT-10.0"`, `"MSYS_NT-..."`, `"CYGWIN_NT-..."`) as well as the
/// `%OS%` value `"Windows_NT"` reported by `cmd.exe`/PowerShell probing.
pub fn is_windows_os(os: &str) -> bool {
    let upper = os.to_ascii_uppercase();
    upper.starts_with("MINGW")
        || upper.starts_with("MSYS")
        || upper.starts_with("CYGWIN")
        || upper.starts_with("WINDOWS")
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
    if is_nonempty_file(&path) {
        debug!("Found cached agent binary: {}", path.display());
        Some(path)
    } else {
        None
    }
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

/// Sanitize a git branch name for use as a GitHub release tag component.
///
/// Replaces any character that is not alphanumeric or `-` with `-`, then
/// collapses consecutive dashes and strips leading/trailing dashes.
pub fn sanitize_branch_name(branch: &str) -> String {
    let sanitized: String = branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    sanitized
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Build the full GitHub Releases download URL for an agent built from a specific branch.
///
/// Branch release tags follow the pattern `agent-branch-{sanitized-branch}`.
pub fn compute_branch_build_url(branch: &str, arch_suffix: &str) -> String {
    let tag = format!("agent-branch-{}", sanitize_branch_name(branch));
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/termihub-agent-{arch_suffix}")
}

/// Download the agent binary from an explicit URL and cache it under `cache_key/termihub-agent-{arch}`.
pub fn download_agent_binary_from_url<F>(
    url: &str,
    cache_key: &str,
    arch_suffix: &str,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    let dest = cache_dir()
        .join(cache_key)
        .join(format!("termihub-agent-{arch_suffix}"));
    download_to_file(url, &dest, progress_cb)?;
    Ok(dest)
}

/// Resolve the agent binary for a specific branch build.
///
/// Checks the local cache first (under `branch-{sanitized}/termihub-agent-{arch}`),
/// then downloads from the branch release on GitHub.
pub fn resolve_branch_build_binary<F>(
    branch: &str,
    arch_suffix: &str,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    let cache_key = format!("branch-{}", sanitize_branch_name(branch));
    let cached = cache_dir()
        .join(&cache_key)
        .join(format!("termihub-agent-{arch_suffix}"));

    if is_nonempty_file(&cached) {
        debug!("Using cached branch build binary: {}", cached.display());
        return Ok(cached);
    }

    let url = compute_branch_build_url(branch, arch_suffix);
    download_agent_binary_from_url(&url, &cache_key, arch_suffix, progress_cb)
}

/// Return the base download URL (without arch suffix) for the current build.
///
/// Dev builds (debug mode, `-dev` version suffix, or CI dev-build flag) use a
/// branch-specific tag: `dev-develop-latest` for develop, `dev-latest` for everything
/// else. Release builds use `v{version}`.
///
/// Append an arch suffix (e.g. `"linux-arm64"`) to obtain the full URL.
pub fn compute_download_base_url(version: &str) -> String {
    let is_dev =
        cfg!(debug_assertions) || env!("TERMIHUB_IS_DEV_BUILD") == "1" || version.ends_with("-dev");
    let tag = if is_dev {
        if env!("TERMIHUB_BUILD_BRANCH") == "develop" {
            "dev-develop-latest".to_string()
        } else {
            "dev-latest".to_string()
        }
    } else {
        format!("v{version}")
    };
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/termihub-agent-")
}

/// Build the full GitHub Releases download URL for a given version and arch suffix.
pub fn compute_download_url(version: &str, arch_suffix: &str) -> String {
    format!("{}{}", compute_download_base_url(version), arch_suffix)
}

// Test helpers with explicit flags so tests are not affected by
// whether the test runner itself is a debug or release build.
#[cfg(test)]
pub(crate) fn compute_download_base_url_impl(
    version: &str,
    is_debug_build: bool,
    branch: &str,
) -> String {
    let is_dev = is_debug_build || version.ends_with("-dev");
    let tag = if is_dev {
        if branch == "develop" {
            "dev-develop-latest".to_string()
        } else {
            "dev-latest".to_string()
        }
    } else {
        format!("v{version}")
    };
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/termihub-agent-")
}

#[cfg(test)]
pub(crate) fn compute_download_url_impl(
    version: &str,
    arch_suffix: &str,
    is_debug_build: bool,
    branch: &str,
) -> String {
    format!(
        "{}{}",
        compute_download_base_url_impl(version, is_debug_build, branch),
        arch_suffix
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
    let url = compute_download_url(version, arch_suffix);
    let dest = cached_binary_path(version, arch_suffix);
    download_to_file(&url, &dest, progress_cb)?;
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
    fn artifact_name_linux_x86_64() {
        assert_eq!(
            artifact_name_for_os_arch("Linux", "x86_64"),
            Some("linux-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Linux", "amd64"),
            Some("linux-x64")
        );
    }

    #[test]
    fn artifact_name_linux_aarch64() {
        assert_eq!(
            artifact_name_for_os_arch("Linux", "aarch64"),
            Some("linux-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Linux", "arm64"),
            Some("linux-arm64")
        );
    }

    #[test]
    fn artifact_name_linux_armv7() {
        assert_eq!(
            artifact_name_for_os_arch("Linux", "armv7l"),
            Some("linux-armv7")
        );
        assert_eq!(
            artifact_name_for_os_arch("Linux", "armhf"),
            Some("linux-armv7")
        );
    }

    #[test]
    fn artifact_name_macos() {
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "arm64"),
            Some("macos-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "aarch64"),
            Some("macos-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "x86_64"),
            Some("macos-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "amd64"),
            Some("macos-x64")
        );
    }

    #[test]
    fn artifact_name_windows_x64() {
        // `%PROCESSOR_ARCHITECTURE%` reports "AMD64"; `uname -m` reports "x86_64".
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "AMD64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows", "amd64"),
            Some("windows-x64")
        );
    }

    #[test]
    fn artifact_name_windows_arm64() {
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "ARM64"),
            Some("windows-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "aarch64"),
            Some("windows-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "arm64"),
            Some("windows-arm64")
        );
    }

    #[test]
    fn artifact_name_windows_mingw_uname_not_linux() {
        // `uname -s` on MinGW/MSYS/Cygwin shells reports these — must resolve to
        // Windows artifacts, never the Linux fallback.
        assert_eq!(
            artifact_name_for_os_arch("MINGW64_NT-10.0-19045", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("MSYS_NT-10.0-19045", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("CYGWIN_NT-10.0-19045", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("MINGW64_NT-10.0", "aarch64"),
            Some("windows-arm64")
        );
    }

    #[test]
    fn artifact_name_windows_unknown_arch() {
        assert_eq!(artifact_name_for_os_arch("Windows_NT", "mips"), None);
        assert_eq!(artifact_name_for_os_arch("Windows_NT", ""), None);
        // 32-bit x86 Windows has no published artifact.
        assert_eq!(artifact_name_for_os_arch("Windows_NT", "x86"), None);
    }

    #[test]
    fn is_windows_os_recognizes_windows_markers() {
        assert!(is_windows_os("Windows_NT"));
        assert!(is_windows_os("Windows"));
        assert!(is_windows_os("MINGW64_NT-10.0-19045"));
        assert!(is_windows_os("MSYS_NT-10.0"));
        assert!(is_windows_os("CYGWIN_NT-10.0"));
    }

    #[test]
    fn is_windows_os_rejects_posix() {
        assert!(!is_windows_os("Linux"));
        assert!(!is_windows_os("Darwin"));
        assert!(!is_windows_os(""));
    }

    #[test]
    fn artifact_name_unknown_falls_back_to_linux() {
        assert_eq!(
            artifact_name_for_os_arch("FreeBSD", "x86_64"),
            Some("linux-x64")
        );
    }

    #[test]
    fn artifact_name_unknown_arch() {
        assert_eq!(artifact_name_for_os_arch("Linux", "mips"), None);
        assert_eq!(artifact_name_for_os_arch("Linux", ""), None);
        assert_eq!(artifact_name_for_os_arch("Darwin", "mips"), None);
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

    // Tests use compute_download_url_impl with explicit flags so they are not
    // affected by whether the test suite itself runs as a debug or release build.

    #[test]
    fn compute_download_url_release_build_uses_version_tag() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", false, "main");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/v1.2.3/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn compute_download_url_debug_build_uses_dev_latest() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", true, "main");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn compute_download_url_dev_version_suffix_uses_dev_latest() {
        let url = compute_download_url_impl("0.1.0-dev", "linux-arm64", false, "main");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-linux-arm64"
        );
    }

    #[test]
    fn compute_download_url_dev_version_armv7() {
        let url = compute_download_url_impl("2.0.0-dev", "linux-armv7", false, "main");
        assert!(url.contains("dev-latest"));
        assert!(url.contains("linux-armv7"));
        assert!(!url.contains("v2.0.0"));
    }

    #[test]
    fn compute_download_url_release_build_does_not_use_dev_latest() {
        let url = compute_download_url_impl("1.0.0", "linux-x64", false, "main");
        assert!(!url.contains("dev-latest"));
        assert!(url.contains("v1.0.0"));
    }

    #[test]
    fn compute_download_url_develop_branch_debug_uses_dev_develop_latest() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", true, "develop");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-develop-latest/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn compute_download_url_develop_branch_dev_version_uses_dev_develop_latest() {
        let url = compute_download_url_impl("0.1.0-dev", "linux-arm64", false, "develop");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-develop-latest/termihub-agent-linux-arm64"
        );
    }

    #[test]
    fn compute_download_url_develop_branch_release_build_uses_version_tag() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", false, "develop");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/v1.2.3/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn sanitize_branch_name_replaces_slash() {
        assert_eq!(
            sanitize_branch_name("feature/666-my-branch"),
            "feature-666-my-branch"
        );
    }

    #[test]
    fn sanitize_branch_name_replaces_underscores() {
        assert_eq!(sanitize_branch_name("feature_foo_bar"), "feature-foo-bar");
    }

    #[test]
    fn sanitize_branch_name_collapses_dashes() {
        assert_eq!(sanitize_branch_name("foo//bar"), "foo-bar");
        assert_eq!(sanitize_branch_name("foo--bar"), "foo-bar");
    }

    #[test]
    fn sanitize_branch_name_strips_leading_trailing() {
        assert_eq!(sanitize_branch_name("/foo/"), "foo");
    }

    #[test]
    fn compute_branch_build_url_structure() {
        let url = compute_branch_build_url("feature/666-my-feature", "linux-arm64");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/agent-branch-feature-666-my-feature/termihub-agent-linux-arm64"
        );
    }

    #[test]
    fn compute_branch_build_url_main() {
        let url = compute_branch_build_url("main", "linux-x64");
        assert!(url.contains("agent-branch-main"));
        assert!(url.contains("linux-x64"));
    }

    // --- SHA-256 integrity verification -----------------------------------

    /// Known SHA-256 of the ASCII string "abc" (NIST test vector), used to pin
    /// the hashing implementation.
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_hex_of_file_matches_known_vector() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"abc").unwrap();

        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest, SHA256_OF_ABC);
    }

    #[test]
    fn sha256_hex_of_file_is_lowercase_hex() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"some binary content").unwrap();

        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest.len(), 64, "SHA-256 hex must be 64 chars");
        assert!(
            digest
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "digest must be lowercase hex, got: {digest}"
        );
    }

    #[test]
    fn sha256_hex_of_file_missing_file_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("does-not-exist.bin");
        assert!(sha256_hex_of_file(&path).is_err());
    }

    #[test]
    fn parse_sha256_sidecar_plain_hex() {
        assert_eq!(
            parse_sha256_sidecar(SHA256_OF_ABC),
            Some(SHA256_OF_ABC.to_string())
        );
    }

    #[test]
    fn parse_sha256_sidecar_sha256sum_text_format() {
        // Standard `sha256sum` text-mode output: "<hex>  <filename>".
        let line = format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n");
        assert_eq!(parse_sha256_sidecar(&line), Some(SHA256_OF_ABC.to_string()));
    }

    #[test]
    fn parse_sha256_sidecar_sha256sum_binary_format() {
        // Binary-mode output prefixes the filename with '*'.
        let line = format!("{SHA256_OF_ABC} *termihub-agent-windows-x64.exe\n");
        assert_eq!(parse_sha256_sidecar(&line), Some(SHA256_OF_ABC.to_string()));
    }

    #[test]
    fn parse_sha256_sidecar_uppercase_is_normalized() {
        let upper = SHA256_OF_ABC.to_ascii_uppercase();
        assert_eq!(
            parse_sha256_sidecar(&upper),
            Some(SHA256_OF_ABC.to_string())
        );
    }

    #[test]
    fn parse_sha256_sidecar_rejects_garbage() {
        assert_eq!(parse_sha256_sidecar(""), None);
        assert_eq!(parse_sha256_sidecar("   \n"), None);
        assert_eq!(parse_sha256_sidecar("not-a-hash"), None);
        // Too short.
        assert_eq!(parse_sha256_sidecar("deadbeef"), None);
        // 64 chars but contains a non-hex char ('g').
        assert_eq!(parse_sha256_sidecar(&"g".repeat(64)), None);
    }

    #[test]
    fn verify_file_checksum_ok_on_match() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"abc").unwrap();

        assert!(verify_file_checksum(&path, SHA256_OF_ABC).is_ok());
        // Case-insensitive on the expected side too.
        assert!(verify_file_checksum(&path, &SHA256_OF_ABC.to_ascii_uppercase()).is_ok());
    }

    #[test]
    fn verify_file_checksum_rejects_mismatch_with_clear_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        // Content whose digest is NOT SHA256_OF_ABC.
        fs::write(&path, b"tampered content").unwrap();

        let err = verify_file_checksum(&path, SHA256_OF_ABC).unwrap_err();
        let msg = err.to_string().to_ascii_lowercase();
        assert!(
            msg.contains("checksum"),
            "error should mention checksum, got: {err}"
        );
        assert!(
            msg.contains(SHA256_OF_ABC),
            "error should include the expected checksum, got: {err}"
        );
    }

    #[test]
    fn checksum_sidecar_path_appends_sha256() {
        let binary = PathBuf::from("/cache/0.1.0/termihub-agent-linux-x64");
        let sidecar = checksum_sidecar_path(&binary);
        assert_eq!(
            sidecar,
            PathBuf::from("/cache/0.1.0/termihub-agent-linux-x64.sha256")
        );
    }

    #[test]
    fn verify_with_adjacent_sidecar_ok_when_matching() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();
        fs::write(
            checksum_sidecar_path(&binary),
            format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n"),
        )
        .unwrap();

        assert!(verify_with_adjacent_sidecar(&binary).is_ok());
    }

    #[test]
    fn verify_with_adjacent_sidecar_rejects_tampered_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        // Sidecar claims the "abc" digest, but the binary has been tampered with.
        fs::write(&binary, b"tampered").unwrap();
        fs::write(checksum_sidecar_path(&binary), SHA256_OF_ABC).unwrap();

        assert!(
            verify_with_adjacent_sidecar(&binary).is_err(),
            "a binary that does not match its sidecar must be rejected"
        );
    }

    #[test]
    fn verify_with_adjacent_sidecar_ok_when_sidecar_absent() {
        // No sidecar present → cannot verify, but must not fail (legacy cache
        // entries and out-of-scope dev builds have no published checksum yet).
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();

        assert!(verify_with_adjacent_sidecar(&binary).is_ok());
    }

    #[test]
    fn verify_with_adjacent_sidecar_errors_on_malformed_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();
        fs::write(checksum_sidecar_path(&binary), "this-is-not-a-checksum").unwrap();

        assert!(
            verify_with_adjacent_sidecar(&binary).is_err(),
            "a malformed sidecar must be treated as an integrity failure"
        );
    }
}
