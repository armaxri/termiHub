//! The lines a Windows agent setup types into its tab (#5946, #5992).
//!
//! They end with `exit`, so the tab's shell ends when the setup does; the host
//! check of `agent_setup_outcome` then decides how it went (Windows does not
//! report the shell's own status reliably). These tests pin the lines for every
//! Windows login shell and, when `pwsh` is installed, execute the PowerShell
//! lines, their encoded form through `sh` (as Git Bash runs it) and the host
//! check in a scratch dir with a scratch `HOME`, never the user's profile or
//! history.

use super::*;
use crate::terminal::agent_install::{
    powershell_encoded_command, windows_install_plan, WindowsDeployShell, WindowsShell,
};
use crate::terminal::agent_setup_outcome::{parse_check, windows_check_command, HostCheck};

const CMD: WindowsDeployShell = WindowsDeployShell::Native(WindowsShell::Cmd);
const POWERSHELL: WindowsDeployShell = WindowsDeployShell::Native(WindowsShell::PowerShell);
const ENCODED: WindowsDeployShell = WindowsDeployShell::EncodedPowerShell;

/// Decode the script of a `powershell.exe … -EncodedCommand <base64>` line.
fn decode_encoded(line: &str) -> String {
    use base64::Engine;
    let b64 = line
        .split("-EncodedCommand ")
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .expect("an -EncodedCommand line");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .unwrap();
    let utf16: Vec<u16> = bytes
        .chunks(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&utf16).unwrap()
}

#[test]
fn every_windows_setup_ends_by_exiting_with_its_status() {
    let powershell = windows_setup_lines(POWERSHELL);
    assert!(powershell
        .last()
        .unwrap()
        .ends_with("; exit $termihubSetupStatus"));
    let cmd = windows_setup_lines(CMD);
    assert_eq!(cmd.last().unwrap(), "exit %TERMIHUB_SETUP_STATUS%");
    let encoded = windows_setup_lines(ENCODED);
    assert!(encoded.last().unwrap().ends_with("; exit $?"));
}

#[test]
fn every_line_is_typed_with_the_enter_key_of_a_windows_console() {
    // LF is Ctrl+Enter for PSReadLine: the line would never run (#5992).
    for shell in [CMD, POWERSHELL, ENCODED] {
        let typed = windows_setup_input(shell);
        assert_eq!(typed.len(), windows_setup_lines(shell).len());
        for line in typed {
            assert!(line.ends_with('\r') && !line.contains('\n'), "{line:?}");
        }
    }
}

#[test]
fn every_line_is_one_plain_ascii_command_line() {
    for shell in [CMD, POWERSHELL, ENCODED] {
        for line in windows_setup_lines(shell) {
            assert!(!line.contains(['\r', '\n']), "{shell:?}: {line:?}");
            assert!(line.is_ascii(), "{shell:?}: {line:?}");
        }
    }
}

#[test]
fn the_status_starts_failed_and_only_a_verified_install_clears_it() {
    let plan = windows_install_plan(WindowsShell::PowerShell);
    let lines = windows_setup_lines(POWERSHELL);
    let body = &lines[1];
    assert!(body.starts_with("$global:termihubSetupStatus = 1; "));
    let install = body.find(&plan.install_command).expect("install");
    let verify = body.find(&plan.verify_command).expect("verify");
    let cleared = body
        .find("$global:termihubSetupStatus = 0")
        .expect("cleared");
    assert!(install < verify && verify < cleared);
    assert!(body.contains("$ErrorActionPreference = 'Stop'"));
    assert!(body.contains("if ($LASTEXITCODE -ne 0) { throw"));

    let plan = windows_install_plan(WindowsShell::Cmd);
    let lines = windows_setup_lines(CMD);
    assert_eq!(lines[1], "set \"TERMIHUB_SETUP_STATUS=1\"");
    // Grouped: `&` inside the install chain binds looser than `&&`.
    assert_eq!(
        lines[2],
        format!(
            "({}) && ({}) && set \"TERMIHUB_SETUP_STATUS=0\"",
            plan.install_command, plan.verify_command
        )
    );
}

#[test]
fn the_stale_cleanup_runs_before_the_exit_and_never_sets_the_status() {
    for (shell, kind) in [
        (POWERSHELL, WindowsShell::PowerShell),
        (CMD, WindowsShell::Cmd),
    ] {
        let cleanup = windows_install_plan(kind).cleanup_stale_command.unwrap();
        let lines = windows_setup_lines(shell);
        let at = lines
            .iter()
            .position(|l| *l == cleanup)
            .expect("cleanup line");
        assert_eq!(at, lines.len() - 2 - usize::from(shell == CMD), "{shell:?}");
        assert!(!cleanup.contains("TERMIHUB_SETUP_STATUS") && !cleanup.contains("termihubSetup"));
    }
}

#[test]
fn the_encoded_form_carries_the_powershell_lines_as_one_script() {
    let lines = windows_setup_lines(ENCODED);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "echo === termiHub Agent Setup ===");
    let script = windows_setup_lines(POWERSHELL).join("\n");
    assert_eq!(
        lines[1],
        format!("{}; exit $?", powershell_encoded_command(&script))
    );
    assert_eq!(decode_encoded(&lines[1]), script);
}

#[test]
fn no_line_reads_the_output_to_decide_the_outcome() {
    // The outcome is the status of the commands, never a scrape of their text.
    for shell in [CMD, POWERSHELL] {
        for line in windows_setup_lines(shell) {
            for scrape in ["Select-String", "findstr", "-match", "-like", "find \""] {
                assert!(!line.contains(scrape), "{shell:?}: {line}");
            }
        }
    }
}

/// Runs the PowerShell lines under a local `pwsh` with a scratch profile.
#[cfg(unix)]
mod executed {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn pwsh() -> Option<PathBuf> {
        [
            "/usr/local/bin/pwsh",
            "/opt/homebrew/bin/pwsh",
            "/usr/bin/pwsh",
            "/snap/bin/pwsh",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
    }

    struct Host {
        dir: tempfile::TempDir,
    }

    impl Host {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            for sub in [
                "home",
                "localappdata",
                "xdg/data",
                "xdg/config",
                "xdg/cache",
                "bin",
            ] {
                std::fs::create_dir_all(dir.path().join(sub)).unwrap();
            }
            Self { dir }
        }
        fn path(&self, rel: &str) -> PathBuf {
            self.dir.path().join(rel)
        }
        fn upload(&self) -> PathBuf {
            self.path("home").join(agent_install::WINDOWS_UPLOAD_NAME)
        }
        fn installed(&self) -> PathBuf {
            self.path("localappdata/termiHub/agent")
                .join(agent_install::WINDOWS_AGENT_EXE)
        }
        /// Stage an uploaded "agent" whose `--version` exits with `code`.
        fn stage_upload(&self, code: i32) {
            write_exec(
                &self.upload(),
                &format!("#!/bin/sh\necho termihub-agent 1.2.3\nexit {code}\n"),
            );
        }
        fn command(&self, program: &Path) -> Command {
            let mut cmd = Command::new(program);
            cmd.env_clear()
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", self.path("bin").display()),
                )
                .env("HOME", self.path("home"))
                .env("USERPROFILE", self.path("home"))
                .env("LOCALAPPDATA", self.path("localappdata"))
                .env("XDG_DATA_HOME", self.path("xdg/data"))
                .env("XDG_CONFIG_HOME", self.path("xdg/config"))
                .env("XDG_CACHE_HOME", self.path("xdg/cache"))
                .env("HISTFILE", self.path("home/.history"))
                .env("POWERSHELL_TELEMETRY_OPTOUT", "1")
                .env("POWERSHELL_UPDATECHECK", "Off")
                .env("LANG", "C")
                .current_dir(self.path("home"));
            cmd
        }
    }

    fn write_exec(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    struct Run {
        status: i32,
        stdout: String,
    }

    /// Run the native PowerShell setup lines as one script file.
    fn run_powershell(pwsh: &Path, host: &Host) -> Run {
        let script = host.path("setup.ps1");
        std::fs::write(&script, windows_setup_lines(POWERSHELL).join("\n")).unwrap();
        let out = host
            .command(pwsh)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
            .arg(&script)
            .output()
            .unwrap();
        Run {
            status: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        }
    }

    fn last_line(text: &str) -> &str {
        text.lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
    }

    #[test]
    fn a_verified_install_exits_0() {
        let Some(pwsh) = pwsh() else {
            eprintln!("pwsh not installed: skipping");
            return;
        };
        let host = Host::new();
        host.stage_upload(0);
        let run = run_powershell(&pwsh, &host);
        assert_eq!(run.status, 0, "{}", run.stdout);
        assert!(
            run.stdout.contains("termihub-agent 1.2.3"),
            "{}",
            run.stdout
        );
        assert_eq!(last_line(&run.stdout), WINDOWS_SETUP_DONE);
        assert!(host.installed().exists());
        assert!(!host.upload().exists());
    }

    #[test]
    fn a_missing_upload_exits_1() {
        let Some(pwsh) = pwsh() else {
            eprintln!("pwsh not installed: skipping");
            return;
        };
        let host = Host::new();
        let run = run_powershell(&pwsh, &host);
        assert_eq!(run.status, 1, "{}", run.stdout);
        assert!(run.stdout.contains("[error] "), "{}", run.stdout);
        assert_eq!(last_line(&run.stdout), WINDOWS_SETUP_FAILED);
    }

    #[test]
    fn a_failing_version_check_exits_1() {
        let Some(pwsh) = pwsh() else {
            eprintln!("pwsh not installed: skipping");
            return;
        };
        let host = Host::new();
        host.stage_upload(3);
        let run = run_powershell(&pwsh, &host);
        assert_eq!(run.status, 1, "{}", run.stdout);
        assert!(
            run.stdout.contains("version check exited with code 3"),
            "{}",
            run.stdout
        );
        assert_eq!(last_line(&run.stdout), WINDOWS_SETUP_FAILED);
    }

    /// The encoded line, run by `sh` as Git Bash would, with `powershell.exe`
    /// standing for the local `pwsh`: the shell exits with the script's status.
    #[test]
    fn the_encoded_line_exits_its_shell_with_the_setup_status() {
        let Some(pwsh) = pwsh() else {
            eprintln!("pwsh not installed: skipping");
            return;
        };
        for (code, want) in [(0, 0), (5, 1)] {
            let host = Host::new();
            std::os::unix::fs::symlink(&pwsh, host.path("bin/powershell.exe")).unwrap();
            host.stage_upload(code);
            let line = windows_setup_lines(ENCODED).join("\n");
            let out = host
                .command(Path::new("/bin/sh"))
                .arg("-c")
                .arg(format!("{line}\necho not-reached"))
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert_eq!(out.status.code(), Some(want), "{stdout}");
            assert!(!stdout.contains("not-reached"), "{stdout}");
        }
    }

    /// Run the host check as `sh` would run its command line, with
    /// `powershell.exe` standing for the local `pwsh`.
    fn run_check(pwsh: &Path, host: &Host, uploaded: &[u8]) -> HostCheck {
        std::os::unix::fs::symlink(pwsh, host.path("bin/powershell.exe")).unwrap();
        let out = host
            .command(Path::new("/bin/sh"))
            .arg("-c")
            .arg(windows_check_command())
            .output()
            .unwrap();
        parse_check(&String::from_utf8_lossy(&out.stdout), &sha256_hex(uploaded))
    }

    fn install(host: &Host, body: &str) {
        std::fs::create_dir_all(host.installed().parent().unwrap()).unwrap();
        write_exec(&host.installed(), body);
    }

    #[test]
    fn the_host_check_tells_the_uploaded_agent_from_every_other_state() {
        let Some(pwsh) = pwsh() else {
            eprintln!("pwsh not installed: skipping");
            return;
        };
        let good = "#!/bin/sh\necho termihub-agent 1.2.3\n";
        // The same version, other bytes: what a failed update leaves in place.
        let old = "#!/bin/sh\n# old build\necho termihub-agent 1.2.3\n";
        let broken = "#!/bin/sh\necho termihub-agent 1.2.3\nexit 3\n";
        let alien = "#!/bin/sh\necho something else\n";
        let unstartable = "#!/nonexistent/interpreter\n";
        for (installed, uploaded, want) in [
            (Some(good), good, HostCheck::Installed),
            (Some(old), good, HostCheck::OtherBinary),
            (None, good, HostCheck::Absent),
            (Some(broken), broken, HostCheck::DoesNotRun),
            (Some(alien), alien, HostCheck::DoesNotRun),
            (Some(unstartable), unstartable, HostCheck::DoesNotRun),
        ] {
            let host = Host::new();
            if let Some(body) = installed {
                install(&host, body);
            }
            assert_eq!(
                run_check(&pwsh, &host, uploaded.as_bytes()),
                want,
                "installed {installed:?}, uploaded {uploaded:?}"
            );
        }
    }
}
