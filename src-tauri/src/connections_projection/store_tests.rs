//! Unit tests for the shadow [`ConnectionsStore`] transitions (#2225).
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
fn add_connection_appends_to_the_array() {
    let store = ConnectionsStore::new();
    store.add_connection(connection("Work/A", "A", Some("Work")));
    store.add_connection(connection("Work/B", "B", Some("Work")));

    assert_eq!(store.connection_count(), 2);
    assert_eq!(store.connection("Work/A").unwrap().name, "A");
    // Ordering is array position — the second add lands after the first.
    let snap = store.snapshot();
    assert_eq!(snap["connections"][0]["id"], json!("Work/A"));
    assert_eq!(snap["connections"][1]["id"], json!("Work/B"));
}

#[test]
fn update_connection_replaces_the_matching_id_only() {
    let store = ConnectionsStore::new();
    store.add_connection(connection("Work/A", "A", Some("Work")));
    store.add_connection(connection("Work/B", "B", Some("Work")));

    store.update_connection(connection("Work/A", "A renamed", None));

    let updated = store.connection("Work/A").unwrap();
    assert_eq!(updated.name, "A renamed");
    assert_eq!(updated.folder_id, None, "the edit moved it to root");
    assert_eq!(store.connection("Work/B").unwrap().name, "B", "B untouched");
    assert_eq!(store.connection_count(), 2, "no entry added or dropped");
}

#[test]
fn update_connection_is_a_no_op_for_an_unknown_id() {
    let store = ConnectionsStore::new();
    store.add_connection(connection("Work/A", "A", None));

    store.update_connection(connection("ghost", "ghost", None));

    assert!(store.connection("ghost").is_none());
    assert_eq!(store.connection_count(), 1);
}

#[test]
fn remove_connection_drops_the_entry() {
    let store = ConnectionsStore::new();
    store.add_connection(connection("Work/A", "A", None));
    store.add_connection(connection("Work/B", "B", None));

    store.remove_connection("Work/A");

    assert!(store.connection("Work/A").is_none());
    assert!(store.connection("Work/B").is_some());
    assert_eq!(store.connection_count(), 1);
}

#[test]
fn remove_connection_is_idempotent() {
    let store = ConnectionsStore::new();
    store.add_connection(connection("Work/A", "A", None));
    store.remove_connection("Work/A");
    store.remove_connection("Work/A"); // no panic, no change
    assert_eq!(store.connection_count(), 0);
}

#[test]
fn move_connection_sets_the_folder_id() {
    let store = ConnectionsStore::new();
    store.add_connection(connection("Root/A", "A", None));

    store.move_connection("Root/A", Some("Work".to_string()));
    assert_eq!(
        store.connection("Root/A").unwrap().folder_id.as_deref(),
        Some("Work")
    );

    // Moving to root clears the folder id.
    store.move_connection("Root/A", None);
    assert_eq!(store.connection("Root/A").unwrap().folder_id, None);
}

#[test]
fn move_connection_is_a_no_op_for_an_unknown_id() {
    let store = ConnectionsStore::new();
    store.move_connection("ghost", Some("Work".to_string()));
    assert_eq!(store.connection_count(), 0);
}

#[test]
fn add_folder_appends_to_the_array() {
    let store = ConnectionsStore::new();
    store.add_folder(folder("Work", "Work", None, false));
    store.add_folder(folder("Work/Dev", "Dev", Some("Work"), true));

    assert_eq!(store.folder_count(), 2);
    assert_eq!(
        store.folder("Work/Dev").unwrap().parent_id.as_deref(),
        Some("Work")
    );
    assert!(store.folder("Work/Dev").unwrap().is_expanded);
}

#[test]
fn toggle_folder_flips_is_expanded() {
    let store = ConnectionsStore::new();
    store.add_folder(folder("Work", "Work", None, false));

    store.toggle_folder("Work");
    assert!(store.folder("Work").unwrap().is_expanded);

    store.toggle_folder("Work");
    assert!(!store.folder("Work").unwrap().is_expanded);
}

#[test]
fn toggle_folder_is_a_no_op_for_an_unknown_id() {
    let store = ConnectionsStore::new();
    store.toggle_folder("ghost"); // no panic
    assert_eq!(store.folder_count(), 0);
}

#[test]
fn remove_folder_reparents_child_folders_to_the_removed_parent() {
    let store = ConnectionsStore::new();
    // Work > Work/Dev > Work/Dev/Deep
    store.add_folder(folder("Work", "Work", None, true));
    store.add_folder(folder("Work/Dev", "Dev", Some("Work"), true));
    store.add_folder(folder("Work/Dev/Deep", "Deep", Some("Work/Dev"), true));

    store.remove_folder("Work/Dev");

    assert!(store.folder("Work/Dev").is_none(), "the folder is gone");
    assert_eq!(
        store.folder("Work/Dev/Deep").unwrap().parent_id.as_deref(),
        Some("Work"),
        "the grandchild reparents to the removed folder's parent"
    );
}

#[test]
fn remove_folder_moves_child_connections_to_root() {
    let store = ConnectionsStore::new();
    store.add_folder(folder("Work", "Work", None, true));
    store.add_connection(connection("Work/A", "A", Some("Work")));
    store.add_connection(connection("Other/B", "B", Some("Other")));

    store.remove_folder("Work");

    assert_eq!(
        store.connection("Work/A").unwrap().folder_id,
        None,
        "a child connection moves to root"
    );
    assert_eq!(
        store.connection("Other/B").unwrap().folder_id.as_deref(),
        Some("Other"),
        "an unrelated connection is untouched"
    );
    assert!(store.folder("Work").is_none());
}

#[test]
fn remove_folder_reparents_children_of_a_root_folder_to_root() {
    let store = ConnectionsStore::new();
    // A root folder with a child folder: removing it lifts the child to root
    // (parent_id becomes the removed folder's own parent, which is None).
    store.add_folder(folder("Top", "Top", None, true));
    store.add_folder(folder("Top/Sub", "Sub", Some("Top"), true));

    store.remove_folder("Top");

    assert_eq!(store.folder("Top/Sub").unwrap().parent_id, None);
}

#[test]
fn remove_folder_is_idempotent() {
    let store = ConnectionsStore::new();
    store.add_folder(folder("Work", "Work", None, true));
    store.remove_folder("Work");
    store.remove_folder("Work"); // no panic, no change
    assert_eq!(store.folder_count(), 0);
}

#[test]
fn replace_overwrites_the_whole_slice() {
    let store = ConnectionsStore::new();
    store.add_folder(folder("Old", "Old", None, true));
    store.add_connection(connection("Old/A", "A", Some("Old")));

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
    store.add_folder(folder("Work", "Work", None, true));
    store.add_connection(connection("Work/A", "A", Some("Work")));

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
    store.add_folder(folder("Work", "Work", None, true));
    store.add_connection(connection("Work/A", "A", Some("Work")));

    let snap = store.snapshot();
    assert_eq!(snap["folders"][0]["id"], json!("Work"));
    assert_eq!(snap["folders"][0]["isExpanded"], json!(true));
    assert_eq!(snap["folders"][0]["parentId"], json!(null));
    assert_eq!(snap["connections"][0]["id"], json!("Work/A"));
    assert_eq!(snap["connections"][0]["folderId"], json!("Work"));
    assert_eq!(snap["connections"][0]["config"]["type"], json!("ssh"));
}
