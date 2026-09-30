//! Unknown per-entry fields across the network manager's save paths (#3951,
//! part of #2744).
//!
//! A WoL device or HTTP monitor that a newer build wrote may carry fields this
//! build does not know. The UI's copy of an entry never has them, so a save
//! that replaces the entry with that copy must keep the fields the entry had
//! on disk.

use serde_json::{json, Value};
use tempfile::TempDir;

use super::http_monitor::HttpMonitorConfig;
use super::{http_monitor_storage, wol_storage, NetworkManager};
use termihub_core::network::WolDevice;

fn manager_with_config_dir(dir: &std::path::Path) -> NetworkManager {
    let mut mgr = NetworkManager::new();
    mgr.config_dir = dir.to_path_buf();
    mgr
}

fn saved_entries(dir: &std::path::Path, file: &str, field: &str) -> Vec<Value> {
    let raw = std::fs::read_to_string(dir.join(file)).unwrap();
    let saved: Value = serde_json::from_str(&raw).unwrap();
    saved[field].as_array().unwrap().clone()
}

fn device_json(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "mac": "AA:BB:CC:DD:EE:FF",
        "broadcast": "255.255.255.255",
        "port": 9,
    })
}

fn monitor_json(id: &str, url: &str) -> Value {
    json!({
        "id": id,
        "url": url,
        "intervalMs": 30_000,
        "method": "GET",
        "expectedStatus": 200,
        "timeoutMs": 5_000,
    })
}

/// A manager whose in-memory WoL list was loaded from a file holding one
/// device with an unknown field.
fn wol_manager_with_future_device(dir: &TempDir) -> NetworkManager {
    let mut entry = device_json("d1", "NAS");
    entry["futureField"] = json!({"nested": true});
    let raw = json!({"version": "1", "devices": [entry]});
    std::fs::write(dir.path().join("wol-devices.json"), raw.to_string()).unwrap();

    let mgr = manager_with_config_dir(dir.path());
    *mgr.wol_devices.lock().unwrap() = wol_storage::load_wol_devices(dir.path()).unwrap();
    mgr
}

#[test]
fn editing_a_wol_device_keeps_its_unknown_fields() {
    let dir = TempDir::new().unwrap();
    let mgr = wol_manager_with_future_device(&dir);

    // The editor's copy, as it arrives over IPC: no unknown fields.
    let edited: WolDevice = serde_json::from_value(device_json("d1", "Renamed")).unwrap();
    mgr.save_wol_device(edited).unwrap();

    let saved = saved_entries(dir.path(), "wol-devices.json", "devices");
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["name"], "Renamed");
    assert_eq!(saved[0]["futureField"], json!({"nested": true}));
}

#[test]
fn saving_another_wol_device_keeps_the_first_ones_unknown_fields() {
    let dir = TempDir::new().unwrap();
    let mgr = wol_manager_with_future_device(&dir);

    let added: WolDevice = serde_json::from_value(device_json("d2", "Desk")).unwrap();
    mgr.save_wol_device(added).unwrap();
    mgr.delete_wol_device("d2").unwrap();

    let saved = saved_entries(dir.path(), "wol-devices.json", "devices");
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["futureField"], json!({"nested": true}));
}

/// Unknown keys on the IPC copy are frontend state, not a newer build's data:
/// they are never written to disk.
#[test]
fn ipc_only_wol_keys_are_not_persisted() {
    let dir = TempDir::new().unwrap();
    let mgr = wol_manager_with_future_device(&dir);

    let mut edited = device_json("d1", "Renamed");
    edited["frontendOnly"] = json!(1);
    let mut added = device_json("d2", "Desk");
    added["frontendOnly"] = json!(1);
    mgr.save_wol_device(serde_json::from_value(edited).unwrap())
        .unwrap();
    mgr.save_wol_device(serde_json::from_value(added).unwrap())
        .unwrap();

    let saved = saved_entries(dir.path(), "wol-devices.json", "devices");
    assert_eq!(saved.len(), 2);
    assert!(saved.iter().all(|d| d.get("frontendOnly").is_none()));
    assert_eq!(saved[0]["futureField"], json!({"nested": true}));
}

fn write_future_monitor(dir: &TempDir) {
    let mut entry = monitor_json("m1", "https://a.example.com");
    entry["futureField"] = json!([1, 2]);
    let raw = json!({"version": "1", "monitors": [entry]});
    std::fs::write(dir.path().join("http-monitors.json"), raw.to_string()).unwrap();
}

#[test]
fn re_persisting_a_monitor_keeps_its_unknown_fields() {
    let dir = TempDir::new().unwrap();
    write_future_monitor(&dir);
    let mgr = manager_with_config_dir(dir.path());

    // The UI's copy (e.g. a restart of the listed monitor), as sent over IPC.
    let mut copy = monitor_json("m1", "https://a.example.com");
    copy["frontendOnly"] = json!(true);
    let copy: HttpMonitorConfig = serde_json::from_value(copy).unwrap();
    mgr.persist_monitor_config(copy).unwrap();

    let saved = saved_entries(dir.path(), "http-monitors.json", "monitors");
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["futureField"], json!([1, 2]));
    assert!(saved[0].get("frontendOnly").is_none());
}

#[test]
fn adding_and_removing_a_monitor_keeps_the_others_unknown_fields() {
    let dir = TempDir::new().unwrap();
    write_future_monitor(&dir);
    let mgr = manager_with_config_dir(dir.path());

    let mut added = monitor_json("m2", "https://b.example.com");
    added["frontendOnly"] = json!(true);
    mgr.persist_monitor_config(serde_json::from_value(added).unwrap())
        .unwrap();
    let saved = saved_entries(dir.path(), "http-monitors.json", "monitors");
    assert_eq!(saved.len(), 2);
    assert!(saved[1].get("frontendOnly").is_none());

    mgr.remove_persisted_monitor_config("m2").unwrap();
    let saved = saved_entries(dir.path(), "http-monitors.json", "monitors");
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["futureField"], json!([1, 2]));
    let loaded = http_monitor_storage::load_http_monitors(dir.path()).unwrap();
    assert_eq!(loaded.len(), 1);
}
