#![cfg(feature = "ssh")]
//! SFTP Stress Integration Tests (SFTP-STRESS-01 through SFTP-STRESS-16).
//!
//! Tests termiHub's SFTP file browser against the pre-populated
//! `sftp-stress` container with large files, deep trees, symlinks,
//! special filenames, and permission edge cases.
//!
//! Container: `sftp-stress` on port 2210 (Docker Compose `stress` profile).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml --profile stress up -d`
//! Skips gracefully if containers are not running.
//!
//! **IMPORTANT**: All of these tests share the single `sftp-stress` container
//! and its one pre-populated filesystem — the upload round-trip mutates a file
//! under the shared test root, and the directory-listing assertions
//! (SFTP-STRESS-05/08/14) are sensitive to concurrent activity on that same
//! remote state. Run in parallel against the one container they flake, and pass
//! cleanly with `--test-threads=1`. Because 15 of the 16 tests read fixed
//! fixture paths, per-test subdirectory isolation is not practical, so the suite
//! is serialized in-source with `#[serial(sftp_stress)]` (mirroring
//! `network_resilience.rs`), which keeps it parallel-safe regardless of
//! `--test-threads`.

mod common;

use common::{port_sftp_stress, require_docker};
use serial_test::serial;
use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser, Ssh};
use termihub_core::config::SshConfig;
use termihub_core::connection::ConnectionType;

/// Connect to the SFTP stress container and return an Ssh instance
/// with file browser enabled.
async fn connect_sftp() -> Ssh {
    let mut ssh = Ssh::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port_sftp_stress(),
        "username": "testuser",
        "authMethod": "password",
        "password": "testpass",
        "enableFileBrowser": true
    });
    ssh.connect(settings)
        .await
        .expect("SFTP stress container connection should succeed");
    ssh
}

// ── SFTP-STRESS-01: Download 1 MB file ──────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_01_download_1mb() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let data = browser
        .read_file("/home/testuser/sftp-test/large-files/1mb.bin")
        .await
        .expect("SFTP-STRESS-01: 1MB download should succeed");

    assert_eq!(
        data.len(),
        1_048_576,
        "SFTP-STRESS-01: File should be exactly 1 MB, got {} bytes",
        data.len()
    );
}

// ── SFTP-STRESS-02: Download 10 MB file ─────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_02_download_10mb() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let data = browser
        .read_file("/home/testuser/sftp-test/large-files/10mb.bin")
        .await
        .expect("SFTP-STRESS-02: 10MB download should succeed");

    assert_eq!(
        data.len(),
        10_485_760,
        "SFTP-STRESS-02: File should be exactly 10 MB, got {} bytes",
        data.len()
    );
}

// ── SFTP-STRESS-03: Download 100 MB file ────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_03_download_100mb() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let data = browser
        .read_file("/home/testuser/sftp-test/large-files/100mb.bin")
        .await
        .expect("SFTP-STRESS-03: 100MB download should succeed");

    assert_eq!(
        data.len(),
        104_857_600,
        "SFTP-STRESS-03: File should be exactly 100 MB, got {} bytes",
        data.len()
    );
}

// ── SFTP-STRESS-04: Upload and verify round-trip ────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_04_upload_roundtrip() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    // Create test data (1 MB of random-ish bytes).
    let test_data: Vec<u8> = (0..1_048_576u32).map(|i| (i % 256) as u8).collect();

    let upload_path = "/home/testuser/sftp-test/upload-test.bin";

    // Upload.
    browser
        .write_file(upload_path, &test_data)
        .await
        .expect("SFTP-STRESS-04: Upload should succeed");

    // Download and verify.
    let downloaded = browser
        .read_file(upload_path)
        .await
        .expect("SFTP-STRESS-04: Download after upload should succeed");

    assert_eq!(
        downloaded.len(),
        test_data.len(),
        "SFTP-STRESS-04: Downloaded size should match uploaded size"
    );
    assert_eq!(
        downloaded, test_data,
        "SFTP-STRESS-04: Downloaded content should match uploaded content"
    );

    // Clean up.
    let _ = browser.delete(upload_path).await;
}

// ── SFTP-STRESS-05: List 1000-entry directory ───────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_05_list_wide_directory() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let entries = browser
        .list_dir("/home/testuser/sftp-test/wide-dir")
        .await
        .expect("SFTP-STRESS-05: Wide directory listing should succeed");

    assert_eq!(
        entries.len(),
        1000,
        "SFTP-STRESS-05: Should list all 1000 entries, got {}",
        entries.len()
    );
}

// ── SFTP-STRESS-06: Navigate 50-level deep tree ─────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_06_deep_tree() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    // Build the path to depth 50.
    let mut deep_path = "/home/testuser/sftp-test/deep-tree".to_string();
    for i in 1..=50 {
        deep_path.push_str(&format!("/level-{i}"));
    }
    deep_path.push_str("/file.txt");

    let data = browser
        .read_file(&deep_path)
        .await
        .expect("SFTP-STRESS-06: Reading file at depth 50 should succeed");

    let text = String::from_utf8_lossy(&data);
    assert!(
        !text.is_empty(),
        "SFTP-STRESS-06: File at depth 50 should have content"
    );
}

// ── SFTP-STRESS-07: Follow valid file symlink ───────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_07_valid_file_symlink() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let data = browser
        .read_file("/home/testuser/sftp-test/symlinks/valid-file-link")
        .await
        .expect("SFTP-STRESS-07: Reading through valid file symlink should succeed");

    assert!(
        !data.is_empty(),
        "SFTP-STRESS-07: Symlink target should have content"
    );
}

// ── SFTP-STRESS-08: Follow valid directory symlink ──────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_08_valid_dir_symlink() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let entries = browser
        .list_dir("/home/testuser/sftp-test/symlinks/valid-dir-link")
        .await
        .expect("SFTP-STRESS-08: Listing through valid dir symlink should succeed");

    assert!(
        !entries.is_empty(),
        "SFTP-STRESS-08: Symlinked directory should have entries"
    );
}

// ── SFTP-STRESS-09: Broken symlink ──────────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_09_broken_symlink() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let result = browser
        .read_file("/home/testuser/sftp-test/symlinks/broken-link")
        .await;

    assert!(
        result.is_err(),
        "SFTP-STRESS-09: Broken symlink should return an error, not panic"
    );
}

// ── SFTP-STRESS-10: Circular symlinks ───────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_10_circular_symlinks() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    // Attempting to read a circular symlink should fail gracefully.
    let result = browser
        .read_file("/home/testuser/sftp-test/symlinks/circular-a")
        .await;

    assert!(
        result.is_err(),
        "SFTP-STRESS-10: Circular symlink should return an error, not infinite loop"
    );
}

// ── SFTP-STRESS-11: Unicode filename ────────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_11_unicode_filename() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let data = browser
        .read_file("/home/testuser/sftp-test/special-names/\u{1F600}_emoji.txt")
        .await
        .expect("SFTP-STRESS-11: Unicode filename should be readable");

    assert!(
        !data.is_empty(),
        "SFTP-STRESS-11: Unicode-named file should have content"
    );
}

// ── SFTP-STRESS-12: Filename with spaces ────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_12_filename_with_spaces() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let data = browser
        .read_file("/home/testuser/sftp-test/special-names/file with spaces.txt")
        .await
        .expect("SFTP-STRESS-12: Filename with spaces should be readable");

    assert!(
        !data.is_empty(),
        "SFTP-STRESS-12: Spaced filename should have content"
    );
}

// ── SFTP-STRESS-13: 200-char filename ───────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_13_long_filename() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    // The generate-test-data.sh creates a 200-char filename.
    let long_name = "a".repeat(200);
    let path = format!("/home/testuser/sftp-test/special-names/{long_name}.txt");

    let data = browser
        .read_file(&path)
        .await
        .expect("SFTP-STRESS-13: 200-char filename should be readable");

    assert!(
        !data.is_empty(),
        "SFTP-STRESS-13: Long-named file should have content"
    );
}

// ── SFTP-STRESS-14: Hidden files (.dotfiles) ────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_14_hidden_dotfiles() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let entries = browser
        .list_dir("/home/testuser/sftp-test/special-names")
        .await
        .expect("SFTP-STRESS-14: Directory listing should succeed");

    // Check that hidden files are visible in the listing.
    let has_dotfile = entries.iter().any(|e| e.name.starts_with('.'));
    assert!(
        has_dotfile,
        "SFTP-STRESS-14: Directory listing should include hidden (.dotfile) entries"
    );
}

// ── SFTP-STRESS-15: Permission 000 file ─────────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_15_permission_000_file() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let result = browser
        .read_file("/home/testuser/sftp-test/permissions/no-access.txt")
        .await;

    assert!(
        result.is_err(),
        "SFTP-STRESS-15: Permission 000 file should return access denied error"
    );
}

// ── SFTP-STRESS-16: Permission 000 directory ────────────────────────

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_16_permission_000_directory() {
    require_docker!(port_sftp_stress());

    let ssh = connect_sftp().await;
    let browser = ssh
        .file_browser()
        .expect("File browser should be available");

    let result = browser
        .list_dir("/home/testuser/sftp-test/permissions/no-access-dir")
        .await;

    assert!(
        result.is_err(),
        "SFTP-STRESS-16: Permission 000 directory should return access denied error"
    );
}

// ── SFTP-STRESS-17: session-path advanced-ops parity (#2312) ─────────
//
// The #2307 step-A convergence lets a session-scoped `&dyn FileBrowser` reach the
// SFTP advanced ops via the new `FileBrowser::as_any` downcast bridge. This test
// proves that bridge end-to-end AND that the results match the standalone
// `sftp_*` path (a directly-constructed `SftpFileBrowser`), so the session path
// is a faithful mirror rather than a divergent second implementation.

/// Build the standalone-path browser for the stress container (mirrors how the
/// desktop `SftpManager::open_session` constructs one from an `SshConfig`).
fn standalone_browser() -> SftpFileBrowser {
    SftpFileBrowser::new(SshConfig {
        host: "127.0.0.1".to_string(),
        port: port_sftp_stress(),
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..Default::default()
    })
}

#[tokio::test]
#[serial(sftp_stress)]
async fn sftp_stress_17_session_path_advanced_ops_parity() {
    require_docker!(port_sftp_stress());

    // Session/ConnectionType path: reach the advanced ops through the `&dyn
    // FileBrowser` the session holds, via the new `as_any` downcast (#2312).
    let ssh = connect_sftp().await;
    let dynamic = ssh
        .file_browser()
        .expect("file browser should be available");
    let via_session = dynamic
        .as_any()
        .and_then(|any| any.downcast_ref::<SftpFileBrowser>())
        .expect("SSH session's FileBrowser must downcast to SftpFileBrowser (#2312)");

    // Standalone `sftp_*` path.
    let standalone = standalone_browser();

    // realpath(".") → home dir; both paths must agree and yield an absolute path.
    let session_home = via_session
        .realpath(".")
        .await
        .expect("session realpath should succeed");
    let standalone_home = standalone
        .realpath(".")
        .await
        .expect("standalone realpath should succeed");
    assert_eq!(
        session_home, standalone_home,
        "session-path realpath must match the standalone path"
    );
    assert!(
        session_home.starts_with('/'),
        "realpath must be absolute, got {session_home:?}"
    );

    // check_writable on a known fixture file → both paths must return the same
    // verdict (the probe is non-destructive: WRITE-open only, no truncate).
    let probe_path = "/home/testuser/sftp-test/large-files/1mb.bin";
    let session_verdict = via_session
        .check_writable(probe_path)
        .await
        .expect("session check_writable should succeed");
    let standalone_verdict = standalone
        .check_writable(probe_path)
        .await
        .expect("standalone check_writable should succeed");
    assert_eq!(
        session_verdict, standalone_verdict,
        "session-path writability verdict must match the standalone path"
    );

    // has_exec_capability (inherent, reached through the same downcast): a normal
    // SSH+shell container exposes an exec channel on both paths.
    let session_exec = via_session
        .has_exec_capability()
        .await
        .expect("session has_exec_capability should succeed");
    let standalone_exec = standalone
        .has_exec_capability()
        .await
        .expect("standalone has_exec_capability should succeed");
    assert_eq!(
        session_exec, standalone_exec,
        "session-path exec-capability must match the standalone path"
    );
    assert!(
        session_exec,
        "the sftp-stress container is a normal SSH host, so exec must be available"
    );
}
