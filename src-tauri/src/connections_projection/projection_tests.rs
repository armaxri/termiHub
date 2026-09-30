//! Projection-contract tests for the shared `connections` region (#2225),
//! reusing the substrate harness (#2164): an in-memory [`ProjectionSink`] and a
//! client cache that applies diffs.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), the
//! server-side fold from the persisted manager (the region's single writer,
//! #2831) → one coalesced diff per change that the client cache converges on, a
//! dead subscriber is reaped, and no `connection.*` intent can write the region.

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

fn folder(id: &str, name: &str, parent_id: Option<&str>, expanded: bool) -> ConnectionFolder {
    ConnectionFolder {
        extra: Default::default(),
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
    store.replace(
        vec![folder("Work", "Work", None, true)],
        vec![connection("Work/A", "A", Some("Work"))],
    );
    store
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
            "savedAs": {},
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

// ── External-file overlay reflected in the region (#2394) ─────────────────────
//
// The frontend `appStore` connections slice holds the main persisted store **and**
// the read-only external-file overlay (`reloadExternalConnections` /
// `load_connections_and_folders` flatten `load_external_sources()` into the list;
// each external row carries `sourceFile`). These prove the server-side fold
// reflects that **same unified set** into the region, so #2225's render cut is
// non-lossy for external-file connections. `fold_connections_from_manager` now
// reflects `ConnectionManager::load_unified_view` (main + external), not the main
// store alone.

/// Write `connections` into a fresh enabled external file inside `dir` and point
/// the manager's settings at it. Returns the file path (kept alive by the caller's
/// `TempDir`).
fn enable_external_file(
    manager: &ConnectionManager,
    dir: &std::path::Path,
    file_name: &str,
    connections: Vec<SavedConnection>,
) -> String {
    let path = dir.join(file_name);
    let path_str = path.to_str().unwrap().to_string();
    crate::connection::manager::save_external_file(
        &path_str,
        "Shared",
        vec![],
        connections,
        &crate::credential::NullStore,
    )
    .unwrap();
    manager
        .save_settings(crate::connection::settings::AppSettings {
            external_connection_files: vec![crate::connection::settings::ExternalFileConfig {
                path: path_str.clone(),
                enabled: true,
            }],
            ..Default::default()
        })
        .unwrap();
    path_str
}

/// The fold reflects the unified main + external view: a main-store connection and
/// an enabled external file both land in the `connections` region, the external
/// row carrying its `sourceFile`. One diff fans out and the client cache converges
/// on the unified authority — with no `connection.*` client dispatch.
#[test]
fn server_side_fold_reflects_external_file_connections_in_the_region() {
    let (manager, dir) = test_manager();

    // A main-store connection persisted through the manager.
    manager
        .save_connection(connection("Main", "Main", None))
        .expect("manager persists the main connection");

    // An enabled external file carrying one connection on disk.
    let ext_path = enable_external_file(
        &manager,
        dir.path(),
        "shared.json",
        vec![connection("Ext", "Ext", None)],
    );

    let (app, store, sink, mut cache) = wire_app(manager);

    // Fold the unified view server-side — no `connection.*` intent is dispatched.
    fold_connections_from_manager(app.handle());

    // The region carries BOTH connections; the external one carries its
    // `sourceFile`, the main one does not.
    assert_eq!(
        store.connection_count(),
        2,
        "main store + external overlay both reflected in the region"
    );
    let conns = store.snapshot()["connections"].as_array().unwrap().clone();
    let external = conns
        .iter()
        .find(|c| c["sourceFile"] == json!(ext_path))
        .expect("the external connection is present, tagged with its sourceFile");
    assert_eq!(external["name"], json!("Ext"));
    assert!(
        conns
            .iter()
            .any(|c| c["name"] == json!("Main") && c["sourceFile"].is_null()),
        "the main connection is present with no sourceFile"
    );

    // Exactly one diff fanned out; the client cache converges on the unified tree.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view,
        store.snapshot(),
        "cache converges on the unified (main + external) authority"
    );
}

/// A `reload_external_connections`-shaped change (toggling / editing the external
/// set) re-reflects the overlay: enabling a second external file and re-folding
/// adds its connection to the region.
#[test]
fn server_side_fold_repicks_up_external_changes() {
    let (manager, dir) = test_manager();
    let ext_path = enable_external_file(
        &manager,
        dir.path(),
        "one.json",
        vec![connection("One", "One", None)],
    );

    let (app, store, sink, _cache) = wire_app(manager);
    fold_connections_from_manager(app.handle());
    assert_eq!(
        store.connection_count(),
        1,
        "one external connection reflected"
    );

    // Enable a *second* external file (mirrors editing the enabled set, then the
    // frontend's `reloadExternalConnections`, which now folds server-side).
    let dir2 = tempfile::tempdir().unwrap();
    let ext_path_2 = dir2.path().join("two.json");
    let ext_path_2_str = ext_path_2.to_str().unwrap().to_string();
    crate::connection::manager::save_external_file(
        &ext_path_2_str,
        "Two",
        vec![],
        vec![connection("Two", "Two", None)],
        &crate::credential::NullStore,
    )
    .unwrap();
    app.state::<ConnectionManager>()
        .save_settings(crate::connection::settings::AppSettings {
            external_connection_files: vec![
                crate::connection::settings::ExternalFileConfig {
                    path: ext_path.clone(),
                    enabled: true,
                },
                crate::connection::settings::ExternalFileConfig {
                    path: ext_path_2_str.clone(),
                    enabled: true,
                },
            ],
            ..Default::default()
        })
        .unwrap();

    fold_connections_from_manager(app.handle());
    assert_eq!(
        store.connection_count(),
        2,
        "both external files now reflected after the reload-shaped fold"
    );
    let conns = store.snapshot()["connections"].as_array().unwrap().clone();
    assert!(conns.iter().any(|c| c["sourceFile"] == json!(ext_path)));
    assert!(conns
        .iter()
        .any(|c| c["sourceFile"] == json!(ext_path_2_str)));
    assert_eq!(sink.diffs().len(), 2, "one diff per fold");
}

/// An external file that fails to load contributes **no** rows to the region and
/// does not panic — exactly how the frontend flatten handles it (a failed source
/// yields an empty `connections` list; the error is logged, never part of the
/// `appStore` connections slice, so it is not modelled in the region either).
#[test]
fn server_side_fold_skips_a_failed_external_file_like_the_frontend() {
    let (manager, dir) = test_manager();
    manager
        .save_connection(connection("Main", "Main", None))
        .expect("manager persists the main connection");

    // A malformed (non-empty, invalid JSON) external file fails to load.
    let bad_path = dir.path().join("broken.json");
    std::fs::write(&bad_path, "{ not valid json").unwrap();
    manager
        .save_settings(crate::connection::settings::AppSettings {
            external_connection_files: vec![crate::connection::settings::ExternalFileConfig {
                path: bad_path.to_str().unwrap().to_string(),
                enabled: true,
            }],
            ..Default::default()
        })
        .unwrap();

    let (app, store, sink, _cache) = wire_app(manager);

    // Must not panic; the region reflects only the main connection.
    fold_connections_from_manager(app.handle());
    assert_eq!(
        store.connection_count(),
        1,
        "only the main connection; the broken external file adds no rows"
    );
    assert!(
        store.snapshot()["connections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["sourceFile"].is_null()),
        "no external rows from the failed file"
    );
    assert_eq!(
        sink.diffs().len(),
        1,
        "one diff (the main connection seeded into the region)"
    );
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(CONNECTIONS_REGION, "live", "A", live.clone());
    projector.subscribe(CONNECTIONS_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(CONNECTIONS_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    store.replace(vec![folder("Work", "Work", None, false)], Vec::new());
    publish_connections(&projector, &store);

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

/// The region has a single writer (#2831): `boot` registers no `connection.*`
/// intent, so a client cannot write the region past the persist command. A
/// dispatcher wired like `boot` rejects every former route as an unknown kind
/// and advances nothing.
#[test]
fn no_connection_intent_can_write_the_region() {
    let store = seeded_store();
    let projector = Arc::new(Projector::new());
    projector.register_region(CONNECTIONS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(HandlerRegistry::new()));

    for kind in [
        "connection.add",
        "connection.update",
        "connection.remove",
        "connection.move",
        "connection.reorder",
        "connection.addFolder",
        "connection.removeFolder",
        "connection.toggleFolder",
        "connection.replace",
    ] {
        let ack = dispatcher.dispatch(Intent {
            intent_id: format!("01J-{kind}"),
            kind: kind.to_string(),
            payload: json!({ "folderId": "Work", "connectionId": "Work/A" }),
            client_id: "client-1".to_string(),
        });
        assert_eq!(ack.status, IntentStatus::Rejected, "{kind} has no route");
    }
    assert_eq!(projector.region_version(CONNECTIONS_REGION), Some(0));
    assert_eq!(store.connection_count(), 1);
}
