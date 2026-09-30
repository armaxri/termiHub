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

/// Env var that flips a missing fixture from a silent skip to a hard failure.
pub const REQUIRE_DOCKER_ENV: &str = "TERMIHUB_REQUIRE_DOCKER";

/// Interpret a raw `TERMIHUB_REQUIRE_DOCKER` value as a boolean (truthy: `1`,
/// `true`, `yes`, `on`, case-insensitive; unset / everything else is falsey).
pub fn parse_required(val: Option<&str>) -> bool {
    matches!(
        val.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Whether this process requires the Docker fixtures to be present.
pub fn docker_required() -> bool {
    parse_required(std::env::var(REQUIRE_DOCKER_ENV).ok().as_deref())
}

/// Returns `true` if a TCP connection to `127.0.0.1:port` succeeds quickly.
pub fn port_reachable(port: u16) -> bool {
    format!("127.0.0.1:{port}")
        .parse()
        .ok()
        .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok())
        .is_some()
}

/// Resolve whether a fixture-gated test body should run. Returns `true` to run;
/// `false` after a visible `SKIPPED:` line when the fixture is absent and not
/// required; **panics** when it is absent but required.
pub fn require_fixture(service: &str, port: u16, reachable: bool, required: bool) -> bool {
    match (reachable, required) {
        (true, _) => true,
        (false, false) => {
            eprintln!(
                "SKIPPED: {service} container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d {service})"
            );
            false
        }
        (false, true) => panic!(
            "REQUIRED fixture unavailable: {service} container not reachable on port \
             {port} but {REQUIRE_DOCKER_ENV} is set — a missing/broken fixture is a \
             hard failure here, not a skip (TBE-006)"
        ),
    }
}

/// Probe `service` on `port` and apply [`require_fixture`] with the process's
/// `TERMIHUB_REQUIRE_DOCKER` setting.
pub fn fixture_ready(service: &str, port: u16) -> bool {
    require_fixture(service, port, port_reachable(port), docker_required())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(require_fixture("ssh-sudo", 2212, true, false));
        assert!(require_fixture("ssh-sudo", 2212, true, true));
    }

    #[test]
    fn require_fixture_skips_when_absent_and_not_required() {
        assert!(!require_fixture("ssh-sudo", 2212, false, false));
    }

    #[test]
    #[should_panic(expected = "REQUIRED fixture unavailable: ssh-password")]
    fn require_fixture_panics_when_absent_but_required() {
        require_fixture("ssh-password", 2201, false, true);
    }
}
