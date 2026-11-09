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
//! The probe is a single `echo` whose output differs per shell family. The
//! words before the `termihub_shell_probe_os` separator name the shell:
//!
//! | Shell | `%OS%` | `$PSHOME` | `$FISH_VERSION` | Output before the separator |
//! | --- | --- | --- | --- | --- |
//! | POSIX (bash, zsh, sh, dash) | literal | nothing | nothing | `%OS%` |
//! | fish (#5016) | literal | nothing | fish's version | `%OS%` + a version |
//! | PowerShell (5 or 7, any OS) | literal | PowerShell's home | nothing | `%OS%` + a path |
//! | cmd.exe | `Windows_NT` | literal | literal | `Windows_NT $PSHOME $FISH_VERSION` |
//!
//! fish has to be told apart from the POSIX shells (#5016): the bash/zsh hook
//! is a parse error in fish, so it gets setup lines in its own syntax. A fish
//! version starts with a digit, which no `$PSHOME` path does.
//!
//! The words after the separator, `$OSTYPE $MSYSTEM $OS`, tell a POSIX shell
//! on a *Windows* host (#5015) — an OpenSSH `DefaultShell` set to Git Bash,
//! MSYS2 or Cygwin — from one on Linux/macOS: bash and zsh set `$OSTYPE` to
//! `msys` / `cygwin` there (`linux-gnu`, `darwin…` elsewhere), and MSYS2 / Git
//! Bash export `$MSYSTEM` (`MINGW64`, `UCRT64`, `MSYS`...), which covers a `sh`
//! / `dash` that has no `$OSTYPE`. Such a host is
//! [`RemoteShell::WindowsPosix`]: its output is rendered by the server's
//! ConPTY, so its setup echo is never filtered (see [`hides_setup_echo`]).
//! fish has no `$OSTYPE`, and a Cygwin fish no `$MSYSTEM` either; `$OS` is the
//! Windows system variable (`Windows_NT`) that every process on a Windows host
//! inherits, so it tells a fish there too (`RemoteShell::Fish { windows: true }`,
//! #5101). PowerShell expands all three to nothing (they are not its
//! variables; its own is `$env:OS`) and cmd.exe leaves them literal, so none
//! changes their classification. They sit after a separator because a Unix
//! `$OSTYPE` would otherwise read like a `$PSHOME`.
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
//! the setup has run ([`SetupGate`]). A cmd.exe host with env or X11 setup is
//! held the same way (#4610). Typed earlier on Linux/macOS, the setup
//! lands in the tty while it is still in cooked mode, whose `ICRNL` turns the
//! CR into LF — a continuation for PSReadLine, which then merges the user's
//! first command into the setup line. On Windows, input that arrives while
//! `powershell.exe` is still starting can be dropped, so the first command ran
//! without the configured environment.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tracing::{debug, warn};

use super::cmd_hook::{cmd_hook_line, cursor_column, join_cmd_setup};
use super::exec::{ssh_exec_with_stdin, SshExecOutput};
use super::handler::SshSession;
use crate::errors::CoreError;
use crate::output::prompt_mark::PromptMarkDetector;
use crate::output::setup_echo::SETUP_DONE_PRINTF;
use crate::session::shell::{fish_typed_setup_command, osc7_setup_command};

/// Opening marker of the probe's output.
pub const SHELL_PROBE_START: &str = "termihub_shell_probe";
/// Closing marker of the probe's output.
pub const SHELL_PROBE_END: &str = "termihub_shell_probe_end";
/// Separates the shell-family words of the probe's output from its
/// host-OS words, `$OSTYPE $MSYSTEM $OS` (#5015, #5101).
pub const SHELL_PROBE_OS: &str = "termihub_shell_probe_os";

/// The probe command run over an exec channel (see the module docs).
pub const SHELL_PROBE_COMMAND: &str = "echo termihub_shell_probe %OS% $PSHOME $FISH_VERSION \
     termihub_shell_probe_os $OSTYPE $MSYSTEM $OS termihub_shell_probe_end";

/// Upper bound on the probe (#4670).
///
/// The probe gates every typed setup line: a probe that gives up reports
/// [`RemoteShell::Unknown`], so the env-var fallback, the X11 lines and the
/// shell-integration line are all skipped and the user's first command runs
/// without the configured environment. So the bound must cover the slowest
/// *legitimate* answer, not a typical one: a cold Windows PowerShell start
/// (Win32-OpenSSH runs the probe through `powershell.exe -c`, which loads .NET
/// and the profile) took longer than the former 8 s on the CI host, and the
/// session then started with no setup at all (#4670). A heavy `.bashrc` (bash
/// sources it for sshd-run commands) is the POSIX twin.
///
/// Only a host whose exec channel stalls outright waits the full bound, and the
/// connector keeps the wait abortable by the connect's cancel token.
pub const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// The flavour of the remote login shell, as far as shell integration cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RemoteShell {
    /// A POSIX-style shell (bash, zsh, sh, dash, ...) on a Linux/macOS host.
    Posix,
    /// A POSIX-style shell on a Windows host (#5015): the OpenSSH
    /// `DefaultShell` is Git Bash, an MSYS2 shell or Cygwin's. Typed the same
    /// setup lines as [`RemoteShell::Posix`], but its setup echo is never
    /// filtered: Win32-OpenSSH renders the session through ConPTY, whose
    /// screen model must see every byte, so showing the setup is the safe
    /// fallback.
    WindowsPosix,
    /// fish (#5016): not POSIX, so it gets setup lines in its own syntax.
    Fish {
        /// fish 4.0+, which reports its directory (OSC 7) and marks its
        /// prompts and commands (OSC 133) by itself, so it is typed no
        /// shell-integration line at all.
        native_integration: bool,
        /// On a Windows host (#5101): an MSYS2 or Cygwin fish as the OpenSSH
        /// `DefaultShell`. Like [`RemoteShell::WindowsPosix`], its setup echo
        /// is never filtered (ConPTY must see every byte) and its directory is
        /// not read over an exec channel.
        windows: bool,
    },
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
    // Every answer to the current probe carries the separator (#5015).
    let Some(sep) = between.iter().position(|t| *t == SHELL_PROBE_OS) else {
        return RemoteShell::Unknown;
    };
    let (family, host_os) = (&between[..sep], &between[sep + 1..]);
    let on_windows = host_os.iter().any(|t| is_windows_host_os(t));
    match family {
        // `%OS%` untouched and `$PSHOME` expanded to nothing: a POSIX shell,
        // on Windows when `$OSTYPE` / `$MSYSTEM` say MSYS2 or Cygwin (#5015).
        ["%OS%"] if on_windows => RemoteShell::WindowsPosix,
        ["%OS%"] => RemoteShell::Posix,
        // `$FISH_VERSION` expanded to a version (`3.7.1`, `4.0.2`): fish
        // (#5016). Checked before PowerShell, whose home is never a number.
        ["%OS%", version] if version.starts_with(|c: char| c.is_ascii_digit()) => {
            RemoteShell::Fish {
                native_integration: fish_has_native_integration(version),
                windows: on_windows,
            }
        }
        // `%OS%` untouched and `$PSHOME` expanded to PowerShell's home: an
        // absolute POSIX path on Linux/macOS (#4148) ...
        ["%OS%", home, ..] if home.starts_with('/') => RemoteShell::UnixPowerShell,
        // ... a Windows path otherwise (which may contain spaces, e.g.
        // `C:\Program Files\PowerShell\7`).
        ["%OS%", _, ..] => RemoteShell::PowerShell,
        // `%OS%` expanded (to `Windows_NT`) and `$PSHOME` left literal: cmd.exe.
        [os, "$PSHOME", "$FISH_VERSION"] if os.eq_ignore_ascii_case("Windows_NT") => {
            RemoteShell::Cmd
        }
        _ => RemoteShell::Unknown,
    }
}

/// Whether `word` (a value of `$OSTYPE`, `$MSYSTEM` or `$OS`) names a Windows
/// host: `msys` / `cygwin` (`$OSTYPE` of bash and zsh there, #5015), an MSYS2
/// environment (`MSYS`, `MINGW64`, `UCRT64`, `CLANG64`...) or `Windows_NT`
/// (the `$OS` every Windows process inherits, #5101). Unix values
/// (`linux-gnu`, `darwin23.0`, `freebsd14.0`...) never match.
fn is_windows_host_os(word: &str) -> bool {
    let word = word.to_ascii_lowercase();
    word == "windows_nt"
        || ["msys", "cygwin", "mingw", "ucrt", "clang"]
            .iter()
            .any(|prefix| word.starts_with(prefix))
}

/// Whether the fish `version` (`$FISH_VERSION`, e.g. `3.7.1`, `4.0b1`) is
/// 4.0 or later: the first release that emits OSC 7 and OSC 133 by itself.
fn fish_has_native_integration(version: &str) -> bool {
    let major: String = version.chars().take_while(char::is_ascii_digit).collect();
    major.parse::<u32>().is_ok_and(|major| major >= 4)
}

/// Probe the remote login shell over an exec channel on `session`.
///
/// Never fails: any error or timeout is reported as [`RemoteShell::Unknown`].
pub async fn detect_remote_shell(session: &SshSession) -> RemoteShell {
    await_shell_probe(
        ssh_exec_with_stdin(session, SHELL_PROBE_COMMAND, ""),
        SHELL_PROBE_TIMEOUT,
    )
    .await
}

/// Await a running shell probe for at most `timeout` and classify its answer.
///
/// Split from [`detect_remote_shell`] so the timing — the probe answering only
/// after a slow shell start (#4670) — is unit-testable without a server.
/// A failure is logged at `warn`: it means no setup line will be typed, so the
/// configured environment and shell integration silently do not apply.
pub async fn await_shell_probe<F>(probe: F, timeout: Duration) -> RemoteShell
where
    F: std::future::Future<Output = Result<SshExecOutput, CoreError>>,
{
    let started = Instant::now();
    let result = match tokio::time::timeout(timeout, probe).await {
        Ok(result) => result,
        Err(_) => Err(CoreError::Other(format!(
            "no answer within {}s",
            timeout.as_secs()
        ))),
    };
    let elapsed_ms = started.elapsed().as_millis();
    match result {
        Ok(output) => {
            let shell = classify_shell_probe(&output.stdout);
            debug!(
                ?shell,
                exit_status = output.exit_status,
                elapsed_ms,
                "Remote shell probe"
            );
            setup_trace(
                started,
                &format!("shell probe answered: {shell:?}"),
                output.stdout.as_bytes(),
            );
            if shell == RemoteShell::Unknown {
                warn!(
                    elapsed_ms,
                    "remote shell not recognised; no session setup (environment variables, \
                     X11 display, shell integration) will be typed"
                );
            }
            shell
        }
        Err(e) => {
            setup_trace(started, &format!("shell probe failed: {e}"), &[]);
            warn!(
                elapsed_ms,
                "remote shell probe failed ({e}); no session setup (environment variables, \
                 X11 display, shell integration) will be typed"
            );
            RemoteShell::Unknown
        }
    }
}

/// The PowerShell shell-integration hook as one typed statement, ended with
/// CR — without the echo erase that [`join_powershell_setup`] appends.
pub fn powershell_hook_line() -> Option<String> {
    osc7_setup_command("powershell").map(|s| format!("{s}\r"))
}

/// The statement ending a typed PowerShell setup (#5044): erases the rows the
/// first prompt and the setup's own echo occupy, `echo_len` characters in all.
///
/// A Windows host renders through ConPTY, so the echo cannot be filtered out
/// of the stream the way a POSIX host's is ([`hides_setup_echo`]); the shell
/// takes it off the screen itself instead. It used to `Clear-Host`, which
/// also wiped the login banner. This erases only from the prompt's row down:
///
/// - The prompt's column comes from PSReadLine's `_initialX` (where it began
///   reading the line), 0 when that cannot be read.
/// - The rows follow from it, the line's length and
///   `$Host.UI.RawUI.BufferSize.Width`.
/// - On Windows it moves the console cursor back and overwrites the rows with
///   blanks through the console API, so the console's own screen model — the
///   one ConPTY renders from — is what changes; nothing bypasses it. Elsewhere
///   (pwsh on Linux/macOS) it writes `CSI <n> A`, `CR`, `CSI J`.
///
/// Its own variables live in a script block's scope, and every error is
/// caught, so it leaves no state behind and `$?` stays true for the prompt.
pub fn powershell_erase_echo(echo_len: usize) -> String {
    format!(
        concat!(
            r#";&{{try{{$w=$Host.UI.RawUI.BufferSize.Width;$x=0;"#,
            r#"try{{$r='Microsoft.PowerShell.PSConsoleReadLine' -as [type];"#,
            r#"$x=[int]$r.GetField('_initialX','NonPublic,Instance').GetValue("#,
            r#"$r.GetField('_singleton','NonPublic,Static').GetValue($null))}}catch{{}};"#,
            r#"$n=[int][Math]::Floor(($x+{len}-1)/$w)+1;"#,
            r#"if($env:OS -eq 'Windows_NT'){{$y=[Console]::CursorTop;$n=[Math]::Min($n,$y);"#,
            r#"$t=$y-$n;[Console]::SetCursorPosition(0,$t);[Console]::Write(' '*($w*$n));"#,
            r#"[Console]::SetCursorPosition(0,$t)}}"#,
            r#"else{{[Console]::Write([char]27+'['+$n+'A'+[char]13+[char]27+'[J')}}"#,
            r#"}}catch{{}}}}"#,
        ),
        len = echo_len
    )
}

/// Join PowerShell setup lines (each CR-ended: the env fallback, X11, the
/// hook) into one typed line that ends with [`powershell_erase_echo`]
/// (#5044), so the one echo is erased — separate lines would leave the
/// earlier ones, env values included, on screen above a fresh prompt.
///
/// The erase needs the whole line's length, its own included, so that is
/// solved as a fixed point (the digits can only grow a few times).
pub fn join_powershell_setup(lines: &[String]) -> String {
    let body = lines
        .iter()
        .map(|l| l.trim_end_matches(['\r', '\n']).trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(";");
    let body_len = body.chars().count();
    let mut len = body_len + powershell_erase_echo(0).chars().count();
    loop {
        let erase = powershell_erase_echo(len);
        let total = body_len + erase.chars().count();
        if total == len {
            return format!("{body}{erase}\r");
        }
        len = total;
    }
}

/// Whether a typed PowerShell setup ends by erasing its own echo (#5044):
/// whenever the hook is typed into a PowerShell login shell (the opt-in
/// command-mark hook). Then every setup line is joined into one
/// ([`join_powershell_setup`]).
pub fn erases_setup_echo(shell: RemoteShell, has_integration: bool) -> bool {
    has_integration && matches!(shell, RemoteShell::PowerShell | RemoteShell::UnixPowerShell)
}

/// The shell-integration line to type into a session whose login shell is
/// `shell`, including its line terminator, or `None` to inject nothing.
///
/// - POSIX (on Linux/macOS or, #5015, Windows): the bash/zsh OSC 7 hook,
///   ended with LF — unchanged from before detection existed.
/// - PowerShell (Windows or Unix): the PowerShell OSC 7 / OSC 133 prompt
///   override, joined with [`join_powershell_setup`] so it ends by erasing
///   its own echo (#5044), ended with CR, which is Enter for PSReadLine (an
///   LF would leave the line unsubmitted and merge it with the user's first
///   command). The
///   connector holds it back until the first prompt ([`SetupGate`]), so a
///   Unix tty no longer maps that CR to LF and a starting Windows shell
///   cannot drop it.
/// - fish 3.x: the fish hook built to be typed (`fish_typed_setup_command`
///   in the shell module), ended with LF (#5016). The bash hook would be a
///   parse error there.
/// - fish 4.0+: nothing. It emits OSC 7 and OSC 133 itself. Its env and X11
///   lines are still typed — joined into one line that ends with the done
///   mark, so their echo is hidden like the rest ([`join_fish_setup`],
///   #5094).
/// - cmd.exe (#5109): the hook's `PROMPT` ([`cmd_hook_line`]), ended with
///   CR. The connector joins it with the other setup lines at the first
///   prompt ([`SetupGate::join_cmd_setup`]), so the one line erases its own
///   echo and is followed by Alt+F7, which takes it out of the console's
///   command history.
/// - Unknown shells: nothing.
pub fn integration_setup_line(shell: RemoteShell) -> Option<String> {
    match shell {
        RemoteShell::Posix | RemoteShell::WindowsPosix => {
            osc7_setup_command("bash").map(|s| format!("{s}\n"))
        }
        RemoteShell::Fish {
            native_integration: false,
            ..
        } => Some(format!("{}\n", fish_typed_setup_command())),
        RemoteShell::Fish {
            native_integration: true,
            ..
        } => None,
        RemoteShell::PowerShell | RemoteShell::UnixPowerShell => {
            powershell_hook_line().map(|l| join_powershell_setup(&[l]))
        }
        RemoteShell::Cmd => Some(cmd_hook_line()),
        RemoteShell::Unknown => None,
    }
}

/// The byte that submits a typed line in `shell`: LF for POSIX shells
/// (unchanged from before detection), CR — the Enter key — for PowerShell and
/// cmd.exe. `None` for an undetected shell, which gets no typed setup at all.
pub fn line_ending(shell: RemoteShell) -> Option<&'static str> {
    match shell {
        RemoteShell::Posix | RemoteShell::WindowsPosix | RemoteShell::Fish { .. } => Some("\n"),
        RemoteShell::PowerShell | RemoteShell::UnixPowerShell | RemoteShell::Cmd => Some("\r"),
        RemoteShell::Unknown => None,
    }
}

/// Whether the setup lines for `shell` must wait for its first prompt, and the
/// user's input for the setup (see [`SetupGate`]). `has_setup` says whether
/// any setup line (env fallback, X11, integration) will be typed at all.
///
/// - Every PowerShell login shell. On Linux/macOS the cooked tty turns the
///   setup's CR into LF until PSReadLine is up (#4148); on Windows input typed
///   while `powershell.exe` is still starting can be dropped, so the first
///   command ran without the configured environment (#4604).
/// - cmd.exe, when it has env or X11 setup to type (#4610): it starts under
///   the same Windows ConPTY, so the same early-input window applies to its
///   `set` line. It gets no integration line, so the gate waits for the
///   setup's answer to settle ([`SetupDone::OutputSettled`]). A cmd.exe host
///   with nothing to set up is left ungated, as before.
/// - POSIX shells never: they read the LF-ended lines fine from the cooked
///   tty, and their behaviour stays unchanged. A POSIX shell on Windows
///   (#5015) keeps that pre-#5009 behaviour too: ungated and unfiltered.
pub fn defers_setup_until_prompt(shell: RemoteShell, has_setup: bool) -> bool {
    match shell {
        RemoteShell::PowerShell | RemoteShell::UnixPowerShell => true,
        RemoteShell::Cmd => has_setup,
        RemoteShell::Posix
        | RemoteShell::WindowsPosix
        | RemoteShell::Fish { .. }
        | RemoteShell::Unknown => false,
    }
}

/// Whether the typed setup's echo is hidden for `shell` (#5009).
/// `has_integration` says whether the shell-integration line is typed,
/// `has_setup` whether any setup line (env fallback, X11, integration) is.
///
/// - A POSIX login shell: only with the integration line, whose setup-done
///   mark is what ends the hidden region (see
///   [`SetupEchoFilter`](crate::output::setup_echo::SetupEchoFilter)).
/// - A fish login shell (#5016, #5094): whenever anything is typed. The
///   joined fish line always ends with the setup-done mark
///   ([`join_fish_setup`]), so a fish 4 — which is typed no integration
///   line — gets its env and X11 lines hidden too. fish redraws its input
///   cell by cell, which the filter follows with a screen model
///   ([`SetupEchoFilter::set_cell_redraw`](crate::output::setup_echo::SetupEchoFilter::set_cell_redraw)).
///
/// Such a host is then also held until its first prompt, so the setup
/// reaches the line editor rather than the cooked tty, whose own echo would
/// come first.
///
/// Not PowerShell, cmd.exe, a POSIX shell on Windows
/// ([`RemoteShell::WindowsPosix`], #5015) or a fish there (#5101): a
/// Windows host renders through
/// ConPTY, whose screen model must see every byte, so there the setup is
/// shown rather than risk desynchronising it (a typed PowerShell setup
/// erases its own echo instead, [`powershell_erase_echo`]).
pub fn hides_setup_echo(shell: RemoteShell, has_integration: bool, has_setup: bool) -> bool {
    match shell {
        RemoteShell::Posix => has_integration,
        RemoteShell::Fish { windows: false, .. } => has_setup || has_integration,
        _ => false,
    }
}

/// Join POSIX (or fish) setup lines (each LF-ended) into one typed line, so
/// their echo is one contiguous region the filter can remove — separate lines
/// would put a prompt between the echoes (#5009). `; ` separates statements
/// in both syntaxes.
pub fn join_posix_setup(lines: &[String]) -> String {
    let statements: Vec<&str> = lines
        .iter()
        .map(|l| l.trim_end_matches('\n').trim())
        .filter(|l| !l.is_empty())
        .collect();
    // A leading space keeps the line (env values included) out of history
    // under `HISTCONTROL=ignorespace` / `HIST_IGNORE_SPACE`, and always in fish.
    format!(" {}\n", statements.join("; "))
}

/// Join fish setup lines into one typed line, as [`join_posix_setup`] does,
/// that always ends by printing the setup-done mark (#5094): the mark is
/// what ends the hidden region, and a fish 4 is typed no integration line
/// (which carries it otherwise). fish's builtin `printf` takes the same
/// `\e` / `\a` escapes as POSIX `printf`.
pub fn join_fish_setup(lines: &[String]) -> String {
    let joined = join_posix_setup(lines);
    let line = joined.trim_end_matches('\n');
    if line.ends_with(SETUP_DONE_PRINTF) {
        joined
    } else if line.trim().is_empty() {
        format!(" {SETUP_DONE_PRINTF}\n")
    } else {
        format!("{line}; {SETUP_DONE_PRINTF}\n")
    }
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

/// `value` as a fish single-quoted word (#5016). Inside fish's `'...'` a
/// backslash escapes `\` and `'` (unlike POSIX, where it is literal), so both
/// get one: `it's` becomes `'it\'s'`, `a\b` becomes `'a\\b'`.
fn fish_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
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
/// - fish: ` set -gx A '1'; set -gx B 'it\'s'` + LF (#5016) — fish's own
///   single quotes, in which `\` and `'` are backslash-escaped; the leading
///   space keeps the line out of fish's history.
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
            RemoteShell::Posix | RemoteShell::WindowsPosix => {
                Some(format!("{name}={}", posix_quote(value)))
            }
            RemoteShell::Fish { .. } => Some(format!("set -gx {name} {}", fish_quote(value))),
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
        RemoteShell::Posix | RemoteShell::WindowsPosix => {
            format!("export {}", statements.join(" "))
        }
        RemoteShell::Cmd => statements.join(" & "),
        // A leading space: fish never saves such a line to its history.
        RemoteShell::Fish { .. } => format!(" {}", statements.join("; ")),
        _ => statements.join("; "),
    };
    Some(format!("{line}{eol}"))
}

/// The lines that point X11 clients in the interactive shell at the forwarded
/// display `localhost:<display>.0` and register its `MIT-MAGIC-COOKIE-1`, each
/// ended with the shell's [`line_ending`].
///
/// - POSIX: `export DISPLAY=...` + `xauth add ... 2>/dev/null` — unchanged.
/// - fish: ` set -gx DISPLAY ...` + the same `xauth add` line, each with a
///   leading space that keeps it out of fish's history (#5016).
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
        // Git Bash / MSYS2 have no `xauth` as a rule; the `2>/dev/null`
        // silences "command not found" there (#5015).
        RemoteShell::Posix | RemoteShell::WindowsPosix => {
            lines.push(format!("export DISPLAY=localhost:{display_num}.0{eol}"));
            if let Some(cookie) = cookie {
                lines.push(format!(
                    "xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null{eol}"
                ));
            }
        }
        RemoteShell::Fish { .. } => {
            // Leading spaces keep both lines out of fish's history.
            lines.push(format!(" set -gx DISPLAY localhost:{display_num}.0{eol}"));
            if let Some(cookie) = cookie {
                lines.push(format!(
                    " xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null{eol}"
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

// ── Diagnostic trace of the setup sequence (#4670) ──────────────────────

/// Set by [`enable_setup_trace`] (the live Windows SSH-host test does).
static SETUP_TRACE: AtomicBool = AtomicBool::new(false);

/// Turn on the diagnostic trace of every byte the [`SetupGate`] sequence
/// types and receives (#4670). Off by default; also on when the environment
/// variable `TERMIHUB_TEST_SSH_TRACE=1` is set. **Test-only**: the trace
/// prints the typed setup verbatim, which embeds env values and the X11
/// cookie, so production code never calls this.
pub fn enable_setup_trace() {
    SETUP_TRACE.store(true, Ordering::Relaxed);
}

/// Whether the setup trace is on (an atomic load once the env is cached).
pub fn setup_trace_enabled() -> bool {
    static ENV: OnceLock<bool> = OnceLock::new();
    SETUP_TRACE.load(Ordering::Relaxed)
        || *ENV.get_or_init(|| std::env::var("TERMIHUB_TEST_SSH_TRACE").is_ok_and(|v| v == "1"))
}

/// Print one trace event — `ms` since the shell request, the event, and the
/// bytes involved, escaped — to stderr when the trace is on.
pub fn setup_trace(t0: Instant, event: &str, data: &[u8]) {
    if setup_trace_enabled() {
        eprintln!(
            "[ssh-setup-trace +{:>6}ms] {event} ({} B): {}",
            t0.elapsed().as_millis(),
            data.len(),
            data.escape_ascii()
        );
    }
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

/// Sequences a PowerShell (or cmd.exe, #4610) session's typed setup against
/// the shell's startup and the user's input (#4148, #4604).
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
    /// When the gate was created (the shell request), for the trace.
    started: Instant,
    /// Whether the terminal's answers to the shell's queries pass while
    /// holding ([`pass_terminal_replies`](Self::pass_terminal_replies)).
    pass_replies: bool,
    /// The terminal's width when the setup is joined into one cmd.exe line
    /// at the first prompt ([`join_cmd_setup`](Self::join_cmd_setup)).
    cmd_join: Option<u16>,
    /// The output before the first prompt settled, kept (up to
    /// [`CMD_PROMPT_OUTPUT_CAP`] bytes) to find the prompt's column.
    before_prompt: Vec<u8>,
}

/// How much output before the first prompt [`SetupGate::join_cmd_setup`]
/// keeps: the first prompt is near its end.
const CMD_PROMPT_OUTPUT_CAP: usize = 64 * 1024;

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
            started: now,
            pass_replies: false,
            cmd_join: None,
            before_prompt: Vec::new(),
        }
    }

    /// Join the setup lines into one cmd.exe line when they are typed, at a
    /// terminal `cols` wide (#5109): the first prompt's column, read from the
    /// output so far, says how many rows the line's echo will take, which the
    /// line then erases ([`join_cmd_setup`]).
    pub fn join_cmd_setup(&mut self, cols: u16) {
        self.cmd_join = Some(cols);
    }

    /// Let the terminal's answers to the shell's own queries through while
    /// holding (#5094). fish 4 asks for the Primary Device Attributes before
    /// its first prompt and reads nothing else until the answer comes;
    /// held, the answer and the setup waited for each other. Only a write
    /// that is nothing but such answers passes (see the `terminal_reply`
    /// module); the user's input stays held.
    pub fn pass_terminal_replies(&mut self, on: bool) {
        self.pass_replies = on;
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
            _ if self.pass_replies && super::terminal_reply::is_terminal_reply(&data) => {
                setup_trace(self.started, "gate: terminal reply passed", &[]);
                Some(data)
            }
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
            Phase::AwaitPrompt { last_output, .. } => {
                *last_output = Some(now);
                if self.cmd_join.is_some() {
                    self.before_prompt.extend_from_slice(data);
                    let excess = self
                        .before_prompt
                        .len()
                        .saturating_sub(CMD_PROMPT_OUTPUT_CAP);
                    self.before_prompt.drain(..excess);
                }
            }
            Phase::AwaitSetup {
                last_output, marks, ..
            } => {
                *last_output = Some(now);
                if marks.feed(data) && self.done == SetupDone::PromptMark {
                    // The setup's own prompt is up: it has run.
                    setup_trace(self.started, "gate: prompt mark seen -> open", &[]);
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
                    setup_trace(self.started, "gate: first prompt, no setup -> open", &[]);
                    self.phase = Phase::Open;
                    return std::mem::take(&mut self.held);
                }
                setup_trace(
                    self.started,
                    "gate: first prompt settled -> typing setup",
                    &[],
                );
                self.phase = Phase::AwaitSetup {
                    deadline: now + SETUP_GATE_CAP,
                    retype_at: now + SETUP_GATE_RETYPE,
                    last_output: None,
                    marks: PromptMarkDetector::new(),
                };
                if let Some(cols) = self.cmd_join.take() {
                    let lines: Vec<String> = self
                        .setup
                        .iter()
                        .map(|l| String::from_utf8_lossy(l).into_owned())
                        .collect();
                    let col = cursor_column(&self.before_prompt, usize::from(cols));
                    self.before_prompt = Vec::new();
                    self.setup = vec![join_cmd_setup(&lines, col, usize::from(cols)).into_bytes()];
                }
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
                    setup_trace(
                        self.started,
                        if settled {
                            "gate: setup output settled -> open"
                        } else {
                            "gate: cap reached without a report -> open"
                        },
                        &[],
                    );
                    self.phase = Phase::Open;
                    return std::mem::take(&mut self.held);
                }
                // The retype is due: the shell has not answered the setup.
                *retype_at = now + SETUP_GATE_RETYPE;
                *last_output = None;
                debug!("the session setup did not report back; typing it again");
                setup_trace(self.started, "gate: no report -> retyping setup", &[]);
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
            classify_shell_probe("termihub_shell_probe %OS% termihub_shell_probe_os linux-gnu termihub_shell_probe_end\n"),
            RemoteShell::Posix
        );
    }

    #[test]
    fn classifies_windows_powershell_output_one_argument_per_line() {
        let out =
            "termihub_shell_probe\r\n%OS%\r\nC:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n\
                   termihub_shell_probe_os\r\ntermihub_shell_probe_end\r\n";
        assert_eq!(classify_shell_probe(out), RemoteShell::PowerShell);
    }

    #[test]
    fn classifies_pwsh_with_a_spaced_home_and_on_linux() {
        let win = "termihub_shell_probe\n%OS%\nC:\\Program Files\\PowerShell\\7\n\
                   termihub_shell_probe_os\ntermihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(win), RemoteShell::PowerShell);
        let linux = "termihub_shell_probe\n%OS%\n/opt/microsoft/powershell/7\n\
                     termihub_shell_probe_os\ntermihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(linux), RemoteShell::UnixPowerShell);
        let mac = "termihub_shell_probe\n%OS%\n/usr/local/microsoft/powershell/7\n\
                   termihub_shell_probe_os\ntermihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(mac), RemoteShell::UnixPowerShell);
    }

    #[test]
    fn classifies_cmd_output() {
        assert_eq!(
            classify_shell_probe(
                "termihub_shell_probe Windows_NT $PSHOME $FISH_VERSION termihub_shell_probe_os $OSTYPE $MSYSTEM termihub_shell_probe_end\r\n"
            ),
            RemoteShell::Cmd
        );
    }

    // ── fish (#5016) ────────────────────────────────────────────────────

    /// #5016: fish answered the probe like bash, so it was typed the bash
    /// hook — a parse error. `$FISH_VERSION` now tells it apart.
    #[test]
    fn classifies_fish_by_its_version() {
        for (version, native) in [
            ("3.0.0", false),
            ("3.7.1", false),
            ("4.0.2", true),
            ("4.0b1", true),
            ("4.6.0", true),
            ("10.1", true),
        ] {
            let out = format!("termihub_shell_probe %OS% {version} termihub_shell_probe_os termihub_shell_probe_end\n");
            assert_eq!(
                classify_shell_probe(&out),
                RemoteShell::Fish {
                    native_integration: native,
                    windows: false,
                },
                "{version}"
            );
        }
    }

    #[test]
    fn the_fish_probe_token_does_not_change_the_other_shells() {
        // bash / zsh / sh / dash expand `$FISH_VERSION` to nothing.
        assert_eq!(
            classify_shell_probe("termihub_shell_probe %OS% termihub_shell_probe_os linux-gnu termihub_shell_probe_end\n"),
            RemoteShell::Posix
        );
        // PowerShell expands it to nothing too; its home is never a number.
        let linux = "termihub_shell_probe\n%OS%\n/opt/microsoft/powershell/7\n\
                     termihub_shell_probe_os\ntermihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(linux), RemoteShell::UnixPowerShell);
        let win = "termihub_shell_probe\n%OS%\nC:\\Program Files\\PowerShell\\7\n\
                   termihub_shell_probe_os\ntermihub_shell_probe_end\n";
        assert_eq!(classify_shell_probe(win), RemoteShell::PowerShell);
        assert!(SHELL_PROBE_COMMAND.contains("$FISH_VERSION"));
    }

    #[test]
    fn fish3_gets_the_typed_fish_hook_never_the_bash_one() {
        let line = integration_setup_line(FISH3).expect("fish 3 setup");
        assert_eq!(line, format!("{}\n", fish_typed_setup_command()));
        // A leading space keeps it out of fish's history.
        assert!(line.starts_with(' '), "{line:?}");
        // One line, ending with the setup-done mark so its echo is hidden.
        assert_eq!(line.matches('\n').count(), 1, "{line:?}");
        assert!(
            line.trim_end()
                .ends_with(crate::output::setup_echo::SETUP_DONE_PRINTF),
            "{line:?}"
        );
        // bash/zsh syntax is a parse error in fish.
        for bash in ["(){", "PROMPT_COMMAND", "[ -z", "fi;", "$'", "local "] {
            assert!(!line.contains(bash), "{bash:?} in {line:?}");
        }
        assert!(line.contains("]7;file://"), "no OSC 7: {line:?}");
        assert!(line.contains("]133;A"), "no OSC 133: {line:?}");
    }

    #[test]
    fn fish4_gets_no_integration_line() {
        // fish 4.0+ emits OSC 7 and OSC 133 itself; a typed line would show.
        assert_eq!(integration_setup_line(FISH4), None);
    }

    #[test]
    fn fish_submits_with_lf_and_is_never_deferred() {
        for fish in [FISH3, FISH4] {
            assert_eq!(line_ending(fish), Some("\n"));
            for has_setup in [false, true] {
                assert!(!defers_setup_until_prompt(fish, has_setup));
            }
        }
    }

    #[test]
    fn fish_env_line_uses_set_gx_and_fish_quoting() {
        for fish in [FISH3, FISH4] {
            let e = env(&[("ZED", "1"), ("ALPHA", "two words")]);
            assert_eq!(
                env_setup_line(fish, &e).as_deref(),
                Some(" set -gx ALPHA 'two words'; set -gx ZED '1'\n")
            );
            // In fish's '...' a backslash escapes `'` and `\`; `$`, `(`,
            // `;` and backticks stay literal.
            let e = env(&[("MSG", "it's $HOME (id); `x` a\\b")]);
            assert_eq!(
                env_setup_line(fish, &e).as_deref(),
                Some(" set -gx MSG 'it\\'s $HOME (id); `x` a\\\\b'\n")
            );
        }
    }

    #[test]
    fn fish_x11_lines_use_set_gx() {
        assert_eq!(
            x11_setup_lines(FISH3, 10, Some("abc123")),
            vec![
                " set -gx DISPLAY localhost:10.0\n".to_string(),
                " xauth add localhost:10 MIT-MAGIC-COOKIE-1 abc123 2>/dev/null\n".to_string(),
            ]
        );
    }

    // ── POSIX shell on a Windows host (#5015) ───────────────────────────

    fn probe_answer(family: &str, host_os: &str) -> String {
        format!("termihub_shell_probe {family} termihub_shell_probe_os {host_os} termihub_shell_probe_end\n")
    }

    /// #5015: a Win32-OpenSSH host whose `DefaultShell` is Git Bash, an MSYS2
    /// shell or Cygwin's answered like a Linux bash and got its setup echo
    /// filtered. `$OSTYPE` / `$MSYSTEM` now tell it apart.
    #[test]
    fn classifies_a_posix_shell_on_windows_by_ostype_or_msystem() {
        for host_os in [
            "msys MINGW64",  // Git Bash (Git for Windows' bin\bash.exe)
            "cygwin UCRT64", // Git for Windows 2.56 on the CI runner (seen live)
            "msys",          // Git Bash's usr\bin\bash.exe, no MSYSTEM
            "msys UCRT64",   // MSYS2 bash / zsh
            "MINGW32",       // MSYS2 dash / sh: no $OSTYPE
            "MSYS",
            "CLANG64",
            "cygwin",     // Cygwin bash / zsh
            "Windows_NT", // a POSIX shell with neither: only `$OS` (#5101)
        ] {
            assert_eq!(
                classify_shell_probe(&probe_answer("%OS%", host_os)),
                RemoteShell::WindowsPosix,
                "{host_os:?}"
            );
        }
    }

    #[test]
    fn a_unix_ostype_stays_posix() {
        for host_os in [
            "",
            "linux-gnu",
            "linux-musl",
            "linux-android",
            "darwin23.0",
            "freebsd14.0",
            "openbsd7.5",
            "solaris2.11",
        ] {
            assert_eq!(
                classify_shell_probe(&probe_answer("%OS%", host_os)),
                RemoteShell::Posix,
                "{host_os:?}"
            );
        }
    }

    /// The host-OS words never change the shell family of fish, PowerShell or
    /// cmd.exe: only the words before the separator name it. (fish carries
    /// whether it runs on Windows, #5101.)
    #[test]
    fn the_host_os_words_do_not_change_the_other_shells() {
        for host_os in ["", "linux-gnu", "msys MINGW64", "cygwin", "Windows_NT"] {
            assert!(
                matches!(
                    classify_shell_probe(&probe_answer("%OS% 3.7.1", host_os)),
                    RemoteShell::Fish {
                        native_integration: false,
                        ..
                    }
                ),
                "{host_os:?}"
            );
            assert!(
                matches!(
                    classify_shell_probe(&probe_answer("%OS% 4.0.2", host_os)),
                    RemoteShell::Fish {
                        native_integration: true,
                        ..
                    }
                ),
                "{host_os:?}"
            );
            assert_eq!(
                classify_shell_probe(&probe_answer("%OS% /opt/microsoft/powershell/7", host_os)),
                RemoteShell::UnixPowerShell,
                "{host_os:?}"
            );
            assert_eq!(
                classify_shell_probe(&probe_answer(
                    "%OS% C:\\Program Files\\PowerShell\\7",
                    host_os
                )),
                RemoteShell::PowerShell,
                "{host_os:?}"
            );
        }
        // cmd.exe leaves every `$` word literal.
        assert_eq!(
            classify_shell_probe(&probe_answer(
                "Windows_NT $PSHOME $FISH_VERSION",
                "$OSTYPE $MSYSTEM $OS"
            )),
            RemoteShell::Cmd
        );
        // A csh error ("PSHOME: Undefined variable.") still has no markers.
        assert_eq!(
            classify_shell_probe("PSHOME: Undefined variable.\n"),
            RemoteShell::Unknown
        );
        assert!(SHELL_PROBE_COMMAND.contains("$OSTYPE $MSYSTEM"));
    }

    /// The probe's words between the markers are in the order the classifier
    /// splits them at: the shell family first, the host OS after the separator.
    #[test]
    fn the_probe_command_puts_the_host_os_after_the_separator() {
        let words: Vec<&str> = SHELL_PROBE_COMMAND.split_whitespace().collect();
        assert_eq!(
            words,
            [
                "echo",
                SHELL_PROBE_START,
                "%OS%",
                "$PSHOME",
                "$FISH_VERSION",
                SHELL_PROBE_OS,
                "$OSTYPE",
                "$MSYSTEM",
                "$OS",
                SHELL_PROBE_END,
            ]
        );
    }

    /// #5015: a POSIX shell on Windows is typed exactly the POSIX setup, but
    /// never has its echo hidden or its setup held for a prompt: ConPTY
    /// renders it, so showing the setup is the safe fallback.
    #[test]
    fn a_posix_shell_on_windows_gets_the_posix_setup_and_never_hides_it() {
        let w = RemoteShell::WindowsPosix;
        let p = RemoteShell::Posix;
        assert_eq!(integration_setup_line(w), integration_setup_line(p));
        assert!(integration_setup_line(w).is_some());
        assert_eq!(line_ending(w), Some("\n"));
        let e = env(&[("A", "it's")]);
        assert_eq!(env_setup_line(w, &e), env_setup_line(p, &e));
        assert_eq!(
            x11_setup_lines(w, 10, Some("abc123")),
            x11_setup_lines(p, 10, Some("abc123"))
        );
        for flag in [false, true] {
            assert!(!hides_setup_echo(w, flag, flag), "has_integration={flag}");
            assert!(!defers_setup_until_prompt(w, flag), "has_setup={flag}");
        }
        // The Linux/macOS twin still hides it (#5009).
        assert!(hides_setup_echo(p, true, true));
    }

    /// #5101: an MSYS2 or Cygwin fish as the `DefaultShell` of a Windows
    /// host. fish has no `$OSTYPE`; MSYS2 exports `$MSYSTEM`, and `$OS`
    /// (`Windows_NT`) is there on every Windows host, Cygwin included.
    #[test]
    fn classifies_fish_on_windows_by_msystem_or_os() {
        for host_os in [
            "UCRT64 Windows_NT", // MSYS2 fish
            "MSYS Windows_NT",
            "Windows_NT", // Cygwin fish: no MSYSTEM
            "windows_nt",
            "MINGW64", // MSYS2 fish whose $OS was unset
        ] {
            for (version, native) in [("3.7.1", false), ("4.0.2", true)] {
                assert_eq!(
                    classify_shell_probe(&probe_answer(&format!("%OS% {version}"), host_os)),
                    RemoteShell::Fish {
                        native_integration: native,
                        windows: true,
                    },
                    "{version} {host_os:?}"
                );
            }
        }
        for host_os in ["", "linux-gnu", "Linux", "darwin23.0", "Windows"] {
            assert_eq!(
                classify_shell_probe(&probe_answer("%OS% 3.7.1", host_os)),
                FISH3,
                "{host_os:?}"
            );
        }
    }

    /// #5101: a fish on Windows is typed exactly fish's setup, but its echo
    /// is never hidden (ConPTY renders it), like a POSIX shell there.
    #[test]
    fn a_fish_on_windows_gets_the_fish_setup_and_never_hides_it() {
        let w = WIN_FISH3;
        assert_eq!(integration_setup_line(w), integration_setup_line(FISH3));
        assert!(integration_setup_line(w).is_some());
        assert_eq!(line_ending(w), Some("\n"));
        let e = env(&[("A", "it's")]);
        assert_eq!(env_setup_line(w, &e), env_setup_line(FISH3, &e));
        assert_eq!(
            x11_setup_lines(w, 10, Some("abc123")),
            x11_setup_lines(FISH3, 10, Some("abc123"))
        );
        for flag in [false, true] {
            assert!(!hides_setup_echo(w, flag, flag), "has_integration={flag}");
            assert!(!defers_setup_until_prompt(w, flag), "has_setup={flag}");
        }
        // The Linux/macOS twin still hides it.
        assert!(hides_setup_echo(FISH3, true, true));
        let win4 = RemoteShell::Fish {
            native_integration: true,
            windows: true,
        };
        assert_eq!(integration_setup_line(win4), None);
        assert!(!hides_setup_echo(win4, false, true));
    }

    #[test]
    fn ignores_noise_around_the_markers() {
        let out = "Welcome to host!\nlast login: today\n\
                   termihub_shell_probe %OS% termihub_shell_probe_os linux-gnu termihub_shell_probe_end\nbye\n";
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
            // An answer without the host-OS separator is not the current
            // probe's (#5015).
            "termihub_shell_probe %OS% termihub_shell_probe_end",
            "termihub_shell_probe %OS% msys termihub_shell_probe_end",
        ] {
            assert_eq!(classify_shell_probe(out), RemoteShell::Unknown, "{out:?}");
        }
    }

    // ── Probe timing (#4670) ────────────────────────────────────────────

    const WINDOWS_POWERSHELL_PROBE: &str = "termihub_shell_probe\r\n%OS%\r\n\
        C:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\ntermihub_shell_probe_os\r\ntermihub_shell_probe_end\r\n";

    /// A probe whose answer arrives `after` — a shell that starts that slowly.
    async fn probe_answering_after(after: Duration) -> Result<SshExecOutput, CoreError> {
        tokio::time::sleep(after).await;
        Ok(SshExecOutput {
            stdout: WINDOWS_POWERSHELL_PROBE.to_string(),
            ..SshExecOutput::default()
        })
    }

    /// #4670: on the CI Windows host a cold `powershell.exe -c` answered the
    /// probe only after the former 8 s bound. The probe was abandoned, the
    /// shell reported Unknown, and the session opened with no env / shell
    /// integration setup at all — the user's first command ran ungated and
    /// without the configured environment. A slow-but-answering shell must
    /// still be detected.
    #[tokio::test(start_paused = true)]
    async fn a_cold_powershell_answering_after_8s_is_still_detected() {
        let cold_start = Duration::from_secs(12);
        // The former bound lost exactly this answer (the regression).
        assert_eq!(
            await_shell_probe(probe_answering_after(cold_start), Duration::from_secs(8)).await,
            RemoteShell::Unknown
        );
        assert!(SHELL_PROBE_TIMEOUT > cold_start);
        assert_eq!(
            await_shell_probe(probe_answering_after(cold_start), SHELL_PROBE_TIMEOUT).await,
            RemoteShell::PowerShell
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_probe_gives_up_at_the_bound() {
        let start = tokio::time::Instant::now();
        let shell = await_shell_probe(
            std::future::pending::<Result<SshExecOutput, CoreError>>(),
            SHELL_PROBE_TIMEOUT,
        )
        .await;
        assert_eq!(shell, RemoteShell::Unknown);
        assert_eq!(start.elapsed(), SHELL_PROBE_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_probe_is_unknown_at_once() {
        let start = tokio::time::Instant::now();
        let failed = async { Err(CoreError::Other("exec refused".to_string())) };
        assert_eq!(
            await_shell_probe(failed, SHELL_PROBE_TIMEOUT).await,
            RemoteShell::Unknown
        );
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[test]
    fn probe_command_avoids_quotes_and_pipes() {
        // powershell.exe -c strips quotes; an exposed `|` would then pipe.
        for c in ['"', '\'', '|', '&', ';', '<', '>'] {
            assert!(!SHELL_PROBE_COMMAND.contains(c), "probe contains {c:?}");
        }
        assert!(SHELL_PROBE_COMMAND.contains(SHELL_PROBE_START));
        assert!(SHELL_PROBE_COMMAND.contains(SHELL_PROBE_END));
        assert!(SHELL_PROBE_COMMAND.contains(SHELL_PROBE_OS));
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
        let hook = osc7_setup_command("powershell").unwrap();
        assert!(line.starts_with(hook), "{line:?}");
        assert_eq!(
            line,
            join_powershell_setup(&[powershell_hook_line().unwrap()])
        );
        assert!(line.ends_with('\r'));
        // One line: an embedded LF would be a PSReadLine continuation.
        assert!(!line.contains('\n'));
        assert!(line.contains("]7;file://"));
    }

    /// The echo length the erase statement of `line` was built with.
    fn erase_len(line: &str) -> usize {
        let at = line
            .find("$n=[int][Math]::Floor(($x+")
            .expect("erase statement")
            + 26;
        line[at..line[at..].find('-').unwrap() + at]
            .parse()
            .unwrap()
    }

    #[test]
    fn typed_powershell_setup_erases_only_its_echo_rows() {
        // #5044: the typed hook cleared the whole screen, banner included.
        let line = integration_setup_line(RemoteShell::PowerShell).unwrap();
        for clear in ["Clear-Host", "cls", "[2J", "[3J", "[H", "Clear()"] {
            assert!(!line.contains(clear), "{clear:?} in {line:?}");
        }
        // It erases from the prompt's row down, by the rows it computed...
        assert!(line.contains("$Host.UI.RawUI.BufferSize.Width"));
        assert!(line.contains("'_initialX'"));
        assert!(line.contains("'['+$n+'A'+[char]13+[char]27+'[J'"));
        // ...through the console itself on Windows, so ConPTY renders it.
        assert!(line.contains("[Console]::SetCursorPosition(0,$t)"));
        // The length it erases is the echo's: the whole line but the CR.
        assert_eq!(erase_len(&line), line.chars().count() - 1);
        // In a child scope, with every error caught: no variables left, no
        // red text, `$?` true for the next prompt's exit mark.
        let erase = &line[line.find(";&{try{").unwrap()..];
        assert!(erase.ends_with("}catch{}}\r"), "{erase:?}");
        assert!(!erase.contains("$global:"), "{erase:?}");
    }

    #[test]
    fn erase_length_is_a_fixed_point_across_digit_counts() {
        // Bodies whose total length crosses a power of ten still count right.
        for n in [0, 1, 50, 400, 500, 600, 9000] {
            let lines = vec![format!("$env:A='{}'\r", "x".repeat(n))];
            let line = join_powershell_setup(&lines);
            assert_eq!(erase_len(&line), line.chars().count() - 1, "n={n}");
        }
    }

    #[test]
    fn powershell_setup_lines_join_into_one_erased_line() {
        let env = env_setup_line(
            RemoteShell::PowerShell,
            &env(&[("FOO", "b a"), ("BAR", "x")]),
        )
        .unwrap();
        let x11 = x11_setup_lines(RemoteShell::PowerShell, 10, Some("abc"));
        let hook = powershell_hook_line().unwrap();
        let mut lines = vec![env];
        lines.extend(x11);
        lines.push(hook.clone());
        let joined = join_powershell_setup(&lines);
        assert_eq!(joined.matches('\r').count(), 1, "one line: {joined:?}");
        assert!(!joined.contains('\n'));
        assert!(
            joined.starts_with("$env:BAR='x'; $env:FOO='b a';$env:DISPLAY="),
            "{joined:?}"
        );
        assert!(joined.contains(hook.trim_end_matches('\r')));
        assert_eq!(erase_len(&joined), joined.chars().count() - 1);
        // A lone hook is the integration line itself.
        assert_eq!(
            join_powershell_setup(std::slice::from_ref(&hook)),
            integration_setup_line(RemoteShell::PowerShell).unwrap()
        );
    }

    #[test]
    fn only_a_typed_powershell_hook_erases_its_echo() {
        for shell in [RemoteShell::PowerShell, RemoteShell::UnixPowerShell] {
            assert!(erases_setup_echo(shell, true));
            assert!(!erases_setup_echo(shell, false));
        }
        for shell in [
            RemoteShell::Posix,
            RemoteShell::WindowsPosix,
            RemoteShell::Cmd,
            RemoteShell::Unknown,
            FISH3,
        ] {
            assert!(!erases_setup_echo(shell, true), "{shell:?}");
        }
    }

    #[test]
    fn unknown_gets_no_setup_and_cmd_the_prompt_hook() {
        assert_eq!(integration_setup_line(RemoteShell::Unknown), None);
        // #5109: cmd.exe gets the PROMPT hook, CR-ended; the gate joins it.
        assert_eq!(
            integration_setup_line(RemoteShell::Cmd),
            Some(cmd_hook_line())
        );
    }

    /// #5109: with the hook, a cmd.exe gate types its setup as ONE line at the
    /// first prompt: the env line, the echo erase sized from the prompt's
    /// column, the PROMPT, then CR and Alt+F7 — and opens on the prompt mark.
    #[test]
    fn cmd_hook_setup_is_joined_at_the_first_prompt() {
        use super::super::cmd_hook::CMD_CLEAR_HISTORY;
        let t0 = Instant::now();
        let mut gate = SetupGate::new(
            defers_setup_until_prompt(RemoteShell::Cmd, true),
            SetupDone::PromptMark,
            t0,
        );
        gate.join_cmd_setup(40);
        assert_eq!(gate.setup(b"set \"V=x\"\r".to_vec()), None);
        assert_eq!(gate.setup(cmd_hook_line().into_bytes()), None);
        assert_eq!(gate.write(b"dir\r".to_vec()), None);
        // A 20-column prompt, drawn the way ConPTY does.
        gate.on_output(t0, b"\x1b[2J\x1b[HBanner\r\n\x1b[3;1HC:\\Users\\abcdefghi>");
        let typed = gate.poll(t0 + SETUP_GATE_SETTLE);
        assert_eq!(typed.len(), 1, "one joined line");
        let line = String::from_utf8(typed[0].clone()).unwrap();
        let (body, tail) = line.split_once('\r').unwrap();
        assert_eq!(tail, CMD_CLEAR_HISTORY);
        assert!(body.starts_with("set \"V=x\"&for /f "), "{body}");
        let rows = (20 + body.chars().count()).div_ceil(40);
        assert!(body.contains(&format!("%b[{rows}A%b[J%b[A")), "{body}");
        // The user's input waits for the hook's prompt mark.
        assert!(gate.poll(t0 + SETUP_GATE_SETTLE).is_empty());
        gate.on_output(t0 + SETUP_GATE_SETTLE, b"\x1b]133;A\x1b\\C:\\>");
        assert_eq!(gate.poll(t0 + SETUP_GATE_SETTLE), vec![b"dir\r".to_vec()]);
    }

    // ── Env-var fallback per shell (#4147) ──────────────────────────────

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    const FISH3: RemoteShell = RemoteShell::Fish {
        native_integration: false,
        windows: false,
    };
    const FISH4: RemoteShell = RemoteShell::Fish {
        native_integration: true,
        windows: false,
    };
    const WIN_FISH3: RemoteShell = RemoteShell::Fish {
        native_integration: false,
        windows: true,
    };

    const ALL_SHELLS: [RemoteShell; 9] = [
        RemoteShell::Posix,
        RemoteShell::WindowsPosix,
        FISH3,
        FISH4,
        WIN_FISH3,
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
            // No POSIX syntax may reach a non-POSIX shell, nor an LF one
            // that submits with CR.
            if !matches!(shell, RemoteShell::Posix | RemoteShell::WindowsPosix) {
                assert!(!line.contains("export"), "{shell:?}: {line:?}");
            }
            if eol == "\r" {
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
            for has_setup in [false, true] {
                let powershell =
                    matches!(shell, RemoteShell::PowerShell | RemoteShell::UnixPowerShell);
                let cmd_with_setup = shell == RemoteShell::Cmd && has_setup;
                assert_eq!(
                    defers_setup_until_prompt(shell, has_setup),
                    powershell || cmd_with_setup,
                    "{shell:?} has_setup={has_setup}"
                );
            }
        }
    }

    #[test]
    fn posix_and_unknown_never_defer() {
        // POSIX hosts stay unchanged (#4610): their setup is typed at once.
        for has_setup in [false, true] {
            assert!(!defers_setup_until_prompt(RemoteShell::Posix, has_setup));
            assert!(!defers_setup_until_prompt(
                RemoteShell::WindowsPosix,
                has_setup
            ));
            assert!(!defers_setup_until_prompt(RemoteShell::Unknown, has_setup));
        }
    }

    /// #5009: a POSIX Linux/macOS host with shell integration is held until
    /// its first prompt, so the setup is typed at the line editor and its
    /// echo can be hidden; without integration it stays ungated. A fish there
    /// hides any setup at all (#5094): its joined line carries the done mark
    /// itself. A Windows host never hides it (#5015, #5101).
    #[test]
    fn posix_with_integration_and_fish_with_any_setup_hide_their_setup_echo() {
        for shell in ALL_SHELLS {
            for has_integration in [false, true] {
                for has_setup in [false, true] {
                    let has_setup = has_setup || has_integration;
                    let want = match shell {
                        RemoteShell::Posix => has_integration,
                        RemoteShell::Fish { windows: false, .. } => has_setup,
                        _ => false,
                    };
                    assert_eq!(
                        hides_setup_echo(shell, has_integration, has_setup),
                        want,
                        "{shell:?} has_integration={has_integration} has_setup={has_setup}"
                    );
                }
            }
        }
    }

    /// #5094: a fish 4 is typed only env / X11 lines; their joined line
    /// ends with the done mark that ends the hidden region. A fish 3 line,
    /// whose integration hook already prints it, gets no second one.
    #[test]
    fn fish_setup_joins_into_one_line_ending_in_the_done_mark() {
        let env = env_setup_line(FISH4, &env(&[("FOO", "b a'r")])).unwrap();
        let x11 = x11_setup_lines(FISH4, 10, Some("abcd"));
        let joined = join_fish_setup(&[env.clone(), x11[0].clone(), x11[1].clone()]);
        assert_eq!(joined.matches('\n').count(), 1, "one line: {joined:?}");
        assert!(joined.ends_with('\n'), "{joined:?}");
        assert_eq!(
            joined,
            format!(
                " set -gx FOO 'b a\\'r'; set -gx DISPLAY localhost:10.0; \
                 xauth add localhost:10 MIT-MAGIC-COOKIE-1 abcd 2>/dev/null; {SETUP_DONE_PRINTF}\n"
            )
        );
        assert_eq!(joined.matches("6973;").count(), 1);

        let hook = integration_setup_line(FISH3).unwrap();
        let joined = join_fish_setup(&[env, hook.clone()]);
        assert_eq!(joined.matches("6973;").count(), 1, "{joined:?}");
        assert!(joined.ends_with(&format!("{SETUP_DONE_PRINTF}\n")));
        assert_eq!(join_fish_setup(std::slice::from_ref(&hook)), hook);
    }

    #[test]
    fn posix_setup_lines_join_into_one_line_ending_in_the_integration() {
        let env = env_setup_line(RemoteShell::Posix, &env(&[("FOO", "b a'r")])).unwrap();
        let x11 = x11_setup_lines(RemoteShell::Posix, 10, Some("abcd"));
        let integration = integration_setup_line(RemoteShell::Posix).unwrap();
        let mut lines = vec![env, x11[0].clone(), x11[1].clone(), integration.clone()];
        let joined = join_posix_setup(&lines);
        assert_eq!(joined.matches('\n').count(), 1, "one line: {joined:?}");
        assert!(joined.ends_with(integration.trim_start()), "{joined:?}");
        assert!(
            joined.starts_with(" export FOO='b a'\\''r'; export DISPLAY=localhost:10.0; xauth add")
        );
        // A lone integration line is unchanged.
        lines.clear();
        lines.push(integration.clone());
        assert_eq!(join_posix_setup(&lines), integration);
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

    /// #5094: fish 4 waits for the terminal's Device Attributes answer
    /// before its first prompt. A fish gate lets such answers through while
    /// the user's own input stays held; any other gate holds them.
    #[test]
    fn a_fish_gate_passes_terminal_replies_but_holds_the_users_input() {
        let t0 = Instant::now();
        let mut gate = SetupGate::new(true, SetupDone::OutputSettled, t0);
        gate.pass_terminal_replies(true);
        gate.setup(b" set -gx A 1\n".to_vec());
        assert_eq!(
            gate.write(b"\x1b[?62;22c".to_vec()),
            Some(b"\x1b[?62;22c".to_vec())
        );
        assert_eq!(gate.write(b"ls\n".to_vec()), None);
        assert_eq!(
            gate.write(b"\x1b[1;1R".to_vec()),
            None,
            "a CPR may be a key"
        );
        assert!(gate.is_holding());

        let mut other = SetupGate::new(true, SetupDone::PromptMark, t0);
        other.setup(b"setup\r".to_vec());
        assert_eq!(other.write(b"\x1b[?62;22c".to_vec()), None);
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

    /// #4610: the cmd.exe replay of the #4604 race. The `set` env line, the X11
    /// `DISPLAY` line and the user's first command are all written while
    /// `cmd.exe` is still starting under ConPTY, where early input can be
    /// dropped. cmd.exe has no integration line (no prompt mark), so the gate
    /// waits for the first prompt, types the setup, and releases the first
    /// command only once the setup's answer has settled — in that order.
    #[test]
    fn cmd_first_command_waits_for_the_setup_to_settle() {
        let mut env_vars = HashMap::new();
        env_vars.insert("V".to_string(), "x".to_string());
        let env_line = env_setup_line(RemoteShell::Cmd, &env_vars).unwrap();
        let x11 = x11_setup_lines(RemoteShell::Cmd, 10, None);

        let t0 = Instant::now();
        let hold = defers_setup_until_prompt(RemoteShell::Cmd, true);
        assert!(hold, "cmd.exe with env/X11 setup is gated");
        let mut gate = SetupGate::new(hold, SetupDone::OutputSettled, t0);
        let mut setup = vec![env_line.clone().into_bytes()];
        setup.extend(x11.iter().map(|l| l.clone().into_bytes()));
        for line in &setup {
            assert_eq!(gate.setup(line.clone()), None, "nothing typed at start");
        }
        assert_eq!(gate.write(b"echo FIRST-%V%\r".to_vec()), None);

        // The banner prints while cmd.exe is still starting: nothing typed.
        let banner = b"Microsoft Windows [Version 10.0.20348]\r\n";
        assert!(output(&mut gate, t0 + ms(200), banner).is_empty());
        assert!(gate.poll(t0 + ms(400)).is_empty());
        // The first prompt, then quiet: the setup — only — is typed.
        assert!(output(&mut gate, t0 + ms(450), b"\r\nC:\\Users\\u>").is_empty());
        let t1 = t0 + ms(450) + SETUP_GATE_SETTLE;
        assert_eq!(gate.poll(t1), setup);
        assert!(gate.is_holding(), "the first command still waits");

        // Typed but unanswered: the first command still waits.
        assert!(gate.poll(t1 + SETUP_GATE_SETTLE * 2).is_empty());
        // The echo of the setup and the next prompt, then quiet: released.
        let answered = t1 + ms(30);
        let echo = format!("{env_line}\nC:\\Users\\u>");
        assert!(output(&mut gate, answered, echo.as_bytes()).is_empty());
        assert_eq!(
            gate.write(b"dir\r".to_vec()),
            None,
            "typeahead queues behind"
        );
        assert!(gate.poll(answered + SETUP_GATE_SETTLE - ms(1)).is_empty());
        assert_eq!(
            gate.poll(answered + SETUP_GATE_SETTLE),
            vec![b"echo FIRST-%V%\r".to_vec(), b"dir\r".to_vec()]
        );
        assert!(!gate.is_holding());
        assert_eq!(gate.write(b"cls\r".to_vec()), Some(b"cls\r".to_vec()));
    }

    #[test]
    fn cmd_without_setup_is_not_gated() {
        let hold = defers_setup_until_prompt(RemoteShell::Cmd, false);
        let mut gate = SetupGate::new(hold, SetupDone::OutputSettled, Instant::now());
        assert!(!gate.is_holding());
        assert_eq!(gate.write(b"dir\r".to_vec()), Some(b"dir\r".to_vec()));
    }
}
