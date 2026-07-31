//! Unit tests for the shadow [`SettingsStore`] transitions (#2227).
//!
//! Drives the store directly and asserts on the serialised view model: the
//! seeded default document, whole-document replace, shallow patch (insert /
//! overwrite / null-set / untouched keys), and reset-to-defaults.

use serde_json::{json, Map, Value};

use super::SettingsStore;

/// Extract a `serde_json::Map` from a JSON object literal (test helper).
fn object(value: Value) -> Map<String, Value> {
    value.as_object().expect("object literal").clone()
}

#[test]
fn a_fresh_store_snapshots_the_default_document() {
    let store = SettingsStore::new();
    let snap = store.snapshot();
    assert_eq!(snap["version"], json!("1"));
    assert_eq!(snap["externalConnectionFiles"], json!([]));
    assert_eq!(snap["powerMonitoringEnabled"], json!(true));
    assert_eq!(snap["fileBrowserEnabled"], json!(true));
    assert_eq!(snap["confirmCloseTabOnShortcut"], json!(true));
    assert_eq!(snap["confirmCloseLiveSession"], json!(true));
    assert_eq!(snap["confirmCloseAttachedTab"], json!(true));
    assert_eq!(snap["askOpenSavedFileInTab"], json!(true));
    assert_eq!(snap["warnLargePortScan"], json!(true));
    assert_eq!(snap["warnLargePingSweep"], json!(true));
    assert_eq!(store.len(), 10);
}

#[test]
fn replace_overwrites_the_whole_document() {
    let store = SettingsStore::new();
    store.replace(object(json!({
        "version": "1",
        "theme": "solarized-dark",
        "fontSize": 16,
        "powerMonitoringEnabled": false,
    })));

    let snap = store.snapshot();
    assert_eq!(snap["theme"], json!("solarized-dark"));
    assert_eq!(snap["fontSize"], json!(16));
    assert_eq!(snap["powerMonitoringEnabled"], json!(false));
    // Keys not present in the replacement are gone — replace is a full swap, not
    // a merge.
    assert!(snap.get("fileBrowserEnabled").is_none());
    assert_eq!(store.len(), 4);
}

#[test]
fn patch_inserts_and_overwrites_only_the_named_keys() {
    let store = SettingsStore::new();
    store.patch(object(json!({
        "theme": "light",          // insert (absent in the default doc)
        "fileBrowserEnabled": false, // overwrite an existing key
    })));

    let snap = store.snapshot();
    assert_eq!(snap["theme"], json!("light"), "new key inserted");
    assert_eq!(
        snap["fileBrowserEnabled"],
        json!(false),
        "existing key overwritten"
    );
    // Untouched keys survive the shallow merge.
    assert_eq!(snap["powerMonitoringEnabled"], json!(true));
    assert_eq!(snap["version"], json!("1"));
}

#[test]
fn patch_with_a_null_value_sets_the_key_to_null_not_delete() {
    // Mirrors the JS `{ ...current, theme: null }` spread, which sets the key to
    // null rather than removing it.
    let store = SettingsStore::new();
    store.patch(object(json!({ "confirmCloseLiveSession": null })));
    assert_eq!(store.get("confirmCloseLiveSession"), Some(Value::Null));
    assert!(
        store
            .snapshot()
            .as_object()
            .unwrap()
            .contains_key("confirmCloseLiveSession"),
        "the key is present-but-null, not removed"
    );
}

#[test]
fn an_empty_patch_leaves_the_document_unchanged() {
    let store = SettingsStore::new();
    let before = store.snapshot();
    store.patch(Map::new());
    assert_eq!(store.snapshot(), before);
}

#[test]
fn reset_restores_the_default_document_after_edits() {
    let store = SettingsStore::new();
    store.replace(object(json!({ "theme": "light", "fontSize": 20 })));
    assert_eq!(store.len(), 2);

    store.reset();
    let snap = store.snapshot();
    assert_eq!(store.len(), 10, "back to the default key set");
    assert_eq!(snap["powerMonitoringEnabled"], json!(true));
    assert!(
        snap.get("theme").is_none(),
        "edited keys are gone after reset"
    );
    assert_eq!(snap, SettingsStore::new().snapshot());
}
