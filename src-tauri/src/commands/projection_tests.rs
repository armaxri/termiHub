//! Window-bound client identity for the projection commands (TAURI-012, #3444).
//!
//! Drives the transport-neutral `*_as` methods the Tauri commands delegate to,
//! with window labels standing in for the invoking `WebviewWindow`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::ProjectionState;
use crate::projection::{
    ClientIdentityError, HandlerRegistry, Intent, IntentStatus, ProducedRegion, ProjectionError,
    ProjectionFrame, ProjectionSink,
};

/// Records every frame delivered to it.
#[derive(Default)]
struct RecordingSink(Mutex<Vec<ProjectionFrame>>);

impl RecordingSink {
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl ProjectionSink for RecordingSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        self.0.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

/// A projection state with one client-scoped route, `note.set`, which writes
/// the payload into `note@<intent.client_id>` — the shape every real
/// client-scoped domain (layout, file-browser, broadcast, …) uses.
fn state() -> ProjectionState {
    let mut registry = HandlerRegistry::new();
    registry.route("note.set", |intent: &Intent, projector| {
        let region = format!("note@{}", intent.client_id);
        let version = projector
            .publish(&region, intent.payload.clone())
            .unwrap_or(0);
        Ok(vec![ProducedRegion { region, version }])
    });
    ProjectionState::with_handler(Arc::new(registry))
}

fn intent(client_id: &str, payload: Value) -> Intent {
    Intent {
        intent_id: format!("i-{client_id}"),
        kind: "note.set".to_string(),
        payload,
        client_id: client_id.to_string(),
    }
}

fn sink() -> Arc<RecordingSink> {
    Arc::new(RecordingSink::default())
}

#[test]
fn single_window_flow_is_unchanged() {
    let s = state();
    let rec = sink();
    let snap = s
        .subscribe_as(
            "main",
            "note@client-A",
            "sub-1".into(),
            "client-A".into(),
            rec.clone(),
        )
        .expect("owner subscribes to its own region");
    assert_eq!(snap.view, Value::Null);

    let ack = s.dispatch_as("main", intent("client-A", json!({ "text": "hi" })));
    assert_eq!(ack.status, IntentStatus::Accepted);
    assert_eq!(rec.count(), 1, "owner receives the diff");

    let resynced = s.resync_as("main", "note@client-A", Some(0)).unwrap();
    assert_eq!(resynced.map(|f| f.view), Some(json!({ "text": "hi" })));

    s.unsubscribe_as("main", "note@client-A", "sub-1").unwrap();
    assert_eq!(s.projector.subscriber_count("note@client-A"), 0);
}

#[test]
fn intent_with_another_windows_client_id_is_rejected() {
    let s = state();
    assert_eq!(
        s.dispatch_as("main", intent("client-A", json!(1))).status,
        IntentStatus::Accepted
    );

    let ack = s.dispatch_as("win-1", intent("client-A", json!("forged")));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(
        ack.error.map(|e| e.code),
        Some("client_identity_mismatch".to_string())
    );
    // The handler never ran: the victim's region is untouched.
    assert_eq!(s.projector.snapshot("note@client-A").view, json!(1));
}

#[test]
fn empty_client_id_is_rejected() {
    let s = state();
    let ack = s.dispatch_as("main", intent("", json!(1)));
    assert_eq!(ack.status, IntentStatus::Rejected);
    assert_eq!(
        ack.error.map(|e| e.code),
        Some("invalid_client_id".to_string())
    );
}

#[test]
fn subscribing_to_another_windows_region_is_rejected() {
    let s = state();
    assert_eq!(
        s.dispatch_as("main", intent("client-A", json!("secret")))
            .status,
        IntentStatus::Accepted
    );

    // Asserting its own client id does not unlock A's scoped region…
    let err = s
        .subscribe_as(
            "win-1",
            "note@client-A",
            "sub-x".into(),
            "client-B".into(),
            sink(),
        )
        .unwrap_err();
    assert!(matches!(err, ClientIdentityError::NotOwner { .. }));
    // …nor does asserting A's client id outright.
    assert!(s
        .subscribe_as(
            "win-1",
            "tunnels",
            "sub-y".into(),
            "client-A".into(),
            sink()
        )
        .is_err());
    // …and a scoped snapshot cannot be read via resync either.
    assert!(s.resync_as("win-1", "note@client-A", None).is_err());
    assert_eq!(s.projector.subscriber_count("note@client-A"), 0);
    assert_eq!(s.projector.subscriber_count("tunnels"), 0);
}

#[test]
fn a_window_cannot_detach_or_hijack_another_windows_subscription() {
    let s = state();
    let victim = sink();
    s.subscribe_as(
        "main",
        "tunnels",
        "sub-1".into(),
        "client-A".into(),
        victim.clone(),
    )
    .unwrap();

    // Same subscription id, own client: attaches beside, never replaces.
    s.subscribe_as(
        "win-1",
        "tunnels",
        "sub-1".into(),
        "client-B".into(),
        sink(),
    )
    .unwrap();
    assert_eq!(s.projector.subscriber_count("tunnels"), 2);

    // Unsubscribing that id removes only win-1's own subscription.
    s.unsubscribe_as("win-1", "tunnels", "sub-1").unwrap();
    s.unsubscribe_as("win-1", "tunnels", "sub-1").unwrap(); // idempotent
    assert_eq!(s.projector.subscriber_count("tunnels"), 1);

    s.projector.publish("tunnels", json!({ "n": 1 }));
    assert_eq!(victim.count(), 1, "main keeps its diff stream");

    // A scoped region of another window cannot be targeted at all.
    s.subscribe_as(
        "main",
        "note@client-A",
        "sub-2".into(),
        "client-A".into(),
        sink(),
    )
    .unwrap();
    assert!(s.unsubscribe_as("win-1", "note@client-A", "sub-2").is_err());
    assert_eq!(s.projector.subscriber_count("note@client-A"), 1);
}

#[test]
fn two_windows_share_shared_regions_but_keep_scoped_regions_isolated() {
    let s = state();
    let (main_shared, win_shared) = (sink(), sink());
    let (main_note, win_note) = (sink(), sink());
    s.subscribe_as(
        "main",
        "tunnels",
        "m-1".into(),
        "client-A".into(),
        main_shared.clone(),
    )
    .unwrap();
    s.subscribe_as(
        "win-1",
        "tunnels",
        "w-1".into(),
        "client-B".into(),
        win_shared.clone(),
    )
    .unwrap();
    s.subscribe_as(
        "main",
        "note@client-A",
        "m-2".into(),
        "client-A".into(),
        main_note.clone(),
    )
    .unwrap();
    s.subscribe_as(
        "win-1",
        "note@client-B",
        "w-2".into(),
        "client-B".into(),
        win_note.clone(),
    )
    .unwrap();

    s.projector.publish("tunnels", json!({ "up": true }));
    assert_eq!((main_shared.count(), win_shared.count()), (1, 1));

    assert_eq!(
        s.dispatch_as("main", intent("client-A", json!("a"))).status,
        IntentStatus::Accepted
    );
    assert_eq!(
        s.dispatch_as("win-1", intent("client-B", json!("b")))
            .status,
        IntentStatus::Accepted
    );
    assert_eq!((main_note.count(), win_note.count()), (1, 1));
}

#[test]
fn destroying_a_window_releases_its_identities_and_subscriptions() {
    let s = state();
    s.subscribe_as("win-1", "tunnels", "w-1".into(), "client-B".into(), sink())
        .unwrap();
    s.subscribe_as(
        "win-1",
        "note@client-B",
        "w-2".into(),
        "client-B".into(),
        sink(),
    )
    .unwrap();
    s.subscribe_as("main", "tunnels", "m-1".into(), "client-A".into(), sink())
        .unwrap();

    assert_eq!(s.release_principal("win-1"), 2);
    assert_eq!(s.projector.subscriber_count("tunnels"), 1);
    assert_eq!(s.projector.subscriber_count("note@client-B"), 0);
    assert_eq!(s.identities.owner_of("client-B"), None);
    assert_eq!(s.identities.owner_of("client-A").as_deref(), Some("main"));
}
