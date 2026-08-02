//! Projection-contract tests for the shared `connections` region (#2225),
//! reusing the substrate harness (#2164): an in-memory [`ProjectionSink`] and a
//! client cache that applies diffs. The routes here drive a real
//! [`ConnectionsStore`] directly (the production `register_connection_intents`
//! resolves the same store from the Tauri `AppHandle`; that thin wiring is
//! integration-verified via a local `./scripts/dev.sh` run) through the identical
//! parse → mutate → publish path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, rejection paths advance nothing, a no-op intent advances nothing, a
//! dead subscriber is reaped, and the client cache converges on the store's
//! authority across a full tree-mutation lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Manager;

use crate::commands::projection::ProjectionState;
use crate::connection::config::{ConnectionFolder, SavedConnection};
use crate::connection::manager::ConnectionManager;
use crate::connections_projection::projection::{
    fold_connections_from_manager, publish_connections, CONNECTIONS_REGION,
};
use crate::connections_projection::store::ConnectionsStore;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::terminal::backend::ConnectionConfig;

// ── Fixtures ─────────────────────────────────────────────────────────────────

fn connection(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
    SavedConnection {
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

fn folder(id: &str, name: &str, parent_id: Option<&str>, expanded: bool) -> ConnectionFolder {
    ConnectionFolder {
        id: id.to_string(),
        name: name.to_string(),
        parent_id: parent_id.map(str::to_string),
        is_expanded: expanded,
    }
}

/// A store with a folder and a connection already present, so a subscriber sees a
/// populated baseline.
fn seeded_store() -> Arc<ConnectionsStore> {
    let store = Arc::new(ConnectionsStore::new());
    store.add_folder(folder("Work", "Work", None, true));
    store.add_connection(connection("Work/A", "A", Some("Work")));
    store
}

/// The production `connection.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_connection_intents` runs. Each closure mirrors the production route
/// one-to-one so the test drives real logic, not a stand-in.
fn registry_for(store: Arc<ConnectionsStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("connection.add", move |intent, projector| {
        s.add_connection(required_connection(intent)?);
        Ok(publish_connections(projector, &s))
    });
    let s = store.clone();
    registry.route("connection.update", move |intent, projector| {
        s.update_connection(required_connection(intent)?);
        Ok(publish_connections(projector, &s))
    });
    let s = store.clone();
    registry.route("connection.remove", move |intent, projector| {
        s.remove_connection(&required_str(intent, "connectionId")?);
        Ok(publish_connections(projector, &s))
    });
    let s = store.clone();
    registry.route("connection.move", move |intent, projector| {
        s.move_connection(
            &required_str(intent, "connectionId")?,
            intent
                .payload
                .get("folderId")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
        Ok(publish_connections(projector, &s))
    });
    let s = store.clone();
    registry.route("connection.addFolder", move |intent, projector| {
        s.add_folder(required_folder(intent)?);
        Ok(publish_connections(projector, &s))
    });
    let s = store.clone();
    registry.route("connection.removeFolder", move |intent, projector| {
        s.remove_folder(&required_str(intent, "folderId")?);
        Ok(publish_connections(projector, &s))
    });
    let s = store.clone();
    registry.route("connection.toggleFolder", move |intent, projector| {
        s.toggle_folder(&required_str(intent, "folderId")?);
        Ok(publish_connections(projector, &s))
    });
    let s = store;
    registry.route("connection.replace", move |intent, projector| {
        let folders: Vec<ConnectionFolder> = optional_typed(intent, "folders")?;
        let connections: Vec<SavedConnection> = optional_typed(intent, "connections")?;
        s.replace(folders, connections);
        Ok(publish_connections(projector, &s))
    });

    registry
}

fn optional_typed<T: serde::de::DeserializeOwned + Default>(
    intent: &Intent,
    key: &str,
) -> Result<T, (String, String)> {
    match intent.payload.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| ("bad_payload".to_string(), format!("invalid {key}: {e}"))),
    }
}

fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

fn required_connection(intent: &Intent) -> Result<SavedConnection, (String, String)> {
    let value = intent.payload.get("connection").ok_or_else(|| {
        (
            "bad_payload".to_string(),
            "missing 'connection'".to_string(),
        )
    })?;
    serde_json::from_value(value.clone()).map_err(|e| {
        (
            "bad_payload".to_string(),
            format!("invalid connection: {e}"),
        )
    })
}

fn required_folder(intent: &Intent) -> Result<ConnectionFolder, (String, String)> {
    let value = intent
        .payload
        .get("folder")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'folder'".to_string()))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid folder: {e}")))
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/tunnel/session/monitor test double).
struct VecSink {
    frames: Mutex<Vec<ProjectionFrame>>,
    alive: AtomicBool,
}

impl VecSink {
    fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
        }
    }

    fn diffs(&self) -> Vec<DiffFrame> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                ProjectionFrame::Diff(d) => Some(d.clone()),
                ProjectionFrame::Snapshot(_) => None,
            })
            .collect()
    }
}

impl ProjectionSink for VecSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(ProjectionError::SinkClosed("killed".into()));
        }
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

/// A minimal client cache mirroring the TypeScript `ProjectionClient`.
struct ClientCache {
    version: u64,
    view: Value,
}

impl ClientCache {
    fn from_snapshot(s: &SnapshotFrame) -> Self {
        Self {
            version: s.version,
            view: s.view.clone(),
        }
    }

    fn apply(&mut self, diff: &DiffFrame) {
        assert_eq!(diff.base_version, self.version, "diff must fit the cache");
        apply_ops(&mut self.view, &diff.ops).expect("diff applies cleanly");
        self.version = diff.version;
    }
}

fn intent(kind: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: "client-1".to_string(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_returns_the_seeded_snapshot_identically_to_every_subscriber() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());

    let snap_a = projector.subscribe(CONNECTIONS_REGION, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(CONNECTIONS_REGION, "sub-b", "B", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "connections");
    assert_eq!(snap_a.view["folders"][0]["id"], json!("Work"));
    assert_eq!(snap_a.view["connections"][0]["id"], json!("Work/A"));
}

#[test]
fn a_connection_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(CONNECTIONS_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(CONNECTIONS_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "connection.add",
        json!({ "connection": connection("Work/B", "B", Some("Work")) }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: CONNECTIONS_REGION.to_string(),
            version: 1,
        }])
    );

    let diffs_a = sink_a.diffs();
    let diffs_b = sink_b.diffs();
    assert_eq!(diffs_a.len(), 1, "exactly one diff to A");
    assert_eq!(diffs_b.len(), 1, "exactly one diff to B");
    assert_eq!(diffs_a[0], diffs_b[0], "identical diff to every subscriber");
    assert_eq!(diffs_a[0].base_version, 0);
    assert_eq!(diffs_a[0].version, 1);

    cache_a.apply(&diffs_a[0]);
    assert_eq!(
        cache_a.view,
        store.snapshot(),
        "cache converges on authority"
    );
    assert_eq!(cache_a.view["connections"][1]["id"], json!("Work/B"));
}

#[test]
fn a_full_tree_lifecycle_advances_monotonically_and_converges() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(CONNECTIONS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // add a nested folder → add a connection in it → move the seeded one into it →
    // toggle the folder → remove the folder (re-homing children). Each accepted
    // intent that changes the view = one diff.
    for (kind, payload) in [
        (
            "connection.addFolder",
            json!({ "folder": folder("Work/Dev", "Dev", Some("Work"), true) }),
        ),
        (
            "connection.add",
            json!({ "connection": connection("Work/Dev/B", "B", Some("Work/Dev")) }),
        ),
        (
            "connection.move",
            json!({ "connectionId": "Work/A", "folderId": "Work/Dev" }),
        ),
        ("connection.toggleFolder", json!({ "folderId": "Work/Dev" })),
        ("connection.removeFolder", json!({ "folderId": "Work/Dev" })),
    ] {
        let ack = dispatcher.dispatch(intent(kind, payload));
        assert_eq!(ack.status, IntentStatus::Accepted, "{kind} accepted");
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 5, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 5);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    // The removed folder is gone and its children were re-homed to root.
    assert_eq!(
        cache.view["folders"],
        json!([folder("Work", "Work", None, true)])
    );
    assert_eq!(cache.view["connections"][0]["folderId"], json!(null));
    assert_eq!(cache.view["connections"][1]["folderId"], json!(null));
}

#[test]
fn a_replace_intent_mirrors_the_whole_slice_in_one_diff() {
    // The render-cut seed: `connection.replace` overwrites both arrays, producing
    // exactly one diff a subscriber's cache converges on — the parity substrate for
    // rendering the tree from the region.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(CONNECTIONS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "connection.replace",
        json!({
            "folders": [folder("New", "New", None, false)],
            "connections": [connection("New/A", "A", Some("New"))],
        }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "the whole-slice mirror is one diff");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view,
        store.snapshot(),
        "cache mirrors the replaced slice"
    );
    assert_eq!(cache.view["folders"][0]["id"], json!("New"));
    assert_eq!(cache.view["connections"][0]["id"], json!("New/A"));
}

#[test]
fn a_replace_intent_with_identical_content_advances_nothing() {
    // Idempotent server-side: re-seeding with the current content coalesces to no
    // diff — so a settled mirror does not churn the region.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(CONNECTIONS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "connection.replace",
        json!({
            "folders": [folder("Work", "Work", None, true)],
            "connections": [connection("Work/A", "A", Some("Work"))],
        }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(CONNECTIONS_REGION), Some(0));
}

#[test]
fn an_intent_missing_the_connection_is_rejected_without_advancing() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(CONNECTIONS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent("connection.add", json!({ "wrong": "field" })));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(CONNECTIONS_REGION), Some(0));
}

#[test]
fn a_no_op_intent_advances_nothing() {
    // Removing an unknown connection leaves the view unchanged, so the projector
    // coalesces it to no diff and no version bump.
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(CONNECTIONS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "connection.remove",
        json!({ "connectionId": "ghost" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(CONNECTIONS_REGION), Some(0));
}

// ── Server-authority fold (#2389, prerequisite for #2225) ─────────────────────
//
// These drive the *production* `fold_connections_from_manager` end to end against
// a `tauri::test::mock_app()` carrying the same managed state `lib.rs::setup()`
// wires: a real `ConnectionManager` (backed by a temp dir), an
// `Arc<ConnectionsStore>`, and a `ProjectionState`. They prove the store is fed
// **server-side** — the instant a saved-connection / folder mutation lands in the
// persisted manager authority — with no `connection.*` client dispatch, and that
// the store reflects the manager's *authoritative* post-mutation tree (recomputed
// ids and all), not a naive replay of the intent-level ops.

/// A `ConnectionManager` backed by a fresh temp dir with a null credential store.
/// Returns the manager and the `TempDir` guard (kept alive for the test's span).
fn test_manager() -> (ConnectionManager, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let manager =
        ConnectionManager::new_for_test(dir.path(), Arc::new(crate::credential::NullStore))
            .unwrap();
    (manager, dir)
}

/// Wire a mock app with the managed state `setup()` builds for the connections
/// region: the manager, the store, and a `ProjectionState` whose `connections`
/// region is registered and has one `VecSink` subscribed. Returns the app, the
/// store, the sink, and the subscribe-time client cache.
#[allow(clippy::type_complexity)]
fn wire_app(
    manager: ConnectionManager,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    Arc<ConnectionsStore>,
    Arc<VecSink>,
    ClientCache,
) {
    let app = tauri::test::mock_app();
    app.manage(manager);

    let store = Arc::new(ConnectionsStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(CONNECTIONS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(CONNECTIONS_REGION, "sub", "C", sink.clone());
    let cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    (app, store, sink, cache)
}

/// A backend-produced saved-connection mutation folded server-side upserts the row
/// in the shared store and fans exactly one `connections` region diff out — with
/// no `connection.*` client dispatch. The store reflects the manager's
/// **recomputed** path-based id, proving the fold reflects the persisted authority
/// rather than replaying the caller's optimistic id.
#[test]
fn server_side_manager_mutation_folds_into_store_and_region_without_client_dispatch() {
    let (manager, _dir) = test_manager();
    let (app, store, sink, mut cache) = wire_app(manager);

    // The manager recomputes the id from folder + name, so a connection saved
    // with an optimistic `conn-<ts>` id persists under a path-based id.
    let mut incoming = connection("conn-1700000000", "MyHost", None);
    incoming.config.settings = json!({ "host": "example.com", "port": 22 });
    let persisted_id = app
        .state::<ConnectionManager>()
        .save_connection(incoming)
        .expect("manager persists the connection");
    assert_ne!(
        persisted_id, "conn-1700000000",
        "the manager recomputes the id from folder + name"
    );

    // No `connection.*` intent is dispatched — the fold feeds the store at the
    // source, from the persisted authority.
    fold_connections_from_manager(app.handle());

    // The store is authoritative server-side and carries the *recomputed* id.
    assert!(
        store.connection(&persisted_id).is_some(),
        "store carries the manager's recomputed id"
    );
    assert!(
        store.connection("conn-1700000000").is_none(),
        "store does not carry the optimistic pre-persist id"
    );

    // Exactly one region diff fanned out; the client cache converges on the store
    // (which equals the manager's authoritative snapshot) with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    assert_eq!(
        cache.view["connections"][0]["id"],
        json!(persisted_id),
        "the region reflects the persisted id"
    );
}

/// The fold reflects the manager's whole authoritative tree across a
/// folder/connection lifecycle: add folder → add a connection under it → delete
/// the folder (the manager re-homes the child to root). The store mirrors the
/// manager's `get_all()` at each source mutation, with one diff per step.
#[test]
fn server_side_fold_reflects_folder_and_connection_lifecycle() {
    let (manager, _dir) = test_manager();
    let (app, store, sink, _cache) = wire_app(manager);
    let manager = app.state::<ConnectionManager>();

    manager
        .save_folder(folder("Work", "Work", None, true))
        .unwrap();
    fold_connections_from_manager(app.handle());

    let mut child = connection("Work/Child", "Child", Some("Work"));
    child.config.settings = json!({ "host": "h", "port": 22 });
    manager.save_connection(child).unwrap();
    fold_connections_from_manager(app.handle());
    assert_eq!(store.folder_count(), 1);
    assert_eq!(store.connection_count(), 1);

    // Deleting the folder re-homes the child to root (manager authority).
    manager.delete_folder("Work").unwrap();
    fold_connections_from_manager(app.handle());
    assert_eq!(store.folder_count(), 0, "folder removed server-side");
    assert_eq!(store.connection_count(), 1, "child retained, re-homed");

    // The store equals the manager's authoritative tree at every step.
    let flat = app.state::<ConnectionManager>().get_all().unwrap();
    assert_eq!(
        store.snapshot(),
        json!({
            "folders": serde_json::to_value(&flat.folders).unwrap(),
            "connections": serde_json::to_value(&flat.connections).unwrap(),
        }),
        "store mirrors the manager authority"
    );
    assert!(
        store
            .snapshot()
            .get("connections")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("folderId"))
            .map(Value::is_null)
            .unwrap_or(false),
        "the re-homed child sits at root"
    );

    assert_eq!(sink.diffs().len(), 3, "one diff per source mutation");
}

/// The fold is a best-effort no-op when the required state is not managed (e.g. a
/// headless harness that never ran `setup()`) — it must not panic.
#[test]
fn server_side_fold_is_a_noop_without_managed_state() {
    let app = tauri::test::mock_app();
    // Nothing managed — reaching the assert without panicking is the contract.
    fold_connections_from_manager(app.handle());
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(CONNECTIONS_REGION, "live", "A", live.clone());
    projector.subscribe(CONNECTIONS_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(CONNECTIONS_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "connection.toggleFolder",
        json!({ "folderId": "Work" }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(CONNECTIONS_REGION),
        1,
        "the dead subscriber was reaped"
    );
}
