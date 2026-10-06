#![cfg(feature = "vnc")]
//! VNC file-transfer side channel over a live SSH tunnel (#4191, concept
//! `vnc-clipboard-file-transfer`).
//!
//! Connects the `vnc` backend to the `vnc-server` fixture **through** the
//! `ssh-password` fixture's SSH tunnel (the VNC target is the compose service
//! name `vnc-server`, as seen from the SSH host), then opens an SFTP subsystem
//! channel on the tunnel's own SSH session — no second login — and resolves the
//! default destination folder. Finally checks the channel's lifetime is tied to
//! the tunnel: once the VNC session is closed, the SFTP channel stops working.
//!
//! Requires: `cd tests/docker && docker compose --profile vnc up -d ssh-password
//! vnc-server`. Skips gracefully otherwise (hard-fails under
//! `TERMIHUB_REQUIRE_DOCKER=1`).

mod common;

use std::time::Duration;

use common::{port_ssh_password, port_vnc, require_docker};
use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser};
use termihub_core::backends::vnc::Vnc;
use termihub_core::connection::graphical_files::{default_dir, desktop_dir};
use termihub_core::connection::{ConnectionType, FileSideChannelKind};
use termihub_core::files::FileBrowser;

/// VNC through the `ssh-password` fixture's tunnel, file transfer opted in.
fn tunnelled_settings(file_transfer: bool, view_only: bool) -> serde_json::Value {
    serde_json::json!({
        // The VNC host as seen from the SSH host: the compose service name.
        "host": "vnc-server",
        "port": 5900,
        "password": "testpass",
        "useSshTunnel": true,
        "sshHost": "127.0.0.1",
        "sshPort": port_ssh_password(),
        "sshUsername": "testuser",
        "sshAuthMethod": "password",
        "sshPassword": "testpass",
        "fileTransfer": file_transfer,
        "viewOnly": view_only,
    })
}

// ── VNC-FT-01: SFTP on the live tunnel session + default folder ─────

#[tokio::test]
async fn vnc_ft_01_sftp_on_the_tunnel_session_resolves_the_default_folder() {
    require_docker!(port_ssh_password());
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    vnc.connect(tunnelled_settings(true, false))
        .await
        .expect("VNC-FT-01: VNC through the SSH tunnel should connect");
    let graphical = vnc.graphical().expect("connected session is graphical");

    let channel = graphical
        .file_side_channel()
        .expect("VNC-FT-01: an opted-in tunnel offers an SSH side channel");
    assert_eq!(channel.kind, FileSideChannelKind::Ssh);
    assert_eq!(channel.host, "127.0.0.1");
    assert_eq!(channel.user, "testuser");
    assert!(
        !channel.same_host,
        "vnc-server is not the SSH host: files land on the SSH host"
    );

    let session = graphical
        .file_side_channel_ssh_session()
        .expect("VNC-FT-01: the tunnel's SSH session is reachable");
    let sftp = SftpFileBrowser::from_session(session)
        .await
        .expect("VNC-FT-01: SFTP opens on the tunnel's own session");

    let home = sftp.realpath(".").await.expect("realpath(.) is home");
    assert_eq!(home, "/home/testuser");
    let desktop_exists = sftp
        .stat(&desktop_dir(&home))
        .await
        .is_ok_and(|e| e.is_directory);
    let fallback = default_dir(None, &home, desktop_exists);
    if desktop_exists {
        assert_eq!(fallback, "/home/testuser/Desktop");
    } else {
        assert_eq!(fallback, home, "no ~/Desktop: the default is ~");
    }

    // A configured `~/…` folder resolves under home on the file host.
    let unique = format!("vnc-ft-{}", std::process::id());
    let configured = format!("~/{unique}");
    let dir = default_dir(Some(&configured), &home, desktop_exists);
    assert_eq!(dir, format!("/home/testuser/{unique}"));
    sftp.mkdir(&dir).await.expect("mkdir over the side channel");
    assert_eq!(sftp.realpath(&dir).await.unwrap(), dir);
    sftp.delete(&dir).await.expect("cleanup");

    // The channel's lifetime is the tunnel's: closing the VNC session tears the
    // tunnel down, disconnecting the SSH session under the SFTP channel.
    vnc.disconnect().await.expect("disconnect");
    let mut closed = false;
    for _ in 0..50 {
        if sftp.realpath(".").await.is_err() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(closed, "VNC-FT-01: SFTP must end with the tunnel");
}

// ── VNC-FT-02: off by default / view-only refuse the channel ────────

#[tokio::test]
async fn vnc_ft_02_opted_out_and_view_only_sessions_offer_no_channel() {
    require_docker!(port_ssh_password());
    require_docker!(port_vnc());

    for (file_transfer, view_only) in [(false, false), (true, true)] {
        let mut vnc = Vnc::new();
        vnc.connect(tunnelled_settings(file_transfer, view_only))
            .await
            .expect("VNC-FT-02: VNC through the SSH tunnel should connect");
        let graphical = vnc.graphical().expect("graphical");
        assert!(
            graphical.file_side_channel().is_none(),
            "fileTransfer={file_transfer} viewOnly={view_only}: no channel"
        );
        assert!(graphical.file_side_channel_ssh_session().is_none());
        vnc.disconnect().await.expect("disconnect");
    }
}

// ── VNC-FT-03: a queued upload over the tunnel's SFTP channel (#4192) ──

#[tokio::test]
async fn vnc_ft_03_queued_upload_runs_over_the_tunnel_sftp_channel() {
    use std::sync::Arc;
    use termihub_core::files::transfer::sftp::{run_sftp_transfer, DEFAULT_RESUME_MODE};
    use termihub_core::files::transfer::{
        ProgressSink, TransferDirection, TransferProgress, TransferRegistry, TransferStateTag,
    };

    require_docker!(port_ssh_password());
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    vnc.connect(tunnelled_settings(true, false))
        .await
        .expect("VNC-FT-03: VNC through the SSH tunnel should connect");
    let graphical = vnc.graphical().expect("graphical");
    let session = graphical
        .file_side_channel_ssh_session()
        .expect("VNC-FT-03: the tunnel's SSH session is reachable");
    let sftp = Arc::new(
        SftpFileBrowser::from_session(session)
            .await
            .expect("VNC-FT-03: SFTP opens on the tunnel's own session"),
    );

    let local_dir = tempfile::tempdir().expect("tempdir");
    let local = local_dir.path().join("drop.bin");
    let payload: Vec<u8> = (0..(300 * 1024)).map(|i| (i % 253) as u8).collect();
    std::fs::write(&local, &payload).expect("write local file");
    let remote = format!("/home/testuser/vnc-ft-03-{}.bin", std::process::id());

    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "vnc-ft-03",
        "rd-session",
        TransferDirection::Upload,
        "drop.bin",
        &remote,
        0,
    );
    let sink: ProgressSink = Arc::new(|_: &TransferProgress| {});
    run_sftp_transfer(
        sftp.clone(),
        TransferDirection::Upload,
        remote.clone(),
        local.to_string_lossy().into_owned(),
        handle,
        registry.clone(),
        sink,
        DEFAULT_RESUME_MODE,
        0,
    )
    .await;

    let state = registry
        .list(Some("rd-session"))
        .into_iter()
        .find(|s| s.transfer_id == "vnc-ft-03")
        .map(|s| s.state);
    assert_eq!(state, Some(TransferStateTag::Completed));
    assert_eq!(
        sftp.read_file(&remote).await.expect("read back"),
        payload,
        "VNC-FT-03: the bytes land on the SSH host unchanged"
    );
    sftp.delete(&remote).await.expect("cleanup");
    vnc.disconnect().await.expect("disconnect");
}
