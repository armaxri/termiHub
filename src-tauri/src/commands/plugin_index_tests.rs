//! Tests for plugin discovery against a local fixture server (PROD-048).

use sha2::{Digest, Sha256};
use termihub_core::plugin::{InstallOptions, InstallStatus};

use super::*;
use crate::commands::test_http_server::{Route, TestServer};

const P: FetchPolicy = FetchPolicy::TEST_ALLOW_HTTP;

struct Fixture {
    tmp: tempfile::TempDir,
    manager: PluginManager,
    package: Vec<u8>,
}

impl Fixture {
    /// A plugin manager plus a packed theme plugin `demo` at `version`.
    fn new(version: &str) -> Self {
        let tmp = tempfile::TempDir::new().unwrap();
        let manager = PluginManager::new(tmp.path().join("plugins"));
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("themes")).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            format!(
                r#"{{"id":"demo","name":"Demo","version":"{version}","author":"a",
                "description":"d","license":"MIT","apiVersion":"1.0",
                "platforms":["linux","macos","windows"],"permissions":[],
                "extensions":{{"theme":{{"themes":[{{"id":"t","name":"T","file":"t.json"}}]}}}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(src.join("themes/t.json"), b"{}").unwrap();
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let pkg = termihub_core::plugin::pack_plugin(&src, &out).unwrap();
        let package = std::fs::read(pkg).unwrap();
        Self {
            tmp,
            manager,
            package,
        }
    }

    fn sha(&self) -> String {
        hex::encode(Sha256::digest(&self.package))
    }

    fn dir(&self) -> PathBuf {
        self.tmp.path().join("downloads")
    }
}

fn index_with(entry_version: &str, min_abi: &str, sha: &str) -> Vec<u8> {
    format!(
        r#"{{"schemaVersion":1,"plugins":[{{"id":"demo","name":"Demo","description":"d",
        "author":"a","version":"{entry_version}","minHostAbi":"{min_abi}",
        "packages":[{{"platforms":["any"],"url":"https://example.invalid/demo.termihub-plugin",
        "sha256":"{sha}"}}]}}]}}"#
    )
    .into_bytes()
}

#[test]
fn blank_or_unset_setting_uses_the_default_index() {
    assert_eq!(resolve_index_url(None), DEFAULT_PLUGIN_INDEX_URL);
    assert_eq!(resolve_index_url(Some("  ")), DEFAULT_PLUGIN_INDEX_URL);
    assert_eq!(
        resolve_index_url(Some(" https://corp.example/i.json ")),
        "https://corp.example/i.json"
    );
    assert!(FetchPolicy::STRICT
        .check_url(DEFAULT_PLUGIN_INDEX_URL)
        .is_ok());
}

#[tokio::test]
async fn browse_evaluates_entries_against_installed_plugins() {
    let fx = Fixture::new("1.0.0");
    let server = TestServer::start(vec![(
        "/index.json",
        Route::Body(index_with("1.0.0", "1.0", &fx.sha())),
    )])
    .await;
    let host = HostFacts::current();
    let result = browse(&server.url("/index.json"), P, &fx.manager, &host)
        .await
        .unwrap();
    assert!(!result.is_default);
    assert_eq!(result.entries.len(), 1);
    let entry = &result.entries[0];
    assert_eq!(entry.install_status, InstallStatus::NotInstalled);
    assert!(entry.installable && entry.abi_compatible && entry.platform_supported);
}

#[tokio::test]
async fn browse_rejects_bad_indexes() {
    let server = TestServer::start(vec![
        ("/garbage", Route::Body(b"<html>nope</html>".to_vec())),
        ("/huge", Route::UnsizedBody(vec![b' '; MAX_INDEX_BYTES + 1])),
        ("/missing", Route::Status(404)),
    ])
    .await;
    let fx = Fixture::new("1.0.0");
    let host = HostFacts::current();
    for (path, needle) in [
        ("/garbage", "malformed"),
        ("/huge", "limit"),
        ("/missing", "404"),
    ] {
        let err = browse(&server.url(path), P, &fx.manager, &host)
            .await
            .unwrap_err();
        assert!(err.contains(needle), "{path}: {err}");
    }
    // The production policy never talks plain HTTP.
    let err = browse(
        &server.url("/garbage"),
        FetchPolicy::STRICT,
        &fx.manager,
        &host,
    )
    .await
    .unwrap_err();
    assert!(err.contains("https"), "{err}");
}

#[tokio::test]
async fn index_download_refuses_unlisted_and_blocked_entries_before_downloading() {
    let fx = Fixture::new("1.0.0");
    let server = TestServer::start(vec![(
        "/index.json",
        Route::Body(index_with("1.0.0", "9.0", &fx.sha())),
    )])
    .await;
    let host = HostFacts::current();
    let url = server.url("/index.json");
    let err = download_index_entry(&url, "other", P, &fx.dir(), &fx.manager, &host)
        .await
        .unwrap_err();
    assert!(err.contains("no longer lists"), "{err}");
    let err = download_index_entry(&url, "demo", P, &fx.dir(), &fx.manager, &host)
        .await
        .unwrap_err();
    assert!(err.contains("ABI 9.0"), "{err}");
    let err = download_index_entry(&url, "../evil", P, &fx.dir(), &fx.manager, &host)
        .await
        .unwrap_err();
    assert!(err.contains("not a valid plugin id"), "{err}");
    assert!(!fx.dir().exists(), "nothing may be written");
}

#[tokio::test]
async fn verified_download_hands_off_to_the_install_pipeline() {
    let fx = Fixture::new("1.0.0");
    let server = TestServer::start(vec![("/demo", Route::Body(fx.package.clone()))]).await;
    let sha = fx.sha();
    let path = download_and_check(
        DownloadTarget {
            url: &server.url("/demo"),
            sha256: &sha,
            expected: Some(("demo", "1.0.0")),
            file_name: "demo-1.0.0.termihub-plugin".into(),
        },
        P,
        &fx.dir(),
        &fx.manager,
    )
    .await
    .unwrap();
    // The verified file is installable through the ordinary, trust-gated path:
    // the unsigned package is refused without the explicit acknowledgement...
    assert!(fx.manager.install(&path, false, false).is_err());
    // ...and installs once the user accepts it.
    let installed = fx
        .manager
        .install_with(
            &path,
            InstallOptions {
                accept_untrusted: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(installed.manifest.id, "demo");
}

#[tokio::test]
async fn checksum_mismatch_or_wrong_identity_is_rejected_and_discarded() {
    let fx = Fixture::new("1.0.0");
    let server = TestServer::start(vec![("/demo", Route::Body(fx.package.clone()))]).await;
    let url = server.url("/demo");
    let sha = fx.sha();
    let wrong_sha = "f".repeat(64);
    let cases: [(&str, Option<(&str, &str)>, &str); 3] = [
        (&wrong_sha, Some(("demo", "1.0.0")), "SHA-256"),
        (&sha, Some(("other", "1.0.0")), "expected `other`"),
        (&sha, Some(("demo", "2.0.0")), "2.0.0 was advertised"),
    ];
    for (sha256, expected, needle) in cases {
        let err = download_and_check(
            DownloadTarget {
                url: &url,
                sha256,
                expected,
                file_name: "demo.termihub-plugin".into(),
            },
            P,
            &fx.dir(),
            &fx.manager,
        )
        .await
        .unwrap_err();
        assert!(err.contains(needle), "{needle}: {err}");
        assert!(!fx.dir().join("demo.termihub-plugin").exists());
    }
}

#[tokio::test]
async fn url_install_requires_https_and_a_checksum() {
    let fx = Fixture::new("1.0.0");
    let server = TestServer::start(vec![
        ("/demo", Route::Body(fx.package.clone())),
        ("/junk", Route::Body(b"not a zip".to_vec())),
    ])
    .await;
    let sha = fx.sha();
    let err = download_url(&server.url("/demo"), "abc", P, &fx.dir(), &fx.manager)
        .await
        .unwrap_err();
    assert!(err.contains("64 hex digits"), "{err}");
    let err = download_url(
        &server.url("/demo"),
        &sha,
        FetchPolicy::STRICT,
        &fx.dir(),
        &fx.manager,
    )
    .await
    .unwrap_err();
    assert!(err.contains("https"), "{err}");

    // Checksum-verified but not a package: rejected and discarded.
    let junk_sha = hex::encode(Sha256::digest(b"not a zip"));
    let err = download_url(&server.url("/junk"), &junk_sha, P, &fx.dir(), &fx.manager)
        .await
        .unwrap_err();
    assert!(err.contains("invalid"), "{err}");
    assert!(!fx
        .dir()
        .join(format!("url-{junk_sha}.termihub-plugin"))
        .exists());

    let path = download_url(&server.url("/demo"), &sha, P, &fx.dir(), &fx.manager)
        .await
        .unwrap();
    assert_eq!(fx.manager.validate(&path).unwrap().id, "demo");
}
