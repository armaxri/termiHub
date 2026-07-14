#![cfg(feature = "ftp")]
//! FTP auto-reconnect integration tests (issue #1339).
//!
//! Exercises the [`FtpFileBrowser`] auto-reconnect path against the live FTP
//! Docker fixture (`tests/docker/ftp-server/`): a browsing operation succeeds,
//! the underlying control socket is forcibly dropped mid-session (simulating an
//! idle-timeout / NAT eviction / transient fault), and the next operation must
//! transparently re-establish the connection and return correct results.
//!
//! ## Fixture
//!
//! Container `ftp-server` (vsftpd), plain FTP on host port **2401** → container
//! `:21`. Login `ftpuser` / `ftppass` (read everything, write into `/uploads`).
//!
//! ## Running
//!
//! ```bash
//! docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server
//! cargo test -p termihub-core --features ftp --test ftp_reconnect -- --nocapture
//! docker compose -f tests/docker/docker-compose.yml --profile ftp down -v
//! ```
//!
//! Without the fixture up, every test **skips cleanly** via `require_docker!`
//! (a runtime port-reachability check), so a plain `cargo test` never fails
//! here. Auto-reconnect *policy* (retry count, backoff, error classification,
//! EPSV→PASV selection) is covered by fast unit tests in
//! `core/src/backends/ftp/reconnect.rs` and `.../mod.rs`; this file verifies the
//! end-to-end recovery against a real server.

mod common;

use common::{port_ftp, require_docker};

use termihub_core::backends::ftp::Ftp;
use termihub_core::connection::ConnectionType;
use termihub_core::files::FileBrowser;

/// Settings JSON for the `ftpuser` account.
fn ftpuser_settings() -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port_ftp(),
        "tlsMode": "none",
        "username": "ftpuser",
        "password": "ftppass",
        // Keep-alive is irrelevant to these tests (they force the drop directly);
        // disable it so no background NOOP interferes with the poisoned socket.
        "keepAliveSecs": 0,
    })
}

/// Connect an [`Ftp`] session with the ftpuser account.
async fn connect() -> Ftp {
    let mut ftp = Ftp::new();
    ftp.connect(ftpuser_settings())
        .await
        .expect("FTP connect failed");
    assert!(ftp.is_connected(), "FTP should report connected");
    ftp
}

/// List `/pub` and return the sorted entry names.
async fn list_pub_names(browser: &dyn FileBrowser) -> Vec<String> {
    let mut names: Vec<String> = browser
        .list_dir("/pub")
        .await
        .expect("list_dir(/pub) failed")
        .into_iter()
        .map(|e| e.name)
        .collect();
    names.sort();
    names
}

// ── RECONNECT-01: a listing recovers after a mid-session control drop ─────────

#[tokio::test]
async fn ftp_reconnect_01_recovers_after_control_drop() {
    require_docker!(port_ftp());

    let mut ftp = connect().await;

    // Baseline listing establishes the browsing control connection.
    let before = {
        let browser = ftp.file_browser().expect("FTP exposes a file browser");
        list_pub_names(browser).await
    };
    assert!(!before.is_empty(), "baseline /pub listing is non-empty");

    // Forcibly drop the live control socket, simulating an idle-timeout / fault.
    assert!(
        ftp.debug_drop_browsing_connection().await,
        "a live browsing connection should have been dropped"
    );

    // The next listing must transparently reconnect and return the same tree.
    let after = {
        let browser = ftp.file_browser().expect("FTP exposes a file browser");
        list_pub_names(browser).await
    };
    assert_eq!(
        before, after,
        "listing after auto-reconnect matches the pre-drop listing"
    );

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── RECONNECT-02: repeated drops each recover (retry budget re-arms) ──────────

#[tokio::test]
async fn ftp_reconnect_02_survives_repeated_drops() {
    require_docker!(port_ftp());

    let mut ftp = connect().await;
    let expected = {
        let browser = ftp.file_browser().expect("FTP exposes a file browser");
        list_pub_names(browser).await
    };

    // Drop-then-list several times; each cycle must recover independently.
    for cycle in 0..3 {
        assert!(
            ftp.debug_drop_browsing_connection().await,
            "cycle {cycle}: expected a live connection to drop"
        );
        let names = {
            let browser = ftp.file_browser().expect("FTP exposes a file browser");
            list_pub_names(browser).await
        };
        assert_eq!(names, expected, "cycle {cycle}: listing recovered");
    }

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── RECONNECT-03: a read (RETR) recovers after a control drop ─────────────────

#[tokio::test]
async fn ftp_reconnect_03_read_recovers_after_drop() {
    require_docker!(port_ftp());

    let mut ftp = connect().await;

    // Prime the connection, then drop it.
    {
        let browser = ftp.file_browser().expect("FTP exposes a file browser");
        let _ = list_pub_names(browser).await;
    }
    assert!(ftp.debug_drop_browsing_connection().await);

    // A RETR after the drop must reconnect and return exact bytes.
    let browser = ftp.file_browser().expect("FTP exposes a file browser");
    let readme = browser
        .read_file("/pub/readme.txt")
        .await
        .expect("read readme.txt after reconnect");
    assert_eq!(
        readme, b"termiHub FTP test server. See pub/docs for more information.\n",
        "readme.txt content after reconnect"
    );

    ftp.disconnect().await.expect("disconnect should succeed");
}
