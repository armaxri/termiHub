use super::*;

const RELEASE_URL: &str = "https://github.com/armaxri/termiHub/releases/tag/dev-develop-latest";
const RELEASE_SHA: &str = "0e3504c5741626da0dc2618dd1378efa4979ed01";

/// Mock of the GitHub `releases/tags/dev-develop-latest` response, as
/// `dev-release-publish.sh` leaves it (extra fields are ignored).
fn release_json(target: Option<&str>, published: Option<&str>) -> GitHubDevRelease {
    let mut value = serde_json::json!({
        "tag_name": "dev-develop-latest",
        "name": "Dev Build — not for production use (develop @ 0e3504c)",
        "prerelease": true,
        "draft": false,
        "html_url": RELEASE_URL,
        "body": "## Dev Build",
    });
    if let Some(t) = target {
        value["target_commitish"] = serde_json::json!(t);
    }
    if let Some(p) = published {
        value["published_at"] = serde_json::json!(p);
    }
    serde_json::from_value(value).unwrap()
}

fn at(s: &str) -> Option<DateTime<Utc>> {
    parse_build_commit_time(s)
}

// ── select_channel ────────────────────────────────────────────────────────────

#[test]
fn ci_develop_build_uses_develop_channel() {
    assert_eq!(
        select_channel(false, true, "develop"),
        UpdateChannel::Develop
    );
}

#[test]
fn ci_main_build_keeps_stable_channel() {
    assert_eq!(select_channel(false, true, "main"), UpdateChannel::Stable);
}

#[test]
fn release_build_keeps_stable_channel() {
    // release.yml builds from a tag: build.rs reports the branch as "unknown".
    assert_eq!(
        select_channel(false, false, "unknown"),
        UpdateChannel::Stable
    );
    assert_eq!(select_channel(false, false, "main"), UpdateChannel::Stable);
}

#[test]
fn ci_dev_build_of_other_branch_skips_check() {
    assert_eq!(
        select_channel(false, true, "feature/1-x"),
        UpdateChannel::None
    );
    assert_eq!(select_channel(false, true, "unknown"), UpdateChannel::None);
}

#[test]
fn tauri_dev_run_skips_check() {
    assert_eq!(select_channel(true, false, "develop"), UpdateChannel::None);
    assert_eq!(select_channel(true, true, "develop"), UpdateChannel::None);
    assert_eq!(select_channel(true, false, "main"), UpdateChannel::None);
}

#[test]
fn channel_serializes_camel_case() {
    assert_eq!(
        serde_json::to_string(&UpdateChannel::Develop).unwrap(),
        "\"develop\""
    );
    assert_eq!(
        serde_json::to_string(&UpdateChannel::None).unwrap(),
        "\"none\""
    );
}

// ── evaluate_develop_release ──────────────────────────────────────────────────

#[test]
fn newer_develop_build_is_available() {
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T10:00:00+02:00"));
    assert!(info.available);
    assert_eq!(info.channel, UpdateChannel::Develop);
    assert_eq!(info.latest_version, "0e3504c");
    assert_eq!(info.build_commit.as_deref(), Some("0e3504c"));
    assert_eq!(
        info.build_published_at.as_deref(),
        Some("2026-10-26T23:31:19+00:00")
    );
    assert_eq!(info.release_url, RELEASE_URL);
    assert!(!info.is_security);
}

#[test]
fn identical_build_is_not_offered() {
    // Same commit, even though the release was published after the commit.
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "0e3504c", at("2026-10-26T22:50:00Z"));
    assert!(!info.available);
    assert_eq!(info.channel, UpdateChannel::Develop);
    assert!(info.build_commit.is_none());
}

#[test]
fn identical_build_with_longer_short_hash_is_not_offered() {
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "0E3504C57", at("2026-10-26T22:50:00Z"));
    assert!(!info.available);
}

#[test]
fn older_release_than_build_is_not_offered() {
    // This build's commit is newer than the published pre-release.
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-27T08:00:00Z"));
    assert!(!info.available);
}

#[test]
fn missing_target_commit_is_not_offered() {
    let release = release_json(None, Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
}

#[test]
fn branch_name_target_is_not_offered() {
    // A release created without --target reports the branch, not a commit.
    let release = release_json(Some("develop"), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
}

#[test]
fn missing_published_at_is_not_offered() {
    let release = release_json(Some(RELEASE_SHA), None);
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
}

#[test]
fn malformed_published_at_is_not_offered() {
    let release = release_json(Some(RELEASE_SHA), Some("yesterday"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
}

#[test]
fn missing_build_time_is_not_offered() {
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "abc1234", None);
    assert!(!info.available);
}

#[test]
fn unknown_running_hash_is_not_offered() {
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "unknown", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
}

#[test]
fn release_json_without_optional_fields_parses() {
    let release: GitHubDevRelease =
        serde_json::from_str(r#"{"html_url":"https://example.invalid/r"}"#).unwrap();
    assert!(release.target_commitish.is_none());
    assert!(release.published_at.is_none());
}

#[test]
fn build_commit_time_parses_git_iso_format() {
    // `git show -s --format=%cI` output, with a trailing newline.
    assert!(parse_build_commit_time("2026-10-26T23:55:14+01:00\n").is_some());
    assert!(parse_build_commit_time("").is_none());
}

// ── boundaries and normalisation (#5168) ──────────────────────────────────────

#[test]
fn a_release_published_exactly_at_the_build_commit_time_is_not_offered() {
    let release = release_json(Some(RELEASE_SHA), Some("2026-10-26T23:31:19Z"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-26T23:31:19Z"));
    assert!(!info.available);
}

#[test]
fn an_offered_commit_is_trimmed_lowercased_and_shortened() {
    let padded = format!("  {}  ", RELEASE_SHA.to_ascii_uppercase());
    let release = release_json(Some(&padded), Some("2026-10-26T23:31:19+02:00"));
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T00:00:00Z"));
    assert!(info.available);
    assert_eq!(info.latest_version, "0e3504c");
    assert_eq!(info.build_commit.as_deref(), Some("0e3504c"));
    // Normalised to UTC.
    assert_eq!(
        info.build_published_at.as_deref(),
        Some("2026-10-26T21:31:19+00:00")
    );
    assert_eq!(info.release_url, RELEASE_URL);
}

#[test]
fn a_not_available_result_keeps_the_running_hash_and_release_url() {
    let release = release_json(Some(RELEASE_SHA), None);
    let info = evaluate_develop_release(release, "abc1234", at("2026-10-25T00:00:00Z"));
    assert!(!info.available);
    assert_eq!(info.latest_version, "abc1234");
    assert_eq!(info.release_url, RELEASE_URL);
    assert!(info.build_published_at.is_none());
    assert!(!info.is_security);
}

#[test]
fn a_too_short_or_non_hex_hash_is_not_a_commit() {
    for (hash, ok) in [
        ("abc123", false),
        ("abc1234", true),
        ("ABC1234", true),
        ("abc123g", false),
        (RELEASE_SHA, true),
    ] {
        assert_eq!(is_commit_hash(hash), ok, "{hash}");
    }
}

#[test]
fn abbreviated_hashes_match_their_full_commit_either_way() {
    assert!(same_commit("0e3504c", RELEASE_SHA));
    assert!(same_commit(RELEASE_SHA, "0E3504C"));
    assert!(!same_commit("0e3504d", RELEASE_SHA));
}

#[test]
fn a_malformed_build_commit_time_does_not_parse() {
    assert!(parse_build_commit_time("").is_none());
    assert!(parse_build_commit_time("2026-10-26").is_none());
    assert!(parse_build_commit_time(" 2026-10-26T23:31:19Z\n").is_some());
}
