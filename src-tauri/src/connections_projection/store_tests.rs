//! Unit tests for the [`ConnectionsStore`] snapshot and its single write path,
//! `replace` (#2225, #2831).
//!
//! Drives the store directly and asserts on the flat arrays / serialised view
//! model (the reused config types carry a `serde_json::Value` settings field,
//! which has no `PartialEq`, so records are compared via their JSON projection or
//! their scalar fields).

use serde_json::json;

use crate::connection::config::{ConnectionFolder, SavedConnection};
use crate::terminal::backend::ConnectionConfig;

use super::{ConnectionsStore, SAVED_AS_CAPACITY};

/// A deterministic saved connection, optionally inside a folder.
fn connection(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: json!({ "host": "example.com", "port": 22 }),
        },
        folder_id: folder_id.map(str::to_string),
        terminal_options: None,
        source_file: None,
    }
}

/// A deterministic folder, optionally nested under a parent.
fn folder(id: &str, name: &str, parent_id: Option<&str>, expanded: bool) -> ConnectionFolder {
    ConnectionFolder {
        extra: Default::default(),
        id: id.to_string(),
        name: name.to_string(),
        parent_id: parent_id.map(str::to_string),
        is_expanded: expanded,
    }
}

#[test]
fn a_fresh_store_snapshots_empty() {
    let store = ConnectionsStore::new();
    assert_eq!(
        store.snapshot(),
        json!({ "folders": [], "connections": [], "savedAs": {} })
    );
}

#[test]
fn replace_overwrites_the_whole_slice() {
    let store = ConnectionsStore::new();
    store.replace(
        vec![folder("Old", "Old", None, true)],
        vec![connection("Old/A", "A", Some("Old"))],
    );

    store.replace(
        vec![folder("New", "New", None, false)],
        vec![connection("New/B", "B", Some("New"))],
    );

    assert!(store.folder("Old").is_none(), "old folder is gone");
    assert!(
        store.connection("Old/A").is_none(),
        "old connection is gone"
    );
    assert_eq!(store.folder_count(), 1);
    assert_eq!(store.connection_count(), 1);
    assert!(!store.folder("New").unwrap().is_expanded);
    assert_eq!(store.connection("New/B").unwrap().name, "B");
}

#[test]
fn replace_with_empty_arrays_clears_the_tree() {
    let store = ConnectionsStore::new();
    store.replace(
        vec![folder("Work", "Work", None, true)],
        vec![connection("Work/A", "A", Some("Work"))],
    );

    store.replace(Vec::new(), Vec::new());

    assert_eq!(store.folder_count(), 0);
    assert_eq!(store.connection_count(), 0);
    assert_eq!(
        store.snapshot(),
        json!({ "folders": [], "connections": [], "savedAs": {} })
    );
}

#[test]
fn snapshot_serialises_the_full_view_model() {
    let store = ConnectionsStore::new();
    store.replace(
        vec![folder("Work", "Work", None, true)],
        vec![connection("Work/A", "A", Some("Work"))],
    );

    let snap = store.snapshot();
    assert_eq!(snap["folders"][0]["id"], json!("Work"));
    assert_eq!(snap["folders"][0]["isExpanded"], json!(true));
    assert_eq!(snap["folders"][0]["parentId"], json!(null));
    assert_eq!(snap["connections"][0]["id"], json!("Work/A"));
    assert_eq!(snap["connections"][0]["folderId"], json!("Work"));
    assert_eq!(snap["connections"][0]["config"]["type"], json!("ssh"));
}

// ── The `savedAs` echo (#3961) ─────────────────────────────────────────────

#[test]
fn a_save_under_a_new_id_is_echoed_in_saved_as() {
    let store = ConnectionsStore::new();
    store.record_saved_as("conn-01J", "Work/A");

    assert_eq!(store.snapshot()["savedAs"], json!({ "conn-01J": "Work/A" }));
}

#[test]
fn a_save_that_keeps_its_id_is_not_echoed() {
    let store = ConnectionsStore::new();
    store.record_saved_as("Work/A", "Work/A");

    assert_eq!(store.snapshot()["savedAs"], json!({}));
}

#[test]
fn saved_as_survives_a_replace() {
    let store = ConnectionsStore::new();
    store.record_saved_as("conn-01J", "A");
    store.replace(Vec::new(), vec![connection("A", "A", None)]);

    assert_eq!(store.snapshot()["savedAs"], json!({ "conn-01J": "A" }));
}

#[test]
fn saved_as_keeps_the_latest_mapping_for_an_id() {
    let store = ConnectionsStore::new();
    store.record_saved_as("conn-01J", "A");
    store.record_saved_as("conn-01J", "A (1)");

    assert_eq!(store.snapshot()["savedAs"], json!({ "conn-01J": "A (1)" }));
}

#[test]
fn saved_as_is_bounded_dropping_the_oldest() {
    let store = ConnectionsStore::new();
    for i in 0..=SAVED_AS_CAPACITY {
        store.record_saved_as(&format!("conn-{i}"), &format!("C{i}"));
    }

    let saved_as = store.snapshot()["savedAs"].clone();
    let saved_as = saved_as.as_object().unwrap();
    assert_eq!(saved_as.len(), SAVED_AS_CAPACITY);
    assert!(!saved_as.contains_key("conn-0"), "the oldest is dropped");
    assert_eq!(
        saved_as[&format!("conn-{SAVED_AS_CAPACITY}")],
        json!(format!("C{SAVED_AS_CAPACITY}"))
    );
}
