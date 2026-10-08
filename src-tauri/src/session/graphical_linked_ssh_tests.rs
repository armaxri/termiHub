//! Looking up the saved SSH connection a direct VNC connection links as its
//! file route (#4194), against an in-memory connection list and a recording
//! credential store — no server and no real store involved.

use serde_json::{json, Value};

use super::*;
use crate::connection::config::SavedConnection;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::CredentialType;
use crate::terminal::backend::ConnectionConfig;

const PW: CredentialType = CredentialType::Password;

fn saved(id: &str, type_id: &str, settings: Value) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        id: id.to_string(),
        name: id.rsplit('/').next().unwrap_or(id).to_string(),
        config: ConnectionConfig {
            type_id: type_id.to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

fn tiger(auth_method: &str) -> SavedConnection {
    saved(
        "Lab/Tiger",
        "ssh",
        json!({ "host": "tiger-box", "port": 2222, "username": "arne",
                "authMethod": auth_method }),
    )
}

/// Look `id` up in `connections`, with every secret owned by the connection
/// id itself and no jump hosts to expand.
fn lookup(connections: &[SavedConnection], id: &str, store: &RecordingStore) -> LinkedLookup {
    lookup_linked(
        connections,
        id,
        |c| c.id.clone(),
        store,
        |_| false,
        |_| Ok(()),
    )
}

#[test]
fn a_deleted_link_is_missing() {
    let store = RecordingStore::default();
    assert!(matches!(
        lookup(&[tiger("agent")], "Lab/Gone", &store),
        LinkedLookup::Missing
    ));
}

#[test]
fn a_link_to_a_connection_that_is_not_ssh_is_missing() {
    let store = RecordingStore::default();
    let telnet = saved("Lab/Tiger", "telnet", json!({ "host": "tiger-box" }));
    assert!(matches!(
        lookup(&[telnet], "Lab/Tiger", &store),
        LinkedLookup::Missing
    ));
}

#[test]
fn a_link_with_a_stored_password_is_found_with_the_secret() {
    let store = RecordingStore::with(&[("Lab/Tiger", PW, "s3cret")]);
    let LinkedLookup::Found(target) = lookup(&[tiger("password")], "Lab/Tiger", &store) else {
        panic!("expected the linked connection");
    };
    assert_eq!(target.connection_id, "Lab/Tiger");
    assert_eq!(target.name, "Tiger");
    assert_eq!(target.config.host, "tiger-box");
    assert_eq!(target.config.port, 2222);
    assert_eq!(target.config.username, "arne");
    assert_eq!(target.config.password.as_deref(), Some("s3cret"));
}

#[test]
fn agent_auth_needs_no_stored_secret() {
    let store = RecordingStore::default();
    let LinkedLookup::Found(target) = lookup(&[tiger("agent")], "Lab/Tiger", &store) else {
        panic!("expected the linked connection");
    };
    assert_eq!(target.config.password, None);
    assert!(store.calls().is_empty(), "the store is not read");
}

#[test]
fn a_link_without_a_stored_password_is_unusable_and_says_why() {
    let store = RecordingStore::default();
    let LinkedLookup::Unusable {
        name,
        host,
        user,
        message,
    } = lookup(&[tiger("password")], "Lab/Tiger", &store)
    else {
        panic!("expected unusable");
    };
    assert_eq!((name.as_str(), host.as_str()), ("Tiger", "tiger-box"));
    assert_eq!(user, "arne");
    assert!(message.contains("no password is saved"), "{message}");
}

#[test]
fn a_locked_store_is_unusable_until_it_is_unlocked() {
    let store = RecordingStore::with(&[("Lab/Tiger", PW, "s3cret")]);
    store.locked.store(true, std::sync::atomic::Ordering::SeqCst);
    let LinkedLookup::Unusable { message, .. } = lookup(&[tiger("password")], "Lab/Tiger", &store)
    else {
        panic!("expected unusable");
    };
    assert!(message.contains("credential store is locked"), "{message}");
}

#[test]
fn an_ambiguous_link_is_unusable() {
    let store = RecordingStore::default();
    let mut other = tiger("agent");
    other.source_file = Some("/team/connections.json".to_string());
    let LinkedLookup::Unusable { message, .. } =
        lookup(&[tiger("agent"), other], "Lab/Tiger", &store)
    else {
        panic!("expected unusable");
    };
    assert!(message.contains("several connection files"), "{message}");
}

#[test]
fn a_jump_host_that_does_not_resolve_is_unusable() {
    let store = RecordingStore::default();
    let result = lookup_linked(
        &[tiger("agent")],
        "Lab/Tiger",
        |c| c.id.clone(),
        &store,
        |_| false,
        |_| Err("jump host 'Gone' not found".to_string()),
    );
    let LinkedLookup::Unusable { message, .. } = result else {
        panic!("expected unusable");
    };
    assert!(message.contains("jump host 'Gone' not found"), "{message}");
}
