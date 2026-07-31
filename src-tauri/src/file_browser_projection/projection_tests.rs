//! Projection-contract tests for the client-scoped `file-browser@<clientId>`
//! region (#2228), reusing the substrate harness (#2164): an in-memory
//! [`VecSink`] and a client cache that applies diffs. The routes here drive a
//! real [`FileBrowserStore`] directly through the **production** parse helpers
//! ([`super`]), the exact parse → mutate → publish path
//! `register_file_browser_intents` runs (that thin wiring only differs in
//! resolving the store from the Tauri `AppHandle`; it is integration-verified via
//! a local `./scripts/dev.sh` run).
//!
//! Asserted: subscribe → snapshot (identical to every subscriber), an accepted
//! intent → exactly one coalesced diff fanned to every subscriber with monotonic
//! versions, client-scoped isolation, rejection paths advance nothing, a no-op
//! intent coalesces to nothing, a dead subscriber is reaped, and the client cache
//! converges on the store's authority across a full browsing session.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{
    optional_str, parse_clipboard, parse_entries, parse_mode, parse_pane, parse_view, required_str,
};
use crate::file_browser_projection::projection::{file_browser_region, publish_file_browser};
use crate::file_browser_projection::store::FileBrowserStore;
use crate::projection::{
    apply_ops, DiffFrame, Dispatcher, HandlerRegistry, Intent, IntentStatus, ProjectionError,
    ProjectionFrame, ProjectionSink, Projector, SnapshotFrame,
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// The production `fileBrowser.*` routes, bound to an injected store instead of
/// resolving one from an `AppHandle` — the exact parse → mutate → publish path
/// `register_file_browser_intents` runs, reusing its parse helpers verbatim.
fn registry_for(store: Arc<FileBrowserStore>) -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();

    let s = store.clone();
    registry.route("fileBrowser.setMode", move |intent, projector| {
        s.set_mode(&intent.client_id, parse_mode(intent)?);
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("fileBrowser.loadStarted", move |intent, projector| {
        s.load_started(&intent.client_id, parse_pane(intent)?);
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("fileBrowser.loadSucceeded", move |intent, projector| {
        let pane = parse_pane(intent)?;
        let path = required_str(intent, "path")?;
        let entries = parse_entries(intent)?;
        s.load_succeeded(&intent.client_id, pane, &path, entries);
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("fileBrowser.loadFailed", move |intent, projector| {
        let pane = parse_pane(intent)?;
        s.load_failed(&intent.client_id, pane, optional_str(intent, "error"));
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("fileBrowser.reset", move |intent, projector| {
        s.reset_pane(&intent.client_id, parse_pane(intent)?);
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    let s = store.clone();
    registry.route("fileBrowser.setClipboard", move |intent, projector| {
        s.set_clipboard(&intent.client_id, parse_clipboard(intent)?);
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    let s = store;
    registry.route("fileBrowser.replace", move |intent, projector| {
        s.replace(&intent.client_id, parse_view(intent)?);
        Ok(publish_file_browser(projector, &s, &intent.client_id))
    });

    registry
}

/// A file-entry payload object (mirrors the frontend `FileEntry` JSON).
fn entry_json(name: &str, is_directory: bool) -> Value {
    json!({
        "name": name,
        "path": format!("/{name}"),
        "isDirectory": is_directory,
        "size": 0,
        "modified": "",
        "permissions": null,
        "writable": null,
    })
}

/// An in-memory sink recording delivered frames; can be killed to simulate a
/// dead subscriber (mirrors the substrate/broadcast/layout test double).
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

fn intent(kind: &str, client: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("01J-{kind}"),
        kind: kind.to_string(),
        payload,
        client_id: client.to_string(),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_returns_the_idle_baseline_identically_to_every_subscriber() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));

    let snap_a = projector.subscribe(&region, "sub-a", "A", Arc::new(VecSink::new()));
    let snap_b = projector.subscribe(&region, "sub-b", "A", Arc::new(VecSink::new()));

    assert_eq!(snap_a.version, 0);
    assert_eq!(snap_a, snap_b, "a late joiner gets an identical baseline");
    assert_eq!(snap_a.region, "file-browser@A");
    assert_eq!(snap_a.view["mode"], json!("none"));
    assert_eq!(snap_a.view["local"]["path"], json!("/"));
    assert_eq!(snap_a.view["clipboard"], Value::Null);
}

#[test]
fn a_load_succeeded_intent_produces_one_diff_fanned_to_two_subscribers() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub-a", "A", sink_a.clone());
    projector.subscribe(&region, "sub-b", "A", sink_b.clone());
    let mut cache_a = ClientCache::from_snapshot(&snap);

    let ack = dispatcher.dispatch(intent(
        "fileBrowser.loadSucceeded",
        "A",
        json!({ "pane": "sftp", "path": "/var", "entries": [entry_json("log", true)] }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(
        ack.produced,
        Some(vec![crate::projection::ProducedRegion {
            region: region.clone(),
            version: 1,
        }])
    );

    let diffs_a = sink_a.diffs();
    let diffs_b = sink_b.diffs();
    assert_eq!(diffs_a.len(), 1, "exactly one diff to A");
    assert_eq!(diffs_b.len(), 1, "exactly one diff to B");
    assert_eq!(diffs_a[0], diffs_b[0], "identical diff to every subscriber");

    cache_a.apply(&diffs_a[0]);
    assert_eq!(cache_a.view, store.snapshot("A"), "cache converges");
    assert_eq!(cache_a.view["sftp"]["path"], json!("/var"));
    assert_eq!(cache_a.view["sftp"]["entries"][0]["name"], json!("log"));
}

#[test]
fn a_full_browsing_session_advances_monotonically_and_converges() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // setMode(local) → loadStarted → loadSucceeded → copy to clipboard → reset.
    for (kind, payload) in [
        ("fileBrowser.setMode", json!({ "mode": "local" })),
        ("fileBrowser.loadStarted", json!({ "pane": "local" })),
        (
            "fileBrowser.loadSucceeded",
            json!({ "pane": "local", "path": "/home", "entries": [entry_json("a", false)] }),
        ),
        (
            "fileBrowser.setClipboard",
            json!({ "clipboard": {
                "entries": [entry_json("a", false)],
                "operation": "copy",
                "sourceMode": "local",
                "sourcePath": "/home",
                "sftpSessionId": null,
            }}),
        ),
        ("fileBrowser.reset", json!({ "pane": "local" })),
    ] {
        let ack = dispatcher.dispatch(intent(kind, "A", payload));
        assert_eq!(ack.status, IntentStatus::Accepted, "{kind} accepted");
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 5, "one diff per view-changing intent");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.version, 5);
    assert_eq!(
        cache.view,
        store.snapshot("A"),
        "cache converges on authority"
    );
    // reset returned the pane to baseline; the clipboard copy persisted.
    assert_eq!(cache.view["local"]["path"], json!("/"));
    assert_eq!(cache.view["local"]["entries"], json!([]));
    assert_eq!(cache.view["clipboard"]["operation"], json!("copy"));
    assert_eq!(cache.view["mode"], json!("local"));
}

#[test]
fn a_replace_seed_produces_one_diff_that_converges_on_the_whole_view() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    // The render-cut mirror seeds the whole slice in a single intent.
    let ack = dispatcher.dispatch(intent(
        "fileBrowser.replace",
        "A",
        json!({
            "mode": "sftp",
            "local": { "path": "/home", "entries": [entry_json("a", false)], "loading": false, "error": null },
            "sftp": { "path": "/var", "entries": [entry_json("log", true)], "loading": true, "error": null },
            "session": { "path": "/", "entries": [], "loading": false, "error": null },
            "clipboard": null,
        }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 1, "the whole-slice seed is one coalesced diff");
    cache.apply(&diffs[0]);
    assert_eq!(
        cache.view,
        store.snapshot("A"),
        "cache converges on authority"
    );
    assert_eq!(cache.view["mode"], json!("sftp"));
    assert_eq!(cache.view["local"]["entries"][0]["name"], json!("a"));
    assert_eq!(cache.view["sftp"]["path"], json!("/var"));
    assert_eq!(cache.view["sftp"]["loading"], json!(true));

    // Re-seeding with identical content is idempotent — no second diff.
    let ack2 = dispatcher.dispatch(intent(
        "fileBrowser.replace",
        "A",
        json!({
            "mode": "sftp",
            "local": { "path": "/home", "entries": [entry_json("a", false)], "loading": false, "error": null },
            "sftp": { "path": "/var", "entries": [entry_json("log", true)], "loading": true, "error": null },
            "session": { "path": "/", "entries": [], "loading": false, "error": null },
            "clipboard": null,
        }),
    ));
    assert_eq!(ack2.status, IntentStatus::Accepted);
    assert_eq!(
        ack2.produced,
        Some(vec![]),
        "an identical re-seed is a no-op"
    );
    assert_eq!(sink.diffs().len(), 1, "no second diff");
}

#[test]
fn browser_state_is_isolated_to_its_client_region() {
    let store = Arc::new(FileBrowserStore::new());
    let region_a = file_browser_region("A");
    let region_b = file_browser_region("B");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region_a, store.snapshot("A"));
    projector.register_region(&region_b, store.snapshot("B"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let sink_a = Arc::new(VecSink::new());
    let sink_b = Arc::new(VecSink::new());
    projector.subscribe(&region_a, "sa", "A", sink_a.clone());
    projector.subscribe(&region_b, "sb", "B", sink_b.clone());

    dispatcher.dispatch(intent(
        "fileBrowser.loadSucceeded",
        "A",
        json!({ "pane": "local", "path": "/a", "entries": [] }),
    ));

    assert_eq!(sink_a.diffs().len(), 1, "A's region advanced");
    assert_eq!(sink_b.diffs().len(), 0, "B's region untouched");
    assert_eq!(projector.region_version(&region_b), Some(0));
}

#[test]
fn an_intent_with_an_invalid_pane_is_rejected_without_advancing() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    // "none" is not a valid concrete pane target for loadStarted.
    let ack = dispatcher.dispatch(intent(
        "fileBrowser.loadStarted",
        "A",
        json!({ "pane": "none" }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_missing_entries_listing_is_rejected_without_advancing() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    let ack = dispatcher.dispatch(intent(
        "fileBrowser.loadSucceeded",
        "A",
        json!({ "pane": "local", "path": "/x" }),
    ));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(ack.error.unwrap().code, "bad_payload");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_no_op_set_mode_advances_nothing() {
    // Re-setting the mode to its current value leaves the view unchanged, so the
    // projector coalesces it to no diff and no version bump.
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    projector.subscribe(&region, "sub", "A", sink.clone());

    // The baseline mode is already "none"; setting it to "none" is a no-op.
    let ack = dispatcher.dispatch(intent(
        "fileBrowser.setMode",
        "A",
        json!({ "mode": "none" }),
    ));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(ack.produced, Some(vec![]), "no region advanced");
    assert_eq!(sink.diffs().len(), 0);
    assert_eq!(projector.region_version(&region), Some(0));
}

#[test]
fn a_set_clipboard_then_clear_round_trips_through_the_region() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));
    let sink = Arc::new(VecSink::new());
    let snap = projector.subscribe(&region, "sub", "A", sink.clone());
    let mut cache = ClientCache::from_snapshot(&snap);

    for payload in [
        json!({ "clipboard": {
            "entries": [entry_json("d", true)],
            "operation": "cut",
            "sourceMode": "session",
            "sourcePath": "/r",
            "terminalSessionId": "t-1",
        }}),
        json!({ "clipboard": null }),
    ] {
        let ack = dispatcher.dispatch(intent("fileBrowser.setClipboard", "A", payload));
        assert_eq!(ack.status, IntentStatus::Accepted);
    }

    let diffs = sink.diffs();
    assert_eq!(diffs.len(), 2, "set then clear each produced a diff");
    for diff in &diffs {
        cache.apply(diff);
    }
    assert_eq!(cache.view, store.snapshot("A"), "cache converges");
    assert_eq!(cache.view["clipboard"], Value::Null);
}

#[test]
fn a_dead_subscriber_is_reaped_on_publish() {
    let store = Arc::new(FileBrowserStore::new());
    let region = file_browser_region("A");
    let projector = Arc::new(Projector::new());
    projector.register_region(&region, store.snapshot("A"));
    let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry_for(store.clone())));

    let live = Arc::new(VecSink::new());
    let dead = Arc::new(VecSink::new());
    projector.subscribe(&region, "live", "A", live.clone());
    projector.subscribe(&region, "dead", "A", dead.clone());
    assert_eq!(projector.subscriber_count(&region), 2);

    dead.alive.store(false, Ordering::SeqCst);
    dispatcher.dispatch(intent(
        "fileBrowser.setMode",
        "A",
        json!({ "mode": "sftp" }),
    ));

    assert_eq!(
        live.diffs().len(),
        1,
        "the live subscriber still gets the diff"
    );
    assert_eq!(
        projector.subscriber_count(&region),
        1,
        "the dead subscriber was reaped"
    );
}
