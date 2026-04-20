use anyhow::Context;
use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tracing::debug;

use crate::connection::manager::ConnectionManager;
use crate::connection::settings::UpdateSettings;

const GITHUB_API_URL: &str = "https://api.github.com/repos/armaxri/termiHub/releases/latest";

/// Minimum interval between automatic update checks (1 hour).
const MIN_CHECK_INTERVAL_SECS: i64 = 3600;

/// Build-time information exposed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Running version string, including `-dev` suffix for dev builds.
    pub version: String,
    /// Short git commit hash embedded at build time.
    pub git_hash: String,
    /// Whether this is a development (non-production) build.
    pub is_dev: bool,
}

/// Return build-time info (version, git hash, dev flag) to the frontend.
#[tauri::command]
pub fn get_app_info(app_handle: AppHandle) -> AppInfo {
    let base = app_handle.package_info().version.to_string();
    let is_dev = tauri::is_dev();
    let version = if is_dev { format!("{base}-dev") } else { base };
    AppInfo {
        version,
        git_hash: env!("GIT_HASH").to_string(),
        is_dev,
    }
}

/// Result returned to the frontend after an update check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Whether a newer version than the running one is available.
    pub available: bool,
    /// Latest version string from GitHub (e.g. `"0.2.0"`).
    pub latest_version: String,
    /// URL of the GitHub releases page for the latest release.
    pub release_url: String,
    /// Release notes (Markdown from the GitHub release body).
    pub release_notes: String,
    /// Whether the release is marked as a security update via `<!-- security -->`.
    pub is_security: bool,
}

/// Subset of the GitHub Releases API response that we consume.
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    prerelease: bool,
    body: Option<String>,
    html_url: String,
}

/// Parse a GitHub `tag_name` like `"v0.2.0"` or `"0.2.0"` into a `semver::Version`.
fn parse_tag(tag: &str) -> anyhow::Result<Version> {
    let stripped = tag.trim_start_matches('v');
    Version::parse(stripped).with_context(|| format!("Invalid version tag: {tag}"))
}

/// Fetch the latest release from GitHub and compare against `running_version`.
///
/// Returns `Err` on network / parse failures so callers can handle them
/// gracefully without panicking.
pub async fn fetch_update_info(running_version: &str) -> anyhow::Result<UpdateInfo> {
    let client = reqwest::Client::builder()
        .user_agent(format!("termiHub/{running_version}"))
        .build()
        .context("Failed to build HTTP client")?;

    let response = client
        .get(GITHUB_API_URL)
        .send()
        .await
        .context("Failed to reach GitHub API")?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(anyhow::anyhow!("GitHub API returned HTTP {status}"));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .context("Failed to parse GitHub API response")?;

    // Skip pre-releases on the stable channel.
    if release.prerelease {
        let running = parse_tag(running_version)?;
        return Ok(UpdateInfo {
            available: false,
            latest_version: running.to_string(),
            release_url: release.html_url,
            release_notes: String::new(),
            is_security: false,
        });
    }

    let latest = parse_tag(&release.tag_name)?;
    let running = parse_tag(running_version)?;
    let available = latest > running;

    let body = release.body.unwrap_or_default();
    let is_security = body.contains("<!-- security -->");

    Ok(UpdateInfo {
        available,
        latest_version: latest.to_string(),
        release_url: release.html_url,
        release_notes: body,
        is_security,
    })
}

/// Return the current UTC time as an ISO 8601 string.
fn now_iso8601() -> String {
    Utc::now().to_rfc3339()
}

/// Parse an ISO 8601 timestamp; returns `None` on failure.
fn parse_timestamp(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Check whether a check is needed given the last check timestamp and rate-limit interval.
///
/// Returns `true` if a check should proceed, `false` if it was too recent.
fn should_check(last_check_time: &Option<String>, force: bool) -> bool {
    if force {
        return true;
    }
    let Some(ts) = last_check_time.as_deref().and_then(parse_timestamp) else {
        return true;
    };
    let elapsed = Utc::now().signed_duration_since(ts).num_seconds();
    elapsed >= MIN_CHECK_INTERVAL_SECS
}

/// Check for a termiHub update.
///
/// * `force` — skip the 1-hour rate limit (used by the "Check Now" button).
///
/// On any network or API error the command returns an `UpdateInfo` with
/// `available: false` and logs the error — callers should never show a
/// hard error to the user for a background check.
#[tauri::command]
pub async fn check_for_updates(
    force: bool,
    app_handle: AppHandle,
    manager: State<'_, ConnectionManager>,
) -> Result<UpdateInfo, String> {
    let base_version = app_handle.package_info().version.to_string();
    let running_version = if tauri::is_dev() {
        format!("{base_version}-dev")
    } else {
        base_version
    };
    debug!("Checking for updates (running={running_version}, force={force})");

    let settings = manager.get_settings();
    let update_settings = settings.updates.clone();

    // Rate-limit automatic checks.
    if !should_check(&update_settings.last_check_time, force) {
        debug!("Update check skipped — last check was less than 1 hour ago");
        // Return "not available" without hitting the network.
        return Ok(UpdateInfo {
            available: false,
            latest_version: running_version,
            release_url: String::new(),
            release_notes: String::new(),
            is_security: false,
        });
    }

    let info = match fetch_update_info(&running_version).await {
        Ok(info) => info,
        Err(err) => {
            tracing::warn!("Update check failed: {err:#}");
            // Persist the timestamp even on failure to avoid hammering the API.
            let mut new_settings = manager.get_settings();
            new_settings.updates.last_check_time = Some(now_iso8601());
            if let Err(save_err) = manager.save_settings(new_settings) {
                tracing::warn!("Failed to persist update check timestamp: {save_err:#}");
            }
            return Ok(UpdateInfo {
                available: false,
                latest_version: running_version,
                release_url: String::new(),
                release_notes: String::new(),
                is_security: false,
            });
        }
    };

    // Persist last_check_time.
    let mut new_settings = manager.get_settings();
    new_settings.updates.last_check_time = Some(now_iso8601());
    if let Err(save_err) = manager.save_settings(new_settings) {
        tracing::warn!("Failed to persist update check timestamp: {save_err:#}");
    }

    debug!(
        "Update check complete: available={}, latest={}",
        info.available, info.latest_version
    );
    Ok(info)
}

/// Persist the user's choice to skip a specific version.
#[tauri::command]
pub fn skip_update_version(
    version: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    let mut settings = manager.get_settings();
    settings.updates.skipped_version = Some(version);
    manager.save_settings(settings).map_err(|e| e.to_string())
}

/// Clear any previously skipped version (user wants to be reminded again).
#[tauri::command]
pub fn clear_skipped_version(manager: State<'_, ConnectionManager>) -> Result<(), String> {
    let mut settings = manager.get_settings();
    settings.updates.skipped_version = None;
    manager.save_settings(settings).map_err(|e| e.to_string())
}

/// Persist the auto-check preference.
#[tauri::command]
pub fn set_update_auto_check(
    enabled: bool,
    manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    let mut settings = manager.get_settings();
    settings.updates.auto_check = enabled;
    manager.save_settings(settings).map_err(|e| e.to_string())
}

/// Return the current update settings (auto-check flag, last check time, skipped version).
#[tauri::command]
pub fn get_update_settings(
    manager: State<'_, ConnectionManager>,
) -> Result<UpdateSettings, String> {
    Ok(manager.get_settings().updates)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_tag ─────────────────────────────────────────────────────────────

    #[test]
    fn parse_tag_with_v_prefix() {
        let v = parse_tag("v0.2.0").unwrap();
        assert_eq!(v, Version::new(0, 2, 0));
    }

    #[test]
    fn parse_tag_without_v_prefix() {
        let v = parse_tag("1.0.3").unwrap();
        assert_eq!(v, Version::new(1, 0, 3));
    }

    #[test]
    fn parse_tag_invalid_returns_error() {
        assert!(parse_tag("not-a-version").is_err());
    }

    // ── should_check ──────────────────────────────────────────────────────────

    #[test]
    fn should_check_with_no_previous_check() {
        assert!(should_check(&None, false));
    }

    #[test]
    fn should_check_force_overrides_rate_limit() {
        let recent = now_iso8601();
        assert!(should_check(&Some(recent), true));
    }

    #[test]
    fn should_check_respects_rate_limit_within_one_hour() {
        let recent = now_iso8601();
        // Just stored — less than 1 hour ago
        assert!(!should_check(&Some(recent), false));
    }

    #[test]
    fn should_check_allows_check_after_one_hour() {
        let old_ts =
            (Utc::now() - chrono::Duration::seconds(MIN_CHECK_INTERVAL_SECS + 60)).to_rfc3339();
        assert!(should_check(&Some(old_ts), false));
    }

    #[test]
    fn should_check_treats_invalid_timestamp_as_no_previous_check() {
        assert!(should_check(&Some("not-a-timestamp".to_string()), false));
    }

    // ── fetch_update_info (mock) ──────────────────────────────────────────────

    fn make_release_json(tag: &str, prerelease: bool, body: &str) -> String {
        serde_json::json!({
            "tag_name": tag,
            "prerelease": prerelease,
            "body": body,
            "html_url": "https://github.com/armaxri/termiHub/releases/tag/v0.2.0"
        })
        .to_string()
    }

    /// Parse mock JSON directly into a GitHubRelease to test detection logic.
    fn detect_from_json(running: &str, json: &str) -> UpdateInfo {
        let release: GitHubRelease = serde_json::from_str(json).unwrap();
        let latest = parse_tag(&release.tag_name).unwrap();
        let running_v = parse_tag(running).unwrap();
        let available = latest > running_v;
        let body = release.body.unwrap_or_default();
        let is_security = body.contains("<!-- security -->");
        UpdateInfo {
            available,
            latest_version: latest.to_string(),
            release_url: release.html_url,
            release_notes: body,
            is_security,
        }
    }

    #[test]
    fn detects_newer_version_as_available() {
        let json = make_release_json("v0.2.0", false, "New features");
        let info = detect_from_json("0.1.0", &json);
        assert!(info.available);
        assert_eq!(info.latest_version, "0.2.0");
        assert!(!info.is_security);
    }

    #[test]
    fn running_same_version_is_up_to_date() {
        let json = make_release_json("v0.1.0", false, "Nothing new");
        let info = detect_from_json("0.1.0", &json);
        assert!(!info.available);
    }

    #[test]
    fn running_newer_than_release_is_up_to_date() {
        let json = make_release_json("v0.1.0", false, "Old release");
        let info = detect_from_json("0.2.0", &json);
        assert!(!info.available);
    }

    #[test]
    fn detects_security_marker_in_release_body() {
        let json = make_release_json("v0.1.1", false, "<!-- security -->\nFixes CVE-2026-0001");
        let info = detect_from_json("0.1.0", &json);
        assert!(info.available);
        assert!(info.is_security);
    }

    #[test]
    fn no_security_marker_means_regular_update() {
        let json = make_release_json("v0.2.0", false, "New feature release");
        let info = detect_from_json("0.1.0", &json);
        assert!(!info.is_security);
    }

    #[test]
    fn patch_release_detected_as_available() {
        let json = make_release_json("v0.1.1", false, "Bug fixes");
        let info = detect_from_json("0.1.0", &json);
        assert!(info.available);
        assert_eq!(info.latest_version, "0.1.1");
    }

    #[test]
    fn major_version_bump_detected() {
        let json = make_release_json("v2.0.0", false, "Breaking changes");
        let info = detect_from_json("1.9.9", &json);
        assert!(info.available);
        assert_eq!(info.latest_version, "2.0.0");
    }

    // ── dev build version comparison ──────────────────────────────────────────

    /// The release `v0.1.0` is semver-greater than the pre-release `0.1.0-dev`,
    /// so a dev build should be offered an update to the matching release.
    #[test]
    fn dev_build_offered_matching_release_as_update() {
        let json = make_release_json("v0.1.0", false, "First stable release");
        let info = detect_from_json("0.1.0-dev", &json);
        assert!(info.available);
        assert_eq!(info.latest_version, "0.1.0");
    }

    /// A dev build running ahead of any release should not be offered a downgrade.
    #[test]
    fn dev_build_ahead_of_release_is_up_to_date() {
        let json = make_release_json("v0.1.0", false, "Old release");
        let info = detect_from_json("0.2.0-dev", &json);
        assert!(!info.available);
    }

    /// A dev build is offered a newer release when one exists.
    #[test]
    fn dev_build_offered_newer_release() {
        let json = make_release_json("v0.2.0", false, "New release");
        let info = detect_from_json("0.1.0-dev", &json);
        assert!(info.available);
        assert_eq!(info.latest_version, "0.2.0");
    }

    /// The `-dev` suffix is valid semver pre-release syntax and parses correctly.
    #[test]
    fn parse_tag_dev_suffix() {
        let v = parse_tag("0.1.0-dev").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 1);
        assert_eq!(v.patch, 0);
        assert!(!v.pre.is_empty());
    }
}
