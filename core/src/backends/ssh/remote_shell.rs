//! Remote login-shell detection for the SSH session setup lines (#4143,
//! #4147, #4148).
//!
//! Shell integration types a one-line setup command into the interactive
//! shell. That line is shell-specific: the POSIX hook is a parse error in
//! PowerShell, and — worse — its trailing LF is a *continuation* in PSReadLine,
//! so the setup line stays half-typed and the user's first command is glued
//! onto it. So before injecting anything the backend asks the host which shell
//! it runs, over an SSH exec channel (which the server runs through the same
//! login shell / Win32-OpenSSH `DefaultShell` as the interactive session).
//!
//! The probe is a single `echo` whose output differs per shell family:
//!
//! | Shell | `%OS%` | `$PSHOME` | Output between the markers |
//! | --- | --- | --- | --- |
//! | POSIX (bash, zsh, sh, fish) | literal | unset → nothing | `%OS%` |
//! | PowerShell (5 or 7, any OS) | literal | PowerShell's home | `%OS%` + a path |
//! | cmd.exe | `Windows_NT` | literal | `Windows_NT $PSHOME` |
//!
//! The probe uses no quotes and no shell metacharacters on purpose:
//! Win32-OpenSSH hands the command line to `powershell.exe -c`, which strips
//! double quotes, and an unquoted `|` would then become a pipeline.
//!
//! Anything else (exec refused, a timeout, a `csh` "Undefined variable" error,
//! no markers) is [`RemoteShell::Unknown`], and nothing is injected for it: a
//! missing CWD hook is a degradation, a corrupted first command is a bug.
//!
//! `%OS%` stays literal under PowerShell on every OS, so it cannot tell a
//! Windows host from a Unix one there; `$PSHOME` can: it is an absolute POSIX
//! path (`/opt/microsoft/powershell/7`) only on Linux/macOS, giving
//! [`RemoteShell::UnixPowerShell`] (#4148).
//!
//! # Every typed setup line goes through here
//!
//! Besides shell integration, the connector types two more setup lines into
//! the interactive shell (#4147): the fallback for the configured environment
//! variables ([`env_setup_line`], for names the server's `AcceptEnv` rejects)
//! and the X11 `DISPLAY` / `xauth` lines ([`x11_setup_lines`]). Each is built
//! in the detected shell's syntax and line ending, or skipped (with a log
//! line) when the shell has no safe equivalent.
//!
//! A PowerShell login shell needs one more thing (#4148, #4604): its setup is
//! held back until the first prompt has printed, and the user's input until
//! the setup has run ([`SetupGate`]). Typed earlier on Linux/macOS, the setup
//! lands in the tty while it is still in cooked mode, whose `ICRNL` turns the
//! CR into LF — a continuation for PSReadLine, which then merges the user's
//! first command into the setup line. On Windows, input that arrives while
//! `powershell.exe` is still starting can be dropped, so the first command ran
//! without the configured environment.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tracing::{debug, warn};

use super::exec::ssh_exec_with_stdin_timeout;
use super::handler::SshSession;
use crate::output::prompt_mark::PromptMarkDetector;
use crate::session::shell::osc7_setup_command;

/// Opening marker of the probe's output.
pub const SHELL_PROBE_START: &str = "termihub_shell_probe";
/// Closing marker of the probe's output.
pub const SHELL_PROBE_END: &str = "termihub_shell_probe_end";

/// The probe command run over an exec channel (see the module docs).
pub const SHELL_PROBE_COMMAND: &str =
    "echo termihub_shell_probe %OS% $PSHOME termihub_shell_probe_end";

/// Upper bound on the probe. Generous enough for a cold Windows PowerShell
/// start (or a heavy `.bashrc`, which bash sources for sshd-run commands), yet
/// short enough that a stalled exec channel delays the connect only briefly.
pub const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// The flavour of the remote login shell, as far as shell integration cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RemoteShell {
    /// A POSIX-style shell (bash, zsh, sh, dash, fish, ...).
    Posix,
    /// Windows PowerShell 5 or PowerShell 7 (`pwsh`) on a Windows host.
    PowerShell,
    /// PowerShell 7 (`pwsh`) as the login shell of a Linux/macOS host (#4148).
    UnixPowerShell,
    /// Windows `cmd.exe`.
    Cmd,
    /// Not detected (not probed, exec refused, timed out, unrecognised output).
    #[default]
    Unknown,
}

/// Classify the probe's stdout.
///
/// Only the text between the two markers is considered, so `.bashrc` / MOTD
/// noise around it cannot confuse the result. PowerShell's `echo` prints each
/// argument on its own line, so the tokens are taken across lines.
pub fn classify_shell_probe(stdout: &str) -> RemoteShell {
    let tokens: Vec<&str> = stdout.split_whitespace().collect();
    // Exact-token match: the start marker is a prefix of the end marker.
    let Some(start) = tokens.iter().position(|t| *t == SHELL_PROBE_START) else {
        return RemoteShell::Unknown;
    };
    let Some(len) = tokens[start + 1..]
        .iter()
        .position(|t| *t == SHELL_PROBE_END)
    else {
        return RemoteShell::Unknown;
    };
    let between = &tokens[start + 1..start + 1 + len];
    match between {
        // `%OS%` untouched and `$PSHOME` expanded to nothing: a POSIX shell.
        ["%OS%"] => RemoteShell::Posix,
        // `%OS%` untouched and `$PSHOME` expanded to PowerShell's home: an
        // absolute POSIX path on Linux/macOS (#4148) ...
        ["%OS%", home, ..] if home.starts_with('/') => RemoteShell::UnixPowerShell,
        // ... a Windows path otherwise (which may contain spaces, e.g.
        // `C:\Program Files\PowerShell\7`).
        ["%OS%", _, ..] => RemoteShell::PowerShell,
        // `%OS%` expanded (to `Windows_NT`) and `$PSHOME` left literal: cmd.exe.
        [os, "$PSHOME"] if os.eq_ignore_ascii_case("Windows_NT") => RemoteShell::Cmd,
        _ => RemoteShell::Unknown,
    }
}

/// Probe the remote login shell over an exec channel on `session`.
///
/// Never fails: any error or timeout is reported as [`RemoteShell::Unknown`].
pub async fn detect_remote_shell(session: &SshSession) -> RemoteShell {
    match ssh_exec_with_stdin_timeout(session, SHELL_PROBE_COMMAND, "", SHELL_PROBE_TIMEOUT).await {
        Ok(output) => {
            let shell = classify_shell_probe(&output.stdout);
            debug!(
                ?shell,
                exit_status = output.exit_status,
                "Remote shell probe"
            );
            shell
        }
        Err(e) => {
            debug!("Remote shell probe failed: {e}");
            RemoteShell::Unknown
        }
    }
}

/// The shell-integration line to type into a session whose login shell is
/// `shell`, including its line terminator, or `None` to inject nothing.
///
/// - POSIX: the bash/zsh OSC 7 hook, ended with LF — unchanged from before
///   detection existed.
/// - PowerShell (Windows or Unix): the PowerShell OSC 7 / OSC 133 prompt
///   override, ended with CR, which is Enter for PSReadLine (an LF would leave
///   the line unsubmitted and merge it with the user's first command). The
///   connector holds it back until the first prompt ([`SetupGate`]), so a
///   Unix tty no longer maps that CR to LF and a starting Windows shell
///   cannot drop it.
/// - cmd.exe and unknown shells: nothing.
pub fn integration_setup_line(shell: RemoteShell) -> Option<String> {
    match shell {
        RemoteShell::Posix => osc7_setup_command("bash").map(|s| format!("{s}\n")),
        RemoteShell::PowerShell | RemoteShell::UnixPowerShell => {
            osc7_setup_command("powershell").map(|s| format!("{s}\r"))
        }
        RemoteShell::Cmd | RemoteShell::Unknown => None,
    }
}

/// The byte that submits a typed line in `shell`: LF for POSIX shells
/// (unchanged from before detection), CR — the Enter key — for PowerShell and
/// cmd.exe. `None` for an undetected shell, which gets no typed setup at all.
pub fn line_ending(shell: RemoteShell) -> Option<&'static str> {
    match shell {
        RemoteShell::Posix => Some("\n"),
        RemoteShell::PowerShell | RemoteShell::UnixPowerShell | RemoteShell::Cmd => Some("\r"),
        RemoteShell::Unknown => None,
    }
}

/// Whether the setup lines for `shell` must wait for its first prompt, and the
/// user's input for the setup (see [`SetupGate`]): every PowerShell login
/// shell. On Linux/macOS the cooked tty turns the setup's CR into LF until
/// PSReadLine is up (#4148); on Windows input typed while `powershell.exe` is
/// still starting can be dropped, so the first command ran without the
/// configured environment (#4604). POSIX shells read the LF-ended lines fine
/// from the cooked tty, and cmd.exe gets no integration line to sequence.
pub fn defers_setup_until_prompt(shell: RemoteShell) -> bool {
    matches!(shell, RemoteShell::PowerShell | RemoteShell::UnixPowerShell)
}

/// Whether `name` is safe to type as an environment variable name in every
/// supported shell: `[A-Za-z_][A-Za-z0-9_]*`. Anything else (`;`, spaces, `$`,
/// `=`...) could end the assignment and start a command.
fn is_safe_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Whether `value` can be typed into a terminal at all. A control character is
/// interpreted by the remote tty / line editor before any quoting applies:
/// `^U` erases the line typed so far, `^C` interrupts it, CR/LF submit it, Tab
/// completes — so a hostile value could replace the assignment with a command
/// of its own. Such variables are skipped (the SSH env request still carried
/// them when the server's `AcceptEnv` allows the name).
fn is_typeable_value(value: &str) -> bool {
    !value.chars().any(char::is_control)
}

/// `value` as a POSIX single-quoted word: `'` becomes `'\''`.
fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `value` as a PowerShell single-quoted (verbatim) string. PowerShell also
/// treats the typographic quotes U+2018..U+201B as single quotes, so every
/// one of them is doubled too — a doubled quote is a literal quote.
fn powershell_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// `NAME=value` as a cmd.exe `set "NAME=value"`, or `None` when cmd.exe cannot
/// take the value literally: inside the quotes `& | < > ( ) ^` are literal,
/// but `%` (and `!` under delayed expansion) still expand and a `"` would end
/// the quoting — and an interactive cmd.exe has no reliable escape for them.
fn cmd_set(name: &str, value: &str) -> Option<String> {
    if value.contains(['"', '%', '!']) {
        return None;
    }
    Some(format!("set \"{name}={value}\""))
}

/// The fallback line that sets the configured environment variables in the
/// interactive shell, in `shell`'s syntax and ended with its [`line_ending`],
/// or `None` when there is nothing (safe) to type.
///
/// # Why this exists (the `AcceptEnv` caveat)
///
/// Setting an environment variable on the SSH *client* does not make it appear
/// on the server: the standard channel env request (`set_env`, RFC 4254 §6.4)
/// is only honoured for names the server explicitly whitelists via sshd's
/// `AcceptEnv`, which defaults to accepting little more than `LANG`/`LC_*`.
/// So the backend requests each variable via `set_env` (clean, and present
/// before the login shell's rc files run *when* the server accepts it) **and**
/// types the line built here into the interactive shell after it starts —
/// guaranteeing the variables take effect regardless of `AcceptEnv`. The line
/// is briefly visible in the terminal, like the X11 `DISPLAY` line.
///
/// Per shell (keys sorted for a deterministic line):
///
/// - POSIX: `export A='1' B='it'\''s'` + LF — single quotes keep every
///   character literal.
/// - PowerShell: `$env:A='1'; $env:B='it''s'` + CR — verbatim strings.
/// - cmd.exe: `set "A=1" & set "B=2"` + CR; a value cmd.exe cannot take
///   literally (`"`, `%`, `!`) is skipped with a warning.
/// - Unknown: nothing (warned) — no syntax is known to be safe.
///
/// In every shell a name outside `[A-Za-z_][A-Za-z0-9_]*` or a value with a
/// control character is skipped with a warning: neither can be typed without
/// risking a command injection. Values are never logged (they may be secrets).
pub fn env_setup_line(shell: RemoteShell, env: &HashMap<String, String>) -> Option<String> {
    if env.is_empty() {
        return None;
    }
    let Some(eol) = line_ending(shell) else {
        warn!(
            count = env.len(),
            "remote shell not detected; not typing the environment-variable fallback \
             (variables apply only where the server's AcceptEnv allows them)"
        );
        return None;
    };
    let mut pairs: Vec<(&String, &String)> = env.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));

    let mut statements: Vec<String> = Vec::new();
    for (name, value) in pairs {
        if !is_safe_env_name(name) {
            warn!(key = %name, "environment variable name is not typeable safely; skipped");
            continue;
        }
        if !is_typeable_value(value) {
            warn!(key = %name, "environment variable value has control characters; skipped");
            continue;
        }
        let statement = match shell {
            RemoteShell::Posix => Some(format!("{name}={}", posix_quote(value))),
            RemoteShell::PowerShell | RemoteShell::UnixPowerShell => {
                Some(format!("$env:{name}={}", powershell_quote(value)))
            }
            RemoteShell::Cmd => cmd_set(name, value),
            RemoteShell::Unknown => None,
        };
        match statement {
            Some(statement) => statements.push(statement),
            None => warn!(
                key = %name,
                "environment variable value cannot be set literally in cmd.exe; skipped"
            ),
        }
    }
    if statements.is_empty() {
        return None;
    }
    let line = match shell {
        RemoteShell::Posix => format!("export {}", statements.join(" ")),
        RemoteShell::Cmd => statements.join(" & "),
        _ => statements.join("; "),
    };
    Some(format!("{line}{eol}"))
}

/// The lines that point X11 clients in the interactive shell at the forwarded
/// display `localhost:<display>.0` and register its `MIT-MAGIC-COOKIE-1`, each
/// ended with the shell's [`line_ending`].
///
/// - POSIX: `export DISPLAY=...` + `xauth add ... 2>/dev/null` — unchanged.
/// - PowerShell on Linux/macOS: `$env:DISPLAY='...'` + the `xauth add`, only
///   when `xauth` is on the `PATH` (it is a native command there too).
/// - PowerShell / cmd.exe on Windows: the `DISPLAY` assignment only. Windows
///   has no `xauth`, so the cookie line is skipped.
/// - Unknown: nothing (warned).
///
/// A cookie that is not plain hex is never typed (it is generated locally, so
/// that would be a bug, but it must not become a command either).
pub fn x11_setup_lines(shell: RemoteShell, display_num: u32, cookie: Option<&str>) -> Vec<String> {
    let Some(eol) = line_ending(shell) else {
        warn!(
            display_num,
            "remote shell not detected; not typing the X11 DISPLAY / xauth setup"
        );
        return Vec::new();
    };
    let cookie = cookie.filter(|c| {
        let ok = !c.is_empty() && c.chars().all(|ch| ch.is_ascii_hexdigit());
        if !ok {
            warn!(
                display_num,
                "X11 cookie is not hex; not typing the xauth line"
            );
        }
        ok
    });
    let mut lines = Vec::new();
    match shell {
        RemoteShell::Posix => {
            lines.push(format!("export DISPLAY=localhost:{display_num}.0{eol}"));
            if let Some(cookie) = cookie {
                lines.push(format!(
                    "xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null{eol}"
                ));
            }
        }
        RemoteShell::UnixPowerShell => {
            lines.push(format!("$env:DISPLAY='localhost:{display_num}.0'{eol}"));
            if let Some(cookie) = cookie {
                lines.push(format!(
                    "if(Get-Command xauth -ErrorAction Ignore){{xauth add localhost:{display_num} \
                     MIT-MAGIC-COOKIE-1 {cookie} 2>$null}}{eol}"
                ));
            }
        }
        RemoteShell::PowerShell | RemoteShell::Cmd => {
            lines.push(if shell == RemoteShell::Cmd {
                format!("set \"DISPLAY=localhost:{display_num}.0\"{eol}")
            } else {
                format!("$env:DISPLAY='localhost:{display_num}.0'{eol}")
            });
            if cookie.is_some() {
                debug!(
                    display_num,
                    "Windows host: no xauth, X11 cookie line skipped"
                );
            }
        }
        RemoteShell::Unknown => {}
    }
    lines
}

/// How long the shell's output must stay quiet after it printed something
/// before its first prompt counts as up ([`SetupGate`]).
pub const SETUP_GATE_SETTLE: Duration = Duration::from_millis(300);

/// Upper bound on each of the gate's two waits — for the first prompt, then
/// for the setup to finish: a shell that prints nothing (or never stops
/// printing) still gets its setup, and the user's input still flows.
pub const SETUP_GATE_CAP: Duration = Duration::from_secs(8);

/// How long after typing the setup the gate waits for it to report back before
/// typing it again (#4604), until [`SETUP_GATE_CAP`]. The setup lines run in
/// milliseconds once the prompt is up, so silence this long means the shell
/// never received them. Every setup line is idempotent, so a second copy is
/// harmless.
pub const SETUP_GATE_RETYPE: Duration = Duration::from_secs(3);

/// How a held-back setup proves it has run ([`SetupGate`], #4604).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupDone {
    /// The setup includes the shell-integration line, whose prompt prints the
    /// OSC 133 prompt-start mark: the first mark after the setup was typed
    /// means every setup line (typed before it) has run.
    PromptMark,
    /// No integration line: the setup has run once the shell answered it (the
    /// echo and the next prompt) and then went quiet for [`SETUP_GATE_SETTLE`].
    OutputSettled,
}

/// The gate's phase.
#[derive(Debug)]
enum Phase {
    /// Every write passes straight through.
    Open,
    /// Waiting for the shell's first prompt; nothing has been typed yet.
    AwaitPrompt {
        deadline: Instant,
        last_output: Option<Instant>,
    },
    /// The setup has been typed; the user's input waits until it has run.
    AwaitSetup {
        deadline: Instant,
        retype_at: Instant,
        last_output: Option<Instant>,
        marks: PromptMarkDetector,
    },
}

/// Sequences a PowerShell session's typed setup against the shell's startup
/// and the user's input (#4148, #4604).
///
/// Two races it closes:
///
/// - **Typed too early, the setup is mangled or lost.** On a Linux/macOS
///   PowerShell host the tty is still in cooked mode until PSReadLine owns it,
///   and its `ICRNL` turns the setup line's CR (Enter) into LF — a
///   continuation for PSReadLine (#4148). On a Windows host, input that arrives
///   while `powershell.exe` is still starting is sometimes dropped outright, so
///   the env setup never ran and the first command saw an empty variable
///   (#4604). So the setup is held until the first prompt is up — approximated
///   as: output has arrived and then stayed quiet for [`SETUP_GATE_SETTLE`] (a
///   login shell is idle exactly when it waits at its prompt), bounded by
///   [`SETUP_GATE_CAP`].
/// - **The user's input must run after the setup.** Releasing the setup does
///   not prove the shell ran it, so the user's input (typeahead, the first
///   command, a connection's initial command) stays held until the setup
///   reports back ([`SetupDone`]) — a readiness signal from the shell itself,
///   not a timer. Each time it does not report within [`SETUP_GATE_RETYPE`]
///   the setup is typed again; [`SETUP_GATE_CAP`] bounds the wait.
///
/// Held user input is released in its original order, after the setup.
#[derive(Debug)]
pub struct SetupGate {
    phase: Phase,
    done: SetupDone,
    /// The setup writes, in order — kept to type them (again).
    setup: Vec<Vec<u8>>,
    /// The user's writes held so far, in order.
    held: Vec<Vec<u8>>,
}

impl SetupGate {
    /// A gate that holds when `hold` is set (see [`defers_setup_until_prompt`])
    /// and is open — passing every write straight through — otherwise. `done`
    /// says how the setup reports that it has run.
    pub fn new(hold: bool, done: SetupDone, now: Instant) -> Self {
        let phase = if hold {
            Phase::AwaitPrompt {
                deadline: now + SETUP_GATE_CAP,
                last_output: None,
            }
        } else {
            Phase::Open
        };
        Self {
            phase,
            done,
            setup: Vec::new(),
            held: Vec::new(),
        }
    }

    /// Whether anything is still being held back.
    pub fn is_holding(&self) -> bool {
        !matches!(self.phase, Phase::Open)
    }

    /// Add a setup line: held until the first prompt, or handed back to be
    /// sent right away when the gate is open. Setup is only added before the
    /// session's first write.
    pub fn setup(&mut self, data: Vec<u8>) -> Option<Vec<u8>> {
        match self.phase {
            Phase::Open => Some(data),
            _ => {
                self.setup.push(data);
                None
            }
        }
    }

    /// Queue the user's `data` while holding, or hand it back to be sent now.
    pub fn write(&mut self, data: Vec<u8>) -> Option<Vec<u8>> {
        match self.phase {
            Phase::Open => Some(data),
            _ => {
                self.held.push(data);
                None
            }
        }
    }

    /// Note that the shell printed `data` at `now`.
    pub fn on_output(&mut self, now: Instant, data: &[u8]) {
        match &mut self.phase {
            Phase::Open => {}
            Phase::AwaitPrompt { last_output, .. } => *last_output = Some(now),
            Phase::AwaitSetup {
                last_output, marks, ..
            } => {
                *last_output = Some(now);
                if marks.feed(data) && self.done == SetupDone::PromptMark {
                    // The setup's own prompt is up: it has run.
                    self.phase = Phase::Open;
                }
            }
        }
    }

    /// When the gate should next be polled, while holding.
    pub fn next_check(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Open => None,
            Phase::AwaitPrompt {
                deadline,
                last_output,
            } => Some(match last_output {
                Some(last) => (*last + SETUP_GATE_SETTLE).min(*deadline),
                None => *deadline,
            }),
            Phase::AwaitSetup {
                deadline,
                retype_at,
                last_output,
                ..
            } => {
                let mut due = (*deadline).min(*retype_at);
                if let (SetupDone::OutputSettled, Some(last)) = (self.done, last_output) {
                    due = due.min(*last + SETUP_GATE_SETTLE);
                }
                Some(due)
            }
        }
    }

    /// The writes to send now, in order — empty while nothing is due. Moves
    /// the gate on: the first prompt is up (type the setup), the setup has not
    /// reported back (type it again), or the setup has run or the cap passed
    /// (open, releasing the user's held input).
    pub fn poll(&mut self, now: Instant) -> Vec<Vec<u8>> {
        let Some(due) = self.next_check() else {
            // Open — possibly just opened by a prompt mark in `on_output`.
            return std::mem::take(&mut self.held);
        };
        if now < due {
            return Vec::new();
        }
        match &mut self.phase {
            Phase::Open => std::mem::take(&mut self.held),
            Phase::AwaitPrompt { .. } => {
                if self.setup.is_empty() {
                    self.phase = Phase::Open;
                    return std::mem::take(&mut self.held);
                }
                self.phase = Phase::AwaitSetup {
                    deadline: now + SETUP_GATE_CAP,
                    retype_at: now + SETUP_GATE_RETYPE,
                    last_output: None,
                    marks: PromptMarkDetector::new(),
                };
                self.setup.clone()
            }
            Phase::AwaitSetup {
                deadline,
                retype_at,
                last_output,
                ..
            } => {
                let settled = self.done == SetupDone::OutputSettled
                    && last_output.is_some_and(|last| now >= last + SETUP_GATE_SETTLE);
                if settled || now >= *deadline {
                    if !settled {
                        warn!("the session setup did not report back; releasing input anyway");
                    }
                    self.phase = Phase::Open;
                    return std::mem::take(&mut self.held);
                }
                // The retype is due: the shell has not answered the setup.
                *retype_at = now + SETUP_GATE_RETYPE;
                *last_output = None;
                debug!("the session setup did not report back; typing it again");
                self.setup.clone()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_posix_output() {
        assert_eq!(
            classify_shell_probe("termihub_shell_probe %OS% termihub_shell_probe_end\n"),
            RemoteShell::Posix
        );
    }

    #[test]
    fn classifies_windows_powershell_output_one_argument_per_line() {
        let out =
            "termihub_shell_probe\r\n%OS%\r\nC:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n\
                   termihub_shell_probe_end\r\n";
        assert_eq!(classify_shell_probe(out), RemoteShell::PowerShell);
    }

    #[test]
    fn classifies_pwsh_with_a_spaced_home_and_on_linux() {
        let win = "termihub_shell_probe\n%OS%\nC:\\Program Files\\PowerShell\\7\n\
                   termihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(win), RemoteShell::PowerShell);
        let linux = "termihub_shell_probe\n%OS%\n/opt/microsoft/powershell/7\n\
                     termihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(linux), RemoteShell::UnixPowerShell);
        let mac = "termihub_shell_probe\n%OS%\n/usr/local/microsoft/powershell/7\n\
                   termihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(mac), RemoteShell::UnixPowerShell);
    }

    #[test]
    fn classifies_cmd_output() {
        assert_eq!(
            classify_shell_probe(
                "termihub_shell_probe Windows_NT $PSHOME termihub_shell_probe_end\r\n"
            ),
            RemoteShell::Cmd
        );
    }

    #[test]
    fn ignores_noise_around_the_markers() {
        let out = "Welcome to host!\nlast login: today\n\
                   termihub_shell_probe %OS% termihub_shell_probe_end\nbye\n";
        assert_eq!(classify_shell_probe(out), RemoteShell::Posix);
    }

    #[test]
    fn unrecognised_output_is_unknown() {
        for out in [
            "",
            "PSHOME: Undefined variable.",
            "termihub_shell_probe %OS%",
            "termihub_shell_probe_end",
            "termihub_shell_probe termihub_shell_probe_end",
            "termihub_shell_probe Linux $PSHOME termihub_shell_probe_end",
            "termihub_shell_probe Windows_NT termihub_shell_probe_end",
        ] {
            assert_eq!(classify_shell_probe(out), RemoteShell::Unknown, "{out:?}");
        }
    }

    #[test]
    fn probe_command_avoids_quotes_and_pipes() {
        // powershell.exe -c strips quotes; an exposed `|` would then pipe.
        for c in ['"', '\'', '|', '&', ';', '<', '>'] {
            assert!(!SHELL_PROBE_COMMAND.contains(c), "probe contains {c:?}");
        }
        assert!(SHELL_PROBE_COMMAND.contains(SHELL_PROBE_START));
        assert!(SHELL_PROBE_COMMAND.contains(SHELL_PROBE_END));
    }

    #[test]
    fn posix_setup_is_the_bash_hook_ended_with_lf() {
        let line = integration_setup_line(RemoteShell::Posix).expect("posix setup");
        assert_eq!(line, format!("{}\n", osc7_setup_command("bash").unwrap()));
        // Byte-identical to the pre-detection injection.
        assert_eq!(osc7_setup_command("bash"), osc7_setup_command("ssh"));
    }

    #[test]
    fn powershell_setup_is_the_powershell_hook_ended_with_cr() {
        let line = integration_setup_line(RemoteShell::PowerShell).expect("powershell setup");
        assert_eq!(
            line,
            format!("{}\r", osc7_setup_command("powershell").unwrap())
        );
        assert!(line.ends_with('\r'));
        // One line: an embedded LF would be a PSReadLine continuation.
        assert!(!line.contains('\n'));
        assert!(line.contains("]7;file://"));
    }

    #[test]
    fn cmd_and_unknown_get_no_setup() {
        assert_eq!(integration_setup_line(RemoteShell::Cmd), None);
        assert_eq!(integration_setup_line(RemoteShell::Unknown), None);
    }

    // ── Env-var fallback per shell (#4147) ──────────────────────────────

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    const ALL_SHELLS: [RemoteShell; 5] = [
        RemoteShell::Posix,
        RemoteShell::PowerShell,
        RemoteShell::UnixPowerShell,
        RemoteShell::Cmd,
        RemoteShell::Unknown,
    ];

    #[test]
    fn env_line_is_none_when_empty_for_every_shell() {
        for shell in ALL_SHELLS {
            assert_eq!(env_setup_line(shell, &HashMap::new()), None, "{shell:?}");
        }
    }

    #[test]
    fn posix_env_line_is_unchanged() {
        let e = env(&[("ZED", "1"), ("ALPHA", "2")]);
        assert_eq!(
            env_setup_line(RemoteShell::Posix, &e).as_deref(),
            Some("export ALPHA='2' ZED='1'\n")
        );
        // Single quotes keep spaces, `$` and backticks literal; `'` is `'\''`.
        let e = env(&[("MSG", "it's $HOME and `id`")]);
        assert_eq!(
            env_setup_line(RemoteShell::Posix, &e).as_deref(),
            Some("export MSG='it'\\''s $HOME and `id`'\n")
        );
    }

    #[test]
    fn powershell_env_line_uses_verbatim_strings_ended_with_cr() {
        for shell in [RemoteShell::PowerShell, RemoteShell::UnixPowerShell] {
            let e = env(&[("ZED", "1"), ("ALPHA", "C:\\Program Files")]);
            assert_eq!(
                env_setup_line(shell, &e).as_deref(),
                Some("$env:ALPHA='C:\\Program Files'; $env:ZED='1'\r")
            );
            // `$(...)`, `"`, backtick and `;` stay literal inside '...'.
            let e = env(&[("X", "a\"$(Remove-Item ~)`;b")]);
            assert_eq!(
                env_setup_line(shell, &e).as_deref(),
                Some("$env:X='a\"$(Remove-Item ~)`;b'\r")
            );
        }
    }

    #[test]
    fn powershell_env_line_doubles_every_single_quote_kind() {
        // PowerShell ends a '...' string at any of ' ‘ ’ ‚ ‛, so each is doubled.
        let e = env(&[("X", "a'b\u{2018}c\u{2019}d\u{201A}e\u{201B}f")]);
        assert_eq!(
            env_setup_line(RemoteShell::PowerShell, &e).as_deref(),
            Some(
                "$env:X='a''b\u{2018}\u{2018}c\u{2019}\u{2019}d\u{201A}\u{201A}e\u{201B}\u{201B}f'\r"
            )
        );
        // A value trying to close the string and run a command stays a value.
        let e = env(&[("X", "'; Remove-Item -Recurse ~; '")]);
        assert_eq!(
            env_setup_line(RemoteShell::UnixPowerShell, &e).as_deref(),
            Some("$env:X='''; Remove-Item -Recurse ~; '''\r")
        );
    }

    /// Model PowerShell's verbatim-string scan: a quote character ends the
    /// string unless the next one is a quote too, which makes it literal.
    fn powershell_unquote(q: &str) -> Option<String> {
        let is_q = |c: char| matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}');
        let mut chars = q.chars().peekable();
        if !is_q(chars.next()?) {
            return None;
        }
        let mut out = String::new();
        while let Some(c) = chars.next() {
            if !is_q(c) {
                out.push(c);
                continue;
            }
            match chars.peek() {
                Some(&n) if is_q(n) => {
                    chars.next();
                    out.push(n);
                }
                // The closing quote must be the very last character.
                _ => return chars.next().is_none().then_some(out),
            }
        }
        None
    }

    #[test]
    fn powershell_quote_round_trips_through_the_tokenizer_rules() {
        for v in [
            "",
            "plain",
            "'",
            "''",
            "a'b",
            "\u{2019}x\u{2018}",
            "'; evil; '",
            "x\u{201B}",
        ] {
            assert_eq!(
                powershell_unquote(&powershell_quote(v)).as_deref(),
                Some(v),
                "{v:?}"
            );
        }
    }

    /// Model POSIX single-quote parsing of a sequence of '...' and \' parts.
    fn posix_unquote(q: &str) -> Option<String> {
        let mut out = String::new();
        let mut chars = q.chars();
        loop {
            match chars.next() {
                None => return Some(out),
                Some('\'') => loop {
                    match chars.next()? {
                        '\'' => break,
                        c => out.push(c),
                    }
                },
                Some('\\') => out.push(chars.next()?),
                Some(_) => return None,
            }
        }
    }

    #[test]
    fn posix_quote_round_trips() {
        for v in ["", "a b", "'", "it's", "'\\''", "$(id)`x`;|&"] {
            assert_eq!(posix_unquote(&posix_quote(v)).as_deref(), Some(v), "{v:?}");
        }
    }

    #[test]
    fn cmd_env_line_uses_quoted_set_and_skips_unsafe_values() {
        let e = env(&[("B", "x & del *"), ("A", "1 | 2 (3) <4> ^5")]);
        assert_eq!(
            env_setup_line(RemoteShell::Cmd, &e).as_deref(),
            Some("set \"A=1 | 2 (3) <4> ^5\" & set \"B=x & del *\"\r")
        );
        // `"` would close the quoting, `%`/`!` expand: those values are skipped.
        let e = env(&[
            ("OK", "fine"),
            ("Q", "a\" & calc & \""),
            ("P", "%PATH%"),
            ("E", "!x!"),
        ]);
        assert_eq!(
            env_setup_line(RemoteShell::Cmd, &e).as_deref(),
            Some("set \"OK=fine\"\r")
        );
        assert_eq!(
            env_setup_line(RemoteShell::Cmd, &env(&[("P", "50%")])),
            None
        );
    }

    #[test]
    fn unknown_shell_gets_no_env_line() {
        assert_eq!(
            env_setup_line(RemoteShell::Unknown, &env(&[("A", "1")])),
            None
        );
    }

    #[test]
    fn hostile_names_are_skipped_in_every_shell() {
        for shell in ALL_SHELLS {
            for name in ["A;id", "A B", "1A", "A=B", "$A", "A`B", "", "A-B", "Ä"] {
                let e = env(&[(name, "v")]);
                assert_eq!(env_setup_line(shell, &e), None, "{shell:?} {name:?}");
            }
            // A safe name next to a hostile one still gets through.
            let e = env(&[("A;rm -rf ~", "v"), ("_OK9", "v")]);
            let line = env_setup_line(shell, &e);
            if shell != RemoteShell::Unknown {
                let line = line.expect("the safe name");
                assert!(line.contains("_OK9"), "{shell:?}: {line:?}");
                assert!(!line.contains("rm -rf"), "{shell:?}: {line:?}");
            }
        }
    }

    #[test]
    fn control_characters_in_values_are_never_typed() {
        // ^U erases the typed line, CR/LF submit it, ^C interrupts, Tab
        // completes, ESC starts a key sequence — each could turn the rest of
        // the value into a command, whatever the quoting.
        for shell in ALL_SHELLS {
            for value in [
                "x\u{15}rm -rf ~\n",
                "a\nb",
                "a\rb",
                "a\u{3}b",
                "a\tb",
                "a\u{1b}[200~b",
                "a\u{7f}b",
                "a\u{9b}b",
            ] {
                let e = env(&[("A", value)]);
                assert_eq!(env_setup_line(shell, &e), None, "{shell:?} {value:?}");
            }
        }
    }

    #[test]
    fn every_env_line_is_one_line_ended_by_the_shells_enter() {
        let e = env(&[("A", "1"), ("B", "two words")]);
        for shell in ALL_SHELLS {
            let Some(line) = env_setup_line(shell, &e) else {
                assert_eq!(shell, RemoteShell::Unknown);
                continue;
            };
            let eol = line_ending(shell).unwrap();
            assert!(line.ends_with(eol), "{shell:?}: {line:?}");
            let body = &line[..line.len() - eol.len()];
            assert!(!body.contains(['\r', '\n']), "{shell:?}: {line:?}");
            // No POSIX syntax (nor its LF) may reach a non-POSIX shell.
            if shell != RemoteShell::Posix {
                assert!(!line.contains("export"), "{shell:?}: {line:?}");
                assert!(!line.contains('\n'), "{shell:?}: {line:?}");
            }
        }
    }

    // ── X11 lines per shell (#4147) ─────────────────────────────────────

    const COOKIE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn posix_x11_lines_are_unchanged() {
        assert_eq!(
            x11_setup_lines(RemoteShell::Posix, 10, Some(COOKIE)),
            vec![
                "export DISPLAY=localhost:10.0\n".to_string(),
                format!("xauth add localhost:10 MIT-MAGIC-COOKIE-1 {COOKIE} 2>/dev/null\n"),
            ]
        );
        assert_eq!(
            x11_setup_lines(RemoteShell::Posix, 11, None),
            vec!["export DISPLAY=localhost:11.0\n".to_string()]
        );
    }

    #[test]
    fn unix_powershell_x11_sets_display_and_guards_xauth() {
        assert_eq!(
            x11_setup_lines(RemoteShell::UnixPowerShell, 10, Some(COOKIE)),
            vec![
                "$env:DISPLAY='localhost:10.0'\r".to_string(),
                format!(
                    "if(Get-Command xauth -ErrorAction Ignore){{xauth add localhost:10 \
                     MIT-MAGIC-COOKIE-1 {COOKIE} 2>$null}}\r"
                ),
            ]
        );
    }

    #[test]
    fn windows_shells_get_display_only_no_xauth() {
        assert_eq!(
            x11_setup_lines(RemoteShell::PowerShell, 10, Some(COOKIE)),
            vec!["$env:DISPLAY='localhost:10.0'\r".to_string()]
        );
        assert_eq!(
            x11_setup_lines(RemoteShell::Cmd, 10, Some(COOKIE)),
            vec!["set \"DISPLAY=localhost:10.0\"\r".to_string()]
        );
    }

    #[test]
    fn unknown_shell_gets_no_x11_lines() {
        assert!(x11_setup_lines(RemoteShell::Unknown, 10, Some(COOKIE)).is_empty());
    }

    #[test]
    fn a_non_hex_cookie_is_never_typed() {
        for shell in [RemoteShell::Posix, RemoteShell::UnixPowerShell] {
            for cookie in ["", "ab; rm -rf ~", "abc\n", "zz"] {
                let lines = x11_setup_lines(shell, 10, Some(cookie));
                assert_eq!(lines.len(), 1, "{shell:?} {cookie:?}: {lines:?}");
                assert!(lines[0].contains("DISPLAY"));
            }
        }
    }

    // ── Line endings + deferral (#4148) ────────────────────────────────

    #[test]
    fn line_endings_per_shell() {
        assert_eq!(line_ending(RemoteShell::Posix), Some("\n"));
        assert_eq!(line_ending(RemoteShell::PowerShell), Some("\r"));
        assert_eq!(line_ending(RemoteShell::UnixPowerShell), Some("\r"));
        assert_eq!(line_ending(RemoteShell::Cmd), Some("\r"));
        assert_eq!(line_ending(RemoteShell::Unknown), None);
    }

    #[test]
    fn every_powershell_defers_its_setup() {
        for shell in ALL_SHELLS {
            assert_eq!(
                defers_setup_until_prompt(shell),
                matches!(shell, RemoteShell::PowerShell | RemoteShell::UnixPowerShell),
                "{shell:?}"
            );
        }
    }

    #[test]
    fn unix_powershell_gets_the_powershell_integration_line() {
        assert_eq!(
            integration_setup_line(RemoteShell::UnixPowerShell),
            integration_setup_line(RemoteShell::PowerShell)
        );
    }

    /// The prompt the integration line installs prints this first (#4345).
    const MARKED_PROMPT: &[u8] =
        b"\x1b]133;D;0\x07\x1b]7;file://H/C:/x\x07\x1b]133;A\x07PS C:\\x> ";

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// Feed the gate one output chunk at `at`, then poll it there.
    fn output(gate: &mut SetupGate, at: Instant, data: &[u8]) -> Vec<Vec<u8>> {
        gate.on_output(at, data);
        gate.poll(at)
    }

    #[test]
    fn open_gate_passes_writes_through() {
        let now = Instant::now();
        let mut gate = SetupGate::new(false, SetupDone::PromptMark, now);
        assert!(!gate.is_holding());
        assert_eq!(gate.setup(b"env".to_vec()), Some(b"env".to_vec()));
        assert_eq!(gate.write(b"x".to_vec()), Some(b"x".to_vec()));
        assert_eq!(gate.next_check(), None);
        assert!(gate.poll(now + SETUP_GATE_CAP * 2).is_empty());
    }

    /// #4604: the Windows PowerShell race. The env + integration setup and the
    /// user's first command are all written while `powershell.exe` is still
    /// starting. Nothing may reach the shell before its first prompt, and the
    /// first command only after the setup's own prompt mark — in that order.
    #[test]
    fn first_command_waits_for_the_setups_prompt_mark() {
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::PromptMark, t0);
        assert_eq!(gate.setup(b"$env:V='x'\r".to_vec()), None);
        assert_eq!(gate.setup(b"<integration>\r".to_vec()), None);
        assert_eq!(gate.write(b"'FIRST-' + $env:V\r".to_vec()), None);
        assert_eq!(gate.next_check(), Some(t0 + SETUP_GATE_CAP));

        // The banner prints; the shell is still loading.
        assert!(output(&mut gate, t0 + ms(400), b"Windows PowerShell\r\n").is_empty());
        assert!(gate.poll(t0 + ms(600)).is_empty());
        // The plain first prompt, then quiet: the setup — only — is typed.
        assert!(output(&mut gate, t0 + ms(650), b"PS C:\\x> ").is_empty());
        let typed = gate.poll(t0 + ms(650) + SETUP_GATE_SETTLE);
        assert_eq!(
            typed,
            vec![b"$env:V='x'\r".to_vec(), b"<integration>\r".to_vec()]
        );
        assert!(gate.is_holding(), "the first command still waits");

        // The setup's echo and quiet do not release the first command…
        let t1 = t0 + ms(650) + SETUP_GATE_SETTLE;
        assert!(output(&mut gate, t1 + ms(20), b"$env:V='x'\r\n").is_empty());
        assert!(gate.poll(t1 + ms(20) + SETUP_GATE_SETTLE * 2).is_empty());
        // …more typeahead queues behind it…
        assert_eq!(gate.write(b"ls\r".to_vec()), None);
        // …and the integration prompt's mark does, in order.
        assert_eq!(
            output(&mut gate, t1 + ms(900), MARKED_PROMPT),
            vec![b"'FIRST-' + $env:V\r".to_vec(), b"ls\r".to_vec()]
        );
        assert!(!gate.is_holding());
        assert_eq!(gate.write(b"pwd\r".to_vec()), Some(b"pwd\r".to_vec()));
    }

    #[test]
    fn a_prompt_mark_before_the_setup_is_typed_does_not_count() {
        // A profile prompt that prints its own OSC 133 (oh-my-posh) proves
        // the shell is up, not that the setup ran.
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::PromptMark, t0);
        gate.setup(b"setup\r".to_vec());
        gate.write(b"first\r".to_vec());
        assert!(output(&mut gate, t0 + ms(100), MARKED_PROMPT).is_empty());
        assert_eq!(
            gate.poll(t0 + ms(100) + SETUP_GATE_SETTLE),
            vec![b"setup\r".to_vec()]
        );
        assert!(gate.is_holding());
    }

    #[test]
    fn a_mark_split_over_chunks_releases_the_input() {
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::PromptMark, t0);
        gate.setup(b"setup\r".to_vec());
        gate.write(b"first\r".to_vec());
        output(&mut gate, t0, b"PS> ");
        let t1 = t0 + SETUP_GATE_SETTLE;
        assert_eq!(gate.poll(t1), vec![b"setup\r".to_vec()]);
        assert!(output(&mut gate, t1 + ms(5), b"\x1b]13").is_empty());
        assert_eq!(
            output(&mut gate, t1 + ms(6), b"3;A\x07PS> "),
            vec![b"first\r".to_vec()]
        );
    }

    #[test]
    fn a_setup_the_shell_never_answered_is_typed_again() {
        // #4604: the starting shell dropped the first copy (no echo, no mark).
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::PromptMark, t0);
        gate.setup(b"setup\r".to_vec());
        gate.write(b"first\r".to_vec());
        output(&mut gate, t0, b"PS> ");
        let t1 = t0 + SETUP_GATE_SETTLE;
        assert_eq!(gate.poll(t1), vec![b"setup\r".to_vec()]);
        assert_eq!(gate.next_check(), Some(t1 + SETUP_GATE_RETYPE));
        assert!(gate.poll(t1 + SETUP_GATE_RETYPE - ms(1)).is_empty());
        assert_eq!(
            gate.poll(t1 + SETUP_GATE_RETYPE),
            vec![b"setup\r".to_vec()],
            "the setup is typed again, still ahead of the first command"
        );
        // Again after another silent stretch, but never past the cap.
        assert_eq!(gate.next_check(), Some(t1 + SETUP_GATE_RETYPE * 2));
        assert_eq!(
            output(&mut gate, t1 + SETUP_GATE_RETYPE + ms(50), MARKED_PROMPT),
            vec![b"first\r".to_vec()]
        );
    }

    #[test]
    fn without_integration_the_setups_answer_settling_releases_the_input() {
        // Env only (integration off): no mark to wait for, so the shell's
        // answer to the setup — its echo and next prompt — then quiet.
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::OutputSettled, t0);
        gate.setup(b"env\r".to_vec());
        gate.write(b"first\r".to_vec());
        output(&mut gate, t0, b"PS> ");
        let t1 = t0 + SETUP_GATE_SETTLE;
        assert_eq!(gate.poll(t1), vec![b"env\r".to_vec()]);
        // Typed but not yet answered: still holding.
        assert!(gate.poll(t1 + SETUP_GATE_SETTLE * 2).is_empty());
        let answered = t1 + ms(40);
        assert!(output(&mut gate, answered, b"env\r\nPS> ").is_empty());
        assert!(gate.poll(answered + SETUP_GATE_SETTLE - ms(1)).is_empty());
        assert_eq!(
            gate.poll(answered + SETUP_GATE_SETTLE),
            vec![b"first\r".to_vec()]
        );
        assert!(!gate.is_holding());
    }

    #[test]
    fn both_waits_are_capped_for_a_silent_or_chatty_shell() {
        let t0 = Instant::now();
        let mut silent = SetupGate::new(true, SetupDone::PromptMark, t0);
        silent.setup(b"a".to_vec());
        silent.write(b"user".to_vec());
        assert_eq!(silent.poll(t0 + SETUP_GATE_CAP), vec![b"a".to_vec()]);
        let t1 = t0 + SETUP_GATE_CAP;
        assert_eq!(silent.poll(t1 + SETUP_GATE_RETYPE), vec![b"a".to_vec()]);
        assert_eq!(silent.poll(t1 + SETUP_GATE_RETYPE * 2), vec![b"a".to_vec()]);
        assert_eq!(silent.poll(t1 + SETUP_GATE_CAP), vec![b"user".to_vec()]);
        assert!(!silent.is_holding());

        let mut chatty = SetupGate::new(true, SetupDone::PromptMark, t0);
        chatty.setup(b"b".to_vec());
        let mut t = t0;
        while t < t0 + SETUP_GATE_CAP {
            chatty.on_output(t, b"noise");
            assert!(chatty.next_check().unwrap() <= t0 + SETUP_GATE_CAP);
            t += ms(100);
        }
        assert_eq!(chatty.poll(t0 + SETUP_GATE_CAP), vec![b"b".to_vec()]);
    }

    #[test]
    fn a_holding_gate_without_setup_opens_at_the_first_prompt() {
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::OutputSettled, t0);
        gate.write(b"first\r".to_vec());
        output(&mut gate, t0, b"PS> ");
        assert_eq!(gate.poll(t0 + SETUP_GATE_SETTLE), vec![b"first\r".to_vec()]);
        assert!(!gate.is_holding());
    }
}
