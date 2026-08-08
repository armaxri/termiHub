//! Unit tests for the shadow [`AgentsStore`] transitions (#2226).
//!
//! Drives the store directly and asserts on the typed records and the serialised
//! view model, checking the agent list order, the backend-authoritative
//! connection-status transitions, and the definition/folder CRUD.

use serde_json::json;

use super::{
    AgentConnectionState, AgentDefinition, AgentFolder, AgentSession, AgentsStore, SavedAgentSeed,
};

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

/// A persisted-list seed (id / name / config / settings) — the input to
/// `reflect_saved_agents`, carrying only the persisted fields the backend owns.
fn seed(id: &str, name: &str, host: &str) -> SavedAgentSeed {
    SavedAgentSeed {
        id: id.to_string(),
        name: name.to_string(),
        config: config(host),
        agent_settings: settings(),
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
fn entry_transitions_on_an_unknown_agent_are_no_ops() {
    let store = AgentsStore::new();
    // None of these fabricate an agent entry or its sub-state for an unknown id.
    store.update("ghost", "x", config("h"), settings());
    store.apply_settings("ghost", settings());
    store.toggle_expanded("ghost");
    store.set_status("ghost", AgentConnectionState::Connected, None);
    store.set_capabilities("ghost", json!({}));
    store.disconnect("ghost");
    // The whole-list snapshot setters still no-op on an unknown id (nothing to
    // render under a missing agent node).
    store.refresh(
        "ghost",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );
    store.clear_sessions("ghost");
    store.set_definitions("ghost", vec![definition("d1", None)]);
    store.set_folders("ghost", vec![folder("f1")]);

    assert!(store.get("ghost").is_none());
    assert!(store.definitions_of("ghost").is_empty());
    assert!(store.folders_of("ghost").is_empty());
    assert_eq!(
        store.snapshot(),
        json!({ "agents": [], "sessions": {}, "definitions": {}, "folders": {} })
    );
}

// ── #2486: creates render reliably (both candidate mechanisms) ─────────────────

/// Mechanism 1 (no-op on unknown id): a folder/definition created against an agent
/// whose entry has not landed yet must not be silently dropped — it renders as soon
/// as the entry arrives (persisted-list fold / client `agent.add` mirror).
#[test]
fn a_create_racing_entry_creation_renders_once_the_entry_lands() {
    let store = AgentsStore::new();
    // Create fires before the agent entry exists (the entry-creation fold has not
    // run yet). Previously a bare unknown-id no-op silently dropped it.
    store.create_folder("a1", folder("f1"));
    store.save_definition("a1", definition("d1", None));
    // Sub-state is recorded even though there is no agent node to render it under yet.
    assert_eq!(store.folders_of("a1"), vec![folder("f1")]);
    assert_eq!(store.definitions_of("a1"), vec![definition("d1", None)]);

    // The entry lands via the persisted-list fold; the pre-created items survive and
    // now render under the agent node.
    store.reflect_saved_agents(vec![seed("a1", "One", "h1")]);
    assert!(store.get("a1").is_some());
    assert_eq!(store.folders_of("a1"), vec![folder("f1")]);
    assert_eq!(store.definitions_of("a1"), vec![definition("d1", None)]);
}

/// An orphan sub-state map for an id that never becomes a real persisted agent is
/// self-cleaning: `reflect_saved_agents` drops it (#2486).
#[test]
fn a_create_for_an_id_that_never_becomes_an_agent_is_dropped_by_reflect() {
    let store = AgentsStore::new();
    store.create_folder("ghost", folder("f1"));
    store.save_definition("ghost", definition("d1", None));
    // A reflect that does not include the id drops the orphan sub-state.
    store.reflect_saved_agents(vec![seed("a1", "One", "h1")]);
    assert!(store.folders_of("ghost").is_empty());
    assert!(store.definitions_of("ghost").is_empty());
}

/// Mechanism 2 (source-fold vs optimistic-write race): a stale whole-list snapshot
/// (`set_folders` / `set_definitions`) delivered *after* an optimistic create must
/// not clobber it. The refresh snapshot was taken before the create was persisted.
#[test]
fn an_optimistic_create_survives_a_stale_whole_list_snapshot() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    // Existing, server-confirmed items plus the fresh optimistic create.
    store.set_folders("a1", vec![folder("f1")]);
    store.set_definitions("a1", vec![definition("d1", None)]);
    store.create_folder("a1", folder("new"));
    store.save_definition("a1", definition("newdef", None));

    // A stale refresh snapshot (taken before the create persisted) lacks the new
    // items. It must not drop them.
    store.set_folders("a1", vec![folder("f1")]);
    store.set_definitions("a1", vec![definition("d1", None)]);

    let folder_ids: Vec<String> = store.folders_of("a1").into_iter().map(|f| f.id).collect();
    let def_ids: Vec<String> = store
        .definitions_of("a1")
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert!(
        folder_ids.contains(&"new".to_string()),
        "create clobbered: {folder_ids:?}"
    );
    assert!(
        def_ids.contains(&"newdef".to_string()),
        "create clobbered: {def_ids:?}"
    );
    assert!(folder_ids.contains(&"f1".to_string()));
    assert!(def_ids.contains(&"d1".to_string()));
}

/// The once-per-connect `refresh` (which replaces sessions + definitions + folders
/// in one shot) must also preserve an unconfirmed local create it races (#2486).
#[test]
fn an_optimistic_create_survives_a_stale_refresh() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.create_folder("a1", folder("new"));
    store.save_definition("a1", definition("newdef", None));

    // A stale connect-refresh snapshot lacking the just-created items.
    store.refresh("a1", vec![], vec![], vec![]);

    assert_eq!(store.folders_of("a1"), vec![folder("new")]);
    assert_eq!(store.definitions_of("a1"), vec![definition("newdef", None)]);
}

/// Once a snapshot confirms a create (it now contains it), the store stops
/// protecting it — so a later snapshot that genuinely omits it (a delete on the
/// server / another client) correctly drops it. No stale-item resurrection (#2486).
#[test]
fn a_confirmed_create_is_no_longer_protected_and_a_genuine_delete_sticks() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.create_folder("a1", folder("f1"));
    store.save_definition("a1", definition("d1", None));

    // A snapshot that includes the create confirms it (stops the protection).
    store.set_folders("a1", vec![folder("f1")]);
    store.set_definitions("a1", vec![definition("d1", None)]);
    assert_eq!(store.folders_of("a1"), vec![folder("f1")]);

    // A later authoritative snapshot omits it (deleted elsewhere) → it is dropped.
    store.set_folders("a1", vec![]);
    store.set_definitions("a1", vec![]);
    assert!(store.folders_of("a1").is_empty());
    assert!(store.definitions_of("a1").is_empty());
}

/// A create the user then deletes locally must stay deleted even if a stale snapshot
/// (still lacking the delete) arrives afterwards — the protection is cleared on the
/// local delete, so it is not resurrected (#2486).
#[test]
fn a_locally_deleted_create_is_not_resurrected_by_a_stale_snapshot() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.create_folder("a1", folder("f1"));
    store.save_definition("a1", definition("d1", None));
    store.delete_folder("a1", "f1");
    store.delete_definition("a1", "d1");

    // A stale snapshot (predating the create) — must not bring the deleted items back.
    store.set_folders("a1", vec![]);
    store.set_definitions("a1", vec![]);
    assert!(store.folders_of("a1").is_empty());
    assert!(store.definitions_of("a1").is_empty());
}

/// A disconnect resets the live view and forgets unconfirmed creates, so the next
/// connect's refresh (which by then reflects any persisted create) is authoritative
/// and nothing stale lingers (#2486).
#[test]
fn a_disconnect_forgets_unconfirmed_creates() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    store.create_folder("a1", folder("f1"));
    store.disconnect("a1");
    assert!(store.folders_of("a1").is_empty());
    // A post-reconnect snapshot without the folder is honoured (not resurrected).
    store.set_folders("a1", vec![]);
    assert!(store.folders_of("a1").is_empty());
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

// ── reflect_saved_agents — server-owned list-membership (#2403) ────────────────

#[test]
fn reflect_saved_agents_creates_entries_on_an_empty_store() {
    let store = AgentsStore::new();
    // The list-load path feeds the whole persisted list; entries are created.
    store.reflect_saved_agents(vec![seed("a1", "One", "h1"), seed("a2", "Two", "h2")]);

    assert_eq!(store.agent_ids(), vec!["a1", "a2"]);
    let a1 = store.get("a1").expect("a1 created");
    assert_eq!(a1.name, "One");
    assert_eq!(a1.config, config("h1"));
    // A freshly reflected agent starts disconnected/collapsed (live status is
    // store-owned, never carried by the persisted list).
    assert_eq!(a1.connection_state, AgentConnectionState::Disconnected);
    assert!(!a1.is_expanded);
    assert_eq!(a1.capabilities, None);
}

#[test]
fn reflect_saved_agents_preserves_live_status_of_surviving_ids() {
    let store = AgentsStore::new();
    store.add("a1", "One", config("h1"), settings());
    // Give a1 live status + sub-state that only lives in the store.
    store.set_status("a1", AgentConnectionState::Connected, None);
    store.set_capabilities("a1", json!({ "maxSessions": 4 }));
    store.toggle_expanded("a1");
    store.refresh(
        "a1",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![folder("f1")],
    );

    // A reload reflects the persisted list; a1 survives with a renamed config.
    store.reflect_saved_agents(vec![seed("a1", "One Renamed", "h1-new")]);

    let a1 = store.get("a1").expect("a1 survives");
    // Persisted fields refreshed…
    assert_eq!(a1.name, "One Renamed");
    assert_eq!(a1.config, config("h1-new"));
    // …live status preserved.
    assert_eq!(a1.connection_state, AgentConnectionState::Connected);
    assert_eq!(a1.capabilities, Some(json!({ "maxSessions": 4 })));
    assert!(a1.is_expanded);
    // Sub-state preserved for the surviving id.
    assert_eq!(store.definitions_of("a1").len(), 1);
    assert_eq!(store.folders_of("a1").len(), 1);
    assert_eq!(
        store.snapshot()["sessions"]["a1"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn reflect_saved_agents_drops_ids_absent_from_the_list() {
    let store = AgentsStore::new();
    store.reflect_saved_agents(vec![seed("a1", "One", "h1"), seed("a2", "Two", "h2")]);
    store.refresh(
        "a2",
        vec![session("s1")],
        vec![definition("d1", None)],
        vec![],
    );

    // a2 is deleted from the persisted list → gone from the region, sub-state too.
    store.reflect_saved_agents(vec![seed("a1", "One", "h1")]);

    assert_eq!(store.agent_ids(), vec!["a1"]);
    assert!(store.get("a2").is_none());
    let view = store.snapshot();
    assert!(view["sessions"].get("a2").is_none());
    assert!(view["definitions"].get("a2").is_none());
}

#[test]
fn reflect_saved_agents_follows_the_persisted_list_order() {
    let store = AgentsStore::new();
    store.reflect_saved_agents(vec![seed("a1", "One", "h1"), seed("a2", "Two", "h2")]);
    // The persisted order (what `reorderRemoteAgents` writes back) is reflected.
    store.reflect_saved_agents(vec![seed("a2", "Two", "h2"), seed("a1", "One", "h1")]);
    assert_eq!(store.agent_ids(), vec!["a2", "a1"]);
}

#[test]
fn reflect_saved_agents_is_idempotent() {
    let store = AgentsStore::new();
    let list = vec![seed("a1", "One", "h1"), seed("a2", "Two", "h2")];
    store.reflect_saved_agents(list.clone());
    let first = store.snapshot();
    store.reflect_saved_agents(list);
    // Reflecting the same list twice yields the identical view (no drift alongside
    // the still-present client mirror).
    assert_eq!(store.snapshot(), first);
}

#[test]
fn reflect_saved_agents_with_an_empty_list_clears_membership() {
    let store = AgentsStore::new();
    store.reflect_saved_agents(vec![seed("a1", "One", "h1")]);
    store.reflect_saved_agents(Vec::new());
    assert_eq!(
        store.snapshot(),
        json!({ "agents": [], "sessions": {}, "definitions": {}, "folders": {} })
    );
}
