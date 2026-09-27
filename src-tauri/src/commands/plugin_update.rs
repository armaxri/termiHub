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
//! decision live, network-free, in [`termihub_core::plugin`]'s `update_check`;
//! the HTTPS-only, redirect-bounded, size-capped, timed-out client lives in
//! [`super::plugin_fetch`], shared with plugin discovery):
//!
//! * **Size-capped** — the update document at [`MAX_UPDATE_DOCUMENT_BYTES`], a
//!   package at [`MAX_PACKAGE_SIZE_BYTES`].
//! * **Verified** — a downloaded package is streamed to a private temp file and
//!   must match the document's SHA-256 before it is kept or parsed; it must then
//!   carry the same plugin id and the advertised version, or it is discarded.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use termihub_core::plugin::{
    evaluate_update, parse_update_document, InstalledPlugin, PluginManager, UpdateCheckOutcome,
    UpdateStatus, MAX_PACKAGE_SIZE_BYTES, MAX_UPDATE_DOCUMENT_BYTES,
};

use super::plugin_fetch::{download_verified, fetch_capped, sanitize_file_component, FetchPolicy};

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

/// Fetch and evaluate the update document for one installed plugin.
async fn check_one(plugin: &InstalledPlugin) -> Result<UpdateCheckOutcome, String> {
    let manifest = &plugin.manifest;
    let url = manifest
        .update_url
        .as_deref()
        .ok_or_else(|| format!("plugin `{}` declares no updateUrl", manifest.id))?;
    let bytes = fetch_capped(
        url,
        MAX_UPDATE_DOCUMENT_BYTES,
        DOCUMENT_TIMEOUT,
        FetchPolicy::STRICT,
        "plugin-update",
    )
    .await?;
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

/// The file name a verified update package for `outcome` is stored under.
fn package_file_name(outcome: &UpdateCheckOutcome) -> String {
    format!(
        "{}-{}.termihub-plugin",
        outcome.plugin_id,
        sanitize_file_component(&outcome.latest_version)
    )
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

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve app cache dir: {e}"))?;
    let path = download_verified(
        &outcome.download_url,
        &outcome.sha256,
        MAX_PACKAGE_SIZE_BYTES,
        DOWNLOAD_TIMEOUT,
        FetchPolicy::STRICT,
        &cache_dir.join(UPDATE_CACHE_DIR),
        &package_file_name(&outcome),
    )
    .await
    .map_err(|e| {
        format!(
            "could not download {} {}: {e}",
            plugin.manifest.name, outcome.latest_version
        )
    })?;

    if let Err(e) =
        check_downloaded_package(&manager, &path, &outcome.plugin_id, &outcome.latest_version)
    {
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

/// Validate a downloaded (already checksum-verified) package and require it to
/// be plugin `expected_id` at `expected_version` — the one that was advertised.
/// Shared with plugin discovery (PROD-048).
pub(crate) fn check_downloaded_package(
    manager: &PluginManager,
    path: &Path,
    expected_id: &str,
    expected_version: &str,
) -> Result<(), String> {
    let manifest = manager
        .validate(path)
        .map_err(|e| format!("downloaded package is invalid: {e}"))?;
    if manifest.id != expected_id {
        return Err(format!(
            "downloaded package is plugin `{}`, expected `{expected_id}`",
            manifest.id
        ));
    }
    if manifest.version != expected_version {
        return Err(format!(
            "downloaded package is version {}, but version {expected_version} was advertised",
            manifest.version
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_file_name_is_a_single_safe_segment() {
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
        assert_eq!(
            package_file_name(&outcome),
            "my-plugin-1.1.0-build-..-x.termihub-plugin"
        );
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

        assert!(check_downloaded_package(&manager, &pkg, "upd", "1.1.0").is_ok());
        assert!(check_downloaded_package(&manager, &pkg, "other", "1.1.0")
            .unwrap_err()
            .contains("expected `other`"));
        assert!(check_downloaded_package(&manager, &pkg, "upd", "1.2.0")
            .unwrap_err()
            .contains("version 1.2.0 was advertised"));
    }
}
