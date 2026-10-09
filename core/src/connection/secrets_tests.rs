//! Schema-driven secret classification (#4289).

use super::*;
use crate::connection::schema::{SettingsGroup, SettingsSchema};
use serde_json::json;

fn field(key: &str, field_type: FieldType) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: key.to_string(),
        description: None,
        help_text: None,
        field_type,
        required: false,
        default: None,
        placeholder: None,
        supports_env_expansion: false,
        supports_tilde_expansion: false,
        visible_when: None,
    }
}

fn schema(fields: Vec<SettingsField>) -> SettingsSchema {
    SettingsSchema {
        groups: vec![SettingsGroup {
            key: "g".to_string(),
            label: "G".to_string(),
            fields,
            collapsed: false,
        }],
    }
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn password_typed_fields_are_secret_whatever_their_key() {
    let s = schema(vec![
        field("host", FieldType::Text),
        field("apiToken", FieldType::Password),
        field("passwordPrompt", FieldType::Text),
        field("apiToken", FieldType::Password),
    ]);
    assert_eq!(schema_secret_keys(&s), keys(&["apiToken"]));
}

#[test]
fn classification_always_includes_the_fallback_keys() {
    let s = schema(vec![field("apiToken", FieldType::Password)]);
    assert_eq!(
        secret_keys(Some(&s)),
        keys(&["apiToken", "password", "sshPassword"])
    );
    assert_eq!(secret_keys(None), keys(&["password", "sshPassword"]));
}

#[cfg(feature = "ssh")]
#[test]
fn every_core_backend_secret_field_is_classified() {
    let mut registry = crate::connection::ConnectionTypeRegistry::new();
    crate::connection::register_core_backends(&mut registry);
    for info in registry.available_types() {
        let classified = schema_secret_keys(&info.schema);
        let expected: &[&str] = match info.type_id.as_str() {
            "ssh" | "telnet" => &["password"],
            _ => &[],
        };
        assert_eq!(classified, keys(expected), "type {}", info.type_id);
    }
}

#[test]
fn take_removes_every_secret_and_returns_the_non_empty_ones() {
    let mut settings = json!({
        "host": "h",
        "password": "pw",
        "sshPassword": "gateway",
        "apiToken": "",
        "proxyJump": [
            { "host": "gw", "username": "ops", "password": "hop-pw" },
            { "host": "gw2", "port": 2222, "password": null },
            { "connectionId": "saved", "password": "ignored" }
        ]
    });
    let taken = take_secrets(
        &keys(&["password", "sshPassword", "apiToken"]),
        &mut settings,
    );
    assert_eq!(taken.fields.get("password").map(String::as_str), Some("pw"));
    assert_eq!(
        taken.fields.get("sshPassword").map(String::as_str),
        Some("gateway")
    );
    assert!(!taken.fields.contains_key("apiToken"));
    assert_eq!(
        taken.hops.get("ops@gw:22").map(String::as_str),
        Some("hop-pw")
    );
    assert_eq!(taken.hops.len(), 1);
    assert_eq!(
        settings,
        json!({
            "host": "h",
            "proxyJump": [
                { "host": "gw", "username": "ops" },
                { "host": "gw2", "port": 2222 },
                { "connectionId": "saved" }
            ]
        })
    );
    assert!(!has_secrets(&keys(&["password", "sshPassword"]), &settings));
}

#[test]
fn legacy_jump_hosts_alias_is_covered() {
    let mut settings = json!({ "jumpHosts": [{ "host": "gw", "password": "x" }] });
    assert!(has_secrets(&[], &settings));
    let taken = take_secrets(&[], &mut settings);
    assert_eq!(taken.hops.get("@gw:22").map(String::as_str), Some("x"));
    assert_eq!(settings, json!({ "jumpHosts": [{ "host": "gw" }] }));
}

#[test]
fn restore_fills_only_missing_or_empty_values_and_follows_reordered_hops() {
    let mut taken = TakenSecrets::default();
    taken.fields.insert("sshPassword".into(), "stored".into());
    taken.fields.insert("apiToken".into(), "tok".into());
    taken.hops.insert("ops@b:22".into(), "b-pw".into());
    taken.hops.insert("ops@a:22".into(), "a-pw".into());
    let mut settings = json!({
        "sshPassword": "",
        "apiToken": "typed-now",
        "proxyJump": [
            { "host": "b", "username": "ops" },
            { "host": "a", "username": "ops", "password": "typed" }
        ]
    });
    restore_secrets(&mut settings, &taken);
    assert_eq!(settings["sshPassword"], "stored");
    assert_eq!(settings["apiToken"], "typed-now");
    assert_eq!(settings["proxyJump"][0]["password"], "b-pw");
    assert_eq!(settings["proxyJump"][1]["password"], "typed");
}

#[test]
fn without_secrets_leaves_the_original_untouched() {
    let settings = json!({ "host": "h", "sshPassword": "s" });
    let copy = without_secrets(&keys(&["sshPassword"]), &settings);
    assert_eq!(copy, json!({ "host": "h" }));
    assert_eq!(settings["sshPassword"], "s");
}

#[test]
fn merge_replaces_same_slot_and_keeps_others() {
    let mut old = TakenSecrets::default();
    old.fields.insert("a".into(), "1".into());
    old.fields.insert("b".into(), "2".into());
    let mut newer = TakenSecrets::default();
    newer.fields.insert("b".into(), "3".into());
    old.merge(newer);
    assert_eq!(old.fields.get("a").map(String::as_str), Some("1"));
    assert_eq!(old.fields.get("b").map(String::as_str), Some("3"));
}

#[test]
fn taken_secrets_round_trip_through_json() {
    let mut taken = TakenSecrets::default();
    taken.fields.insert("sshPassword".into(), "s".into());
    taken.hops.insert("u@h:22".into(), "p".into());
    let text = serde_json::to_string(&taken).unwrap();
    assert_eq!(serde_json::from_str::<TakenSecrets>(&text).unwrap(), taken);
    assert!(serde_json::from_str::<TakenSecrets>("{}").unwrap().is_empty());
}
