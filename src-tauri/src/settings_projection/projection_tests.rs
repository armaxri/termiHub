//! Projection-contract tests for the shared `settings` region (#2227), reusing
//! the substrate harness (#2164): an in-memory [`ProjectionSink`] and a client
//! cache that applies diffs. The routes here drive a real [`SettingsStore`]
//! directly (the production `register_settings_intents` resolves the same store
//! from the Tauri `AppHandle`; that thin wiring is integration-verified via a
//! local `./scripts/dev.sh` run) through the identical parse → mutate → publish
//! path.
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, rejection paths advance nothing, a no-op intent advances nothing, a
//! dead subscriber is reaped, and the client cache converges on the store's
//! authority across a replace → patch → reset lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use tauri::Manager;

use crate::commands::projection::ProjectionState;
use crate::connection::manager::ConnectionManager;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};
use crate::settings_projection::projection::{
    fold_settings_from_manager, publish_settings, SETTINGS_REGION,
};
use crate::settings_projection::store::SettingsStore;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// The production `settings.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_settings_intents` runs. Each closure mirrors the production route so
/// the test drives real logic, not a stand-in.
fn registry_for(store: Arc<SettingsStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("settings.replace", move |intent, projector| {
        s.replace(required_object(intent, "settings")?);
        Ok(publish_settings(projector, &s))
    });
    let s = store.clone();
    registry.route("settings.patch", move |intent, projector| {
        s.patch(required_object(intent, "patch")?);
        Ok(publish_settings(projector, &s))
    });
    let s = store;
    registry.route("settings.reset", move |_intent, projector| {
        s.reset();
        Ok(publish_settings(projector, &s))
    });

    registry
}

/// The route-side object parse — the rejection path shared by replace/patch.
fn required_object(intent: &Intent, key: &str) -> Result<Map<String, Value>, (String, String)> {
    match intent.payload.get(key) {
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err((
            "bad_payload".to_string(),
            format!("'{key}' must be an object"),
        )),
        None => Err(("bad_payload".to_string(), format!("missing '{key}'"))),
    }
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/agents/session test double).
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
fn subscribe_returns_the_default_snapshot_identically_to_every_subscriber() {
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());

    let snap_a = projector.subscribe(SETTINGS_REGION, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(SETTINGS_REGION, "sub-b", "B", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "settings");
    assert_eq!(snap_a.view["version"], json!("1"));
    assert_eq!(snap_a.view["powerMonitoringEnabled"], json!(true));
}

#[test]
fn a_settings_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(SETTINGS_REGION, "sub-a", "A", sink_a.clone());
    projector.subscribe(SETTINGS_REGION, "sub-b", "B", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "settings.patch",
        json!({ "patch": { "theme": "light", "fontSize": 16 } }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: SETTINGS_REGION.to_string(),
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
    assert_eq!(cache_a.view["theme"], json!("light"));
    assert_eq!(cache_a.view["fontSize"], json!(16));
}

#[test]
fn a_full_settings_lifecycle_advances_monotonically_and_converges() {
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(SETTINGS_REGION, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // replace (whole save) → patch a field → patch another → reset. Each
    // accepted intent that changes the view = one diff.
    for kind_payload in [
        (
            "settings.replace",
            json!({ "settings": { "version": "1", "theme": "dark", "fontSize": 12 } }),
        ),
        ("settings.patch", json!({ "patch": { "fontSize": 18 } })),
        (
            "settings.patch",
            json!({ "patch": { "cursorBlink": true } }),
        ),
        ("settings.reset", json!({})),
    ] {
        let ack = dispatcher.dispatch(intent(kind_payload.0, kind_payload.1));
        assert_eq!(
            ack.status,
            IntentStatus::Accepted,
            "{} accepted",
            kind_payload.0
        );
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 4, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 4);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    // reset returned the document to the default baseline.
    assert_eq!(cache.view, SettingsStore::new().snapshot());
}

#[test]
fn an_intent_missing_its_object_is_rejected_without_advancing() {
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SETTINGS_REGION, "sub", "A", sink.clone());

    // Missing `patch` field.
    let ack = dispatcher.dispatch(intent("settings.patch", json!({})));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    // Non-object `settings` field.
    let ack2 = dispatcher.dispatch(intent("settings.replace", json!({ "settings": "nope" })));
    assert_eq!(ack2.status, IntentStatus::Rejected);
    assert_eq!(ack2.error.unwrap().code, "bad_payload");

    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(SETTINGS_REGION), Some(0));
}

#[test]
fn a_no_op_intent_advances_nothing() {
    // A patch that sets keys to their current values leaves the view unchanged,
    // so the projector coalesces it to no diff and no version bump.
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(SETTINGS_REGION, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "settings.patch",
        json!({ "patch": { "powerMonitoringEnabled": true } }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(SETTINGS_REGION), Some(0));
}

// ── Server-authority fold (#2386, prerequisite for #2227) ─────────────────────
//
// These drive the *production* `fold_settings_from_manager` end to end against a
// `tauri::test::mock_app()` carrying the same managed state `lib.rs::setup()`
// wires: a real `ConnectionManager` (backed by a temp dir), an
// `Arc<SettingsStore>`, and a `ProjectionState`. They prove the store is fed
// **server-side** — the instant a `save_settings` lands in the persisted manager
// authority — with no `settings.*` client dispatch, and that the store reflects
// the manager's *resolved* `AppSettings` document (serial-port-scan prefixes and
// all), not the default baseline.

/// A `ConnectionManager` backed by a fresh temp dir with a null credential store.
/// Returns the manager and the `TempDir` guard (kept alive for the test's span).
fn test_manager() -> (ConnectionManager, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let manager =
        ConnectionManager::new_for_test(dir.path(), Arc::new(crate::credential::NullStore))
            .unwrap();
    (manager, dir)
}

/// Wire a mock app with the managed state `setup()` builds for the settings
/// region: the manager, the store, and a `ProjectionState` whose `settings`
/// region is registered and has one `VecSink` subscribed. Returns the app, the
/// store, the sink, and the subscribe-time client cache.
#[allow(clippy::type_complexity)]
fn wire_app(
    manager: ConnectionManager,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    Arc<SettingsStore>,
    Arc<VecSink>,
    ClientCache,
) {
    let app = tauri::test::mock_app();
    app.manage(manager);

    let store = Arc::new(SettingsStore::new());
    app.manage(store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SETTINGS_REGION, store.snapshot());
    let sink = Arc::new(VecSink::new());
    let snap = projection
        .projector
        .subscribe(SETTINGS_REGION, "sub", "C", sink.clone());
    let cache = ClientCache::from_snapshot(&snap);
    app.manage(projection);

    (app, store, sink, cache)
}

/// A backend-produced whole-document `save_settings` folded server-side replaces
/// the document in the shared store and fans exactly one `settings` region diff
/// out — with no `settings.*` client dispatch. The store reflects the persisted
/// authority, proving the fold feeds the store at the source.
#[test]
fn server_side_settings_save_folds_into_store_and_region_without_client_dispatch() {
    let (manager, _dir) = test_manager();
    let (app, store, sink, mut cache) = wire_app(manager);

    // Persist a whole-document save through the real manager authority.
    let manager = app.state::<ConnectionManager>();
    let mut settings = manager.get_settings();
    settings.theme = Some("light".to_string());
    settings.font_size = Some(20);
    manager
        .save_settings(settings)
        .expect("manager persists the settings");

    // No `settings.*` intent is dispatched — the fold feeds the store at the
    // source, from the persisted authority.
    fold_settings_from_manager(app.handle());

    // The store is authoritative server-side and carries the saved document.
    assert_eq!(store.get("theme"), Some(json!("light")));
    assert_eq!(store.get("fontSize"), Some(json!(20)));

    // Exactly one region diff fanned out; the client cache converges on the store
    // (which equals the manager's resolved snapshot) with no round-trip.
    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "one diff from the server-side fold");
    cache.apply(&diffs[0]);
    assert_eq!(cache.view, store.snapshot(), "cache converges on authority");
    assert_eq!(cache.view["theme"], json!("light"));
    assert_eq!(cache.view["fontSize"], json!(20));
}

/// The fold reflects the manager's **resolved** document, not its raw storage:
/// `serial_port_scan_prefixes` is `None` in storage after a plain save, but the
/// fold reflects the concrete built-in default list the frontend receives from
/// `get_settings` — proving `get_settings_resolved` is the single source shared
/// by the command and the fold.
#[test]
fn server_side_fold_reflects_the_resolved_settings_document() {
    let (manager, _dir) = test_manager();
    let (app, store, sink, _cache) = wire_app(manager);

    let manager = app.state::<ConnectionManager>();
    // A plain save leaves `serial_port_scan_prefixes` unset in storage.
    let settings = manager.get_settings();
    assert!(settings.serial_port_scan_prefixes.is_none());
    manager.save_settings(settings).unwrap();

    fold_settings_from_manager(app.handle());

    // The store carries the resolved (non-empty) prefixes, not `null`/absent.
    let prefixes = store
        .get("serialPortScanPrefixes")
        .expect("prefixes present");
    assert!(
        prefixes.as_array().map(|a| !a.is_empty()).unwrap_or(false),
        "the fold reflects the resolved default prefix list, got {prefixes:?}"
    );
    assert_eq!(sink.diffs().len(), 1, "one diff from the server-side fold");
}

/// A shell-integration install / uninstall (`install_shell_integration` /
/// `uninstall_shell_integration`) persists the updated `shell_integration` block
/// through the manager and then folds server-side (#2407). This drives the same
/// path: persist a shell-integration change through the real manager authority,
/// fold, and assert the `settings` region reflects the `shellIntegration` block
/// — the region no longer depends on the frontend's follow-up `settings.patch`.
///
/// The real commands are not called directly here: `registry::register` /
/// `unregister` perform OS-level context-menu writes, so this asserts the fold
/// (the additive part of #2407) reflects the persisted shell-integration outcome,
/// mirroring how the `save_settings` fold is verified above.
#[test]
fn server_side_fold_reflects_shell_integration_install_and_uninstall() {
    let (manager, _dir) = test_manager();
    let (app, store, sink, _cache) = wire_app(manager);
    let manager = app.state::<ConnectionManager>();

    // Baseline: the store starts on the frontend default document, which has no
    // `shellIntegration` block until the authority is folded in.
    assert_eq!(store.get("shellIntegration"), None);

    // Install: persist the registered outcome (as `install_shell_integration`
    // does after `registry::register`), then fold — no `settings.*` dispatch.
    let mut settings = manager.get_settings();
    settings.shell_integration.registered = true;
    settings.shell_integration.registered_exe_path = Some("/opt/termihub".to_string());
    manager.save_settings(settings).unwrap();
    fold_settings_from_manager(app.handle());

    assert_eq!(
        store.get("shellIntegration").unwrap()["registered"],
        json!(true)
    );
    assert_eq!(
        store.get("shellIntegration").unwrap()["registeredExePath"],
        json!("/opt/termihub")
    );

    // Uninstall: persist the unregistered outcome, then fold again.
    let mut settings = manager.get_settings();
    settings.shell_integration.registered = false;
    settings.shell_integration.registered_exe_path = None;
    manager.save_settings(settings).unwrap();
    fold_settings_from_manager(app.handle());

    assert_eq!(
        store.get("shellIntegration").unwrap()["registered"],
        json!(false)
    );

    // Each fold that changed the document fanned exactly one region diff out to
    // the subscriber with no client dispatch: install + uninstall = two.
    assert_eq!(
        sink.diffs().len(),
        2,
        "install and uninstall each fold one region diff, server-side"
    );
}

/// The fold is a best-effort no-op when the required state is not managed (e.g. a
/// headless harness that never ran `setup()`) — it must not panic.
#[test]
fn server_side_fold_is_a_noop_without_managed_state() {
    let app = tauri::test::mock_app();
    // Nothing managed — reaching the assert without panicking is the contract.
    fold_settings_from_manager(app.handle());
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = Arc::new(SettingsStore::new());
    let projector = Arc::new(Projector::new());
    projector.register_region(SETTINGS_REGION, store.snapshot());
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(SETTINGS_REGION, "live", "A", live.clone());
    projector.subscribe(SETTINGS_REGION, "dead", "B", dead.clone());
    assert_eq!(projector.subscriber_count(SETTINGS_REGION), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "settings.patch",
        json!({ "patch": { "theme": "light" } }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(SETTINGS_REGION),
        1,
        "the dead subscriber was reaped"
    );
}
