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
    lookup_supplied(connections, id, None, store)
}

/// [`lookup`] with a secret the user entered for this session (#4265).
fn lookup_supplied(
    connections: &[SavedConnection],
    id: &str,
    supplied: Option<&str>,
    store: &RecordingStore,
) -> LinkedLookup {
    lookup_linked(
        connections,
        id,
        supplied,
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
        ..
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
    store
        .locked
        .store(true, std::sync::atomic::Ordering::SeqCst);
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
        None,
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

/// The secret request a lookup carries, or a panic naming what it found.
fn secret_request(lookup: LinkedLookup) -> LinkedSecretRequest {
    match lookup {
        LinkedLookup::Unusable {
            secret: Some(request),
            ..
        } => request,
        LinkedLookup::Unusable { message, .. } => panic!("unusable without a request: {message}"),
        _ => panic!("expected an unusable link asking for its secret"),
    }
}

/// #4265: a password connection with nothing saved asks the user for the
/// password (when they act), offering to save it under the connection.
#[test]
fn a_link_without_a_stored_password_asks_for_the_password() {
    let store = RecordingStore::default();
    let request = secret_request(lookup(&[tiger("password")], "Lab/Tiger", &store));
    assert_eq!(
        request,
        LinkedSecretRequest {
            connection_id: "Lab/Tiger".to_string(),
            source_file: None,
            kind: LinkedSecretKind::Password,
            auth_method: "password".to_string(),
            host: "tiger-box".to_string(),
            username: "arne".to_string(),
            store_locked: false,
            can_save: true,
            rejected: false,
        }
    );
}

/// An encrypted key with no saved passphrase asks for the passphrase, and the
/// request names the connection's file so a saved secret lands in its scope.
#[test]
fn an_encrypted_key_without_a_stored_passphrase_asks_for_the_passphrase() {
    let store = RecordingStore::default();
    let mut conn = tiger("key");
    conn.config.settings["keyPath"] = json!("/home/arne/.ssh/id_ed25519");
    conn.source_file = Some("/team/connections.json".to_string());
    let request = secret_request(lookup_linked(
        &[conn],
        "Lab/Tiger",
        None,
        |c| c.id.clone(),
        &store,
        |_| true,
        |_| Ok(()),
    ));
    assert_eq!(request.kind, LinkedSecretKind::KeyPassphrase);
    assert_eq!(request.auth_method, "key");
    assert_eq!(
        request.source_file.as_deref(),
        Some("/team/connections.json")
    );
}

/// A locked store asks the user to unlock it first.
#[test]
fn a_locked_store_asks_to_be_unlocked() {
    let store = RecordingStore::default();
    store
        .locked
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let request = secret_request(lookup(&[tiger("password")], "Lab/Tiger", &store));
    assert!(request.store_locked);
}

/// A shared named credential (#3557) is asked for without a Save box: it is
/// rotated in Settings, never replaced by a per-connection secret.
#[test]
fn a_shared_credential_is_asked_for_without_offering_to_save() {
    let store = RecordingStore::default();
    let mut conn = tiger("password");
    conn.config.settings["credentialRef"] = json!("nc-1");
    let request = secret_request(lookup(&[conn], "Lab/Tiger", &store));
    assert!(!request.can_save);
}

/// The secret the user entered stands in for the missing one, and the target
/// remembers how to ask again should the server reject it.
#[test]
fn a_supplied_secret_stands_in_for_a_missing_one() {
    let store = RecordingStore::default();
    let LinkedLookup::Found(target) =
        lookup_supplied(&[tiger("password")], "Lab/Tiger", Some("typed"), &store)
    else {
        panic!("expected the linked connection");
    };
    assert_eq!(target.config.password.as_deref(), Some("typed"));
    let ask = target
        .ask_again
        .expect("a user-entered secret can be asked for again");
    assert_eq!(ask.kind, LinkedSecretKind::Password);
}

/// A saved secret is used as before; a stored one never asks again.
#[test]
fn a_stored_secret_needs_no_request() {
    let store = RecordingStore::with(&[("Lab/Tiger", PW, "s3cret")]);
    let LinkedLookup::Found(target) =
        lookup_supplied(&[tiger("password")], "Lab/Tiger", Some("typed"), &store)
    else {
        panic!("expected the linked connection");
    };
    assert_eq!(target.config.password.as_deref(), Some("s3cret"));
    assert!(target.ask_again.is_none());
}

/// Problems the user cannot fix by typing a secret carry no request.
#[test]
fn an_ambiguous_link_asks_for_nothing() {
    let store = RecordingStore::default();
    let mut other = tiger("password");
    other.source_file = Some("/team/connections.json".to_string());
    let LinkedLookup::Unusable { secret, .. } =
        lookup(&[tiger("password"), other], "Lab/Tiger", &store)
    else {
        panic!("expected unusable");
    };
    assert!(secret.is_none());
}
