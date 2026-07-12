#![cfg(feature = "ssh")]
//! Integration tests for [`ssh_exec_with_stdin`] against Docker SSH fixtures.
//!
//! Covers the helper's three captured outputs (stdout, stderr, exit status)
//! and stdin delivery, plus the exec-capability discriminator used by
//! [`SftpSession::has_exec_capability`](../../src-tauri): a shell connection
//! echoes a probe marker back on stdout (capable), while an SFTP-only
//! (`ForceCommand internal-sftp`) connection does not (not capable).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if the containers are not running.

mod common;

use common::{port_ssh_password, port_ssh_sftp_only, require_docker, ssh_password_config};
use termihub_core::backends::ssh::{auth::connect_and_authenticate, ssh_exec_with_stdin};

/// Marker echoed by the exec-capability probe. Kept in sync with the probe in
/// `src-tauri/src/files/sftp.rs`.
const EXEC_PROBE_MARKER: &str = "termihub_exec_probe_ok";

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

    let out = ssh_exec_with_stdin(&session, &format!("echo {EXEC_PROBE_MARKER}"), "")
        .await
        .expect("probe should execute on a shell connection");

    assert_eq!(out.exit_status, 0);
    assert!(
        out.stdout.contains(EXEC_PROBE_MARKER),
        "a shell connection must echo the probe marker back, got: {}",
        out.stdout
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
    // SFTP subsystem: the probe marker never reaches stdout. The channel may
    // still open, so we assert on the *absence of the marker*, which is exactly
    // what `has_exec_capability` keys off.
    let out = ssh_exec_with_stdin(&session, &format!("echo {EXEC_PROBE_MARKER}"), "").await;

    let marker_present = out
        .map(|o| o.stdout.contains(EXEC_PROBE_MARKER))
        .unwrap_or(false);
    assert!(
        !marker_present,
        "an SFTP-only connection must not echo the probe marker (no usable exec channel)"
    );
}
