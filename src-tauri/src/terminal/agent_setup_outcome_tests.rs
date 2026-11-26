//! The outcome of a Windows agent setup is never read from exit code 0 (#5992).

use tauri::Emitter;

use super::*;
use crate::terminal::agent_deploy::fake_host;

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn answer(sha: &str, rest: &str) -> String {
    format!("termihub-check sha256 {sha}\r\ntermihub-check {rest}\r\n")
}

fn is_unknown(outcome: &SetupOutcome) -> bool {
    matches!(outcome, SetupOutcome::Unknown(_))
}

fn is_failed(outcome: &SetupOutcome) -> bool {
    matches!(outcome, SetupOutcome::Failed(_))
}

fn timeout_error() -> TerminalError {
    TerminalError::timed_out("Remote command", CHECK_TIMEOUT)
}

// ── What the check says ──────────────────────────────────────────────

#[test]
fn only_the_uploaded_binary_that_runs_counts_as_installed() {
    let ok = "version 0 termihub-agent 1.2.3 (branch: develop)";
    assert_eq!(parse_check(&answer(SHA, ok), SHA), HostCheck::Installed);
    assert_eq!(
        parse_check(&answer(&SHA.to_uppercase(), ok), SHA),
        HostCheck::Installed
    );
    // An older agent, even one of the very same version.
    assert_eq!(
        parse_check(&answer(OTHER, ok), SHA),
        HostCheck::PreviousRuns
    );
    assert_eq!(parse_check("termihub-check absent", SHA), HostCheck::Absent);
    for rest in [
        "version 3 termihub-agent 1.2.3",
        "version 0 something else",
        "version 0 ",
        "version -1073741515 ",
        "version-error",
    ] {
        assert_eq!(
            parse_check(&answer(SHA, rest), SHA),
            HostCheck::DoesNotRun,
            "{rest}"
        );
        assert_eq!(
            parse_check(&answer(OTHER, rest), SHA),
            HostCheck::OtherBinary,
            "{rest}"
        );
    }
}

#[test]
fn a_banner_around_the_answer_is_ignored() {
    let noisy = format!(
        "Welcome!\r\n\r\n{}bye",
        answer(SHA, "version 0 termihub-agent 1.2.3")
    );
    assert_eq!(parse_check(&noisy, SHA), HostCheck::Installed);
}

#[test]
fn anything_but_one_complete_answer_is_unreadable() {
    let ok = "version 0 termihub-agent 1.2.3";
    for output in [
        String::new(),
        "termihub-agent 1.2.3".to_string(),
        "termihub-check error".to_string(),
        format!("termihub-check sha256 {SHA}"),
        answer("", ok),
        answer("not-a-hash", ok),
        answer(&SHA[1..], ok),
        answer(SHA, "version  termihub-agent 1.2.3"),
        answer(SHA, "something"),
        format!("{}{}", answer(SHA, ok), answer(SHA, ok)),
        format!("termihub-check absent\n{}", answer(SHA, ok)),
    ] {
        assert_eq!(
            parse_check(&output, SHA),
            HostCheck::Unreadable,
            "{output:?}"
        );
    }
}

#[test]
fn the_check_command_is_one_word_safe_line_for_every_login_shell() {
    let command = windows_check_command();
    assert!(command.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive "));
    // cmd.exe takes at most 8191 characters.
    assert!(command.len() < 8000, "{}", command.len());
    assert!(!check_script().contains("Get-FileHash"));
}

// ── The outcome ──────────────────────────────────────────────────────

#[test]
fn exit_code_0_is_never_success_on_its_own() {
    let end = ShellEnd::Exited(0);
    assert!(is_failed(&windows_setup_outcome(
        end,
        &Ok(HostCheck::Absent)
    )));
    for other in [HostCheck::OtherBinary, HostCheck::PreviousRuns] {
        assert!(is_failed(&windows_setup_outcome(end, &Ok(other))));
    }
    assert!(is_unknown(&windows_setup_outcome(
        end,
        &Ok(HostCheck::Busy)
    )));
    assert!(is_failed(&windows_setup_outcome(
        end,
        &Ok(HostCheck::DoesNotRun)
    )));
    assert!(is_unknown(&windows_setup_outcome(
        end,
        &Ok(HostCheck::Unreadable)
    )));
    assert!(is_unknown(&windows_setup_outcome(
        end,
        &Err(timeout_error())
    )));
    assert!(is_unknown(&windows_setup_outcome(
        end,
        &Err(TerminalError::SshError("channel open failed".into()))
    )));
    assert_eq!(
        windows_setup_outcome(end, &Ok(HostCheck::Installed)),
        SetupOutcome::Installed
    );
}

#[test]
fn a_verified_agent_is_installed_however_the_shell_ended() {
    for end in [
        ShellEnd::Exited(0),
        ShellEnd::Exited(1),
        ShellEnd::NoStatus,
        ShellEnd::StillOpen,
    ] {
        assert_eq!(
            windows_setup_outcome(end, &Ok(HostCheck::Installed)),
            SetupOutcome::Installed,
            "{end:?}"
        );
    }
}

#[test]
fn a_missing_or_old_agent_is_a_failure_only_once_the_shell_really_ended() {
    for check in [
        HostCheck::Absent,
        HostCheck::OtherBinary,
        HostCheck::PreviousRuns,
    ] {
        assert!(is_failed(&windows_setup_outcome(
            ShellEnd::Exited(1),
            &Ok(check)
        )));
        for end in [ShellEnd::NoStatus, ShellEnd::StillOpen] {
            assert!(
                is_unknown(&windows_setup_outcome(end, &Ok(check))),
                "{end:?} {check:?}"
            );
        }
    }
}

#[test]
fn every_outcome_says_whether_the_previous_agent_is_still_there() {
    let says = |end, check| match windows_setup_outcome(end, &Ok(check)) {
        SetupOutcome::Failed(why) | SetupOutcome::Unknown(why) => {
            why.contains("previous agent is still in place")
        }
        SetupOutcome::Installed => panic!("{check:?} is not installed"),
    };
    for end in [
        ShellEnd::Exited(0),
        ShellEnd::Exited(1),
        ShellEnd::NoStatus,
        ShellEnd::StillOpen,
    ] {
        assert!(says(end, HostCheck::PreviousRuns), "{end:?}");
        for check in [
            HostCheck::Absent,
            HostCheck::OtherBinary,
            HostCheck::DoesNotRun,
            HostCheck::Busy,
            HostCheck::Unreadable,
        ] {
            assert!(!says(end, check), "{end:?} {check:?}");
        }
    }
}

#[test]
fn without_a_check_only_the_setups_own_failure_code_means_failed() {
    let gone = || Err(TerminalError::SshError("gone".into()));
    assert!(is_failed(&windows_setup_outcome(
        ShellEnd::Exited(1),
        &gone()
    )));
    assert!(is_failed(&windows_setup_outcome(
        ShellEnd::Exited(1),
        &Err(timeout_error())
    )));
    // STATUS_CONTROL_C_EXIT: the console was killed, not the setup's status.
    for end in [
        ShellEnd::Exited(0),
        ShellEnd::Exited(-1_073_741_510),
        ShellEnd::NoStatus,
        ShellEnd::StillOpen,
    ] {
        assert!(is_unknown(&windows_setup_outcome(end, &gone())), "{end:?}");
    }
}

#[test]
fn each_outcome_has_its_own_progress_step() {
    assert_eq!(SetupOutcome::Installed.progress().0, "installed");
    assert_eq!(
        SetupOutcome::Failed("no".into()).progress(),
        ("failed", "no")
    );
    assert_eq!(
        SetupOutcome::Unknown("eh".into()).progress(),
        ("unknown", "eh")
    );
}

// ── The check over a real SSH session ────────────────────────────────

async fn check(
    powershell: Option<Vec<(&'static str, String)>>,
) -> Result<HostCheck, TerminalError> {
    let (session, state) = fake_host::connect(&[]).await;
    state.lock().unwrap().faults.powershell = powershell;
    tokio::task::spawn_blocking(move || recover_and_check_host(&session, SHA, CHECK_TIMEOUT))
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_check_runs_over_its_own_exec_channel() {
    let reply = |text: String| Some(vec![("ComputeHash", text)]);
    let good = answer(SHA, "version 0 termihub-agent 1.2.3");
    let old = answer(OTHER, "version 0 termihub-agent 1.2.3");
    assert_eq!(check(reply(good)).await.unwrap(), HostCheck::Installed);
    assert_eq!(check(reply(old)).await.unwrap(), HostCheck::PreviousRuns);
    // A recovery that meets a running setup ends there.
    let busy = Some(vec![("Lock-Setup", RECOVER_BUSY.to_string())]);
    assert_eq!(check(busy).await.unwrap(), HostCheck::Busy);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_check_that_cannot_run_is_unknown() {
    // No PowerShell on the host, then PowerShell refusing the script.
    for powershell in [None, Some(Vec::new())] {
        let found = check(powershell).await;
        assert!(is_unknown(&windows_setup_outcome(
            ShellEnd::Exited(0),
            &found
        )));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_check_that_times_out_is_unknown() {
    let (session, state) = fake_host::connect(&[]).await;
    state.lock().unwrap().faults.hang_powershell = true;
    let found = tokio::task::spawn_blocking(move || {
        recover_and_check_host(&session, SHA, Duration::from_millis(200))
    })
    .await
    .unwrap();
    assert!(found.as_ref().is_err_and(|e| e.is_timeout()), "{found:?}");
    assert!(is_unknown(&windows_setup_outcome(
        ShellEnd::Exited(0),
        &found
    )));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_check_over_a_gone_connection_is_unknown() {
    let (session, _state) = fake_host::connect(&[]).await;
    session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await
        .unwrap();
    let found = tokio::task::spawn_blocking(move || {
        recover_and_check_host(&session, SHA, Duration::from_secs(5))
    })
    .await
    .unwrap();
    assert!(found.is_err(), "{found:?}");
    assert!(is_unknown(&windows_setup_outcome(
        ShellEnd::Exited(0),
        &found
    )));
}

// ── The end of the tab's shell ───────────────────────────────────────

fn exit_event(session: &str, code: Option<i32>) -> serde_json::Value {
    serde_json::json!({ "session_id": session, "exit_code": code, "end_cause": null })
}

#[test]
fn the_watch_reports_its_own_sessions_end_only() {
    let app = tauri::test::mock_app();
    let watch = SessionEndWatch::start(app.handle(), "s1");
    app.emit("terminal-exit", exit_event("other", Some(1)))
        .unwrap();
    app.emit("terminal-exit", exit_event("s1", Some(0)))
        .unwrap();
    assert_eq!(
        watch.wait(Duration::from_secs(5), || true),
        ShellEnd::Exited(0)
    );
}

#[test]
fn an_end_without_a_code_an_early_end_and_an_open_shell_are_told_apart() {
    let app = tauri::test::mock_app();
    let dropped = SessionEndWatch::start(app.handle(), "s1");
    app.emit("terminal-exit", exit_event("s1", None)).unwrap();
    assert_eq!(
        dropped.wait(Duration::from_secs(5), || true),
        ShellEnd::NoStatus
    );
    // Seen by the watch, and the session already removed.
    let seen = SessionEndWatch::start(app.handle(), "s2");
    app.emit("terminal-exit", exit_event("s2", Some(1)))
        .unwrap();
    assert_eq!(
        seen.wait(Duration::from_secs(5), || false),
        ShellEnd::Exited(1)
    );
    // Gone before the watch began: no event, and no five-minute wait.
    let began = std::time::Instant::now();
    let gone = SessionEndWatch::start(app.handle(), "s3");
    assert_eq!(
        gone.wait(Duration::from_secs(60), || false),
        ShellEnd::NoStatus
    );
    assert!(began.elapsed() < Duration::from_secs(20));
    let open = SessionEndWatch::start(app.handle(), "s4");
    assert_eq!(
        open.wait(Duration::from_millis(20), || true),
        ShellEnd::StillOpen
    );
}

/// The session is dropped right before its end is announced (#6004), so the
/// wait may begin between the two: the code that follows still counts.
#[test]
fn an_end_announced_right_after_the_session_was_dropped_is_seen() {
    let app = tauri::test::mock_app();
    let watch = SessionEndWatch::start(app.handle(), "s1");
    let handle = app.handle().clone();
    let mut announcing = None;
    let end = watch.wait(Duration::from_secs(60), || {
        announcing = Some(std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            handle
                .emit("terminal-exit", exit_event("s1", Some(1)))
                .unwrap();
        }));
        false
    });
    announcing.expect("asked").join().unwrap();
    assert_eq!(end, ShellEnd::Exited(1));
}

/// #6123 made a Win32-OpenSSH PTY shell end as `shell_exited` with no code,
/// since the server's 0 is not the shell's. The setup's shell then still ended
/// on its own: the watch must say so, not "no status" (a lost link), or every
/// setup that did not install reads "may not have finished" (#5992).
#[test]
fn a_shell_that_exited_without_a_status_still_ended() {
    let app = tauri::test::mock_app();
    let watch = SessionEndWatch::start(app.handle(), "s1");
    app.emit(
        "terminal-exit",
        serde_json::json!({ "session_id": "s1", "exit_code": null, "end_cause": "shell_exited" }),
    )
    .unwrap();
    assert_eq!(
        watch.wait(Duration::from_secs(5), || true),
        ShellEnd::ExitedWithoutStatus
    );
    // A lost link is still no status.
    let lost = SessionEndWatch::start(app.handle(), "s2");
    app.emit(
        "terminal-exit",
        serde_json::json!({ "session_id": "s2", "exit_code": null, "end_cause": "io_error" }),
    )
    .unwrap();
    assert_eq!(
        lost.wait(Duration::from_secs(5), || true),
        ShellEnd::NoStatus
    );
}

#[test]
fn a_windows_setup_whose_shell_ended_without_a_status_reads_like_one_that_exited() {
    let end = ShellEnd::ExitedWithoutStatus;
    assert_eq!(
        windows_setup_outcome(end, &Ok(HostCheck::Installed)),
        SetupOutcome::Installed
    );
    for check in [
        HostCheck::Absent,
        HostCheck::OtherBinary,
        HostCheck::PreviousRuns,
    ] {
        assert!(
            is_failed(&windows_setup_outcome(end, &Ok(check))),
            "{check:?}"
        );
    }
    // Without a usable check its end proves nothing: no code says it failed.
    assert!(is_unknown(&windows_setup_outcome(
        end,
        &Ok(HostCheck::Busy)
    )));
}
