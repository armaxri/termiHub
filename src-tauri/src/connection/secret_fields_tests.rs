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
            "ssh" | "telnet" | "ftp" | "rdp" | "mock-remote-desktop" => &["password"],
            "vnc" => &["password", "sshPassword"],
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
            "sshPassword".to_string()
        ]
    );
}

#[test]
fn an_unknown_type_falls_back_to_the_builtin_secret_keys() {
    assert_eq!(
        secret_keys_for("plugin:not-installed:x"),
        vec!["password".to_string(), "sshPassword".to_string()]
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
    let clean = without_secrets("vnc", &settings);
    let text = clean.to_string();
    for secret in ["pw", "gw", "hop"] {
        assert!(!text.contains(&format!("\"{secret}\"")), "{text}");
    }
    assert_eq!(clean["host"], "h");
}

#[test]
fn only_connections_that_can_own_field_secrets_touch_the_store() {
    assert!(may_have_field_secrets("vnc", &json!({ "host": "h" })));
    assert!(may_have_field_secrets(
        "ssh",
        &json!({ "proxyJump": [{ "host": "gw" }] })
    ));
    assert!(!may_have_field_secrets(
        "ssh",
        &json!({ "proxyJump": [{ "connectionId": "saved" }] })
    ));
    assert!(!may_have_field_secrets("local", &json!({ "shell": "zsh" })));
    assert!(!may_have_field_secrets(
        "ssh",
        &json!({ "host": "h", "authMethod": "key" })
    ));
}
