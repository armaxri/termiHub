//! Live outcome of the agent **setup tab** on a real Windows OpenSSH host
//! (#5992).
//!
//! The setup types its install into a PTY shell, whose exit code Win32-OpenSSH
//! does not pass on: a failed setup arrives as `0`. These cases type the
//! production lines ([`windows_setup_input`]) into a real SSH terminal and then
//! run the production host check, once per `DefaultShell`:
//!
//! 1. **Installed** — the binary is staged: the lines run (so Enter reaches the
//!    shell), end the shell, and the check finds the uploaded agent running.
//! 2. **Old agent left in place** — another build was meant to be installed but
//!    the shell ended without installing it: failed, although the old agent
//!    answers `--version` with the same version.
//! 3. **Deliberately failed setup** — nothing is staged: failed, whatever exit
//!    code the server reports (it is logged).
//! 4. **Cleaned up** — a working agent is put back.
//!
//! Gated like the parent's tests; the recipe runs it right after the
//! deploy/connect/reattach test of the same shell.

use super::*;
use crate::terminal::agent_setup::windows_setup_input;
use crate::terminal::agent_setup_outcome::{
    check_host, sha256_hex, windows_setup_outcome, SetupOutcome, ShellEnd, CHECK_TIMEOUT,
};
use crate::utils::remote_exec::upload_bytes_via_sftp;
use termihub_core::connection::ConnectionType;

/// The production pause before the setup types into a fresh shell.
const SHELL_INIT: Duration = Duration::from_secs(2);

/// Type `lines` into a fresh setup terminal and wait until its shell ends.
async fn run_in_setup_tab(fixture: &Fixture, lines: &[String]) -> (ShellEnd, String) {
    let mut ssh = termihub_core::backends::ssh::Ssh::new();
    let settings = serde_json::to_value(fixture.ssh_config()).expect("SSH settings");
    ssh.connect(settings)
        .await
        .unwrap_or_else(|e| panic!("the setup terminal did not connect: {e}"));
    let mut rx = ssh.subscribe_output();
    tokio::time::sleep(SHELL_INIT).await;
    for line in lines {
        ssh.write(line.as_bytes()).expect("type a setup line");
    }
    let mut raw = Vec::new();
    let ended = tokio::time::timeout(LIVE_CEILING, async {
        while let Some(chunk) = rx.recv().await {
            raw.extend_from_slice(&chunk);
        }
    })
    .await
    .is_ok();
    let end = match ssh.exit_code() {
        Some(code) if ended => ShellEnd::Exited(code),
        _ if ended => ShellEnd::NoStatus,
        _ => ShellEnd::StillOpen,
    };
    let _ = ssh.disconnect().await;
    (end, strip_ansi(&String::from_utf8_lossy(&raw)))
}

/// Stage `upload` (if any) as the setup does, over the setup's own session.
async fn stage(fixture: &Fixture, upload: Option<Vec<u8>>) {
    let config = fixture.ssh_config();
    tokio::task::spawn_blocking(move || {
        let Some(bytes) = upload else { return };
        let session = connect_and_authenticate(&config).expect("SFTP session");
        upload_bytes_via_sftp(&session, &bytes, WINDOWS_UPLOAD_NAME).expect("upload the agent");
    })
    .await
    .expect("upload thread");
}

/// The production outcome of a run that ended as `end` and meant to install
/// `binary`.
async fn outcome(fixture: &Fixture, end: ShellEnd, binary: &[u8]) -> SetupOutcome {
    let (config, sha) = (fixture.ssh_config(), sha256_hex(binary));
    tokio::task::spawn_blocking(move || {
        let session = connect_and_authenticate(&config).expect("SSH session");
        let check = check_host(&session, &sha, CHECK_TIMEOUT);
        eprintln!("shell end {end:?}, host check {check:?}");
        windows_setup_outcome(end, &check)
    })
    .await
    .expect("check thread")
}

async fn setup_outcome(want: WindowsDeployShell) {
    let Some(fixture) = live_fixture() else {
        return;
    };
    if fixture.default_shell != want {
        eprintln!(
            "SKIPPED: the fixture's OpenSSH DefaultShell is {:?}, this test needs {want:?} \
             (the lane runs each shell's test in its own step)",
            fixture.default_shell
        );
        return;
    }
    trust_all_host_keys();
    let working = read_agent_bin(&fixture).unwrap_or_else(|e| panic!("{e}"));
    // Trailing bytes a PE image ignores: another build of the same version.
    let newer = [working.as_slice(), b"termiHub #5992"].concat();
    let lines = windows_setup_input(want);

    // ── 1. Installed.
    stage(&fixture, Some(working.clone())).await;
    let (end, text) = run_in_setup_tab(&fixture, &lines).await;
    assert!(
        matches!(end, ShellEnd::Exited(_)),
        "the setup lines did not end the shell ({end:?}): {text:?}"
    );
    assert_eq!(
        outcome(&fixture, end, &working).await,
        SetupOutcome::Installed,
        "{text:?}"
    );

    // ── 2. The old agent is still there.
    let (end, text) = run_in_setup_tab(&fixture, &["exit\r".to_string()]).await;
    let failed = outcome(&fixture, end, &newer).await;
    assert!(
        matches!(&failed, SetupOutcome::Failed(why) if why.contains("older agent")),
        "an old agent left in place must be a failed setup, got {failed:?}: {text:?}"
    );

    // ── 3. A deliberately failed setup: nothing was uploaded.
    let (end, text) = run_in_setup_tab(&fixture, &lines).await;
    eprintln!("{want:?}: the failed setup's shell ended as {end:?}");
    let failed = outcome(&fixture, end, &working).await;
    assert!(
        matches!(end, ShellEnd::Exited(_)) && matches!(failed, SetupOutcome::Failed(_)),
        "a failed setup must be reported failed, got {end:?} / {failed:?}: {text:?}"
    );

    // ── 4. Leave a working agent.
    stage(&fixture, Some(working.clone())).await;
    let (end, text) = run_in_setup_tab(&fixture, &lines).await;
    assert_eq!(
        outcome(&fixture, end, &working).await,
        SetupOutcome::Installed,
        "{text:?}"
    );
}

/// #5992 with the OpenSSH `DefaultShell` left at `cmd.exe`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cmd_default_shell_setup_outcome() {
    setup_outcome(WindowsDeployShell::Native(WindowsShell::Cmd)).await;
}

/// #5992 with the OpenSSH `DefaultShell` set to PowerShell.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn powershell_default_shell_setup_outcome() {
    setup_outcome(WindowsDeployShell::Native(WindowsShell::PowerShell)).await;
}

/// #5992 with the OpenSSH `DefaultShell` set to Git Bash.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bash_default_shell_setup_outcome() {
    setup_outcome(WindowsDeployShell::EncodedPowerShell).await;
}
