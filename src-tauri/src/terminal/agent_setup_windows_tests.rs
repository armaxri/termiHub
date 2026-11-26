//! The Windows setup script never loses a working agent (#5996).
//!
//! Static checks for the typed lines of every login shell, and, when `pwsh` is
//! installed, real runs of the script, the recovery and the host check in a
//! scratch dir with a scratch `HOME` (never the user's profile or history). The
//! script is made to fail, and is killed, before every single step. What only
//! Windows can show (a running image, ConPTY, Windows PowerShell 5.1) is graded
//! by `windows_ssh_host_tests/setup_outcome.rs`.

use super::*;

const CMD: WindowsDeployShell = WindowsDeployShell::Native(WindowsShell::Cmd);
const POWERSHELL: WindowsDeployShell = WindowsDeployShell::Native(WindowsShell::PowerShell);
const ENCODED: WindowsDeployShell = WindowsDeployShell::EncodedPowerShell;

/// What an `-EncodedCommand` line runs.
fn decoded(line: &str) -> String {
    use base64::Engine;
    let b64 = line
        .split_whitespace()
        .skip_while(|w| *w != "-EncodedCommand")
        .nth(1)
        .unwrap_or_else(|| panic!("no -EncodedCommand in {line}"))
        // PowerShell's own `;` before `exit` follows the command.
        .trim_end_matches(';');
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap();
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).unwrap()
}

#[test]
fn every_shell_types_one_line_that_runs_the_script_and_ends_the_shell() {
    for (shell, exit) in [
        (CMD, " & exit"),
        (POWERSHELL, "; exit $LASTEXITCODE"),
        (ENCODED, "; exit $?"),
    ] {
        let lines = windows_setup_lines(shell);
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert!(
            line.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "),
            "{line}"
        );
        assert!(line.ends_with(exit), "{line}");
        // CR is Enter: LF leaves the line unfinished in PSReadLine (#5992).
        assert_eq!(windows_setup_input(shell), [format!("{line}\r")]);
    }
}

/// #6001: an execution policy of AllSigned set by group policy wins over
/// `-ExecutionPolicy Bypass` and refuses an unsigned script *file*. The line
/// runs no script file: it reads the uploaded script and runs its text, which
/// no execution policy checks. Its spelling is the same from every shell.
#[test]
fn the_setup_runs_no_script_file_an_execution_policy_could_refuse() {
    let lines: Vec<String> = [CMD, POWERSHELL, ENCODED]
        .into_iter()
        .flat_map(windows_setup_lines)
        .collect();
    for line in &lines {
        assert!(!line.contains("-File"), "{line}");
        assert!(!line.contains("-ExecutionPolicy"), "{line}");
        assert!(!line.contains(".ps1"), "{line}");
    }
    let run = decoded(&lines[0]);
    assert!(run.contains("[scriptblock]::Create"), "{run}");
    assert!(run.contains("ReadAllText"), "{run}");
    assert!(run.contains("$env:USERPROFILE"), "{run}");
    assert!(run.contains(WINDOWS_SETUP_SCRIPT_NAME), "{run}");
    assert!(run.is_ascii(), "{run}");
    for line in &lines[1..] {
        assert_eq!(decoded(line), run, "one command for every shell");
    }
}

#[test]
fn nothing_typed_or_uploaded_is_posix_or_overwrites_a_file() {
    let script = windows_setup_script();
    for text in [script.clone(), recover_script()] {
        assert!(text.is_ascii() && !text.contains("__"), "{text}");
        for line in text.lines().filter(|l| l.contains("Move-Item")) {
            assert!(!line.contains("Move-Item -Force"), "{line}");
        }
        assert!(!text.contains("Copy-Item"));
    }
    // Windows PowerShell 5.1 has none of these.
    for newer in ["&&", "||", "??", "?."] {
        assert!(!script.contains(newer), "{newer}");
    }
}

#[test]
fn the_new_agent_is_proven_before_the_installed_one_is_touched() {
    let at = |part: &str| {
        INSTALL_STEPS
            .iter()
            .position(|s| s.contains(part))
            .unwrap_or_else(|| panic!("no step {part}"))
    };
    let proven = at("Test-Agent $new");
    let away = at("Move-Item -LiteralPath $dst -Destination $bak");
    let swapped = at("Move-Item -LiteralPath $new -Destination $dst");
    assert!(proven < away);
    // Nothing between the two renames.
    assert_eq!(swapped, away + 1);
}

#[test]
fn the_recovery_fits_the_command_line_of_cmd() {
    let len = windows_recover_command().len();
    assert!(len < 8000, "{len}");
}

#[test]
fn a_message_typed_into_a_windows_tab_cannot_run_anything() {
    assert_eq!(
        windows_echo_input("Agent setup failed: C:/x not found, retry."),
        "echo 'Agent setup failed: C:/x not found, retry.'\r"
    );
    let hostile = "a'; & calc | b\r\ncalc $(id) `id` %PATH% ^ \"x\" <y >z !q \u{2019}; rm";
    let typed = windows_echo_input(hostile);
    let text = typed
        .strip_prefix("echo '")
        .and_then(|t| t.strip_suffix("'\r"))
        .expect("one echo line");
    assert!(
        text.chars()
            .all(|c| c.is_ascii_alphanumeric() || ".,:_-/ ".contains(c)),
        "{typed:?}"
    );
}

/// Runs under a local `pwsh` with a scratch profile.
#[cfg(unix)]
mod executed {
    use super::*;
    use crate::terminal::agent_setup_outcome::{
        parse_check, sha256_hex, windows_check_command, HostCheck,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const OLD: &str = "#!/bin/sh\necho termihub-agent 1.0.0\n";
    const NEW: &str = "#!/bin/sh\necho termihub-agent 2.0.0\n";
    const BROKEN: &str = "#!/bin/sh\necho termihub-agent 2.0.0\nexit 3\n";
    /// Starts under the staged name only: the verify after the install fails.
    const FAILS_INSTALLED: &str =
        "#!/bin/sh\necho termihub-agent 2.0.0\ncase \"$0\" in *.new.exe) ;; *) exit 3 ;; esac\n";
    const THROW: &str = "throw 'injected'";
    const KILL: &str = "[Diagnostics.Process]::GetCurrentProcess().Kill()";

    fn pwsh() -> Option<PathBuf> {
        let found = [
            "/usr/local/bin/pwsh",
            "/opt/homebrew/bin/pwsh",
            "/usr/bin/pwsh",
            "/snap/bin/pwsh",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists());
        if found.is_none() {
            eprintln!("pwsh not installed: skipping");
        }
        found
    }

    fn write_exec(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A fake Windows host whose `powershell.exe` is the local `pwsh`.
    struct Host {
        dir: tempfile::TempDir,
    }

    impl Host {
        fn new(pwsh: &Path) -> Self {
            let host = Self {
                dir: tempfile::tempdir().unwrap(),
            };
            for sub in [
                "home",
                "lad/termiHub/agent",
                "xdg/data",
                "xdg/config",
                "xdg/cache",
                "bin",
            ] {
                std::fs::create_dir_all(host.path(sub)).unwrap();
            }
            std::os::unix::fs::symlink(pwsh, host.path("bin/powershell.exe")).unwrap();
            host
        }

        /// A host with `OLD` installed and `upload` staged.
        fn update(pwsh: &Path, upload: &str) -> Self {
            let host = Self::new(pwsh);
            host.put("termihub-agent.exe", OLD);
            host.stage(upload);
            host
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.dir.path().join(rel)
        }

        /// A file in the install dir.
        fn file(&self, name: &str) -> PathBuf {
            self.path("lad/termiHub/agent").join(name)
        }

        fn put(&self, name: &str, body: &str) {
            write_exec(&self.file(name), body);
        }

        fn read(&self, name: &str) -> Option<String> {
            std::fs::read_to_string(self.file(name)).ok()
        }

        fn stage(&self, body: &str) {
            write_exec(&self.path("home").join(WINDOWS_UPLOAD_NAME), body);
        }

        /// Run one command line as the host's login shell does.
        fn sh(&self, line: &str) -> (Option<i32>, String) {
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(line)
                .env_clear()
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", self.path("bin").display()),
                )
                .env("HOME", self.path("home"))
                .env("USERPROFILE", self.path("home"))
                .env("LOCALAPPDATA", self.path("lad"))
                .env("XDG_DATA_HOME", self.path("xdg/data"))
                .env("XDG_CONFIG_HOME", self.path("xdg/config"))
                .env("XDG_CACHE_HOME", self.path("xdg/cache"))
                .env("HISTFILE", self.path("home/.history"))
                .env("POWERSHELL_TELEMETRY_OPTOUT", "1")
                .env("POWERSHELL_UPDATECHECK", "Off")
                .env("LANG", "C")
                .current_dir(self.path("home"))
                .output()
                .unwrap();
            let text = [out.stdout, out.stderr].concat();
            (
                out.status.code(),
                String::from_utf8_lossy(&text).into_owned(),
            )
        }

        /// Upload `script` and run it.
        fn setup(&self, script: &str) -> (Option<i32>, String) {
            let path = self.path("home").join(WINDOWS_SETUP_SCRIPT_NAME);
            std::fs::write(&path, script).unwrap();
            self.sh(&format!(
                "exec powershell.exe -NoLogo -NoProfile -NonInteractive -File '{}'",
                path.display()
            ))
        }

        fn recover(&self) -> String {
            self.sh(&windows_recover_command()).1
        }

        fn check(&self, uploaded: &str) -> HostCheck {
            parse_check(
                &self.sh(&windows_check_command()).1,
                &sha256_hex(uploaded.as_bytes()),
            )
        }

        /// The installed agent is `body`, nothing else is left behind.
        fn assert_only(&self, body: &str, what: &str) {
            assert_eq!(
                self.read("termihub-agent.exe").as_deref(),
                Some(body),
                "{what}"
            );
            let mut left: Vec<String> = std::fs::read_dir(self.path("lad/termiHub/agent"))
                .unwrap()
                .chain(std::fs::read_dir(self.path("home")).unwrap())
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .filter(|n| n.starts_with("termihub-agent"))
                .collect();
            left.sort();
            assert_eq!(
                left,
                ["termihub-agent.exe", "termihub-agent.lock"],
                "{what}"
            );
        }
    }

    /// The setup script with `fault` before step `at`.
    fn faulty(at: usize, fault: &str) -> String {
        let mut steps = INSTALL_STEPS.to_vec();
        steps.insert(at, fault);
        setup_script_of(&steps)
    }

    /// What must be installed when the setup stopped before step `at`.
    fn survivor(at: usize) -> &'static str {
        let swapped = INSTALL_STEPS
            .iter()
            .position(|s| s.contains("Move-Item -LiteralPath $new -Destination $dst"))
            .unwrap();
        if at <= swapped {
            OLD
        } else {
            NEW
        }
    }

    #[test]
    fn the_typed_line_runs_the_uploaded_script_and_passes_its_status_on() {
        let Some(pwsh) = pwsh() else { return };
        // A POSIX login shell (Git Bash) types the line as the setup does.
        let line = windows_setup_lines(ENCODED).remove(0);
        let script = windows_setup_script();
        let script_path = |host: &Host| host.path("home").join(WINDOWS_SETUP_SCRIPT_NAME);

        let host = Host::update(&pwsh, NEW);
        std::fs::write(script_path(&host), &script).unwrap();
        let (code, out) = host.sh(&line);
        assert_eq!(code, Some(0), "{out}");
        assert!(out.contains("Agent installed."), "{out}");
        host.assert_only(NEW, "installed through the typed line");

        let host = Host::update(&pwsh, BROKEN);
        std::fs::write(script_path(&host), &script).unwrap();
        let (code, out) = host.sh(&line);
        assert_eq!(
            code,
            Some(1),
            "a failed setup ends the shell with its failure: {out}"
        );
        assert_eq!(
            host.read("termihub-agent.exe").as_deref(),
            Some(OLD),
            "{out}"
        );
    }

    #[test]
    fn a_working_update_replaces_the_agent_and_leaves_no_copies() {
        let Some(pwsh) = pwsh() else { return };
        let host = Host::update(&pwsh, NEW);
        let (status, out) = host.setup(&windows_setup_script());
        assert_eq!(status, Some(0), "{out}");
        assert!(out.contains("Agent installed."), "{out}");
        host.assert_only(NEW, &out);
        assert_eq!(host.check(NEW), HostCheck::Installed);
        // Also as the first install, into a profile without the folder.
        let host = Host::new(&pwsh);
        std::fs::remove_dir_all(host.path("lad/termiHub")).unwrap();
        host.stage(NEW);
        let (status, out) = host.setup(&windows_setup_script());
        assert_eq!(status, Some(0), "{out}");
        host.assert_only(NEW, &out);
    }

    #[test]
    fn an_update_that_cannot_work_keeps_the_previous_agent() {
        let Some(pwsh) = pwsh() else { return };
        for (upload, error) in [
            (Some(BROKEN), "does not start on this host"),
            (
                Some("#!/nonexistent/interpreter\n"),
                "does not start on this host",
            ),
            (Some(FAILS_INSTALLED), "The installed agent does not start"),
            (None, "[error]"),
        ] {
            let host = Host::update(&pwsh, upload.unwrap_or_default());
            if upload.is_none() {
                std::fs::remove_file(host.path("home").join(WINDOWS_UPLOAD_NAME)).unwrap();
            }
            let (status, out) = host.setup(&windows_setup_script());
            assert_eq!(status, Some(1), "{upload:?}: {out}");
            assert!(out.contains(error), "{upload:?}: {out}");
            assert!(
                out.contains("previously installed agent is still in place"),
                "{out}"
            );
            host.assert_only(OLD, &out);
            assert_eq!(host.check(upload.unwrap_or("x")), HostCheck::PreviousRuns);
        }
    }

    #[test]
    fn a_failure_before_any_step_keeps_a_working_agent() {
        let Some(pwsh) = pwsh() else { return };
        for at in 0..=INSTALL_STEPS.len() {
            let host = Host::update(&pwsh, NEW);
            let (status, out) = host.setup(&faulty(at, THROW));
            assert_eq!(status, Some(1), "step {at}: {out}");
            host.assert_only(survivor(at), &format!("step {at}: {out}"));
        }
    }

    #[test]
    fn a_setup_killed_before_any_step_is_recovered() {
        let Some(pwsh) = pwsh() else { return };
        let mut without_agent = Vec::new();
        for at in 0..=INSTALL_STEPS.len() {
            let host = Host::update(&pwsh, NEW);
            let (status, out) = host.setup(&faulty(at, KILL));
            assert_eq!(status, None, "step {at} must die by a signal: {out}");
            if host.read("termihub-agent.exe").is_none() {
                without_agent.push(at);
                // What the next deploy restores too (#5207).
                assert_eq!(
                    host.read("termihub-agent.previous.exe").as_deref(),
                    Some(OLD)
                );
            }
            let out = host.recover();
            host.assert_only(survivor(at), &format!("step {at}: {out}"));
        }
        assert_eq!(without_agent.len(), 1, "{without_agent:?}");
    }

    #[test]
    fn the_next_setup_recovers_a_killed_one_even_when_it_fails_itself() {
        let Some(pwsh) = pwsh() else { return };
        for at in 0..=INSTALL_STEPS.len() {
            let host = Host::update(&pwsh, NEW);
            host.setup(&faulty(at, KILL));
            if at % 2 == 0 {
                host.stage(NEW);
                let (status, out) = host.setup(&windows_setup_script());
                assert_eq!(status, Some(0), "step {at}: {out}");
                host.assert_only(NEW, &format!("step {at}: {out}"));
            } else {
                host.stage(BROKEN);
                let (status, out) = host.setup(&windows_setup_script());
                assert_eq!(status, Some(1), "step {at}: {out}");
                host.assert_only(survivor(at), &format!("step {at}: {out}"));
            }
        }
    }

    #[test]
    fn a_setup_puts_a_leftover_agent_back_before_it_starts() {
        let Some(pwsh) = pwsh() else { return };
        // A broken install next to the last working agent, and an update that
        // fails too: without the restore up front the copy would be moved away.
        let host = Host::update(&pwsh, FAILS_INSTALLED);
        host.put("termihub-agent.exe", BROKEN);
        host.put("termihub-agent.previous.exe", OLD);
        let (status, out) = host.setup(&windows_setup_script());
        assert_eq!(status, Some(1), "{out}");
        host.assert_only(OLD, &out);
    }

    #[test]
    fn a_recovery_never_replaces_an_agent_that_starts() {
        let Some(pwsh) = pwsh() else { return };
        let host = Host::new(&pwsh);
        host.put("termihub-agent.exe", NEW);
        host.put("termihub-agent.previous.exe", OLD);
        host.put("termihub-agent.stale-1.exe", OLD);
        let out = host.recover();
        host.assert_only(NEW, &out);
        // Nothing installed at all: nothing to do, and no folder is made.
        let host = Host::new(&pwsh);
        std::fs::remove_dir_all(host.path("lad/termiHub")).unwrap();
        host.recover();
        assert!(!host.path("lad/termiHub").exists());
    }

    #[test]
    fn leftover_copies_are_used_only_when_they_are_needed() {
        let Some(pwsh) = pwsh() else { return };
        // A broken install next to the previous agent.
        let host = Host::new(&pwsh);
        host.put("termihub-agent.exe", BROKEN);
        host.put("termihub-agent.previous.exe", OLD);
        let out = host.recover();
        host.assert_only(OLD, &out);
        // No install and only a stale copy: what an older setup left behind.
        let host = Host::new(&pwsh);
        host.put("termihub-agent.stale-1.exe", OLD);
        let out = host.recover();
        host.assert_only(OLD, &out);
        // A stale copy never replaces an installed file, and is not deleted
        // while that file does not start.
        let host = Host::new(&pwsh);
        host.put("termihub-agent.exe", BROKEN);
        host.put("termihub-agent.stale-1.exe", OLD);
        host.recover();
        assert_eq!(host.read("termihub-agent.exe").as_deref(), Some(BROKEN));
        assert_eq!(
            host.read("termihub-agent.stale-1.exe").as_deref(),
            Some(OLD)
        );
    }

    #[test]
    fn a_running_setup_keeps_every_other_one_out() {
        let Some(pwsh) = pwsh() else { return };
        let host = Host::update(&pwsh, NEW);
        let lock = std::fs::File::create(host.file(WINDOWS_LOCK_NAME)).unwrap();
        lock.lock().unwrap();
        let recover = fill(&format!(
            "{LIBRARY}{}",
            RECOVER.replace("Lock-Setup 10", "Lock-Setup 0")
        ));
        let out = host.sh(&powershell_encoded_command(&recover)).1;
        assert!(out.lines().any(|l| l.trim() == RECOVER_BUSY), "{out}");
        let script = windows_setup_script().replace("Lock-Setup 30", "Lock-Setup 0");
        let (status, out) = host.setup(&script);
        assert_eq!(status, Some(1), "{out}");
        assert!(out.contains("could not be locked"), "{out}");
        assert_eq!(host.read("termihub-agent.exe").as_deref(), Some(OLD));
        // Its upload is the other setup's: left alone.
        assert!(host.path("home").join(WINDOWS_UPLOAD_NAME).exists());
        drop(lock);
        host.recover();
        host.assert_only(OLD, "after the lock is free");
    }

    #[test]
    fn the_host_check_tells_the_uploaded_agent_from_every_other_state() {
        let Some(pwsh) = pwsh() else { return };
        // The same version, other bytes: what a failed update leaves in place.
        let same_version = "#!/bin/sh\n# old build\necho termihub-agent 2.0.0\n";
        let alien = "#!/bin/sh\necho something else\n";
        for (installed, uploaded, want) in [
            (Some(NEW), NEW, HostCheck::Installed),
            (Some(same_version), NEW, HostCheck::PreviousRuns),
            (Some(BROKEN), NEW, HostCheck::OtherBinary),
            (None, NEW, HostCheck::Absent),
            (Some(BROKEN), BROKEN, HostCheck::DoesNotRun),
            (Some(alien), alien, HostCheck::DoesNotRun),
        ] {
            let host = Host::new(&pwsh);
            if let Some(body) = installed {
                host.put("termihub-agent.exe", body);
            }
            assert_eq!(host.check(uploaded), want, "{installed:?} / {uploaded:?}");
        }
    }
}
