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
            agent: None,
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

// --- agent-hosted transfers waiting for their agent session (#4114) ------------

fn agent_record(id: &str, definition: Option<&str>) -> PersistedTransfer {
    PersistedTransfer {
        agent: Some(crate::files::transfer::persist::PersistedAgentTarget {
            agent_id: "agent-1".to_string(),
            remote_session_id: "remote-old".to_string(),
            definition_id: definition.map(str::to_string),
        }),
        ..record(id, None)
    }
}

fn agent_opened(agent: &str, definition: Option<&str>) -> WaitTrigger {
    WaitTrigger::AgentSessionOpened {
        agent_id: agent.to_string(),
        definition_id: definition.map(str::to_string),
    }
}

/// An agent-hosted transfer whose session is not live waits for a session on
/// its agent from its definition, and resumes once one opens.
#[test]
fn an_agent_transfer_resumes_when_its_agent_session_opens() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    note_blocked(
        &waits,
        &agent_record("t1", Some("def-a")),
        &RelaunchBlocked::AgentSessionUnavailable,
    );
    assert!(waits.contains("t1"));

    // Neither another agent, another definition, a saved connection opening
    // nor the store unlocking resumes it.
    assert!(due(&waits, &agent_opened("agent-2", Some("def-a")), &registry).is_empty());
    assert!(due(&waits, &agent_opened("agent-1", Some("def-b")), &registry).is_empty());
    assert!(due(&waits, &opened("def-a"), &registry).is_empty());
    assert!(due(&waits, &WaitTrigger::StoreUnlocked, &registry).is_empty());

    assert_eq!(
        due(&waits, &agent_opened("agent-1", Some("def-a")), &registry),
        vec!["t1"]
    );
    assert!(!waits.contains("t1"));
}

/// A remote-to-remote copy reading from an agent-hosted session (#4115)
/// waits for that agent's session when its own destination has no agent.
#[test]
fn an_agent_sourced_remote_copy_waits_for_its_source_agent() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    let mut copy = remote_copy("r2r", "conn-src", "conn-dst");
    if let Some(source) = copy.remote_source.as_mut() {
        source.agent = Some(crate::files::transfer::persist::PersistedAgentTarget {
            agent_id: "agent-src".to_string(),
            remote_session_id: "remote-old".to_string(),
            definition_id: Some("def-src".to_string()),
        });
    }
    note_blocked(&waits, &copy, &RelaunchBlocked::AgentSessionUnavailable);

    assert!(due(&waits, &agent_opened("agent-1", Some("def-src")), &registry).is_empty());
    assert_eq!(
        due(
            &waits,
            &agent_opened("agent-src", Some("def-src")),
            &registry
        ),
        vec!["r2r"]
    );
}

// --- agent-to-agent remote copies wait on both ends (#4158) -------------------

use crate::files::transfer::persist::PersistedAgentTarget;
use crate::files::transfer::relaunch_agent::{resolve_agent_target, AgentSessionIdentity};

fn agent_target(agent: &str, definition: &str) -> PersistedAgentTarget {
    PersistedAgentTarget {
        agent_id: agent.to_string(),
        remote_session_id: "remote-old".to_string(),
        definition_id: Some(definition.to_string()),
    }
}

/// A remote-to-remote copy from `agent-src` (`def-src`) to `agent-dst`
/// (`def-dst`).
fn agent_to_agent_copy(id: &str) -> PersistedTransfer {
    let mut copy = remote_copy(id, "conn-src", "conn-dst");
    copy.agent = Some(agent_target("agent-dst", "def-dst"));
    if let Some(source) = copy.remote_source.as_mut() {
        source.agent = Some(agent_target("agent-src", "def-src"));
    }
    copy
}

/// A reopened (new agent-side id) live session on `agent` from `definition`.
fn live(agent: &str, definition: &str) -> (AgentSessionIdentity, String) {
    (
        AgentSessionIdentity {
            agent_id: agent.to_string(),
            remote_session_id: "remote-new".to_string(),
            definition_id: Some(definition.to_string()),
        },
        format!("{agent}/{definition}"),
    )
}

/// Relaunch an agent-to-agent copy against the `live` agent sessions as the
/// app does: resolve the source, then the destination, each by its identity
/// and the ranged probe; a missing end blocks the row and puts it back on the
/// wait list. Returns the resolved ends when both are live.
async fn relaunch_copy(
    waits: &CredentialWaits,
    record: &PersistedTransfer,
    live: &[(AgentSessionIdentity, String)],
) -> Option<(String, String)> {
    let probe = |_: String| async { Ok(()) };
    let src = record
        .remote_source
        .as_ref()
        .and_then(|s| s.agent.as_ref())
        .unwrap();
    let dst = record.agent.as_ref().unwrap();
    let resolved = match resolve_agent_target(src, live.to_vec(), probe).await {
        Ok(src) => resolve_agent_target(dst, live.to_vec(), probe)
            .await
            .map(|dst| (src, dst)),
        Err(e) => Err(e),
    };
    match resolved {
        Ok(ends) => Some(ends),
        Err(blocked) => {
            note_blocked(waits, record, &blocked);
            None
        }
    }
}

/// Destination agent back first: the row retries and pauses again; once the
/// source agent reconnects too, the row resumes over both ends.
#[tokio::test]
async fn an_agent_to_agent_copy_resumes_when_the_source_returns_after_the_destination() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    let copy = agent_to_agent_copy("r2r");
    assert_eq!(relaunch_copy(&waits, &copy, &[]).await, None);
    assert!(waits.contains("r2r"));

    let mut sessions = vec![live("agent-dst", "def-dst")];
    let trigger = agent_opened("agent-dst", Some("def-dst"));
    assert_eq!(due(&waits, &trigger, &registry), vec!["r2r"]);
    assert_eq!(relaunch_copy(&waits, &copy, &sessions).await, None);
    assert!(waits.contains("r2r"), "only the destination is back");

    sessions.push(live("agent-src", "def-src"));
    let trigger = agent_opened("agent-src", Some("def-src"));
    assert_eq!(due(&waits, &trigger, &registry), vec!["r2r"]);
    assert_eq!(
        relaunch_copy(&waits, &copy, &sessions).await,
        Some((
            "agent-src/def-src".to_string(),
            "agent-dst/def-dst".to_string()
        ))
    );
    assert!(!waits.contains("r2r"));
}

/// Source agent back first: the same, the other way round.
#[tokio::test]
async fn an_agent_to_agent_copy_resumes_when_the_destination_returns_after_the_source() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    let copy = agent_to_agent_copy("r2r");
    assert_eq!(relaunch_copy(&waits, &copy, &[]).await, None);

    let mut sessions = vec![live("agent-src", "def-src")];
    let trigger = agent_opened("agent-src", Some("def-src"));
    assert_eq!(due(&waits, &trigger, &registry), vec!["r2r"]);
    assert_eq!(relaunch_copy(&waits, &copy, &sessions).await, None);
    assert!(waits.contains("r2r"), "only the source is back");

    sessions.push(live("agent-dst", "def-dst"));
    let trigger = agent_opened("agent-dst", Some("def-dst"));
    assert_eq!(due(&waits, &trigger, &registry), vec!["r2r"]);
    assert!(relaunch_copy(&waits, &copy, &sessions).await.is_some());
    assert!(!waits.contains("r2r"));
}

/// With only one end back the row stays paused and keeps waiting on both
/// identities, however often that end's sessions reopen.
#[tokio::test]
async fn an_agent_to_agent_copy_with_one_end_back_stays_paused() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    let copy = agent_to_agent_copy("r2r");
    assert_eq!(relaunch_copy(&waits, &copy, &[]).await, None);

    let sessions = [live("agent-dst", "def-dst")];
    for _ in 0..2 {
        let trigger = agent_opened("agent-dst", Some("def-dst"));
        assert_eq!(due(&waits, &trigger, &registry), vec!["r2r"]);
        assert_eq!(relaunch_copy(&waits, &copy, &sessions).await, None);
        assert!(waits.contains("r2r"));
    }
    // It still waits on the source's identity, too.
    let trigger = agent_opened("agent-src", Some("def-src"));
    assert_eq!(due(&waits, &trigger, &registry), vec!["r2r"]);
}

/// Sessions that match neither end's identity never retry the row, and a
/// relaunch against them never resumes it.
#[tokio::test]
async fn an_agent_to_agent_copy_never_resumes_on_mismatched_identities() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    let copy = agent_to_agent_copy("r2r");
    assert_eq!(relaunch_copy(&waits, &copy, &[]).await, None);

    for (agent, definition) in [
        ("agent-other", Some("def-src")),
        ("agent-src", Some("def-dst")),
        ("agent-dst", Some("def-src")),
        ("agent-dst", None),
    ] {
        let trigger = agent_opened(agent, definition);
        assert!(due(&waits, &trigger, &registry).is_empty(), "{agent}");
    }
    assert!(waits.contains("r2r"));

    // Swapped definitions on the right agents are still the wrong file
    // systems: the relaunch pauses the row again.
    let swapped = [live("agent-src", "def-dst"), live("agent-dst", "def-src")];
    assert_eq!(relaunch_copy(&waits, &copy, &swapped).await, None);
    assert!(waits.contains("r2r"));
}

/// An ad-hoc agent session can only come back as itself, so any session on
/// its agent retries it (the relaunch's identity check decides).
#[test]
fn an_ad_hoc_agent_transfer_retries_on_any_session_of_its_agent() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    note_blocked(
        &waits,
        &agent_record("t1", None),
        &RelaunchBlocked::AgentSessionUnavailable,
    );
    assert!(due(&waits, &agent_opened("agent-2", None), &registry).is_empty());
    assert_eq!(
        due(&waits, &agent_opened("agent-1", Some("def-x")), &registry),
        vec!["t1"]
    );
}

/// A credentials wait is not resumed by an agent session opening.
#[test]
fn a_credentials_wait_ignores_agent_sessions() {
    let waits = CredentialWaits::default();
    let registry = TransferRegistry::new();
    waiting(&waits, &record("t1", Some("conn-a")));
    assert!(due(&waits, &agent_opened("agent-1", Some("conn-a")), &registry).is_empty());
    assert!(waits.contains("t1"));
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
