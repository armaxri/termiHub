//! Schema-driven classification of saved-connection secrets (#4289).

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use serde_json::json;
use termihub_core::connection::secrets::TakenSecrets;

const FS: CredentialType = CredentialType::FieldSecrets;

#[test]
fn every_builtin_secret_field_is_classified() {
    // Every secret field of every built-in desktop type, by its schema.
    let registry = crate::session::registry::build_desktop_registry();
    for info in registry.available_types() {
        let expected: &[&str] = match info.type_id.as_str() {
            // The SSH outbound-proxy password (#4867).
            "ssh" => &["password", "proxyPassword"],
            "telnet" | "ftp" | "mock-remote-desktop" => &["password"],
            // The SSH Tunnel group's gateway password (VNC; RDP since #4865)
            // and its outbound-proxy password (#4887).
            "vnc" | "rdp" => &["password", "sshPassword", "sshProxyPassword"],
            _ => &[],
        };
        let classified = schema_keys_in(&registry, &info.type_id).unwrap();
        assert_eq!(classified, expected, "type {}", info.type_id);
        for key in expected {
            assert!(
                secret_keys_for(&info.type_id).iter().any(|k| k == key),
                "{}.{key} is not classified",
                info.type_id
            );
        }
    }
}

#[test]
fn a_plugin_declared_secret_is_classified() {
    let schema = termihub_core::plugin::config_schema_to_settings_schema(&json!({
        "type": "object",
        "properties": {
            "endpoint": { "type": "string" },
            "apiToken": { "type": "string", "writeOnly": true },
            "pin": { "type": "string", "format": "password" }
        }
    }));
    // The same classification secret_keys_for applies to a registered type.
    let keys = with_fallback(secrets::schema_secret_keys(&schema));
    assert_eq!(
        field_secret_keys(&keys),
        vec![
            "apiToken".to_string(),
            "pin".to_string(),
            "sshPassword".to_string(),
            "proxyPassword".to_string(),
            "sshProxyPassword".to_string()
        ]
    );
}

#[test]
fn an_unknown_type_falls_back_to_the_builtin_secret_keys() {
    assert_eq!(
        secret_keys_for("plugin:not-installed:x"),
        vec![
            "password".to_string(),
            "sshPassword".to_string(),
            "proxyPassword".to_string(),
            "sshProxyPassword".to_string()
        ]
    );
}

#[test]
fn storing_merges_over_the_stored_secrets() {
    let store = RecordingStore::default();
    let mut first = TakenSecrets::default();
    first.fields.insert("sshPassword".into(), "gw".into());
    first.hops.insert("u@h:22".into(), "hop".into());
    store_field_secrets(&store, "c", first).unwrap();

    let mut second = TakenSecrets::default();
    second.fields.insert("sshPassword".into(), "gw2".into());
    store_field_secrets(&store, "c", second).unwrap();

    let stored = read_field_secrets(&store, "c").unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some("gw2")
    );
    assert_eq!(stored.hops.get("u@h:22").map(String::as_str), Some("hop"));
    assert!(store.value("c", FS).is_some());
}

#[test]
fn restoring_fills_the_settings_for_a_connect() {
    let store = RecordingStore::with(&[(
        "c",
        FS,
        r#"{"fields":{"sshPassword":"gw"},"hops":{"ops@b:22":"hop"}}"#,
    )]);
    let mut settings = json!({
        "host": "h",
        "proxyJump": [{ "host": "b", "username": "ops" }]
    });
    restore_saved_field_secrets(&store, "c", &mut settings).unwrap();
    assert_eq!(settings["sshPassword"], "gw");
    assert_eq!(settings["proxyJump"][0]["password"], "hop");

    let mut hops = vec![json!({ "host": "b", "username": "ops" })];
    restore_saved_hop_secrets(&store, "c", &mut hops).unwrap();
    assert_eq!(hops[0]["password"], "hop");
}

#[test]
fn exports_carry_no_secret() {
    let settings = json!({
        "host": "h",
        "password": "pw",
        "sshPassword": "gw",
        "proxyJump": [{ "host": "b", "password": "hop" }]
    });
    for type_id in ["vnc", "rdp"] {
        let clean = without_secrets(type_id, &settings);
        let text = clean.to_string();
        for secret in ["pw", "gw", "hop"] {
            assert!(
                !text.contains(&format!("\"{secret}\"")),
                "{type_id}: {text}"
            );
        }
        assert_eq!(clean["host"], "h");
    }
}

#[test]
fn only_connections_that_can_own_field_secrets_touch_the_store() {
    assert!(may_have_field_secrets("vnc", &json!({ "host": "h" })));
    // RDP's SSH Tunnel group owns a field secret too (#4865).
    assert!(may_have_field_secrets("rdp", &json!({ "host": "h" })));
    assert!(may_have_field_secrets(
        "ssh",
        &json!({ "proxyJump": [{ "host": "gw" }] })
    ));
    // Every SSH connection can own an outbound-proxy password (#4867).
    assert!(may_have_field_secrets(
        "ssh",
        &json!({ "host": "h", "authMethod": "key" })
    ));
    assert!(!may_have_field_secrets(
        "telnet",
        &json!({ "proxyJump": [{ "connectionId": "saved" }] })
    ));
    assert!(!may_have_field_secrets("local", &json!({ "shell": "zsh" })));
    assert!(!may_have_field_secrets(
        "telnet",
        &json!({ "host": "h", "port": 23 })
    ));
}

#[test]
fn listing_reports_only_the_names_of_the_stored_secrets() {
    let store = RecordingStore::default();
    let mut taken = TakenSecrets::default();
    taken
        .fields
        .insert("sshPassword".into(), "gw-secret".into());
    taken
        .fields
        .insert("apiToken".into(), "token-secret".into());
    taken.hops.insert("u@h:22".into(), "hop-secret".into());
    store_field_secrets(&store, "c", taken).unwrap();

    let keys = stored_field_secret_keys(&store, "c").unwrap();
    assert_eq!(keys.fields, vec!["apiToken", "sshPassword"]);
    assert_eq!(keys.hops, vec!["u@h:22"]);
    let wire = serde_json::to_string(&keys).unwrap();
    for secret in ["gw-secret", "token-secret", "hop-secret"] {
        assert!(!wire.contains(secret), "a value crossed: {wire}");
    }
    assert_eq!(
        stored_field_secret_keys(&store, "none").unwrap(),
        StoredFieldSecretKeys::default()
    );
}

#[test]
fn clearing_removes_exactly_the_named_secrets() {
    let store = RecordingStore::default();
    let mut taken = TakenSecrets::default();
    taken.fields.insert("sshPassword".into(), "gw".into());
    taken.fields.insert("apiToken".into(), "token".into());
    taken.hops.insert("u@h:22".into(), "hop".into());
    taken.hops.insert("v@k:22".into(), "hop2".into());
    store_field_secrets(&store, "c", taken).unwrap();

    remove_field_secrets(&store, "c", &["sshPassword".into()], &["u@h:22".into()]).unwrap();

    let stored = read_field_secrets(&store, "c").unwrap();
    assert!(!stored.fields.contains_key("sshPassword"));
    assert_eq!(
        stored.fields.get("apiToken").map(String::as_str),
        Some("token")
    );
    assert!(!stored.hops.contains_key("u@h:22"));
    assert_eq!(stored.hops.get("v@k:22").map(String::as_str), Some("hop2"));
}

#[test]
fn clearing_the_last_secret_deletes_the_entry_and_unknown_names_change_nothing() {
    let store = RecordingStore::default();
    let mut taken = TakenSecrets::default();
    taken.fields.insert("sshPassword".into(), "gw".into());
    store_field_secrets(&store, "c", taken).unwrap();

    remove_field_secrets(&store, "c", &["notStored".into()], &[]).unwrap();
    assert!(store.value("c", FS).is_some());

    remove_field_secrets(&store, "c", &["sshPassword".into()], &[]).unwrap();
    assert!(store.value("c", FS).is_none());
    // Nothing stored: still a no-op.
    remove_field_secrets(&store, "c", &["sshPassword".into()], &[]).unwrap();
}

#[test]
fn pruning_drops_only_hop_secrets_of_hops_the_settings_no_longer_have() {
    let store = RecordingStore::default();
    let mut taken = TakenSecrets::default();
    taken.fields.insert("sshPassword".into(), "gw".into());
    taken.hops.insert("u@a:22".into(), "pa".into());
    taken.hops.insert("u@b:22".into(), "pb".into());
    store_field_secrets(&store, "c", taken).unwrap();

    let settings = json!({ "proxyJump": [{ "host": "b", "username": "u" }] });
    let removed = prune_orphan_hop_secrets(&store, "c", &settings).unwrap();
    assert_eq!(removed, vec!["u@a:22".to_string()]);
    let stored = read_field_secrets(&store, "c").unwrap();
    assert_eq!(stored.hops.keys().collect::<Vec<_>>(), vec!["u@b:22"]);
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some("gw")
    );

    // Nothing orphaned: nothing removed. No entry: nothing to do.
    assert!(prune_orphan_hop_secrets(&store, "c", &settings)
        .unwrap()
        .is_empty());
    assert!(prune_orphan_hop_secrets(&store, "none", &settings)
        .unwrap()
        .is_empty());
}
