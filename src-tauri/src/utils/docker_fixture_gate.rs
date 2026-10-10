//! Skip-or-hard-fail gate for the desktop crate's in-crate Docker-backed tests
//! (#3978).
//!
//! The elevated-save tests (`files::sftp`) and the agent-deploy test
//! (`utils::remote_exec`) drive private desktop-crate code against live
//! `tests/docker` containers, so they cannot live in `src-tauri/tests/` and use
//! its `require_sftp_stress!` gate. This module is their equivalent: with the
//! fixture absent they print a visible `SKIPPED:` line and return (local and
//! per-PR runs have no containers up), but under `TERMIHUB_REQUIRE_DOCKER=1`
//! — set by the Docker-provisioned `integration-fixtures.yml` lane — a missing
//! or broken fixture panics, so the lane can never go green by skipping
//! (TBE-006). Mirrors `src-tauri/tests/common` and `core/tests/common`.

use std::net::TcpStream;
use std::time::Duration;

use termihub_core::test_fixtures;

/// Env var that flips a missing fixture from a silent skip to a hard failure.
pub const REQUIRE_DOCKER_ENV: &str = test_fixtures::REQUIRE_DOCKER_ENV;

/// Whether this process requires the Docker fixtures to be present.
pub fn docker_required() -> bool {
    test_fixtures::flag_set(REQUIRE_DOCKER_ENV)
}

/// Returns `true` if a TCP connection to `127.0.0.1:port` succeeds quickly.
pub fn port_reachable(port: u16) -> bool {
    format!("127.0.0.1:{port}")
        .parse()
        .ok()
        .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok())
        .is_some()
}

/// Resolve whether a fixture-gated test body should run: a thin wrapper over
/// [`test_fixtures::require_reported`] (#4544). Returns `true` to run; `false`
/// after a visible `SKIPPED:` line when the fixture is absent and not
/// required; **panics** when it is absent but required.
pub fn require_fixture(service: &str, port: u16, reachable: bool, required: bool) -> bool {
    test_fixtures::require_reported(
        reachable,
        required,
        format_args!(
            "{service} container not reachable on port {port} \
             (start with: docker compose -f tests/docker/docker-compose.yml up -d {service})"
        ),
        format_args!(
            "fixture unavailable: {service} container not reachable on port \
             {port} but {REQUIRE_DOCKER_ENV} is set — a missing/broken fixture is a \
             hard failure here, not a skip (TBE-006)"
        ),
    )
}

/// Probe `service` on `port` and apply [`require_fixture`] with the process's
/// `TERMIHUB_REQUIRE_DOCKER` setting.
pub fn fixture_ready(service: &str, port: u16) -> bool {
    require_fixture(service, port, port_reachable(port), docker_required())
}
