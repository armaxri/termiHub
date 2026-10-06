//! Relaunching graphical side-channel transfers after a restart (#4205): the
//! identity a transfer records, the refusal to resume on a different file
//! host, and when a relaunch waits for the VNC session instead of failing.

use std::sync::Arc;

use serde_json::Value;
use termihub_core::connection::{FileChannelUnavailable, FileSideChannel, FileSideChannelKind};

use super::*;
use crate::session::graphical_upload::AgentHostFiles;

fn persisted(route: FileSideChannelKind) -> PersistedGraphicalTarget {
    PersistedGraphicalTarget {
        connection_id: "Lab/pi-desktop".to_string(),
        route,
        host: "lab-pi".to_string(),
        user: "pi".to_string(),
        agent_id: (route == FileSideChannelKind::Agent).then(|| "agent-1".to_string()),
    }
}

fn identity(route: FileSideChannelKind, host: &str, user: &str) -> SideChannelIdentity {
    SideChannelIdentity {
        route,
        host: host.to_string(),
        user: user.to_string(),
        agent_id: (route == FileSideChannelKind::Agent).then(|| "agent-1".to_string()),
    }
}

fn channel(kind: FileSideChannelKind, host: &str) -> FileSideChannel {
    FileSideChannel {
        kind,
        host: host.to_string(),
        user: "pi".to_string(),
        same_host: true,
    }
}

const SSH: FileSideChannelKind = FileSideChannelKind::Ssh;
const AGENT: FileSideChannelKind = FileSideChannelKind::Agent;

// ── Identity ────────────────────────────────────────────────────────

/// The same route to the same host as the same account matches; an unknown
/// account on either side does not block the match.
#[test]
fn the_same_route_host_and_account_match() {
    for route in [SSH, AGENT] {
        assert_eq!(
            identity_mismatch(&persisted(route), &identity(route, "lab-pi", "pi")),
            None
        );
        assert_eq!(
            identity_mismatch(&persisted(route), &identity(route, "lab-pi", "")),
            None
        );
    }
}

/// Another host, account, route or agent never matches: the partial file is
/// not continued on a different machine, and the message says where the
/// connection leads now.
#[test]
fn a_different_host_route_account_or_agent_is_refused() {
    let ssh = persisted(SSH);
    let message = identity_mismatch(&ssh, &identity(SSH, "other-box", "pi")).unwrap();
    assert!(message.contains("pi@other-box (SSH tunnel)"), "{message}");
    assert!(message.contains("not pi@lab-pi (SSH tunnel)"), "{message}");
    assert!(message.contains("different host"), "{message}");

    assert!(identity_mismatch(&ssh, &identity(SSH, "lab-pi", "root")).is_some());
    assert!(identity_mismatch(&ssh, &identity(AGENT, "lab-pi", "pi")).is_some());

    let agent = persisted(AGENT);
    let mut other_agent = identity(AGENT, "lab-pi", "pi");
    other_agent.agent_id = Some("agent-2".to_string());
    assert!(identity_mismatch(&agent, &other_agent).is_some());
    other_agent.agent_id = None;
    assert!(identity_mismatch(&agent, &other_agent).is_some());
}

/// An empty persisted host never matches an empty live one.
#[test]
fn an_empty_host_never_matches() {
    let mut empty = persisted(SSH);
    empty.host = String::new();
    assert!(identity_mismatch(&empty, &identity(SSH, "", "pi")).is_some());
}

/// A side channel's answer is classified: `ready` can carry the transfer,
/// `degraded` is worth waiting for, `unavailable` refuses with the reason.
#[test]
fn live_side_channels_are_classified_by_status() {
    let ready = RemoteDesktopFileChannel::Ready {
        channel: channel(AGENT, "lab-pi"),
        agent_id: Some("agent-1".to_string()),
        default_dir: "/home/pi/Desktop".to_string(),
    };
    assert_eq!(
        LiveSideChannel::of(&ready),
        LiveSideChannel::Ready(identity(AGENT, "lab-pi", "pi"))
    );

    let degraded = RemoteDesktopFileChannel::Degraded {
        channel: channel(SSH, "lab-pi"),
        agent_id: None,
        message: "SFTP is not enabled".to_string(),
    };
    assert_eq!(
        LiveSideChannel::of(&degraded),
        LiveSideChannel::Degraded {
            identity: identity(SSH, "lab-pi", "pi"),
            message: "SFTP is not enabled".to_string(),
        }
    );

    let off = RemoteDesktopFileChannel::Unavailable {
        reason: FileChannelUnavailable::Disabled,
    };
    match LiveSideChannel::of(&off) {
        LiveSideChannel::Refused(message) => assert!(message.contains("turned off"), "{message}"),
        other => panic!("expected Refused, got {other:?}"),
    }
}

/// The SSH route records no agent even when one is passed; the agent route
/// records its agent.
#[test]
fn the_identity_keeps_the_agent_only_for_the_agent_route() {
    assert_eq!(
        SideChannelIdentity::of(&channel(SSH, "lab-pi"), Some("agent-1")).agent_id,
        None
    );
    assert_eq!(
        SideChannelIdentity::of(&channel(AGENT, "lab-pi"), Some("agent-1")).to_persisted("c"),
        PersistedGraphicalTarget {
            connection_id: "c".to_string(),
            route: AGENT,
            host: "lab-pi".to_string(),
            user: "pi".to_string(),
            agent_id: Some("agent-1".to_string()),
        }
    );
}

struct NoAgent;

impl AgentRequests for NoAgent {
    fn request(&self, _: &str, _: &str, _: Value) -> Result<Value, String> {
        Err("unused".to_string())
    }
}

/// A transfer records the side channel only for a session opened from a
/// saved connection — nothing could find an unsaved one after a restart.
#[test]
fn only_a_saved_connections_side_channel_is_recorded() {
    let carrier = UploadCarrier::Agent(Arc::new(AgentHostFiles::new(
        "agent-1".to_string(),
        Arc::new(NoAgent),
    )));
    let lab = channel(AGENT, "lab-pi");
    assert_eq!(side_channel_target(None, &lab, &carrier), None);
    assert_eq!(side_channel_target(Some(""), &lab, &carrier), None);
    assert_eq!(
        side_channel_target(Some("Lab/pi-desktop"), &lab, &carrier),
        Some(persisted(AGENT))
    );
}

// ── Resolution ──────────────────────────────────────────────────────

async fn resolve(
    live: Vec<(LiveSideChannel, &'static str)>,
) -> Result<&'static str, RelaunchBlocked> {
    resolve_graphical_target(&persisted(SSH), live, |target| async move {
        if target == "broken" {
            Err("SFTP is not enabled on lab-pi".to_string())
        } else {
            Ok(target)
        }
    })
    .await
}

fn ready(host: &str) -> LiveSideChannel {
    LiveSideChannel::Ready(identity(SSH, host, "pi"))
}

fn degraded(host: &str) -> LiveSideChannel {
    LiveSideChannel::Degraded {
        identity: identity(SSH, host, "pi"),
        message: "the tunnel is not connected".to_string(),
    }
}

/// Right after a restart no session of the connection is open: the row
/// stays paused with the VNC reason (and waits), it does not fail.
#[tokio::test]
async fn no_session_keeps_the_row_waiting_for_the_vnc_connection() {
    let err = resolve(vec![]).await.unwrap_err();
    assert_eq!(err, RelaunchBlocked::GraphicalSessionUnavailable);
    assert_eq!(err.message(), GRAPHICAL_SESSION_UNAVAILABLE);
    assert!(err.message().contains("reconnect to resume"));
}

/// A ready channel to the same host carries the transfer; a session whose
/// channel leads elsewhere is skipped for it.
#[tokio::test]
async fn a_ready_matching_channel_is_used_and_a_mismatch_skipped() {
    assert_eq!(
        resolve(vec![
            (ready("other-box"), "elsewhere"),
            (ready("lab-pi"), "lab")
        ])
        .await,
        Ok("lab")
    );
}

/// Only a channel to another host: the row fails with the reason instead of
/// resuming the partial file there.
#[tokio::test]
async fn only_a_different_host_fails_the_row() {
    match resolve(vec![(ready("other-box"), "elsewhere")]).await {
        Err(RelaunchBlocked::Failed(message)) => {
            assert!(message.contains("other-box"), "{message}")
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// A matching channel that is degraded (the tunnel is still coming up) is
/// worth waiting for — even when another session leads elsewhere.
#[tokio::test]
async fn a_degraded_matching_channel_keeps_waiting() {
    assert_eq!(
        resolve(vec![(degraded("lab-pi"), "lab")]).await,
        Err(RelaunchBlocked::GraphicalSessionUnavailable)
    );
    assert_eq!(
        resolve(vec![
            (ready("other-box"), "elsewhere"),
            (degraded("lab-pi"), "lab")
        ])
        .await,
        Err(RelaunchBlocked::GraphicalSessionUnavailable)
    );
    // A degraded channel to another host is not worth waiting for.
    assert!(matches!(
        resolve(vec![(degraded("other-box"), "elsewhere")]).await,
        Err(RelaunchBlocked::Failed(_))
    ));
}

/// A session with file transfer turned off fails the row with the reason.
#[tokio::test]
async fn a_session_without_file_transfer_fails_the_row() {
    let refused = LiveSideChannel::Refused("File transfer is turned off".to_string());
    match resolve(vec![(refused, "off")]).await {
        Err(RelaunchBlocked::Failed(message)) => {
            assert!(message.contains("turned off"), "{message}")
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// A carrier that cannot be opened is skipped for the next matching session;
/// when none opens, the row fails with the carrier's reason.
#[tokio::test]
async fn a_carrier_that_does_not_open_is_skipped_then_fails() {
    assert_eq!(
        resolve(vec![(ready("lab-pi"), "broken"), (ready("lab-pi"), "lab")]).await,
        Ok("lab")
    );
    match resolve(vec![(ready("lab-pi"), "broken")]).await {
        Err(RelaunchBlocked::Failed(message)) => {
            assert!(message.contains("SFTP is not enabled"), "{message}")
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

// ── Startup ─────────────────────────────────────────────────────────

/// At startup, a side-channel upload the quit cut off (still queued or
/// running) waits for its VNC connection, and reopening it resumes the upload;
/// one the user had paused, and any other kind of transfer, stays an ordinary
/// paused row.
#[test]
fn quit_interrupted_side_channel_transfers_wait_for_their_vnc_connection() {
    use crate::files::transfer::persist::PersistedTransferStatus;
    use crate::files::transfer::relaunch_auto::{due, WaitTrigger};
    use crate::files::transfer::{TransferDirection, TransferRegistry};

    let dir = tempfile::TempDir::new().unwrap();
    let persist = TransferPersistenceManager::new_test(dir.path());
    for (id, graphical, status) in [
        ("cut-off", true, PersistedTransferStatus::Active),
        ("queued", true, PersistedTransferStatus::Queued),
        ("user-paused", true, PersistedTransferStatus::Paused),
        ("ssh", false, PersistedTransferStatus::Active),
    ] {
        persist.record_registration(
            id,
            "rd-old",
            TransferDirection::Upload,
            "big.bin",
            "/home/pi/Desktop/big.bin",
            Some("/local/big.bin".to_string()),
            0,
        );
        if graphical {
            persist.record_graphical_target(id, persisted(SSH));
        }
        if status != PersistedTransferStatus::Queued {
            persist.note_progress(id, status, 4096, 8192, false, None);
        }
    }

    let mut parked: Vec<_> = park_interrupted(&persist).into_iter().collect();
    parked.sort();
    assert_eq!(parked, ["cut-off", "queued"]);

    let registry = TransferRegistry::new();
    let waits = persist.credential_waits();
    assert!(due(
        waits,
        &WaitTrigger::GraphicalSessionActive("Lab/other".to_string()),
        &registry
    )
    .is_empty());
    let mut resumed = due(
        waits,
        &WaitTrigger::GraphicalSessionActive("Lab/pi-desktop".to_string()),
        &registry,
    );
    resumed.sort();
    assert_eq!(resumed, ["cut-off", "queued"]);
}
