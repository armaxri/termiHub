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

use super::ConnectionsStore;

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
        json!({ "folders": [], "connections": [] })
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
        json!({ "folders": [], "connections": [] })
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
