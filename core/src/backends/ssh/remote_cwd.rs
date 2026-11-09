//! Reading the interactive shell's directory over a side channel (#5009).
//!
//! The file browser follows an SSH terminal's directory without anything
//! being typed into the user's shell: a short-lived exec channel on the
//! *same* SSH connection runs [`REMOTE_CWD_SCRIPT`] (POSIX `sh`, fed on
//! stdin so the login shell's syntax does not matter). OpenSSH runs every
//! channel of a connection as a child of the same per-connection `sshd`
//! process, so the script walks up from itself to that process and picks its
//! child with a controlling terminal — the interactive shell. It prints the
//! directory of that terminal's foreground process (a nested shell, or the
//! shell itself at its prompt), read from `/proc` on Linux and with `lsof`
//! elsewhere (macOS, BSD).
//!
//! It answers nothing — and the session simply has no cwd following — on a
//! host without `sh`, without `/proc` or `lsof`, that refuses exec channels
//! (`ForceCommand`, SFTP-only accounts), or on Windows.
//!
//! # Windows hosts need the shell hook (#5028)
//!
//! A Win32-OpenSSH host is followed only through the opt-in Command Marks
//! (Shell Hook) setting, which has a PowerShell and a Git Bash form but no
//! cmd.exe form over SSH yet. Per `DefaultShell`:
//!
//! - **PowerShell** (Windows PowerShell 5 or `pwsh`, and `pwsh` as a Unix
//!   login shell too): impossible without the hook. `Set-Location` moves
//!   PowerShell's own location, not the process directory the operating
//!   system knows, so no outside reader can see a `cd`.
//! - **cmd.exe**: its `cd` does change the process directory, but Windows
//!   has no supported API that reports *another* process's current
//!   directory. Reading it means inspecting undocumented internal structures
//!   of the user's shell process with debugger-level access, from a
//!   PowerShell started (and compiling helper code) for every read. That was
//!   judged neither robust (undocumented layout, endpoint-security tools flag
//!   exactly this access pattern) nor free of side effects on the host, so
//!   it is not done.
//! - **Git Bash / MSYS2 / Cygwin**: MSYS has a `/proc`, but this script
//!   cannot use it there. The exec channel's `sh` is a child of the native
//!   `sshd`, which the MSYS runtime reports as parent pid 1, so the walk up
//!   never finds the connection. Its paths are also POSIX paths
//!   (`/c/Users/me`) that the host's SFTP server does not open
//!   (`/C:/Users/me`).
//!
//! So when the shell probe has classified the host (the hook, environment
//! variables or X11 are on), [`follows_without_hook`] keeps such a session
//! from opening exec channels that can only fail. A session that was not
//! probed tries the script and stops after a few unanswered reads, as before.

use std::time::Duration;

use super::exec::ssh_exec_with_stdin_timeout;
use super::handler::SshSession;
use super::remote_shell::RemoteShell;

/// Upper bound on one read; a slower host just reports later.
pub const REMOTE_CWD_TIMEOUT: Duration = Duration::from_secs(3);

/// The marker in front of the directory in the script's output.
const MARKER: &str = "TH_CWD:";

/// The command run on the exec channel; the script arrives on its stdin.
pub const REMOTE_CWD_COMMAND: &str = "sh -s";

/// Prints `TH_CWD:<dir>` for the connection's interactive shell (see the
/// module docs), or nothing.
pub const REMOTE_CWD_SCRIPT: &str = r#"
p=$$ found=
if [ -r /proc/self/stat ]; then
  ppid_of() { s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; r=${s##*) }; set -- $r; echo "$2"; }
  comm_of() { cat "/proc/$1/comm" 2>/dev/null; }
  cwd_of() { readlink "/proc/$1/cwd" 2>/dev/null; }
else
  ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
  comm_of() { ps -o comm= -p "$1" 2>/dev/null; }
  cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1; }
fi
while [ "${p:-0}" -gt 1 ] 2>/dev/null; do
  case "$(comm_of "$p")" in *sshd*|*dropbear*) found=1; break;; esac
  p=$(ppid_of "$p")
done
[ -n "$found" ] || exit 1
pid= fg=
if [ -r /proc/self/stat ]; then
  for d in /proc/[0-9]*; do
    s=$(cat "$d/stat" 2>/dev/null) || continue
    r=${s##*) }; set -- $r
    if [ "$2" = "$p" ] && [ "$5" != 0 ]; then pid=${d#/proc/}; fg=$6; break; fi
  done
else
  set -- $(ps -A -o pid= -o ppid= -o tty= -o tpgid= 2>/dev/null |
    awk -v p="$p" '$2==p && $3!="?" && $3!="??" { print $1, $4; exit }')
  pid=$1 fg=$2
fi
[ -n "$pid" ] || exit 1
for x in $fg $pid; do
  [ "$x" -gt 0 ] 2>/dev/null || continue
  d=$(cwd_of "$x")
  if [ -n "$d" ]; then echo "TH_CWD:$d"; exit 0; fi
done
exit 1
"#;

/// Whether a session whose login shell was detected as `shell` can be
/// followed by [`read_remote_cwd`]: not on a Windows host, and not for a
/// PowerShell login shell anywhere (see the module docs). An undetected
/// shell ([`RemoteShell::Unknown`]) is tried.
pub fn follows_without_hook(shell: RemoteShell) -> bool {
    match shell {
        RemoteShell::Posix | RemoteShell::Fish { .. } | RemoteShell::Unknown => true,
        RemoteShell::WindowsPosix
        | RemoteShell::Cmd
        | RemoteShell::PowerShell
        | RemoteShell::UnixPowerShell => false,
    }
}

/// The directory in the script's `stdout`, if it printed one.
pub fn parse_remote_cwd(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|l| l.strip_prefix(MARKER))
        .map(|d| d.trim_end_matches('\r').to_string())
        .filter(|d| d.starts_with('/'))
}

/// Read the interactive shell's directory over a new exec channel on
/// `session`; `None` when the host cannot tell.
pub async fn read_remote_cwd(session: &SshSession) -> Option<String> {
    let out = ssh_exec_with_stdin_timeout(
        session,
        REMOTE_CWD_COMMAND,
        REMOTE_CWD_SCRIPT,
        REMOTE_CWD_TIMEOUT,
    )
    .await
    .ok()?;
    parse_remote_cwd(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_marked_directory_only() {
        assert_eq!(
            parse_remote_cwd("noise\nTH_CWD:/home/pi/My Dir\r\n"),
            Some("/home/pi/My Dir".to_string())
        );
        assert_eq!(parse_remote_cwd(""), None);
        assert_eq!(parse_remote_cwd("TH_CWD:relative"), None);
    }

    #[test]
    fn windows_hosts_and_powershell_are_not_read() {
        assert!(follows_without_hook(RemoteShell::Posix));
        assert!(follows_without_hook(RemoteShell::Fish {
            native_integration: false
        }));
        assert!(follows_without_hook(RemoteShell::Unknown));
        for shell in [
            RemoteShell::WindowsPosix,
            RemoteShell::Cmd,
            RemoteShell::PowerShell,
            RemoteShell::UnixPowerShell,
        ] {
            assert!(!follows_without_hook(shell), "{shell:?}");
        }
    }

    #[test]
    fn script_prints_the_marker_it_is_parsed_by() {
        assert!(REMOTE_CWD_SCRIPT.contains("echo \"TH_CWD:$d\""));
    }
}
