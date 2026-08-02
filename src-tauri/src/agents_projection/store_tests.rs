//! Unit tests for the shadow [`AgentsStore`] transitions (#2226).
//!
//! Drives the store directly and asserts on the typed records and the serialised
//! view model, checking the agent list order, the backend-authoritative
//! connection-status transitions, and the definition/folder CRUD.

use serde_json::json;

use super::{AgentConnectionState, AgentDefinition, AgentFolder, AgentSession, AgentsStore};

/// A deterministic agent config blob.
fn config(host: &str) -> serde_json::Value {
    json!({ "host": host, "port": 22, "authMethod": "password" })
}

/// A deterministic settings blob.
fn settings() -> serde_json::Value {
    json!({ "autoReconnect": true })
}

fn definition(id: &str, folder: Option<&str>) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        name: format!("def-{id}"),
        session_type: "shell".to_string(),
        config: json!({ "shell": "bash" }),
        persistent: false,
        folder_id: folder.map(str::to_string),
        terminal_options: None,
        icon: None,
        source_file: None,
    }
}

fn folder(id: &str) -> AgentFolder {
    AgentFolder {
        id: id.to_string(),
        name: format!("folder-{id}"),
        parent_id: None,
        is_expanded: true,
    }
}

fn session(id: &str) -> AgentSession {
    AgentSession {
        session_id: id.to_string(),
        title: format!("session {id}"),
        session_type: "shell".to_string(),
        status: "running".to_string(),
        attached: true,
        definition_id: None,
    }
}

#[test]
fn a_fresh_store_snapshots_empty() {
    let store = AgentsStore::new();
    assert_eq!(
        store.snapshot(),
        json!({ "agents": [], "sessions": {}, "definitions": {}, "folders": {} })
    );
}

#[test]
fn add_creates_a_disconnected_collapsed_agent() {
    let store = AgentsStore::new();
    store.add("a1", "Agent One", config("h1"), settings());

    let agent = store.get("a1").expect("agent exists");
    assert_eq!(agent.name, "Agent One");
    assert_eq!(agent.connection_state, AgentConnectionState::Disconnected);
    assert!(!agent.is_expanded);
    assert_eq!(agent.capabilities, None);
    assert_eq!(agent.last_error, None);
    // Optional fields are omitted from the serialised view (matches the frontend
    // `?`-optional shape, not `| null`).
    let view = store.snapshot();
    let entry = &view["agents"][0];
    assert!(entry.get("capabilities").is_none());
    assert!(entry.get("lastError").is_none());
}

#[test]
fn add_is_idempotent_on_a_duplicate_id() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.add("a1", "One again", config("h2"), settings());
    assert_eq!(store.agent_ids(), vec!["a1"]);
    // The first add wins (append-only, no clobber).
    assert_eq!(store.get("a1").unwrap().name, "One");
}

#[test]
fn update_replaces_config_fields_but_preserves_live_status() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.set_status("a1", AgentConnectionState::Connected, None);
    store.set_capabilities("a1", json!({ "maxSessions": 4 }));
    store.toggle_expanded("a1");

    store.update(
        "a1",
        "Renamed",
        config("h2"),
        json!({ "autoReconnect": false }),
    );

    let agent = store.get("a1").unwrap();
    assert_eq!(agent.name, "Renamed");
    assert_eq!(agent.config["host"], json!("h2"));
    assert_eq!(agent.agent_settings["autoReconnect"], json!(false));
    // Live status carried over, not clobbered.
    assert_eq!(agent.connection_state, AgentConnectionState::Connected);
    assert_eq!(agent.capabilities, Some(json!({ "maxSessions": 4 })));
    assert!(agent.is_expanded);
}

#[test]
fn apply_settings_updates_only_settings() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.apply_settings("a1", json!({ "autoReconnect": false, "extra": 1 }));
    let agent = store.get("a1").unwrap();
    assert_eq!(
        agent.agent_settings,
        json!({ "autoReconnect": false, "extra": 1 })
    );
    assert_eq!(agent.name, "One");
}

#[test]
fn remove_drops_the_agent_and_all_its_substate() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );

    store.remove("a1");
    assert!(store.get("a1").is_none());
    assert!(store.definitions_of("a1").is_empty());
    assert!(store.folders_of("a1").is_empty());
    let view = store.snapshot();
    assert!(view["sessions"].get("a1").is_none());
}

#[test]
fn reorder_moves_an_agent_and_ignores_out_of_range() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.add("a2", "Two", config("h2"), settings());
    store.add("a3", "Three", config("h3"), settings());

    store.reorder(0, 2);
    assert_eq!(store.agent_ids(), vec!["a2", "a3", "a1"]);

    // Out-of-range indices are a no-op.
    store.reorder(0, 9);
    assert_eq!(store.agent_ids(), vec!["a2", "a3", "a1"]);
}

#[test]
fn status_tracks_last_error_like_the_frontend() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());

    // disconnected records the error.
    store.set_status(
        "a1",
        AgentConnectionState::Disconnected,
        Some("boom".into()),
    );
    assert_eq!(store.get("a1").unwrap().last_error.as_deref(), Some("boom"));

    // reconnecting leaves the stored error untouched.
    store.set_status("a1", AgentConnectionState::Reconnecting, None);
    assert_eq!(store.get("a1").unwrap().last_error.as_deref(), Some("boom"));

    // connecting clears it.
    store.set_status("a1", AgentConnectionState::Connecting, None);
    assert_eq!(store.get("a1").unwrap().last_error, None);

    // disconnected with no error falls back to the stored (now clear) value.
    store.set_status("a1", AgentConnectionState::Disconnected, None);
    assert_eq!(store.get("a1").unwrap().last_error, None);

    // connected clears any error too.
    store.set_status(
        "a1",
        AgentConnectionState::Disconnected,
        Some("again".into()),
    );
    store.set_status("a1", AgentConnectionState::Connected, None);
    assert_eq!(store.get("a1").unwrap().last_error, None);
    assert_eq!(
        store.get("a1").unwrap().connection_state,
        AgentConnectionState::Connected
    );
}

#[test]
fn disconnect_forces_disconnected_and_clears_live_but_keeps_definitions() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.set_status("a1", AgentConnectionState::Connected, None);
    store.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );

    store.disconnect("a1");
    let agent = store.get("a1").unwrap();
    assert_eq!(agent.connection_state, AgentConnectionState::Disconnected);
    let view = store.snapshot();
    assert_eq!(view["sessions"]["a1"], json!([]));
    assert_eq!(view["folders"]["a1"], json!([]));
    // Definitions (persisted config) survive a disconnect.
    assert_eq!(store.definitions_of("a1").len(), 1);
}

#[test]
fn save_definition_upserts_and_update_replaces() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());

    store.save_definition("a1", definition("d1", None));
    store.save_definition("a1", definition("d2", None));
    assert_eq!(store.definitions_of("a1").len(), 2);

    // Re-saving the same id replaces, not appends.
    let mut renamed = definition("d1", None);
    renamed.name = "renamed".to_string();
    store.save_definition("a1", renamed);
    let defs = store.definitions_of("a1");
    assert_eq!(defs.len(), 2);
    assert_eq!(defs.iter().find(|d| d.id == "d1").unwrap().name, "renamed");

    // update replaces an existing definition by id.
    let mut updated = definition("d2", None);
    updated.persistent = true;
    store.update_definition("a1", updated);
    assert!(
        store
            .definitions_of("a1")
            .iter()
            .find(|d| d.id == "d2")
            .unwrap()
            .persistent
    );
}

#[test]
fn delete_folder_removes_it_and_reparents_child_definitions() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.create_folder("a1", folder("f1"));
    store.save_definition("a1", definition("d1", Some("f1")));
    store.save_definition("a1", definition("d2", None));

    store.delete_folder("a1", "f1");
    assert!(store.folders_of("a1").is_empty());
    // The child definition is reparented to the root (folderId → None).
    let d1 = store
        .definitions_of("a1")
        .into_iter()
        .find(|d| d.id == "d1")
        .unwrap();
    assert_eq!(d1.folder_id, None);
}

#[test]
fn update_folder_replaces_by_id() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.create_folder("a1", folder("f1"));

    let mut toggled = folder("f1");
    toggled.is_expanded = false;
    store.update_folder("a1", toggled);
    assert!(!store.folders_of("a1")[0].is_expanded);
}

#[test]
fn create_folder_upserts_by_id_so_it_is_idempotent() {
    // The server-side fold of the `create_agent_folder` RPC outcome (#2388) and
    // the additive client `agent.createFolder` mirror both apply `create_folder`
    // with the same server-assigned id; upsert-by-id must converge on one entry.
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());

    store.create_folder("a1", folder("f1"));
    store.create_folder("a1", folder("f1"));
    assert_eq!(
        store.folders_of("a1").len(),
        1,
        "duplicate id does not append"
    );

    // A distinct id still appends.
    store.create_folder("a1", folder("f2"));
    assert_eq!(store.folders_of("a1").len(), 2);

    // Re-creating with the same id replaces (last-write-wins).
    let mut renamed = folder("f1");
    renamed.name = "renamed".to_string();
    store.create_folder("a1", renamed);
    let f1 = store
        .folders_of("a1")
        .into_iter()
        .find(|f| f.id == "f1")
        .unwrap();
    assert_eq!(f1.name, "renamed");
    assert_eq!(store.folders_of("a1").len(), 2, "still no duplicate");
}

#[test]
fn set_sessions_replaces_only_the_sessions_slice() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );

    store.set_sessions("a1", vec![session("s2"), session("s3")]);

    let view = store.snapshot();
    let ids: Vec<&str> = view["sessions"]["a1"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["s2", "s3"], "sessions replaced");
    // Definitions and folders are untouched (distinct from `refresh`).
    assert_eq!(store.definitions_of("a1").len(), 1);
    assert_eq!(store.folders_of("a1").len(), 1);
}

#[test]
fn remove_session_drops_one_session_by_id_and_is_idempotent() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.set_sessions("a1", vec![session("s1"), session("s2")]);

    store.remove_session("a1", "s1");
    let remaining: Vec<String> = store.snapshot()["sessions"]["a1"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(remaining, vec!["s2".to_string()]);

    // Removing again / an unknown id is a no-op.
    store.remove_session("a1", "s1");
    store.remove_session("a1", "ghost");
    assert_eq!(
        store.snapshot()["sessions"]["a1"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn set_definitions_and_set_folders_replace_only_their_slice() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );

    store.set_definitions("a1", vec![definition("d2", None), definition("d3", None)]);
    store.set_folders("a1", vec![folder("f2")]);

    let def_ids: Vec<String> = store
        .definitions_of("a1")
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(def_ids, vec!["d2".to_string(), "d3".to_string()]);
    let folder_ids: Vec<String> = store.folders_of("a1").into_iter().map(|f| f.id).collect();
    assert_eq!(folder_ids, vec!["f2".to_string()]);
    // The live-session slice is untouched.
    assert_eq!(
        store.snapshot()["sessions"]["a1"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn per_slice_setters_on_an_unknown_agent_are_no_ops() {
    let store = AgentsStore::new();
    store.set_sessions("ghost", vec![session("s1")]);
    store.set_definitions("ghost", vec![definition("d1", None)]);
    store.set_folders("ghost", vec![folder("f1")]);
    store.remove_session("ghost", "s1");
    assert_eq!(
        store.snapshot(),
        json!({ "agents": [], "sessions": {}, "definitions": {}, "folders": {} })
    );
}

#[test]
fn transitions_on_an_unknown_agent_are_no_ops() {
    let store = AgentsStore::new();
    // None of these should panic or create an agent / sub-state.
    store.update("ghost", "x", config("h"), settings());
    store.apply_settings("ghost", settings());
    store.toggle_expanded("ghost");
    store.set_status("ghost", AgentConnectionState::Connected, None);
    store.set_capabilities("ghost", json!({}));
    store.disconnect("ghost");
    store.refresh(
        "ghost",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );
    store.clear_sessions("ghost");
    store.save_definition("ghost", definition("d1", None));
    store.create_folder("ghost", folder("f1"));

    assert!(store.get("ghost").is_none());
    assert!(store.definitions_of("ghost").is_empty());
    assert!(store.folders_of("ghost").is_empty());
    assert_eq!(
        store.snapshot(),
        json!({ "agents": [], "sessions": {}, "definitions": {}, "folders": {} })
    );
}

#[test]
fn the_snapshot_preserves_agent_order() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.add("a2", "Two", config("h2"), settings());
    store.reorder(1, 0);

    let view = store.snapshot();
    let ids: Vec<&str> = view["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["a2", "a1"]);
}

#[test]
fn replace_overwrites_the_whole_slice_with_a_snapshot() {
    // Build a populated source store the render-cut mirror would copy from.
    let source = AgentsStore::new();
    source.add("a1", "One", config("h1"), settings());
    source.add("a2", "Two", config("h2"), settings());
    source.set_status("a1", AgentConnectionState::Connected, None);
    source.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", Some("f1"))],
        vec![folder("f1")],
    );
    let snapshot = source.snapshot();

    // Deserialize the source view back into the typed slice the replace carries.
    let agents: Vec<super::AgentEntry> =
        serde_json::from_value(snapshot["agents"].clone()).unwrap();
    let sessions = serde_json::from_value(snapshot["sessions"].clone()).unwrap();
    let definitions = serde_json::from_value(snapshot["definitions"].clone()).unwrap();
    let folders = serde_json::from_value(snapshot["folders"].clone()).unwrap();

    // Prime a target with unrelated state that replace must fully overwrite.
    let target = AgentsStore::new();
    target.add("old", "Stale", config("old"), settings());
    target.refresh("old", vec![session("x")], vec![], vec![]);

    target.replace(agents, sessions, definitions, folders);

    assert!(target.get("old").is_none(), "replace drops prior agents");
    assert_eq!(
        target.snapshot(),
        source.snapshot(),
        "replace makes the store a faithful copy of the source slice"
    );
}

#[test]
fn replace_with_empty_maps_clears_everything() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![],
    );

    store.replace(
        Vec::new(),
        Default::default(),
        Default::default(),
        Default::default(),
    );

    assert_eq!(
        store.snapshot(),
        json!({ "agents": [], "sessions": {}, "definitions": {}, "folders": {} })
    );
}
