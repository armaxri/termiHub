//! GitHub Releases API access for the agent self-update check.
//!
//! The agent polls `GET /repos/{repo}/releases/latest`, parses the release JSON
//! into [`ReleaseInfo`], and resolves the binary + checksum asset URLs matching
//! its own platform. Parsing is separated from the HTTP call so it can be unit
//! tested without a network.

use anyhow::{Context, Result};
use serde::Deserialize;
use termihub_core::agent_release_asset::{
    agent_asset_suffix, agent_checksum_asset_name, agent_release_asset_name,
    agent_signature_asset_name, is_windows_os,
};

/// The default GitHub repository agent releases are published to.
pub const DEFAULT_REPO: &str = "armaxri/termiHub";

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
    /// (e.g. `"linux-x64"`) and, when present, its `.sha256` checksum and `.sig`
    /// signature sidecars. Asset names come from the shared
    /// [`termihub_core::agent_release_asset`] scheme (#4302).
    ///
    /// Returns `None` when no binary asset for this platform is published.
    pub fn asset_urls_for(&self, arch_suffix: &str) -> Option<AssetUrls> {
        let binary_name = agent_release_asset_name(arch_suffix);
        let checksum_name = agent_checksum_asset_name(arch_suffix);
        let signature_name = agent_signature_asset_name(arch_suffix);

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
        let signature_url = self
            .assets
            .iter()
            .find(|a| a.name == signature_name)
            .map(|a| a.browser_download_url.clone());

        Some(AssetUrls {
            binary_url,
            checksum_url,
            signature_url,
        })
    }
}

/// Resolved download URLs for a platform's agent binary and its checksum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetUrls {
    pub binary_url: String,
    /// `None` when the release does not publish a `.sha256` sidecar asset.
    pub checksum_url: Option<String>,
    /// `None` when the release does not publish a `.sig` signature sidecar
    /// (AGT-005) — a release-built agent then refuses to stage the binary.
    pub signature_url: Option<String>,
}

/// Parse a GitHub `releases/latest` JSON body into a [`ReleaseInfo`].
pub fn parse_release_json(body: &str) -> Result<ReleaseInfo> {
    serde_json::from_str(body).context("failed to parse GitHub releases/latest JSON")
}

/// Map the compile-time OS/arch to the published agent asset suffix the
/// self-updater may download.
///
/// Delegates to the shared [`agent_asset_suffix`] (the same table the desktop
/// deployer uses, #4302 / DUP2-009), so Linux and macOS agents resolve their
/// published asset. Windows is deliberately excluded: Windows agents are
/// published, but an in-place self-update apply is Unix-only, so a Windows
/// agent only notifies connected desktops instead of downloading a binary it
/// cannot apply. Returns `None` for any unpublished platform.
pub fn asset_suffix_for(os: &str, arch: &str) -> Option<&'static str> {
    if is_windows_os(os) {
        return None;
    }
    agent_asset_suffix(os, arch)
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
            { "name": "termihub-agent-linux-x64.sig", "browser_download_url": "https://example.test/dl/termihub-agent-linux-x64.sig" },
            { "name": "termihub-agent-linux-arm64", "browser_download_url": "https://example.test/dl/termihub-agent-linux-arm64" }
        ]
    }"#;

    #[test]
    fn parse_release_json_extracts_tag_and_assets() {
        let info = parse_release_json(SAMPLE).unwrap();
        assert_eq!(info.tag_name, "v0.3.0");
        assert_eq!(info.assets.len(), 4);
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
        assert_eq!(
            urls.signature_url.as_deref(),
            Some("https://example.test/dl/termihub-agent-linux-x64.sig")
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
        assert_eq!(urls.signature_url, None);
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
    fn asset_suffix_maps_macos_arches() {
        // DUP2-009: release.yml publishes macOS agents and the apply path is
        // `cfg(unix)`, so a macOS agent must resolve its own asset.
        assert_eq!(asset_suffix_for("macos", "aarch64"), Some("macos-arm64"));
        assert_eq!(asset_suffix_for("macos", "x86_64"), Some("macos-x64"));
    }

    #[test]
    fn asset_suffix_excludes_windows_and_unknown_platforms() {
        // Windows agents are published, but an in-place self-update apply is
        // Unix-only, so a Windows agent deliberately only notifies.
        assert_eq!(asset_suffix_for("windows", "x86_64"), None);
        assert_eq!(asset_suffix_for("windows", "aarch64"), None);
        assert_eq!(asset_suffix_for("linux", "mips"), None);
        assert_eq!(asset_suffix_for("freebsd", "x86_64"), None);
    }

    #[test]
    fn asset_suffix_agrees_with_the_shared_core_scheme_off_windows() {
        use termihub_core::agent_release_asset::agent_asset_suffix;
        for os in ["linux", "macos", "freebsd"] {
            for arch in ["x86_64", "aarch64", "arm", "mips"] {
                assert_eq!(
                    asset_suffix_for(os, arch),
                    agent_asset_suffix(os, arch),
                    "{os}/{arch}"
                );
            }
        }
    }

    #[test]
    fn asset_urls_for_uses_the_shared_asset_names() {
        let body = r#"{
            "tag_name": "v0.3.0",
            "assets": [
                { "name": "termihub-agent-windows-x64.exe", "browser_download_url": "https://example.test/w.exe" },
                { "name": "termihub-agent-windows-x64.exe.sha256", "browser_download_url": "https://example.test/w.exe.sha256" },
                { "name": "termihub-agent-windows-x64.exe.sig", "browser_download_url": "https://example.test/w.exe.sig" },
                { "name": "termihub-agent-macos-arm64", "browser_download_url": "https://example.test/m" }
            ]
        }"#;
        let info = parse_release_json(body).unwrap();
        let urls = info.asset_urls_for("windows-x64").unwrap();
        assert_eq!(urls.binary_url, "https://example.test/w.exe");
        assert_eq!(
            urls.checksum_url.as_deref(),
            Some("https://example.test/w.exe.sha256")
        );
        assert_eq!(
            urls.signature_url.as_deref(),
            Some("https://example.test/w.exe.sig")
        );
        assert_eq!(
            info.asset_urls_for("macos-arm64").unwrap().binary_url,
            "https://example.test/m"
        );
    }

    #[test]
    fn releases_latest_url_uses_repo() {
        assert_eq!(
            releases_latest_url("armaxri/termiHub"),
            "https://api.github.com/repos/armaxri/termiHub/releases/latest"
        );
    }
}
