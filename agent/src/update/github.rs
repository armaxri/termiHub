//! GitHub Releases API access for the agent self-update check.
//!
//! The agent polls `GET /repos/{repo}/releases/latest`, parses the release JSON
//! into [`ReleaseInfo`], and resolves the binary + checksum asset URLs matching
//! its own platform. Parsing is separated from the HTTP call so it can be unit
//! tested without a network.

use anyhow::{Context, Result};
use serde::Deserialize;

/// The default GitHub repository agent releases are published to.
pub const DEFAULT_REPO: &str = "armaxri/termiHub";

/// Base name of the agent binary release asset (an arch suffix is appended,
/// e.g. `termihub-agent-linux-x64`).
const ASSET_BASE: &str = "termihub-agent";

/// A single downloadable asset attached to a GitHub release.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    #[serde(rename = "browser_download_url")]
    pub browser_download_url: String,
}

/// The subset of the GitHub `releases/latest` response the agent needs.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ReleaseInfo {
    pub tag_name: String,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

impl ReleaseInfo {
    /// Find the download URL for the binary asset matching `arch_suffix`
    /// (e.g. `"linux-x64"`) and, when present, its `.sha256` sidecar.
    ///
    /// Returns `None` when no binary asset for this platform is published.
    pub fn asset_urls_for(&self, arch_suffix: &str) -> Option<AssetUrls> {
        let binary_name = format!("{ASSET_BASE}-{arch_suffix}");
        let checksum_name = format!("{binary_name}.sha256");

        let binary_url = self
            .assets
            .iter()
            .find(|a| a.name == binary_name)
            .map(|a| a.browser_download_url.clone())?;
        let checksum_url = self
            .assets
            .iter()
            .find(|a| a.name == checksum_name)
            .map(|a| a.browser_download_url.clone());

        Some(AssetUrls {
            binary_url,
            checksum_url,
        })
    }
}

/// Resolved download URLs for a platform's agent binary and its checksum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetUrls {
    pub binary_url: String,
    /// `None` when the release does not publish a `.sha256` sidecar asset.
    pub checksum_url: Option<String>,
}

/// Parse a GitHub `releases/latest` JSON body into a [`ReleaseInfo`].
pub fn parse_release_json(body: &str) -> Result<ReleaseInfo> {
    serde_json::from_str(body).context("failed to parse GitHub releases/latest JSON")
}

/// Map the compile-time OS/arch to the published agent asset suffix.
///
/// Agent binaries are published for Linux only (`linux-x64`, `linux-arm64`,
/// `linux-armv7`). Returns `None` on any other platform, so the self-update
/// check skips cleanly rather than downloading a non-existent asset.
pub fn asset_suffix_for(os: &str, arch: &str) -> Option<&'static str> {
    if os != "linux" {
        return None;
    }
    match arch {
        "x86_64" => Some("linux-x64"),
        "aarch64" => Some("linux-arm64"),
        // `std::env::consts::ARCH` reports "arm" for 32-bit ARM (armv7).
        "arm" => Some("linux-armv7"),
        _ => None,
    }
}

/// The published asset suffix for the platform the agent is running on.
pub fn current_asset_suffix() -> Option<&'static str> {
    asset_suffix_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// Build the `releases/latest` API URL for a repository.
pub fn releases_latest_url(repo: &str) -> String {
    format!("https://api.github.com/repos/{repo}/releases/latest")
}

/// Fetch and parse the latest release from the GitHub API.
///
/// GitHub requires a `User-Agent` header on API requests; the caller-provided
/// [`reqwest::Client`] is expected to set one. Any transport or HTTP-status
/// error is returned so the caller can log a warning and skip the cycle.
pub async fn fetch_latest_release(client: &reqwest::Client, url: &str) -> Result<ReleaseInfo> {
    let resp = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("failed to reach GitHub releases API at {url}"))?
        .error_for_status()
        .with_context(|| format!("GitHub releases API returned an error status for {url}"))?;
    let body = resp
        .text()
        .await
        .context("failed to read GitHub releases API response body")?;
    parse_release_json(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "tag_name": "v0.3.0",
        "name": "termiHub 0.3.0",
        "assets": [
            { "name": "termihub-agent-linux-x64", "browser_download_url": "https://example.test/dl/termihub-agent-linux-x64" },
            { "name": "termihub-agent-linux-x64.sha256", "browser_download_url": "https://example.test/dl/termihub-agent-linux-x64.sha256" },
            { "name": "termihub-agent-linux-arm64", "browser_download_url": "https://example.test/dl/termihub-agent-linux-arm64" }
        ]
    }"#;

    #[test]
    fn parse_release_json_extracts_tag_and_assets() {
        let info = parse_release_json(SAMPLE).unwrap();
        assert_eq!(info.tag_name, "v0.3.0");
        assert_eq!(info.assets.len(), 3);
        assert_eq!(info.assets[0].name, "termihub-agent-linux-x64");
    }

    #[test]
    fn parse_release_json_tolerates_missing_assets() {
        let info = parse_release_json(r#"{ "tag_name": "v1.0.0" }"#).unwrap();
        assert_eq!(info.tag_name, "v1.0.0");
        assert!(info.assets.is_empty());
    }

    #[test]
    fn parse_release_json_rejects_garbage() {
        assert!(parse_release_json("not json").is_err());
        assert!(parse_release_json("{}").is_err()); // missing tag_name
    }

    #[test]
    fn asset_urls_for_resolves_binary_and_sidecar() {
        let info = parse_release_json(SAMPLE).unwrap();
        let urls = info.asset_urls_for("linux-x64").unwrap();
        assert_eq!(
            urls.binary_url,
            "https://example.test/dl/termihub-agent-linux-x64"
        );
        assert_eq!(
            urls.checksum_url.as_deref(),
            Some("https://example.test/dl/termihub-agent-linux-x64.sha256")
        );
    }

    #[test]
    fn asset_urls_for_binary_without_sidecar() {
        let info = parse_release_json(SAMPLE).unwrap();
        let urls = info.asset_urls_for("linux-arm64").unwrap();
        assert_eq!(
            urls.binary_url,
            "https://example.test/dl/termihub-agent-linux-arm64"
        );
        assert_eq!(urls.checksum_url, None);
    }

    #[test]
    fn asset_urls_for_missing_platform_is_none() {
        let info = parse_release_json(SAMPLE).unwrap();
        assert!(info.asset_urls_for("linux-armv7").is_none());
    }

    #[test]
    fn asset_suffix_maps_linux_arches() {
        assert_eq!(asset_suffix_for("linux", "x86_64"), Some("linux-x64"));
        assert_eq!(asset_suffix_for("linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(asset_suffix_for("linux", "arm"), Some("linux-armv7"));
    }

    #[test]
    fn asset_suffix_rejects_non_linux_and_unknown_arch() {
        assert_eq!(asset_suffix_for("macos", "aarch64"), None);
        assert_eq!(asset_suffix_for("windows", "x86_64"), None);
        assert_eq!(asset_suffix_for("linux", "mips"), None);
    }

    #[test]
    fn releases_latest_url_uses_repo() {
        assert_eq!(
            releases_latest_url("armaxri/termiHub"),
            "https://api.github.com/repos/armaxri/termiHub/releases/latest"
        );
    }
}
