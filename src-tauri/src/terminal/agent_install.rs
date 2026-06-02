//! Platform-aware remote agent install commands.
//!
//! The agent is uploaded via SFTP to a temporary location and then moved into
//! place by a command run through the remote host's default shell. POSIX and
//! Windows hosts need entirely different command syntax (`mkdir -p`/`mv`/`chmod`
//! vs PowerShell/`cmd` with no `chmod`), so this module produces an
//! [`InstallPlan`] describing the upload target, final install path, and the
//! install/verify commands for the detected platform.
//!
//! Detection of the remote OS lives in [`crate::utils::remote_exec`]; this
//! module only distinguishes the Windows shell flavor (`cmd.exe` vs PowerShell)
//! because the two expand environment variables and quote paths differently.

use tracing::debug;

use termihub_core::backends::ssh::handler::SshSession;

use crate::utils::remote_exec::{is_windows_arch, run_remote_command};

/// Temporary SFTP upload path on POSIX hosts (writable without sudo).
pub const POSIX_UPLOAD_PATH: &str = "/tmp/termihub-agent-upload";

/// Default install path on POSIX hosts, relative to the SSH home directory.
pub const POSIX_DEFAULT_INSTALL_PATH: &str = ".local/bin/termihub-agent";

/// SFTP upload filename on Windows hosts.
///
/// Uploaded relative to the SFTP session's start directory (the user's home /
/// `%USERPROFILE%` on Windows OpenSSH), so the install command can reference it
/// as `%USERPROFILE%\…` (`$env:USERPROFILE\…` in PowerShell).
pub const WINDOWS_UPLOAD_NAME: &str = "termihub-agent-upload.exe";

/// Install directory on Windows, relative to `%LOCALAPPDATA%`.
pub const WINDOWS_INSTALL_SUBDIR: &str = r"termiHub\agent";

/// Installed agent filename on Windows.
pub const WINDOWS_AGENT_EXE: &str = "termihub-agent.exe";

/// Which shell the remote Windows OpenSSH server runs commands in by default.
///
/// Windows OpenSSH defaults to `cmd.exe`, but administrators can switch the
/// `DefaultShell` to PowerShell. The two expand environment variables
/// differently (`%VAR%` vs `$env:VAR`) and PowerShell needs the call operator
/// `&` to launch a quoted path, so install commands must be built per shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsShell {
    /// `cmd.exe` — expands `%VAR%`.
    Cmd,
    /// Windows PowerShell / PowerShell Core — expands `$env:VAR`.
    PowerShell,
}

/// A platform-specific plan for uploading and installing the agent binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    /// SFTP target path for the uploaded binary.
    pub upload_path: String,
    /// Final installed path of the agent, in a form the remote shell expands.
    pub install_path: String,
    /// Command run through the remote default shell to move the binary into place.
    pub install_command: String,
    /// Command run through the remote default shell to print the agent version.
    pub verify_command: String,
}

/// Returns `true` if a path looks like a Windows path rather than a POSIX one.
///
/// Recognizes drive letters (`C:\`, `C:/`), backslash separators, `cmd`-style
/// `%VAR%` environment references, and PowerShell `$env:VAR` references.
pub fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let has_drive_letter = bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes.get(2), Some(b'\\') | Some(b'/') | None);
    has_drive_letter || path.contains('\\') || path.contains('%') || path.starts_with("$env:")
}

/// Build the install plan for a POSIX remote host.
///
/// Preserves the existing `mkdir -p`/`mv -f`/`chmod +x` behavior. `remote_path`
/// is used verbatim (relative to the SSH home for the default `.local/bin` path).
pub fn posix_install_plan(remote_path: &str) -> InstallPlan {
    InstallPlan {
        upload_path: POSIX_UPLOAD_PATH.to_string(),
        install_path: remote_path.to_string(),
        install_command: format!(
            "mkdir -p \"$(dirname {remote_path})\" && \
             mv -f {POSIX_UPLOAD_PATH} {remote_path} && \
             chmod +x {remote_path}"
        ),
        verify_command: format!("{remote_path} --version 2>/dev/null"),
    }
}

/// Build the install plan for a Windows remote host.
///
/// Always installs to `%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe`, using
/// `cmd.exe` or PowerShell syntax depending on `shell`. No `chmod` is issued.
pub fn windows_install_plan(shell: WindowsShell) -> InstallPlan {
    // Install dir, destination exe, and uploaded-binary source, expressed with
    // the shell's own environment-variable syntax.
    let (app_data, user_profile) = match shell {
        WindowsShell::Cmd => ("%LOCALAPPDATA%", "%USERPROFILE%"),
        WindowsShell::PowerShell => ("$env:LOCALAPPDATA", "$env:USERPROFILE"),
    };
    let dir = format!(r"{app_data}\{WINDOWS_INSTALL_SUBDIR}");
    let dst = format!(r"{dir}\{WINDOWS_AGENT_EXE}");
    let src = format!(r"{user_profile}\{WINDOWS_UPLOAD_NAME}");

    let (install_command, verify_command) = match shell {
        WindowsShell::Cmd => (
            format!(r#"(if not exist "{dir}" md "{dir}") & move /Y "{src}" "{dst}""#),
            format!(r#""{dst}" --version"#),
        ),
        WindowsShell::PowerShell => (
            format!(
                r#"New-Item -ItemType Directory -Force -Path "{dir}" | Out-Null; Move-Item -Force -Path "{src}" -Destination "{dst}""#
            ),
            // PowerShell needs the call operator to launch a quoted path.
            format!(r#"& "{dst}" --version"#),
        ),
    };

    InstallPlan {
        upload_path: WINDOWS_UPLOAD_NAME.to_string(),
        install_path: dst,
        install_command,
        verify_command,
    }
}

/// Build a command that prints the absolute install path on a Windows host.
///
/// Running this through the remote shell expands `%LOCALAPPDATA%` /
/// `$env:LOCALAPPDATA` to a concrete path (e.g.
/// `C:\Users\me\AppData\Local\termiHub\agent\termihub-agent.exe`) which is
/// shell-agnostic and can be stored as the connection's agent path.
pub fn windows_resolve_command(shell: WindowsShell) -> String {
    match shell {
        WindowsShell::Cmd => {
            format!(r"echo %LOCALAPPDATA%\{WINDOWS_INSTALL_SUBDIR}\{WINDOWS_AGENT_EXE}")
        }
        WindowsShell::PowerShell => {
            format!(
                r#"Write-Output "$env:LOCALAPPDATA\{WINDOWS_INSTALL_SUBDIR}\{WINDOWS_AGENT_EXE}""#
            )
        }
    }
}

/// Detect whether the remote Windows host runs commands in `cmd.exe` or PowerShell.
///
/// Probes `echo %PROCESSOR_ARCHITECTURE%`: `cmd.exe` expands it to a real
/// architecture string, while PowerShell echoes the literal `%…%`. Defaults to
/// [`WindowsShell::PowerShell`] when the `cmd`-style expansion does not occur.
pub fn detect_windows_shell(session: &SshSession) -> WindowsShell {
    // cmd.exe expands `%PROCESSOR_ARCHITECTURE%` to e.g. `AMD64`; PowerShell
    // echoes the literal `%PROCESSOR_ARCHITECTURE%`.
    let probe = run_remote_command(session, "echo %PROCESSOR_ARCHITECTURE%").unwrap_or_default();
    if is_windows_arch(&probe) {
        debug!("Detected remote Windows shell: cmd.exe");
        WindowsShell::Cmd
    } else {
        debug!("Detected remote Windows shell: PowerShell (cmd expansion failed)");
        WindowsShell::PowerShell
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_windows_path_recognizes_windows_forms() {
        assert!(is_windows_path(r"C:\Users\me\agent.exe"));
        assert!(is_windows_path("C:/Users/me/agent.exe"));
        assert!(is_windows_path(
            r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"
        ));
        assert!(is_windows_path(r"folder\sub\agent.exe"));
        assert!(is_windows_path(
            "$env:LOCALAPPDATA\\termiHub\\agent\\termihub-agent.exe"
        ));
        assert!(is_windows_path("D:"));
    }

    #[test]
    fn is_windows_path_rejects_posix_forms() {
        assert!(!is_windows_path("/tmp/termihub-agent-upload"));
        assert!(!is_windows_path("~/.local/bin/termihub-agent"));
        assert!(!is_windows_path(".local/bin/termihub-agent"));
        assert!(!is_windows_path("/usr/local/bin/termihub-agent"));
        assert!(!is_windows_path(""));
    }

    #[test]
    fn posix_plan_preserves_legacy_commands() {
        let plan = posix_install_plan(".local/bin/termihub-agent");
        assert_eq!(plan.upload_path, "/tmp/termihub-agent-upload");
        assert_eq!(plan.install_path, ".local/bin/termihub-agent");
        // Same command shape as the original deploy_agent install step.
        assert!(plan.install_command.contains("mkdir -p"));
        assert!(plan
            .install_command
            .contains("mv -f /tmp/termihub-agent-upload"));
        assert!(plan.install_command.contains("chmod +x"));
        assert!(plan.install_command.contains(".local/bin/termihub-agent"));
        assert_eq!(
            plan.verify_command,
            ".local/bin/termihub-agent --version 2>/dev/null"
        );
    }

    #[test]
    fn posix_plan_custom_path() {
        let plan = posix_install_plan("/opt/termihub-agent");
        assert!(plan.install_command.contains("/opt/termihub-agent"));
        assert!(plan
            .verify_command
            .starts_with("/opt/termihub-agent --version"));
    }

    #[test]
    fn windows_cmd_plan_uses_cmd_syntax() {
        let plan = windows_install_plan(WindowsShell::Cmd);
        assert_eq!(plan.upload_path, "termihub-agent-upload.exe");
        assert_eq!(
            plan.install_path,
            r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"
        );
        // No POSIX-only commands.
        assert!(!plan.install_command.contains("mkdir -p"));
        assert!(!plan.install_command.contains("chmod"));
        assert!(!plan.install_command.contains("mv -f"));
        assert!(!plan.install_command.contains("/tmp"));
        // cmd.exe directory + move.
        assert!(plan
            .install_command
            .contains("md \"%LOCALAPPDATA%\\termiHub\\agent\""));
        assert!(plan
            .install_command
            .contains("move /Y \"%USERPROFILE%\\termihub-agent-upload.exe\""));
        assert!(plan
            .install_command
            .contains(r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"));
        assert_eq!(
            plan.verify_command,
            r#""%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe" --version"#
        );
    }

    #[test]
    fn windows_powershell_plan_uses_powershell_syntax() {
        let plan = windows_install_plan(WindowsShell::PowerShell);
        assert_eq!(plan.upload_path, "termihub-agent-upload.exe");
        assert_eq!(
            plan.install_path,
            r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe"
        );
        assert!(!plan.install_command.contains("mkdir -p"));
        assert!(!plan.install_command.contains("chmod"));
        assert!(!plan.install_command.contains("/tmp"));
        assert!(plan
            .install_command
            .contains("New-Item -ItemType Directory -Force"));
        assert!(plan.install_command.contains("Move-Item -Force"));
        assert!(plan
            .install_command
            .contains(r"$env:USERPROFILE\termihub-agent-upload.exe"));
        assert!(plan
            .install_command
            .contains(r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe"));
        // PowerShell needs the call operator to launch a quoted path.
        assert_eq!(
            plan.verify_command,
            r#"& "$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe" --version"#
        );
    }

    #[test]
    fn windows_resolve_command_per_shell() {
        assert_eq!(
            windows_resolve_command(WindowsShell::Cmd),
            r"echo %LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"
        );
        assert_eq!(
            windows_resolve_command(WindowsShell::PowerShell),
            r#"Write-Output "$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe""#
        );
    }

    #[test]
    fn windows_plans_never_emit_posix_redirect() {
        for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
            let plan = windows_install_plan(shell);
            assert!(!plan.verify_command.contains("2>/dev/null"));
            assert!(!plan.verify_command.contains("$HOME"));
        }
    }
}
