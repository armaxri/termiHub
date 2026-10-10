//! Unit tests for [`crate::test_fixtures`] (#4338): fixture addressing from
//! `dev.local.json`, the parallel-tree collision guard, and the skip-or-fail
//! gate.

use std::collections::HashMap;
use std::path::Path;

use crate::test_fixtures::{
    gate, parse_flag, require_reported, require_with, resolve, FixtureEnv, Gate, ALLOW_DEFAULT_ENV,
    DEFAULT_PROJECT, PORT_OFFSET_ENV, PROJECT_ENV, REQUIRE_DOCKER_ENV,
};

/// An environment reader over a fixed map, so tests never touch the process env.
fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    move |name| map.get(name).cloned()
}

fn write_dev_local(dir: &Path, json: &str) {
    std::fs::write(dir.join("dev.local.json"), json).expect("write dev.local.json");
}

/// A `<tree>/dev<N>/termiHub` checkout for each slot, returning the tree.
fn parallel_tree(slots: &[u32]) -> tempfile::TempDir {
    let tree = tempfile::tempdir().expect("tempdir");
    for slot in slots {
        std::fs::create_dir_all(tree.path().join(format!("dev{slot}")).join("termiHub"))
            .expect("create checkout");
    }
    tree
}

#[test]
fn ports_and_containers_resolve_from_one_dev_local_json() {
    let root = tempfile::tempdir().expect("tempdir");
    write_dev_local(
        root.path(),
        r#"{"dev_name": "dev5", "compose_project": "termihub-test-5", "test_port_offset": 5000}"#,
    );
    let fixtures = resolve(env(&[]), root.path()).expect("resolve");
    assert_eq!(
        fixtures,
        FixtureEnv {
            port_offset: 5000,
            project: "termihub-test-5".into()
        }
    );
    assert_eq!(fixtures.port(2201), 7201);
    assert_eq!(
        fixtures.container("network-fault"),
        "termihub-test-5-network-fault"
    );
}

#[test]
fn environment_overrides_dev_local_json() {
    let root = tempfile::tempdir().expect("tempdir");
    write_dev_local(
        root.path(),
        r#"{"compose_project": "from-file", "test_port_offset": 3000}"#,
    );
    let fixtures = resolve(
        env(&[(PORT_OFFSET_ENV, "7000"), (PROJECT_ENV, "from-env")]),
        root.path(),
    )
    .expect("resolve");
    assert_eq!(fixtures.port_offset, 7000);
    assert_eq!(fixtures.project, "from-env");

    // One variable set: the other value still comes from the file.
    let fixtures = resolve(env(&[(PROJECT_ENV, "from-env")]), root.path()).expect("resolve");
    assert_eq!(fixtures.port_offset, 3000);
    assert_eq!(fixtures.project, "from-env");
}

#[test]
fn lone_checkout_without_dev_local_json_uses_the_historical_defaults() {
    let root = tempfile::tempdir().expect("tempdir");
    let fixtures = resolve(env(&[]), root.path()).expect("resolve");
    assert_eq!(fixtures, FixtureEnv::default());
    assert_eq!(fixtures.project, DEFAULT_PROJECT);
    assert_eq!(fixtures.port(2201), 2201);
}

#[test]
fn parallel_tree_without_dev_local_json_refuses_offset_zero() {
    let tree = parallel_tree(&[0, 3]);
    let checkout = tree.path().join("dev3").join("termiHub");
    let err = resolve(env(&[]), &checkout).expect_err("must refuse the silent default");
    assert!(err.contains("parallel dev*/termiHub tree"), "{err}");
    assert!(err.contains("missing"), "{err}");
}

#[test]
fn parallel_tree_with_malformed_dev_local_json_refuses_offset_zero() {
    let tree = parallel_tree(&[0, 3]);
    let checkout = tree.path().join("dev3").join("termiHub");
    write_dev_local(&checkout, "{not json");
    let err = resolve(env(&[]), &checkout).expect_err("must refuse the silent default");
    assert!(err.contains("malformed"), "{err}");
}

#[test]
fn parallel_tree_guard_honours_the_opt_outs() {
    let tree = parallel_tree(&[0, 3]);
    let checkout = tree.path().join("dev3").join("termiHub");
    let fixtures = resolve(env(&[(ALLOW_DEFAULT_ENV, "1")]), &checkout).expect("opted out");
    assert_eq!(fixtures, FixtureEnv::default());
    let fixtures = resolve(env(&[(PORT_OFFSET_ENV, "3000")]), &checkout).expect("explicit");
    assert_eq!(fixtures.port_offset, 3000);
}

#[test]
fn single_slot_tree_keeps_the_defaults() {
    // A dev<N> directory with no sibling checkout is not a parallel tree.
    let tree = parallel_tree(&[4]);
    let checkout = tree.path().join("dev4").join("termiHub");
    let fixtures = resolve(env(&[]), &checkout).expect("resolve");
    assert_eq!(fixtures, FixtureEnv::default());
}

#[test]
fn inconsistent_dev_name_and_offset_is_an_error() {
    let root = tempfile::tempdir().expect("tempdir");
    write_dev_local(
        root.path(),
        r#"{"dev_name": "dev3", "test_port_offset": 1000}"#,
    );
    let err = resolve(env(&[]), root.path()).expect_err("inconsistent offset");
    assert!(err.contains("implies test_port_offset 3000"), "{err}");

    write_dev_local(
        root.path(),
        r#"{"dev_name": "dev3", "test_port_offset": 3000, "compose_project": "termihub-test-1"}"#,
    );
    let err = resolve(env(&[]), root.path()).expect_err("inconsistent project");
    assert!(err.contains("termihub-test-3"), "{err}");
}

#[test]
fn invalid_offsets_are_errors_not_silent_zero() {
    let root = tempfile::tempdir().expect("tempdir");
    assert!(resolve(env(&[(PORT_OFFSET_ENV, "abc")]), root.path()).is_err());
    write_dev_local(root.path(), r#"{"test_port_offset": "2000"}"#);
    assert!(resolve(env(&[]), root.path()).is_err());
}

#[test]
#[should_panic(expected = "overflows u16")]
fn port_overflow_panics() {
    FixtureEnv {
        port_offset: 64000,
        project: DEFAULT_PROJECT.into(),
    }
    .port(2201);
}

#[test]
fn gate_decides_run_skip_fail() {
    assert_eq!(gate(true, false), Gate::Run);
    assert_eq!(gate(true, true), Gate::Run);
    assert_eq!(gate(false, false), Gate::Skip);
    assert_eq!(gate(false, true), Gate::Fail);
}

#[test]
fn parse_flag_accepts_only_truthy_values() {
    for v in ["1", "true", "TRUE", "yes", "on", " 1 "] {
        assert!(parse_flag(Some(v)), "{v:?} should be set");
    }
    assert!(!parse_flag(None));
    for v in ["", "0", "false", "no", "off", "maybe"] {
        assert!(!parse_flag(Some(v)), "{v:?} should not be set");
    }
}

#[test]
fn require_runs_when_available_and_skips_when_not_required() {
    assert!(require_with(
        true,
        true,
        REQUIRE_DOCKER_ENV,
        "fixture",
        "hint"
    ));
    assert!(!require_with(
        false,
        false,
        REQUIRE_DOCKER_ENV,
        "fixture",
        "hint"
    ));
}

#[test]
#[should_panic(
    expected = "REQUIRED dependency unavailable: docker daemon, but TERMIHUB_REQUIRE_DOCKER is set"
)]
fn require_panics_when_missing_and_required() {
    require_with(false, true, REQUIRE_DOCKER_ENV, "docker daemon", "hint");
}

#[test]
fn require_reported_runs_when_available_and_skips_when_not_required() {
    assert!(require_reported(
        true,
        false,
        format_args!("fixture"),
        format_args!("fixture unavailable")
    ));
    assert!(require_reported(
        true,
        true,
        format_args!("fixture"),
        format_args!("fixture unavailable")
    ));
    assert!(!require_reported(
        false,
        false,
        format_args!("fixture"),
        format_args!("fixture unavailable")
    ));
}

#[test]
#[should_panic(expected = "REQUIRED fixture unavailable: ssh-sudo on port 2212")]
fn require_reported_panics_with_the_required_prefix_when_missing_and_required() {
    let port = 2212;
    require_reported(
        false,
        true,
        format_args!("ssh-sudo on port {port}"),
        format_args!("fixture unavailable: ssh-sudo on port {port}"),
    );
}
