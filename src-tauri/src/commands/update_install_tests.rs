//! Tests for the in-app update install decisions (#5758).

use super::*;

/// A stable, keyed, installed macOS arm64 `.app` — the in-place baseline.
fn ctx() -> InstallContext {
    InstallContext {
        channel: UpdateChannel::Stable,
        updater_configured: true,
        install_kind: Some(InstallKind::App),
        portable: false,
        identity_vars: Vec::new(),
        os: "macos".into(),
        arch: "aarch64".into(),
    }
}

fn with(f: impl FnOnce(&mut InstallContext)) -> InstallContext {
    let mut c = ctx();
    f(&mut c);
    c
}

// ── per-platform routes ─────────────────────────────────────────────────────

#[test]
fn macos_app_updates_in_place_on_both_architectures() {
    assert_eq!(install_route(&ctx()), Ok("darwin-aarch64-app".into()));
    let intel = with(|c| c.arch = "x86_64".into());
    assert_eq!(install_route(&intel), Ok("darwin-x86_64-app".into()));
}

#[test]
fn windows_msi_updates_in_place() {
    let c = with(|c| {
        c.os = "windows".into();
        c.arch = "x86_64".into();
        c.install_kind = Some(InstallKind::Msi);
    });
    assert_eq!(install_route(&c), Ok("windows-x86_64-msi".into()));
}

#[test]
fn windows_nsis_is_not_published_so_it_keeps_the_release_page() {
    let c = with(|c| {
        c.os = "windows".into();
        c.arch = "x86_64".into();
        c.install_kind = Some(InstallKind::Nsis);
    });
    assert_eq!(
        install_route(&c),
        Err(ReleasePageReason::UnsupportedInstall)
    );
}

#[test]
fn linux_appimage_updates_in_place() {
    let c = with(|c| {
        c.os = "linux".into();
        c.arch = "x86_64".into();
        c.install_kind = Some(InstallKind::AppImage);
    });
    assert_eq!(install_route(&c), Ok("linux-x86_64-appimage".into()));
}

#[test]
fn deb_and_rpm_keep_the_release_page() {
    for kind in [InstallKind::Deb, InstallKind::Rpm] {
        for arch in ["x86_64", "aarch64"] {
            let c = with(|c| {
                c.os = "linux".into();
                c.arch = arch.into();
                c.install_kind = Some(kind);
            });
            assert_eq!(
                install_route(&c),
                Err(ReleasePageReason::PackageManager),
                "{kind:?} on {arch}"
            );
        }
    }
}

#[test]
fn an_unpublished_architecture_keeps_the_release_page() {
    // No AppImage is built for Linux ARM64 (linuxdeploy is x86_64-only).
    let c = with(|c| {
        c.os = "linux".into();
        c.install_kind = Some(InstallKind::AppImage);
    });
    assert_eq!(
        install_route(&c),
        Err(ReleasePageReason::UnsupportedInstall)
    );
}

#[test]
fn an_unknown_bundle_keeps_the_release_page() {
    let c = with(|c| {
        c.os = "linux".into();
        c.install_kind = None;
    });
    assert_eq!(
        install_route(&c),
        Err(ReleasePageReason::UnsupportedInstall)
    );
}

// ── fallbacks ───────────────────────────────────────────────────────────────

#[test]
fn a_build_without_an_updater_key_keeps_the_release_page() {
    let c = with(|c| c.updater_configured = false);
    assert_eq!(install_route(&c), Err(ReleasePageReason::NoUpdaterKey));
}

#[test]
fn develop_and_unchecked_builds_keep_the_release_page() {
    for channel in [UpdateChannel::Develop, UpdateChannel::None] {
        let c = with(|c| c.channel = channel);
        assert_eq!(install_route(&c), Err(ReleasePageReason::NotStableChannel));
    }
}

#[test]
fn a_portable_copy_keeps_the_release_page() {
    let c = with(|c| c.portable = true);
    assert_eq!(install_route(&c), Err(ReleasePageReason::Portable));
}

#[test]
fn an_isolated_instance_is_not_restarted_by_the_windows_installer() {
    let isolated = vec!["TERMIHUB_CONFIG_DIR".to_string()];
    let windows = with(|c| {
        c.os = "windows".into();
        c.arch = "x86_64".into();
        c.install_kind = Some(InstallKind::Msi);
        c.identity_vars = isolated.clone();
    });
    assert_eq!(
        install_route(&windows),
        Err(ReleasePageReason::IsolatedInstance)
    );
    // macOS / Linux relaunch through utils::relaunch, which keeps the profile.
    let mac = with(|c| c.identity_vars = isolated);
    assert!(install_route(&mac).is_ok());
}

#[test]
fn route_summary_maps_to_the_frontend_fields() {
    assert_eq!(
        route_summary(&Ok("darwin-aarch64-app".into())),
        (UpdateInstallMethod::InApp, None)
    );
    assert_eq!(
        route_summary(&Err(ReleasePageReason::PackageManager)),
        (
            UpdateInstallMethod::ReleasePage,
            Some(ReleasePageReason::PackageManager)
        )
    );
}

// ── config ──────────────────────────────────────────────────────────────────

#[test]
fn updater_key_must_be_present_and_non_empty() {
    use serde_json::json;
    assert!(!updater_pubkey_configured(None));
    assert!(!updater_pubkey_configured(Some(&json!({}))));
    assert!(!updater_pubkey_configured(Some(&json!({ "pubkey": "" }))));
    assert!(!updater_pubkey_configured(Some(&json!({ "pubkey": "  " }))));
    assert!(!updater_pubkey_configured(Some(&json!({ "pubkey": 1 }))));
    assert!(updater_pubkey_configured(Some(
        &json!({ "pubkey": "dW50cnVzdGVk" })
    )));
}

#[test]
fn the_base_config_has_no_updater_key() {
    // Dev and CI builds must never offer an in-place update: the key lives only
    // in the release fragment.
    let base: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert!(base["plugins"].get("updater").is_none());
    assert!(base["bundle"].get("createUpdaterArtifacts").is_none());
}

#[test]
fn the_release_fragment_enforces_signed_versions_and_points_at_latest_json() {
    let fragment: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.updater.conf.json")).unwrap();
    let platforms: serde_json::Value = serde_json::from_str(include_str!(
        "../../../scripts/internal/updater-platforms.json"
    ))
    .unwrap();
    let updater = &fragment["plugins"]["updater"];
    // The bundler must not sign (#5761): `createUpdaterArtifacts` would make
    // `tauri build` demand TAURI_SIGNING_PRIVATE_KEY in a job that runs
    // third-party build code. release.yml's sign-updater job signs instead.
    assert!(fragment["bundle"].get("createUpdaterArtifacts").is_none());
    assert_eq!(updater["requireSignedVersion"], true);
    assert_ne!(updater["allowDowngrades"], true);
    assert_eq!(
        updater["endpoints"],
        serde_json::json!([platforms["endpoint"]])
    );
    assert!(updater["pubkey"].is_string());
}

#[test]
fn published_targets_match_the_release_manifest_platforms() {
    let platforms: serde_json::Value = serde_json::from_str(include_str!(
        "../../../scripts/internal/updater-platforms.json"
    ))
    .unwrap();
    let mut from_json: Vec<String> = platforms["platforms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["target"].as_str().unwrap().to_string())
        .collect();
    let mut from_rust: Vec<String> = PUBLISHED_TARGETS.iter().map(|t| t.to_string()).collect();
    from_json.sort();
    from_rust.sort();
    assert_eq!(from_json, from_rust);
}

// ── downgrade policy ────────────────────────────────────────────────────────

#[test]
fn a_newer_offered_version_matching_the_check_is_accepted() {
    assert_eq!(check_offered_version("0.1.0", "0.2.0", "0.2.0"), Ok(()));
    assert_eq!(check_offered_version("0.1.0", "0.1.1", "v0.1.1"), Ok(()));
}

#[test]
fn downgrades_and_reinstalls_are_refused() {
    assert!(check_offered_version("0.2.0", "0.1.0", "0.1.0")
        .unwrap_err()
        .contains("never downgrades"));
    assert!(check_offered_version("0.2.0", "0.2.0", "0.2.0").is_err());
}

#[test]
fn a_manifest_version_other_than_the_checked_one_is_refused() {
    let err = check_offered_version("0.1.0", "0.3.0", "0.2.0").unwrap_err();
    assert!(err.contains("not the v0.2.0"), "{err}");
}

#[test]
fn unparseable_versions_are_refused() {
    assert!(check_offered_version("x", "0.2.0", "0.2.0").is_err());
    assert!(check_offered_version("0.1.0", "y", "0.2.0").is_err());
}

#[test]
fn bundle_types_map_to_install_kinds() {
    use tauri::utils::config::BundleType;
    assert_eq!(
        InstallKind::from_bundle_type(BundleType::Dmg),
        InstallKind::App
    );
    assert_eq!(
        InstallKind::from_bundle_type(BundleType::AppImage),
        InstallKind::AppImage
    );
    assert_eq!(
        InstallKind::from_bundle_type(BundleType::Deb),
        InstallKind::Deb
    );
}
