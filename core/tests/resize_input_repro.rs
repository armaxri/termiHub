//! Resize, then type a line: does every byte reach the shell? (#6078)
//!
//! The measurement and the report are in `common/resize_input.rs`; this file
//! runs them against the two sessions the nightly lost a first character in:
//!
//! - `local_bash_resize_then_type`: bash in a local pseudoterminal through the
//!   production spawner (on Windows ConPTY, with every bash the runner has:
//!   Git Bash and the MSYS2 UCRT64 bash), so the session is ConPTY plus the
//!   MSYS2 console and nothing of the app;
//! - `ssh_resize_then_type`: the login shell of the native sshd fixture over
//!   the production SSH backend (the Windows SSH Host lane's `bash` leg sets
//!   Git Bash as the OpenSSH DefaultShell).
//!
//! Each prints its report (`--show-output`) and fails when a round lost bytes
//! or got no answer. Opt-in with `TERMIHUB_RESIZE_INPUT_REPRO=1`; the Windows
//! SSH Host lane runs both.
#![cfg(any(feature = "ssh", feature = "local-shell"))]

mod common;

#[path = "common/resize_input.rs"]
mod resize_input;

use resize_input::{enabled_rounds, run_rounds, wait_ready, Output, Report, Session};

/// Fail with the whole report when a round did not run its line.
fn assert_whole(report: &Report) {
    println!("{}", report.render());
    let failures = report.failures();
    assert!(
        failures.is_empty(),
        "{}: {} of {} rounds did not run their line whole (#6078); see the report above",
        report.label,
        failures.len(),
        report.rounds.len()
    );
}

#[cfg(feature = "local-shell")]
mod local {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::sync::Mutex;

    use termihub_core::backends::local_shell::NativeLocalShellSpawner;
    use termihub_core::session::shell::ShellCommand;
    use termihub_core::session::traits::LocalShellSpawner;

    use super::*;

    /// A bash to measure: its label, program and extra env.
    struct Bash {
        label: &'static str,
        program: &'static str,
        env: Vec<(&'static str, &'static str)>,
    }

    /// The bashes this machine has.
    fn bashes() -> Vec<Bash> {
        let candidates = if cfg!(windows) {
            vec![
                Bash {
                    label: "Git Bash",
                    program: r"C:\Program Files\Git\usr\bin\bash.exe",
                    env: vec![],
                },
                Bash {
                    label: "MSYS2 UCRT64 bash",
                    program: r"C:\msys64\usr\bin\bash.exe",
                    env: vec![("MSYSTEM", "UCRT64"), ("CHERE_INVOKING", "1")],
                },
            ]
        } else {
            vec![Bash {
                label: "bash",
                program: "/bin/bash",
                env: vec![],
            }]
        };
        candidates
            .into_iter()
            .filter(|bash| {
                let there = Path::new(bash.program).is_file();
                if !there {
                    println!("{}: {} not found, not measured", bash.label, bash.program);
                }
                there
            })
            .collect()
    }

    fn measure(label: &str, program: &str, env: &[(&str, &str)], rounds: usize) -> Report {
        let mut vars: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        vars.insert("TERM".into(), "xterm-256color".into());
        vars.insert("PS1".into(), "$ ".into());
        // Never the user's history.
        let scratch = tempfile::tempdir().unwrap();
        vars.insert(
            "HISTFILE".into(),
            scratch.path().join("history").display().to_string(),
        );
        let command = ShellCommand {
            program: program.to_owned(),
            args: vec!["--noprofile".into(), "--norc".into(), "-i".into()],
            env: vars,
            cwd: Some(scratch.path().to_path_buf()),
            cols: 120,
            rows: 30,
        };
        let spawned = NativeLocalShellSpawner
            .spawn(&command)
            .unwrap_or_else(|e| panic!("spawn {program}: {e}"));
        let output = Output::default();
        let sink = output.clone();
        let mut reader = spawned.reader;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    return;
                }
                sink.push(&buf[..n]);
            }
        });
        let writer = Mutex::new(spawned.writer);
        let write = |data: &[u8]| {
            let mut w = writer.lock().unwrap();
            w.write_all(data).expect("write to the shell");
            w.flush().expect("flush to the shell");
        };
        let resize = |cols: u16, rows: u16| (spawned.resize)(cols, rows).expect("resize");
        let session = Session {
            write: &write,
            resize: &resize,
            output,
            enter: "\r",
        };
        assert!(wait_ready(&session), "{label} never answered");
        let report = run_rounds(&format!("local {label}"), &session, rounds);
        (spawned.kill)();
        report
    }

    #[test]
    fn local_bash_resize_then_type() {
        let Some(rounds) = enabled_rounds() else {
            return;
        };
        let reports: Vec<Report> = bashes()
            .into_iter()
            .map(|bash| measure(bash.label, bash.program, &bash.env, rounds))
            .collect();
        assert!(!reports.is_empty(), "no bash to measure on this machine");
        for report in &reports {
            assert_whole(report);
        }
    }
}

#[cfg(feature = "ssh")]
mod ssh {
    use termihub_core::backends::ssh::Ssh;
    use termihub_core::connection::ConnectionType;

    use super::*;
    use crate::common;
    use crate::common::require_native_sshd;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ssh_resize_then_type() {
        let Some(rounds) = enabled_rounds() else {
            return;
        };
        let sshd = require_native_sshd!();
        let mut ssh = Ssh::new();
        let mut settings = sshd.key_settings();
        // The plain shell path: nothing of ours is typed into it.
        settings["shellIntegration"] = serde_json::Value::Bool(false);
        ssh.connect(settings).await.expect("shell session connects");
        let output = Output::default();
        let sink = output.clone();
        let mut rx = ssh.subscribe_output();
        tokio::spawn(async move {
            while let Some(chunk) = rx.recv().await {
                sink.push(&chunk);
            }
        });
        let report = tokio::task::block_in_place(|| {
            let write = |data: &[u8]| ssh.write(data).expect("write to the shell");
            let resize = |cols: u16, rows: u16| ssh.resize(cols, rows).expect("resize");
            let session = Session {
                write: &write,
                resize: &resize,
                output,
                enter: "\r",
            };
            assert!(wait_ready(&session), "the login shell never answered");
            run_rounds("ssh login shell", &session, rounds)
        });
        ssh.disconnect().await.expect("disconnect cleanly");
        assert_whole(&report);
    }
}
