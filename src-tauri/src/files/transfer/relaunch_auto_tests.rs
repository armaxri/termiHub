//! Tests for the automatic resume of transfers paused for credentials (#3883).
//!
//! These cover which transfers a trigger picks up. The credential resolution
//! a picked-up transfer then goes through is covered with a mock credential
//! store in `relaunch_credentials_tests.rs`.

use super::*;
use crate::files::transfer::persist::{PersistedRemoteSource, PersistedTransferStatus};
use crate::files::transfer::relaunch_credentials::RelaunchBlocked;
use crate::files::transfer::TransferDirection;

fn record(id: &str, connection: Option<&str>) -> PersistedTransfer {
    PersistedTransfer {
        transfer_id: id.to_string(),
        session_id: "sess-old".to_string(),
        direction: TransferDirection::Download,
        file_name: "data.csv".to_string(),
        remote_path: "/remote/data.csv".to_string(),
        local_path: Some("/home/user/data.csv".to_string()),
        status: PersistedTransferStatus::Paused,
        transferred: 4096,
        total: 8192,
        resume_offset: 4096,
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        docker: None,
        group_id: None,
        folder_paste_id: None,
        source_mtime: None,
        remote_source: None,
        saved_connection_id: connection.map(str::to_string),
        agent: None,
    }
}

fn remote_copy(id: &str, src: &str, dst: &str) -> PersistedTransfer {
    PersistedTransfer {
        local_path: None,
        remote_source: Some(PersistedRemoteSource {
            session_id: "sess-src".to_string(),
            path: "/src/data.csv".to_string(),
            saved_connection_id: Some(src.to_string()),
            container_id: None,
        }),
        ..record(id, Some(dst))
    }
}

/// A transfer whose relaunch was blocked because its secret was missing.
fn waiting(waits: &CredentialWaits, record: &PersistedTransfer) {
    note_blocked(waits, record, &RelaunchBlocked::NeedsCredentials);
}

fn opened(connection_id: &str) -> WaitTrigger {
    WaitTrigger::ConnectionOpened(connection_id.to_string())
}

// --- the connection opens -----------------------------------------------------

/// Opening the saved connection a paused transfer waits for picks it up, once.
#[test]
fn opening_the_matching_connection_resumes_the_transfer() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &record("t1", Some("conn-a")));

    assert_eq!(due(&waits, &opened("conn-a"), &registry), vec!["t1"]);
    assert!(
        !waits.contains("t1"),
        "a picked-up transfer no longer waits"
    );
    assert!(
        due(&waits, &opened("conn-a"), &registry).is_empty(),
        "a second session of the connection does not resume it again"
    );
}

/// A different connection opening leaves the transfer waiting.
#[test]
fn opening_a_different_connection_does_not_resume_the_transfer() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &record("t1", Some("conn-a")));

    assert!(due(&waits, &opened("conn-b"), &registry).is_empty());
    assert!(
        waits.contains("t1"),
        "it still waits for its own connection"
    );
}

/// A remote-to-remote copy waits for both of its connections: either one
/// opening picks it up.
#[test]
fn either_end_of_a_remote_copy_resumes_it() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &remote_copy("r2r", "conn-src", "conn-dst"));
    assert_eq!(due(&waits, &opened("conn-src"), &registry), vec!["r2r"]);

    waiting(&waits, &remote_copy("r2r", "conn-src", "conn-dst"));
    assert_eq!(due(&waits, &opened("conn-dst"), &registry), vec!["r2r"]);
}

// --- the store unlocks --------------------------------------------------------

/// Unlocking the credential store picks up every transfer paused for
/// credentials, whatever its connection.
#[test]
fn unlocking_the_store_resumes_the_transfer() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &record("t1", Some("conn-a")));
    waiting(&waits, &record("t2", Some("conn-b")));

    let mut due_ids = due(&waits, &WaitTrigger::StoreUnlocked, &registry);
    due_ids.sort();
    assert_eq!(due_ids, vec!["t1", "t2"]);
    assert!(due(&waits, &WaitTrigger::StoreUnlocked, &registry).is_empty());
}

/// The store unlocks but the secret is still not stored: the relaunch is
/// blocked again, so the transfer goes back to waiting (and stays paused).
#[test]
fn a_transfer_blocked_again_after_a_trigger_keeps_waiting() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    let rec = record("t1", Some("conn-a"));
    waiting(&waits, &rec);

    assert_eq!(
        due(&waits, &WaitTrigger::StoreUnlocked, &registry),
        vec!["t1"]
    );
    note_blocked(&waits, &rec, &RelaunchBlocked::NeedsCredentials);

    assert!(waits.contains("t1"));
    assert_eq!(due(&waits, &opened("conn-a"), &registry), vec!["t1"]);
}

// --- only transfers paused for credentials -------------------------------------

/// A rehydrated row the user has not tried to resume is paused, but not for
/// credentials: no trigger resumes it.
#[test]
fn a_paused_row_that_is_not_waiting_for_credentials_stays_paused() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();

    assert!(due(&waits, &opened("conn-a"), &registry).is_empty());
    assert!(due(&waits, &WaitTrigger::StoreUnlocked, &registry).is_empty());
}

/// A relaunch that fails for another reason fails the row; it never waits.
#[test]
fn a_failed_relaunch_does_not_wait() {
    let waits = CredentialWaits::default();
    note_blocked(
        &waits,
        &record("t1", Some("conn-a")),
        &RelaunchBlocked::Failed("Cannot resume: could not connect".to_string()),
    );
    assert!(!waits.contains("t1"));
}

/// A transfer without a saved connection has nothing to wait for.
#[test]
fn a_transfer_without_a_saved_connection_does_not_wait() {
    let waits = CredentialWaits::default();
    waiting(&waits, &record("t1", None));
    assert!(!waits.contains("t1"));
}

/// The user pausing the row takes it off the wait list: nothing resumes it.
#[test]
fn a_transfer_the_user_paused_is_never_resumed() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &record("t1", Some("conn-a")));

    waits.forget("t1");

    assert!(due(&waits, &opened("conn-a"), &registry).is_empty());
    assert!(due(&waits, &WaitTrigger::StoreUnlocked, &registry).is_empty());
}

/// A transfer that runs again has a live handle. If the user then pauses it,
/// a trigger must not resume it, even when a stale wait entry is left over.
#[test]
fn a_live_transfer_the_user_paused_stays_paused() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &record("t1", Some("conn-a")));
    let handle = registry.enqueue(
        "t1",
        "sess-new",
        TransferDirection::Download,
        "data.csv",
        "/remote/data.csv",
        8192,
    );
    assert!(registry.pause("t1"));

    assert!(due(&waits, &opened("conn-a"), &registry).is_empty());
    assert!(due(&waits, &WaitTrigger::StoreUnlocked, &registry).is_empty());
    assert!(!waits.contains("t1"), "the stale entry is dropped");
    assert!(
        handle.take_pause_request(),
        "the user's pause is still pending"
    );
    assert!(
        !handle.take_resume_request(),
        "the user's pause is not undone"
    );
}

/// Cancelling a waiting row takes its record, and with it the wait: a later
/// trigger finds nothing to resume.
#[test]
fn a_cancelled_transfer_is_never_resumed() {
    let dir = tempfile::TempDir::new().unwrap();
    let persist = TransferPersistenceManager::new_test(dir.path());
    let registry = TransferRegistry::new();
    persist.record_registration(
        "t1",
        "sess-old",
        TransferDirection::Download,
        "data.csv",
        "/remote/data.csv",
        Some("/home/user/data.csv".to_string()),
        8192,
    );
    persist.record_saved_connection("t1", "conn-a");
    let rec = persist.get_record("t1").expect("record");
    waiting(persist.credential_waits(), &rec);

    assert!(persist.take_record("t1").is_some());

    assert!(due(
        persist.credential_waits(),
        &WaitTrigger::StoreUnlocked,
        &registry
    )
    .is_empty());
}
