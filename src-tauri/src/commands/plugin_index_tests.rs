//! Tests for plugin discovery against a local fixture server (PROD-048).

use sha2::{Digest, Sha256};
use termihub_core::plugin::index_signature_test_support::{sign_index, test_index_key};
use termihub_core::plugin::{InstallOptions, InstallStatus};

use super::*;
use crate::commands::test_http_server::{Route, TestServer};

const P: FetchPolicy = FetchPolicy::TEST_ALLOW_HTTP;

/// A build without an index key (the committed placeholder): no signature is
/// fetched or checked.
fn no_key() -> IndexSignaturePolicy {
    IndexSignaturePolicy::new(Vec::new(), true)
}

/// Trusting test key 1; `require` as for the default index in a release build.
fn trust_key1(require: bool) -> IndexSignaturePolicy {
    IndexSignaturePolicy::new(vec![test_index_key(1).verifying_key()], require)
}

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
    let result = browse(&server.url("/index.json"), P, &no_key(), &fx.manager, &host)
        .await
        .unwrap();
    assert!(!result.is_default);
    assert_eq!(result.signature, IndexSignatureStatus::NotConfigured);
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
        let err = browse(&server.url(path), P, &no_key(), &fx.manager, &host)
            .await
            .unwrap_err();
        assert!(err.contains(needle), "{path}: {err}");
    }
    // The production policy never talks plain HTTP.
    let err = browse(
        &server.url("/garbage"),
        FetchPolicy::STRICT,
        &no_key(),
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
    let err = download_index_entry(&url, "other", P, &no_key(), &fx.dir(), &fx.manager, &host)
        .await
        .unwrap_err();
    assert!(err.contains("no longer lists"), "{err}");
    let err = download_index_entry(&url, "demo", P, &no_key(), &fx.dir(), &fx.manager, &host)
        .await
        .unwrap_err();
    assert!(err.contains("ABI 9.0"), "{err}");
    let err = download_index_entry(&url, "../evil", P, &no_key(), &fx.dir(), &fx.manager, &host)
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
    // (sha256, expected identity, error substring)
    type Case<'a> = (&'a str, Option<(&'a str, &'a str)>, &'a str);
    let cases: [Case; 3] = [
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

// --- Index signature (#3716) ---

#[test]
fn signature_url_appends_sig_to_the_path() {
    assert_eq!(
        signature_url(DEFAULT_PLUGIN_INDEX_URL).unwrap(),
        format!("{DEFAULT_PLUGIN_INDEX_URL}.sig")
    );
    assert_eq!(
        signature_url("https://corp.example/i.json?token=1").unwrap(),
        "https://corp.example/i.json.sig?token=1"
    );
}

#[test]
fn only_the_default_index_in_a_release_build_requires_a_signature() {
    assert!(!index_signature_policy("https://corp.example/i.json").requires_signature());
    // Unit tests are a debug (dev) build, so the default index tolerates a
    // missing signature here; release builds require it.
    assert_eq!(
        index_signature_policy(DEFAULT_PLUGIN_INDEX_URL).requires_signature(),
        !crate::terminal::agent_binary::is_dev_build(env!("CARGO_PKG_VERSION"))
    );
}

/// Serves `index` at `/index.json` and, when given, `sig` at `/index.json.sig`.
async fn signed_server(index: Vec<u8>, sig: Option<Route>) -> TestServer {
    let mut routes = vec![("/index.json", Route::Body(index))];
    if let Some(sig) = sig {
        routes.push(("/index.json.sig", sig));
    }
    TestServer::start(routes).await
}

#[tokio::test]
async fn default_index_with_a_valid_signature_is_verified() {
    let fx = Fixture::new("1.0.0");
    let index = index_with("1.0.0", "1.0", &fx.sha());
    let sig = sign_index(&test_index_key(1), &index);
    let server = signed_server(index, Some(Route::Body(sig.into_bytes()))).await;
    let result = browse(
        &server.url("/index.json"),
        P,
        &trust_key1(true),
        &fx.manager,
        &HostFacts::current(),
    )
    .await
    .unwrap();
    assert_eq!(result.signature, IndexSignatureStatus::Verified);
    assert_eq!(result.entries.len(), 1);
}

#[tokio::test]
async fn default_index_rejects_tampered_wrong_key_and_missing_signatures() {
    let fx = Fixture::new("1.0.0");
    let host = HostFacts::current();
    let index = index_with("1.0.0", "1.0", &fx.sha());
    // The served index differs from the signed one by a single byte.
    let mut tampered = index.clone();
    tampered.push(b' ');
    let cases: [(Vec<u8>, Option<Route>, &str); 4] = [
        (
            tampered,
            Some(Route::Body(
                sign_index(&test_index_key(1), &index).into_bytes(),
            )),
            "does not verify",
        ),
        (
            index.clone(),
            Some(Route::Body(
                sign_index(&test_index_key(2), &index).into_bytes(),
            )),
            "does not verify",
        ),
        (index.clone(), None, "signature"),
        (
            index.clone(),
            Some(Route::Body(b"<html>not found</html>".to_vec())),
            "malformed",
        ),
    ];
    for (served, sig, needle) in cases {
        let server = signed_server(served, sig).await;
        let url = server.url("/index.json");
        let err = browse(&url, P, &trust_key1(true), &fx.manager, &host)
            .await
            .unwrap_err();
        assert!(err.contains(needle), "{needle}: {err}");
        // A download re-verifies the index and refuses before fetching anything.
        let err = download_index_entry(
            &url,
            "demo",
            P,
            &trust_key1(true),
            &fx.dir(),
            &fx.manager,
            &host,
        )
        .await
        .unwrap_err();
        assert!(err.contains(needle), "{needle}: {err}");
        assert!(!fx.dir().exists(), "nothing may be written");
    }
}

#[tokio::test]
async fn oversized_signature_is_refused() {
    let fx = Fixture::new("1.0.0");
    let index = index_with("1.0.0", "1.0", &fx.sha());
    let server = signed_server(
        index,
        Some(Route::UnsizedBody(vec![
            b'A';
            MAX_INDEX_SIGNATURE_BYTES + 1
        ])),
    )
    .await;
    let err = browse(
        &server.url("/index.json"),
        P,
        &trust_key1(true),
        &fx.manager,
        &HostFacts::current(),
    )
    .await
    .unwrap_err();
    assert!(err.contains("limit"), "{err}");
}

#[tokio::test]
async fn custom_index_may_be_unsigned_but_never_badly_signed() {
    let fx = Fixture::new("1.0.0");
    let host = HostFacts::current();
    let index = index_with("1.0.0", "1.0", &fx.sha());

    // Missing signature: loads, marked unsigned (the UI shows a notice).
    let server = signed_server(index.clone(), None).await;
    let result = browse(
        &server.url("/index.json"),
        P,
        &trust_key1(false),
        &fx.manager,
        &host,
    )
    .await
    .unwrap();
    assert_eq!(result.signature, IndexSignatureStatus::Unsigned);
    assert_eq!(result.entries.len(), 1);

    // Signed by the termiHub key: verified, even though optional.
    let sig = sign_index(&test_index_key(1), &index);
    let server = signed_server(index.clone(), Some(Route::Body(sig.into_bytes()))).await;
    let result = browse(
        &server.url("/index.json"),
        P,
        &trust_key1(false),
        &fx.manager,
        &host,
    )
    .await
    .unwrap();
    assert_eq!(result.signature, IndexSignatureStatus::Verified);

    // A signature that is present but foreign is refused, not downgraded.
    let foreign = sign_index(&test_index_key(2), &index);
    let server = signed_server(index, Some(Route::Body(foreign.into_bytes()))).await;
    let err = browse(
        &server.url("/index.json"),
        P,
        &trust_key1(false),
        &fx.manager,
        &host,
    )
    .await
    .unwrap_err();
    assert!(err.contains("does not verify"), "{err}");
}

#[tokio::test]
async fn placeholder_key_loads_the_index_without_checking() {
    let fx = Fixture::new("1.0.0");
    let index = index_with("1.0.0", "1.0", &fx.sha());
    // Even a garbage signature does not matter: it is never fetched.
    let server = signed_server(index, Some(Route::Body(b"garbage".to_vec()))).await;
    let result = browse(
        &server.url("/index.json"),
        P,
        &no_key(),
        &fx.manager,
        &HostFacts::current(),
    )
    .await
    .unwrap();
    assert_eq!(result.signature, IndexSignatureStatus::NotConfigured);
}
