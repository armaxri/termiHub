//! The POSIX setup script never loses a working agent (#5999).
//!
//! The script runs under every POSIX shell here, in a scratch dir with a
//! scratch `HOME` and a `PATH` of its own (no `sudo`, no real `systemctl`). It
//! is made to fail, interrupted and killed at every `#@` point.

use super::*;

#[test]
fn the_uploaded_script_has_no_test_markers_or_placeholders() {
    let script = generate_setup_script("~/.local/bin/termihub-agent", true, "/up/a");
    assert!(SETUP_SCRIPT_TEMPLATE.lines().any(|l| l.trim() == "#@"));
    assert!(!script.lines().any(|l| l.trim() == "#@"));
    assert!(!script.contains("__"), "unfilled placeholder");
    assert!(script.ends_with('\n') && !script.contains('\r'));
}

#[test]
fn the_installed_agent_is_only_ever_replaced_by_a_rename() {
    for line in SETUP_SCRIPT_TEMPLATE.lines().map(str::trim) {
        if line.starts_with('#') {
            continue;
        }
        let writes_target = line.ends_with(" \"$TARGET\"")
            && ["cp ", "tee ", "cat "].iter().any(|c| line.contains(c));
        assert!(!writes_target && !line.contains("> \"$TARGET\""), "{line}");
    }
    let at = |part: &str| SETUP_SCRIPT_TEMPLATE.find(part).expect(part);
    let proven = at("VERSION_OUT=$(\"$NEW\" --version");
    let kept = at("mv -f \"$PREVIOUS.$$\" \"$PREVIOUS\"");
    let swapped = at("$SUDO mv -f \"$NEW\" \"$TARGET\"");
    let service = at("systemctl restart termihub-agent ||");
    assert!(proven < kept && kept < swapped && swapped < service);
}

/// Executes the script under each available POSIX shell.
#[cfg(unix)]
mod executed {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const OLD: &str = "#!/bin/sh\necho termihub-agent 1.0.0\n";
    const NEW: &str = "#!/bin/sh\necho termihub-agent 2.0.0\n";
    const OTHER: &str = "#!/bin/sh\necho termihub-agent 3.0.0\n";
    const BROKEN: &str = "#!/bin/sh\necho termihub-agent 2.0.0\nexit 3\n";
    const NOT_AN_AGENT: &str = "#!/bin/sh\necho hello\n";
    /// Starts under the staged name only: the verify after the swap fails.
    const FAILS_FINAL: &str =
        "#!/bin/sh\necho termihub-agent 2.0.0\ncase \"$0\" in *.new.*) ;; *) exit 3 ;; esac\n";
    const KEPT: Option<i32> = Some(EXIT_PREVIOUS_KEPT);

    /// The tools the script may use; no `sudo`, no `systemctl`.
    const TOOLS: &[&str] = &[
        "sh", "cat", "cp", "mv", "ln", "rm", "mkdir", "rmdir", "chmod", "dirname", "head", "cksum",
        "wc", "id", "readlink", "ps", "find", "tee",
    ];

    fn shells() -> Vec<&'static str> {
        let all = [
            "/bin/sh",
            "/bin/dash",
            "/usr/bin/dash",
            "/bin/bash",
            "/bin/ksh",
        ];
        all.into_iter().filter(|s| Path::new(s).exists()).collect()
    }

    fn write_exec(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn is_root() -> bool {
        let out = Command::new("id").arg("-u").output().unwrap();
        out.stdout.starts_with(b"0")
    }

    struct Host {
        dir: tempfile::TempDir,
        shell: &'static str,
    }

    impl Host {
        fn new(shell: &'static str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let host = Self { dir, shell };
            std::fs::create_dir_all(host.path("home")).unwrap();
            for tool in TOOLS {
                let real = ["/bin", "/usr/bin"]
                    .iter()
                    .map(|d| Path::new(d).join(tool))
                    .find(|p| p.exists())
                    .unwrap_or_else(|| panic!("no {tool} on this machine"));
                std::fs::create_dir_all(host.path("bin")).unwrap();
                symlink(real, host.path("bin").join(tool)).unwrap();
            }
            // Retries and flushes need no real waiting here.
            host.tool("sleep", "exit 0");
            host.tool("sync", "exit 0");
            host
        }

        /// A host with `OLD` installed and `upload` staged.
        fn update(shell: &'static str, upload: &str) -> Self {
            let host = Self::new(shell);
            write_exec(&host.target(), OLD);
            host.stage(upload);
            host
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.dir.path().join(rel)
        }

        fn target(&self) -> PathBuf {
            self.path("opt/termihub-agent")
        }

        fn file(&self, suffix: &str) -> PathBuf {
            self.path(&format!("opt/termihub-agent{suffix}"))
        }

        /// Replace a tool by a shell script.
        fn tool(&self, name: &str, body: &str) {
            let path = self.path("bin").join(name);
            let _ = std::fs::remove_file(&path);
            write_exec(&path, &format!("#!/bin/sh\n{body}\n"));
        }

        fn upload_dir(&self) -> PathBuf {
            self.path("home/.config/termihub-agent/updates/upload.Ab12Cd")
        }

        fn stage(&self, body: &str) {
            std::fs::create_dir_all(self.upload_dir()).unwrap();
            std::fs::write(self.upload_dir().join("termihub-agent"), body).unwrap();
        }

        fn script(&self, install: &Path, service: bool) -> String {
            fill_setup_script(
                install.to_str().unwrap(),
                if service { "true" } else { "false" },
                self.upload_dir().join("termihub-agent").to_str().unwrap(),
            )
            .replace(
                "UNIT_DIR=/etc/systemd/system",
                &format!("UNIT_DIR={}", self.path("units").display()),
            )
        }

        fn run(&self, script: &str) -> (Option<i32>, String) {
            self.run_as(script, "exec")
        }

        /// Run `script` after `prefix` in the same shell process.
        fn run_as(&self, script: &str, prefix: &str) -> (Option<i32>, String) {
            std::fs::create_dir_all(self.upload_dir()).unwrap();
            let path = self.upload_dir().join("setup.sh");
            std::fs::write(&path, script).unwrap();
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("{prefix} {} '{}'", self.shell, path.display()))
                .env_clear()
                .env("PATH", self.path("bin"))
                .env("HOME", self.path("home"))
                .env("HISTFILE", self.path("home/.history"))
                .env("LC_ALL", "C")
                .current_dir(self.path("home"))
                .output()
                .unwrap();
            // The script's own last line stays last.
            let text = [out.stderr, out.stdout].concat();
            (
                out.status.code(),
                String::from_utf8_lossy(&text).into_owned(),
            )
        }

        fn setup(&self) -> (Option<i32>, String) {
            self.run(&without_markers(&self.script(&self.target(), false)))
        }

        /// `body` is installed (or nothing is), with nothing next to it and no
        /// upload left.
        fn assert_only(&self, body: Option<&str>, what: &str) {
            let what = format!("{}: {what}", self.shell);
            assert_eq!(
                std::fs::read_to_string(self.target()).ok().as_deref(),
                body,
                "{what}"
            );
            let mut left: Vec<String> = std::fs::read_dir(self.path("opt"))
                .map(|d| {
                    d.map(|e| e.unwrap().file_name().into_string().unwrap())
                        .collect()
                })
                .unwrap_or_default();
            left.retain(|n| n != "termihub-agent");
            assert!(left.is_empty(), "left behind {left:?}: {what}");
            assert!(!self.upload_dir().exists(), "upload left: {what}");
        }

        fn starts(&self) -> bool {
            Command::new(self.target())
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success() && o.stdout.starts_with(b"termihub-agent "))
        }
    }

    fn last_line(text: &str) -> &str {
        text.lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
    }

    fn markers() -> usize {
        SETUP_SCRIPT_TEMPLATE
            .lines()
            .filter(|l| l.trim() == "#@")
            .count()
    }

    /// `script` with the `at`-th marker replaced by `fault`.
    fn faulty(script: &str, at: usize, fault: &str) -> String {
        let mut seen = 0;
        let mut out = String::new();
        for line in script.lines() {
            if line.trim() == "#@" {
                if seen == at {
                    out.push_str(fault);
                }
                seen += 1;
            } else {
                out.push_str(line);
            }
            out.push('\n');
        }
        out
    }

    /// Index of the marker in front of the first line starting with `line`.
    fn marker_before(line: &str) -> usize {
        let head = SETUP_SCRIPT_TEMPLATE.split(line).next().unwrap();
        head.lines().filter(|l| l.trim() == "#@").count() - 1
    }

    #[test]
    fn a_working_update_replaces_the_agent_and_leaves_no_copies() {
        for shell in shells() {
            let host = Host::update(shell, NEW);
            let (status, out) = host.setup();
            assert_eq!(status, Some(0), "{shell}: {out}");
            assert!(
                last_line(&out).starts_with("Agent v2.0.0 installed at "),
                "{out}"
            );
            host.assert_only(Some(NEW), &out);

            let host = Host::new(shell);
            host.stage(NEW);
            let (status, out) = host.setup();
            assert_eq!(status, Some(0), "{shell}: first install: {out}");
            host.assert_only(Some(NEW), &out);
            assert!(host.starts());
        }
    }

    #[test]
    fn an_update_that_cannot_work_keeps_the_previous_agent_and_says_so() {
        for shell in shells() {
            for (upload, error) in [
                (Some(BROKEN), "does not start on this host"),
                (Some(NOT_AN_AGENT), "is not a termiHub agent"),
                (Some(""), "does not start on this host"),
                (
                    Some("#!/nonexistent/interpreter\n"),
                    "does not start on this host",
                ),
                (Some(FAILS_FINAL), "does not start."),
                (None, "was not uploaded"),
            ] {
                let host = Host::update(shell, upload.unwrap_or_default());
                if upload.is_none() {
                    std::fs::remove_file(host.upload_dir().join("termihub-agent")).unwrap();
                }
                let before = std::fs::metadata(host.target()).unwrap();
                let (status, out) = host.setup();
                if upload == Some("") && status == Some(0) {
                    panic!("{shell}: an empty upload was installed: {out}");
                }
                assert!(out.contains("[error] "), "{shell} {upload:?}: {out}");
                assert!(
                    last_line(&out).starts_with("Agent setup failed: "),
                    "{shell} {upload:?}: {out}"
                );
                if upload != Some("") {
                    assert!(last_line(&out).contains(error), "{shell} {upload:?}: {out}");
                }
                host.assert_only(Some(OLD), &format!("{upload:?}: {out}"));
                use std::os::unix::fs::MetadataExt;
                let after = std::fs::metadata(host.target()).unwrap();
                assert_eq!(before.ino(), after.ino(), "the very same file");
                // Before the path is even looked at, nothing is known about it.
                if upload.is_some() {
                    assert_eq!(status, KEPT, "{shell} {upload:?}: {out}");
                    assert!(out.contains("The previous agent is still in place and starts."));
                } else {
                    assert_eq!(status, Some(1), "{out}");
                }
            }
        }
    }

    #[test]
    fn a_failure_or_signal_at_any_point_keeps_a_working_agent() {
        for shell in shells() {
            let mut faults = vec!["exit 7", "kill -HUP $$"];
            if shell == shells()[0] {
                faults.extend(["kill -INT $$", "kill -TERM $$"]);
            }
            for fault in faults {
                for at in 0..markers() {
                    let host = Host::update(shell, NEW);
                    let script = faulty(&host.script(&host.target(), false), at, fault);
                    let (status, out) = host.run(&script);
                    let what = format!("{fault} at {at}: {out}");
                    match status {
                        Some(0) => host.assert_only(Some(NEW), &what),
                        _ => {
                            assert_eq!(status, KEPT, "{shell}: {what}");
                            host.assert_only(Some(OLD), &what);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_failed_first_install_leaves_nothing() {
        for shell in shells() {
            for at in 0..markers() {
                let host = Host::new(shell);
                host.stage(NEW);
                let script = faulty(&host.script(&host.target(), false), at, "exit 7");
                let (status, out) = host.run(&script);
                let what = format!("at {at}: {out}");
                match status {
                    Some(0) => host.assert_only(Some(NEW), &what),
                    _ => {
                        assert_eq!(status, Some(1), "{shell}: {what}");
                        host.assert_only(None, &what);
                    }
                }
            }
            let host = Host::new(shell);
            host.stage(FAILS_FINAL);
            let (status, out) = host.setup();
            assert_eq!(status, Some(1), "{out}");
            host.assert_only(None, &out);
        }
    }

    #[test]
    fn a_kill_at_any_point_leaves_an_agent_that_starts_and_the_next_setup_cleans_up() {
        for shell in shells() {
            for at in 0..markers() {
                // Both follow-ups under the first shell, one of them elsewhere.
                let nexts = match (shell == shells()[0], at % 2) {
                    (true, _) => vec![NEW, BROKEN],
                    (_, 0) => vec![NEW],
                    _ => vec![BROKEN],
                };
                for next in nexts {
                    let host = Host::update(shell, NEW);
                    let script = faulty(&host.script(&host.target(), false), at, "kill -KILL $$");
                    let (status, out) = host.run(&script);
                    let what = format!("{shell} killed at {at}: {out}");
                    // There is an agent at the install path at every moment.
                    assert!(host.starts(), "{what}");
                    let survivor = std::fs::read_to_string(host.target()).unwrap();
                    assert!(survivor == OLD || survivor == NEW, "{what}");
                    assert!(status.is_none() || status == Some(0), "{what}");
                    host.stage(next);
                    let (status, out) = host.setup();
                    let what = format!("{what}\nthen {out}");
                    if next == NEW {
                        assert_eq!(status, Some(0), "{what}");
                        host.assert_only(Some(NEW), &what);
                    } else {
                        assert_eq!(status, KEPT, "{what}");
                        host.assert_only(Some(&survivor), &what);
                    }
                }
            }
        }
    }

    #[test]
    fn a_full_disk_keeps_the_previous_agent() {
        let big = |agent: &str| format!("{agent}{}", "# padding\n".repeat(30_000));
        for shell in shells() {
            // The new binary does not fit.
            let host = Host::update(shell, &big(NEW));
            let script = without_markers(&host.script(&host.target(), false));
            let (status, out) = host.run_as(&script, "ulimit -f 100; exec");
            assert_eq!(status, KEPT, "{shell}: {out}");
            assert!(last_line(&out).contains("could not be written"), "{out}");
            host.assert_only(Some(OLD), &out);

            // The copy of the old one does not fit, where links are not possible.
            let host = Host::update(shell, NEW);
            write_exec(&host.target(), &big(OLD));
            host.tool("ln", "exit 1");
            let script = without_markers(&host.script(&host.target(), false));
            let (status, out) = host.run_as(&script, "ulimit -f 100; exec");
            assert_eq!(status, KEPT, "{shell}: {out}");
            assert!(last_line(&out).contains("could not be kept"), "{out}");
            host.assert_only(Some(&big(OLD)), &out);
        }
    }

    #[test]
    fn incomplete_copies_are_noticed() {
        for shell in shells() {
            // A short write that nobody reported.
            let host = Host::update(shell, NEW);
            host.tool("tee", "head -c 35 >\"$1\"; cat >/dev/null");
            let (status, out) = host.setup();
            assert_eq!(status, KEPT, "{shell}: {out}");
            assert!(last_line(&out).contains("is not complete"), "{out}");
            host.assert_only(Some(OLD), &out);
            // The same for the copy of the installed agent.
            let host = Host::update(shell, NEW);
            host.tool("ln", "exit 1");
            let cp = ["/bin/cp", "/usr/bin/cp"];
            let cp = cp.iter().find(|p| Path::new(p).exists()).unwrap();
            host.tool(
                "cp",
                &format!(
                    "case \"$3\" in *.previous.*) head -c 5 \"$2\" >\"$3\" ;; *) exec {cp} \"$@\" ;; esac"
                ),
            );
            let (status, out) = host.setup();
            assert_eq!(status, KEPT, "{shell}: {out}");
            assert!(last_line(&out).contains("could not be kept"), "{out}");
            host.assert_only(Some(OLD), &out);
        }
    }

    #[test]
    fn without_hard_links_or_cksum_the_update_still_works_and_rolls_back() {
        for shell in shells() {
            for (upload, want, code) in [(NEW, NEW, 0), (FAILS_FINAL, OLD, EXIT_PREVIOUS_KEPT)] {
                let host = Host::update(shell, upload);
                host.tool("ln", "exit 1");
                std::fs::remove_file(host.path("bin/cksum")).unwrap();
                let (status, out) = host.setup();
                assert_eq!(status, Some(code), "{shell}: {out}");
                host.assert_only(Some(want), &out);
            }
        }
    }

    #[test]
    fn a_read_only_install_dir_keeps_the_agent_or_uses_sudo() {
        if is_root() {
            eprintln!("SKIPPED: root writes everywhere");
            return;
        }
        for shell in shells() {
            let set = |host: &Host, m| {
                let p = std::fs::Permissions::from_mode(m);
                std::fs::set_permissions(host.path("opt"), p).unwrap();
            };
            let host = Host::update(shell, NEW);
            set(&host, 0o555);
            let (status, out) = host.setup();
            set(&host, 0o755);
            assert_eq!(status, KEPT, "{shell}: {out}");
            assert!(last_line(&out).contains("permission denied"), "{out}");
            host.assert_only(Some(OLD), &out);

            // sudo: every change goes through it.
            for (upload, want, code) in [(NEW, NEW, 0), (FAILS_FINAL, OLD, EXIT_PREVIOUS_KEPT)] {
                let host = Host::update(shell, upload);
                let dir = host.path("opt").display().to_string();
                host.tool(
                    "sudo",
                    &format!("chmod 755 '{dir}'; \"$@\"; r=$?; chmod 555 '{dir}'; exit $r"),
                );
                set(&host, 0o555);
                let (status, out) = host.setup();
                set(&host, 0o755);
                assert_eq!(status, Some(code), "{shell}: {out}");
                host.assert_only(Some(want), &out);
            }

            // A refusal never asks for a password.
            let host = Host::update(shell, NEW);
            write_exec(&host.target(), NOT_AN_AGENT);
            host.tool(
                "sudo",
                &format!("echo \"$@\" >>'{}'", host.path("sudo.log").display()),
            );
            set(&host, 0o555);
            let (status, out) = host.setup();
            set(&host, 0o755);
            assert_eq!(status, Some(1), "{out}");
            assert!(!host.path("sudo.log").exists(), "{out}");
            host.assert_only(Some(NOT_AN_AGENT), &out);
        }
    }

    #[test]
    fn the_mode_of_the_installed_agent_is_kept() {
        for shell in shells() {
            for m in [0o700, 0o750, 0o755, 0o555] {
                let host = Host::update(shell, NEW);
                let p = std::fs::Permissions::from_mode(m);
                std::fs::set_permissions(host.target(), p).unwrap();
                let (status, out) = host.setup();
                assert_eq!(status, Some(0), "{shell}: {out}");
                // Only the owner's write bit may be added.
                assert_eq!(mode(&host.target()) & !0o200, m & !0o200, "{shell}");
                host.assert_only(Some(NEW), &out);
            }
        }
    }

    #[test]
    fn a_symbolic_link_stays_a_link_and_its_target_is_updated_or_kept() {
        for shell in shells() {
            for (upload, want, code) in [(NEW, NEW, 0), (FAILS_FINAL, OLD, EXIT_PREVIOUS_KEPT)] {
                let host = Host::update(shell, upload);
                std::fs::create_dir_all(host.path("link")).unwrap();
                symlink("second", host.path("link/agent")).unwrap();
                symlink("../opt/termihub-agent", host.path("link/second")).unwrap();
                let script = without_markers(&host.script(&host.path("link/agent"), false));
                let (status, out) = host.run(&script);
                assert_eq!(status, Some(code), "{shell}: {out}");
                assert!(host.path("link/agent").is_symlink());
                assert_eq!(std::fs::read_dir(host.path("link")).unwrap().count(), 2);
                host.assert_only(Some(want), &out);
            }
            // Dangling: the file it names is created.
            let host = Host::new(shell);
            host.stage(NEW);
            std::fs::create_dir_all(host.path("link")).unwrap();
            symlink(host.target(), host.path("link/agent")).unwrap();
            let script = without_markers(&host.script(&host.path("link/agent"), false));
            let (status, out) = host.run(&script);
            assert_eq!(status, Some(0), "{shell}: {out}");
            host.assert_only(Some(NEW), &out);
            // A loop is refused.
            let host = Host::update(shell, NEW);
            symlink("agent", host.path("loop")).unwrap();
            symlink("loop", host.path("agent")).unwrap();
            let script = without_markers(&host.script(&host.path("agent"), false));
            let (status, out) = host.run(&script);
            assert_eq!(status, Some(1), "{shell}: {out}");
            assert!(last_line(&out).contains("cannot be followed"), "{out}");
        }
    }

    #[test]
    fn leftovers_are_recovered_or_cleaned_and_nothing_else_is_touched() {
        for shell in shells() {
            // The agent does not start, the previous one is next to it, and this
            // update fails too.
            for broken in [Some(BROKEN), None] {
                let host = Host::update(shell, FAILS_FINAL);
                match broken {
                    Some(body) => write_exec(&host.target(), body),
                    None => std::fs::remove_file(host.target()).unwrap(),
                }
                write_exec(&host.file(".previous"), OLD);
                let (status, out) = host.setup();
                assert_eq!(status, KEPT, "{shell} {broken:?}: {out}");
                host.assert_only(Some(OLD), &out);
            }
            // A previous copy never replaces an agent that starts.
            let host = Host::update(shell, BROKEN);
            write_exec(&host.target(), OTHER);
            write_exec(&host.file(".previous"), OLD);
            let (status, out) = host.setup();
            assert_eq!(status, KEPT, "{shell}: {out}");
            host.assert_only(Some(OTHER), &out);
            // Stale new binaries go; a running setup's and a user's file stay.
            let host = Host::update(shell, NEW);
            let live = format!(".new.{}", std::process::id());
            for suffix in [
                ".new.999999",
                ".previous.999999",
                live.as_str(),
                ".new.notes",
            ] {
                write_exec(&host.file(suffix), BROKEN);
            }
            let (status, out) = host.setup();
            assert_eq!(status, Some(0), "{shell}: {out}");
            assert!(!host.file(".new.999999").exists());
            assert!(!host.file(".previous.999999").exists());
            assert!(host.file(&live).exists() && host.file(".new.notes").exists());
            // A folder where the copy belongs is refused before any change.
            let host = Host::update(shell, NEW);
            std::fs::create_dir_all(host.file(".previous")).unwrap();
            let (status, out) = host.setup();
            assert_eq!(status, Some(1), "{shell}: {out}");
            assert_eq!(std::fs::read_to_string(host.target()).unwrap(), OLD);
        }
    }

    #[test]
    fn a_restore_that_fails_keeps_the_copy_for_the_next_setup() {
        for shell in shells() {
            let host = Host::update(shell, FAILS_FINAL);
            let mv = ["/bin/mv", "/usr/bin/mv"];
            let mv = mv.iter().find(|p| Path::new(p).exists()).unwrap();
            host.tool(
                "mv",
                &format!("case \"$2\" in *.previous) exit 1 ;; esac\nexec {mv} \"$@\""),
            );
            let (status, out) = host.setup();
            assert_eq!(status, Some(1), "{shell}: {out}");
            assert!(!out.contains("still in place"), "{out}");
            let kept = std::fs::read_to_string(host.file(".previous")).ok();
            assert_eq!(kept.as_deref(), Some(OLD), "{shell}: the only working copy");

            host.tool("mv", &format!("exec {mv} \"$@\""));
            host.stage(BROKEN);
            let (status, out) = host.setup();
            assert_eq!(status, KEPT, "{shell}: {out}");
            host.assert_only(Some(OLD), &out);
        }
    }

    #[test]
    fn a_failed_setup_leaves_a_file_of_the_user_named_like_the_copy() {
        for shell in shells() {
            let host = Host::update(shell, BROKEN);
            write_exec(&host.file(".previous"), NOT_AN_AGENT);
            let (status, out) = host.setup();
            assert_eq!(status, KEPT, "{shell}: {out}");
            let kept = std::fs::read_to_string(host.file(".previous")).ok();
            assert_eq!(kept.as_deref(), Some(NOT_AN_AGENT), "{out}");
        }
    }

    #[test]
    fn uploads_of_killed_setups_are_removed_after_two_days() {
        for shell in shells() {
            let host = Host::update(shell, NEW);
            let updates = host.path("home/.config/termihub-agent/updates");
            for name in ["upload.old123", "upload.new123", "staged"] {
                std::fs::create_dir_all(updates.join(name)).unwrap();
                std::fs::write(updates.join(name).join("termihub-agent"), "x").unwrap();
            }
            for name in ["upload.old123", "staged"] {
                let done = Command::new("touch")
                    .args(["-t", "202001010000"])
                    .arg(updates.join(name))
                    .status()
                    .unwrap();
                assert!(done.success());
            }
            let (status, out) = host.setup();
            assert_eq!(status, Some(0), "{shell}: {out}");
            assert!(!updates.join("upload.old123").exists());
            assert!(updates.join("upload.new123").exists());
            assert!(updates.join("staged").exists());
        }
    }

    #[test]
    fn a_file_that_is_not_an_agent_is_replaced_only_at_termihubs_own_path() {
        for shell in shells() {
            let host = Host::update(shell, NEW);
            std::fs::write(host.target(), "half a binary").unwrap();
            let (status, out) = host.setup();
            assert_eq!(status, Some(1), "{shell}: {out}");
            host.assert_only(Some("half a binary"), &out);

            for (upload, want, code) in [(NEW, NEW, 0), (FAILS_FINAL, "half a binary", 1)] {
                let host = Host::new(shell);
                host.stage(upload);
                let own = host.path("home/.local/bin/termihub-agent");
                std::fs::create_dir_all(own.parent().unwrap()).unwrap();
                std::fs::write(&own, "half a binary").unwrap();
                let script = host.script(Path::new("~/.local/bin/termihub-agent"), false);
                let (status, out) = host.run(&without_markers(&script));
                assert_eq!(status, Some(code), "{shell}: {out}");
                assert_eq!(std::fs::read_to_string(&own).unwrap(), want, "{out}");
            }
        }
    }

    #[test]
    fn a_roll_back_never_replaces_a_newer_install() {
        for shell in shells() {
            let host = Host::update(shell, NEW);
            let after_swap = marker_before("$SUDO sync \"$TARGET_DIR\"");
            let newer = host.path("newer");
            write_exec(&newer, OTHER);
            let fault = format!(
                "mv -f '{}' '{}'; exit 7",
                newer.display(),
                host.target().display()
            );
            let script = faulty(&host.script(&host.target(), false), after_swap, &fault);
            let (status, out) = host.run(&script);
            assert_eq!(status, KEPT, "{shell}: {out}");
            host.assert_only(Some(OTHER), &out);
        }
    }

    // ── The systemd service ──────────────────────────────────────────

    /// A fake `systemctl`: `active` and `enabled` are files, every call is
    /// logged, and a `fail-<verb>` file fails that verb once.
    fn fake_systemd(host: &Host, active: bool) {
        let dir = host.path("systemd");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(host.path("units")).unwrap();
        host.tool(
            "systemctl",
            &format!(
                "cd '{}'\necho \"$*\" >>log\n\
                 if [ -f \"fail-$1\" ]; then rm -f \"fail-$1\" active; exit 1; fi\n\
                 case $1 in\n\
                 is-active) [ -f active ] ;;\nis-enabled) [ -f enabled ] ;;\n\
                 start | restart) : >active ;;\nstop) rm -f active ;;\n\
                 enable) : >enabled ;;\ndisable) rm -f enabled ;;\nesac",
                dir.display()
            ),
        );
        if active {
            std::fs::write(dir.join("active"), "").unwrap();
            std::fs::write(dir.join("enabled"), "").unwrap();
            std::fs::write(unit(host), "old unit\n").unwrap();
        }
    }

    fn unit(host: &Host) -> PathBuf {
        host.path("units/termihub-agent.service")
    }

    fn assert_service(host: &Host, unit_text: Option<&str>, running: bool, what: &str) {
        let text = std::fs::read_to_string(unit(host)).ok();
        match (unit_text, &text) {
            (Some("new"), Some(t)) => assert!(t.contains("ExecStart="), "{what}"),
            (want, got) => assert_eq!(want, got.as_deref(), "{what}"),
        }
        assert_eq!(host.path("systemd/active").exists(), running, "{what}");
        assert_eq!(host.path("systemd/enabled").exists(), running, "{what}");
        let units = std::fs::read_dir(host.path("units")).unwrap().count();
        assert_eq!(units, usize::from(unit_text.is_some()), "{what}");
    }

    fn setup_with_service(host: &Host) -> (Option<i32>, String) {
        host.run(&without_markers(&host.script(&host.target(), true)))
    }

    #[test]
    fn the_service_is_restarted_only_after_the_agent_is_proven() {
        for shell in shells() {
            for active in [true, false] {
                let host = Host::update(shell, NEW);
                fake_systemd(&host, active);
                let (status, out) = setup_with_service(&host);
                assert_eq!(status, Some(0), "{shell}: {out}");
                assert!(last_line(&out).contains("installed at"), "{out}");
                host.assert_only(Some(NEW), &out);
                assert_service(&host, Some("new"), true, &out);
            }
            for upload in [BROKEN, FAILS_FINAL] {
                let host = Host::update(shell, upload);
                fake_systemd(&host, true);
                let (status, out) = setup_with_service(&host);
                assert_eq!(status, KEPT, "{shell}: {out}");
                assert!(
                    !host.path("systemd/log").exists(),
                    "systemctl was used: {out}"
                );
                assert_service(&host, Some("old unit\n"), true, &out);
            }
        }
    }

    #[test]
    fn a_service_that_ran_before_runs_again_after_a_failure() {
        for shell in shells() {
            for verb in ["daemon-reload", "enable", "restart"] {
                let host = Host::update(shell, NEW);
                fake_systemd(&host, true);
                std::fs::write(host.path(&format!("systemd/fail-{verb}")), "").unwrap();
                let (status, out) = setup_with_service(&host);
                let what = format!("{shell} {verb}: {out}");
                assert_eq!(status, KEPT, "{what}");
                assert!(
                    last_line(&out).starts_with("Agent setup failed: The service"),
                    "{what}"
                );
                host.assert_only(Some(OLD), &what);
                assert_service(&host, Some("old unit\n"), true, &what);
            }
        }
    }

    #[test]
    fn a_new_service_that_fails_is_removed_and_the_new_agent_kept() {
        for shell in shells() {
            for verb in ["daemon-reload", "enable", "restart"] {
                let host = Host::update(shell, NEW);
                fake_systemd(&host, false);
                std::fs::write(host.path(&format!("systemd/fail-{verb}")), "").unwrap();
                let (status, out) = setup_with_service(&host);
                let what = format!("{shell} {verb}: {out}");
                assert_eq!(status, Some(EXIT_SERVICE_FAILED), "{what}");
                assert!(
                    out.contains("The new agent itself is installed and starts."),
                    "{what}"
                );
                host.assert_only(Some(NEW), &what);
                assert_service(&host, None, false, &what);
            }
        }
    }

    #[test]
    fn a_new_service_is_stopped_and_removed_when_its_setup_is_cut_off() {
        let first = marker_before("    SERVICE_CHANGING=true");
        for shell in shells() {
            for at in first..markers() {
                let host = Host::update(shell, NEW);
                fake_systemd(&host, false);
                let script = faulty(&host.script(&host.target(), true), at, "kill -TERM $$");
                let (status, out) = host.run(&script);
                let what = format!("{shell} at {at}: {out}");
                assert_eq!(status, Some(EXIT_SERVICE_FAILED), "{what}");
                host.assert_only(Some(NEW), &what);
                assert_service(&host, None, false, &what);
            }
        }
    }

    #[test]
    fn a_failure_signal_or_kill_in_the_service_step_leaves_a_running_service() {
        let first = marker_before("    SERVICE_CHANGING=true");
        for shell in shells() {
            for fault in ["exit 7", "kill -HUP $$", "kill -TERM $$", "kill -KILL $$"] {
                for at in first..markers() {
                    let host = Host::update(shell, NEW);
                    fake_systemd(&host, true);
                    let script = faulty(&host.script(&host.target(), true), at, fault);
                    let (status, out) = host.run(&script);
                    let what = format!("{shell} {fault} at {at}: {out}");
                    if fault.contains("KILL") {
                        assert!(
                            host.starts() && host.path("systemd/active").exists(),
                            "{what}"
                        );
                        host.stage(NEW);
                        let (status, out) = setup_with_service(&host);
                        assert_eq!(status, Some(0), "{what}\nthen {out}");
                        host.assert_only(Some(NEW), &what);
                        assert_service(&host, Some("new"), true, &what);
                    } else {
                        assert_eq!(status, KEPT, "{what}");
                        host.assert_only(Some(OLD), &what);
                        assert_service(&host, Some("old unit\n"), true, &what);
                    }
                }
            }
        }
    }
}
