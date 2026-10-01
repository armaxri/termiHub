#![cfg(feature = "ssh")]
//! Files-only SSH sessions on hosts that refuse the shell (#4078), against the
//! Docker SSH fixtures.
//!
//! On `ssh-sftp-only` (`ForceCommand internal-sftp`) the shell is refused, but the
//! SFTP subsystem works: the [`Ssh`] backend must keep the session up, report it
//! files-only through [`ConnectionType::files_only_watch`], and keep its file
//! browser usable. On a normal host (`ssh-password`) a shell the user exits must
//! still end the session as before and never report files-only.
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d
//! ssh-sftp-only ssh-password`. Skips gracefully when they are not running.

mod common;

use std::time::Duration;

use common::{port_ssh_password, port_ssh_sftp_only, require_docker};
use termihub_core::backends::ssh::Ssh;
use termihub_core::connection::ConnectionType;

fn password_settings(port: u16) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "testuser",
        "authMethod": "password",
        "password": "testpass",
        "shellIntegration": false,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sftp_only_host_keeps_the_session_files_only() {
    require_docker!(port_ssh_sftp_only());

    let mut ssh = Ssh::new();
    let mut watch = ssh
        .files_only_watch()
        .expect("ssh exposes a files-only watch");
    ssh.connect(password_settings(port_ssh_sftp_only()))
        .await
        .expect("connect to the sftp-only host");
    let mut output = ssh.subscribe_output();

    tokio::time::timeout(
        Duration::from_secs(30),
        watch.wait_for(|files_only| *files_only),
    )
    .await
    .expect("the refused shell must settle files-only in time")
    .expect("the watch stays open while the backend lives");

    assert!(ssh.is_connected(), "a files-only session stays connected");
    // The output stream stays open (no EOF), so the session manager keeps it.
    assert!(
        tokio::time::timeout(Duration::from_millis(500), async {
            while output.recv().await.is_some() {}
        })
        .await
        .is_err(),
        "a files-only session must not end its output stream"
    );
    ssh.write(b"ls\n")
        .expect("terminal input on a files-only session is dropped, not an error");

    // The file browser works over SFTP on the same session.
    let browser = ssh
        .file_browser()
        .expect("files-only keeps the file browser");
    let entries = browser
        .list_dir("/etc")
        .await
        .expect("list a directory on the sftp-only host");
    assert!(
        entries.iter().any(|e| e.name == "hostname"),
        "listing /etc must show hostname"
    );
    let hostname = browser
        .read_file("/etc/hostname")
        .await
        .expect("read a root-owned file over SFTP");
    assert!(!hostname.is_empty(), "/etc/hostname is not empty");

    ssh.disconnect().await.expect("disconnect");
    assert!(!ssh.is_connected());
    assert!(!*watch.borrow(), "disconnect clears files-only");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_normal_shell_exit_still_ends_the_session() {
    require_docker!(port_ssh_password());

    let mut ssh = Ssh::new();
    let watch = ssh
        .files_only_watch()
        .expect("ssh exposes a files-only watch");
    ssh.connect(password_settings(port_ssh_password()))
        .await
        .expect("connect to the shell host");
    let mut output = ssh.subscribe_output();

    // Let the login shell come up, then exit it as a user would.
    tokio::time::sleep(Duration::from_millis(500)).await;
    ssh.write(b"exit\n").expect("type exit");

    tokio::time::timeout(Duration::from_secs(20), async {
        while output.recv().await.is_some() {}
    })
    .await
    .expect("exiting the shell must end the output stream");
    // Give a (wrong) refusal probe time to flip the flag, then check it did not.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!*watch.borrow(), "a user exit is never files-only");
    assert!(!ssh.is_connected(), "the session ended");
    ssh.disconnect().await.ok();
}
