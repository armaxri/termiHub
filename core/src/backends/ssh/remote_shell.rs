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
//! A PowerShell login shell on Linux/macOS needs one more thing (#4148): its
//! setup is held back until the first prompt has printed ([`SetupGate`]).
//! Typed earlier, it lands in the tty while it is still in cooked mode, whose
//! `ICRNL` turns the CR into LF — a continuation for PSReadLine, which then
//! merges the user's first command into the setup line.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tracing::{debug, warn};

use super::exec::ssh_exec_with_stdin_timeout;
use super::handler::SshSession;
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
///   the line unsubmitted and merge it with the user's first command). On a
///   Unix host the connector holds it back until the first prompt
///   ([`SetupGate`]), so the tty no longer maps that CR to LF.
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

/// Whether the setup lines for `shell` must wait for its first prompt (see
/// [`SetupGate`]): only a PowerShell login shell on Linux/macOS (#4148). On
/// Windows, ConPTY delivers the CR as Enter whenever it arrives, and POSIX
/// shells read the LF-ended lines fine from the cooked tty.
pub fn defers_setup_until_prompt(shell: RemoteShell) -> bool {
    shell == RemoteShell::UnixPowerShell
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
pub fn x11_setup_lines(shell: RemoteShell, display: u32, cookie: Option<&str>) -> Vec<String> {
    let Some(eol) = line_ending(shell) else {
        warn!(
            display,
            "remote shell not detected; not typing the X11 DISPLAY / xauth setup"
        );
        return Vec::new();
    };
    let cookie = cookie.filter(|c| {
        let ok = !c.is_empty() && c.chars().all(|ch| ch.is_ascii_hexdigit());
        if !ok {
            warn!(display, "X11 cookie is not hex; not typing the xauth line");
        }
        ok
    });
    let mut lines = Vec::new();
    match shell {
        RemoteShell::Posix => {
            lines.push(format!("export DISPLAY=localhost:{display}.0{eol}"));
            if let Some(cookie) = cookie {
                lines.push(format!(
                    "xauth add localhost:{display} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null{eol}"
                ));
            }
        }
        RemoteShell::UnixPowerShell => {
            lines.push(format!("$env:DISPLAY='localhost:{display}.0'{eol}"));
            if let Some(cookie) = cookie {
                lines.push(format!(
                    "if(Get-Command xauth -ErrorAction Ignore){{xauth add localhost:{display} \
                     MIT-MAGIC-COOKIE-1 {cookie} 2>$null}}{eol}"
                ));
            }
        }
        RemoteShell::PowerShell | RemoteShell::Cmd => {
            lines.push(if shell == RemoteShell::Cmd {
                format!("set \"DISPLAY=localhost:{display}.0\"{eol}")
            } else {
                format!("$env:DISPLAY='localhost:{display}.0'{eol}")
            });
            if cookie.is_some() {
                debug!(display, "Windows host: no xauth, X11 cookie line skipped");
            }
        }
        RemoteShell::Unknown => {}
    }
    lines
}

/// How long the shell's output must stay quiet after it printed something
/// before a held-back setup is released ([`SetupGate`]).
pub const SETUP_GATE_SETTLE: Duration = Duration::from_millis(300);

/// Upper bound on holding the setup back, from the shell request on: a shell
/// that prints nothing (or never stops printing) still gets its setup.
pub const SETUP_GATE_CAP: Duration = Duration::from_secs(8);

/// Holds the session's typed input back until the remote shell's first prompt
/// has printed, for a PowerShell login shell on Linux/macOS (#4148).
///
/// Until PSReadLine owns the terminal the tty is in cooked mode, and its
/// `ICRNL` turns the setup line's CR (Enter) into LF on arrival — a
/// continuation for PSReadLine. Once the prompt is up the tty is raw and the
/// CR reaches PSReadLine as Enter. "Prompt is up" is approximated as: output
/// has arrived and then stayed quiet for [`SETUP_GATE_SETTLE`] (a login shell
/// is idle exactly when it waits at its prompt), bounded by
/// [`SETUP_GATE_CAP`].
///
/// Everything written while holding — the connector's own setup lines, the
/// shell-integration line and any typeahead — is released in its original
/// order, in one burst, so nothing can overtake the setup.
#[derive(Debug)]
pub struct SetupGate {
    /// `Some` while holding: the writes queued so far, in order.
    held: Option<Vec<Vec<u8>>>,
    deadline: Instant,
    last_output: Option<Instant>,
}

impl SetupGate {
    /// A gate that holds when `hold` is set (see [`defers_setup_until_prompt`])
    /// and is open — passing every write straight through — otherwise.
    pub fn new(hold: bool, now: Instant) -> Self {
        Self {
            held: hold.then(Vec::new),
            deadline: now + SETUP_GATE_CAP,
            last_output: None,
        }
    }

    /// Whether writes are still being held back.
    pub fn is_holding(&self) -> bool {
        self.held.is_some()
    }

    /// Queue `data` while holding, or hand it back to be sent right away.
    pub fn write(&mut self, data: Vec<u8>) -> Option<Vec<u8>> {
        match self.held.as_mut() {
            Some(held) => {
                held.push(data);
                None
            }
            None => Some(data),
        }
    }

    /// Note that the shell printed something at `now`.
    pub fn on_output(&mut self, now: Instant) {
        if self.held.is_some() {
            self.last_output = Some(now);
        }
    }

    /// When the gate should next be polled, while holding.
    pub fn next_check(&self) -> Option<Instant> {
        self.held.as_ref()?;
        Some(match self.last_output {
            Some(last) => (last + SETUP_GATE_SETTLE).min(self.deadline),
            None => self.deadline,
        })
    }

    /// Release the held writes (in order) once the prompt has settled or the
    /// cap has passed; `None` while still holding or when already open.
    pub fn poll(&mut self, now: Instant) -> Option<Vec<Vec<u8>>> {
        let due = self.next_check()?;
        if now >= due {
            self.held.take()
        } else {
            None
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
        assert_eq!(classify_shell_probe(linux), RemoteShell::PowerShell);
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
}
