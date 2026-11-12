//! Real-shell tests: a startup prompt never gets termiHub's typed setup (#5452)
//! or a connection's initial command (#5455) as its answer.
//!
//! A startup file can ask a question before the first prompt: zsh's
//! `compinit` asks "Ignore insecure directories and continue [y]?", and
//! frameworks ask whether to update. The prompt reads the terminal in
//! non-canonical mode, just like the line editor does, so the setup typed
//! when the line editor seemed to be reading was taken as the answer and the
//! rest of it ran as a mangled command (`cho …`).
//!
//! Each test starts a real `bash` / `zsh` through [`LocalShell`] with the
//! integration on, in a throwaway `HOME` / `ZDOTDIR` / `XDG_*` / `HISTFILE`
//! whose startup file asks a one-key question, then checks that nothing
//! answers it until the user does, and that the setup still runs at the
//! prompt afterwards.

use super::*;
use serial_test::serial;
use std::path::Path;
use std::time::Duration;

const PROMPT: &str = "THPROMPT>";
const QUESTION: &str = "Continue startup? [y/n]";

fn installed(binary: &str) -> bool {
    if binary.starts_with('/') {
        return Path::new(binary).exists();
    }
    ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .any(|dir| Path::new(dir).join(binary).exists())
}

/// The shell to test as `kind` (`bash` / `zsh`), if it announces its line
/// editor. These tests cover only that path: an older shell (macOS's
/// `/bin/bash` 3.2, the `bash` on the macOS CI runner) keeps the
/// canonical-mode cue by design, so a startup question still gets the input
/// there (see `local_shell_ready`). `TERMIHUB_TEST_BASH` / `TERMIHUB_TEST_ZSH`
/// pick another binary, e.g. `/bin/bash` to check the skip.
fn shell_with_line_editor_mark(kind: &str) -> Option<String> {
    let var = format!("TERMIHUB_TEST_{}", kind.to_ascii_uppercase());
    let shell = std::env::var(var).unwrap_or_else(|_| kind.to_string());
    if !installed(&shell) {
        eprintln!("{shell} not installed — skipping");
        return None;
    }
    if ready_signal(&shell) != ReadySignal::PasteMark {
        eprintln!("{shell} announces no bracketed paste (older than 5.1) — skipping");
        return None;
    }
    Some(shell)
}

/// A one-key question before the first prompt, like `compinit`'s, then a
/// fixed prompt.
fn startup_files(home: &Path) {
    // No /etc/zshrc & co.: the system's own `compinit` must not ask first.
    std::fs::write(home.join(".zshenv"), "setopt no_global_rcs\n").expect("zshenv");
    std::fs::write(
        home.join(".zshrc"),
        format!(
            "if read -q '?{QUESTION} '; then echo; echo ANSWER-Y; \
             else echo; echo ANSWER-N; fi\nPROMPT='{PROMPT} '\n"
        ),
    )
    .expect("zshrc");
    let bash_rc =
        format!("read -r -n 1 -p '{QUESTION} ' a; echo; echo \"ANSWER-$a\"\nPS1='{PROMPT} '\n");
    std::fs::write(home.join(".bash_profile"), &bash_rc).expect("profile");
    std::fs::write(home.join(".bashrc"), &bash_rc).expect("bashrc");
}

struct Session {
    shell: LocalShell,
    rx: crate::connection::OutputReceiver,
    raw: Vec<u8>,
    _home: tempfile::TempDir,
}

impl Session {
    async fn start(shell_name: &str) -> Session {
        Self::start_with(shell_name, serde_json::json!({ "shellIntegration": true })).await
    }

    /// Start with the settings in `extra` on top of the scratch environment.
    async fn start_with(shell_name: &str, extra: serde_json::Value) -> Session {
        let home = tempfile::tempdir().expect("temp HOME");
        startup_files(home.path());
        let dir = |name: &str| {
            let d = home.path().join(name);
            std::fs::create_dir_all(&d).expect("scratch dir");
            d.to_string_lossy().to_string()
        };
        let home_str = home.path().to_string_lossy().to_string();
        let histfile = home
            .path()
            .join(".th_history")
            .to_string_lossy()
            .to_string();
        let mut settings = serde_json::json!({
            "shell": shell_name,
            "envVars": [
                { "key": "HOME", "value": home_str },
                { "key": "ZDOTDIR", "value": home_str },
                { "key": "HISTFILE", "value": histfile },
                { "key": "XDG_CONFIG_HOME", "value": dir(".config") },
                { "key": "XDG_DATA_HOME", "value": dir(".local/share") },
                { "key": "XDG_STATE_HOME", "value": dir(".local/state") },
                { "key": "XDG_CACHE_HOME", "value": dir(".cache") },
                { "key": "INPUTRC", "value": home.path().join(".inputrc").to_string_lossy() },
                { "key": "TERM_PROGRAM", "value": "" },
                { "key": "SHELL_SESSION_HISTORY", "value": "0" },
                { "key": "BASH_SILENCE_DEPRECATION_WARNING", "value": "1" },
            ],
        });
        if let (Some(settings), Some(extra)) = (settings.as_object_mut(), extra.as_object()) {
            settings.extend(extra.clone());
        }
        let mut shell = LocalShell::new();
        shell.connect(settings).await.expect("connect failed");
        let rx = shell.subscribe_output();
        Session {
            shell,
            rx,
            raw: Vec::new(),
            _home: home,
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.raw).to_string()
    }

    async fn read_until(&mut self, what: &str, done: impl Fn(&str) -> bool) {
        let ok = tokio::time::timeout(Duration::from_secs(60), async {
            while !done(&self.text()) {
                match self.rx.recv().await {
                    Some(chunk) => self.raw.extend(chunk),
                    None => return false,
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        assert!(ok, "timed out waiting for {what}: {:?}", self.text());
    }

    /// Collect output for `wait`.
    async fn soak(&mut self, wait: Duration) {
        let end = tokio::time::Instant::now() + wait;
        while let Ok(Some(chunk)) = tokio::time::timeout_at(end, self.rx.recv()).await {
            self.raw.extend(chunk);
        }
    }

    async fn close(mut self) {
        let _ = self.shell.write(b"exit\r");
        self.shell.disconnect().await.ok();
    }
}

async fn assert_question_waits_for_the_user(shell_name: &str) {
    let mut s = Session::start(shell_name).await;
    s.read_until("the startup question", |t| t.contains(QUESTION))
        .await;
    // The setup used to be typed within milliseconds of the question
    // switching the terminal to non-canonical mode.
    s.soak(Duration::from_millis(2500)).await;
    let text = s.text();
    assert!(
        !text.contains("ANSWER-"),
        "{shell_name}: something answered the startup question: {text:?}"
    );

    // The user answers. Their keys could still sit in the line editor, so
    // the setup waits for the prompt after their first command.
    s.shell.write(b"y").expect("write");
    s.read_until("the user's answer and the prompt", |t| {
        (t.contains("ANSWER-y") || t.contains("ANSWER-Y")) && t.contains(PROMPT)
    })
    .await;
    s.shell.write(b"echo FIRST_$((1+1))\r").expect("write");
    s.read_until("the first command and the integrated prompt", |t| {
        t.contains("FIRST_2") && t.contains("\x1b]133;A")
    })
    .await;
    s.shell.write(b"echo TH_$((40+2))\r").expect("write");
    s.read_until("the command and its D mark", |t| {
        t.contains("TH_42") && t.contains("\x1b]133;D;0")
    })
    .await;
    let text = s.text();
    assert!(
        !text.contains("command not found") && !text.contains("ANSWER-N"),
        "{shell_name}: {text:?}"
    );
    s.close().await;
}

#[tokio::test]
#[serial(local_pty)]
async fn zsh_startup_question_is_not_answered_by_the_setup() {
    let Some(shell) = shell_with_line_editor_mark("zsh") else {
        return;
    };
    assert_question_waits_for_the_user(&shell).await;
}

#[tokio::test]
#[serial(local_pty)]
async fn bash_startup_question_is_not_answered_by_the_setup() {
    let Some(shell) = shell_with_line_editor_mark("bash") else {
        return;
    };
    assert_question_waits_for_the_user(&shell).await;
}

/// A connection's initial command without the integration (#5455): the
/// session manager types it once [`wait_for_prompt`] sees the backend's probe
/// report the prompt. A startup question must not count as that prompt.
async fn assert_initial_command_waits_for_the_user(shell_name: &str) {
    use crate::session::prompt_ready::{wait_for_prompt, PromptSignal};
    const INITIAL: &str = "echo INIT_$((6*7))";
    let mut s = Session::start_with(
        shell_name,
        serde_json::json!({ "shellIntegration": false, "initialCommand": INITIAL }),
    )
    .await;
    s.read_until("the startup question", |t| t.contains(QUESTION))
        .await;
    let probe = s
        .shell
        .prompt_probe()
        .expect("a local bash/zsh has a probe");
    let early = tokio::time::timeout(
        Duration::from_millis(2500),
        wait_for_prompt(None, Some(&probe)),
    )
    .await;
    assert!(
        !matches!(early, Ok(PromptSignal::Probe)),
        "{shell_name}: the probe took the startup question for the prompt: {:?}",
        s.text()
    );

    // The user answers the question; then the prompt is reported.
    s.shell.write(b"y").expect("write");
    let signal = wait_for_prompt(None, Some(&probe)).await;
    assert_eq!(signal, PromptSignal::Probe, "{shell_name}: {:?}", s.text());
    s.shell
        .write(format!("{INITIAL}\r").as_bytes())
        .expect("write");
    s.read_until("the initial command's output", |t| t.contains("INIT_42"))
        .await;
    let text = s.text();
    assert!(
        (text.contains("ANSWER-y") || text.contains("ANSWER-Y"))
            && !text.contains("command not found"),
        "{shell_name}: {text:?}"
    );
    s.close().await;
}

#[tokio::test]
#[serial(local_pty)]
async fn zsh_startup_question_is_not_answered_by_the_initial_command() {
    let Some(shell) = shell_with_line_editor_mark("zsh") else {
        return;
    };
    assert_initial_command_waits_for_the_user(&shell).await;
}

#[tokio::test]
#[serial(local_pty)]
async fn bash_startup_question_is_not_answered_by_the_initial_command() {
    let Some(shell) = shell_with_line_editor_mark("bash") else {
        return;
    };
    assert_initial_command_waits_for_the_user(&shell).await;
}
