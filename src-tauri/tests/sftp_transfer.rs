//! Docker SFTP integration tests for the cancellable chunked transfer
//! subsystem (issue #1245).
//!
//! These exercise the real D1 behaviour against the pre-populated
//! `sftp-stress` container (Docker Compose `stress` profile, port 2210):
//!
//! 1. **cancel-mid-transfer** — a download of a large file is cancelled while
//!    in flight; the partial destination file is removed and the terminal
//!    `cancelled` progress event fires.
//! 2. **concurrent-transfer-while-browsing liveness** — a `list_dir` on the
//!    browsing session completes promptly while a large transfer runs on a
//!    dedicated channel, proving the copy does not hold the session mutex.
//!
//! The tests skip gracefully when the container is not reachable, mirroring
//! `core/tests`' runtime skip convention. Requires:
//! `docker compose -f tests/docker/docker-compose.yml --profile stress up -d`.

#![cfg(unix)]

use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser, SftpTransferChannel};
use termihub_core::config::SshConfig;
use termihub_core::files::FileBrowser;
use termihub_lib::files::sftp::Writability;
use termihub_lib::files::transfer::{
    run_download, ProgressSink, TransferContext, TransferDirection, TransferPhase,
    TransferProgress, TransferRegistry,
};

/// Resolve the sftp-stress container port (per-checkout offset aware), matching
/// `core/tests/common`'s `port_sftp_stress`.
fn sftp_stress_port() -> u16 {
    if let Some(p) = std::env::var("TERMIHUB_TEST_SFTP_STRESS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return p;
    }
    let offset: u16 = std::env::var("TERMIHUB_TEST_PORT_OFFSET")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    2210 + offset
}

fn is_port_reachable(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    addr.parse()
        .map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).is_ok())
        .unwrap_or(false)
}

/// Env var that flips a missing fixture from a silent skip to a hard failure
/// (TBE-006). Mirrors `core/tests/common`'s `REQUIRE_DOCKER_ENV`; a CI lane that
/// brings the sftp-stress fixture up sets it (`=1`) so an absent/broken
/// container reds the lane instead of skipping to a false green.
const REQUIRE_DOCKER_ENV: &str = "TERMIHUB_REQUIRE_DOCKER";

/// Interpret a raw `TERMIHUB_REQUIRE_DOCKER` value as a boolean (truthy: `1`,
/// `true`, `yes`, `on`, case-insensitive; unset / everything else is falsey, so
/// local and per-PR runs never hard-fail).
fn parse_required(val: Option<&str>) -> bool {
    matches!(
        val.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Whether this process requires the Docker fixture to be present.
fn docker_required() -> bool {
    parse_required(std::env::var(REQUIRE_DOCKER_ENV).ok().as_deref())
}

/// Resolve whether a fixture-gated test body should run. Returns `true` to run;
/// `false` after a visible `SKIPPED:` line when the fixture is absent and not
/// required; **panics** when absent but required (`TERMIHUB_REQUIRE_DOCKER`
/// set), so a Docker-backed lane reds instead of going falsely green (TBE-006).
fn require_fixture(reachable: bool, required: bool, port: u16) -> bool {
    match (reachable, required) {
        (true, _) => true,
        (false, false) => {
            eprintln!(
                "SKIPPED: sftp-stress container not reachable on port {port} \
                 (start with `docker compose -f tests/docker/docker-compose.yml --profile stress up -d`)"
            );
            false
        }
        (false, true) => panic!(
            "REQUIRED fixture unavailable: sftp-stress container not reachable on \
             port {port} but {REQUIRE_DOCKER_ENV} is set — a missing/broken \
             fixture is a hard failure here, not a skip (TBE-006)"
        ),
    }
}

/// Register a process-wide host-key verifier that trusts the local Docker
/// fixture containers, so these desktop SFTP integration tests connect
/// deterministically under the strict default host-key policy (#1969, #2032).
///
/// Opening a session goes through the same strict host-key path as the rest of
/// the app: with no verifier registered it trusts only keys already recorded in
/// the runner's `~/.ssh/known_hosts` and refuses everything else with "Unknown
/// server key". CI runners (and any freshly-(re)built fixture image) never have
/// the generated fixture key recorded, so the handshake fails pre-auth (#2105).
/// These tests connect only to the loopback `sftp-stress` fixture, where there
/// is no man-in-the-middle to guard against, so a test-only verifier that trusts
/// every fixture key is safe and deterministic. This mirrors core's
/// `trust_fixture_host_keys()` (`core/tests/common/mod.rs`). Registration is
/// set-once and idempotent (first call wins), so calling it from every
/// `require_sftp_stress!` site is harmless.
fn trust_fixture_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };

    struct TrustLocalFixtures;

    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustLocalFixtures {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }

    // First registration wins; any later call is a harmless no-op.
    let _ = set_host_key_verifier(Arc::new(TrustLocalFixtures));
}

/// Skip *or hard-fail* the current test based on the sftp-stress container's
/// port. Not reachable normally prints a visible `SKIPPED:` line and returns —
/// but under `TERMIHUB_REQUIRE_DOCKER=1` it panics instead, so an absent/broken
/// fixture reds a Docker-backed lane rather than skipping to a false green
/// (TBE-006). See [`require_fixture`].
macro_rules! require_sftp_stress {
    ($port:expr) => {
        // Trust the loopback fixture host key before connecting, so the strict
        // default host-key policy (#1969) does not refuse the freshly-built
        // fixture container with "Unknown server key" (#2105, sibling of #2032).
        trust_fixture_host_keys();
        let __require_port = $port;
        if !require_fixture(
            is_port_reachable(__require_port),
            docker_required(),
            __require_port,
        ) {
            return;
        }
    };
}

fn stress_config(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..SshConfig::default()
    }
}

/// A progress sink that records every emitted payload, so tests can assert on
/// the transfer lifecycle without a Tauri `AppHandle`.
#[derive(Clone, Default)]
struct RecordingSink {
    events: Arc<Mutex<Vec<TransferProgress>>>,
}

impl RecordingSink {
    fn as_sink(&self) -> ProgressSink {
        let events = self.events.clone();
        Arc::new(move |p: &TransferProgress| {
            events.lock().expect("sink mutex").push(p.clone());
        })
    }

    fn terminal_phase(&self) -> Option<TransferPhase> {
        self.events
            .lock()
            .expect("sink mutex")
            .last()
            .map(|p| p.phase)
    }
}

/// Connect a core [`SftpFileBrowser`] against the container and return it, ready
/// to drive the transfer subsystem.
///
/// Constructs the browser directly and eagerly connects it — the same path the
/// session's `ConnectionType` file browser resolves to — now that the standalone
/// UUID `SftpManager` session model has been retired (#2314).
async fn connect() -> Arc<SftpFileBrowser> {
    let config = stress_config(sftp_stress_port());
    let browser = SftpFileBrowser::new(config);
    browser
        .connect()
        .await
        .expect("SFTP session should connect");
    Arc::new(browser)
}

/// Open a dedicated [`SftpTransferChannel`] off `session` (mirrors the command
/// layer), awaited directly on the async core browser.
async fn open_dedicated(session: Arc<SftpFileBrowser>) -> SftpTransferChannel {
    session
        .open_dedicated_channel()
        .await
        .expect("dedicated SFTP channel should open")
}

/// Cancel-mid-transfer: the partial local file is removed and the terminal
/// `cancelled` event fires.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_mid_transfer_cleans_up_partial_file() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    let dedicated = open_dedicated(session).await;

    let dest = std::env::temp_dir().join(format!("termihub-cancel-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let transfer_id = "cancel-test".to_string();
    let token = registry.register(
        &transfer_id,
        "s",
        TransferDirection::Download,
        "100mb.bin",
        "/home/testuser/sftp-test/large-files/100mb.bin",
        100 * 1024 * 1024,
    );
    let sink = RecordingSink::default();
    let ctx = TransferContext {
        transfer_id: transfer_id.clone(),
        session_id: "s".to_string(),
        direction: TransferDirection::Download,
        file_name: "100mb.bin".to_string(),
        path: "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
        total: 100 * 1024 * 1024,
    };

    // Cancel almost immediately so the copy stops after an early chunk boundary
    // with the destination only partially written.
    let cancel_token = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_token.cancel();
    });

    run_download(
        dedicated,
        "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
        dest_str.clone(),
        ctx,
        token,
        registry.clone(),
        sink.as_sink(),
    )
    .await;

    assert_eq!(
        sink.terminal_phase(),
        Some(TransferPhase::Cancelled),
        "a cancelled transfer must end on the `cancelled` phase"
    );
    assert!(
        !dest.exists(),
        "the partial destination file must be removed on cancel"
    );
    assert!(
        !registry_contains(&registry, &transfer_id),
        "the registry entry must be dropped after the transfer settles"
    );
}

/// Helper: registry has no public `contains` outside tests, so probe via cancel
/// (a dropped entry returns false).
fn registry_contains(registry: &TransferRegistry, id: &str) -> bool {
    registry.cancel(id)
}

/// The write-open probe classifies a user-owned file as writable and a
/// root-owned `/etc` file as read-only — the owner-mismatch case the cheap
/// permission hint cannot catch (issue #1324). Never modifies either file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn check_writable_distinguishes_owner_from_root_owned() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;

    // A file the connecting user owns: create it fresh under $HOME, probe it,
    // then clean up. The probe must never truncate it.
    let user_path = format!(
        "/home/testuser/termihub-writable-{}.txt",
        uuid::Uuid::new_v4()
    );
    let user_writable = {
        session
            .write_file(&user_path, b"probe-content")
            .await
            .expect("writing the user-owned probe file should succeed");
        let writability = session
            .check_writable(&user_path)
            .await
            .expect("probe on a user-owned file should not error");
        // Content must survive the probe unchanged (no truncate/write).
        let content = session
            .read_file(&user_path)
            .await
            .expect("reading the probe file back should succeed");
        let _ = session.delete(&user_path).await;
        (writability, String::from_utf8(content).expect("utf-8"))
    };
    assert_eq!(
        user_writable.0,
        Writability::Writable,
        "a file owned by the connecting user must probe as writable"
    );
    assert_eq!(
        user_writable.1, "probe-content",
        "the write-open probe must not modify the file's contents"
    );

    // A root-owned file the user cannot write (mode 644, owned by root).
    let root_writability = session
        .check_writable("/etc/hostname")
        .await
        .expect("probe on a root-owned file should not error");
    assert_eq!(
        root_writability,
        Writability::ReadOnly,
        "a root-owned /etc file must probe as read-only for a non-root user"
    );
}

/// Concurrent-transfer-while-browsing liveness: a `list_dir` on the browsing
/// session completes promptly while a large transfer runs on a dedicated
/// channel.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browsing_stays_live_during_transfer() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    let dedicated = open_dedicated(session.clone()).await;

    let dest = std::env::temp_dir().join(format!("termihub-live-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let token = registry.register(
        "live-test",
        "s",
        TransferDirection::Download,
        "100mb.bin",
        "/home/testuser/sftp-test/large-files/100mb.bin",
        100 * 1024 * 1024,
    );
    let sink = RecordingSink::default();
    let ctx = TransferContext {
        transfer_id: "live-test".to_string(),
        session_id: "s".to_string(),
        direction: TransferDirection::Download,
        file_name: "100mb.bin".to_string(),
        path: "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
        total: 100 * 1024 * 1024,
    };

    // Start the large transfer in the background on the dedicated channel.
    let transfer = tokio::spawn(async move {
        run_download(
            dedicated,
            "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
            dest_str,
            ctx,
            token,
            registry,
            sink.as_sink(),
        )
        .await;
    });

    // While it runs, a directory listing on the browsing session must complete
    // promptly (the copy does not hold the session mutex).
    let start = Instant::now();
    let entries = session
        .list_dir("/home/testuser/sftp-test/large-files")
        .await
        .expect("list_dir on the browsing session should succeed during a transfer");
    let elapsed = start.elapsed();

    assert!(
        !entries.is_empty(),
        "the large-files directory should list entries"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "list_dir should complete promptly while a transfer runs, took {elapsed:?}"
    );

    // Let the transfer finish / clean up.
    let _ = tokio::time::timeout(Duration::from_secs(60), transfer).await;
    let _ = std::fs::remove_file(&dest);
}

// --- require_sftp_stress! gate logic (TBE-006) ---
//
// These verify the skip-vs-hard-fail decision the macro switches on, without
// touching Docker or the network, so they always run in the ordinary test
// gate — the path that must never regress to a silent return-as-pass.

#[test]
fn parse_required_recognizes_truthy_values() {
    for v in ["1", "true", "TRUE", "yes", "on", " 1 "] {
        assert!(parse_required(Some(v)), "{v:?} should be truthy");
    }
}

#[test]
fn parse_required_treats_unset_and_falsey_as_not_required() {
    assert!(!parse_required(None), "unset should be falsey");
    for v in ["", "0", "false", "no", "off"] {
        assert!(!parse_required(Some(v)), "{v:?} should be falsey");
    }
}

#[test]
fn require_fixture_runs_when_reachable() {
    assert!(require_fixture(true, false, 2210));
    assert!(require_fixture(true, true, 2210));
}

#[test]
fn require_fixture_skips_when_absent_and_not_required() {
    assert!(!require_fixture(false, false, 2210));
}

#[test]
fn require_fixture_panics_when_absent_but_required() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(|| require_fixture(false, true, 2210));
    std::panic::set_hook(prev);
    assert!(
        outcome.is_err(),
        "require_fixture must panic when the fixture is absent but required"
    );
}
