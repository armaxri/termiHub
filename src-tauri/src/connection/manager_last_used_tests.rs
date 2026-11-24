//! A saved connection's last-used time (#5940): stamped on each successful
//! connect, never moved back by a save of an older copy, and absent — never
//! used — in files written before it existed, which load and write back
//! without gaining the key.

use std::path::Path;
use std::sync::Arc;

use super::*;
use crate::credential::null::NullStore;

fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A pre-#5940 main file: two connections, neither with `lastUsedAt`, one
/// carrying a field this build does not know.
fn legacy_main_file(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("connections.json");
    let file = serde_json::json!({
        "version": "5",
        "children": [
            {
                "type": "connection",
                "name": "prod",
                "config": { "type": "local", "config": {} },
                "futureConnectionField": 7
            },
            {
                "type": "connection",
                "name": "staging",
                "config": { "type": "local", "config": {} }
            }
        ]
    });
    std::fs::write(&path, file.to_string()).unwrap();
    path
}

fn manager(dir: &Path) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, Arc::new(NullStore)).unwrap()
}

fn last_used(mgr: &ConnectionManager, id: &str) -> Option<u64> {
    mgr.get_all()
        .unwrap()
        .connections
        .into_iter()
        .find(|c| c.id == id)
        .and_then(|c| c.last_used_at)
}

#[test]
fn a_legacy_file_loads_every_connection_as_never_used() {
    let dir = tempfile::tempdir().unwrap();
    legacy_main_file(dir.path());
    let mgr = manager(dir.path());
    let all = mgr.get_all().unwrap().connections;
    assert_eq!(all.len(), 2);
    assert!(all.iter().all(|c| c.last_used_at.is_none()), "{all:?}");
}

#[test]
fn a_connect_stamps_the_connection_and_persists_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = legacy_main_file(dir.path());
    let mgr = manager(dir.path());

    assert!(mgr.record_connection_used("prod", 1_000).unwrap());

    assert_eq!(last_used(&mgr, "prod"), Some(1_000));
    let disk = read_json(&path);
    assert_eq!(disk["children"][0]["lastUsedAt"], 1_000, "{disk}");
    // The other connection stays never-used: no key is written for it.
    assert!(disk["children"][1].get("lastUsedAt").is_none(), "{disk}");
    // Stamping is an in-place edit: the unknown field survives (#3947).
    assert_eq!(disk["children"][0]["futureConnectionField"], 7, "{disk}");
    // A fresh manager (an app restart) reads the stamp back.
    assert_eq!(last_used(&manager(dir.path()), "prod"), Some(1_000));
}

#[test]
fn each_connect_moves_the_stamp_forward_never_back() {
    let dir = tempfile::tempdir().unwrap();
    legacy_main_file(dir.path());
    let mgr = manager(dir.path());

    assert!(mgr.record_connection_used("prod", 1_000).unwrap());
    assert!(mgr.record_connection_used("prod", 2_000).unwrap());
    assert_eq!(last_used(&mgr, "prod"), Some(2_000));
    // An out-of-order (older) stamp is ignored and writes nothing.
    assert!(!mgr.record_connection_used("prod", 1_500).unwrap());
    assert_eq!(last_used(&mgr, "prod"), Some(2_000));
}

#[test]
fn two_connections_to_the_same_target_keep_their_own_times() {
    let dir = tempfile::tempdir().unwrap();
    legacy_main_file(dir.path());
    let mgr = manager(dir.path());

    mgr.record_connection_used("prod", 1_000).unwrap();
    mgr.record_connection_used("staging", 3_000).unwrap();
    assert_eq!(last_used(&mgr, "prod"), Some(1_000));
    assert_eq!(last_used(&mgr, "staging"), Some(3_000));
}

#[test]
fn an_unknown_id_is_a_no_op_that_leaves_the_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = legacy_main_file(dir.path());
    let before = std::fs::read_to_string(&path).unwrap();
    let mgr = manager(dir.path());

    // An ad-hoc session, a deleted connection, or one in an external file.
    assert!(!mgr.record_connection_used("gone", 1_000).unwrap());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
}

#[test]
fn saving_an_older_copy_keeps_the_stamp() {
    let dir = tempfile::tempdir().unwrap();
    legacy_main_file(dir.path());
    let mgr = manager(dir.path());

    // The editor opened the connection before it was connected...
    let mut copy = mgr
        .get_all()
        .unwrap()
        .connections
        .into_iter()
        .find(|c| c.id == "prod")
        .unwrap();
    mgr.record_connection_used("prod", 5_000).unwrap();
    // ...and saves its stale copy (no stamp) with an edit.
    assert!(copy.last_used_at.is_none());
    copy.config.settings = serde_json::json!({ "shell": "zsh" });
    mgr.save_connection(copy.clone()).unwrap();
    assert_eq!(last_used(&mgr, "prod"), Some(5_000));

    // A copy carrying an older stamp does not move it back either.
    copy.last_used_at = Some(10);
    mgr.save_connection(copy).unwrap();
    assert_eq!(last_used(&mgr, "prod"), Some(5_000));
}

#[test]
fn saving_a_never_used_connection_writes_no_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = legacy_main_file(dir.path());
    let mgr = manager(dir.path());

    let mut copy = mgr.get_all().unwrap().connections[1].clone();
    copy.config.settings = serde_json::json!({ "shell": "fish" });
    mgr.save_connection(copy).unwrap();

    let disk = read_json(&path);
    let children = disk["children"].as_array().unwrap();
    assert!(
        children.iter().all(|c| c.get("lastUsedAt").is_none()),
        "{disk}"
    );
}

#[test]
fn keep_newest_last_used_takes_the_newer_of_both() {
    let conn = |at: Option<u64>| SavedConnection {
        last_used_at: at,
        ..sample()
    };
    assert_eq!(keep_newest_last_used(conn(None), None).last_used_at, None);
    assert_eq!(
        keep_newest_last_used(conn(None), Some(&conn(Some(4)))).last_used_at,
        Some(4)
    );
    assert_eq!(
        keep_newest_last_used(conn(Some(9)), Some(&conn(Some(4)))).last_used_at,
        Some(9)
    );
    assert_eq!(
        keep_newest_last_used(conn(Some(2)), Some(&conn(Some(4)))).last_used_at,
        Some(4)
    );
}

fn sample() -> SavedConnection {
    serde_json::from_value(serde_json::json!({
        "id": "prod",
        "name": "prod",
        "config": { "type": "local", "config": {} },
        "folderId": null
    }))
    .unwrap()
}
