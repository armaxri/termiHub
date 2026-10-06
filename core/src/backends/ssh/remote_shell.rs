//! Remote login-shell detection for SSH shell integration (#4143).
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

use std::time::Duration;

use tracing::debug;

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
    /// Windows PowerShell 5 or PowerShell 7 (`pwsh`), on any OS.
    PowerShell,
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
        // `%OS%` untouched and `$PSHOME` expanded to PowerShell's home (which
        // may contain spaces, e.g. `C:\Program Files\PowerShell\7`).
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
/// - PowerShell: the PowerShell OSC 7 / OSC 133 prompt override, ended with
///   CR, which is Enter for PSReadLine under ConPTY (an LF would leave the line
///   unsubmitted and merge it with the user's first command).
/// - cmd.exe and unknown shells: nothing.
pub fn integration_setup_line(shell: RemoteShell) -> Option<String> {
    match shell {
        RemoteShell::Posix => osc7_setup_command("bash").map(|s| format!("{s}\n")),
        RemoteShell::PowerShell => osc7_setup_command("powershell").map(|s| format!("{s}\r")),
        RemoteShell::Cmd | RemoteShell::Unknown => None,
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
