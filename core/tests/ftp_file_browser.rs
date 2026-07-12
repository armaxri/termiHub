#![cfg(feature = "ftp")]
//! FTP file-browser integration tests (issue #1456).
//!
//! Exercises the live [`FtpFileBrowser`] CRUD surface against the seeded FTP
//! Docker fixture (`tests/docker/ftp-server/`, issue #1333): directory listing
//! of the known tree, `read`/`write` (RETR/STOR) round-trips, and the full
//! `mkdir` → `rename` → `list` → `delete` cycle exercising both `DELE` (file)
//! and `RMD` (directory).
//!
//! ## Fixture
//!
//! Container `ftp-server` (ProFTPD), plain FTP on host port **2401** → container
//! `:21`. Logins (see `tests/docker/README.md`):
//!   * `anonymous` — read-only browse of the whole tree
//!   * `ftpuser` / `ftppass` — read everything, write into `/uploads`
//!
//! The deterministic `/pub` tree (fixed sizes + fixed content) is asserted
//! below; keep these constants in sync with
//! `tests/docker/ftp-server/generate-test-data.sh`.
//!
//! ## Running
//!
//! ```bash
//! # Bring the fixture up (waits for the port-21 healthcheck):
//! docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server
//!
//! # Run the suite (the `ftp` feature gates the whole file):
//! cargo test -p termihub-core --features ftp --test ftp_file_browser -- --nocapture
//!
//! # Tear down when done:
//! docker compose -f tests/docker/docker-compose.yml --profile ftp down -v
//! ```
//!
//! Without the fixture up, every test **skips cleanly** via `require_docker!`
//! (a runtime port-reachability check), so a plain `cargo test` never fails
//! here.
//!
//! ## Coverage notes
//!
//! * **MLSD** is exercised live: ProFTPD advertises `MLSD`, so `list_dir`
//!   takes the machine-readable path. The `LIST` (`ls -l`) fallback parser is
//!   covered by the unit tests in `core/src/backends/ftp/listing_parser.rs`;
//!   the fixture offers no clean way to disable `MLSD` per-connection to force
//!   the fallback at runtime.
//! * **FTPS** (explicit/implicit) is intentionally not covered here: the
//!   fixture presents a self-signed certificate, and the backend validates
//!   against the Mozilla root store with no insecure/skip-verify option, so an
//!   FTPS handshake against the fixture cert cannot succeed. Tracked as a
//!   follow-up (needs a trusted fixture cert or a backend trust-override).

mod common;

use common::{port_ftp, require_docker};

use termihub_core::backends::ftp::Ftp;
use termihub_core::connection::ConnectionType;
use termihub_core::files::{FileBrowser, FileEntry};

// ── Known seeded `/pub` tree (must match generate-test-data.sh) ─────────────

/// Top-level `/pub` entries: `(name, is_directory, size)`. Directory sizes are
/// server-dependent and therefore not asserted (checked via `is_directory`).
const PUB_TOP: &[(&str, bool, u64)] = &[
    ("docs", true, 0),
    ("images", true, 0),
    ("data", true, 0),
    ("readme.txt", false, 61),
    ("welcome.txt", false, 65),
];

/// `/pub/docs` files with fixed sizes.
const PUB_DOCS: &[(&str, u64)] = &[
    ("guide.txt", 52),
    ("manual.txt", 54),
    ("changelog.txt", 44),
    ("faq.txt", 51),
];

/// `/pub/images` binary files with fixed sizes.
const PUB_IMAGES: &[(&str, u64)] = &[("logo.bin", 2048), ("banner.bin", 4096)];

/// `/pub/data` binary files spanning empty..1 MiB with fixed sizes.
const PUB_DATA: &[(&str, u64)] = &[
    ("dataset-1k.bin", 1024),
    ("dataset-8k.bin", 8192),
    ("dataset-64k.bin", 65536),
    ("dataset-1m.bin", 1048576),
    ("empty.bin", 0),
    ("single-byte.bin", 1),
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Settings JSON for the `ftpuser` account (read everything, write `/uploads`).
fn ftpuser_settings() -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port_ftp(),
        "tlsMode": "none",
        "username": "ftpuser",
        "password": "ftppass",
    })
}

/// Settings JSON for the read-only anonymous account.
fn anonymous_settings() -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port_ftp(),
        "tlsMode": "none",
        "anonymous": true,
    })
}

/// Connect an [`Ftp`] session with the given settings.
async fn connect(settings: serde_json::Value) -> Ftp {
    let mut ftp = Ftp::new();
    ftp.connect(settings).await.expect("FTP connect failed");
    assert!(ftp.is_connected(), "FTP should report connected");
    ftp
}

/// List `path` and index the entries by name for easy assertions.
async fn list_by_name(
    browser: &dyn FileBrowser,
    path: &str,
) -> std::collections::HashMap<String, FileEntry> {
    browser
        .list_dir(path)
        .await
        .unwrap_or_else(|e| panic!("list_dir({path}) failed: {e}"))
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect()
}

/// Assert a named entry exists with the expected directory flag, size (files
/// only) and joined path.
fn assert_entry(
    entries: &std::collections::HashMap<String, FileEntry>,
    dir: &str,
    name: &str,
    is_dir: bool,
    size: u64,
) {
    let entry = entries
        .get(name)
        .unwrap_or_else(|| panic!("entry {name:?} missing from listing of {dir:?}"));
    assert_eq!(entry.is_directory, is_dir, "is_directory for {name}");
    assert_eq!(entry.path, format!("{dir}/{name}"), "path for {name}");
    if !is_dir {
        assert_eq!(entry.size, size, "size for {name}");
    }
}

// ── FTP-01: list the seeded tree (names, is_directory, sizes) ────────────────

#[tokio::test]
async fn ftp_01_list_seeded_tree() {
    require_docker!(port_ftp());

    let mut ftp = connect(ftpuser_settings()).await;
    let browser = ftp.file_browser().expect("FTP exposes a file browser");

    // Top level of /pub: 2 files + 3 directories.
    let top = list_by_name(browser, "/pub").await;
    assert_eq!(top.len(), PUB_TOP.len(), "unexpected /pub entry count");
    for &(name, is_dir, size) in PUB_TOP {
        assert_entry(&top, "/pub", name, is_dir, size);
    }

    // /pub/docs — four fixed-size text files.
    let docs = list_by_name(browser, "/pub/docs").await;
    assert_eq!(docs.len(), PUB_DOCS.len(), "unexpected /pub/docs count");
    for &(name, size) in PUB_DOCS {
        assert_entry(&docs, "/pub/docs", name, false, size);
    }

    // /pub/images — two fixed-size binaries.
    let images = list_by_name(browser, "/pub/images").await;
    assert_eq!(
        images.len(),
        PUB_IMAGES.len(),
        "unexpected /pub/images count"
    );
    for &(name, size) in PUB_IMAGES {
        assert_entry(&images, "/pub/images", name, false, size);
    }

    // /pub/data — six binaries spanning empty..1 MiB.
    let data = list_by_name(browser, "/pub/data").await;
    assert_eq!(data.len(), PUB_DATA.len(), "unexpected /pub/data count");
    for &(name, size) in PUB_DATA {
        assert_entry(&data, "/pub/data", name, false, size);
    }

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── FTP-02: read seeded files (RETR) with exact bytes ────────────────────────

#[tokio::test]
async fn ftp_02_read_seeded_files() {
    require_docker!(port_ftp());

    let mut ftp = connect(ftpuser_settings()).await;
    let browser = ftp.file_browser().expect("FTP exposes a file browser");

    // Text file with fixed content.
    let readme = browser
        .read_file("/pub/readme.txt")
        .await
        .expect("read readme.txt");
    assert_eq!(
        readme, b"termiHub FTP test server. See pub/docs for more information.\n",
        "readme.txt content"
    );
    assert_eq!(readme.len(), 61, "readme.txt size");

    // Zero-filled binary of a known size.
    let data_1k = browser
        .read_file("/pub/data/dataset-1k.bin")
        .await
        .expect("read dataset-1k.bin");
    assert_eq!(data_1k.len(), 1024, "dataset-1k.bin size");
    assert!(
        data_1k.iter().all(|&b| b == 0),
        "dataset-1k.bin is zero-filled"
    );

    // Single-byte and empty edge cases.
    let single = browser
        .read_file("/pub/data/single-byte.bin")
        .await
        .expect("read single-byte.bin");
    assert_eq!(single, b"X", "single-byte.bin content");

    let empty = browser
        .read_file("/pub/data/empty.bin")
        .await
        .expect("read empty.bin");
    assert!(empty.is_empty(), "empty.bin should be zero bytes");

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── FTP-03: stat a seeded file and directory ─────────────────────────────────

#[tokio::test]
async fn ftp_03_stat() {
    require_docker!(port_ftp());

    let mut ftp = connect(ftpuser_settings()).await;
    let browser = ftp.file_browser().expect("FTP exposes a file browser");

    let file = browser.stat("/pub/readme.txt").await.expect("stat file");
    assert!(!file.is_directory, "readme.txt is a file");
    assert_eq!(file.size, 61, "readme.txt size via stat");
    assert_eq!(file.name, "readme.txt", "readme.txt name via stat");

    let dir = browser.stat("/pub/docs").await.expect("stat dir");
    assert!(dir.is_directory, "docs is a directory");
    assert_eq!(dir.name, "docs", "docs name via stat");

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── FTP-04: mkdir → write → rename → read → delete round-trip ─────────────────
//
// Writes land under /uploads (the only ftpuser-writable directory). Exercises
// MKD, STOR, RNFR/RNTO, RETR, DELE (file) and RMD (directory), verifying each
// step with a fresh listing.

#[tokio::test]
async fn ftp_04_crud_round_trip() {
    require_docker!(port_ftp());

    let mut ftp = connect(ftpuser_settings()).await;
    let browser = ftp.file_browser().expect("FTP exposes a file browser");

    // Unique per-process working dir so reruns / parallel runs never collide.
    let dir = format!("/uploads/th_it_{}", std::process::id());
    let file = format!("{dir}/hello.txt");
    let renamed = format!("{dir}/renamed.txt");
    let payload: &[u8] = b"round-trip payload\n";

    // Best-effort cleanup of any leftovers from a crashed prior run.
    let _ = browser.delete(&file).await;
    let _ = browser.delete(&renamed).await;
    let _ = browser.delete(&dir).await;

    // 1. mkdir (MKD).
    browser.mkdir(&dir).await.expect("mkdir new directory");
    let uploads = list_by_name(browser, "/uploads").await;
    let dir_name = format!("th_it_{}", std::process::id());
    assert_entry(&uploads, "/uploads", &dir_name, true, 0);

    // 2. write a file (STOR), then verify via listing.
    browser
        .write_file(&file, payload)
        .await
        .expect("write file");
    let after_write = list_by_name(browser, &dir).await;
    assert_eq!(
        after_write.len(),
        1,
        "new dir holds exactly the written file"
    );
    assert_entry(&after_write, &dir, "hello.txt", false, payload.len() as u64);

    // 3. read it back (RETR) — content must round-trip byte-for-byte.
    let read_back = browser.read_file(&file).await.expect("read written file");
    assert_eq!(read_back, payload, "written file round-trips");

    // 4. rename (RNFR/RNTO), then verify old gone / new present.
    browser.rename(&file, &renamed).await.expect("rename file");
    let after_rename = list_by_name(browser, &dir).await;
    assert!(!after_rename.contains_key("hello.txt"), "old name is gone");
    assert_entry(
        &after_rename,
        &dir,
        "renamed.txt",
        false,
        payload.len() as u64,
    );

    // 5. delete the file (DELE), verify the directory is now empty.
    browser.delete(&renamed).await.expect("delete file (DELE)");
    let after_delete_file = list_by_name(browser, &dir).await;
    assert!(
        after_delete_file.is_empty(),
        "directory empty after file delete"
    );

    // 6. delete the directory (RMD), verify it is gone from /uploads.
    browser.delete(&dir).await.expect("delete directory (RMD)");
    let after_delete_dir = list_by_name(browser, "/uploads").await;
    assert!(
        !after_delete_dir.contains_key(&dir_name),
        "directory removed from /uploads"
    );

    ftp.disconnect().await.expect("disconnect should succeed");
}

// ── FTP-05: anonymous login is read-only ─────────────────────────────────────

#[tokio::test]
async fn ftp_05_anonymous_read_only() {
    require_docker!(port_ftp());

    let mut ftp = connect(anonymous_settings()).await;
    let browser = ftp.file_browser().expect("FTP exposes a file browser");

    // Anonymous can browse the seeded tree.
    let top = list_by_name(browser, "/pub").await;
    assert_eq!(
        top.len(),
        PUB_TOP.len(),
        "anonymous sees the full /pub tree"
    );
    assert_entry(&top, "/pub", "welcome.txt", false, 65);

    // Anonymous writes are denied by the server.
    let denied = browser.mkdir("/uploads/anon_should_fail").await;
    assert!(denied.is_err(), "anonymous mkdir must be denied");

    ftp.disconnect().await.expect("disconnect should succeed");
}
