//! Shared helpers for the desktop SFTP integration tests against the
//! pre-populated `sftp-stress` fixture (Docker Compose `stress` profile).
//!
//! Each test binary uses a different subset, so unused-item lints are allowed
//! here (the usual `tests/common` pattern).

#![allow(dead_code)]

use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_core::backends::ssh::{SftpFileBrowser, SftpTransferChannel};
use termihub_core::config::SshConfig;
use termihub_lib::files::transfer::state::TransferStateTag;
use termihub_lib::files::transfer::{ProgressSink, TransferPhase, TransferProgress};
use tokio::io::AsyncWriteExt;

/// Resolve the sftp-stress container port (per-checkout offset aware), matching
/// `core/tests/common`'s `port_sftp_stress`.
pub fn sftp_stress_port() -> u16 {
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

pub fn is_port_reachable(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    addr.parse()
        .map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).is_ok())
        .unwrap_or(false)
}

/// Env var that flips a missing fixture from a silent skip to a hard failure
/// (TBE-006). Mirrors `core/tests/common`'s `REQUIRE_DOCKER_ENV`; a CI lane that
/// brings the sftp-stress fixture up sets it (`=1`) so an absent/broken
/// container reds the lane instead of skipping to a false green.
pub const REQUIRE_DOCKER_ENV: &str = "TERMIHUB_REQUIRE_DOCKER";

/// Interpret a raw `TERMIHUB_REQUIRE_DOCKER` value as a boolean (truthy: `1`,
/// `true`, `yes`, `on`, case-insensitive; unset / everything else is falsey, so
/// local and per-PR runs never hard-fail).
pub fn parse_required(val: Option<&str>) -> bool {
    matches!(
        val.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Whether this process requires the Docker fixture to be present.
pub fn docker_required() -> bool {
    parse_required(std::env::var(REQUIRE_DOCKER_ENV).ok().as_deref())
}

/// Resolve whether a fixture-gated test body should run. Returns `true` to run;
/// `false` after a visible `SKIPPED:` line when the fixture is absent and not
/// required; **panics** when absent but required (`TERMIHUB_REQUIRE_DOCKER`
/// set), so a Docker-backed lane reds instead of going falsely green (TBE-006).
pub fn require_fixture(reachable: bool, required: bool, port: u16) -> bool {
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
pub fn trust_fixture_host_keys() {
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
        $crate::common::trust_fixture_host_keys();
        let __require_port = $port;
        if !$crate::common::require_fixture(
            $crate::common::is_port_reachable(__require_port),
            $crate::common::docker_required(),
            __require_port,
        ) {
            return;
        }
    };
}

pub fn stress_config(port: u16) -> SshConfig {
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
pub struct RecordingSink {
    pub events: Arc<Mutex<Vec<TransferProgress>>>,
}

impl RecordingSink {
    pub fn as_sink(&self) -> ProgressSink {
        let events = self.events.clone();
        Arc::new(move |p: &TransferProgress| {
            events.lock().expect("sink mutex").push(p.clone());
        })
    }

    pub fn terminal_phase(&self) -> Option<TransferPhase> {
        self.events
            .lock()
            .expect("sink mutex")
            .last()
            .map(|p| p.phase)
    }

    /// Whether any recorded event carried the given rich queue state — used to
    /// confirm a pause actually landed mid-transfer (PROD-0012).
    pub fn saw_state(&self, state: TransferStateTag) -> bool {
        self.events
            .lock()
            .expect("sink mutex")
            .iter()
            .any(|p| p.state == state)
    }
}

/// Connect a core [`SftpFileBrowser`] against the container and return it, ready
/// to drive the transfer subsystem.
///
/// Constructs the browser directly and eagerly connects it — the same path the
/// session's `ConnectionType` file browser resolves to — now that the standalone
/// UUID `SftpManager` session model has been retired (#2314).
pub async fn connect() -> Arc<SftpFileBrowser> {
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
pub async fn open_dedicated(session: Arc<SftpFileBrowser>) -> SftpTransferChannel {
    session
        .open_dedicated_channel()
        .await
        .expect("dedicated SFTP channel should open")
}

/// A deterministic, non-repeating byte pattern of length `n`, so a resumed
/// tail can be compared exactly against its source.
pub fn known_bytes(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i % 251) as u8).collect()
}

/// Write `content` to `remote_path` via a dedicated channel's truncating
/// `create_write`, then flush + shut down so the whole file is durable.
pub async fn write_remote(channel: &SftpTransferChannel, remote_path: &str, content: &[u8]) {
    let mut w = channel
        .create_write(remote_path)
        .await
        .expect("create_write should open the remote file");
    w.write_all(content)
        .await
        .expect("write_all should succeed");
    w.flush().await.expect("flush should succeed");
    w.shutdown().await.expect("shutdown should succeed");
}
