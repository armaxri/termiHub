//! Jump-host references resolve against the same connection set the editor's
//! picker offers — the main store plus every enabled external connection file
//! (#3602) — and an id held by more than one file is refused as ambiguous
//! rather than silently connecting through the wrong gateway.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::connection::settings::ExternalFileConfig;
use crate::credential::null::NullStore;
use crate::terminal::backend::ConnectionConfig;

fn manager(dir: &std::path::Path) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, Arc::new(NullStore)).unwrap()
}

/// An SSH connection to `host` reached through saved-connection references `hops`.
fn ssh(id: &str, host: &str, hops: &[&str]) -> SavedConnection {
    let mut settings = json!({ "host": host, "username": "u", "authMethod": "key" });
    if !hops.is_empty() {
        let hops: Vec<serde_json::Value> =
            hops.iter().map(|h| json!({ "connectionId": h })).collect();
        settings["proxyJump"] = json!(hops);
    }
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: id.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

/// Write an external connection file holding `connections`; returns its path.
fn external_file(dir: &std::path::Path, name: &str, connections: Vec<SavedConnection>) -> String {
    let path = dir.join(format!("{name}.json"));
    let path = path.to_str().unwrap().to_string();
    save_external_file(&path, name, vec![], connections, &NullStore).unwrap();
    path
}

fn configure_external_files(mgr: &ConnectionManager, files: &[(&str, bool)]) {
    let mut settings = mgr.get_settings();
    settings.external_connection_files = files
        .iter()
        .map(|(path, enabled)| ExternalFileConfig {
            path: path.to_string(),
            enabled: *enabled,
        })
        .collect();
    mgr.save_settings(settings).unwrap();
}

/// The settings of a connection that jumps through `hops`, resolved.
fn resolve(mgr: &ConnectionManager, hops: &[&str]) -> anyhow::Result<serde_json::Value> {
    let mut settings = ssh("target", "target-host", hops).config.settings;
    mgr.resolve_jump_host_refs(&mut settings, Some("target"))?;
    Ok(settings)
}

fn hop_hosts(settings: &serde_json::Value) -> Vec<String> {
    settings["proxyJump"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["host"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_main_store_connection_resolves_a_hop_in_an_enabled_external_file() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let file = external_file(
        dir.path(),
        "shared",
        vec![ssh("ext-gw", "ext-gw-host", &[])],
    );
    configure_external_files(&mgr, &[(&file, true)]);

    let settings = resolve(&mgr, &["ext-gw"]).unwrap();

    assert_eq!(hop_hosts(&settings), ["ext-gw-host"]);
    assert_eq!(settings["proxyJump"][0]["connectionId"], "ext-gw");
}

#[test]
fn a_hop_chain_may_cross_files_in_both_directions() {
    // target → ext-gw (external file) whose own hop is main-gw (main store) and
    // other-gw (a second external file).
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_connection(ssh("main-gw", "main-gw-host", &[]))
        .unwrap();
    let a = external_file(
        dir.path(),
        "a",
        vec![ssh("ext-gw", "ext-gw-host", &["main-gw", "other-gw"])],
    );
    let b = external_file(dir.path(), "b", vec![ssh("other-gw", "other-gw-host", &[])]);
    configure_external_files(&mgr, &[(&a, true), (&b, true)]);

    let settings = resolve(&mgr, &["ext-gw"]).unwrap();

    assert_eq!(
        hop_hosts(&settings),
        ["main-gw-host", "other-gw-host", "ext-gw-host"]
    );
}

#[test]
fn an_id_held_by_the_main_store_and_an_external_file_is_refused_as_ambiguous() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_connection(ssh("gw", "main-host", &[])).unwrap();
    let file = external_file(dir.path(), "shared", vec![ssh("gw", "ext-host", &[])]);
    configure_external_files(&mgr, &[(&file, true)]);

    let err = resolve(&mgr, &["gw"]).unwrap_err().to_string();

    assert!(err.contains("ambiguous"), "{err}");
    assert!(err.contains("main connection store"), "{err}");
    assert!(err.contains(&file), "{err}");
}

#[test]
fn an_id_held_by_two_external_files_is_refused_as_ambiguous() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let a = external_file(dir.path(), "a", vec![ssh("gw", "a-host", &[])]);
    let b = external_file(dir.path(), "b", vec![ssh("gw", "b-host", &[])]);
    configure_external_files(&mgr, &[(&a, true), (&b, true)]);

    let err = resolve(&mgr, &["gw"]).unwrap_err().to_string();

    assert!(err.contains("ambiguous"), "{err}");
    assert!(err.contains(&a) && err.contains(&b), "{err}");
}

#[test]
fn an_ambiguous_id_deep_in_the_chain_is_refused_too() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_connection(ssh("inner", "main-inner", &[]))
        .unwrap();
    mgr.save_connection(ssh("outer", "outer-host", &["inner"]))
        .unwrap();
    let file = external_file(dir.path(), "shared", vec![ssh("inner", "ext-inner", &[])]);
    configure_external_files(&mgr, &[(&file, true)]);

    let err = resolve(&mgr, &["outer"]).unwrap_err().to_string();

    assert!(err.contains("ambiguous"), "{err}");
}

#[test]
fn a_hop_in_a_disabled_external_file_is_unresolved_with_a_clear_message() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let file = external_file(dir.path(), "off", vec![ssh("ext-gw", "ext-gw-host", &[])]);
    configure_external_files(&mgr, &[(&file, false)]);

    let err = resolve(&mgr, &["ext-gw"]).unwrap_err().to_string();

    assert!(err.contains("not found"), "{err}");
    assert!(err.contains("disabled"), "{err}");
    assert!(err.contains(&file), "{err}");
}

#[test]
fn a_disabled_file_does_not_make_an_enabled_match_ambiguous() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_connection(ssh("gw", "main-host", &[])).unwrap();
    let file = external_file(dir.path(), "off", vec![ssh("gw", "ext-host", &[])]);
    configure_external_files(&mgr, &[(&file, false)]);

    let settings = resolve(&mgr, &["gw"]).unwrap();

    assert_eq!(hop_hosts(&settings), ["main-host"]);
}

#[test]
fn a_missing_hop_names_the_external_files_that_failed_to_load() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let broken = dir.path().join("broken.json");
    std::fs::write(&broken, "{ not json").unwrap();
    let broken = broken.to_str().unwrap().to_string();
    configure_external_files(&mgr, &[(&broken, true)]);

    let err = resolve(&mgr, &["gw"]).unwrap_err().to_string();

    assert!(err.contains("not found"), "{err}");
    assert!(err.contains("failed to load"), "{err}");
    assert!(err.contains(&broken), "{err}");
}

#[test]
fn a_hop_that_exists_nowhere_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());

    let err = resolve(&mgr, &["ghost"]).unwrap_err().to_string();

    assert!(err.contains("'ghost' not found"), "{err}");
    assert!(!err.contains("disabled"), "{err}");
}
