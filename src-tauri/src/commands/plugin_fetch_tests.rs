//! Tests for the plugin fetch helpers against a local fixture server.

use super::*;
use crate::commands::test_http_server::{Route, TestServer};

const T: Duration = Duration::from_secs(10);

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

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

#[test]
fn strict_policy_accepts_only_https() {
    assert!(FetchPolicy::STRICT
        .check_url("https://example.com/i.json")
        .is_ok());
    for bad in [
        "http://127.0.0.1:9/i.json",
        "file:///etc/passwd",
        "ftp://x/y",
        "https://user:pw@example.com/",
    ] {
        assert!(FetchPolicy::STRICT.check_url(bad).is_err(), "{bad}");
    }
    assert!(FetchPolicy::TEST_ALLOW_HTTP
        .check_url("http://127.0.0.1:9/x")
        .is_ok());
    assert!(FetchPolicy::TEST_ALLOW_HTTP
        .check_url("file:///etc/passwd")
        .is_err());
}

#[tokio::test]
async fn strict_fetch_refuses_plain_http_before_any_request() {
    let server = TestServer::start(vec![("/i.json", Route::Body(b"{}".to_vec()))]).await;
    let err = fetch_capped(&server.url("/i.json"), 1024, T, FetchPolicy::STRICT, "t")
        .await
        .unwrap_err();
    assert!(err.contains("https"), "{err}");
}

#[tokio::test]
async fn fetch_returns_the_body_and_enforces_the_cap() {
    let server = TestServer::start(vec![
        ("/ok", Route::Body(b"hello".to_vec())),
        ("/big", Route::Body(vec![b'x'; 100])),
        ("/big-unsized", Route::UnsizedBody(vec![b'x'; 100])),
        ("/gone", Route::Status(500)),
    ])
    .await;
    let p = FetchPolicy::TEST_ALLOW_HTTP;
    assert_eq!(
        fetch_capped(&server.url("/ok"), 64, T, p, "t")
            .await
            .unwrap(),
        b"hello"
    );
    for path in ["/big", "/big-unsized"] {
        let err = fetch_capped(&server.url(path), 64, T, p, "t")
            .await
            .unwrap_err();
        assert!(err.contains("64-byte limit"), "{path}: {err}");
    }
    let err = fetch_capped(&server.url("/gone"), 64, T, p, "t")
        .await
        .unwrap_err();
    assert!(err.contains("500"), "{err}");
}

#[tokio::test]
async fn redirect_to_plain_http_is_refused_even_in_test_policy() {
    let server = TestServer::start(vec![("/final", Route::Body(b"x".to_vec()))]).await;
    let target = server.url("/final");
    let redirecting = TestServer::start(vec![("/start", Route::Redirect(target))]).await;
    let err = fetch_capped(
        &redirecting.url("/start"),
        64,
        T,
        FetchPolicy::TEST_ALLOW_HTTP,
        "t",
    )
    .await
    .unwrap_err();
    assert!(err.contains("non-HTTPS"), "{err}");
}

#[tokio::test]
async fn download_verified_stores_only_a_matching_file() {
    let body = b"package bytes".to_vec();
    let server = TestServer::start(vec![("/p", Route::Body(body.clone()))]).await;
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = tmp.path().join("downloads");
    let p = FetchPolicy::TEST_ALLOW_HTTP;

    let path = download_verified(&server.url("/p"), &sha(&body), 1024, T, p, &dir, "p.pkg")
        .await
        .unwrap();
    assert_eq!(path, dir.join("p.pkg"));
    assert_eq!(std::fs::read(&path).unwrap(), body);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    // Checksum mismatch: nothing stored, no temp file left behind.
    let err = download_verified(&server.url("/p"), &sha(b"other"), 1024, T, p, &dir, "q.pkg")
        .await
        .unwrap_err();
    assert!(err.contains("SHA-256"), "{err}");
    let names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, vec!["p.pkg".to_string()]);
}

#[tokio::test]
async fn download_verified_refuses_oversize_bodies() {
    let body = vec![b'x'; 200];
    let server = TestServer::start(vec![
        ("/sized", Route::Body(body.clone())),
        ("/unsized", Route::UnsizedBody(body.clone())),
    ])
    .await;
    let tmp = tempfile::TempDir::new().unwrap();
    for path in ["/sized", "/unsized"] {
        let err = download_verified(
            &server.url(path),
            &sha(&body),
            100,
            T,
            FetchPolicy::TEST_ALLOW_HTTP,
            tmp.path(),
            "x.pkg",
        )
        .await
        .unwrap_err();
        assert!(err.contains("100-byte limit"), "{path}: {err}");
    }
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn download_verified_rejects_unsafe_file_names() {
    let tmp = tempfile::TempDir::new().unwrap();
    for name in ["", "../x", "a/b", "a\\b", ".hidden"] {
        let err = download_verified(
            "https://example.com/p",
            &"0".repeat(64),
            10,
            T,
            FetchPolicy::STRICT,
            tmp.path(),
            name,
        )
        .await
        .unwrap_err();
        assert!(err.contains("unsafe"), "{name}: {err}");
    }
}

#[test]
fn sanitize_file_component_keeps_one_safe_segment() {
    assert_eq!(
        sanitize_file_component("1.1.0+build/../x"),
        "1.1.0-build-..-x"
    );
    assert_eq!(sanitize_file_component("my-plugin"), "my-plugin");
}
