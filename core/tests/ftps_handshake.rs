#![cfg(feature = "ftp-test-support")]
//! FTPS handshake integration tests against the FTP fixture (#1333, #4006).
//!
//! The fixture (`tests/docker/ftp-server/`) serves explicit FTPS (`AUTH TLS` on
//! :21, host port **2401**) and implicit FTPS (TLS from the first byte on :990,
//! host port **2402**) with a leaf for `127.0.0.1` signed by a committed test
//! CA (`tests/docker/ftp-server/certs/`).
//!
//! The shipping client trusts only the Mozilla root store, so these tests
//! register the fixture CA through the test-only `ftp-test-support` hook
//! ([`trust_test_root_pem`]). That hook only *adds* a root: the chain, the
//! `127.0.0.1` name and the validity period are still verified exactly as in
//! production — FTPS-03 proves an unrelated CA is still refused.
//!
//! ## Running
//!
//! ```bash
//! docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server
//! cargo test -p termihub-core --features ftp-test-support --test ftps_handshake
//! ```
//!
//! Skips cleanly without the fixture (hard-fails under `TERMIHUB_REQUIRE_DOCKER=1`).

mod common;

use std::path::PathBuf;

use common::{port_ftp, port_ftps_implicit, require_docker};

use termihub_core::backends::ftp::test_support::trust_test_root_pem;
use termihub_core::backends::ftp::Ftp;
use termihub_core::connection::ConnectionType;

/// The committed fixture CA (`tests/docker/ftp-server/certs/ca.crt`).
fn fixture_ca_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate is in the workspace root")
        .join("tests/docker/ftp-server/certs/ca.crt")
}

/// Trust the fixture CA for this process (idempotent).
fn trust_fixture_ca() {
    let pem = std::fs::read(fixture_ca_path()).expect("read the fixture CA");
    trust_test_root_pem(&pem).expect("register the fixture CA");
}

fn settings(port: u16, tls_mode: &str) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "tlsMode": tls_mode,
        "username": "ftpuser",
        "password": "ftppass",
    })
}

/// Connect, list `/pub` over the TLS data channel, read a known file, and
/// disconnect.
async fn handshake_list_and_read(port: u16, tls_mode: &str) {
    let mut ftp = Ftp::new();
    ftp.connect(settings(port, tls_mode))
        .await
        .unwrap_or_else(|e| panic!("{tls_mode} FTPS connect failed: {e}"));
    let browser = ftp.file_browser().expect("FTP exposes a file browser");

    let names: Vec<String> = browser
        .list_dir("/pub")
        .await
        .unwrap_or_else(|e| panic!("{tls_mode} FTPS list /pub failed: {e}"))
        .into_iter()
        .map(|e| e.name)
        .collect();
    for expected in ["docs", "images", "data", "readme.txt", "welcome.txt"] {
        assert!(
            names.iter().any(|n| n == expected),
            "{tls_mode}: {expected} missing from /pub: {names:?}"
        );
    }

    let readme = browser
        .read_file("/pub/readme.txt")
        .await
        .unwrap_or_else(|e| panic!("{tls_mode} FTPS read failed: {e}"));
    assert_eq!(
        readme, b"termiHub FTP test server. See pub/docs for more information.\n",
        "{tls_mode}: readme.txt over the TLS data channel"
    );

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── FTPS-01: explicit FTPS (AUTH TLS on :21) ─────────────────────────────────

#[tokio::test]
async fn ftps_01_explicit_handshake_list_and_read() {
    require_docker!(port_ftp());
    trust_fixture_ca();
    handshake_list_and_read(port_ftp(), "explicit").await;
}

// ── FTPS-02: implicit FTPS (TLS from the first byte on :990) ─────────────────

#[tokio::test]
async fn ftps_02_implicit_handshake_list_and_read() {
    require_docker!(port_ftps_implicit());
    trust_fixture_ca();
    handshake_list_and_read(port_ftps_implicit(), "implicit").await;
}

// ── FTPS-03: the fixture leaf is refused when its CA is not trusted ─────────
//
// Runs in its own process (no `trust_fixture_ca`): integration test binaries
// share one process, so this test re-executes itself as a child with only the
// filter for its inner half, where no root was ever registered.

#[tokio::test]
async fn ftps_03_untrusted_fixture_cert_is_refused() {
    require_docker!(port_ftp());
    if std::env::var_os("TERMIHUB_FTPS_UNTRUSTED_CHILD").is_some() {
        let mut ftp = Ftp::new();
        let result = ftp.connect(settings(port_ftp(), "explicit")).await;
        assert!(
            result.is_err(),
            "explicit FTPS must refuse the fixture cert without its CA"
        );
        return;
    }
    let exe = std::env::current_exe().expect("test binary path");
    let status = std::process::Command::new(exe)
        .args([
            "--exact",
            "ftps_03_untrusted_fixture_cert_is_refused",
            "--test-threads=1",
        ])
        .env("TERMIHUB_FTPS_UNTRUSTED_CHILD", "1")
        .status()
        .expect("spawn the untrusted-CA child");
    assert!(status.success(), "the untrusted-CA child run failed");
}
