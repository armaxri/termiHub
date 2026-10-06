//! Tauri commands for in-app **plugin discovery** (PROD-048): browse a curated
//! plugin index and download a listed (or user-pasted) package, verified.
//!
//! Everything network-facing runs here in the backend through
//! [`super::plugin_fetch`] (HTTPS only, bounded redirects, size caps, timeouts);
//! the webview never fetches the index or a package itself. A download is
//! streamed to a private temp file and its SHA-256 checked **before** the bytes
//! are parsed or unpacked; only then is the package validated and required to
//! be the listed plugin id and version. The resulting file is handed back to the
//! frontend, which runs it through the **unchanged** local install flow —
//! package validation, signature / publisher trust gate, native-trust
//! acknowledgement (#3296), ABI / toolchain / platform checks and version-change
//! confirmation (#3383 / #3490). Nothing is installed, enabled or trusted here.
//!
//! Trust level (see `docs/architecture.md`, ADR-17): the index is fetched over
//! HTTPS from a maintainer-controlled location and carries a SHA-256 per
//! package. Its detached Ed25519 signature (`<url>.sig`, #3716) is fetched and
//! checked **before** the index is parsed, against the compiled-in plugin-index
//! key ([`termihub_core::plugin::IndexSignaturePolicy`]): the default index is
//! only accepted with a valid signature (release builds), a custom index may be
//! unsigned (shown as such), and a signature that is present must always
//! verify. While the committed key is still the placeholder, nothing can be
//! verified and the index is shown as "signature not checked". The index stays
//! a discovery aid, not a trust anchor — trust decisions stay with the
//! package's own signature and the explicit per-plugin acknowledgement.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use termihub_core::plugin::{
    evaluate_index_entry, is_valid_plugin_id, is_valid_sha256_hex, parse_plugin_index, HostFacts,
    IndexSignaturePolicy, IndexSignatureStatus, PluginIndex, PluginIndexEntryView, PluginManager,
    INDEX_SIGNATURE_EXT, MAX_INDEX_BYTES, MAX_INDEX_SIGNATURE_BYTES, MAX_PACKAGE_SIZE_BYTES,
};

use super::plugin_fetch::{download_verified, fetch_capped, sanitize_file_component, FetchPolicy};
use super::plugin_update::check_downloaded_package;
use crate::connection::manager::ConnectionManager;

/// The maintainer-controlled default index: `plugins/index.json` on the
/// repository's stable `main` branch, changed only through a reviewed PR.
pub const DEFAULT_PLUGIN_INDEX_URL: &str =
    "https://raw.githubusercontent.com/armaxri/termiHub/main/plugins/index.json";

/// Overall timeout for fetching the index.
const INDEX_TIMEOUT: Duration = Duration::from_secs(20);

/// Overall timeout for downloading a package (up to 50 MB).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// Cache sub-directory verified discovery downloads are written to.
const DOWNLOAD_CACHE_DIR: &str = "plugin-downloads";

/// The Browse view's data: which index was read, and every entry with this
/// host's compatibility verdict.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PluginIndexResult {
    /// The index URL that was fetched.
    pub url: String,
    /// Whether that is the built-in default index.
    pub is_default: bool,
    /// How the index was authenticated (#3716): verified against the
    /// termiHub plugin-index key, unsigned, or not checked (placeholder key).
    #[cfg_attr(
        test,
        ts(type = "import(\"./PluginIndexSignatureStatus\").PluginIndexSignatureStatus")
    )]
    pub signature: IndexSignatureStatus,
    /// The listed plugins, in index order.
    #[cfg_attr(
        test,
        ts(type = "Array<import(\"./PluginIndexEntryView\").PluginIndexEntryView>")
    )]
    pub entries: Vec<PluginIndexEntryView>,
}

/// The configured index URL, or the default when unset / blank.
fn resolve_index_url(configured: Option<&str>) -> String {
    match configured.map(str::trim) {
        Some(url) if !url.is_empty() => url.to_string(),
        _ => DEFAULT_PLUGIN_INDEX_URL.to_string(),
    }
}

/// The signature policy for the index at `url`: the embedded plugin-index
/// key, with a signature **required** only for the built-in default index in a
/// release build. Custom indexes, and the default index in a dev/branch build
/// (whose `main` index may not be signed with a key that only just landed on
/// `develop`), tolerate a *missing* signature and are shown as unsigned — the
/// same dev-build rule that relaxes agent update signatures (#3213).
fn index_signature_policy(url: &str) -> IndexSignaturePolicy {
    let release = !crate::terminal::agent_binary::is_dev_build(env!("CARGO_PKG_VERSION"));
    IndexSignaturePolicy::embedded(url == DEFAULT_PLUGIN_INDEX_URL && release)
}

/// The URL of the detached signature of the index at `url`: `.sig` appended
/// to the URL's path (any query string is kept after it).
fn signature_url(url: &str) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse(url).map_err(|e| format!("URL `{url}` is invalid: {e}"))?;
    let path = format!("{}.{INDEX_SIGNATURE_EXT}", parsed.path());
    parsed.set_path(&path);
    Ok(parsed.into())
}

/// Fetch the index at `url`, check its signature against `trust` over the
/// exact bytes, and only then strictly parse it.
async fn load_index(
    url: &str,
    policy: FetchPolicy,
    trust: &IndexSignaturePolicy,
) -> Result<(PluginIndex, IndexSignatureStatus), String> {
    let bytes = fetch_capped(url, MAX_INDEX_BYTES, INDEX_TIMEOUT, policy, "plugin-index")
        .await
        .map_err(|e| format!("could not fetch the plugin index: {e}"))?;
    let signature = if trust.has_trusted_keys() {
        let sig_url = signature_url(url)?;
        match fetch_capped(
            &sig_url,
            MAX_INDEX_SIGNATURE_BYTES,
            INDEX_TIMEOUT,
            policy,
            "plugin-index-signature",
        )
        .await
        {
            Ok(sig) => Some(sig),
            Err(e) if trust.requires_signature() => {
                return Err(format!(
                    "could not fetch the plugin index signature (required for the default \
                     index): {e}"
                ));
            }
            Err(e) => {
                tracing::info!(%sig_url, error = %e, "no plugin index signature; treating as unsigned");
                None
            }
        }
    } else {
        // Placeholder key: nothing can be verified, so don't fetch.
        None
    };
    let status = trust
        .check(&bytes, signature.as_deref())
        .map_err(|e| e.to_string())?;
    match status {
        IndexSignatureStatus::Verified => {}
        IndexSignatureStatus::Unsigned => {
            tracing::warn!(%url, "loaded an UNSIGNED plugin index (not authenticated)");
        }
        IndexSignatureStatus::NotConfigured => {
            tracing::info!(
                %url,
                "plugin index signature not checked: this build has no index signing key \
                 (placeholder)"
            );
        }
    }
    let index = parse_plugin_index(&bytes).map_err(|e| e.to_string())?;
    Ok((index, status))
}

/// Installed plugin versions by id.
fn installed_versions(manager: &PluginManager) -> Result<BTreeMap<String, String>, String> {
    Ok(manager
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|p| (p.manifest.id, p.manifest.version))
        .collect())
}

/// Fetch the index at `url` and evaluate every entry for this host.
async fn browse(
    url: &str,
    policy: FetchPolicy,
    trust: &IndexSignaturePolicy,
    manager: &PluginManager,
    host: &HostFacts,
) -> Result<PluginIndexResult, String> {
    let (index, signature) = load_index(url, policy, trust).await?;
    let installed = installed_versions(manager)?;
    Ok(PluginIndexResult {
        url: url.to_string(),
        is_default: url == DEFAULT_PLUGIN_INDEX_URL,
        signature,
        entries: index
            .plugins
            .iter()
            .map(|e| evaluate_index_entry(e, host, &installed))
            .collect(),
    })
}

/// Fetch the configured plugin index and evaluate each entry's compatibility
/// with this computer. Only runs when the user asks (opening Browse / Refresh);
/// never downloads or installs anything.
#[tauri::command]
pub async fn fetch_plugin_index(
    manager: State<'_, PluginManager>,
    connections: State<'_, ConnectionManager>,
) -> Result<PluginIndexResult, String> {
    let url = resolve_index_url(connections.get_settings().plugin_index_url.as_deref());
    let result = browse(
        &url,
        FetchPolicy::STRICT,
        &index_signature_policy(&url),
        &manager,
        &HostFacts::current(),
    )
    .await;
    if let Err(error) = &result {
        tracing::info!(%url, %error, "plugin index fetch failed");
    }
    result
}

/// What a discovery download must turn out to be.
struct DownloadTarget<'a> {
    url: &'a str,
    sha256: &'a str,
    /// `(id, version)` the package must carry, when listed in an index.
    expected: Option<(&'a str, &'a str)>,
    file_name: String,
}

/// Download `target` into `dir`, verify its checksum, then validate the package
/// and (for index entries) its identity. Any failure deletes the file.
async fn download_and_check(
    target: DownloadTarget<'_>,
    policy: FetchPolicy,
    dir: &Path,
    manager: &PluginManager,
) -> Result<PathBuf, String> {
    let path = download_verified(
        target.url,
        target.sha256,
        MAX_PACKAGE_SIZE_BYTES,
        DOWNLOAD_TIMEOUT,
        policy,
        dir,
        &target.file_name,
    )
    .await?;
    let checked = match target.expected {
        Some((id, version)) => check_downloaded_package(manager, &path, id, version),
        None => manager
            .validate(&path)
            .map(|_| ())
            .map_err(|e| format!("downloaded package is invalid: {e}")),
    };
    if let Err(e) = checked {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

/// The directory verified discovery downloads land in.
fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve app cache dir: {e}"))?
        .join(DOWNLOAD_CACHE_DIR))
}

fn path_string(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "package path is not valid UTF-8".to_string())
}

/// Re-fetch the index, pick `plugin_id`'s package for this computer, and
/// download + verify it. Returns the verified package path for the install
/// dialog; **does not install it**.
///
/// The URL and checksum always come from a fresh backend fetch of the index —
/// never from the frontend — and only an entry this host can install is
/// downloaded.
#[tauri::command]
pub async fn download_plugin_from_index(
    plugin_id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
    connections: State<'_, ConnectionManager>,
) -> Result<String, String> {
    let url = resolve_index_url(connections.get_settings().plugin_index_url.as_deref());
    let path = download_index_entry(
        &url,
        &plugin_id,
        FetchPolicy::STRICT,
        &index_signature_policy(&url),
        &download_dir(&app)?,
        &manager,
        &HostFacts::current(),
    )
    .await?;
    tracing::info!(%plugin_id, "downloaded and verified indexed plugin; awaiting user install");
    path_string(path)
}

/// Core of [`download_plugin_from_index`], with the fetch policy, signature
/// policy, target directory and host injectable for tests. The index is
/// re-fetched **and re-verified** — a download never trusts an earlier load.
async fn download_index_entry(
    index_url: &str,
    plugin_id: &str,
    policy: FetchPolicy,
    trust: &IndexSignaturePolicy,
    dir: &Path,
    manager: &PluginManager,
    host: &HostFacts,
) -> Result<PathBuf, String> {
    if !is_valid_plugin_id(plugin_id) {
        return Err(format!("`{plugin_id}` is not a valid plugin id"));
    }
    let (index, _) = load_index(index_url, policy, trust).await?;
    let entry = index
        .entry(plugin_id)
        .ok_or_else(|| format!("the plugin index no longer lists `{plugin_id}`"))?;
    let view = evaluate_index_entry(entry, host, &installed_versions(manager)?);
    if let Some(reason) = view.blocked_reason {
        return Err(format!("{} cannot be installed: {reason}", entry.name));
    }
    let package = entry
        .package_for(&host.triple)
        .ok_or_else(|| format!("{} has no package for {}", entry.name, host.triple))?;
    download_and_check(
        DownloadTarget {
            url: &package.url,
            sha256: &package.sha256,
            expected: Some((&entry.id, &entry.version)),
            file_name: format!(
                "{}-{}.termihub-plugin",
                entry.id,
                sanitize_file_component(&entry.version)
            ),
        },
        policy,
        dir,
        manager,
    )
    .await
}

/// Download a package from a user-pasted HTTPS `url`, verify it against the
/// user-supplied `sha256`, and validate it. Returns the verified package path
/// for the install dialog; **does not install it**.
#[tauri::command]
pub async fn download_plugin_from_url(
    url: String,
    sha256: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<String, String> {
    let path = download_url(
        url.trim(),
        sha256.trim(),
        FetchPolicy::STRICT,
        &download_dir(&app)?,
        &manager,
    )
    .await?;
    tracing::info!(%url, "downloaded and verified plugin from URL; awaiting user install");
    path_string(path)
}

/// Core of [`download_plugin_from_url`].
async fn download_url(
    url: &str,
    sha256: &str,
    policy: FetchPolicy,
    dir: &Path,
    manager: &PluginManager,
) -> Result<PathBuf, String> {
    policy.check_url(url)?;
    if !is_valid_sha256_hex(sha256) {
        return Err("the SHA-256 checksum must be exactly 64 hex digits".to_string());
    }
    // A unique name per checksum: the manifest (and so the id) is unknown until
    // the bytes are verified.
    let file_name = format!("url-{}.termihub-plugin", sha256.to_ascii_lowercase());
    download_and_check(
        DownloadTarget {
            url,
            sha256,
            expected: None,
            file_name,
        },
        policy,
        dir,
        manager,
    )
    .await
}

#[cfg(test)]
#[path = "plugin_index_tests.rs"]
mod tests;
