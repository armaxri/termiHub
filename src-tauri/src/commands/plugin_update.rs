//! Tauri commands for the opt-in plugin **update check** (PROD-051 / PLG-012).
//!
//! termiHub has no plugin registry for 0.1 and never installs anything silently.
//! A plugin that declares an HTTPS `updateUrl` in its manifest can be checked
//! for a newer version, and an offered update can be *downloaded and verified* —
//! the resulting package file is then handed back to the frontend, which runs it
//! through the ordinary install flow (trust / signature gate, version-change
//! confirmation, native-trust re-acknowledgement).
//!
//! The network side is deliberately narrow (the parsing and the "is it newer?"
//! decision live, network-free, in [`termihub_core::plugin`]'s `update_check`):
//!
//! * **HTTPS only** — the client is `https_only`, every URL is re-validated, and
//!   the redirect policy refuses any hop to a non-HTTPS URL and caps the chain
//!   at [`MAX_REDIRECTS`].
//! * **Size-capped** — the update document at [`MAX_UPDATE_DOCUMENT_BYTES`], a
//!   package at [`MAX_PACKAGE_SIZE_BYTES`]; an oversize `Content-Length` is
//!   refused before reading, and the streamed body is cut off at the cap.
//! * **Timed out** — a short connect timeout and an overall request timeout.
//! * **Verified** — a downloaded package must match the document's SHA-256 and
//!   carry the same plugin id and the advertised version, or it is discarded.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use termihub_core::plugin::{
    evaluate_update, parse_update_document, validate_https_url, verify_package_sha256,
    InstalledPlugin, PluginManager, UpdateCheckOutcome, UpdateStatus, MAX_PACKAGE_SIZE_BYTES,
    MAX_UPDATE_DOCUMENT_BYTES,
};

/// Maximum number of redirects followed for one request.
pub const MAX_REDIRECTS: usize = 3;

/// Connect timeout for update checks and downloads.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Overall timeout for fetching an update document.
const DOCUMENT_TIMEOUT: Duration = Duration::from_secs(20);

/// Overall timeout for downloading a package (up to 50 MB).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// Cache sub-directory the verified update packages are written to.
const UPDATE_CACHE_DIR: &str = "plugin-updates";

/// The result of checking one plugin: an evaluated outcome, or why the check
/// failed. Exactly one of `outcome` / `error` is set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateCheckResult {
    /// The plugin checked.
    pub plugin_id: String,
    /// The evaluated check, when it succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<UpdateCheckOutcome>,
    /// A user-facing reason the check failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Decide whether a redirect hop to `url` may be followed after `previous`
/// hops: only HTTPS targets, and at most [`MAX_REDIRECTS`].
fn redirect_allowed(url: &reqwest::Url, previous: usize) -> Result<(), &'static str> {
    if previous >= MAX_REDIRECTS {
        return Err("too many redirects");
    }
    if url.scheme() != "https" {
        return Err("redirect to a non-HTTPS URL refused");
    }
    Ok(())
}

/// Build the HTTPS-only client with bounded timeouts and the redirect policy.
fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(concat!(
            "termiHub/",
            env!("CARGO_PKG_VERSION"),
            " plugin-update"
        ))
        .redirect(reqwest::redirect::Policy::custom(
            |attempt| match redirect_allowed(attempt.url(), attempt.previous().len()) {
                Ok(()) => attempt.follow(),
                Err(reason) => attempt.error(reason),
            },
        ))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
}

/// Append `chunk` to `buf`, refusing to grow past `cap` bytes.
fn push_capped(buf: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if buf.len().saturating_add(chunk.len()) > cap {
        return Err(format!("response is larger than the {cap}-byte limit"));
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// GET `url` (which must be HTTPS) and return its body, refusing anything over
/// `cap` bytes — by `Content-Length` up front, and while streaming.
async fn fetch_capped(url: &str, cap: usize, timeout: Duration) -> Result<Vec<u8>, String> {
    validate_https_url(url).map_err(|r| format!("URL `{url}` {r}"))?;
    let client = build_client(timeout)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request to {url} failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned HTTP {status}"));
    }
    if let Some(len) = response.content_length() {
        if len > cap as u64 {
            return Err(format!("{url} is larger than the {cap}-byte limit"));
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("reading {url} failed: {e}"))?
    {
        push_capped(&mut body, &chunk, cap)?;
    }
    Ok(body)
}

/// Fetch and evaluate the update document for one installed plugin.
async fn check_one(plugin: &InstalledPlugin) -> Result<UpdateCheckOutcome, String> {
    let manifest = &plugin.manifest;
    let url = manifest
        .update_url
        .as_deref()
        .ok_or_else(|| format!("plugin `{}` declares no updateUrl", manifest.id))?;
    let bytes = fetch_capped(url, MAX_UPDATE_DOCUMENT_BYTES, DOCUMENT_TIMEOUT).await?;
    let doc = parse_update_document(&bytes).map_err(|e| e.to_string())?;
    evaluate_update(&manifest.id, &manifest.version, &doc).map_err(|e| e.to_string())
}

/// Check every installed plugin that declares an `updateUrl` (or only
/// `plugin_id`, when given) for a newer version. Never downloads or installs
/// anything. Plugins without an `updateUrl` are skipped.
#[tauri::command]
pub async fn check_plugin_updates(
    plugin_id: Option<String>,
    manager: State<'_, PluginManager>,
) -> Result<Vec<PluginUpdateCheckResult>, String> {
    let plugins = match &plugin_id {
        Some(id) => vec![manager.get(id).map_err(|e| e.to_string())?],
        None => manager.list().map_err(|e| e.to_string())?,
    };
    let mut results = Vec::new();
    for plugin in plugins.iter().filter(|p| p.manifest.update_url.is_some()) {
        let id = plugin.manifest.id.clone();
        let result = check_one(plugin).await;
        if let Err(error) = &result {
            tracing::info!(plugin_id = %id, %error, "plugin update check failed");
        }
        results.push(match result {
            Ok(outcome) => PluginUpdateCheckResult {
                plugin_id: id,
                outcome: Some(outcome),
                error: None,
            },
            Err(error) => PluginUpdateCheckResult {
                plugin_id: id,
                outcome: None,
                error: Some(error),
            },
        });
    }
    Ok(results)
}

/// Where a verified update package for `outcome` is written.
fn package_path(cache_dir: &Path, outcome: &UpdateCheckOutcome) -> PathBuf {
    let version: String = outcome
        .latest_version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    cache_dir
        .join(UPDATE_CACHE_DIR)
        .join(format!("{}-{version}.termihub-plugin", outcome.plugin_id))
}

/// Download the update offered for `plugin_id`, verify it, and return the path
/// of the verified package file. **Does not install it**: the frontend passes
/// the path to the normal install flow, which applies the trust, signature and
/// version-change gates and asks the user to confirm.
///
/// Re-checks the update document first, so only a currently-offered,
/// host-compatible, strictly newer version is ever downloaded. The package must
/// match the document's SHA-256 and carry the same plugin id and the advertised
/// version; otherwise it is deleted and an error returned.
#[tauri::command]
pub async fn download_plugin_update(
    plugin_id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<String, String> {
    let plugin = manager.get(&plugin_id).map_err(|e| e.to_string())?;
    let outcome = check_one(&plugin).await?;
    match outcome.status {
        UpdateStatus::UpdateAvailable => {}
        UpdateStatus::UpToDate => {
            return Err(format!("{} is already up to date", plugin.manifest.name));
        }
        UpdateStatus::IncompatibleHost => {
            return Err(format!(
                "{} {} needs plugin ABI {}; update termiHub first",
                plugin.manifest.name, outcome.latest_version, outcome.min_host_abi
            ));
        }
    }

    let cap = usize::try_from(MAX_PACKAGE_SIZE_BYTES).unwrap_or(usize::MAX);
    let bytes = fetch_capped(&outcome.download_url, cap, DOWNLOAD_TIMEOUT).await?;
    if !verify_package_sha256(&bytes, &outcome.sha256) {
        return Err(format!(
            "downloaded package does not match the published SHA-256 for {} {}",
            plugin.manifest.name, outcome.latest_version
        ));
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve app cache dir: {e}"))?;
    let path = package_path(&cache_dir, &outcome);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;

    if let Err(e) = check_downloaded_package(&manager, &path, &outcome) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    tracing::info!(
        plugin_id = %plugin_id,
        version = %outcome.latest_version,
        "downloaded and verified plugin update; awaiting user install"
    );
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "package path is not valid UTF-8".to_string())
}

/// Validate the downloaded package and require it to be the advertised update
/// of the same plugin.
fn check_downloaded_package(
    manager: &PluginManager,
    path: &Path,
    outcome: &UpdateCheckOutcome,
) -> Result<(), String> {
    let manifest = manager
        .validate(path)
        .map_err(|e| format!("downloaded package is invalid: {e}"))?;
    if manifest.id != outcome.plugin_id {
        return Err(format!(
            "downloaded package is plugin `{}`, expected `{}`",
            manifest.id, outcome.plugin_id
        ));
    }
    if manifest.version != outcome.latest_version {
        return Err(format!(
            "downloaded package is version {}, but the update document advertised {}",
            manifest.version, outcome.latest_version
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn redirects_only_to_https_and_bounded() {
        assert!(redirect_allowed(&url("https://example.com/a"), 0).is_ok());
        assert!(redirect_allowed(&url("https://example.com/a"), MAX_REDIRECTS - 1).is_ok());
        assert_eq!(
            redirect_allowed(&url("http://example.com/a"), 0),
            Err("redirect to a non-HTTPS URL refused")
        );
        assert_eq!(
            redirect_allowed(&url("https://example.com/a"), MAX_REDIRECTS),
            Err("too many redirects")
        );
    }

    #[test]
    fn push_capped_refuses_to_exceed_the_cap() {
        let mut buf = Vec::new();
        push_capped(&mut buf, b"abc", 4).unwrap();
        push_capped(&mut buf, b"d", 4).unwrap();
        assert!(push_capped(&mut buf, b"e", 4).is_err());
        assert_eq!(buf, b"abcd");
    }

    #[tokio::test]
    async fn fetch_refuses_non_https_urls_before_any_request() {
        for bad in [
            "http://127.0.0.1:9/update.json",
            "file:///etc/passwd",
            "ftp://x/y",
        ] {
            let err = fetch_capped(bad, 1024, Duration::from_secs(1))
                .await
                .unwrap_err();
            assert!(err.contains("https"), "{bad}: {err}");
        }
    }

    #[test]
    fn package_path_is_confined_to_the_update_cache() {
        let outcome = UpdateCheckOutcome {
            plugin_id: "my-plugin".into(),
            installed_version: "1.0.0".into(),
            latest_version: "1.1.0+build/../x".into(),
            status: UpdateStatus::UpdateAvailable,
            download_url: "https://e.com/p".into(),
            sha256: "0".repeat(64),
            min_host_abi: "1.0".into(),
            changelog_url: None,
        };
        let path = package_path(Path::new("/cache"), &outcome);
        assert_eq!(
            path,
            Path::new("/cache/plugin-updates/my-plugin-1.1.0-build-..-x.termihub-plugin")
        );
        assert_eq!(path.parent(), Some(Path::new("/cache/plugin-updates")));
    }

    #[test]
    fn downloaded_package_must_be_the_advertised_update() {
        let tmp = tempfile::TempDir::new().unwrap();
        let manager = PluginManager::new(tmp.path().join("plugins"));
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("themes")).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            r#"{"id":"upd","name":"Upd","version":"1.1.0","author":"a","description":"d",
               "license":"MIT","apiVersion":"1.0","platforms":["linux","macos","windows"],
               "permissions":[],"extensions":{"theme":{"themes":[
               {"id":"t","name":"T","file":"t.json"}]}}}"#,
        )
        .unwrap();
        std::fs::write(src.join("themes/t.json"), b"{}").unwrap();
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let pkg = termihub_core::plugin::pack_plugin(&src, &out).unwrap();

        let outcome = |id: &str, version: &str| UpdateCheckOutcome {
            plugin_id: id.into(),
            installed_version: "1.0.0".into(),
            latest_version: version.into(),
            status: UpdateStatus::UpdateAvailable,
            download_url: "https://e.com/p".into(),
            sha256: "0".repeat(64),
            min_host_abi: "1.0".into(),
            changelog_url: None,
        };
        assert!(check_downloaded_package(&manager, &pkg, &outcome("upd", "1.1.0")).is_ok());
        assert!(
            check_downloaded_package(&manager, &pkg, &outcome("other", "1.1.0"))
                .unwrap_err()
                .contains("expected `other`")
        );
        assert!(
            check_downloaded_package(&manager, &pkg, &outcome("upd", "1.2.0"))
                .unwrap_err()
                .contains("advertised 1.2.0")
        );
    }
}
