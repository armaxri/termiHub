//! Moving plaintext schema secrets into the credential store (#4289).

use std::sync::atomic::Ordering;

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::CredentialType;
use crate::terminal::backend::ConnectionConfig;
use serde_json::json;

const FS: CredentialType = CredentialType::FieldSecrets;

fn conn(id: &str, type_id: &str, settings: serde_json::Value) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        icon_color: None,
        icon_emoji: None,
        id: id.to_string(),
        name: id.to_string(),
        config: ConnectionConfig {
            type_id: type_id.to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

fn tunnelled_vnc() -> SavedConnection {
    conn(
        "desk",
        "vnc",
        json!({ "host": "h", "useSshTunnel": true, "sshHost": "gw", "sshPassword": "gw-secret" }),
    )
}

#[test]
fn plaintext_secrets_move_to_the_store_and_are_stripped() {
    let store = RecordingStore::default();
    let mut conns = vec![
        tunnelled_vnc(),
        conn(
            "jump",
            "ssh",
            json!({ "host": "t", "proxyJump": [{ "host": "b", "username": "ops", "password": "hop" }] }),
        ),
        conn("plain", "local", json!({ "shell": "zsh" })),
    ];
    assert!(migrate_plaintext_field_secrets(&mut conns, None, &store, false).unwrap());

    let text = serde_json::to_string(&conns).unwrap();
    assert!(
        !text.contains("gw-secret") && !text.contains("\"hop\""),
        "{text}"
    );
    assert_eq!(conns[0].config.settings["sshHost"], "gw");
    let desk = store.value("desk", FS).unwrap();
    assert!(desk.contains("gw-secret"), "{desk}");
    assert!(store.value("jump", FS).unwrap().contains("hop"));
    assert_eq!(store.value("plain", FS), None);
}

#[test]
fn an_external_file_scopes_the_owner() {
    let store = RecordingStore::default();
    let mut conns = vec![tunnelled_vnc()];
    assert!(migrate_plaintext_field_secrets(&mut conns, Some("file-1"), &store, false).unwrap());
    assert!(store
        .value(&owner_id("desk", Some("file-1")), FS)
        .unwrap()
        .contains("gw-secret"));
}

#[test]
fn a_failed_migration_write_deletes_nothing() {
    let store = RecordingStore {
        fail_sets: true,
        ..Default::default()
    };
    let mut conns = vec![tunnelled_vnc()];
    let before = serde_json::to_value(&conns).unwrap();
    assert!(migrate_plaintext_field_secrets(&mut conns, None, &store, false).is_err());
    assert_eq!(serde_json::to_value(&conns).unwrap(), before);
    assert!(store.snapshot().is_empty());
}

#[test]
fn a_failed_read_deletes_nothing() {
    let store = RecordingStore {
        fail_gets: true,
        ..Default::default()
    };
    let mut conns = vec![tunnelled_vnc()];
    assert!(migrate_plaintext_field_secrets(&mut conns, None, &store, false).is_err());
    assert_eq!(conns[0].config.settings["sshPassword"], "gw-secret");
}

#[test]
fn a_locked_store_defers_the_move_without_touching_anything() {
    let store = RecordingStore::default();
    store.locked.store(true, Ordering::SeqCst);
    let mut conns = vec![tunnelled_vnc()];
    assert!(!migrate_plaintext_field_secrets(&mut conns, None, &store, false).unwrap());
    assert_eq!(conns[0].config.settings["sshPassword"], "gw-secret");
    assert!(store.calls().is_empty());
}

#[test]
fn a_plaintext_secret_wins_over_a_stale_stored_one_and_others_are_kept() {
    let store = RecordingStore::with(&[(
        "desk",
        FS,
        r#"{"fields":{"sshPassword":"old"},"hops":{"u@h:22":"kept"}}"#,
    )]);
    let mut conns = vec![tunnelled_vnc()];
    migrate_plaintext_field_secrets(&mut conns, None, &store, false).unwrap();
    let stored = secret_fields::read_field_secrets(&store, "desk").unwrap();
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some("gw-secret")
    );
    assert_eq!(stored.hops.get("u@h:22").map(String::as_str), Some("kept"));
}

#[test]
fn nothing_to_move_never_touches_the_store() {
    let store = RecordingStore {
        fail_gets: true,
        ..Default::default()
    };
    let mut conns = vec![conn(
        "s",
        "ssh",
        json!({ "host": "h", "authMethod": "key" }),
    )];
    assert!(!migrate_plaintext_field_secrets(&mut conns, None, &store, false).unwrap());
    assert!(store.calls().is_empty());
}

#[test]
fn an_empty_secret_is_stripped_without_a_write() {
    let store = RecordingStore::default();
    let mut conns = vec![conn(
        "desk",
        "vnc",
        json!({ "host": "h", "sshPassword": "" }),
    )];
    assert!(migrate_plaintext_field_secrets(&mut conns, None, &store, false).unwrap());
    assert!(conns[0].config.settings.get("sshPassword").is_none());
    assert!(store.snapshot().is_empty());
}

#[test]
fn a_migrated_entry_drops_hop_secrets_the_file_no_longer_has_when_pruning() {
    // The file was edited outside termiHub: its hop was re-addressed and
    // carries the new password in plaintext (#4792).
    let seeded = || {
        RecordingStore::with(&[(
            "jump",
            FS,
            r#"{"fields":{"sshPassword":"gw"},"hops":{"ops@old:22":"stale"}}"#,
        )])
    };
    let edited = || {
        vec![conn(
            "jump",
            "ssh",
            json!({ "host": "t", "proxyJump": [{ "host": "new", "username": "ops", "password": "fresh" }] }),
        )]
    };

    let store = seeded();
    let mut conns = edited();
    assert!(migrate_plaintext_field_secrets(&mut conns, None, &store, true).unwrap());
    let stored = secret_fields::read_field_secrets(&store, "jump").unwrap();
    assert_eq!(stored.hops.keys().collect::<Vec<_>>(), vec!["ops@new:22"]);
    assert_eq!(
        stored.fields.get("sshPassword").map(String::as_str),
        Some("gw")
    );

    // Without pruning (an entry another file may still read) nothing is dropped.
    let store = seeded();
    let mut conns = edited();
    assert!(migrate_plaintext_field_secrets(&mut conns, None, &store, false).unwrap());
    let stored = secret_fields::read_field_secrets(&store, "jump").unwrap();
    assert_eq!(stored.hops.len(), 2);
}
