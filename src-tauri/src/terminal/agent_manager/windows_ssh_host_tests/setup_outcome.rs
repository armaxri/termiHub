//! Live agent **setup tab** on a real Windows OpenSSH host: the outcome it
//! reports (#5992) and the agent it must never lose (#5996).
//!
//! The setup runs its uploaded script in a PTY shell, whose exit code
//! Win32-OpenSSH does not pass on: a failed setup arrives as `0`. These cases
//! type the production line ([`windows_setup_input`]) into a real SSH terminal
//! and then run the production recovery and host check, once per
//! `DefaultShell`:
//!
//! 1. **Installed** — the line runs (so Enter reaches the shell), ends the
//!    shell, and the check finds the uploaded agent running.
//! 2. **Failed update, agent in use** — the new binary does not start, while a
//!    connected agent holds the old exe: failed, and the OLD agent is still
//!    installed and starts.
//! 3. **Update, agent in use** — another build replaces the running agent.
//! 4. **Failed update, nothing uploaded** — failed, the old agent is kept.
//! 5. **Interrupted** — the agent is renamed away as a setup killed between its
//!    two renames leaves it: the recovery puts it back.
//! 6. **Not run** — the shell ended without running the script: failed, although
//!    the old agent answers `--version` with the same version.
//!
//! Gated like the parent's tests; the recipe runs it right after the
//! deploy/connect/reattach test of the same shell.

use super::rollback::{run_checked, BROKEN_AGENT};
use super::*;
use crate::terminal::agent_install::{powershell_single_quote, resolve_windows_install_path};
use crate::terminal::agent_setup_outcome::{
    check_host, recover_and_check_host, sha256_hex, windows_setup_outcome, HostCheck, SetupOutcome,
    ShellEnd, CHECK_TIMEOUT,
};
use crate::terminal::agent_setup_windows::{
    windows_setup_input, windows_setup_script, WINDOWS_SETUP_SCRIPT_NAME,
};
use crate::utils::remote_exec::upload_bytes_via_sftp;
use termihub_core::backends::ssh::handler::SshSession;
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

/// Run `work` over a fresh SSH session, off the async threads.
async fn over_ssh<T: Send + 'static>(
    fixture: &Fixture,
    work: impl FnOnce(&SshSession) -> T + Send + 'static,
) -> T {
    let config = fixture.ssh_config();
    tokio::task::spawn_blocking(move || {
        let session = connect_and_authenticate(&config).expect("SSH session");
        work(&session)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()))
}

/// Run the whole setup of `upload`, staged as the setup does, and return the
/// production outcome for a run meant to install `meant`.
async fn run_setup(
    fixture: &Fixture,
    lines: &[String],
    upload: Option<Vec<u8>>,
    meant: &[u8],
) -> SetupOutcome {
    over_ssh(fixture, move |session| {
        if let Some(bytes) = upload {
            upload_bytes_via_sftp(session, &bytes, WINDOWS_UPLOAD_NAME).expect("upload the agent");
        }
        upload_bytes_via_sftp(
            session,
            windows_setup_script().as_bytes(),
            WINDOWS_SETUP_SCRIPT_NAME,
        )
        .expect("upload the script");
    })
    .await;
    let (end, text) = run_in_setup_tab(fixture, lines).await;
    assert!(
        matches!(end, ShellEnd::Exited(_)),
        "the setup did not end its shell ({end:?}): {text:?}"
    );
    let sha = sha256_hex(meant);
    over_ssh(fixture, move |session| {
        let check = recover_and_check_host(session, &sha, CHECK_TIMEOUT);
        eprintln!("shell end {end:?}, host check {check:?}, tab: {text:?}");
        windows_setup_outcome(end, &check)
    })
    .await
}

/// The host runs exactly `binary`, and no copy of an agent is left except
/// images a running agent may hold.
async fn assert_host_runs(fixture: &Fixture, binary: &[u8], what: &str) {
    let sha = sha256_hex(binary);
    let listing = powershell_encoded_command(
        r#"(Get-ChildItem "$env:LOCALAPPDATA\termiHub\agent").Name; (Get-ChildItem $env:USERPROFILE -Filter 'termihub-agent*').Name"#,
    );
    let (check, left) = over_ssh(fixture, move |session| {
        (
            check_host(session, &sha, CHECK_TIMEOUT).expect("host check"),
            run_remote_command(session, &listing).expect("listing"),
        )
    })
    .await;
    assert_eq!(check, HostCheck::Installed, "{what}: {left:?}");
    for name in ["previous", "new.exe", "upload", "setup.ps1"] {
        assert!(!left.contains(name), "{what}: {name} left behind: {left:?}");
    }
}

fn assert_failed_but_kept(outcome: &SetupOutcome, what: &str) {
    assert!(
        matches!(outcome, SetupOutcome::Failed(why) if why.contains("previous agent is still in place")),
        "{what}: must fail and keep the previous agent, got {outcome:?}"
    );
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
    let old = read_agent_bin(&fixture).unwrap_or_else(|e| panic!("{e}"));
    // Trailing bytes a PE image ignores: another build of the same version.
    let newer = [old.as_slice(), b"termiHub #5992"].concat();
    let lines = windows_setup_input(want);

    // ── 1. Installed.
    let outcome = run_setup(&fixture, &lines, Some(old.clone()), &old).await;
    assert_eq!(outcome, SetupOutcome::Installed);
    assert_host_runs(&fixture, &old, "first install").await;

    // ── 2. A failed update while a connected agent holds the old exe.
    let path = over_ssh(&fixture, move |session| {
        resolve_windows_install_path(session, want).expect("install path")
    })
    .await;
    let mut request_id = 0u64;
    let running = establish(&fixture.agent_config(&path), &mut request_id).await;
    let broken = BROKEN_AGENT.to_vec();
    let outcome = run_setup(&fixture, &lines, Some(broken.clone()), &broken).await;
    assert_failed_but_kept(&outcome, "broken update of a running agent");
    assert_host_runs(&fixture, &old, "the OLD agent after a failed update").await;

    // ── 3. A working update of the running agent.
    let outcome = run_setup(&fixture, &lines, Some(newer.clone()), &newer).await;
    assert_eq!(
        outcome,
        SetupOutcome::Installed,
        "update of a running agent"
    );
    assert_host_runs(&fixture, &newer, "updated agent").await;
    drop(running);

    // ── 4. A failed update: nothing was uploaded.
    let outcome = run_setup(&fixture, &lines, None, &old).await;
    assert_failed_but_kept(&outcome, "update without an upload");
    assert_host_runs(&fixture, &newer, "agent after an update without an upload").await;

    // ── 5. Killed between the two renames, then the desktop's recovery.
    let sha = sha256_hex(&newer);
    let away = powershell_encoded_command(&format!(
        "Set-Location (Join-Path $env:LOCALAPPDATA {}); \
         Move-Item -ErrorAction Stop termihub-agent.exe termihub-agent.previous.exe",
        powershell_single_quote(r"termiHub\agent")
    ));
    let recovered = over_ssh(&fixture, move |session| {
        run_checked(session, &away, "renaming the agent away");
        assert_eq!(
            check_host(session, &sha, CHECK_TIMEOUT).expect("host check"),
            HostCheck::Absent
        );
        recover_and_check_host(session, &sha, CHECK_TIMEOUT)
    })
    .await;
    assert!(
        matches!(recovered, Ok(HostCheck::Installed)),
        "an interrupted setup must be recovered: {recovered:?}"
    );
    assert_host_runs(&fixture, &newer, "recovered agent").await;

    // ── 5b. Killed between the two renames with the desktop gone: a plain
    // connect puts the agent back and starts it (#6002).
    let away_again = powershell_encoded_command(&format!(
        "Set-Location (Join-Path $env:LOCALAPPDATA {}); \
         Move-Item -ErrorAction Stop termihub-agent.exe termihub-agent.previous.exe",
        powershell_single_quote(r"termiHub\agent")
    ));
    over_ssh(&fixture, move |session| {
        run_checked(session, &away_again, "renaming the agent away");
    })
    .await;
    let mut request_id = 0u64;
    let connected = establish(&fixture.agent_config(&path), &mut request_id).await;
    drop(connected);
    assert_host_runs(&fixture, &newer, "agent a connect recovered").await;

    // ── 6. The shell ended without running the script.
    let exit = ["exit\r".to_string()];
    let outcome = run_setup(&fixture, &exit, None, &old).await;
    assert_failed_but_kept(&outcome, "a setup that never ran");

    // ── 7. An execution policy of AllSigned from group policy (#6001).
    if set_user_policy(&fixture, Some("AllSigned")).await {
        let outcome = run_setup(&fixture, &lines, Some(old.clone()), &old).await;
        set_user_policy(&fixture, None).await;
        assert_eq!(
            outcome,
            SetupOutcome::Installed,
            "a host whose policy is AllSigned installs the agent"
        );
        assert_host_runs(&fixture, &old, "installed under AllSigned").await;
    }
}

/// Set (or with `None` remove) the fixture user's execution policy as group
/// policy sets it (`HKCU\Software\Policies\…\PowerShell`), which wins over
/// `-ExecutionPolicy`. `false` when the user may not write it: the step is
/// skipped and says so.
async fn set_user_policy(fixture: &Fixture, policy: Option<&str>) -> bool {
    let key = r"HKCU:\Software\Policies\Microsoft\Windows\PowerShell";
    let script = match policy {
        Some(policy) => format!(
            "New-Item -Force -Path '{key}' | Out-Null; \
             Set-ItemProperty -Path '{key}' -Name EnableScripts -Value 1 -Type DWord; \
             Set-ItemProperty -Path '{key}' -Name ExecutionPolicy -Value '{policy}'; \
             (Get-ExecutionPolicy -Scope UserPolicy).ToString()"
        ),
        None => format!(
            "Remove-Item -Force -Recurse -Path '{key}' -ErrorAction SilentlyContinue; 'removed'"
        ),
    };
    let command = powershell_encoded_command(&script);
    let out = over_ssh(fixture, move |session| {
        run_remote_command(session, &command)
    })
    .await
    .unwrap_or_else(|e| format!("{e}"));
    match policy {
        Some(policy) if out.trim() != policy => {
            eprintln!("SKIPPED: the fixture user cannot set a UserPolicy of {policy}: {out:?}");
            false
        }
        _ => true,
    }
}

/// #5992 / #5996 with the OpenSSH `DefaultShell` left at `cmd.exe`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cmd_default_shell_setup_outcome() {
    setup_outcome(WindowsDeployShell::Native(WindowsShell::Cmd)).await;
}

/// #5992 / #5996 with the OpenSSH `DefaultShell` set to PowerShell.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn powershell_default_shell_setup_outcome() {
    setup_outcome(WindowsDeployShell::Native(WindowsShell::PowerShell)).await;
}

/// #5992 / #5996 with the OpenSSH `DefaultShell` set to Git Bash.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bash_default_shell_setup_outcome() {
    setup_outcome(WindowsDeployShell::EncodedPowerShell).await;
}
