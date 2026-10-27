//! Local Git Bash on Windows (#5014), through [`LocalShell`] on a real
//! ConPTY: a default tab shows the user's rc output, nothing of termiHub's,
//! and still follows `cd`; the opt-in command marks are set up without a
//! typed line.
//!
//! Skipped (with a `SKIPPED:` line) when Git for Windows is not installed;
//! the GitHub-hosted Windows runners have it.

use super::*;
use serial_test::serial;
use std::time::Duration;

/// Text of termiHub's setup that must never reach the terminal.
const SETUP_LEAKS: &[&str] = &[
    "__termihub",
    "[termiHub]",
    "PROMPT_COMMAND",
    "TERMIHUB_SI",
    "6973;",
];

fn git_bash_installed() -> bool {
    crate::session::shell::detect_available_shells().contains(&"gitbash".to_string())
}

async fn read_until(rx: &mut crate::connection::OutputReceiver, out: &mut String, needle: &str) {
    let ok = tokio::time::timeout(Duration::from_secs(90), async {
        while !out.contains(needle) {
            match rx.recv().await {
                Some(chunk) => out.push_str(&String::from_utf8_lossy(&chunk)),
                None => return false,
            }
        }
        true
    })
    .await
    .unwrap_or(false);
    assert!(ok, "timed out waiting for {needle:?}: {out:?}");
}

/// Whether `out` holds an OSC 7 report of `dir`. Only the OSC 7 counts:
/// Git Bash's prompt also sets the window title to `MINGW64:<dir>` (OSC 0),
/// which ends in the same name.
fn reported(out: &str, dir: &std::path::Path) -> bool {
    let name = dir.file_name().expect("name").to_string_lossy().to_string();
    out.split("\x1b]7;file://")
        .skip(1)
        .filter_map(|rest| rest.split('\x07').next())
        .any(|uri| uri.ends_with(&format!("/{name}")))
}

async fn read_until_reported(
    rx: &mut crate::connection::OutputReceiver,
    out: &mut String,
    dir: &std::path::Path,
) {
    let ok = tokio::time::timeout(Duration::from_secs(90), async {
        while !reported(out, dir) {
            match rx.recv().await {
                Some(chunk) => out.push_str(&String::from_utf8_lossy(&chunk)),
                None => return false,
            }
        }
        true
    })
    .await
    .unwrap_or(false);
    assert!(ok, "no OSC 7 for {dir:?}: {out:?}");
}

/// Start Git Bash in a temporary `HOME` whose profile prints a banner, wait
/// for its first prompt, `cd` to a second directory, and return what the
/// terminal received.
async fn cd_in_git_bash(shell_integration: Option<bool>) -> String {
    let home = tempfile::tempdir().expect("temp HOME");
    let rc = "echo 'RC-BANNER-LINE'\n";
    std::fs::write(home.path().join(".bash_profile"), rc).expect("profile");
    let target = tempfile::tempdir().expect("target dir");
    let home_str = home.path().to_string_lossy().to_string();
    let mut settings = serde_json::json!({
        "shell": "gitbash",
        "startingDirectory": home_str,
        "envVars": [{ "key": "HOME", "value": home_str }],
    });
    if let Some(on) = shell_integration {
        settings["shellIntegration"] = serde_json::Value::Bool(on);
    }
    let mut shell = LocalShell::new();
    shell.connect(settings).await.expect("connect");
    let mut rx = shell.subscribe_output();
    let mut out = String::new();
    read_until(&mut rx, &mut out, "RC-BANNER-LINE").await;
    // The start directory is reported once the first prompt settles.
    read_until_reported(&mut rx, &mut out, home.path()).await;

    // Forward slashes: `cd` in Git Bash takes `C:/x` as is.
    let to = target.path().to_string_lossy().replace('\\', "/");
    shell
        .write(format!("cd '{to}'\r").as_bytes())
        .expect("write");
    read_until_reported(&mut rx, &mut out, target.path()).await;
    shell.write(b"exit\r").ok();
    shell.disconnect().await.ok();
    out
}

/// #5014: a default Git Bash tab follows `cd` with nothing typed into it —
/// the backend reads the directory of the real `bash.exe` behind Git's
/// launcher — and shows the profile's output and nothing of termiHub's.
#[tokio::test]
#[serial(local_pty)]
async fn default_git_bash_follows_cd_without_typing_anything() {
    if !git_bash_installed() {
        eprintln!("SKIPPED: Git Bash is not installed");
        return;
    }
    let out = cd_in_git_bash(None).await;
    for leak in SETUP_LEAKS {
        assert!(!out.contains(leak), "{leak:?} shown: {out:?}");
    }
    assert!(!out.contains("\x1b]133;"), "no hook installed: {out:?}");
}

/// #5014: with command marks switched on, the hook is installed without a
/// typed line — no setup text reaches the terminal — and OSC 133 marks and
/// the profile's output both show.
#[tokio::test]
#[serial(local_pty)]
async fn opt_in_git_bash_marks_commands_without_typing_the_setup() {
    if !git_bash_installed() {
        eprintln!("SKIPPED: Git Bash is not installed");
        return;
    }
    let out = cd_in_git_bash(Some(true)).await;
    for leak in SETUP_LEAKS {
        assert!(!out.contains(leak), "{leak:?} shown: {out:?}");
    }
    assert!(out.contains("\x1b]133;A"), "prompt marks: {out:?}");
    assert!(out.contains("\x1b]133;C"), "command marks: {out:?}");
}
