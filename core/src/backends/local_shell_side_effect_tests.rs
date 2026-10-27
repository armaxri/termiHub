//! What termiHub's shell integration leaves behind in the user's own shell
//! (#5009): history entries, shell functions and variables, `PROMPT_COMMAND`
//! / `PS1` changes. Measured on a real `bash` / `zsh` through [`LocalShell`].
//!
//! `audit_injected_setup_side_effects` (ignored; run with `--ignored
//! --nocapture`) prints the table for the injected setup next to a plain
//! shell, which is the evidence for #5009's audit. The other tests assert
//! that a session with the injection off leaves the shell exactly as a plain
//! shell, while the file browser still follows its directory.

use super::*;
use serial_test::serial;
use std::path::Path;
use std::time::Duration;

fn installed(binary: &str) -> bool {
    ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .any(|dir| Path::new(dir).join(binary).exists())
}

/// One shell's observable state, as printed by [`PROBE`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct ShellState {
    /// History entries (in-session `fc -ln 1`) that mention termiHub.
    pub history_in_session: usize,
    /// Lines of the history file written at exit that mention termiHub.
    pub history_file: usize,
    /// Shell functions whose name or body mentions termiHub.
    pub functions: usize,
    /// Shell variables named like termiHub's.
    pub variables: usize,
    pub prompt_command: String,
    pub ps1: String,
    pub ps0: String,
    pub precmd: String,
}

/// Printed by the shell; every value on its own marked line. The `$((…))`
/// arithmetic keeps the markers out of the command's own echo.
const PROBE: &str = concat!(
    r#"echo "TH$((1))HIST:$(fc -ln 1 2>/dev/null | grep -c termihub)"; "#,
    r#"echo "TH$((1))FUNCS:$(typeset -f 2>/dev/null | grep -c termihub)"; "#,
    r#"echo "TH$((1))VARS:$(set 2>/dev/null | grep -c '^__termihub\|^__th_')"; "#,
    r#"echo "TH$((1))PC:${PROMPT_COMMAND[*]}"; "#,
    r#"echo "TH$((1))PS1:$PS1"; "#,
    r#"echo "TH$((1))PS0:$PS0"; "#,
    r#"echo "TH$((1))PRECMD:${precmd_functions[*]}"; "#,
    r#"echo "TH$((1))END""#,
);

fn field(out: &str, name: &str) -> String {
    let key = format!("TH1{name}:");
    out.lines()
        .rev()
        .find_map(|l| {
            l.find(&key)
                .map(|i| l[i + key.len()..].trim_end().to_string())
        })
        .unwrap_or_default()
}

async fn read_until(rx: &mut crate::connection::OutputReceiver, out: &mut String, needle: &str) {
    let ok = tokio::time::timeout(Duration::from_secs(60), async {
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

/// Start `shell_name` with the injection on or off, let it settle, run a
/// user command, probe its state, exit, and read the history file.
pub(super) async fn measure(shell_name: &str, integration: Option<bool>) -> ShellState {
    let home = tempfile::tempdir().expect("temp HOME");
    let hist = home.path().join(".th_history");
    let h = hist.to_string_lossy().to_string();
    // History on, written at exit, no ignorespace — the default on macOS
    // and Fedora (Debian/Ubuntu's .bashrc sets ignoreboth).
    std::fs::write(
        home.path().join(".zshrc"),
        format!("HISTFILE='{h}'\nSAVEHIST=1000\nHISTSIZE=1000\n"),
    )
    .expect("zshrc");
    let bash_rc = format!("HISTFILE='{h}'\nHISTSIZE=1000\nHISTFILESIZE=1000\nset -o history\n");
    std::fs::write(home.path().join(".bash_profile"), &bash_rc).expect("profile");
    std::fs::write(home.path().join(".bashrc"), &bash_rc).expect("bashrc");
    let home_str = home.path().to_string_lossy().to_string();
    let mut shell = LocalShell::new();
    let mut settings = serde_json::json!({
            "shell": shell_name,
            "envVars": [
                { "key": "HOME", "value": home_str },
                { "key": "ZDOTDIR", "value": home_str },
                // Like an app started from Finder/Dock: no Terminal.app
                // session history or cwd hooks inherited from the test runner.
                { "key": "TERM_PROGRAM", "value": "" },
                { "key": "SHELL_SESSION_HISTORY", "value": "0" },
            ],
    });
    if let Some(on) = integration {
        settings["shellIntegration"] = serde_json::Value::Bool(on);
    }
    shell.connect(settings).await.expect("connect");
    let mut rx = shell.subscribe_output();
    let mut out = String::new();
    // Let startup (and any setup) finish, then type like a user.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    while let Ok(Some(c)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
        out.push_str(&String::from_utf8_lossy(&c));
    }
    shell.write(b"echo user-$((1))-command\r").expect("write");
    read_until(&mut rx, &mut out, "user-1-command").await;
    shell.write(format!("{PROBE}\r").as_bytes()).expect("write");
    read_until(&mut rx, &mut out, "TH1END").await;
    shell.write(b"exit\r").expect("write");
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while rx.recv().await.is_some() {}
    })
    .await;
    // The shell writes its history file as it exits.
    for _ in 0..50 {
        if hist.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    shell.disconnect().await.ok();
    let file = std::fs::read_to_string(&hist).unwrap_or_default();
    ShellState {
        history_in_session: field(&out, "HIST").parse().unwrap_or(usize::MAX),
        history_file: file.lines().filter(|l| l.contains("termihub")).count(),
        functions: field(&out, "FUNCS").parse().unwrap_or(usize::MAX),
        variables: field(&out, "VARS").parse().unwrap_or(usize::MAX),
        prompt_command: field(&out, "PC"),
        ps1: field(&out, "PS1"),
        ps0: field(&out, "PS0"),
        precmd: field(&out, "PRECMD"),
    }
}

#[tokio::test]
#[serial(local_pty)]
#[ignore = "audit: prints the side-effect table; run with --ignored --nocapture"]
async fn audit_injected_setup_side_effects() {
    for shell in ["bash", "zsh"] {
        if !installed(shell) {
            continue;
        }
        let plain = measure(shell, Some(false)).await;
        let injected = measure(shell, Some(true)).await;
        eprintln!("AUDIT {shell} plain    = {plain:?}");
        eprintln!("AUDIT {shell} injected = {injected:?}");
    }
}

/// #5009 (c): a session with default settings leaves the user's shell as a
/// plain shell — no history entry, no function or variable, `PROMPT_COMMAND`,
/// `precmd_functions`, `PS1` and `PS0` untouched.
#[tokio::test]
#[serial(local_pty)]
async fn a_default_session_leaves_the_shell_untouched() {
    for shell in ["bash", "zsh"] {
        if !installed(shell) {
            continue;
        }
        let state = measure(shell, None).await;
        // The probe line itself mentions termihub once in bash's history.
        let own = usize::from(shell == "bash");
        assert_eq!(state.history_in_session, own, "{shell}: {state:?}");
        assert_eq!(
            state.history_file, 1,
            "{shell}: only the probe line: {state:?}"
        );
        assert_eq!(
            (state.functions, state.variables),
            (0, 0),
            "{shell}: {state:?}"
        );
        for value in [&state.prompt_command, &state.ps1, &state.ps0, &state.precmd] {
            assert!(
                !value.contains("termihub") && !value.contains("133;"),
                "{shell}: the prompt was changed: {state:?}"
            );
        }
    }
}

/// #5009 (a, b, d): a default session shows the rc output, nothing of
/// termiHub's, and the file browser still follows the shell — from the OSC 7
/// the backend adds after reading the directory from the OS.
#[tokio::test]
#[serial(local_pty)]
async fn a_default_session_follows_cwd_without_typing_anything() {
    for shell_name in ["bash", "zsh"] {
        if !installed(shell_name) {
            continue;
        }
        let home = tempfile::tempdir().expect("temp HOME");
        let rc = "echo 'RC-BANNER-LINE'\n";
        for f in [".zshrc", ".bash_profile", ".bashrc"] {
            std::fs::write(home.path().join(f), rc).expect("rc");
        }
        let target = tempfile::tempdir().expect("target dir");
        let home_str = home.path().to_string_lossy().to_string();
        let mut shell = LocalShell::new();
        shell
            .connect(serde_json::json!({
                "shell": shell_name,
                "startingDirectory": home_str,
                "envVars": [
                    { "key": "HOME", "value": home_str },
                    { "key": "ZDOTDIR", "value": home_str },
                    { "key": "TERM_PROGRAM", "value": "" },
                    { "key": "SHELL_SESSION_HISTORY", "value": "0" },
                ],
            }))
            .await
            .expect("connect");
        let mut rx = shell.subscribe_output();
        let mut out = String::new();
        let home_name = home
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        read_until(&mut rx, &mut out, &home_name).await;
        assert!(out.contains("RC-BANNER-LINE"), "{shell_name}: {out:?}");
        // The start directory is reported once the first prompt settles.
        read_until(&mut rx, &mut out, "\x1b]7;file://").await;

        let cd = format!("cd '{}'\r", target.path().display());
        shell.write(cd.as_bytes()).expect("write");
        let target_name = target
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let osc_target = format!("{target_name}\x07");
        read_until(&mut rx, &mut out, &osc_target).await;
        for leak in [
            "__termihub",
            "[termiHub]",
            "PROMPT_COMMAND",
            "precmd_functions",
            "6973;",
        ] {
            assert!(!out.contains(leak), "{shell_name}: {leak:?} shown: {out:?}");
        }
        assert!(
            !out.contains("\x1b]133;"),
            "{shell_name}: no hook installed: {out:?}"
        );
        shell.disconnect().await.ok();
    }
}
