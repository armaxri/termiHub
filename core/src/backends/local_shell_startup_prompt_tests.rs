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
        Self::start_in(shell_name, extra, startup_files).await
    }

    /// As [`start_with`](Self::start_with), with the startup files `files`
    /// writes into the scratch `HOME` / `ZDOTDIR`.
    async fn start_in(
        shell_name: &str,
        extra: serde_json::Value,
        files: impl FnOnce(&Path),
    ) -> Session {
        let home = tempfile::tempdir().expect("temp HOME");
        files(home.path());
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

    // The user answers with one key, which the question consumes at once,
    // so the setup goes in at the first prompt (#5515).
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

/// The setup of a session, as the session manager sees it (#5512).
fn gated(s: &Session) -> std::sync::Arc<dyn crate::connection::GatedSetup> {
    s.shell
        .gated_setup()
        .expect("a bash / zsh announcing its line editor has a gated setup")
}

/// Run `false` and `true` and see their OSC 133 exit marks.
async fn assert_exit_marks(s: &mut Session) {
    s.shell.write(b"false\r").expect("write");
    s.read_until("the failed command's D mark", |t| {
        t.contains("\x1b]133;D;1")
    })
    .await;
    s.shell.write(b"true\r").expect("write");
    s.read_until("the next command's D mark", |t| {
        t.rfind("\x1b]133;D;0") > t.find("\x1b]133;D;1")
    })
    .await;
}

/// #5515, the maintainer's product-test profile: zsh with shell integration
/// and an initial command, whose `.zshrc` asks `read -q` before the first
/// prompt. Answering it must bring the setup at the first prompt, so the
/// prompt marks arrive without another command, and a failed command gets
/// its error mark.
#[tokio::test]
#[serial(local_pty)]
async fn zsh_answered_startup_question_brings_the_command_marks() {
    let Some(shell) = shell_with_line_editor_mark("zsh") else {
        return;
    };
    let mut s = Session::start_in(
        &shell,
        serde_json::json!({
            "shellIntegration": true,
            "initialCommand": "echo INITIAL-COMMAND-RAN",
        }),
        |home| {
            // No /etc/zshrc & co.: the system's own `compinit` must not ask first.
            std::fs::write(home.join(".zshenv"), "setopt no_global_rcs\n").expect("zshenv");
            // The kit's `.zshrc` (coordinator-handover/product-test/start.sh).
            std::fs::write(
                home.join(".zshrc"),
                "HISTFILE=\"$ZDOTDIR/.zsh_history\"\n\
                 print -P \"%F{yellow}[product-test] .zshrc asks a one-key question:%f\"\n\
                 if read -q \"?Continue startup? Press y or n: \"; then echo; \
                 echo \"ANSWER-Y\"; else echo; echo \"ANSWER-N\"; fi\n\
                 PROMPT='%F{green}question-shell%f %# '\n",
            )
            .expect("zshrc");
        },
    )
    .await;
    s.read_until("the startup question", |t| t.contains("Continue startup?"))
        .await;
    s.soak(Duration::from_millis(2500)).await;
    let text = s.text();
    assert!(
        !text.contains("ANSWER-") && !text.contains("\x1b]133;"),
        "the question was answered, or the setup typed into it: {text:?}"
    );
    let setup = gated(&s);
    assert!(setup.is_pending(), "the setup waits for the prompt");

    s.shell.write(b"y").expect("write");
    s.read_until("the answer and the integrated prompt", |t| {
        t.contains("ANSWER-Y") && t.contains("\x1b]133;A")
    })
    .await;
    assert!(!setup.is_pending(), "the setup went in at the first prompt");
    assert_exit_marks(&mut s).await;
    let text = s.text();
    assert!(!text.contains("command not found"), "{text:?}");
    s.close().await;
}

/// The bash flavour of #5515: `read -n 1` answered with one key.
#[tokio::test]
#[serial(local_pty)]
async fn bash_answered_startup_question_brings_the_command_marks() {
    let Some(shell) = shell_with_line_editor_mark("bash") else {
        return;
    };
    let mut s = Session::start(&shell).await;
    s.read_until("the startup question", |t| t.contains(QUESTION))
        .await;
    let setup = gated(&s);
    s.shell.write(b"y").expect("write");
    s.read_until("the answer and the integrated prompt", |t| {
        t.contains("ANSWER-y") && t.contains("\x1b]133;A")
    })
    .await;
    assert!(!setup.is_pending());
    assert_exit_marks(&mut s).await;
    s.close().await;
}

/// #5512: with bracketed paste turned off the line editor never announces
/// its prompt, so the setup is never typed on its own — not even after the
/// cap the canonical-mode cue has. The session manager's **Send now** types
/// it, and the marks follow.
async fn assert_paste_off_setup_waits_for_send_now(shell_name: &str) {
    let mut s = Session::start_in(
        shell_name,
        serde_json::json!({ "shellIntegration": true, "initialCommand": "true" }),
        |home| {
            std::fs::write(home.join(".zshenv"), "setopt no_global_rcs\n").expect("zshenv");
            std::fs::write(
                home.join(".zshrc"),
                // Before ZLE is loaded, ZLE sets the parameter again.
                format!("zmodload zsh/zle; unset zle_bracketed_paste\nPROMPT='{PROMPT} '\n"),
            )
            .expect("zshrc");
            let rc = format!("bind 'set enable-bracketed-paste off'\nPS1='{PROMPT} '\n");
            std::fs::write(home.join(".bash_profile"), &rc).expect("profile");
            std::fs::write(home.join(".bashrc"), &rc).expect("bashrc");
        },
    )
    .await;
    s.read_until("the prompt", |t| t.contains(PROMPT)).await;
    s.soak(Duration::from_millis(2500)).await;
    let text = s.text();
    assert!(
        !text.contains("\x1b]133;") && !text.contains("\x1b[?2004h"),
        "{shell_name}: {text:?}"
    );
    let setup = gated(&s);
    assert!(setup.is_pending(), "{shell_name}: nothing typed on its own");

    setup.send_now();
    s.read_until("the integrated prompt", |t| t.contains("\x1b]133;A"))
        .await;
    assert!(!setup.is_pending());
    setup.send_now(); // a second Send now types nothing
    assert_exit_marks(&mut s).await;
    let text = s.text();
    assert!(
        !text.contains("command not found"),
        "{shell_name}: {text:?}"
    );
    s.close().await;
}

#[tokio::test]
#[serial(local_pty)]
async fn zsh_paste_off_setup_waits_for_send_now() {
    let Some(shell) = shell_with_line_editor_mark("zsh") else {
        return;
    };
    assert_paste_off_setup_waits_for_send_now(&shell).await;
}

#[tokio::test]
#[serial(local_pty)]
async fn bash_paste_off_setup_waits_for_send_now() {
    let Some(shell) = shell_with_line_editor_mark("bash") else {
        return;
    };
    assert_paste_off_setup_waits_for_send_now(&shell).await;
}

/// Only the uncapped, mark-gated setup is offered to the session manager:
/// without the integration there is none.
#[tokio::test]
#[serial(local_pty)]
async fn no_gated_setup_without_the_integration() {
    let Some(shell) = shell_with_line_editor_mark("zsh") else {
        return;
    };
    let s = Session::start_with(&shell, serde_json::json!({ "shellIntegration": false })).await;
    assert!(s.shell.gated_setup().is_none());
    s.close().await;
}

/// A shell on the canonical-mode cue (macOS `/bin/bash` 3.2) offers its
/// pending setup to the session manager with the cap it is typed at, so the
/// initial command waits for the setup's mark that long (#5525); a shell
/// announcing its line editor offers it uncapped.
#[tokio::test]
#[serial(local_pty)]
async fn the_offered_setup_carries_its_cap() {
    let canonical = std::env::var("TERMIHUB_TEST_OLD_BASH").unwrap_or("/bin/bash".into());
    if installed(&canonical) && ready_signal(&canonical) == ReadySignal::Canonical {
        let s = Session::start_in(
            &canonical,
            serde_json::json!({ "shellIntegration": true }),
            |home| {
                std::fs::write(home.join(".bash_profile"), "sleep 2\n").expect("profile");
            },
        )
        .await;
        let setup = s
            .shell
            .gated_setup()
            .expect("a pending canonical-cue setup");
        assert!(setup.is_pending());
        assert_eq!(
            setup.cap(),
            Some(crate::backends::local_shell_setup::READY_CAP)
        );
        s.close().await;
    } else {
        eprintln!("{canonical} is not on the canonical-mode cue — skipping that half");
    }
    if let Some(shell) = shell_with_line_editor_mark("zsh") {
        let s = Session::start(&shell).await;
        assert_eq!(gated(&s).cap(), None);
        s.close().await;
    }
}
