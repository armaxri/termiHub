//! Tests for the desktop-side secrets of agent-tunnelled VNC/RDP definitions
//! (#3803).

use std::cell::RefCell;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use termihub_core::protocol::methods::{ConnectionCreateParams, ConnectionUpdateParams};

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::{CredentialStore, CredentialStoreStatus, CredentialType};
use crate::terminal::agent_manager::AgentDefinitionInfo;
use crate::utils::errors::TerminalError;

const AGENT: &str = "agent-1";
const SECRET: &str = "vnc-s3cret-do-not-leak";

fn create_params(session_type: &str, config: Value) -> ConnectionCreateParams {
    ConnectionCreateParams {
        name: "Lab desktop".into(),
        session_type: session_type.into(),
        config,
        persistent: false,
        folder_id: None,
        terminal_options: None,
        icon: None,
    }
}

fn update_params(
    id: &str,
    session_type: Option<&str>,
    config: Option<Value>,
) -> ConnectionUpdateParams {
    ConnectionUpdateParams {
        id: id.into(),
        name: None,
        session_type: session_type.map(String::from),
        config,
        persistent: None,
        folder_id: None,
        terminal_options: None,
        icon: None,
    }
}

fn info(id: &str, session_type: &str, config: Value) -> AgentDefinitionInfo {
    AgentDefinitionInfo {
        id: id.into(),
        name: "Lab desktop".into(),
        session_type: session_type.into(),
        config,
        persistent: false,
        folder_id: None,
        terminal_options: None,
        icon: None,
        source_file: None,
    }
}

/// The agent's answer to `connections.create`: echo the params it received.
fn echo_create(p: ConnectionCreateParams) -> AgentDefinitionInfo {
    info("def-1", &p.session_type, p.config)
}

/// The agent's answer to `connections.update`: echo the params it received.
fn echo_update(p: &ConnectionUpdateParams) -> AgentDefinitionInfo {
    info(
        &p.id,
        p.session_type.as_deref().unwrap_or("vnc"),
        p.config.clone().unwrap_or(Value::Null),
    )
}

fn stored(store: &RecordingStore, def_id: &str) -> Option<String> {
    store.value(&owner_id(AGENT, def_id), CredentialType::Password)
}

// ── Keys ────────────────────────────────────────────────────────────

#[test]
fn owner_id_is_namespaced_by_agent_and_definition() {
    assert_eq!(
        owner_id("agent-1", "def-9"),
        "agent-graphical:agent-1:def-9"
    );
    let key = credential_key("agent-1", "def-9");
    assert_eq!(key.to_string(), "agent-graphical:agent-1:def-9:password");
}

#[test]
fn only_vnc_and_rdp_are_tunnelled_graphical() {
    assert!(is_tunnelled_graphical("vnc"));
    assert!(is_tunnelled_graphical("rdp"));
    assert!(!is_tunnelled_graphical("ssh"));
    assert!(!is_tunnelled_graphical("shell"));
}

// ── Save: the agent never receives the secret ───────────────────────

#[test]
fn saving_a_graphical_definition_sends_no_password_to_the_agent() {
    let store = RecordingStore::default();
    let sent = RefCell::new(None);
    let params = create_params(
        "vnc",
        json!({ "host": "10.0.0.5", "port": 5901, "password": SECRET, "saveToStore": true }),
    );

    let saved = save_definition(&store, AGENT, params, |p| {
        *sent.borrow_mut() = Some(serde_json::to_string(&p).unwrap());
        Ok(echo_create(p))
    })
    .unwrap();

    let wire = sent.into_inner().expect("the agent was called");
    assert!(
        !wire.contains(SECRET),
        "the secret reached the agent: {wire}"
    );
    assert!(
        !wire.contains("\"password\""),
        "a password key reached the agent: {wire}"
    );
    assert!(saved.config.get("password").is_none());
    // The opted-in secret lives in the desktop store, keyed by agent + definition.
    assert_eq!(stored(&store, "def-1").as_deref(), Some(SECRET));
}

#[test]
fn saving_with_the_legacy_save_flag_sends_only_the_unified_flag() {
    let store = RecordingStore::default();
    let sent = RefCell::new(None);
    let params = create_params(
        "rdp",
        json!({ "host": "h", "password": SECRET, "saveToStore": true }),
    );

    let saved = save_definition(&store, AGENT, params, |p| {
        *sent.borrow_mut() = Some(p.config.clone());
        Ok(echo_create(p))
    })
    .unwrap();

    let wire = sent.into_inner().expect("the agent was called");
    assert_eq!(wire, json!({ "host": "h", "savePassword": true }));
    assert_eq!(saved.config["savePassword"], true);
    assert_eq!(stored(&store, "def-1").as_deref(), Some(SECRET));
}

#[test]
fn saving_without_the_save_option_keeps_the_secret_nowhere() {
    let store = RecordingStore::default();
    let params = create_params("rdp", json!({ "host": "h", "password": SECRET }));

    let saved = save_definition(&store, AGENT, params, |p| {
        assert!(p.config.get("password").is_none());
        Ok(echo_create(p))
    })
    .unwrap();

    assert!(saved.config.get("password").is_none());
    assert!(
        store.snapshot().is_empty(),
        "nothing is stored without the save option"
    );
}

#[test]
fn saving_a_non_graphical_definition_is_untouched() {
    let store = RecordingStore::default();
    let params = create_params("ssh", json!({ "host": "h", "password": "agent-side" }));

    let saved = save_definition(&store, AGENT, params, |p| Ok(echo_create(p))).unwrap();

    assert_eq!(saved.config["password"], "agent-side");
    assert!(store.calls().is_empty());
}

#[test]
fn a_failed_agent_save_stores_nothing() {
    let store = RecordingStore::default();
    let params = create_params(
        "vnc",
        json!({ "host": "h", "password": SECRET, "saveToStore": true }),
    );

    let result = save_definition(&store, AGENT, params, |_| {
        Err(TerminalError::RemoteError("agent down".into()))
    });

    assert!(result.is_err());
    assert!(store.snapshot().is_empty());
}

// ── Update ──────────────────────────────────────────────────────────

#[test]
fn updating_a_graphical_definition_strips_and_stores_the_secret() {
    let store = RecordingStore::default();
    let params = update_params(
        "def-2",
        Some("vnc"),
        Some(json!({ "host": "h", "password": SECRET, "savePassword": true })),
    );

    let updated = update_definition(&store, AGENT, params, |p| {
        let wire = serde_json::to_string(&p).unwrap();
        assert!(
            !wire.contains(SECRET),
            "the secret reached the agent: {wire}"
        );
        Ok(echo_update(&p))
    })
    .unwrap();

    assert!(updated.config.get("password").is_none());
    assert_eq!(stored(&store, "def-2").as_deref(), Some(SECRET));
}

#[test]
fn an_update_with_an_empty_password_keeps_the_stored_secret() {
    let store =
        RecordingStore::with(&[(&owner_id(AGENT, "def-2"), CredentialType::Password, SECRET)]);
    let params = update_params(
        "def-2",
        Some("rdp"),
        Some(json!({ "host": "h", "password": "", "saveToStore": true })),
    );

    update_definition(&store, AGENT, params, |p| {
        assert!(p.config.as_ref().unwrap().get("password").is_none());
        Ok(echo_update(&p))
    })
    .unwrap();

    assert_eq!(stored(&store, "def-2").as_deref(), Some(SECRET));
}

#[test]
fn a_move_update_without_config_is_passed_through() {
    let store = RecordingStore::default();
    let params = update_params("def-2", None, None);
    update_definition(&store, AGENT, params, |p| Ok(echo_update(&p))).unwrap();
    assert!(store.calls().is_empty());
}

// ── Delete ──────────────────────────────────────────────────────────

#[test]
fn forgetting_a_definition_removes_its_desktop_secret() {
    let store =
        RecordingStore::with(&[(&owner_id(AGENT, "def-3"), CredentialType::Password, SECRET)]);
    forget_definition(&store, AGENT, "def-3");
    assert!(stored(&store, "def-3").is_none());
}

// ── Migration of legacy definitions ────────────────────────────────

#[test]
fn a_legacy_definition_carrying_a_password_is_migrated_and_scrubbed() {
    let store = RecordingStore::default();
    let updates = RefCell::new(Vec::new());
    let defs = vec![
        info(
            "def-legacy",
            "vnc",
            json!({ "host": "h", "password": SECRET }),
        ),
        info("def-clean", "rdp", json!({ "host": "h2" })),
        info(
            "def-ssh",
            "ssh",
            json!({ "host": "h3", "password": "agent-side" }),
        ),
    ];

    let out = migrate_definitions(&store, AGENT, defs, |p| {
        updates
            .borrow_mut()
            .push(serde_json::to_string(&p).unwrap());
        Ok(echo_update(&p))
    });

    // The secret moved into the desktop store…
    assert_eq!(stored(&store, "def-legacy").as_deref(), Some(SECRET));
    // …and the agent-side definition was rewritten without it, exactly once.
    let updates = updates.into_inner();
    assert_eq!(
        updates.len(),
        1,
        "only the legacy definition is rewritten: {updates:?}"
    );
    assert!(updates[0].contains("def-legacy"));
    assert!(!updates[0].contains(SECRET));
    assert!(!updates[0].contains("\"password\""));
    // The rewritten definition resolves from the store from now on, under the
    // one save option every connection type uses (#3818).
    assert!(updates[0].contains("\"savePassword\":true"));
    assert!(!updates[0].contains("saveToStore"));

    let legacy = out.iter().find(|d| d.id == "def-legacy").unwrap();
    assert!(legacy.config.get("password").is_none());
    assert_eq!(legacy.config["savePassword"], true);
    // Non-graphical definitions keep their agent-side settings.
    let ssh = out.iter().find(|d| d.id == "def-ssh").unwrap();
    assert_eq!(ssh.config["password"], "agent-side");
    assert_eq!(out.len(), 3);
}

#[test]
fn a_listed_legacy_save_flag_is_shown_as_the_unified_flag() {
    // A definition saved with the old `saveToStore` option and no password
    // needs no agent rewrite, but the editor must show it as "Save password".
    let store = RecordingStore::default();
    let defs = vec![info(
        "def-old",
        "vnc",
        json!({ "host": "h", "saveToStore": true }),
    )];

    let out = migrate_definitions(&store, AGENT, defs, |_| {
        panic!("a definition without a password is not rewritten")
    });

    assert_eq!(out[0].config, json!({ "host": "h", "savePassword": true }));
}

#[test]
fn migration_waits_for_a_locked_store_but_still_scrubs_the_result() {
    let store = RecordingStore::default();
    store.locked.store(true, Ordering::SeqCst);
    let defs = vec![info(
        "def-legacy",
        "vnc",
        json!({ "host": "h", "password": SECRET }),
    )];

    let out = migrate_definitions(&store, AGENT, defs, |_| {
        panic!("the agent copy is the only one while the store is locked")
    });

    assert!(store.snapshot().is_empty());
    assert!(
        out[0].config.get("password").is_none(),
        "the desktop view never carries it"
    );
}

#[test]
fn migration_keeps_the_agent_copy_when_the_store_write_fails() {
    let store = RecordingStore {
        fail_sets: true,
        ..RecordingStore::default()
    };
    let defs = vec![info(
        "def-legacy",
        "rdp",
        json!({ "host": "h", "password": SECRET }),
    )];

    let out = migrate_definitions(&store, AGENT, defs, |_| {
        panic!("must not scrub the agent copy before the desktop copy exists")
    });

    assert!(out[0].config.get("password").is_none());
}

#[test]
fn migration_without_a_store_scrubs_the_agent_copy() {
    // `none` mode never persists passwords: the secret is dropped from the
    // agent and prompted for at connect time, like every other connection.
    let store = crate::credential::null::NullStore;
    assert_eq!(store.status(), CredentialStoreStatus::Unavailable);
    let updates = RefCell::new(0);
    let defs = vec![info(
        "def-legacy",
        "vnc",
        json!({ "host": "h", "password": SECRET }),
    )];

    let out = migrate_definitions(&store, AGENT, defs, |p| {
        *updates.borrow_mut() += 1;
        assert!(!serde_json::to_string(&p).unwrap().contains(SECRET));
        Ok(echo_update(&p))
    });

    assert_eq!(updates.into_inner(), 1);
    assert!(out[0].config.get("password").is_none());
}

#[test]
fn a_failed_agent_rewrite_still_scrubs_the_returned_definition() {
    let store = RecordingStore::default();
    let defs = vec![info(
        "def-legacy",
        "vnc",
        json!({ "host": "h", "password": SECRET }),
    )];

    let out = migrate_definitions(&store, AGENT, defs, |_| {
        Err(TerminalError::RemoteError("agent down".into()))
    });

    // The desktop copy exists, so the next listing retries only the scrub.
    assert_eq!(stored(&store, "def-legacy").as_deref(), Some(SECRET));
    assert!(out[0].config.get("password").is_none());
}

// ── Log redaction ──────────────────────────────────────────────────

#[test]
fn migration_logs_the_move_without_the_secret() {
    use crate::utils::log_capture::{create_log_buffer, LogCaptureLayer};
    use tracing_subscriber::layer::SubscriberExt;

    let buffer = create_log_buffer();
    let subscriber = tracing_subscriber::registry().with(LogCaptureLayer::new(buffer.clone()));
    let store = RecordingStore::default();

    crate::utils::log_capture::test_support::with_scoped_subscriber(subscriber, || {
        let defs = vec![info(
            "def-legacy",
            "vnc",
            json!({ "host": "h", "password": SECRET }),
        )];
        migrate_definitions(&store, AGENT, defs, |p| Ok(echo_update(&p)));
        let params = create_params(
            "rdp",
            json!({ "host": "h", "password": SECRET, "saveToStore": true }),
        );
        save_definition(&store, AGENT, params, |p| Ok(echo_create(p))).unwrap();
    });

    let entries = buffer.lock().unwrap().get_recent(50);
    assert!(
        entries.iter().any(|e| e.level == "INFO"
            && e.message.contains("def-legacy")
            && e.message.contains("desktop credential store")),
        "the migration must be logged, got: {entries:?}"
    );
    assert!(
        entries.iter().all(|e| !e.message.contains(SECRET)),
        "a secret must never be logged, got: {entries:?}"
    );
}
