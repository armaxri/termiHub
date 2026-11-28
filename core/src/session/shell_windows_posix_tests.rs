//! The OSC 7 hook typed into a POSIX shell on a Windows SSH host (#6170).
//!
//! Git Bash reports MSYS paths in `$PWD` (`/tmp`, `/usr`, `/c/Users/me`).
//! A drive path maps to a Windows folder without asking the shell (#6147),
//! a mount point such as `/tmp` does not. On such a host the hook asks the
//! shell for the Windows path: `pwd -W`, else `cygpath -m "$PWD"`, else
//! `$PWD` as before.

use std::process::Command;

use super::*;

/// Run `script` in a bash that reads no profile or rc and writes no history,
/// with a scratch `HOME`; return its stdout.
#[cfg(unix)]
fn run_bash(script: &str) -> String {
    let home = tempfile::tempdir().expect("scratch home");
    let output = Command::new("bash")
        .args(["--noprofile", "--norc", "-c", script])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home.path())
        .env("HISTFILE", home.path().join(".bash_history"))
        .output()
        .expect("bash");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The OSC 7 the hook prints for the shell's directory, after `prelude`.
#[cfg(unix)]
fn reported_cwd(prelude: &str) -> String {
    let script = format!(
        "{prelude}\ncd /tmp\n{}\n__termihub_osc7",
        windows_posix_osc7_command()
    );
    let out = run_bash(&script);
    let start = out.rfind("\x1b]7;file://").expect("an OSC 7") + "\x1b]7;file://".len();
    let end = out[start..].find('\x07').expect("BEL") + start;
    out[start..end].to_string()
}

#[test]
fn the_windows_posix_hook_asks_the_shell_for_the_windows_path() {
    let setup = windows_posix_osc7_command();
    let pwd_w = setup.find("pwd -W").expect("asks pwd -W");
    let cygpath = setup
        .find(r#"cygpath -m "$PWD""#)
        .expect("falls back to cygpath");
    assert!(pwd_w < cygpath, "pwd -W first: {setup}");
    // It is still the shared hook: status, D, OSC 7, A in order, and done mark.
    let status = setup.find("local __th_s=$?").expect("captures $? first");
    let osc7 = setup.find(r"\e]7;file://").expect("emits OSC 7");
    assert!(status < pwd_w && pwd_w < osc7, "{setup}");
    assert!(setup.contains("return $__th_s;"), "{setup}");
    assert!(setup.starts_with(' '), "kept out of history");
    assert!(setup.ends_with(r"printf '\e]6973;termihub-setup-done\a'"));
}

#[test]
fn other_bash_hosts_keep_reporting_pwd() {
    for shell in ["bash", "ssh", "gitbash", "zsh"] {
        let setup = osc7_setup_command(shell).expect("a hook");
        assert!(!setup.contains("pwd -W"), "{shell}: {setup}");
        assert!(setup.contains(r#""$PWD""#), "{shell}: {setup}");
    }
}

#[cfg(unix)]
#[test]
fn a_mount_point_is_reported_as_its_windows_folder() {
    // Git Bash's `pwd -W` names the folder /tmp is mounted on.
    let fake_pwd = r#"pwd(){ if [ "$1" = -W ]; then echo 'C:/Users/me/AppData/Local/Temp'; else builtin pwd "$@"; fi; }"#;
    assert_eq!(reported_cwd(fake_pwd), "/C:/Users/me/AppData/Local/Temp");
}

#[cfg(unix)]
#[test]
fn without_pwd_w_it_asks_cygpath() {
    // Cygwin's bash has no `pwd -W`; its `cygpath -m` names the folder.
    let fake = r#"pwd(){ if [ "$1" = -W ]; then return 1; else builtin pwd "$@"; fi; }
cygpath(){ [ "$1" = -m ] && echo 'C:/cygwin64/tmp'; }"#;
    assert_eq!(reported_cwd(fake), "/C:/cygwin64/tmp");
}

#[cfg(unix)]
#[test]
fn without_either_it_reports_pwd_as_before() {
    // Neither answers: the MSYS path, as an older hook sent it. A drive path
    // then still opens through the SFTP translation of #6147.
    let fake = r#"pwd(){ if [ "$1" = -W ]; then return 1; else builtin pwd "$@"; fi; }"#;
    let reported = reported_cwd(fake);
    assert!(
        reported.ends_with("/tmp") && !reported.contains(':'),
        "{reported}"
    );
}

#[cfg(unix)]
#[test]
fn the_hook_keeps_the_exit_status() {
    let script = format!(
        "{}\n(exit 3); __termihub_osc7 >/dev/null; echo \"status=$?\"",
        windows_posix_osc7_command()
    );
    assert!(run_bash(&script).contains("status=3"));
}
