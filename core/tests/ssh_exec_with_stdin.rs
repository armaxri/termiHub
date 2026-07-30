#![cfg(feature = "ssh")]
//! Integration tests for [`ssh_exec_with_stdin`] against Docker SSH fixtures.
//!
//! Covers the helper's three captured outputs (stdout, stderr, exit status)
//! and stdin delivery, plus the shared [`probe_exec_capability`] discriminator
//! used by `SftpSession::has_exec_capability` (in `src-tauri`): a shell
//! connection echoes the probe marker back on stdout (capable), while an
//! SFTP-only (`ForceCommand internal-sftp`) connection does not (not capable).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if the containers are not running.

mod common;

use common::{port_ssh_password, port_ssh_sftp_only, require_docker, ssh_password_config};
use termihub_core::backends::ssh::{
    auth::connect_and_authenticate, probe_exec_capability, ssh_exec_with_stdin,
};

#[tokio::test]
async fn exec_captures_stdout_and_zero_exit_for_id() {
    require_docker!(port_ssh_password());

    let config = ssh_password_config(port_ssh_password());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("password auth should succeed");

    let out = ssh_exec_with_stdin(&session, "id", "")
        .await
        .expect("id should execute");

    assert_eq!(out.exit_status, 0, "id should exit 0, got {out:?}");
    assert!(
        out.stdout.contains("uid="),
        "id stdout should contain uid=, got: {}",
        out.stdout
    );
}

#[tokio::test]
async fn exec_writes_stdin_to_the_command() {
    require_docker!(port_ssh_password());

    let config = ssh_password_config(port_ssh_password());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("password auth should succeed");

    // `cat` echoes its stdin verbatim — proves stdin is written and EOF sent.
    let payload = "hello from stdin\n";
    let out = ssh_exec_with_stdin(&session, "cat", payload)
        .await
        .expect("cat should execute");

    assert_eq!(out.exit_status, 0);
    assert_eq!(out.stdout, payload, "cat should echo the written stdin");
}

#[tokio::test]
async fn exec_captures_stderr_and_nonzero_exit_status() {
    require_docker!(port_ssh_password());

    let config = ssh_password_config(port_ssh_password());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("password auth should succeed");

    let out = ssh_exec_with_stdin(&session, "echo boom 1>&2; exit 7", "")
        .await
        .expect("command should execute");

    assert_eq!(out.exit_status, 7, "exit status should be captured");
    assert!(
        out.stderr.contains("boom"),
        "stderr should be captured, got: {}",
        out.stderr
    );
    assert!(
        out.stdout.is_empty(),
        "nothing was written to stdout, got: {}",
        out.stdout
    );
}

#[tokio::test]
async fn exec_capability_probe_true_for_shell_connection() {
    require_docker!(port_ssh_password());

    let config = ssh_password_config(port_ssh_password());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("password auth should succeed");

    // Exercise the production discriminator directly: a shell connection can
    // open and use an exec channel, so the probe reports it as capable.
    assert!(
        probe_exec_capability(&session).await,
        "a shell connection must be reported as exec-capable"
    );
}

#[tokio::test]
async fn exec_capability_probe_false_for_sftp_only_connection() {
    require_docker!(port_ssh_sftp_only());

    let config = ssh_password_config(port_ssh_sftp_only());
    let (session, _registry) = connect_and_authenticate(&config)
        .await
        .expect("password auth should succeed on the sftp-only fixture");

    // The server forces `internal-sftp`, so the exec request is replaced by the
    // SFTP subsystem: the probe marker never reaches stdout (and the channel may
    // still open or error). The production discriminator keys off exactly that,
    // so it must report the connection as not exec-capable.
    assert!(
        !probe_exec_capability(&session).await,
        "an SFTP-only connection must be reported as not exec-capable (no usable exec channel)"
    );
}
