//! The environment bootstrap that hands bash its shell-integration setup
//! without typing it (#5014, used for Git Bash on Windows), run in a real
//! bash: it installs the hook, cleans up after itself, and leaves a
//! `PROMPT_COMMAND` from the user's rc alone.

use super::*;
use std::process::{Command, Stdio};

/// Run an interactive bash with `rc` as its rc file and the bootstrap in its
/// environment; type `input`; return its stdout.
fn run_bootstrapped(rc: &str, input: &str, theirs: Option<&str>) -> String {
    let dir = tempfile::tempdir().expect("tempdir");
    let rc_path = dir.path().join("rc");
    std::fs::write(&rc_path, rc).expect("rc");
    let mut cmd = ShellCommand {
        program: "bash".to_string(),
        args: vec![],
        env: std::collections::HashMap::new(),
        cwd: None,
        cols: 80,
        rows: 24,
    };
    if let Some(theirs) = theirs {
        cmd.env
            .insert("PROMPT_COMMAND".to_string(), theirs.to_string());
    }
    bootstrap_bash_setup(&mut cmd);
    let mut child = Command::new("bash")
        .args(["--noprofile", "--rcfile"])
        .arg(&rc_path)
        .arg("-i")
        .env_remove("PROMPT_COMMAND")
        .envs(&cmd.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("bash");
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().expect("stdin");
        stdin.write_all(input.as_bytes()).expect("input");
    }
    let out = child.wait_with_output().expect("output");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

const PROBE: &str = concat!(
    "echo \"PC=[${PROMPT_COMMAND[*]}]\"\n",
    "echo \"ENV=[$(env | grep -c -e ^TERMIHUB_SI= -e ^PROMPT_COMMAND=)]\"\n",
    "exit\n",
);

#[test]
fn the_bootstrap_installs_the_hook_and_removes_itself() {
    let out = run_bootstrapped("echo RC-BANNER\n", PROBE, None);
    assert!(out.contains("RC-BANNER"), "{out:?}");
    assert!(out.contains("\x1b]133;A"), "first prompt marked: {out:?}");
    assert!(out.contains("\x1b]7;file://"), "cwd reported: {out:?}");
    assert!(out.contains("PC=[__termihub_osc7]"), "{out:?}");
    assert!(out.contains("ENV=[0]"), "nothing left exported: {out:?}");
}

#[test]
fn a_prompt_command_the_rc_appends_survives() {
    let rc = "PROMPT_COMMAND=\"$PROMPT_COMMAND;echo RC-HOOK\"\n";
    let out = run_bootstrapped(rc, PROBE, None);
    assert!(out.contains("\x1b]133;A"), "{out:?}");
    assert!(out.contains("RC-HOOK"), "their hook runs: {out:?}");
    assert!(out.contains("PC=[__termihub_osc7;echo RC-HOOK]"), "{out:?}");
}

#[test]
fn a_prompt_command_from_the_environment_survives() {
    let out = run_bootstrapped("", PROBE, Some("echo ENV-HOOK"));
    assert!(out.contains("\x1b]133;A"), "{out:?}");
    assert!(out.contains("ENV-HOOK"), "{out:?}");
    assert!(
        out.contains("PC=[__termihub_osc7;echo ENV-HOOK]"),
        "{out:?}"
    );
}

/// An rc that replaces `PROMPT_COMMAND` drops the bootstrap: no hook (the
/// caller then types the setup) and nothing of termiHub's is shown.
#[test]
fn an_rc_that_replaces_prompt_command_drops_the_bootstrap() {
    let out = run_bootstrapped("PROMPT_COMMAND='echo OWN'\n", PROBE, None);
    assert!(!out.contains("\x1b]133;"), "{out:?}");
    assert!(out.contains("PC=[echo OWN]"), "{out:?}");
}
