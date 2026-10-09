//! Contract test: the workflows publish exactly the agent asset names the
//! desktop deployer and the agent self-updater resolve (#4302, PKG2-002).
//!
//! `termihub_core::agent_release_asset` is the single source of the agent
//! release-asset naming scheme. This test reads the release and dev-build
//! workflow YAML (and the dev release publish helper) and fails when any list of agent assets there drifts from
//! [`agent_release_asset_names`] — e.g. a Windows asset published without
//! `.exe`, a platform missing from dev builds, or a renamed target.

use std::collections::BTreeSet;
use std::path::PathBuf;

use termihub_core::agent_release_asset::{agent_release_asset_names, AGENT_ASSET_BASE};

fn workflow(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(".github")
        .join("workflows")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn expected() -> BTreeSet<String> {
    agent_release_asset_names().into_iter().collect()
}

/// Every `artifact_name: termihub-agent-…` matrix value in a workflow.
fn matrix_artifact_names(yaml: &str) -> BTreeSet<String> {
    yaml.lines()
        .filter_map(|l| l.trim().strip_prefix("artifact_name:"))
        .map(|v| v.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|v| v.starts_with(AGENT_ASSET_BASE))
        .collect()
}

/// The entries of every bash `<var>=(` … `)` array in a workflow, one set per
/// array, keeping only agent asset names (an entry may carry a `|label`).
fn bash_arrays(yaml: &str, var: &str) -> Vec<BTreeSet<String>> {
    let opener = format!("{var}=(");
    let mut arrays = Vec::new();
    let mut lines = yaml.lines();
    while let Some(line) = lines.next() {
        if line.trim() != opener {
            continue;
        }
        let mut set = BTreeSet::new();
        for entry in lines.by_ref() {
            let entry = entry.trim();
            if entry == ")" {
                break;
            }
            let name = entry.trim_matches('"');
            let name = name.split('|').next().unwrap_or(name);
            if name.starts_with(AGENT_ASSET_BASE) {
                set.insert(name.to_string());
            }
        }
        arrays.push(set);
    }
    arrays
}

#[test]
fn release_matrix_publishes_exactly_the_core_asset_names() {
    assert_eq!(matrix_artifact_names(&workflow("release.yml")), expected());
}

#[test]
fn release_sign_and_verify_lists_match_the_core_asset_names() {
    let arrays = bash_arrays(&workflow("release.yml"), "agents");
    // sign-agent-binaries + verify-release.
    assert_eq!(
        arrays.len(),
        2,
        "expected two agents=( lists in release.yml"
    );
    for set in arrays {
        assert_eq!(set, expected());
    }
}

#[test]
fn dev_build_matrix_publishes_exactly_the_core_asset_names() {
    // Includes both Windows agents (PKG2-007): dev desktops must be able to
    // deploy to Windows hosts, and the release gate relies on Dev Build to
    // compile every agent target before tag time.
    assert_eq!(
        matrix_artifact_names(&workflow("dev-build.yml")),
        expected()
    );
}

#[test]
fn dev_build_completeness_check_expects_every_core_asset() {
    // The required-artifact list lives in the publish helper (#4471); Dev
    // Build's publish job runs its `check-artifacts` before publishing.
    let dev_build = workflow("dev-build.yml");
    assert!(
        dev_build.contains("scripts/internal/dev-release-publish.sh check-artifacts"),
        "dev-build.yml must run dev-release-publish.sh check-artifacts"
    );
    assert!(
        bash_arrays(&dev_build, "EXPECTED").is_empty(),
        "the required-artifact list must live only in dev-release-publish.sh"
    );
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("internal")
        .join("dev-release-publish.sh");
    let script =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let arrays = bash_arrays(&script, "EXPECTED");
    assert_eq!(
        arrays.len(),
        1,
        "expected one EXPECTED=( list in dev-release-publish.sh"
    );
    assert_eq!(arrays[0], expected());
}
