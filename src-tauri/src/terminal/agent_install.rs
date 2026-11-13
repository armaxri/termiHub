//! Platform-aware remote agent install commands.
//!
//! The agent is uploaded via SFTP to a temporary location and then moved into
//! place by a command run through the remote host's default shell. On POSIX
//! hosts that location is a fresh owner-only (`0700`) dir inside the agent's
//! own config dir, created per upload by [`POSIX_PREPARE_UPLOAD_DIR_COMMAND`] —
//! never a fixed, world-shared `/tmp` name (AGT2-002, #4287). POSIX and
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

use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{is_windows_arch, probe_output, run_remote_command};

/// Remote command that creates a fresh private upload dir on a POSIX host and
/// prints its absolute path (AGT2-002, #4287).
///
/// The dir is `mktemp -d <config>/termihub-agent/updates/upload.XXXXXX`, where
/// `<config>` mirrors the agent's own `config_dir()` (`$XDG_CONFIG_HOME`, else
/// `~/Library/Application Support` on macOS, else `~/.config`). Under
/// `umask 077` every dir it creates is owner-only, and the `updates` dir is
/// tightened to `0700` if it already existed. Living inside the agent's
/// `<config>/updates` staging root means the agent trusts the uploaded binary
/// for a coordinated update without trusting any shared location — including
/// agents that predate this change, which already trust that root.
///
/// Run through `sh -c` so it works whatever the user's login shell is. The
/// inner script must therefore never contain a single quote.
pub const POSIX_PREPARE_UPLOAD_DIR_COMMAND: &str = "sh -c 'umask 077; \
b=\"${XDG_CONFIG_HOME:-}\"; \
if [ -z \"$b\" ]; then \
if [ \"$(uname -s)\" = Darwin ]; then b=\"$HOME/Library/Application Support\"; \
else b=\"$HOME/.config\"; fi; fi; \
d=\"$b/termihub-agent/updates\"; \
mkdir -p \"$d\" && chmod 700 \"$d\" && mktemp -d \"$d/upload.XXXXXX\"'";

/// File name of the uploaded agent binary inside the private upload dir.
pub const POSIX_UPLOAD_FILE_NAME: &str = "termihub-agent";

/// Path segment every prepared upload dir must contain (see
/// [`POSIX_PREPARE_UPLOAD_DIR_COMMAND`]).
const PREPARED_DIR_MARKER: &str = "/termihub-agent/updates/upload.";

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
    /// Where the previous binary is kept while the new one is verified (#5207).
    pub backup_path: String,
    /// Prints the version of the binary at [`Self::backup_path`] (like
    /// [`Self::verify_command`]): proves a leftover backup is worth restoring.
    pub backup_verify_command: String,
    /// Copies the installed binary to [`Self::backup_path`]. A copy, not a move,
    /// so the install path never goes missing; exit status is checked.
    pub backup_command: String,
    /// Moves [`Self::backup_path`] back over the install path (a rename inside
    /// the install dir); exit status is checked.
    pub restore_command: String,
    /// Deletes [`Self::backup_path`]; a missing backup is not an error. On
    /// Windows a backup that a running process holds is renamed aside instead.
    pub discard_backup_command: String,
    /// Deletes stale images an earlier install renamed aside because a running
    /// agent held them (Windows only, #5254). Best effort, exit status ignored.
    pub cleanup_stale_command: Option<String>,
}

/// Suffix of the previous-binary backup on POSIX hosts (`<path>.previous`).
pub const POSIX_BACKUP_SUFFIX: &str = ".previous";

/// File name of the previous-binary backup on Windows hosts. It keeps the
/// `.exe` extension so `cmd`/PowerShell can still run it with `--version`.
pub const WINDOWS_BACKUP_EXE: &str = "termihub-agent.previous.exe";

/// File-name prefix of an install or backup renamed aside on Windows because a
/// running agent held it (#5254): `termihub-agent.stale-<random>.exe`.
pub const WINDOWS_STALE_PREFIX: &str = "termihub-agent.stale-";

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

/// Parse the output of [`POSIX_PREPARE_UPLOAD_DIR_COMMAND`] into the prepared
/// upload dir.
///
/// Takes the last non-empty line (a login banner may precede it) and accepts it
/// only when it is an absolute path of the expected shape with no `..`
/// component and none of the characters that would need escaping inside the
/// quoted install commands and setup script (`'`, `"`, `$`, `` ` ``, `\`,
/// control characters). Anything else is an error, so a failed `mktemp` never
/// turns into an upload to an unexpected place.
pub fn parse_prepared_upload_dir(output: &str) -> Result<String, TerminalError> {
    let dir = output
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default();
    let safe = dir.starts_with('/')
        && dir.contains(PREPARED_DIR_MARKER)
        && !dir.split('/').any(|part| part == "..")
        && !dir
            .chars()
            .any(|c| matches!(c, '\'' | '"' | '$' | '`' | '\\') || c.is_control());
    if safe {
        Ok(dir.to_string())
    } else {
        Err(TerminalError::RemoteError(format!(
            "Could not create a private upload directory on the remote host (got {dir:?})"
        )))
    }
}

/// Create a fresh private upload dir on a POSIX host over `session` and return
/// its absolute path (see [`POSIX_PREPARE_UPLOAD_DIR_COMMAND`]).
pub fn prepare_posix_upload_dir(session: &SshSession) -> Result<String, TerminalError> {
    let output = run_remote_command(session, POSIX_PREPARE_UPLOAD_DIR_COMMAND)?;
    let dir = parse_prepared_upload_dir(&output)?;
    debug!(%dir, "Prepared private agent upload dir");
    Ok(dir)
}

/// The SFTP upload target for the agent binary inside `upload_dir`.
pub fn posix_upload_path(upload_dir: &str) -> String {
    format!("{upload_dir}/{POSIX_UPLOAD_FILE_NAME}")
}

/// Build the install plan for a POSIX remote host.
///
/// Uploads into `upload_dir` (from [`prepare_posix_upload_dir`]), then keeps the
/// `mkdir -p`/`mv -f`/`chmod +x` install and removes the emptied upload dir.
/// `remote_path` is used verbatim (relative to the SSH home for the default
/// `.local/bin` path); `upload_dir` was validated by
/// [`parse_prepared_upload_dir`], so single-quoting it is safe. The previous
/// binary is backed up to `<remote_path>.previous` (#5207).
pub fn posix_install_plan(remote_path: &str, upload_dir: &str) -> InstallPlan {
    let upload_path = posix_upload_path(upload_dir);
    let backup_path = format!("{remote_path}{POSIX_BACKUP_SUFFIX}");
    InstallPlan {
        backup_verify_command: format!("{backup_path} --version 2>/dev/null"),
        backup_command: format!("cp -pf {remote_path} {backup_path}"),
        restore_command: format!("mv -f {backup_path} {remote_path}"),
        discard_backup_command: format!("rm -f {backup_path}"),
        cleanup_stale_command: None,
        backup_path,
        install_path: remote_path.to_string(),
        install_command: format!(
            "mkdir -p \"$(dirname {remote_path})\" && \
             mv -f '{upload_path}' {remote_path} && \
             chmod +x {remote_path} && \
             rmdir '{upload_dir}'"
        ),
        verify_command: format!("{remote_path} --version 2>/dev/null"),
        upload_path,
    }
}

/// Build the install plan for a Windows remote host.
///
/// Always installs to `%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe`, using
/// `cmd.exe` or PowerShell syntax depending on `shell`. No `chmod` is issued.
///
/// A running agent (a session daemon, the registry daemon or a `--stdio`
/// worker) keeps its exe open, and Windows refuses to replace or delete an
/// open image — but it does allow renaming one (#5254). So the install first
/// renames whatever is at the install path aside to a stale name
/// (`termihub-agent.stale-<random>.exe`) and then moves the upload in; the
/// running process keeps executing from the stale name. The backup stays a
/// *copy* (reading an open image is allowed), so a rollback moves the
/// unlocked copy back and the install path is only empty inside the one
/// install command. [`InstallPlan::cleanup_stale_command`] deletes stale
/// images once nothing runs them any more.
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
    let bak = format!(r"{dir}\{WINDOWS_BACKUP_EXE}");
    let set_aside_dst = windows_set_aside_command(shell, &dst);

    let (install_command, verify_command) = match shell {
        WindowsShell::Cmd => (
            format!(
                r#"(if not exist "{dir}" md "{dir}") & {set_aside_dst} & move /Y "{src}" "{dst}""#
            ),
            format!(r#""{dst}" --version"#),
        ),
        WindowsShell::PowerShell => (
            format!(
                r#"New-Item -ItemType Directory -Force -Path "{dir}" | Out-Null; {set_aside_dst}; Move-Item -Force -Path "{src}" -Destination "{dst}""#
            ),
            // PowerShell needs the call operator to launch a quoted path.
            format!(r#"& "{dst}" --version"#),
        ),
    };

    // Backup / restore of the previous binary (#5207). PowerShell's
    // `-ErrorAction Stop` turns a failed copy/move into a non-zero exit status.
    // The backup slot is freed first and again on discard (#5254): a backup
    // that cannot be deleted because something runs it is renamed aside, so a
    // locked leftover never blocks the next copy.
    let free_bak = windows_free_slot_command(shell, &bak);
    let (backup_verify_command, backup_command, restore_command) = match shell {
        WindowsShell::Cmd => (
            format!(r#""{bak}" --version"#),
            format!(r#"{free_bak} & copy /Y "{dst}" "{bak}""#),
            format!(r#"move /Y "{bak}" "{dst}""#),
        ),
        WindowsShell::PowerShell => (
            format!(r#"& "{bak}" --version"#),
            format!(
                r#"{free_bak}; Copy-Item -Force -ErrorAction Stop -Path "{dst}" -Destination "{bak}""#
            ),
            format!(r#"Move-Item -Force -ErrorAction Stop -Path "{bak}" -Destination "{dst}""#),
        ),
    };

    InstallPlan {
        upload_path: WINDOWS_UPLOAD_NAME.to_string(),
        install_path: dst,
        install_command,
        verify_command,
        backup_path: bak,
        backup_verify_command,
        backup_command,
        restore_command,
        discard_backup_command: free_bak,
        cleanup_stale_command: Some(windows_cleanup_stale_command(shell)),
    }
}

/// A command (in `shell`'s syntax) renaming `path` aside to a fresh
/// `termihub-agent.stale-<random>.exe` in the install dir, when it exists
/// (#5254). Windows lets a running image be renamed though it cannot be
/// replaced or deleted. The rename's failure is a non-zero exit status in
/// PowerShell (`-ErrorAction Stop` ends the script); in `cmd` the next step of
/// the chain fails instead, because `path` is still there.
///
/// `path` must be inside the install dir: the stale name is a sibling, so the
/// rename never crosses a volume.
pub fn windows_set_aside_command(shell: WindowsShell, path: &str) -> String {
    let stale = windows_stale_prefix(shell);
    match shell {
        // `%RANDOM%` expands to 0–32767 per occurrence; two give 30 bits, so a
        // clash with a stale file that is still locked is negligible.
        WindowsShell::Cmd => {
            format!(r#"(if exist "{path}" move /Y "{path}" "{stale}%RANDOM%%RANDOM%.exe" >nul)"#)
        }
        WindowsShell::PowerShell => format!(
            r#"if (Test-Path -Path "{path}") {{ Move-Item -Force -ErrorAction Stop -Path "{path}" -Destination ("{stale}" + [guid]::NewGuid().ToString('N') + '.exe') }}"#
        ),
    }
}

/// A command (in `shell`'s syntax) that empties `path`: deletes it, and when
/// the delete fails because a running process holds it, renames it aside with
/// [`windows_set_aside_command`]. A missing `path` is not an error.
pub fn windows_free_slot_command(shell: WindowsShell, path: &str) -> String {
    let set_aside = windows_set_aside_command(shell, path);
    match shell {
        WindowsShell::Cmd => {
            format!(r#"(if exist "{path}" del /F /Q "{path}" >nul 2>&1) & {set_aside}"#)
        }
        WindowsShell::PowerShell => format!(
            r#"if (Test-Path -Path "{path}") {{ Remove-Item -Force -ErrorAction SilentlyContinue -Path "{path}" }}; {set_aside}"#
        ),
    }
}

/// Path prefix of the stale images [`windows_set_aside_command`] creates.
fn windows_stale_prefix(shell: WindowsShell) -> String {
    let app_data = match shell {
        WindowsShell::Cmd => "%LOCALAPPDATA%",
        WindowsShell::PowerShell => "$env:LOCALAPPDATA",
    };
    format!(r"{app_data}\{WINDOWS_INSTALL_SUBDIR}\{WINDOWS_STALE_PREFIX}")
}

/// A command (in `shell`'s syntax) deleting every stale image in the install
/// dir that nothing runs any more (#5254). Best effort: one that is still
/// locked is skipped and the command still succeeds, so a later deploy retries.
/// The pattern only matches `termihub-agent.stale-*.exe`, never the install or
/// the backup.
pub fn windows_cleanup_stale_command(shell: WindowsShell) -> String {
    match shell {
        WindowsShell::Cmd => {
            let pattern = format!("{}*.exe", windows_stale_prefix(shell));
            format!(r#"if exist "{pattern}" del /F /Q "{pattern}" >nul 2>&1"#)
        }
        WindowsShell::PowerShell => format!(
            r#"Get-ChildItem -Path "$env:LOCALAPPDATA\{WINDOWS_INSTALL_SUBDIR}" -Filter "{WINDOWS_STALE_PREFIX}*.exe" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue"#
        ),
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
///
/// Test-only: the live Windows SSH-host suites pick their probe syntax with it.
/// The deploy uses [`detect_windows_deploy_shell`], which fails closed instead
/// of guessing (#5449).
#[cfg(test)]
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

// ── PowerShell deploy step for any login shell (#5449) ──────────────────────

/// The Windows PowerShell executable the encoded deploy step runs. It ships in
/// `System32\WindowsPowerShell\v1.0`, on the system `PATH` of every supported
/// Windows (10 / Server 2016 and later).
pub const WINDOWS_POWERSHELL_EXE: &str = "powershell.exe";

/// What the PowerShell availability probe prints (see
/// [`detect_windows_deploy_shell`]).
const POWERSHELL_PROBE_SCRIPT: &str = "Write-Output $env:PROCESSOR_ARCHITECTURE";

/// How the deploy runs its commands on a Windows host.
///
/// Win32-OpenSSH hands every exec to the account's `DefaultShell`. `cmd.exe`
/// and PowerShell get the native [`windows_install_plan`] in their own syntax.
/// Any other login shell (Git Bash, MSYS2, Cygwin, …) gets the PowerShell plan
/// with every command wrapped as `powershell.exe … -EncodedCommand <base64>`
/// ([`powershell_encoded_command`]): the base64 text has no character any of
/// those shells treats specially, so the script reaches PowerShell unchanged.
/// The deploy never needs Git Bash and never issues a POSIX command there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsDeployShell {
    /// The `DefaultShell` is `cmd.exe` or PowerShell: commands in its syntax.
    Native(WindowsShell),
    /// Any other login shell: each command is an encoded PowerShell script.
    EncodedPowerShell,
}

/// Quote `value` as a PowerShell single-quoted (verbatim) string literal.
///
/// Nothing inside single quotes is expanded; the only special characters are
/// the quotes themselves, which PowerShell also recognises in their typographic
/// forms (U+2018–U+201B). Each is escaped by doubling it.
pub fn powershell_single_quote(value: &str) -> String {
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

/// A command line that runs `script` in Windows PowerShell from any login
/// shell: `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand
/// <base64 of the UTF-16LE script>`.
///
/// No value is spliced into a shell command line: the script travels as
/// standard base64 (`A–Z a–z 0–9 + / =`), which `cmd.exe`, PowerShell and
/// POSIX shells all pass through as one plain word. PowerShell reports the
/// script's success as its exit status exactly as it does for the `-c` that
/// OpenSSH uses when PowerShell is the `DefaultShell`, so the exit-status
/// checks of the deploy keep their meaning.
pub fn powershell_encoded_command(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    format!("{WINDOWS_POWERSHELL_EXE} -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}

/// Classify the Windows deploy shell from the three probe outputs of
/// [`detect_windows_deploy_shell`]: `echo %PROCESSOR_ARCHITECTURE%` (expands in
/// `cmd.exe` only), `echo $env:PROCESSOR_ARCHITECTURE` (expands in PowerShell
/// only) and the encoded PowerShell probe (`None` when it was not run).
///
/// `None` means no probe printed an architecture: PowerShell could not be run.
pub fn classify_windows_deploy_shell(
    cmd_probe: &str,
    powershell_probe: &str,
    encoded_probe: Option<&str>,
) -> Option<WindowsDeployShell> {
    if is_windows_arch(cmd_probe.trim()) {
        Some(WindowsDeployShell::Native(WindowsShell::Cmd))
    } else if is_windows_arch(powershell_probe.trim()) {
        Some(WindowsDeployShell::Native(WindowsShell::PowerShell))
    } else if encoded_probe.is_some_and(|out| last_line(out).is_some_and(is_windows_arch)) {
        Some(WindowsDeployShell::EncodedPowerShell)
    } else {
        None
    }
}

/// The last non-empty, trimmed line of `output` (a login banner may precede it).
fn last_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).rfind(|line| !line.is_empty())
}

/// Detect how the deploy must run commands on a Windows host
/// ([`WindowsDeployShell`]), failing closed.
///
/// Tries `cmd.exe` syntax, then PowerShell syntax, then an encoded
/// `powershell.exe` probe. When none of them prints the host's architecture,
/// PowerShell cannot be run there and the deploy stops with an error before
/// anything is uploaded — it never guesses a syntax. A timeout propagates
/// (#3698).
pub fn detect_windows_deploy_shell(
    session: &SshSession,
) -> Result<WindowsDeployShell, TerminalError> {
    let cmd_probe = probe_output(run_remote_command(session, "echo %PROCESSOR_ARCHITECTURE%"))?;
    let powershell_probe = if is_windows_arch(cmd_probe.trim()) {
        String::new()
    } else {
        probe_output(run_remote_command(
            session,
            "echo $env:PROCESSOR_ARCHITECTURE",
        ))?
    };
    let encoded_probe = match classify_windows_deploy_shell(&cmd_probe, &powershell_probe, None) {
        Some(shell) => {
            debug!(?shell, "Detected remote Windows deploy shell");
            return Ok(shell);
        }
        None => probe_output(run_remote_command(
            session,
            &powershell_encoded_command(POWERSHELL_PROBE_SCRIPT),
        ))?,
    };
    match classify_windows_deploy_shell(&cmd_probe, &powershell_probe, Some(&encoded_probe)) {
        Some(shell) => {
            debug!(?shell, "Detected remote Windows deploy shell");
            Ok(shell)
        }
        None => Err(TerminalError::RemoteError(format!(
            "The remote Windows host's login shell is neither cmd.exe nor PowerShell, and \
             {WINDOWS_POWERSHELL_EXE} could not be run from it (got {:?}). The agent is \
             installed with PowerShell; nothing was changed on the host.",
            last_line(&encoded_probe).unwrap_or_default()
        ))),
    }
}

/// The install plan for a [`WindowsDeployShell`]: the native
/// [`windows_install_plan`], or the PowerShell plan with every command wrapped
/// by [`powershell_encoded_command`].
///
/// The encoded plan's [`InstallPlan::install_path`] / `backup_path` keep the
/// PowerShell `$env:LOCALAPPDATA\…` form: they only name the paths in messages;
/// the launch path comes from [`resolve_encoded_install_path`].
pub fn windows_deploy_install_plan(shell: WindowsDeployShell) -> InstallPlan {
    match shell {
        WindowsDeployShell::Native(shell) => windows_install_plan(shell),
        WindowsDeployShell::EncodedPowerShell => {
            let plan = windows_install_plan(WindowsShell::PowerShell);
            InstallPlan {
                install_command: powershell_encoded_command(&plan.install_command),
                verify_command: powershell_encoded_command(&plan.verify_command),
                backup_verify_command: powershell_encoded_command(&plan.backup_verify_command),
                backup_command: powershell_encoded_command(&plan.backup_command),
                restore_command: powershell_encoded_command(&plan.restore_command),
                discard_backup_command: powershell_encoded_command(&plan.discard_backup_command),
                cleanup_stale_command: plan
                    .cleanup_stale_command
                    .as_deref()
                    .map(powershell_encoded_command),
                ..plan
            }
        }
    }
}

/// The PowerShell script printing the absolute install path for the encoded
/// deploy step, as UTF-8 so a non-ASCII profile name survives the pipe.
fn encoded_resolve_script() -> String {
    format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         Write-Output (Join-Path -Path $env:LOCALAPPDATA -ChildPath {})",
        powershell_single_quote(&format!(r"{WINDOWS_INSTALL_SUBDIR}\{WINDOWS_AGENT_EXE}"))
    )
}

/// The command printing the absolute install path for the encoded deploy step.
pub fn encoded_resolve_command() -> String {
    powershell_encoded_command(&encoded_resolve_script())
}

/// Parse the output of [`encoded_resolve_command`] into the agent's launch
/// path on a host whose login shell is neither `cmd.exe` nor PowerShell.
///
/// That shell runs the stored path unquoted (`<path> --stdio`), so the path is
/// returned with forward slashes (`C:/Users/me/AppData/Local/termiHub/agent/
/// termihub-agent.exe`), which POSIX shells and Windows both accept, and it is
/// refused unless it is a drive-absolute path ending in the install location
/// with no `..` component and only letters, digits and `/ : . _ - + @`. Any
/// other output (PowerShell missing, a space or a shell metacharacter in the
/// profile path) is an error, so the deploy fails closed before it uploads.
pub fn parse_encoded_install_path(output: &str) -> Result<String, TerminalError> {
    let raw = last_line(output).unwrap_or_default();
    let path = raw.replace('\\', "/");
    let bytes = path.as_bytes();
    let drive_absolute =
        bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    let suffix = format!(
        "/{}/{WINDOWS_AGENT_EXE}",
        WINDOWS_INSTALL_SUBDIR.replace('\\', "/")
    );
    let safe_chars = path
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '/' | ':' | '.' | '_' | '-' | '+' | '@'));
    let ok = drive_absolute
        && path.ends_with(&suffix)
        && safe_chars
        && !path[2..].contains(':')
        && !path.split('/').any(|part| part == ".." || part == ".");
    if ok {
        Ok(path)
    } else {
        Err(TerminalError::RemoteError(format!(
            "Could not determine a usable agent install path on the remote Windows host \
             (PowerShell printed {raw:?}). The path must be a plain drive path without \
             spaces or shell metacharacters; nothing was changed on the host."
        )))
    }
}

/// Resolve the agent's launch path for the encoded deploy step over `session`
/// (see [`parse_encoded_install_path`]). A timeout propagates (#3698).
pub fn resolve_encoded_install_path(session: &SshSession) -> Result<String, TerminalError> {
    let output = probe_output(run_remote_command(session, &encoded_resolve_command()))?;
    parse_encoded_install_path(&output)
}

/// The launch path a native (`cmd.exe` / PowerShell) Windows install reports,
/// from the output of [`windows_resolve_command`].
///
/// The resolved absolute path (`C:\Users\me\AppData\Local\termiHub\agent\
/// termihub-agent.exe`) when the shell printed one, otherwise the
/// [`windows_install_plan`] form (`%LOCALAPPDATA%\…` for `cmd.exe`,
/// `$env:LOCALAPPDATA\…` for PowerShell), which the same shell expands when it
/// launches the agent.
pub fn native_install_path(shell: WindowsShell, resolve_output: Option<&str>) -> String {
    resolve_output
        .and_then(last_line)
        .map(str::to_string)
        .unwrap_or_else(|| windows_install_plan(shell).install_path)
}

/// Resolve the path a Windows install of the agent lands at, in the form the
/// host's login shell launches it with: [`native_install_path`] for `cmd.exe` /
/// PowerShell, the forward-slash [`parse_encoded_install_path`] form for any
/// other login shell (Git Bash, MSYS2, …). Only the encoded path can fail.
pub fn resolve_windows_install_path(
    session: &SshSession,
    shell: WindowsDeployShell,
) -> Result<String, TerminalError> {
    match shell {
        WindowsDeployShell::Native(shell) => {
            let output = run_remote_command(session, &windows_resolve_command(shell)).ok();
            Ok(native_install_path(shell, output.as_deref()))
        }
        WindowsDeployShell::EncodedPowerShell => resolve_encoded_install_path(session),
    }
}

/// Whether `path` names the termiHub-managed Windows install location
/// (`…\termiHub\agent\termihub-agent.exe`) in any of its forms: the
/// `%LOCALAPPDATA%` / `$env:LOCALAPPDATA` plan forms, a resolved absolute
/// path, or the forward-slash encoded-deploy form. Case-insensitive, as
/// Windows paths are.
pub fn is_managed_windows_install_path(path: &str) -> bool {
    let normalized = path.trim().replace('\\', "/").to_ascii_lowercase();
    let suffix = format!(
        "/{}/{WINDOWS_AGENT_EXE}",
        WINDOWS_INSTALL_SUBDIR.replace('\\', "/")
    )
    .to_ascii_lowercase();
    is_windows_path(path) && normalized.ends_with(&suffix)
}

/// The agent path to store after a deploy/update reported `installed_path`
/// (#5522, #5532), or `None` to keep `current` unchanged.
///
/// **Windows:** an install always lands at the managed
/// `%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe`, never at the POSIX
/// default the connect would otherwise run, so that path is stored.
///
/// **POSIX:** a deploy/update installs to the stored `agentPath` itself when
/// that is a custom path ([`custom_posix_agent_path`], #5532), so the stored
/// path already names the new binary and nothing changes. Only an install to
/// another non-default path (an explicit `remotePath` override) is stored,
/// and an install to the POSIX default is never stored (it is what an unset
/// path runs anyway).
///
/// A user-set custom path is **not** overwritten: a custom path that names
/// some other binary was set on purpose and is kept. The stored path is
/// replaced only when it is unset, empty, the POSIX default (`posix_default`,
/// or any other form of it), or an earlier managed install path in another
/// form (e.g. the host's login shell changed from PowerShell to Git Bash).
pub fn adopted_agent_path(
    current: Option<&str>,
    installed: &str,
    posix_default: &str,
) -> Option<String> {
    let installed = installed.trim();
    if installed.is_empty()
        || (!is_windows_path(installed) && is_posix_default_install_path(installed))
    {
        return None;
    }
    let replaceable = match current.map(str::trim) {
        None | Some("") => true,
        Some(path) => {
            path == posix_default
                || is_posix_default_install_path(path)
                || is_managed_windows_install_path(path)
        }
    };
    (replaceable && current != Some(installed)).then(|| installed.to_string())
}

/// The agent path to store after the POSIX setup wizard installed to
/// `remote_path` (#5532), or `None` to keep `current` unchanged.
///
/// Unlike a deploy/update, the wizard installs where the user told it to: its
/// install-path field is prefilled with the stored `agentPath`, so a path that
/// differs from it is the user's choice in this very dialog, and the connect
/// must then run what the wizard installed — not a binary elsewhere. So any
/// differing path is stored, a custom one included. An install to the POSIX
/// default leaves an unset or default stored path alone (it already runs the
/// default), and an empty path stores nothing.
pub fn setup_agent_path(current: Option<&str>, remote_path: &str) -> Option<String> {
    let remote_path = remote_path.trim();
    if remote_path.is_empty() {
        return None;
    }
    let current = current.map(str::trim).filter(|path| !path.is_empty());
    let unchanged = match current {
        None => is_posix_default_install_path(remote_path),
        Some(path) => {
            path == remote_path
                || (is_posix_default_install_path(path)
                    && is_posix_default_install_path(remote_path))
        }
    };
    (!unchanged).then(|| remote_path.to_string())
}

/// Whether `path` is the POSIX default install path in any of its forms:
/// relative to the SSH home (`.local/bin/termihub-agent`), `~/…` or
/// `$HOME/…`.
pub fn is_posix_default_install_path(path: &str) -> bool {
    let path = path.trim();
    let rest = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("$HOME/"))
        .unwrap_or(path);
    rest == POSIX_DEFAULT_INSTALL_PATH
}

/// The stored `agentPath` a POSIX deploy/update installs to (#5532), or `None`
/// to install to the POSIX default.
///
/// `None` for an unset, empty or default path, and for a Windows path (a
/// managed Windows install path left over from an earlier host): the default is
/// what such an agent runs, or should run, on a POSIX host. Any other path is a
/// custom one the user set, and the next connect launches it, so the update
/// goes there. Otherwise the update would install to the default and the
/// connect would keep running the old binary at the custom path.
pub fn custom_posix_agent_path(agent_path: Option<&str>) -> Option<&str> {
    let path = agent_path?.trim();
    (!path.is_empty() && !is_posix_default_install_path(path) && !is_windows_path(path))
        .then_some(path)
}

/// Check that `path` can be used verbatim as a POSIX install target and launch
/// command (#5532).
///
/// The install plan and the connect's exec command put the path into a shell
/// command unquoted, so it may only hold characters no shell treats specially:
/// ASCII letters, digits and `/ . _ - + , @ : =`, after an optional leading
/// `~/` or `$HOME/`. Spaces, quotes, `$`, globs and the like are refused
/// before anything touches the host.
pub fn validate_posix_agent_path(path: &str) -> Result<(), TerminalError> {
    let rest = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("$HOME/"))
        .unwrap_or(path);
    let safe = !rest.is_empty()
        && !rest.ends_with('/')
        && !rest.starts_with('-')
        && !rest.starts_with('~')
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+,@:=".contains(c));
    if safe {
        Ok(())
    } else {
        Err(TerminalError::RemoteError(format!(
            "The agent path {path:?} cannot be used to install the agent: it may only \
             contain letters, digits and / . _ - + , @ : = (optionally starting with ~/). \
             Nothing was changed on the host."
        )))
    }
}

/// Whether `output` (of `<path> --version`) comes from a termiHub agent: its
/// first non-empty line is `termihub-agent <version>`.
pub fn is_termihub_agent_version_output(output: &str) -> bool {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .is_some_and(|line| line.starts_with("termihub-agent "))
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
        assert!(!is_windows_path(
            "/home/me/.config/termihub-agent/updates/upload.x"
        ));
        assert!(!is_windows_path("~/.local/bin/termihub-agent"));
        assert!(!is_windows_path(".local/bin/termihub-agent"));
        assert!(!is_windows_path("/usr/local/bin/termihub-agent"));
        assert!(!is_windows_path(""));
    }

    const UPLOAD_DIR: &str = "/home/me/.config/termihub-agent/updates/upload.Ab12Cd";

    #[test]
    fn posix_plan_installs_from_the_private_upload_dir() {
        let plan = posix_install_plan(".local/bin/termihub-agent", UPLOAD_DIR);
        assert_eq!(plan.upload_path, format!("{UPLOAD_DIR}/termihub-agent"));
        assert_eq!(plan.install_path, ".local/bin/termihub-agent");
        assert!(plan.install_command.contains("mkdir -p"));
        assert!(plan.install_command.contains(&format!(
            "mv -f '{UPLOAD_DIR}/termihub-agent' .local/bin/termihub-agent"
        )));
        assert!(plan.install_command.contains("chmod +x"));
        assert!(
            plan.install_command
                .contains(&format!("rmdir '{UPLOAD_DIR}'")),
            "the emptied private upload dir is removed: {}",
            plan.install_command
        );
        assert!(!plan.install_command.contains("/tmp"));
        assert_eq!(
            plan.verify_command,
            ".local/bin/termihub-agent --version 2>/dev/null"
        );
    }

    #[test]
    fn posix_plan_custom_path() {
        let plan = posix_install_plan("/opt/termihub-agent", UPLOAD_DIR);
        assert!(plan.install_command.contains("/opt/termihub-agent"));
        assert!(plan
            .verify_command
            .starts_with("/opt/termihub-agent --version"));
    }

    #[test]
    fn prepare_command_makes_a_fresh_private_dir_not_a_fixed_tmp_name() {
        let cmd = POSIX_PREPARE_UPLOAD_DIR_COMMAND;
        assert!(
            cmd.starts_with("sh -c '"),
            "must not depend on the login shell"
        );
        assert!(cmd.contains("umask 077"));
        assert!(cmd.contains("chmod 700"));
        assert!(cmd.contains("mktemp -d"));
        assert!(cmd.contains("termihub-agent/updates"));
        assert!(!cmd.contains("/tmp"), "no world-shared location: {cmd}");
        // The inner script is single-quoted, so it must not contain a quote.
        assert_eq!(cmd.matches('\'').count(), 2);
    }

    #[test]
    fn parse_prepared_upload_dir_takes_the_last_line() {
        let out = format!("Welcome to host\n\n{UPLOAD_DIR}\n");
        assert_eq!(parse_prepared_upload_dir(&out).unwrap(), UPLOAD_DIR);
        let mac = "/Users/me/Library/Application Support/termihub-agent/updates/upload.x1Y2z3";
        assert_eq!(parse_prepared_upload_dir(mac).unwrap(), mac);
    }

    #[test]
    fn parse_prepared_upload_dir_rejects_anything_unexpected() {
        for bad in [
            "",
            "mktemp: failed",
            "relative/termihub-agent/updates/upload.abc",
            "/tmp/termihub-agent-upload",
            "/home/me/.config/termihub-agent/updates",
            "/home/it's/.config/termihub-agent/updates/upload.abc",
            "/home/$me/.config/termihub-agent/updates/upload.abc",
            "/home/me/.config/termihub-agent/updates/upload.abc/../../x",
        ] {
            assert!(
                parse_prepared_upload_dir(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    /// Run the real prepare command through `sh` with a fake `$HOME`.
    #[cfg(unix)]
    fn run_prepare(home: &std::path::Path, xdg: Option<&std::path::Path>) -> String {
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c")
            .arg(POSIX_PREPARE_UPLOAD_DIR_COMMAND)
            .env("HOME", home)
            .env_remove("XDG_CONFIG_HOME");
        if let Some(xdg) = xdg {
            cmd.env("XDG_CONFIG_HOME", xdg);
        }
        let out = cmd.output().expect("run sh");
        assert!(out.status.success(), "{out:?}");
        parse_prepared_upload_dir(&String::from_utf8_lossy(&out.stdout)).expect("valid dir")
    }

    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[cfg(unix)]
    #[test]
    fn prepare_command_creates_unique_owner_only_dirs_in_the_agent_config() {
        let home = tempfile::tempdir().unwrap();
        let a = run_prepare(home.path(), None);
        let b = run_prepare(home.path(), None);
        assert_ne!(a, b, "each upload gets its own dir");

        let config = if cfg!(target_os = "macos") {
            home.path().join("Library/Application Support")
        } else {
            home.path().join(".config")
        };
        let updates = config.join("termihub-agent").join("updates");
        for dir in [&a, &b] {
            let dir = std::path::Path::new(dir);
            assert_eq!(dir.parent().unwrap(), updates);
            assert_eq!(mode_of(dir), 0o700, "{} must be 0700", dir.display());
        }
        assert_eq!(mode_of(&updates), 0o700, "the updates dir must be 0700");
    }

    #[cfg(unix)]
    #[test]
    fn prepare_command_honours_xdg_config_home_like_the_agent() {
        let home = tempfile::tempdir().unwrap();
        let xdg = home.path().join("xdg");
        let dir = run_prepare(home.path(), Some(&xdg));
        assert!(
            std::path::Path::new(&dir).starts_with(xdg.join("termihub-agent").join("updates")),
            "{dir}"
        );
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
            for cmd in [
                &plan.backup_verify_command,
                &plan.backup_command,
                &plan.restore_command,
                &plan.discard_backup_command,
                &plan.install_command,
                plan.cleanup_stale_command.as_ref().unwrap(),
            ] {
                assert!(!cmd.contains("2>/dev/null"), "{cmd}");
                assert!(!cmd.contains("$HOME"), "{cmd}");
            }
        }
    }

    // ── Previous-binary backup / restore (#5207) ───────────────────────

    #[test]
    fn posix_plan_backs_up_and_restores_the_previous_binary() {
        let plan = posix_install_plan(".local/bin/termihub-agent", UPLOAD_DIR);
        assert_eq!(plan.backup_path, ".local/bin/termihub-agent.previous");
        assert_eq!(
            plan.backup_command,
            "cp -pf .local/bin/termihub-agent .local/bin/termihub-agent.previous",
            "a copy keeps the install path populated and preserves +x"
        );
        assert_eq!(
            plan.restore_command,
            "mv -f .local/bin/termihub-agent.previous .local/bin/termihub-agent"
        );
        assert_eq!(
            plan.discard_backup_command,
            "rm -f .local/bin/termihub-agent.previous"
        );
        assert_eq!(
            plan.backup_verify_command,
            ".local/bin/termihub-agent.previous --version 2>/dev/null"
        );
    }

    #[test]
    fn posix_plan_backup_follows_a_custom_path() {
        let plan = posix_install_plan("/opt/termihub-agent", UPLOAD_DIR);
        assert_eq!(plan.backup_path, "/opt/termihub-agent.previous");
        assert!(plan
            .restore_command
            .ends_with("/opt/termihub-agent.previous /opt/termihub-agent"));
    }

    #[test]
    fn windows_cmd_plan_backs_up_and_restores_the_previous_binary() {
        let plan = windows_install_plan(WindowsShell::Cmd);
        let dst = r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe";
        let bak = r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.previous.exe";
        let stale = r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.stale-%RANDOM%%RANDOM%.exe";
        let free_bak = format!(
            r#"(if exist "{bak}" del /F /Q "{bak}" >nul 2>&1) & (if exist "{bak}" move /Y "{bak}" "{stale}" >nul)"#
        );
        assert_eq!(plan.backup_path, bak);
        // Still a copy: the install path keeps a runnable agent until the
        // install command itself runs.
        assert_eq!(
            plan.backup_command,
            format!(r#"{free_bak} & copy /Y "{dst}" "{bak}""#)
        );
        assert_eq!(plan.restore_command, format!(r#"move /Y "{bak}" "{dst}""#));
        assert_eq!(plan.discard_backup_command, free_bak);
        assert_eq!(plan.backup_verify_command, format!(r#""{bak}" --version"#));
    }

    #[test]
    fn windows_powershell_plan_backs_up_and_restores_the_previous_binary() {
        let plan = windows_install_plan(WindowsShell::PowerShell);
        let dst = r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe";
        let bak = r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.previous.exe";
        let stale = r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.stale-";
        let free_bak = format!(
            r#"if (Test-Path -Path "{bak}") {{ Remove-Item -Force -ErrorAction SilentlyContinue -Path "{bak}" }}; if (Test-Path -Path "{bak}") {{ Move-Item -Force -ErrorAction Stop -Path "{bak}" -Destination ("{stale}" + [guid]::NewGuid().ToString('N') + '.exe') }}"#
        );
        assert_eq!(plan.backup_path, bak);
        assert_eq!(
            plan.backup_command,
            format!(
                r#"{free_bak}; Copy-Item -Force -ErrorAction Stop -Path "{dst}" -Destination "{bak}""#
            )
        );
        assert_eq!(
            plan.restore_command,
            format!(r#"Move-Item -Force -ErrorAction Stop -Path "{bak}" -Destination "{dst}""#)
        );
        assert_eq!(plan.discard_backup_command, free_bak);
        // PowerShell needs the call operator to launch a quoted path.
        assert_eq!(
            plan.backup_verify_command,
            format!(r#"& "{bak}" --version"#)
        );
    }

    // ── Replacing a running exe (#5254) ────────────────────────────────

    #[test]
    fn windows_cmd_install_renames_a_running_exe_aside_before_the_move() {
        let plan = windows_install_plan(WindowsShell::Cmd);
        let dir = r"%LOCALAPPDATA%\termiHub\agent";
        let dst = format!(r"{dir}\termihub-agent.exe");
        let src = r"%USERPROFILE%\termihub-agent-upload.exe";
        assert_eq!(
            plan.install_command,
            format!(
                r#"(if not exist "{dir}" md "{dir}") & (if exist "{dst}" move /Y "{dst}" "{dir}\termihub-agent.stale-%RANDOM%%RANDOM%.exe" >nul) & move /Y "{src}" "{dst}""#
            )
        );
        // The upload move is last, so its exit status is the command's.
        assert!(plan
            .install_command
            .ends_with(&format!(r#"move /Y "{src}" "{dst}""#)));
    }

    #[test]
    fn windows_powershell_install_renames_a_running_exe_aside_before_the_move() {
        let plan = windows_install_plan(WindowsShell::PowerShell);
        let dir = r"$env:LOCALAPPDATA\termiHub\agent";
        let dst = format!(r"{dir}\termihub-agent.exe");
        let src = r"$env:USERPROFILE\termihub-agent-upload.exe";
        assert_eq!(
            plan.install_command,
            format!(
                r#"New-Item -ItemType Directory -Force -Path "{dir}" | Out-Null; if (Test-Path -Path "{dst}") {{ Move-Item -Force -ErrorAction Stop -Path "{dst}" -Destination ("{dir}\termihub-agent.stale-" + [guid]::NewGuid().ToString('N') + '.exe') }}; Move-Item -Force -Path "{src}" -Destination "{dst}""#
            )
        );
    }

    #[test]
    fn windows_set_aside_stays_in_the_install_dir() {
        for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
            let plan = windows_install_plan(shell);
            let cmd = windows_set_aside_command(shell, &plan.install_path);
            let dir = plan.install_path.rsplit_once('\\').unwrap().0;
            assert!(
                cmd.contains(&format!(r"{dir}\{WINDOWS_STALE_PREFIX}")),
                "a sibling rename never crosses a volume: {cmd}"
            );
            assert!(cmd.contains(&plan.install_path), "{cmd}");
        }
    }

    #[test]
    fn windows_cleanup_only_matches_stale_images() {
        assert_eq!(
            windows_cleanup_stale_command(WindowsShell::Cmd),
            r#"if exist "%LOCALAPPDATA%\termiHub\agent\termihub-agent.stale-*.exe" del /F /Q "%LOCALAPPDATA%\termiHub\agent\termihub-agent.stale-*.exe" >nul 2>&1"#
        );
        assert_eq!(
            windows_cleanup_stale_command(WindowsShell::PowerShell),
            r#"Get-ChildItem -Path "$env:LOCALAPPDATA\termiHub\agent" -Filter "termihub-agent.stale-*.exe" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue"#
        );
        for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
            let plan = windows_install_plan(shell);
            assert_eq!(
                plan.cleanup_stale_command.as_deref(),
                Some(windows_cleanup_stale_command(shell).as_str())
            );
            let cmd = windows_cleanup_stale_command(shell);
            // The pattern can match neither the install nor the backup.
            assert!(!cmd.contains(WINDOWS_AGENT_EXE), "{cmd}");
            assert!(!cmd.contains(WINDOWS_BACKUP_EXE), "{cmd}");
            assert!(!WINDOWS_AGENT_EXE.starts_with(WINDOWS_STALE_PREFIX));
            assert!(!WINDOWS_BACKUP_EXE.starts_with(WINDOWS_STALE_PREFIX));
        }
    }

    #[test]
    fn posix_plan_has_no_stale_cleanup() {
        assert_eq!(
            posix_install_plan(".local/bin/termihub-agent", UPLOAD_DIR).cleanup_stale_command,
            None
        );
    }

    #[test]
    fn windows_backup_keeps_an_exe_extension_so_it_can_be_run() {
        for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
            assert!(windows_install_plan(shell).backup_path.ends_with(".exe"));
        }
    }
}

#[cfg(test)]
#[path = "agent_install_encoded_tests.rs"]
mod encoded_tests;

#[cfg(test)]
#[path = "agent_install_path_tests.rs"]
mod path_tests;
