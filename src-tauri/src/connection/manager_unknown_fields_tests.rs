//! Unknown per-node fields a newer desktop wrote into a connection file
//! survive an edit made through this build (#3947).
//!
//! The IPC shapes never carry those fields, so every save path that replaces a
//! node with the editor's copy must keep the fields the node had on disk.

use std::path::Path;
use std::sync::Arc;

use super::*;
use crate::credential::null::NullStore;

fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn write_json(path: &Path, value: &serde_json::Value) {
    std::fs::write(path, value.to_string()).unwrap();
}

/// A tree with one folder and one connection inside it, each carrying an
/// unknown field.
fn tree_with_unknown_fields() -> serde_json::Value {
    serde_json::json!([{
        "type": "folder",
        "name": "Work",
        "isExpanded": true,
        "futureFolderField": "folder-extra",
        "children": [{
            "type": "connection",
            "name": "db",
            "config": { "type": "local", "config": {} },
            "futureConnectionField": { "pinned": true }
        }]
    }])
}

fn main_file_with_unknown_fields(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("connections.json");
    write_json(
        &path,
        &serde_json::json!({
            "version": "5",
            "children": tree_with_unknown_fields(),
            "agents": [{
                "id": "agent-1",
                "name": "Agent",
                "config": { "host": "h", "port": 22, "username": "u", "authMethod": "key" },
                "futureAgentField": 7
            }]
        }),
    );
    path
}

/// Round-trip a value through its IPC (JSON) shape, as the frontend sends it.
fn over_the_wire<T: serde::Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
    serde_json::from_value(serde_json::to_value(value).unwrap()).unwrap()
}

fn assert_folder_and_connection_extras(children: &serde_json::Value) {
    let folder = &children[0];
    assert_eq!(folder["futureFolderField"], "folder-extra", "{children}");
    assert_eq!(
        folder["children"][0]["futureConnectionField"],
        serde_json::json!({ "pinned": true }),
        "{children}"
    );
}

#[test]
fn editing_a_connection_keeps_its_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = main_file_with_unknown_fields(dir.path());
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();

    let mut edited = over_the_wire(&mgr.get_all().unwrap().connections[0]);
    edited.config.settings = serde_json::json!({ "shell": "zsh" });
    mgr.save_connection(edited).unwrap();

    let on_disk = read_json(&path);
    assert_folder_and_connection_extras(&on_disk["children"]);
    assert_eq!(
        on_disk["children"][0]["children"][0]["config"]["config"],
        serde_json::json!({ "shell": "zsh" })
    );
}

#[test]
fn renaming_a_folder_keeps_its_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = main_file_with_unknown_fields(dir.path());
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();

    let mut folder = over_the_wire(&mgr.get_all().unwrap().folders[0]);
    folder.name = "Office".to_string();
    mgr.save_folder(folder).unwrap();

    let on_disk = read_json(&path);
    assert_eq!(on_disk["children"][0]["name"], "Office");
    assert_folder_and_connection_extras(&on_disk["children"]);
}

#[test]
fn editing_an_agent_keeps_its_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = main_file_with_unknown_fields(dir.path());
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();

    let mut agent = over_the_wire(&mgr.get_all().unwrap().agents[0]);
    agent.name = "Renamed".to_string();
    mgr.save_agent(agent).unwrap();

    let on_disk = read_json(&path);
    assert_eq!(on_disk["agents"][0]["name"], "Renamed");
    assert_eq!(on_disk["agents"][0]["futureAgentField"], 7, "{on_disk}");
}

/// Keys the frontend adds to an agent object (runtime state it keeps beside
/// the definition) are never persisted as if they were a newer build's fields.
#[test]
fn an_agent_saved_over_ipc_does_not_persist_frontend_only_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = main_file_with_unknown_fields(dir.path());
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();

    let mut wire = serde_json::to_value(&mgr.get_all().unwrap().agents[0]).unwrap();
    wire["connectionState"] = serde_json::json!("connected");
    mgr.save_agent(serde_json::from_value(wire.clone()).unwrap())
        .unwrap();
    wire["id"] = serde_json::json!("agent-2");
    mgr.save_agent(serde_json::from_value(wire).unwrap())
        .unwrap();

    let on_disk = read_json(&path);
    let agents = on_disk["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2, "{on_disk}");
    assert!(
        agents.iter().all(|a| a.get("connectionState").is_none()),
        "{on_disk}"
    );
    assert_eq!(agents[0]["futureAgentField"], 7, "{on_disk}");
    assert!(agents[1].get("futureAgentField").is_none(), "{on_disk}");
}

#[test]
fn editing_a_connection_in_an_external_file_keeps_its_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();
    let file = dir.path().join("shared.json");
    write_json(
        &file,
        &serde_json::json!({ "version": "5", "children": tree_with_unknown_fields() }),
    );
    let file_str = file.to_str().unwrap().to_string();

    let (conns, _) = flatten_tree(&read_external_store(&file_str).unwrap().children, None);
    let mut edited = over_the_wire(&conns[0]);
    edited.source_file = Some(file_str.clone());
    edited.config.settings = serde_json::json!({ "shell": "fish" });
    mgr.save_connection_routed(edited).unwrap();

    let on_disk = read_json(&file);
    assert_folder_and_connection_extras(&on_disk["children"]);
    assert_eq!(
        on_disk["children"][0]["children"][0]["config"]["config"],
        serde_json::json!({ "shell": "fish" })
    );
}

#[test]
fn moving_a_connection_to_another_file_keeps_its_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    main_file_with_unknown_fields(dir.path());
    let mgr = ConnectionManager::new_for_test(dir.path(), Arc::new(NullStore)).unwrap();
    let file = dir.path().join("moved.json");
    let file_str = file.to_str().unwrap().to_string();

    let mut moving = over_the_wire(&mgr.get_all().unwrap().connections[0]);
    moving.source_file = Some(file_str.clone());
    mgr.save_connection_to_file(moving, None).unwrap();

    let on_disk = read_json(&file);
    let text = on_disk.to_string();
    assert!(
        text.contains("\"futureConnectionField\":{\"pinned\":true}"),
        "{text}"
    );
}

fn ssh_node_with_password() -> serde_json::Value {
    serde_json::json!({
        "type": "connection",
        "name": "s",
        "config": { "type": "ssh", "config": {
            "host": "h", "port": 22, "username": "u",
            "authMethod": "password", "password": "secret"
        } }
    })
}

/// PER2-005: an external file written by a newer termiHub is refused on load
/// and by every write path, and is left byte-for-byte intact.
#[test]
fn a_newer_external_file_is_refused_and_left_intact() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shared.json");
    let newer = serde_json::json!({
        "version": "99",
        "children": [ssh_node_with_password()],
        "futureTop": 1
    })
    .to_string();
    std::fs::write(&file, &newer).unwrap();
    let path = file.to_str().unwrap();

    let err = try_load_external_file(path, "scope", &HashSet::new(), &NullStore, None)
        .err()
        .expect("a newer external file must be refused");
    assert!(err.to_string().contains("newer version"), "{err:#}");
    assert!(read_external_store(path).is_err());
    assert!(remove_from_external_file(path, "s").is_err());

    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer);
}

/// PER2-005: the load-time rewrite (password strip) keeps the file's unknown
/// top-level fields and its own version instead of hard-coding "2".
#[test]
fn external_rewrite_keeps_unknown_top_level_fields_and_version() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shared.json");
    write_json(
        &file,
        &serde_json::json!({
            "version": "5",
            "children": [ssh_node_with_password()],
            "futureTop": { "a": 1 }
        }),
    );
    let path = file.to_str().unwrap();

    try_load_external_file(path, "scope", &HashSet::new(), &NullStore, None).unwrap();

    let on_disk = read_json(&file);
    assert_eq!(
        on_disk["futureTop"],
        serde_json::json!({ "a": 1 }),
        "{on_disk}"
    );
    assert_eq!(on_disk["version"], "5", "{on_disk}");
    assert!(
        on_disk["children"][0]["config"]["config"]
            .get("password")
            .is_none(),
        "{on_disk}"
    );

    remove_from_external_file(path, "nothing").unwrap();
    assert_eq!(read_json(&file)["futureTop"], serde_json::json!({ "a": 1 }));
}
