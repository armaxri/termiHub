//! Tests for the `require_docker!` gate logic (TBE-006).
//!
//! `require_docker!` (and the sibling `require_sftp_stress!` in `src-tauri`)
//! used to *silently* return-as-pass when a fixture was absent, so a
//! Docker-backed integration lane whose containers never came up would go
//! falsely green. The gate now has two modes:
//!
//! * **skip** (visible `SKIPPED:` line) when a fixture is absent and Docker is
//!   not required — the local / per-PR default;
//! * **hard-fail** (panic) when a fixture is absent but `TERMIHUB_REQUIRE_DOCKER`
//!   is set — the CI-lane enforcement.
//!
//! These tests exercise the pure decision (`fixture_gate`), the env parser
//! (`parse_required`), and the full `require_fixture` skip-vs-panic behaviour.
//! None of them touch Docker or a network, so they run in the ordinary
//! `cargo test` gate — the code path that must never regress silently.

mod common;

use common::{fixture_gate, parse_required, require_fixture, FixtureGate};

#[test]
fn gate_runs_when_fixture_reachable_regardless_of_require_flag() {
    assert_eq!(fixture_gate(true, false), FixtureGate::Run);
    assert_eq!(fixture_gate(true, true), FixtureGate::Run);
}

#[test]
fn gate_skips_when_absent_and_not_required() {
    assert_eq!(fixture_gate(false, false), FixtureGate::Skip);
}

#[test]
fn gate_fails_when_absent_but_required() {
    assert_eq!(fixture_gate(false, true), FixtureGate::Fail);
}

#[test]
fn parse_required_recognizes_truthy_values() {
    for v in ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON", " 1 "] {
        assert!(parse_required(Some(v)), "{v:?} should be truthy");
    }
}

#[test]
fn parse_required_treats_unset_and_falsey_as_not_required() {
    assert!(!parse_required(None), "unset should be falsey");
    for v in ["", "0", "false", "no", "off", "maybe"] {
        assert!(!parse_required(Some(v)), "{v:?} should be falsey");
    }
}

#[test]
fn require_fixture_runs_when_reachable() {
    // Reachable → run the body (return true), never skip or panic, whatever the
    // require flag says.
    assert!(require_fixture(true, false, "test fixture", 1234, "hint"));
    assert!(require_fixture(true, true, "test fixture", 1234, "hint"));
}

#[test]
fn require_fixture_skips_when_absent_and_not_required() {
    // Absent + not required → skip (return false), no panic. This is the
    // local / per-PR default: a missing fixture must not fail the run.
    assert!(!require_fixture(false, false, "test fixture", 1234, "hint"));
}

#[test]
fn require_fixture_panics_when_absent_but_required() {
    // Absent + required → hard-fail. This is the TBE-006 enforcement: a lane
    // that set TERMIHUB_REQUIRE_DOCKER must red, not skip, on a missing fixture.
    // Silence the default panic hook so the expected panic does not print a
    // scary backtrace into the test log.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome =
        std::panic::catch_unwind(|| require_fixture(false, true, "test fixture", 1234, "hint"));
    std::panic::set_hook(prev);
    assert!(
        outcome.is_err(),
        "require_fixture must panic when the fixture is absent but required"
    );
}
