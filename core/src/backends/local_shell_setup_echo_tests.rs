//! Real-shell tests: the typed shell-integration setup never reaches the
//! terminal, while everything the user's own startup prints does (#5009).
//!
//! Each test spawns a real `bash` / `zsh` through [`LocalShell`] (real PTY,
//! integration exactly as the app injects it) in a throwaway `HOME` whose rc
//! file prints lines — one of them after a pause, like a slow MOTD or a
//! `fortune` — and sets a fixed prompt. The raw stream must not contain any
//! of the setup, and the rendered screen ([`Screen`]) must show the rc output
//! and exactly one prompt.

use super::*;
use crate::output::test_screen::Screen;
use serial_test::serial;
use std::path::Path;
use std::time::Duration;

const PROMPT: &str = "THPROMPT>";

fn installed(binary: &str) -> bool {
    if binary.starts_with('/') {
        return Path::new(binary).exists();
    }
    ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .any(|dir| Path::new(dir).join(binary).exists())
}

struct Session {
    shell: LocalShell,
    rx: crate::connection::OutputReceiver,
    raw: Vec<u8>,
    _home: tempfile::TempDir,
}

/// The rc body: two lines around a pause, and the fixed prompt (`top` adds a
/// first prompt line, for the two-line case).
fn rc(prompt_var: &str, top: Option<&str>) -> String {
    let prompt = match top {
        Some(top) => format!("{top}\\n{PROMPT} "),
        None => format!("{PROMPT} "),
    };
    let quoted = if prompt_var == "PS1" {
        format!("PS1='{prompt}'")
    } else {
        format!("PROMPT=$'{prompt}'")
    };
    format!("echo 'RC-LINE-ONE'\nsleep 0.4\necho 'RC-LINE-TWO'\n{quoted}\n")
}

impl Session {
    async fn start(shell_name: &str, top: Option<&str>) -> Session {
        let home = tempfile::tempdir().expect("temp HOME");
        std::fs::write(home.path().join(".zshrc"), rc("PROMPT", top)).expect("zshrc");
        std::fs::write(home.path().join(".bash_profile"), rc("PS1", top)).expect("profile");
        let home_str = home.path().to_string_lossy().to_string();
        let mut shell = LocalShell::new();
        let settings = serde_json::json!({
            "shell": shell_name,
            "shellIntegration": true,
            "envVars": [
                { "key": "HOME", "value": home_str },
                { "key": "ZDOTDIR", "value": home_str },
            ],
        });
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

    /// Read until `done` holds, then until output has been quiet for 500 ms.
    async fn read_until_settled(&mut self, what: &str, done: impl Fn(&str) -> bool) {
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
        while let Ok(Some(chunk)) =
            tokio::time::timeout(Duration::from_millis(500), self.rx.recv()).await
        {
            self.raw.extend(chunk);
        }
    }

    async fn wait_for_integrated_prompt(&mut self) {
        self.read_until_settled("the integrated prompt", |t| {
            t.contains("\x1b]133;A") && t.contains(PROMPT)
        })
        .await;
    }

    fn screen(&self) -> Vec<String> {
        let mut screen = Screen::new(80);
        screen.feed(&self.raw);
        screen.lines()
    }

    async fn close(mut self) {
        let _ = self.shell.write(b"exit\r");
        self.shell.disconnect().await.ok();
    }
}

fn assert_no_setup_text(text: &str) {
    for leak in [
        "__termihub",
        "[termiHub]",
        "PROMPT_COMMAND",
        "precmd_functions",
    ] {
        assert!(!text.contains(leak), "setup text {leak:?} leaked: {text:?}");
    }
}

async fn assert_quiet_start(shell_name: &str) {
    if !installed(shell_name) {
        eprintln!("{shell_name} not installed — skipping");
        return;
    }
    let mut s = Session::start(shell_name, None).await;
    s.wait_for_integrated_prompt().await;
    assert_no_setup_text(&s.text());
    let screen = s.screen();
    assert_eq!(
        screen,
        vec!["RC-LINE-ONE", "RC-LINE-TWO", PROMPT],
        "raw: {:?}",
        s.text()
    );

    // The integration is live: a command is bracketed by C … D;0.
    s.shell.write(b"echo TH_$((40+2))\r").expect("write");
    s.read_until_settled("the command's D mark", |t| t.contains("\x1b]133;D;0"))
        .await;
    assert!(s.text().contains("TH_42"));
    s.close().await;
}

#[tokio::test]
#[serial(local_pty)]
async fn bash_start_shows_rc_output_and_one_prompt_but_no_setup() {
    assert_quiet_start("bash").await;
}

/// macOS's `/bin/bash` 3.2 (no `PS0`).
#[tokio::test]
#[serial(local_pty)]
async fn system_bash_start_shows_rc_output_and_one_prompt_but_no_setup() {
    assert_quiet_start("/bin/bash").await;
}

#[tokio::test]
#[serial(local_pty)]
async fn zsh_start_shows_rc_output_and_one_prompt_but_no_setup() {
    assert_quiet_start("zsh").await;
}

#[tokio::test]
#[serial(local_pty)]
async fn a_two_line_prompt_is_shown_once() {
    for shell_name in ["bash", "zsh"] {
        if !installed(shell_name) {
            continue;
        }
        let mut s = Session::start(shell_name, Some("TOP-LINE")).await;
        s.wait_for_integrated_prompt().await;
        assert_no_setup_text(&s.text());
        assert_eq!(
            s.screen(),
            vec!["RC-LINE-ONE", "RC-LINE-TWO", "TOP-LINE", PROMPT],
            "{shell_name} raw: {:?}",
            s.text()
        );
        s.close().await;
    }
}

/// Input typed before the first prompt still runs, after the setup.
#[tokio::test]
#[serial(local_pty)]
async fn input_typed_before_the_prompt_runs_after_the_setup() {
    for shell_name in ["bash", "zsh"] {
        if !installed(shell_name) {
            continue;
        }
        let mut s = Session::start(shell_name, None).await;
        s.shell.write(b"echo EARLY_$((1+1))\r").expect("write");
        s.read_until_settled("the early command", |t| {
            t.contains("EARLY_2") && t.contains("\x1b]133;D;0")
        })
        .await;
        let text = s.text();
        assert!(text.contains("RC-LINE-TWO"), "{shell_name}: {text:?}");
        s.close().await;
    }
}
