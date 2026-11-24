//! The agent setup output is plain and readable on any remote shell (#5822).
//!
//! The setup script used to pass octal-escaped emoji (`\360\237\232\200`) to
//! `echo`, which only some shells expand — bash and dash printed the raw
//! escapes. These tests pin the fix statically (no octal escapes, no
//! non-ASCII, no `echo` in the generated scripts) and by executing the
//! generated scripts under every POSIX shell available, in a scratch dir with
//! a scratch `HOME`.

use super::*;

/// The first `\NNN` octal escape in `text`, if any.
fn first_octal_escape(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    (0..bytes.len().saturating_sub(3)).find_map(|i| {
        let is_octal = |b: u8| (b'0'..=b'7').contains(&b);
        (bytes[i] == b'\\' && bytes[i + 1..i + 4].iter().all(|&b| is_octal(b)))
            .then(|| &text[i..i + 4])
    })
}

/// The lines of a shell script that call `echo`.
fn echo_lines(script: &str) -> Vec<&str> {
    script
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            line.starts_with("echo ") || line.contains("; echo ") || line.contains("then echo ")
        })
        .collect()
}

fn all_scripts() -> Vec<(&'static str, String)> {
    vec![
        (
            "setup",
            generate_setup_script("/usr/local/bin/termihub-agent", false, "/up/termihub-agent"),
        ),
        (
            "setup+service",
            generate_setup_script("~/.local/bin/termihub-agent", true, "/up/termihub-agent"),
        ),
        (
            "error script",
            generate_error_script("Script upload failed: boom"),
        ),
        (
            "inline fallback",
            failure_printf("Script upload failed: boom"),
        ),
    ]
}

#[test]
fn the_octal_detector_finds_the_old_escapes() {
    assert_eq!(
        first_octal_escape(r"echo '\360\237\232\200 === termiHub'"),
        Some(r"\360")
    );
    assert_eq!(first_octal_escape(r"printf '%s\n' 'plain'"), None);
}

#[test]
fn generated_scripts_carry_no_octal_escapes_or_non_ascii() {
    for (name, script) in all_scripts() {
        assert_eq!(
            first_octal_escape(&script),
            None,
            "{name} must not carry octal escapes"
        );
        assert!(script.is_ascii(), "{name} must be plain ASCII");
    }
}

#[test]
fn generated_scripts_print_with_printf_never_echo() {
    for (name, script) in all_scripts() {
        assert!(
            echo_lines(&script).is_empty(),
            "{name} must print via printf, not echo: {:?}",
            echo_lines(&script)
        );
        assert!(!script.contains("echo -e"), "{name} must not use echo -e");
        assert!(script.contains("printf '%s"), "{name} prints via printf");
    }
}

#[test]
fn the_setup_script_uses_plain_markers_and_one_summary_line() {
    let script = generate_setup_script("/usr/local/bin/termihub-agent", true, "/up/a");
    for marker in ["[..] ", "[ok] ", "[error] "] {
        assert!(script.contains(marker), "missing marker {marker:?}");
    }
    assert!(script.contains("Agent $VERSION_LABEL installed at $SHOWN_PATH."));
    assert!(script.contains("Agent setup failed: $1"));
    // A `set -e` abort still ends in a failure line.
    assert!(script.contains("Agent setup failed: a setup step exited with status $status"));
}

#[test]
fn the_failure_lines_end_in_one_summary_line_and_quote_safely() {
    let cmd = failure_printf("it's\nbroken");
    assert_eq!(
        cmd,
        "printf '%s\\n' '[error] it'\\''s broken' '' 'Agent setup failed: it'\\''s broken'\n"
    );
}

#[test]
fn windows_and_cancel_feedback_stay_plain() {
    // Static guard over the inline commands typed into the terminal.
    let source = include_str!("agent_setup.rs");
    assert!(source.contains("\"printf '%s\\\\n' 'Agent setup cancelled.'\\n\""));
    assert!(source.contains("windows_echo_input(\"Agent setup cancelled.\")"));
    assert!(source.contains("windows_echo_input(&format!(\"Agent setup failed: {message}\"))"));
}

/// Executes the generated scripts under each available POSIX shell.
#[cfg(unix)]
mod executed {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    struct Run {
        status: i32,
        stdout: String,
    }

    /// The POSIX shells on this machine worth checking the output under.
    fn shells() -> Vec<&'static str> {
        ["/bin/sh", "/bin/dash", "/bin/bash", "/usr/bin/dash"]
            .into_iter()
            .filter(|s| Path::new(s).exists())
            .collect()
    }

    fn write_exec(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Run `script` (staged as `<upload>/setup.sh`) with a scratch HOME.
    fn run(shell: &str, scratch: &Path, upload: &Path, script: &str) -> Run {
        std::fs::create_dir_all(upload).unwrap();
        let script_path = upload.join(SETUP_SCRIPT_NAME);
        std::fs::write(&script_path, script).unwrap();
        let out = Command::new(shell)
            .arg(&script_path)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", scratch.join("home"))
            .env("LANG", "C")
            .env("LC_ALL", "C")
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

    fn assert_plain(shell: &str, out: &str) {
        assert_eq!(
            first_octal_escape(out),
            None,
            "{shell}: raw octal escape in output:\n{out}"
        );
        assert!(out.is_ascii(), "{shell}: non-ASCII output:\n{out}");
    }

    fn fake_agent(dir: &Path) -> PathBuf {
        fake_agent_reporting(dir, "termihub-agent 1.2.3")
    }

    fn fake_agent_reporting(dir: &Path, version_line: &str) -> PathBuf {
        let bin = dir.join("termihub-agent");
        write_exec(
            &bin,
            &format!("#!/bin/sh\nprintf '%s\\n' '{version_line}'\n"),
        );
        bin
    }

    #[test]
    fn a_branch_build_reads_version_and_branch_without_nested_parentheses() {
        for shell in shells() {
            let scratch = tempfile::tempdir().unwrap();
            let upload = scratch.path().join("upload.Ab12Cd");
            std::fs::create_dir_all(&upload).unwrap();
            let binary = fake_agent_reporting(&upload, "termihub-agent 0.1.0 (branch: develop)");
            // Outside $HOME: the path is shown as it is.
            let install = scratch.path().join("opt/termihub-agent");
            let script =
                generate_setup_script(install.to_str().unwrap(), false, binary.to_str().unwrap());
            let run = run(shell, scratch.path(), &upload, &script);
            assert_eq!(run.status, 0, "{shell}: setup failed:\n{}", run.stdout);
            assert_eq!(
                last_line(&run.stdout),
                format!(
                    "Agent v0.1.0 (develop) installed at {}. You can close this tab.",
                    install.display()
                ),
                "{shell}"
            );
        }
    }

    #[test]
    fn a_successful_setup_prints_plain_lines_and_one_installed_line() {
        for shell in shells() {
            let scratch = tempfile::tempdir().unwrap();
            let upload = scratch.path().join("upload.Ab12Cd");
            std::fs::create_dir_all(&upload).unwrap();
            let binary = fake_agent(&upload);
            let install = scratch.path().join("home/.local/bin/termihub-agent");
            let script =
                generate_setup_script(install.to_str().unwrap(), false, binary.to_str().unwrap());
            let run = run(shell, scratch.path(), &upload, &script);
            assert_eq!(run.status, 0, "{shell}: setup failed:\n{}", run.stdout);
            assert_plain(shell, &run.stdout);
            assert!(run.stdout.contains("=== termiHub Agent Setup ==="));
            assert!(run.stdout.contains("[ok] termihub-agent 1.2.3"));
            // A path under $HOME is shown home-relative (#5956).
            assert_eq!(
                last_line(&run.stdout),
                "Agent v1.2.3 installed at ~/.local/bin/termihub-agent. You can close this tab.",
                "{shell}"
            );
            assert!(install.exists(), "{shell}: agent installed");
            assert!(!upload.exists(), "{shell}: script removed its upload dir");
        }
    }

    #[test]
    fn a_missing_upload_ends_in_one_failure_line() {
        for shell in shells() {
            let scratch = tempfile::tempdir().unwrap();
            let upload = scratch.path().join("upload.Ab12Cd");
            let install = scratch.path().join("bin/termihub-agent");
            let script = generate_setup_script(
                install.to_str().unwrap(),
                false,
                upload.join("termihub-agent").to_str().unwrap(),
            );
            let run = run(shell, scratch.path(), &upload, &script);
            assert_eq!(run.status, 1, "{shell}");
            assert_plain(shell, &run.stdout);
            assert!(run
                .stdout
                .contains("[error] The agent binary was not uploaded."));
            assert_eq!(
                last_line(&run.stdout),
                "Agent setup failed: The agent binary was not uploaded.",
                "{shell}"
            );
            assert!(!upload.exists(), "{shell}: script removed its upload dir");
        }
    }

    #[test]
    fn a_failing_step_under_set_e_still_ends_in_a_failure_line() {
        for shell in shells() {
            let scratch = tempfile::tempdir().unwrap();
            let upload = scratch.path().join("upload.Ab12Cd");
            std::fs::create_dir_all(&upload).unwrap();
            let binary = fake_agent(&upload);
            // The install dir's name is taken by a file: `mkdir -p` fails.
            std::fs::write(scratch.path().join("blocked"), "").unwrap();
            let install = scratch.path().join("blocked/termihub-agent");
            let script =
                generate_setup_script(install.to_str().unwrap(), false, binary.to_str().unwrap());
            let run = run(shell, scratch.path(), &upload, &script);
            assert_ne!(run.status, 0, "{shell}");
            assert_plain(shell, &run.stdout);
            assert!(
                last_line(&run.stdout).starts_with("Agent setup failed: a setup step exited"),
                "{shell}: {}",
                run.stdout
            );
            assert!(!upload.exists(), "{shell}: leftover upload removed");
        }
    }

    #[test]
    fn the_error_script_prints_plain_failure_lines_and_cleans_up() {
        for shell in shells() {
            let scratch = tempfile::tempdir().unwrap();
            let upload = scratch.path().join("upload.Ab12Cd");
            let script = generate_error_script("Architecture mismatch: it's arm64\nnot x86_64");
            let run = run(shell, scratch.path(), &upload, &script);
            // It ends the tab's shell (`exec`), so its status says "failed" (#5865).
            assert_eq!(run.status, 1, "{shell}");
            assert_plain(shell, &run.stdout);
            assert_eq!(
                run.stdout,
                "[error] Architecture mismatch: it's arm64 not x86_64\n\n\
                 Agent setup failed: Architecture mismatch: it's arm64 not x86_64\n",
                "{shell}"
            );
            assert!(!upload.exists(), "{shell}: error script removed itself");
        }
    }
}
