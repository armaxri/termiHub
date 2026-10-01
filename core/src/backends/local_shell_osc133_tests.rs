//! Real-shell OSC 133 command-mark tests (#3415, #4013).
//!
//! The snippet unit tests in `session/shell.rs` pin the *text* of the bash/zsh
//! hooks; these spawn a real `bash` / `zsh` through [`LocalShell`] (real PTY,
//! shell integration injected exactly as the app does it) and prove the hooks
//! actually fire: every command is bracketed by `C` … `D;<exit>` with the real
//! exit status, the bytes between those two marks are exactly the command's
//! output (what the frontend's "Copy Last Command Output" copies), and a plain
//! `sh` — which gets no integration — emits no marks at all.
//!
//! Each shell runs hermetically: `HOME` and `ZDOTDIR` point into a throwaway
//! directory so a developer's own rc files (prompt frameworks, their own
//! OSC 133 emitters) cannot change what is measured; an empty `.zshrc` there
//! keeps zsh's new-user menu away. A shell that is not
//! installed is skipped with a note rather than failed.

use super::*;
use serial_test::serial;
use std::path::Path;
use std::time::Duration;

/// Ceiling for one wait on the shell (start-up or one command). Every wait
/// returns as soon as its condition holds; the ceiling only bounds a hang.
fn wait_ceiling() -> Duration {
    std::env::var("TERMIHUB_TEST_READY_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(60))
}

/// An OSC 133 mark as it appears on the wire (`ESC ] 133 ; <payload> BEL`).
fn mark(payload: &str) -> String {
    format!("\x1b]133;{payload}\x07")
}

/// Drop CSI sequences (`ESC [ … final`) and other OSC sequences (`ESC ] … BEL`)
/// that are not OSC 133, so assertions see the command output and the marks
/// only — line-editor mode switches such as bracketed paste (`ESC[?2004l`) are
/// not output.
fn strip_non_marks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                // Parameters/intermediates until a final byte in @..~.
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                let mut seq = String::from("\x1b");
                let mut terminated = false;
                for n in chars.by_ref() {
                    seq.push(n);
                    if n == '\x07' {
                        terminated = true;
                        break;
                    }
                    if seq.ends_with("\x1b\\") {
                        terminated = true;
                        break;
                    }
                }
                if terminated && seq.starts_with("\x1b]133;") {
                    out.push_str(&seq);
                }
            }
            Some(_) => {
                // Two-byte escape (e.g. `ESC =`, `ESC >`): drop both.
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// A live shell session plus everything it has printed so far.
struct Session {
    shell: LocalShell,
    rx: crate::connection::OutputReceiver,
    output: String,
    _home: tempfile::TempDir,
}

impl Session {
    async fn start(shell_name: &str) -> Session {
        let home = tempfile::tempdir().expect("temp HOME");
        // An empty `.zshrc` keeps zsh from starting its interactive
        // `zsh-newuser-install` menu in a home without startup files (Linux).
        std::fs::write(home.path().join(".zshrc"), "").expect("write .zshrc");
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
            output: String::new(),
            _home: home,
        }
    }

    /// Read until `done(output)` holds; panics with the transcript on timeout.
    async fn read_until(&mut self, what: &str, done: impl Fn(&str) -> bool) {
        let rx = &mut self.rx;
        let output = &mut self.output;
        let ok = tokio::time::timeout(wait_ceiling(), async {
            if done(output) {
                return true;
            }
            while let Some(chunk) = rx.recv().await {
                output.push_str(&String::from_utf8_lossy(&chunk));
                if done(output) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(
            ok,
            "timed out waiting for {what}; transcript: {:?}",
            self.output
        );
    }

    /// Wait until the shell's latest prompt has been drawn in full, i.e. the
    /// input-start mark (`B`) follows the last prompt-start mark (`A`).
    ///
    /// `A` alone is not enough (#4071): bash prints it from `PROMPT_COMMAND`,
    /// *before* readline puts the terminal into raw mode and draws `PS1`. Input
    /// written in that window is echoed by the tty itself, then again by
    /// readline after the prompt, so the early echo and the prompt line land
    /// between `C` and `D` when there is no `C` (bash < 4.4). `B` is part of
    /// `PS1`, so once it is out the line editor owns the terminal.
    async fn wait_for_input_start(&mut self) {
        let (a, b) = (mark("A"), mark("B"));
        self.read_until("a fully drawn prompt (A … B)", |out| {
            out.rfind(&a)
                .is_some_and(|pos| out[pos + a.len()..].contains(&b))
        })
        .await;
    }

    /// Wait for the prompt, submit `line`, and return everything printed from
    /// the submission until the shell's next prompt-start mark (`A`).
    async fn run(&mut self, line: &str) -> String {
        self.wait_for_input_start().await;
        let start = self.output.len();
        self.shell
            .write(format!("{line}\r").as_bytes())
            .expect("write failed");
        let a = mark("A");
        self.read_until(&format!("the prompt after {line:?}"), |out| {
            out[start..].contains(&a)
        })
        .await;
        let segment = &self.output[start..];
        let end = segment.find(&a).expect("A present") + a.len();
        segment[..end].to_string()
    }

    async fn close(mut self) {
        let _ = self.shell.write(b"exit\r");
        self.shell.disconnect().await.ok();
    }
}

fn installed(binary: &str) -> bool {
    ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .any(|dir| Path::new(dir).join(binary).exists())
}

/// Start `shell_name`, wait for the injected integration to print its first
/// marked prompt, run `seq 3` and `false`, and check the marks around each.
async fn assert_marks_bracket_real_commands(shell_name: &str) {
    if !installed(shell_name) {
        eprintln!("{shell_name} not installed — skipping the real-shell OSC 133 test");
        return;
    }
    let mut session = Session::start(shell_name).await;
    // The integration snippet is typed into the shell's stdin; once it has run,
    // every prompt is bracketed by `A` … `B`, and `run` waits for that before
    // it types anything.
    let a = mark("A");

    // seq: exit 0, output exactly three lines.
    let seq = strip_non_marks(&session.run("seq 3").await);
    let done_ok = mark("D;0");
    let d = seq
        .find(&done_ok)
        .unwrap_or_else(|| panic!("`seq 3` must finish with D;0: {seq:?}"));
    let c = mark("C");
    let output_start = match seq.find(&c) {
        Some(pos) => pos + c.len(),
        // bash < 4.4 has no PS0, so no `C`; the frontend then takes the output
        // as starting on the line after the input — mirror that here.
        None => end_of_echo(&seq, "seq 3").unwrap_or_else(|| {
            panic!("without C, the segment must open with the echoed command: {seq:?}")
        }),
    };
    assert!(output_start <= d, "C must precede D: {seq:?}");
    let rest = seq[output_start..d]
        .strip_prefix("1\r\n2\r\n3\r\n")
        .unwrap_or_else(|| panic!("the output between C and D must be `seq 3`'s: {seq:?}"));
    assert!(
        is_prompt_sp(rest),
        "nothing but zsh's PROMPT_SP may follow the output before D: {seq:?}"
    );
    assert!(
        seq[d..].contains(&a),
        "a new prompt (A) must follow D: {seq:?}"
    );
    if shell_name == "zsh" {
        assert!(seq.contains(&c), "zsh's preexec hook must emit C: {seq:?}");
    }

    // false: the D mark carries the real non-zero exit status.
    let failed = strip_non_marks(&session.run("false").await);
    assert!(
        failed.contains(&mark("D;1")),
        "`false` must finish with D;1: {failed:?}"
    );

    dump_transcript(shell_name, &session.output);
    session.close().await;
}

/// The index just past the line break that ends the echo of `line` at the very
/// start of `text`, or `None` if `text` does not open with that echo.
///
/// The echo may be wrapped: a prompt that fills the line (CI runners have very
/// long host names) makes readline break the input with a CR and padding
/// rather than a `\r\n`, e.g. `se \rq 3\r\n`. So only the command's own
/// non-blank characters are matched, in order, skipping blanks and line-break
/// characters between them; after the last one only blanks may precede `\r\n`.
fn end_of_echo(text: &str, line: &str) -> Option<usize> {
    let mut want = line.chars().filter(|c| !c.is_whitespace()).peekable();
    let mut matched_to = 0;
    for (i, ch) in text.char_indices() {
        if want.peek().is_none() {
            break;
        }
        matched_to = i + ch.len_utf8();
        if matches!(ch, ' ' | '\r' | '\n') {
            continue;
        }
        if want.next() != Some(ch) {
            return None;
        }
    }
    if want.peek().is_some() {
        return None;
    }
    let tail = &text[matched_to..];
    let nl = tail.find("\r\n")?;
    tail[..nl]
        .chars()
        .all(|c| c == ' ' || c == '\r')
        .then_some(matched_to + nl + 2)
}

/// zsh's PROMPT_SP: after a command, zsh prints `%` (`#` for root) plus a row of
/// padding and then `\r \r`, which overwrites the `%` again when the output
/// ended in a newline. It runs before `precmd`, so it sits between the output
/// and `D` — but it leaves only blanks on screen, so it is not output.
fn is_prompt_sp(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    let mut chars = s.chars();
    matches!(chars.next(), Some('%' | '#'))
        && s.ends_with("\r \r")
        && chars.all(|c| c == ' ' || c == '\r')
}

/// When `TERMIHUB_OSC133_TRANSCRIPT_DIR` is set, write the session's output from
/// its first marked prompt on to `<dir>/<shell>.json` — how the frontend replay
/// fixture (`src/test/fixtures/osc133/<shell>.json`, read by
/// `src/services/commandMarks.real-shell.test.ts`) is regenerated.
/// The user and host names are replaced with fixed placeholders.
fn dump_transcript(shell_name: &str, output: &str) {
    let Ok(dir) = std::env::var("TERMIHUB_OSC133_TRANSCRIPT_DIR") else {
        return;
    };
    // Fixtures are per shell name; a path-valued run (`/bin/bash`) has none.
    if shell_name.contains('/') {
        return;
    }
    let from = output.find(&mark("A")).unwrap_or(0);
    let mut text = output[from..].to_string();
    let user = std::env::var("USER").unwrap_or_default();
    if !user.is_empty() {
        text = text.replace(&user, "user");
    }
    if let Some(host) = short_hostname() {
        text = text.replace(&host, "host");
    }
    let path = Path::new(&dir).join(format!("{shell_name}.json"));
    let json = serde_json::json!({ "shell": shell_name, "cols": 80, "transcript": text });
    let body = serde_json::to_string_pretty(&json).expect("json") + "\n";
    std::fs::write(&path, body).expect("write transcript");
    eprintln!("wrote {}", path.display());
}

fn short_hostname() -> Option<String> {
    let out = std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()?;
    let host = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!host.is_empty()).then_some(host)
}

#[tokio::test]
#[serial(local_pty)]
async fn bash_marks_commands_with_their_exit_codes() {
    assert_marks_bracket_real_commands("bash").await;
}

/// `/bin/bash` by path: on macOS that is the system bash 3.2, which has no
/// `PS0` and so no `C` mark — the path the macOS CI runner took in #4071, which
/// a Homebrew `bash` earlier on `PATH` would otherwise hide on a developer Mac.
#[tokio::test]
#[serial(local_pty)]
async fn system_bash_marks_commands_with_their_exit_codes() {
    assert_marks_bracket_real_commands("/bin/bash").await;
}

#[tokio::test]
#[serial(local_pty)]
async fn zsh_marks_commands_with_their_exit_codes() {
    assert_marks_bracket_real_commands("zsh").await;
}

/// `sh` gets no shell integration, so it must never emit an OSC 133 mark —
/// the frontend tracker then stays empty and every mark action is a no-op.
#[tokio::test]
#[serial(local_pty)]
async fn sh_emits_no_marks() {
    let mut session = Session::start("sh").await;
    session
        .shell
        .write(b"seq 3; false; echo TH_SH_DONE_$((40+2))\r")
        .expect("write failed");
    session
        .read_until("the sh command output", |out| out.contains("TH_SH_DONE_42"))
        .await;
    assert!(
        !session.output.contains("\x1b]133;"),
        "sh must emit no OSC 133 marks: {:?}",
        session.output
    );
    session.close().await;
}

#[test]
fn prompt_sp_is_recognised_but_real_output_is_not() {
    assert!(is_prompt_sp(""));
    assert!(is_prompt_sp("%     \r \r"));
    assert!(is_prompt_sp("#  \r \r"));
    assert!(!is_prompt_sp("4\r\n"));
    assert!(!is_prompt_sp("%  extra\r \r"));
}

#[test]
fn echo_end_is_found_through_wraps_but_not_past_a_prompt() {
    // Plain echo.
    assert_eq!(end_of_echo("seq 3\r\n1\r\n", "seq 3"), Some(7));
    // Wrapped at the right margin (both shapes seen from readline).
    let wrapped = "se \rq 3\r\n1\r\n";
    assert_eq!(
        end_of_echo(wrapped, "seq 3"),
        Some(wrapped.find('1').unwrap())
    );
    let wrapped = "seq \r 3\r\n1\r\n";
    assert_eq!(
        end_of_echo(wrapped, "seq 3"),
        Some(wrapped.find('1').unwrap())
    );
    // The #4071 shape (input typed before the prompt: an early tty echo, the
    // prompt, then readline's echo) is not something this can untangle — the
    // output would be taken to start at the prompt line, so the `seq 3` check
    // fails loudly. Waiting for `B` before typing is what rules this shape out.
    let raced = "seq 3\r\nhost:~ user$ \x1b]133;B\x07seq 3\r\n1\r\n";
    assert_eq!(end_of_echo(raced, "seq 3"), Some(7));
    // Not the echo at all.
    assert_eq!(end_of_echo("host:~ user$ seq 3\r\n", "seq 3"), None);
    assert_eq!(end_of_echo("seq 3 extra\r\n", "seq 3"), None);
}

#[test]
fn strip_non_marks_keeps_only_osc_133() {
    let raw = "\x1b[?2004l\r\x1b]7;file:///tmp\x07\x1b]133;C\x071\r\n\x1b]133;D;0\x07\x1b=";
    assert_eq!(
        strip_non_marks(raw),
        "\r\x1b]133;C\x071\r\n\x1b]133;D;0\x07"
    );
}
