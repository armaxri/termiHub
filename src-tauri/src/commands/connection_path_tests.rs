//! Tests for the connection-path probe registry and its wire payloads (#5168).

use serde_json::json;
use tauri::Manager;

use super::*;

#[test]
fn hop_status_maps_to_the_frontend_strings() {
    assert_eq!(status_str(HopStatus::Connecting), "connecting");
    assert_eq!(status_str(HopStatus::Connected), "connected");
    assert_eq!(status_str(HopStatus::Failed), "failed");
}

#[test]
fn payloads_serialize_camel_case() {
    let hop = HopStatusEvent {
        probe_id: "p1".into(),
        index: 1,
        total: 3,
        host: "jump".into(),
        port: 22,
        status: "failed".into(),
        message: "auth".into(),
    };
    assert_eq!(
        serde_json::to_value(hop).unwrap(),
        json!({"probeId": "p1", "index": 1, "total": 3, "host": "jump", "port": 22,
               "status": "failed", "message": "auth"})
    );
    let done = ProbeCompleteEvent {
        probe_id: "p1".into(),
        success: true,
    };
    assert_eq!(
        serde_json::to_value(done).unwrap(),
        json!({"probeId": "p1", "success": true})
    );
}

#[test]
fn cancelling_an_unknown_probe_reports_false() {
    let registry = ProbeRegistry::default();
    assert!(!registry.cancel("nope"));
}

#[test]
fn cancel_trips_the_registered_token() {
    let registry = ProbeRegistry::default();
    let token = registry.register("p1");
    assert!(registry.cancel("p1"));
    assert!(token.is_cancelled());
}

#[test]
fn re_registering_an_id_cancels_the_previous_probe() {
    let registry = ProbeRegistry::default();
    let first = registry.register("p1");
    let second = registry.register("p1");
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
}

#[test]
fn a_stale_probe_completing_leaves_its_replacement_registered() {
    let registry = ProbeRegistry::default();
    let first = registry.register("p1");
    let second = registry.register("p1");

    registry.complete("p1", &first);
    assert!(
        registry.cancel("p1"),
        "the newer probe must stay cancellable"
    );
    assert!(second.is_cancelled());

    registry.complete("p1", &second);
    assert!(!registry.cancel("p1"), "a completed probe is forgotten");
}

#[test]
fn the_cancel_command_reads_the_managed_registry() {
    let app = tauri::test::mock_app();
    app.manage(ProbeRegistry::default());
    let token = app.state::<ProbeRegistry>().register("p1");

    assert!(!cancel_connection_path_probe("nope".into(), app.state::<ProbeRegistry>()).unwrap());
    assert!(cancel_connection_path_probe("p1".into(), app.state::<ProbeRegistry>()).unwrap());
    assert!(token.is_cancelled());
}
