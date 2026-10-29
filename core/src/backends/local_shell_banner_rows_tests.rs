//! Real-shell tests: after the first command in a new shell that printed a
//! login banner, the screen holds the banner, one prompt with the command,
//! its output and the next prompt — no stale or repeated rows (#5054).
//!
//! macOS's `/bin/bash` prints a three-line "default interactive shell is now
//! zsh" notice when the account's login shell is bash (as on the CI
//! runners), and the runners' default prompt (`\h:\W \u\$`) is about 70
//! columns wide, so in a split pane both wrap. Each test prints that notice
//! and sets such a prompt from a throwaway `HOME`'s rc file, at a PTY width
//! where the prompt wraps and at one where it does not, with and without the
//! opt-in shell integration (whose typed setup is hidden and whose first
//! prompt is replaced by the next one — #5009). It runs one command and
//! renders the raw output on a [`Screen`] of the same width.

use super::*;
use crate::output::test_screen::Screen;
use serial_test::serial;
use std::path::Path;
use std::time::Duration;

/// A prompt as long as the macOS runners' (`<hostname>:~ runner$`).
const PROMPT: &str = "Mac-1761234567890-bt149-5f91d326-0b7c-4c3e-9d8e-FA29FE77A022:~ runner$";

/// The notice macOS's `/bin/bash` 3.2 prints at startup.
const BANNER: [&str; 3] = [
    "The default interactive shell is now zsh.",
    "To update your account to use zsh, please run `chsh -s /bin/zsh`.",
    "For more details, please visit https://support.apple.com/kb/HT208050.",
];

const COMMAND: &str = "echo N22_abc_";
const OUTPUT: &str = "N22_abc_";

/// A width where the prompt wraps (a split pane) and one where it fits.
const WIDTHS: [u16; 2] = [40, 100];

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
    cols: u16,
    _home: tempfile::TempDir,
}

impl Session {
    async fn start(shell_name: &str, integration: bool, cols: u16) -> Session {
        let home = tempfile::tempdir().expect("temp HOME");
        let banner: String = BANNER
            .iter()
            .map(|line| format!("printf '%s\\n' '{line}' >&2\n"))
            .collect();
        let rc = format!("{banner}PS1='{PROMPT} '\nPROMPT='{PROMPT} '\n");
        for file in [".bash_profile", ".bashrc", ".zshrc"] {
            std::fs::write(home.path().join(file), &rc).expect("rc file");
        }
        let home_str = home.path().to_string_lossy().to_string();
        let mut shell = LocalShell::new();
        let settings = serde_json::json!({
            "shell": shell_name,
            "shellIntegration": integration,
            "cols": cols,
            "rows": 24,
            "envVars": [
                { "key": "HOME", "value": home_str },
                { "key": "ZDOTDIR", "value": home_str },
                // The real notice, where the login shell is bash, would come
                // on top of the rc file's copy.
                { "key": "BASH_SILENCE_DEPRECATION_WARNING", "value": "1" },
            ],
        });
        shell.connect(settings).await.expect("connect failed");
        let rx = shell.subscribe_output();
        Session {
            shell,
            rx,
            raw: Vec::new(),
            cols,
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

    fn screen(&self) -> Vec<String> {
        let mut screen = Screen::new(usize::from(self.cols));
        screen.feed(&self.raw);
        screen.lines()
    }

    async fn close(mut self) {
        let _ = self.shell.write(b"exit\r");
        self.shell.disconnect().await.ok();
    }
}

/// `line` wrapped at `cols` the way a terminal wraps it.
fn wrapped(line: &str, cols: usize) -> Vec<String> {
    line.chars()
        .collect::<Vec<_>>()
        .chunks(cols)
        .map(|c| c.iter().collect::<String>().trim_end().to_string())
        .collect()
}

/// What the user must see: the banner, the prompt with the command, its
/// output and the next prompt — each exactly once.
fn expected_screen(cols: usize) -> Vec<String> {
    let mut want: Vec<String> = BANNER.iter().flat_map(|l| wrapped(l, cols)).collect();
    want.extend(wrapped(&format!("{PROMPT} {COMMAND}"), cols));
    want.push(OUTPUT.to_string());
    want.extend(wrapped(PROMPT, cols));
    want
}

/// Whether the prompt has been drawn after `marker` (with integration: the
/// prompt that carries the marks).
fn prompt_after(text: &str, marker: &str, integration: bool) -> bool {
    text.split_once(marker).is_some_and(|(_, after)| {
        after.contains("runner$ ") && (!integration || after.contains("\x1b]133;A"))
    })
}

async fn assert_clean_rows_after_first_command(shell_name: &str, integration: bool, cols: u16) {
    let label = format!("{shell_name} integration={integration} cols={cols}");
    let mut s = Session::start(shell_name, integration, cols).await;
    s.read_until_settled("the first prompt", |t| {
        prompt_after(t, "HT208050", integration)
    })
    .await;
    let submitted = s.raw.len();
    s.shell
        .write(format!("{COMMAND}\r").as_bytes())
        .expect("write");
    let done = format!("{OUTPUT}\r\n");
    s.read_until_settled("the output and the next prompt", |t| {
        prompt_after(t, &done, integration)
    })
    .await;
    let screen = s.screen();
    let want = expected_screen(usize::from(cols));
    assert_eq!(screen, want, "{label}\nraw: {:?}", s.text());
    if integration {
        assert_command_marked(&String::from_utf8_lossy(&s.raw[submitted..]), &label);
    }
    s.close().await;
}

/// The command is recorded: its output is bracketed by `C` (output starts)
/// and `D;0` (finished) — on bash 3 too, which has no `PS0` and, after #5059,
/// no `B` on its prompt (its `C` comes from a `DEBUG` trap).
fn assert_command_marked(after_submit: &str, label: &str) {
    let c_mark = "\x1b]133;C\x07";
    let d_mark = "\x1b]133;D;0\x07";
    let marked = after_submit.split_once(c_mark).is_some_and(|(echo, rest)| {
        echo.contains("\r\n") && rest.starts_with(&format!("{OUTPUT}\r\n")) && rest.contains(d_mark)
    });
    assert!(
        marked,
        "{label}: the command must be marked C … output … D;0: {after_submit:?}"
    );
    assert_eq!(
        after_submit.matches("\x1b]133;C").count(),
        1,
        "{label}: exactly one C per command: {after_submit:?}"
    );
}

async fn assert_clean_rows_everywhere(integration: bool) {
    for shell_name in ["/bin/bash", "bash", "zsh"] {
        if !installed(shell_name) {
            eprintln!("{shell_name} not installed — skipping");
            continue;
        }
        for cols in WIDTHS {
            assert_clean_rows_after_first_command(shell_name, integration, cols).await;
        }
    }
}

/// Default: no shell hook is typed (#5042), the shell draws everything.
#[tokio::test]
#[serial(local_pty)]
async fn banner_and_long_prompt_leave_clean_rows_after_the_first_command_by_default() {
    assert_clean_rows_everywhere(false).await;
}

/// Opt-in command marks: the typed setup is hidden and the next prompt takes
/// the first prompt's place. Every row of the first prompt goes (also the
/// rows it wrapped onto), and the command echo stays where the shell meant
/// it to be.
#[tokio::test]
#[serial(local_pty)]
async fn banner_and_long_prompt_leave_clean_rows_after_the_first_command_with_command_marks() {
    assert_clean_rows_everywhere(true).await;
}
