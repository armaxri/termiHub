//! References the connection manager owns follow a saved connection's id
//! change (#3596): jump-host references in every connection file, and the
//! broadcast groups and shell-integration entries in the settings.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::connection::settings::ExternalFileConfig;
use crate::credential::null::NullStore;
use crate::terminal::backend::ConnectionConfig;

fn manager(dir: &std::path::Path) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, Arc::new(NullStore)).unwrap()
}

fn ssh(id: &str, name: &str, folder_id: Option<&str>, hops: &[&str]) -> SavedConnection {
    let mut settings = json!({ "host": name, "username": "u", "authMethod": "key" });
    if !hops.is_empty() {
        let hops: Vec<serde_json::Value> =
            hops.iter().map(|h| json!({ "connectionId": h })).collect();
        settings["proxyJump"] = json!(hops);
    }
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings,
        },
        folder_id: folder_id.map(String::from),
        terminal_options: None,
        source_file: None,
    }
}

fn folder(id: &str, name: &str) -> ConnectionFolder {
    ConnectionFolder {
        id: id.to_string(),
        name: name.to_string(),
        parent_id: None,
        is_expanded: true,
    }
}

/// The jump-host reference ids of connection `id` in `connections`.
fn hops_of(connections: &[SavedConnection], id: &str) -> Vec<String> {
    let conn = connections
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("no connection {id}"));
    conn.config.settings["proxyJump"]
        .as_array()
        .map(|hops| {
            hops.iter()
                .map(|h| h["connectionId"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn external_connections(file: &str) -> Vec<SavedConnection> {
    let store = read_external_store(file).unwrap();
    flatten_tree(&store.children, None).0
}

fn enable_external_file(mgr: &ConnectionManager, file: &str) {
    let mut settings = mgr.get_settings();
    settings.external_connection_files = vec![ExternalFileConfig {
        path: file.to_string(),
        enabled: true,
    }];
    mgr.save_settings(settings).unwrap();
}

#[test]
fn a_folder_rename_rewrites_jump_host_references_in_the_same_file() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_folder(folder("Net", "Net")).unwrap();
    mgr.save_connection(ssh("gw", "gw", Some("Net"), &[]))
        .unwrap();
    mgr.save_connection(ssh("t", "t", None, &["Net/gw"]))
        .unwrap();

    mgr.save_folder(folder("Net", "Edge")).unwrap();

    // Written by the rename itself: a fresh manager reads the rewritten file.
    let all = manager(dir.path()).get_all().unwrap();
    assert_eq!(hops_of(&all.connections, "t"), ["Edge/gw"]);
    // The reference still resolves to the renamed connection.
    let mut settings = all
        .connections
        .iter()
        .find(|c| c.id == "t")
        .unwrap()
        .config
        .settings
        .clone();
    mgr.resolve_jump_host_refs(&mut settings, Some("t"))
        .unwrap();
    assert_eq!(settings["proxyJump"][0]["host"], "gw");
}

#[test]
fn a_renamed_connection_keeps_its_own_jump_host_references_when_they_move_too() {
    // The saved connection references a hop in the folder being renamed; both
    // the hop and the referencing connection move in one batch.
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_folder(folder("Net", "Net")).unwrap();
    mgr.save_connection(ssh("gw", "gw", Some("Net"), &[]))
        .unwrap();
    mgr.save_connection(ssh("t", "t", Some("Net"), &["Net/gw"]))
        .unwrap();

    mgr.save_folder(folder("Net", "Edge")).unwrap();

    let all = mgr.get_all().unwrap();
    assert_eq!(hops_of(&all.connections, "Edge/t"), ["Edge/gw"]);
}

#[test]
fn deleting_a_folder_rewrites_jump_host_references_to_its_rehomed_connections() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    mgr.save_folder(folder("Net", "Net")).unwrap();
    mgr.save_connection(ssh("gw", "gw", Some("Net"), &[]))
        .unwrap();
    mgr.save_connection(ssh("t", "t", None, &["Net/gw"]))
        .unwrap();

    mgr.delete_folder("Net").unwrap();

    assert_eq!(hops_of(&mgr.get_all().unwrap().connections, "t"), ["gw"]);
}

#[test]
fn a_main_store_rename_rewrites_references_in_enabled_external_files() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let file = dir.path().join("shared.json");
    let file = file.to_str().unwrap().to_string();
    save_external_file(
        &file,
        "shared",
        vec![],
        vec![ssh("ext", "ext", None, &["gw", "other"])],
        &NullStore,
    )
    .unwrap();
    enable_external_file(&mgr, &file);
    mgr.save_connection(ssh("gw", "gw", None, &[])).unwrap();

    mgr.save_connection(ssh("gw", "bastion", None, &[]))
        .unwrap();

    assert_eq!(
        hops_of(&external_connections(&file), "ext"),
        ["bastion", "other"]
    );
}

#[test]
fn a_disabled_external_file_is_left_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let file = dir.path().join("off.json");
    let file = file.to_str().unwrap().to_string();
    save_external_file(
        &file,
        "off",
        vec![],
        vec![ssh("ext", "ext", None, &["gw"])],
        &NullStore,
    )
    .unwrap();
    let before = std::fs::read_to_string(&file).unwrap();
    let mut settings = mgr.get_settings();
    settings.external_connection_files = vec![ExternalFileConfig {
        path: file.clone(),
        enabled: false,
    }];
    mgr.save_settings(settings).unwrap();
    mgr.save_connection(ssh("gw", "gw", None, &[])).unwrap();

    mgr.save_connection(ssh("gw", "bastion", None, &[]))
        .unwrap();

    assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn an_external_file_rename_rewrites_references_in_the_main_store_and_its_own_file() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let file = dir.path().join("shared.json");
    let file = file.to_str().unwrap().to_string();
    enable_external_file(&mgr, &file);
    let mut gw = ssh("gw", "gw", None, &[]);
    gw.source_file = Some(file.clone());
    mgr.save_connection_routed(gw.clone()).unwrap();
    let mut sibling = ssh("sib", "sib", None, &["gw"]);
    sibling.source_file = Some(file.clone());
    mgr.save_connection_routed(sibling).unwrap();
    mgr.save_connection(ssh("t", "t", None, &["gw"])).unwrap();

    gw.name = "bastion".to_string();
    mgr.save_connection_routed(gw).unwrap();

    assert_eq!(
        hops_of(&mgr.get_all().unwrap().connections, "t"),
        ["bastion"]
    );
    assert_eq!(hops_of(&external_connections(&file), "sib"), ["bastion"]);
}

#[test]
fn moving_a_connection_to_a_file_where_it_is_renamed_rewrites_references() {
    // The target file already holds a `gw`, so the moved one is deduplicated
    // to a new name — and so a new id — on arrival.
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let file = dir.path().join("shared.json");
    let file = file.to_str().unwrap().to_string();
    save_external_file(
        &file,
        "shared",
        vec![],
        vec![ssh("gw", "gw", None, &[])],
        &NullStore,
    )
    .unwrap();
    enable_external_file(&mgr, &file);
    mgr.save_connection(ssh("gw", "gw", None, &[])).unwrap();
    mgr.save_connection(ssh("t", "t", None, &["gw"])).unwrap();

    let moved = mgr
        .move_connection_to_file("gw", None, Some(file.clone()))
        .unwrap();

    assert_ne!(moved.id, "gw");
    assert_eq!(
        hops_of(&mgr.get_all().unwrap().connections, "t"),
        [moved.id]
    );
}

#[test]
fn broadcast_groups_and_shell_entries_follow_a_folder_rename() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let mut settings: AppSettings = serde_json::from_value(json!({
        "version": "1",
        "broadcastGroups": [{ "id": "g", "name": "G", "connectionIds": ["Work/a", "b"] }],
        "shellIntegration": { "entries": [{ "id": "e", "name": "E", "connectionId": "Work/a" }] }
    }))
    .unwrap();
    settings.external_connection_files = Vec::new();
    mgr.save_settings(settings).unwrap();
    mgr.save_folder(folder("Work", "Work")).unwrap();
    mgr.save_connection(ssh("a", "a", Some("Work"), &[]))
        .unwrap();

    mgr.save_folder(folder("Work", "Job")).unwrap();

    // Persisted: a fresh manager reads the rewritten settings file.
    let reloaded = serde_json::to_value(manager(dir.path()).get_settings()).unwrap();
    assert_eq!(
        reloaded["broadcastGroups"][0]["connectionIds"],
        json!(["Job/a", "b"])
    );
    assert_eq!(
        reloaded["shellIntegration"]["entries"][0]["connectionId"],
        "Job/a"
    );
}

#[test]
fn an_unreadable_external_file_does_not_block_the_rename_or_the_other_references() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(dir.path());
    let broken = dir.path().join("broken.json");
    std::fs::write(&broken, "{ not json").unwrap();
    let mut settings: AppSettings = serde_json::from_value(json!({
        "version": "1",
        "broadcastGroups": [{ "id": "g", "name": "G", "connectionIds": ["gw"] }]
    }))
    .unwrap();
    settings.external_connection_files = vec![ExternalFileConfig {
        path: broken.to_str().unwrap().to_string(),
        enabled: true,
    }];
    mgr.save_settings(settings).unwrap();
    mgr.save_connection(ssh("gw", "gw", None, &[])).unwrap();
    mgr.save_connection(ssh("t", "t", None, &["gw"])).unwrap();

    assert_eq!(
        mgr.save_connection(ssh("gw", "bastion", None, &[]))
            .unwrap(),
        "bastion"
    );

    assert_eq!(
        hops_of(&mgr.get_all().unwrap().connections, "t"),
        ["bastion"]
    );
    let settings = serde_json::to_value(mgr.get_settings()).unwrap();
    assert_eq!(
        settings["broadcastGroups"][0]["connectionIds"],
        json!(["bastion"])
    );
    assert_eq!(std::fs::read_to_string(&broken).unwrap(), "{ not json");
}
