//! Live agent-update **rollback** on a real Windows OpenSSH host (#5219).
//!
//! #5207 made `install_agent_bytes` keep the previous binary
//! (`termihub-agent.previous.exe`) and move it back when the new one fails its
//! `--version` verify. Its Windows plans (cmd `copy`/`move`/`del`, PowerShell
//! `Copy-Item`/`Move-Item`/`Remove-Item`) had string tests only, because the
//! in-process fake host speaks POSIX. These cases run the production install
//! through each OpenSSH `DefaultShell`:
//!
//! 1. **Exit status** — a failed backup / restore / install (`copy` / `move` /
//!    `Copy-Item` / `Move-Item` of a missing file) must report a non-zero exit
//!    status through the `DefaultShell`; the deploy reads it to stop or roll
//!    back, and a failure that exits 0 would pass as done.
//! 2. **Broken update** — install a working agent, then a binary that cannot
//!    start: the result is `RolledBack`, the original exe (same size) is back
//!    at the install path and the production `--version` probe finds it.
//! 3. **Leftover backup** — a `termihub-agent.previous.exe` next to a broken
//!    install (a deploy that died mid-way) is restored by the next deploy: a
//!    working update then succeeds and removes it, and a broken update rolls
//!    back to it (it was restored, not deleted).
//!
//! Gated like the parent's tests; the recipe runs it after the
//! deploy/connect/reattach test of the same shell.

use super::*;
use crate::terminal::agent_install::InstallPlan;
use crate::utils::remote_exec::run_remote_command_checked;
use termihub_core::backends::ssh::handler::SshSession;

/// Bytes that are not a Windows executable: running them fails at once (no
/// stdout), exactly like a corrupt or wrong-architecture download.
const BROKEN_AGENT: &[u8] = b"not a Windows executable: termiHub #5219 rollback test\r\n";

/// A command (in `shell`'s syntax) printing `PRESENT` or `ABSENT` for `path`.
fn exists_probe(shell: WindowsShell, path: &str) -> String {
    match shell {
        WindowsShell::Cmd => format!(r#"if exist "{path}" (echo PRESENT) else (echo ABSENT)"#),
        WindowsShell::PowerShell => {
            format!(r#"if (Test-Path -Path "{path}") {{ 'PRESENT' }} else {{ 'ABSENT' }}"#)
        }
    }
}

/// A command (in `shell`'s syntax) printing the size of `path` in bytes.
fn size_probe(shell: WindowsShell, path: &str) -> String {
    match shell {
        WindowsShell::Cmd => format!(r#"for %I in ("{path}") do @echo %~zI"#),
        WindowsShell::PowerShell => format!(r#"(Get-Item -Path "{path}").Length"#),
    }
}

/// A command (in `shell`'s syntax) overwriting `path` with text, so it no
/// longer runs: the broken install a deploy that died mid-way leaves.
fn break_probe(shell: WindowsShell, path: &str) -> String {
    match shell {
        WindowsShell::Cmd => format!(r#"echo broken-5219> "{path}""#),
        WindowsShell::PowerShell => {
            format!(r#"Set-Content -ErrorAction Stop -Path "{path}" -Value broken-5219"#)
        }
    }
}

/// A command (in `shell`'s syntax) stopping this user's agents and removing
/// the install, the backup and the upload temp file. Best effort: absent files
/// and no running agent are fine. A running agent (a daemon of the earlier
/// test) would lock the exe.
fn reset_command(shell: WindowsShell, plan: &InstallPlan) -> String {
    let (dst, bak) = (&plan.install_path, &plan.backup_path);
    match shell {
        WindowsShell::Cmd => format!(
            r#"taskkill /F /IM {WINDOWS_AGENT_EXE} >nul 2>&1 & ping -n 2 127.0.0.1 >nul & del /F /Q "{dst}" "{bak}" "%USERPROFILE%\{WINDOWS_UPLOAD_NAME}" >nul 2>&1 & echo RESET"#
        ),
        WindowsShell::PowerShell => format!(
            r#"Get-Process -Name termihub-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Remove-Item -Force -ErrorAction SilentlyContinue -Path "{dst}", "{bak}", "$env:USERPROFILE\{WINDOWS_UPLOAD_NAME}"; 'RESET'"#
        ),
    }
}

/// Run `command`, failing the test with `what` and the full exec report.
fn run(session: &SshSession, command: &str, what: &str) -> String {
    run_remote_command(session, command)
        .unwrap_or_else(|e| panic!("{what} (`{command}`) failed: {e}"))
}

/// Run `command` with its exit status checked; it must succeed.
fn run_checked(session: &SshSession, command: &str, what: &str) {
    if let Err(e) = run_remote_command_checked(session, command) {
        panic!(
            "{what} (`{command}`) failed: {e}\n  => {}",
            exec_detailed(session, command)
        );
    }
}

/// Start from a host with no agent, no backup and no staged upload.
fn reset(session: &SshSession, shell: WindowsShell, plan: &InstallPlan) {
    let out = run(
        session,
        &reset_command(shell, plan),
        "resetting the install",
    );
    assert!(out.contains("RESET"), "reset did not finish: {out:?}");
    for path in [&plan.install_path, &plan.backup_path] {
        assert_eq!(
            run(session, &exists_probe(shell, path), "probing a reset path").trim(),
            "ABSENT",
            "{path} survived the reset (locked by a running agent?)"
        );
    }
}

/// #5219 scope 3: every copy/move the deploy checks must report its failure as
/// a non-zero exit status through the `DefaultShell`. On the reset host there
/// is no install, no backup and no upload, so each one fails.
fn assert_failed_steps_exit_non_zero(session: &SshSession, plan: &InstallPlan) {
    for (step, command) in [
        ("backup (copy of a missing install)", &plan.backup_command),
        ("restore (move of a missing backup)", &plan.restore_command),
        ("install (move of a missing upload)", &plan.install_command),
    ] {
        match run_remote_command_checked(session, command) {
            Err(e) => {
                assert!(
                    e.to_string().contains("exit status"),
                    "{step}: failed without an exit status: {e}"
                );
                eprintln!("{step} reports its failure: {e}");
            }
            Ok(out) => panic!(
                "{step} failed but reported success (exit 0 or no status) — `{command}` \
                 printed {out:?}\n  => {}",
                exec_detailed(session, command)
            ),
        }
    }
}

/// Install `bytes` with the production deploy, failing the test on an error.
fn install(session: &SshSession, bytes: &[u8], what: &str) -> DeployOutcome {
    deploy_bytes(session, bytes).unwrap_or_else(|e| panic!("{what}: deploy failed: {e}"))
}

/// Assert a deploy of a working agent succeeded and left no backup behind.
fn assert_clean_install(
    session: &SshSession,
    outcome: &DeployOutcome,
    want: WindowsShell,
    plan: &InstallPlan,
) -> String {
    let path = assert_deployed(outcome, want);
    assert_eq!(
        run(
            session,
            &exists_probe(want, &plan.backup_path),
            "probing the backup"
        )
        .trim(),
        "ABSENT",
        "a verified update must remove {}",
        plan.backup_path
    );
    path
}

/// Assert `outcome` rolled back and the original agent (`original_len` bytes)
/// is back at the install path, runs, and the backup is gone (moved back).
fn assert_rolled_back(
    fixture: &Fixture,
    session: &SshSession,
    outcome: &DeployOutcome,
    plan: &InstallPlan,
    original_len: usize,
) {
    let shell = fixture.default_shell;
    let AgentDeployResult::RolledBack {
        reason,
        restored_version,
        installed_path,
    } = &outcome.result
    else {
        panic!(
            "an update to a binary that cannot start must roll back, got {:?}",
            outcome.result
        );
    };
    assert!(reason.contains("--version"), "rollback reason: {reason:?}");
    assert!(
        restored_version.starts_with(env!("CARGO_PKG_VERSION")),
        "restored agent reports {restored_version:?}, expected {}",
        env!("CARGO_PKG_VERSION")
    );
    assert!(
        outcome.progress_steps.iter().any(|s| s == "done"),
        "rollback never reported done: {:?}",
        outcome.progress_steps
    );
    let path = installed_path
        .clone()
        .unwrap_or_else(|| panic!("rollback names no install path: {:?}", outcome.result));
    let suffix = format!(r"\appdata\local\termihub\agent\{WINDOWS_AGENT_EXE}");
    assert!(
        path.to_ascii_lowercase().ends_with(&suffix) && !path.contains('%'),
        "rollback install path is not the resolved %LOCALAPPDATA% path: {path:?}"
    );

    // The original exe is back: same size as the working agent, not the
    // broken bytes, and the backup it came from is gone (moved, not copied).
    let size = run(session, &size_probe(shell, &path), "sizing the install");
    assert_eq!(
        size.trim(),
        original_len.to_string(),
        "the installed exe is not the original agent ({} broken bytes would be the update)",
        BROKEN_AGENT.len()
    );
    assert_eq!(
        run(
            session,
            &exists_probe(shell, &plan.backup_path),
            "probing the backup"
        )
        .trim(),
        "ABSENT",
        "the backup should have been moved back over the install"
    );
    assert_eq!(
        outcome.upload_leftover.trim(),
        "ABSENT",
        "the staged upload was left in %USERPROFILE%"
    );

    // ...and it runs: the production `--version` probe against the absolute path.
    let probe = probe_remote_agent(&fixture.agent_config(&path), env!("CARGO_PKG_VERSION"))
        .unwrap_or_else(|e| panic!("--version probe of the restored agent failed: {e}"));
    assert!(
        probe.found
            && probe
                .version
                .as_deref()
                .is_some_and(|v| v.starts_with(env!("CARGO_PKG_VERSION"))),
        "the restored agent at {path} does not run: {probe:?}"
    );
    eprintln!("{shell:?}: rolled back to agent v{restored_version} at {path}");
}

/// The whole #5219 scenario for one shell. Blocking (the remote-exec helpers
/// use `block_in_place`), so it runs on a `spawn_blocking` thread.
fn rollback_scenario(fixture: &Fixture) {
    let shell = fixture.default_shell;
    let plan = windows_install_plan(shell);
    let session = connect_and_authenticate(&fixture.ssh_config())
        .unwrap_or_else(|e| panic!("SSH to the Windows host failed: {e}"));
    let working = read_agent_bin(fixture).unwrap_or_else(|e| panic!("{e}"));
    reset(&session, shell, &plan);

    // ── 1. A failed copy/move exits non-zero through the DefaultShell.
    assert_failed_steps_exit_non_zero(&session, &plan);

    // ── 2. Working agent, then an update to a binary that cannot start.
    let first = install(&session, &working, "installing the working agent");
    assert_clean_install(&session, &first, shell, &plan);
    let broken = install(&session, BROKEN_AGENT, "updating to the broken binary");
    assert_rolled_back(fixture, &session, &broken, &plan, working.len());

    // ── 3a. Leftover backup next to a broken install; a working update.
    leave_backup_next_to_a_broken_install(&session, shell, &plan);
    let healed = install(&session, &working, "updating over a leftover backup");
    assert_clean_install(&session, &healed, shell, &plan);

    // ── 3b. Same leftover; a broken update must roll back to it — so the
    // deploy restored the leftover instead of deleting it.
    leave_backup_next_to_a_broken_install(&session, shell, &plan);
    let broken = install(&session, BROKEN_AGENT, "broken update over a leftover");
    assert_rolled_back(fixture, &session, &broken, &plan, working.len());

    reset(&session, shell, &plan);
}

/// What a deploy that died between the backup and its cleanup, with a broken
/// binary in place, leaves: a working `termihub-agent.previous.exe` next to an
/// install that does not run.
fn leave_backup_next_to_a_broken_install(
    session: &SshSession,
    shell: WindowsShell,
    plan: &InstallPlan,
) {
    run_checked(
        session,
        &plan.backup_command,
        "copying the install to the backup",
    );
    run_checked(
        session,
        &break_probe(shell, &plan.install_path),
        "breaking the install",
    );
    assert_eq!(
        run(session, &plan.verify_command, "running the broken install"),
        "",
        "the broken install still prints a version"
    );
    assert!(
        !run(session, &plan.backup_verify_command, "running the backup").is_empty(),
        "the leftover backup does not run"
    );
}

async fn update_rollback(want: WindowsShell) {
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
    tokio::task::spawn_blocking(move || rollback_scenario(&fixture))
        .await
        .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()));
}

/// #5219 with the OpenSSH `DefaultShell` left at `cmd.exe`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cmd_default_shell_update_rollback() {
    update_rollback(WindowsShell::Cmd).await;
}

/// #5219 with the OpenSSH `DefaultShell` set to PowerShell.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn powershell_default_shell_update_rollback() {
    update_rollback(WindowsShell::PowerShell).await;
}

// ── Command-shape unit tests (run everywhere) ──────────────────────────

#[test]
fn probes_use_each_shells_syntax() {
    let p = r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe";
    assert!(exists_probe(WindowsShell::Cmd, p).starts_with(r#"if exist "%LOCALAPPDATA%"#));
    assert!(exists_probe(WindowsShell::PowerShell, p).starts_with("if (Test-Path -Path"));
    assert!(size_probe(WindowsShell::Cmd, p).ends_with("do @echo %~zI"));
    assert!(size_probe(WindowsShell::PowerShell, p).ends_with(").Length"));
    assert!(break_probe(WindowsShell::Cmd, p).starts_with("echo broken-5219> "));
    assert!(break_probe(WindowsShell::PowerShell, p).contains("-ErrorAction Stop"));
}

#[test]
fn reset_removes_install_backup_and_upload() {
    for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
        let plan = windows_install_plan(shell);
        let cmd = reset_command(shell, &plan);
        assert!(cmd.contains(&plan.install_path), "{cmd}");
        assert!(cmd.contains(&plan.backup_path), "{cmd}");
        assert!(cmd.contains(WINDOWS_UPLOAD_NAME), "{cmd}");
        assert!(cmd.ends_with("RESET") || cmd.ends_with("'RESET'"), "{cmd}");
    }
}

#[test]
fn broken_agent_is_not_an_executable() {
    assert!(!BROKEN_AGENT.starts_with(b"MZ"));
}
