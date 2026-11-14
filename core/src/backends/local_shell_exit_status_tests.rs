//! A real local shell reports the status the user exited it with (#5742,
//! #5784): `exit 7` typed into a shell on a real PTY (ConPTY on Windows)
//! reads back as `Some(7)` once the output ends, `exit` as `Some(0)`.
//!
//! Unix runs `bash` (or `sh`) with the default shell integration, in a
//! throwaway `HOME` / `XDG_*` / `HISTFILE`, so the typed lines never reach the
//! user's history. Windows runs `cmd.exe`, which keeps no history file.

use super::*;
use serial_test::serial;
use std::time::Duration;

/// Upper bound for one wait. A shell starts and exits within a second or so.
const CEILING: Duration = Duration::from_secs(60);

/// Printed once the shell reads typed input; the typed line itself does not
/// contain it (`$((1))` on Unix, cmd's `^` escape on Windows).
const READY: &str = "TH1READY";

#[cfg(unix)]
fn shell_and_probe(home: &std::path::Path) -> (serde_json::Value, &'static str) {
    let shell = if crate::session::shell::detect_available_shells()
        .iter()
        .any(|s| s == "bash")
    {
        "bash"
    } else {
        "sh"
    };
    let home_str = home.to_string_lossy().to_string();
    let histfile = home.join(".th_history").to_string_lossy().to_string();
    let settings = serde_json::json!({
        "shell": shell,
        "envVars": [
            { "key": "HOME", "value": home_str },
            { "key": "ZDOTDIR", "value": home_str },
            { "key": "HISTFILE", "value": histfile },
            { "key": "XDG_CONFIG_HOME", "value": format!("{home_str}/.config") },
            { "key": "XDG_DATA_HOME", "value": format!("{home_str}/.local/share") },
            { "key": "XDG_STATE_HOME", "value": format!("{home_str}/.local/state") },
            { "key": "XDG_CACHE_HOME", "value": format!("{home_str}/.cache") },
            { "key": "TERM_PROGRAM", "value": "" },
            { "key": "SHELL_SESSION_HISTORY", "value": "0" },
            { "key": "BASH_SILENCE_DEPRECATION_WARNING", "value": "1" },
        ],
    });
    (settings, "echo TH$((1))READY\r")
}

#[cfg(windows)]
fn shell_and_probe(home: &std::path::Path) -> (serde_json::Value, &'static str) {
    let home_str = home.to_string_lossy().to_string();
    let settings = serde_json::json!({
        "shell": "cmd",
        "envVars": [
            { "key": "USERPROFILE", "value": home_str },
            { "key": "HOME", "value": home_str },
        ],
    });
    (settings, "echo TH^1READY\r")
}

/// Start a real shell, wait until it reads input, type `exit_line`, and
/// return the status the backend reports once the output ended.
async fn exit_status_of(exit_line: &str) -> Option<i32> {
    let home = tempfile::tempdir().expect("scratch HOME");
    let (settings, probe) = shell_and_probe(home.path());
    let mut shell = LocalShell::new();
    shell.connect(settings).await.expect("connect");
    let mut rx = shell.subscribe_output();

    shell.write(probe.as_bytes()).expect("write probe");
    let mut out = String::new();
    let ready = tokio::time::timeout(CEILING, async {
        while !out.contains(READY) {
            match rx.recv().await {
                Some(chunk) => out.push_str(&String::from_utf8_lossy(&chunk)),
                None => return false,
            }
        }
        true
    })
    .await
    .unwrap_or(false);
    assert!(ready, "the shell never answered the probe: {out:?}");
    assert_eq!(shell.exit_code(), None, "no status while the shell runs");

    shell
        .write(format!("{exit_line}\r").as_bytes())
        .expect("write exit");
    let ended = tokio::time::timeout(CEILING, async { while rx.recv().await.is_some() {} }).await;
    assert!(ended.is_ok(), "the shell did not end after {exit_line:?}");
    let status = shell.exit_code();
    shell.disconnect().await.ok();
    status
}

#[tokio::test]
#[serial(local_pty)]
async fn a_real_shell_reports_the_code_it_exited_with() {
    assert_eq!(exit_status_of("exit 7").await, Some(7));
}

#[tokio::test]
#[serial(local_pty)]
async fn a_real_shell_exited_plainly_reports_zero() {
    assert_eq!(exit_status_of("exit 0").await, Some(0));
}
