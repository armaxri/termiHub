//! "Browse remote files" (#4193): only a `ready` side channel opens, the start
//! folder is checked, and the carrier is registered under the graphical
//! session id (agent route against a fake agent host; the SSH route's live
//! run is VNC-FT-04 in `core/tests/vnc_file_channel.rs`).

use std::collections::HashSet;

use serde_json::Value;
use termihub_core::connection::{FileChannelUnavailable, FileSideChannel, FileSideChannelKind};
use termihub_core::files::FileEntry;
use termihub_core::protocol::methods::CONNECTION_FILES_STAT;

use super::*;

/// A fake agent host with a few folders that answers host-level `stat`.
struct FakeAgent {
    dirs: HashSet<&'static str>,
}

impl FakeAgent {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            dirs: ["/home/pi", "/home/pi/Desktop", "/home/pi/Downloads"].into(),
        })
    }
}

impl AgentRequests for FakeAgent {
    fn request(&self, _agent_id: &str, method: &str, params: Value) -> Result<Value, String> {
        if !params["connection_id"].is_null() {
            return Err("host-level request expected".to_string());
        }
        assert_eq!(method, CONNECTION_FILES_STAT);
        let path = params["path"]
            .as_str()
            .unwrap_or_default()
            .replacen('~', "/home/pi", 1);
        if self.dirs.contains(path.as_str()) {
            Ok(serde_json::to_value(FileEntry {
                name: path.rsplit('/').next().unwrap_or_default().to_string(),
                path,
                is_directory: true,
                ..FileEntry::default()
            })
            .unwrap())
        } else {
            Err(format!("{path}: not found"))
        }
    }
}

fn side_channel(kind: FileSideChannelKind) -> FileSideChannel {
    FileSideChannel {
        kind,
        host: "lab-pi".to_string(),
        user: "pi".to_string(),
        same_host: true,
    }
}

fn ready_agent() -> RemoteDesktopFileChannel {
    RemoteDesktopFileChannel::Ready {
        channel: side_channel(FileSideChannelKind::Agent),
        agent_id: Some("agent-1".to_string()),
        default_dir: "/home/pi/Desktop".to_string(),
    }
}

async fn open(
    side: &SideChannelBrowsers,
    channel: RemoteDesktopFileChannel,
    dir: Option<&str>,
) -> Result<RemoteDesktopFileBrowser, TerminalError> {
    let agents: Arc<dyn AgentRequests> = FakeAgent::new();
    open_side_channel(
        side,
        "rd-1",
        channel,
        None,
        agents,
        dir.map(str::to_string),
        None,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ready_agent_route_opens_at_the_default_folder() {
    let side = SideChannelBrowsers::default();
    let opened = open(&side, ready_agent(), None).await.unwrap();
    assert_eq!(opened.start_dir, "/home/pi/Desktop");
    assert_eq!(opened.channel, side_channel(FileSideChannelKind::Agent));
    assert!(side.get("rd-1").and_then(|c| c.agent()).is_some());
}

/// Opened for a session of a saved connection, the side channel carries the
/// identity its downloads and uploads persist (#4205); without one it
/// carries none, so they are not persisted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_connections_side_channel_registers_its_identity() {
    let side = SideChannelBrowsers::default();
    open(&side, ready_agent(), None).await.unwrap();
    assert_eq!(side.target("rd-1"), None);

    let agents: Arc<dyn AgentRequests> = FakeAgent::new();
    open_side_channel(
        &side,
        "rd-1",
        ready_agent(),
        None,
        agents,
        None,
        Some("Lab/pi-desktop"),
    )
    .await
    .unwrap();
    assert_eq!(
        side.target("rd-1"),
        Some(crate::files::transfer::persist::PersistedGraphicalTarget {
            connection_id: "Lab/pi-desktop".to_string(),
            route: FileSideChannelKind::Agent,
            host: "lab-pi".to_string(),
            user: "pi".to_string(),
            agent_id: Some("agent-1".to_string()),
        })
    );
    assert!(side.remove("rd-1"));
    assert_eq!(side.target("rd-1"), None, "closing drops the identity");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_requested_folder_is_expanded_and_must_exist() {
    let side = SideChannelBrowsers::default();
    let opened = open(&side, ready_agent(), Some("~/Downloads"))
        .await
        .unwrap();
    assert_eq!(opened.start_dir, "/home/pi/Downloads");

    let fresh = SideChannelBrowsers::default();
    let err = open(&fresh, ready_agent(), Some("/home/pi/missing"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("does not exist"), "{err}");
    assert!(
        fresh.get("rd-1").is_none(),
        "a refused open registers nothing"
    );
}

#[tokio::test]
async fn view_only_off_and_no_route_never_open() {
    for reason in [
        FileChannelUnavailable::ViewOnly,
        FileChannelUnavailable::Disabled,
        FileChannelUnavailable::NoRoute,
    ] {
        let side = SideChannelBrowsers::default();
        let err = open(
            &side,
            RemoteDesktopFileChannel::Unavailable { reason },
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, TerminalError::RemoteError(_)), "{err:?}");
        assert!(side.get("rd-1").is_none());
    }
}

#[tokio::test]
async fn a_degraded_route_does_not_open() {
    let side = SideChannelBrowsers::default();
    let err = open(
        &side,
        RemoteDesktopFileChannel::Degraded {
            channel: side_channel(FileSideChannelKind::Ssh),
            agent_id: None,
            message: "SFTP is not enabled on lab-pi".to_string(),
        },
        None,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("SFTP is not enabled"), "{err}");
    assert!(side.get("rd-1").is_none());
}

#[tokio::test]
async fn an_ssh_route_without_its_tunnel_session_does_not_open() {
    let side = SideChannelBrowsers::default();
    let err = open(
        &side,
        RemoteDesktopFileChannel::Ready {
            channel: side_channel(FileSideChannelKind::Ssh),
            agent_id: None,
            default_dir: "/home/pi".to_string(),
        },
        None,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("not connected"), "{err}");
    assert!(side.get("rd-1").is_none());
}
