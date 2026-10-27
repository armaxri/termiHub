//! Update channel selection and the develop-build channel (#5023).
//!
//! Stable builds compare semver against `releases/latest`. CI dev builds of the
//! `develop` branch all carry the same `-dev` version, so they are compared by
//! commit instead: the rolling `dev-develop-latest` pre-release that
//! `.github/workflows/dev-build.yml` publishes records the commit it was built
//! from (`target_commitish`) and when it was published (`published_at`). A develop
//! build is behind when that commit differs from its own and the pre-release was
//! published after its own commit was made.
//!
//! Notify only: nothing here downloads or installs anything.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::update::UpdateInfo;

/// GitHub API URL of the rolling develop pre-release published by `dev-build.yml`.
pub const DEVELOP_RELEASE_API_URL: &str =
    "https://api.github.com/repos/armaxri/termiHub/releases/tags/dev-develop-latest";

/// Number of hex digits shown for a commit in the develop-build notice.
const SHORT_SHA_LEN: usize = 7;

/// Which release feed an update check consults for this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    /// Tagged releases (`releases/latest`), compared by semver.
    #[default]
    Stable,
    /// The rolling `dev-develop-latest` pre-release, compared by commit.
    Develop,
    /// No update check for this build (local `tauri dev` runs, other branches).
    None,
}

/// Pick the update channel for a build.
///
/// * `tauri_is_dev` — a local `tauri dev` run: never checks.
/// * `ci_dev_build` — a CI dev build (`dev-build.yml`): `develop` follows the
///   develop pre-release, `main` keeps the stable feed, any other branch skips.
/// * Everything else (tagged release builds, whose branch is usually
///   `"unknown"`) keeps the stable feed unchanged.
pub fn select_channel(tauri_is_dev: bool, ci_dev_build: bool, build_branch: &str) -> UpdateChannel {
    if tauri_is_dev {
        return UpdateChannel::None;
    }
    if !ci_dev_build {
        return UpdateChannel::Stable;
    }
    match build_branch {
        "develop" => UpdateChannel::Develop,
        "main" => UpdateChannel::Stable,
        _ => UpdateChannel::None,
    }
}

/// Subset of the GitHub release JSON the develop channel reads.
#[derive(Debug, Deserialize)]
pub struct GitHubDevRelease {
    /// Release page opened by "Open download page".
    pub html_url: String,
    /// Full commit SHA the pre-release was built from.
    #[serde(default)]
    pub target_commitish: Option<String>,
    /// RFC 3339 time the pre-release was published.
    #[serde(default)]
    pub published_at: Option<String>,
}

/// An "unavailable" develop-channel result (up to date, or undecidable).
fn not_available(running_hash: &str, release_url: String) -> UpdateInfo {
    UpdateInfo {
        available: false,
        latest_version: running_hash.to_string(),
        release_url,
        release_notes: String::new(),
        is_security: false,
        channel: UpdateChannel::Develop,
        build_commit: None,
        build_published_at: None,
    }
}

/// A usable abbreviated or full commit hash: at least 7 hex digits.
fn is_commit_hash(s: &str) -> bool {
    s.len() >= SHORT_SHA_LEN && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether two (possibly abbreviated) commit hashes name the same commit.
fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    a.starts_with(&b) || b.starts_with(&a)
}

/// Parse the build-time commit timestamp embedded by `build.rs`.
pub fn parse_build_commit_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Compare the develop pre-release against this build.
///
/// `running_hash` is this build's (short) git hash; `build_commit_time` is when
/// its commit was made. Returns `available: true` only when the pre-release was
/// built from a different commit **and** published after this build's commit.
/// Anything undecidable (unknown hash, missing or malformed fields) is reported
/// as "not available" so a develop build is never prompted by mistake.
pub fn evaluate_develop_release(
    release: GitHubDevRelease,
    running_hash: &str,
    build_commit_time: Option<DateTime<Utc>>,
) -> UpdateInfo {
    let release_url = release.html_url;
    let Some(release_commit) = release
        .target_commitish
        .as_deref()
        .map(str::trim)
        .filter(|c| is_commit_hash(c))
    else {
        return not_available(running_hash, release_url);
    };
    if !is_commit_hash(running_hash) || same_commit(release_commit, running_hash) {
        return not_available(running_hash, release_url);
    }
    let Some(published) = release
        .published_at
        .as_deref()
        .and_then(parse_build_commit_time)
    else {
        return not_available(running_hash, release_url);
    };
    let Some(built) = build_commit_time else {
        return not_available(running_hash, release_url);
    };
    if published <= built {
        return not_available(running_hash, release_url);
    }
    let short: String = release_commit
        .to_ascii_lowercase()
        .chars()
        .take(SHORT_SHA_LEN)
        .collect();
    UpdateInfo {
        available: true,
        latest_version: short.clone(),
        release_url,
        release_notes: String::new(),
        is_security: false,
        channel: UpdateChannel::Develop,
        build_commit: Some(short),
        build_published_at: Some(published.to_rfc3339()),
    }
}

#[cfg(test)]
#[path = "update_develop_tests.rs"]
mod tests;
