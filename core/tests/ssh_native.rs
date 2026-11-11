#![cfg(feature = "ssh")]
//! SSH/SFTP core journeys against a **native** loopback sshd (CI-020, TIN-007).
//!
//! The Docker SSH fixtures only run on Linux. These tests need nothing but an
//! OpenSSH server, so they run against the platform's own sshd, which
//! `scripts/internal/native-sshd-fixture.{sh,ps1}` stands up on macOS, Linux
//! and Windows. On macOS and Linux that is an unprivileged `/usr/sbin/sshd` for
//! the current user. On Windows it is Win32-OpenSSH with a dedicated local test
//! user.
//!
//! The fixture authorizes a fresh client key plus every key in
//! `tests/fixtures/ssh-keys` (the same set the Docker `ssh-keys` container
//! trusts), so the key-type matrix is covered natively too. The user is the
//! fixture's user, not the Docker `testuser`, so nothing here assumes Linux
//! paths or a POSIX login shell: remote commands are chosen per platform.
//! Windows' OpenSSH runs them under `cmd.exe`, the others under a POSIX shell,
//! and the fixture always runs on the same host as the test.
//!
//! Gating: `require_native_sshd!()` skips when `TERMIHUB_NATIVE_SSHD` is unset
//! and no fixture is reachable (local / per-PR runs). Once the flag is set, a
//! missing fixture is a hard failure. Run locally with:
//!
//! ```sh
//! eval "$(scripts/internal/native-sshd-fixture.sh up --scratch-home)"
//! cargo test -p termihub-core --features ssh --test ssh_native
//! scripts/internal/native-sshd-fixture.sh down
//! ```

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{require_native_sshd, ssh_exec, ssh_keys_dir};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::remote_shell::{detect_remote_shell, RemoteShell};
use termihub_core::backends::ssh::{
    probe_exec_capability, ssh_exec_with_stdin, SftpAdvancedOps, SftpFileBrowser, Ssh,
};
use termihub_core::connection::ConnectionType;
use termihub_core::session::prompt_ready::{wait_for_prompt, PromptSignal};
use termihub_core::tunnel::config::LocalForwardConfig;
use termihub_core::tunnel::local_forward::LocalForwarder;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Echo stdin to stdout: `cat` on POSIX, `sort` on `cmd.exe` (a one-line
/// payload sorts to itself; cmd has no `cat`).
const CMD_ECHO_STDIN: &str = if cfg!(windows) { "sort" } else { "cat" };

/// Write to stderr and exit 7.
const CMD_STDERR_EXIT_7: &str = if cfg!(windows) {
    "echo boom 1>&2 & exit 7"
} else {
    "echo boom 1>&2; exit 7"
};

/// A shell line whose OUTPUT contains `native-42-ok` while the typed text does
/// not, so seeing it proves the shell ran the line rather than echoed it.
const SHELL_LINE: &str = if cfg!(windows) {
    // `%OS%` expands to `Windows_NT` in cmd.exe.
    "echo native-%OS%-ok\r"
} else {
    "echo native-$((40+2))-ok\n"
};
const SHELL_EXPECT: &str = if cfg!(windows) {
    "native-Windows_NT-ok"
} else {
    "native-42-ok"
};

/// Every fixture key and its passphrase (the passphrase keys use `testpass123`).
const FIXTURE_KEYS: &[(&str, Option<&str>)] = &[
    ("rsa_2048", None),
    ("rsa_4096", None),
    ("ed25519", None),
    ("ecdsa_256", None),
    ("ecdsa_384", None),
    ("ecdsa_521", None),
    ("rsa_2048_passphrase", Some("testpass123")),
    ("ed25519_passphrase", Some("testpass123")),
    ("ecdsa_256_passphrase", Some("testpass123")),
    ("ecdsa_384_passphrase", Some("testpass123")),
    ("ecdsa_521_passphrase", Some("testpass123")),
];

/// A throwaway ed25519 key that the fixture does NOT authorize (same key as
/// `ssh_auth.rs`'s SSH-AUTH-12).
const UNAUTHORIZED_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAP6eRqfIpS5mPIXbpAxb9+kNbkhdwFQbpnwmmLYQ5VFgAAAKB5NZAVeTWQ
FQAAAAtzc2gtZWQyNTUxOQAAACAP6eRqfIpS5mPIXbpAxb9+kNbkhdwFQbpnwmmLYQ5VFg
AAAEAcqb4xWsO2YRZ6lRZ8Z1J403c449E7SmzTqLAlTN97zg/p5Gp8ilLmY8hdukDFv36Q
1uSF3AVBumfCaYthDlUWAAAAF3Rlcm1paHViLXRlc3QtdGhyb3dhd2F5AQIDBAUG
-----END OPENSSH PRIVATE KEY-----
";

fn fixture_key(name: &str) -> String {
    ssh_keys_dir()
        .join(name)
        .to_str()
        .expect("fixture key path is UTF-8")
        .to_string()
}

/// `whoami` prints `user` on POSIX and `host\user` on Windows, whose account
/// names are case-insensitive.
fn assert_logged_in_as(output: &str, user: &str) {
    let out = output.trim().to_ascii_lowercase();
    let user = user.to_ascii_lowercase();
    assert!(
        out == user || out.ends_with(&format!("\\{user}")),
        "expected to be logged in as {user:?}, whoami printed {output:?}"
    );
}

/// Normalise command output for comparison across `\n` / `\r\n` platforms.
fn normalise(s: &str) -> String {
    s.replace("\r\n", "\n").trim().to_string()
}

#[tokio::test]
async fn native_01_key_login_runs_a_command_as_the_fixture_user() {
    let sshd = require_native_sshd!();

    let (session, _) = connect_and_authenticate(&sshd.key_config())
        .await
        .expect("key auth with the fixture client key should succeed");
    let who = ssh_exec(&session, "whoami").await.expect("whoami runs");
    assert_logged_in_as(&who, &sshd.user);
}

#[tokio::test]
async fn native_02_every_fixture_key_type_authenticates() {
    let sshd = require_native_sshd!();

    for (name, passphrase) in FIXTURE_KEYS {
        let config = sshd.config_with_key(&fixture_key(name), *passphrase);
        let (session, _) = connect_and_authenticate(&config)
            .await
            .unwrap_or_else(|e| panic!("{name}: key auth should succeed, got {e:?}"));
        let who = ssh_exec(&session, "whoami")
            .await
            .unwrap_or_else(|e| panic!("{name}: whoami failed: {e}"));
        assert_logged_in_as(&who, &sshd.user);
    }
}

#[tokio::test]
async fn native_03_unauthorized_key_and_wrong_passphrase_are_rejected() {
    let sshd = require_native_sshd!();

    let dir = tempfile::tempdir().expect("temp dir");
    let key_path = dir.path().join("unauthorized_key");
    std::fs::write(&key_path, UNAUTHORIZED_KEY).expect("write temp key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
            .expect("chmod temp key");
    }
    let config = sshd.config_with_key(key_path.to_str().expect("UTF-8 path"), None);
    assert!(
        connect_and_authenticate(&config).await.is_err(),
        "a key the server does not authorize must be rejected"
    );

    let config = sshd.config_with_key(
        &fixture_key("rsa_2048_passphrase"),
        Some("wrong-passphrase"),
    );
    assert!(
        connect_and_authenticate(&config).await.is_err(),
        "an authorized key with the wrong passphrase must be rejected"
    );
}

#[tokio::test]
async fn native_04_exec_captures_stdout_stderr_exit_status_and_stdin() {
    let sshd = require_native_sshd!();
    let (session, _) = connect_and_authenticate(&sshd.key_config())
        .await
        .expect("key auth should succeed");

    let out = ssh_exec_with_stdin(&session, CMD_STDERR_EXIT_7, "")
        .await
        .expect("command executes");
    assert_eq!(out.exit_status, 7, "exit status is captured: {out:?}");
    assert!(out.stderr.contains("boom"), "stderr is captured: {out:?}");
    assert!(
        out.stdout.trim().is_empty(),
        "nothing was written to stdout: {out:?}"
    );

    let payload = "hello from stdin\n";
    let out = ssh_exec_with_stdin(&session, CMD_ECHO_STDIN, payload)
        .await
        .expect("stdin echo executes");
    assert_eq!(out.exit_status, 0, "stdin echo exits 0: {out:?}");
    assert_eq!(
        normalise(&out.stdout),
        normalise(payload),
        "stdin reaches the command and EOF is sent"
    );

    assert!(
        probe_exec_capability(&session).await,
        "a normal sshd connection must be reported as exec-capable"
    );
}

#[tokio::test]
async fn native_05_interactive_shell_session_round_trips() {
    let sshd = require_native_sshd!();

    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    // Integration off: the plain shell path. `native_05c` covers it on (#4143).
    settings["shellIntegration"] = serde_json::Value::Bool(false);
    ssh.connect(settings).await.expect("shell session connects");
    let mut rx = ssh.subscribe_output();

    ssh.write(SHELL_LINE.as_bytes())
        .expect("write to the shell");
    let mut seen = String::new();
    let found = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(chunk) = rx.recv().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if seen.contains(SHELL_EXPECT) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(
        found,
        "the shell never printed {SHELL_EXPECT:?}; output so far: {seen:?}"
    );

    ssh.disconnect().await.expect("disconnect cleanly");
    assert!(!ssh.is_connected(), "session reports disconnected");
}

/// The login shell the fixture runs: Win32-OpenSSH's default `cmd.exe` on
/// Windows (the lane leaves `DefaultShell` unset), a POSIX shell elsewhere —
/// or `pwsh` when `TERMIHUB_NATIVE_SSHD_LOGIN_SHELL=pwsh` says the fixture
/// was set up with a PowerShell login shell (#4148; a local check, e.g. an
/// sshd whose `ForceCommand` wraps `pwsh -l` — run only `native_05b..05d`),
/// or `fish` / `fish3` likewise for a fish 4+ / fish 3.x login shell (#5016).
/// On Windows, `TERMIHUB_NATIVE_SSHD_LOGIN_SHELL=gitbash` says the lane set
/// the OpenSSH `DefaultShell` to Git Bash (#5015; the Windows SSH Host lane's
/// `bash` leg, `scripts/internal/run-windows-ssh-host-suite.sh bash`), and
/// `powershell` / `pwsh` that it set Windows PowerShell 5.1 / PowerShell 7
/// (the `powershell` leg, #5044).
fn fixture_shell() -> RemoteShell {
    let login_shell = std::env::var("TERMIHUB_NATIVE_SSHD_LOGIN_SHELL");
    if cfg!(windows) {
        return match login_shell.as_deref() {
            Ok("gitbash") => RemoteShell::WindowsPosix,
            // #5044: Windows PowerShell 5.1 or PowerShell 7 as DefaultShell.
            Ok("powershell" | "pwsh") => RemoteShell::PowerShell,
            _ => RemoteShell::Cmd,
        };
    }
    match login_shell.as_deref() {
        Ok("pwsh") => RemoteShell::UnixPowerShell,
        Ok("fish") => RemoteShell::Fish {
            native_integration: true,
            windows: false,
        },
        Ok("fish3") => RemoteShell::Fish {
            native_integration: false,
            windows: false,
        },
        _ => RemoteShell::Posix,
    }
}

/// [`SHELL_LINE`] / [`SHELL_EXPECT`] in the fixture login shell's syntax.
fn first_command(shell: RemoteShell) -> (&'static str, &'static str) {
    match shell {
        RemoteShell::UnixPowerShell | RemoteShell::PowerShell => (
            "Write-Output ('native-' + (40+2) + '-ok')\r",
            "native-42-ok",
        ),
        // fish has no `$((...))`; a POSIX line would be a parse error there.
        RemoteShell::Fish { .. } => ("echo native-(math 40+2)-ok\n", "native-42-ok"),
        // A POSIX shell on Windows (#5015): `SHELL_LINE` is cmd.exe's there.
        RemoteShell::WindowsPosix => ("echo native-$((40+2))-ok\n", "native-42-ok"),
        _ => (SHELL_LINE, SHELL_EXPECT),
    }
}

#[tokio::test]
async fn native_05b_remote_shell_probe_detects_the_login_shell() {
    let sshd = require_native_sshd!();

    let (session, _) = connect_and_authenticate(&sshd.key_config())
        .await
        .expect("key auth with the fixture client key should succeed");
    assert_eq!(detect_remote_shell(&session).await, fixture_shell());
}

/// Type `line` into `ssh` and collect its output until `done` holds for it
/// (or 30 s pass); returns whether it did, and the output.
///
/// Plays the terminal's part for cursor-position queries (`ESC [6n`) and
/// device-attribute queries (`ESC [0c`), as the app's xterm does: PSReadLine
/// on Unix sends the former and fish 4 the latter, and each waits for the
/// reply, so a pwsh or fish login shell stalls without one. bash / zsh /
/// cmd.exe never ask.
async fn type_and_wait(ssh: &mut Ssh, line: &str, done: impl Fn(&str) -> bool) -> (bool, String) {
    let mut rx = ssh.subscribe_output();
    ssh.write(line.as_bytes()).expect("write to the shell");
    let mut seen = String::new();
    let ok = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(chunk) = rx.recv().await {
            let text = String::from_utf8_lossy(&chunk);
            for _ in 0..text.matches("\x1b[6n").count() {
                let _ = ssh.write(b"\x1b[1;1R");
            }
            // fish 4 waits up to 10 s for the Primary Device Attributes
            // reply before its first prompt (#5016); xterm.js answers it.
            for _ in 0..text.matches("\x1b[0c").count() {
                let _ = ssh.write(b"\x1b[?62;22c");
            }
            seen.push_str(&text);
            if done(&seen) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    (ok, seen)
}

/// #4143 / #4148: with shell integration ON (the default) the first typed
/// command must run — the setup line may never swallow it — and the host's
/// terminal shows only setup the shell understands.
#[tokio::test]
async fn native_05c_first_command_runs_with_shell_integration_on() {
    let sshd = require_native_sshd!();
    let shell = fixture_shell();

    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["shellIntegration"] = serde_json::Value::Bool(true);
    ssh.connect(settings).await.expect("shell session connects");

    // POSIX / pwsh: the OSC 7 hook is live once a prompt after the command
    // prints it.
    let want_osc7 = shell != RemoteShell::Cmd;
    let (line, expect) = first_command(shell);
    let (done, seen) = type_and_wait(&mut ssh, line, |seen| {
        seen.contains(expect) && (!want_osc7 || seen.contains("\x1b]7;file://"))
    })
    .await;
    assert!(
        done,
        "the first command did not run (or no OSC 7 followed); output so far: {seen:?}"
    );
    if shell == RemoteShell::WindowsPosix {
        // #5015: a POSIX shell on Windows gets the POSIX setup, but its echo
        // is deliberately not filtered (ConPTY renders the session), so it
        // may show. Only a PowerShell / cmd.exe setup would be wrong there.
        for wrong in ["$env:", "ParserError"] {
            assert!(!seen.contains(wrong), "{wrong:?} sent to bash: {seen:?}");
        }
    } else if !matches!(shell, RemoteShell::Posix | RemoteShell::Fish { .. }) {
        assert!(
            !seen.contains("PROMPT_COMMAND"),
            "{shell:?} must not be sent the POSIX setup; output: {seen:?}"
        );
    } else {
        // #5009 / #5016: the POSIX or fish setup is typed at the first prompt
        // and its echo never reaches the terminal.
        for leak in [
            "__termihub",
            "PROMPT_COMMAND",
            "precmd_functions",
            "6973;",
            "--on-event",
        ] {
            assert!(!seen.contains(leak), "setup text {leak:?} shown: {seen:?}");
        }
    }
    if matches!(shell, RemoteShell::Fish { .. }) {
        // #5016: fish was once typed the bash hook — a parse error.
        for error in ["fish: ", "Unsupported use of", "Expected a command"] {
            assert!(!seen.contains(error), "fish reported {error:?}: {seen:?}");
        }
    }
    if shell == RemoteShell::Cmd {
        assert!(
            !seen.contains("[termiHub]"),
            "cmd.exe got a setup: {seen:?}"
        );
    }
    if want_osc7 {
        // #4148: pwsh on Unix once sent `file:////home/me` (no host, an extra
        // slash). The POSIX hook sends `file:///path` (empty host, valid); the
        // PowerShell one always names the host.
        assert!(!seen.contains("file:////"), "malformed OSC 7: {seen:?}");
        if shell == RemoteShell::UnixPowerShell {
            let at = seen.find("\x1b]7;file://").unwrap() + "\x1b]7;file://".len();
            assert!(
                !seen[at..].starts_with('/'),
                "OSC 7 without a host: {seen:?}"
            );
        }
    }

    ssh.disconnect().await.expect("disconnect cleanly");
}

/// #4147: configured environment variables reach the interactive shell
/// through the typed fallback (the fixture's sshd accepts no `AcceptEnv`
/// names), in the login shell's own syntax — and the first command after it
/// still runs. The value carries quotes and `$` to prove the quoting.
#[tokio::test]
async fn native_05d_env_vars_apply_in_the_login_shell_and_first_command_runs() {
    let sshd = require_native_sshd!();
    let shell = fixture_shell();

    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["shellIntegration"] = serde_json::Value::Bool(true);
    // Every shell takes this literally (cmd.exe would skip a `%` or `"`).
    let value = "it's a $HOME value";
    settings["env"] = serde_json::json!({ "TH_4147_VAR": value });
    ssh.connect(settings).await.expect("shell session connects");

    let line = match shell {
        RemoteShell::Cmd => "echo [%TH_4147_VAR%]\r",
        RemoteShell::UnixPowerShell | RemoteShell::PowerShell => {
            "Write-Output ('[' + $env:TH_4147_VAR + ']')\r"
        }
        _ => "echo \"[$TH_4147_VAR]\"\n",
    };
    // Neither the setup line's echo nor the command's echo contains this.
    let expect = format!("[{value}]");
    let (done, seen) = type_and_wait(&mut ssh, line, |seen| seen.contains(&expect)).await;
    assert!(
        done,
        "{shell:?}: the env var did not reach the shell (or the command did not run); \
         output so far: {seen:?}"
    );
    if shell == RemoteShell::WindowsPosix {
        // #5015: typed as a POSIX `export`, whose echo is not filtered there.
    } else if shell != RemoteShell::Posix {
        assert!(
            !seen.contains("export "),
            "{shell:?} got the POSIX export: {seen:?}"
        );
    } else {
        // #5009: the env fallback is typed with the hidden setup line, so
        // its value is never echoed.
        assert!(
            !seen.contains("TH_4147_VAR=") && !seen.contains("__termihub"),
            "the typed env setup was shown: {seen:?}"
        );
    }
    if matches!(shell, RemoteShell::Fish { .. }) {
        // #5016: fish gets its own syntax — never a parse error.
        for error in ["fish: ", "Unsupported use of", "Expected a command"] {
            assert!(!seen.contains(error), "fish reported {error:?}: {seen:?}");
        }
        // #5094: and the typed setup stays hidden although fish redraws its
        // input cell by cell — in the terminal, in the window title (OSC 0)
        // and in fish 4's own command mark (`OSC 133;C;cmdline_url=`).
        for leak in ["set -gx", "TH_4147_VAR%20", "6973;", "__termihub"] {
            assert!(!seen.contains(leak), "setup text {leak:?} shown: {seen:?}");
        }
    }

    ssh.disconnect().await.expect("disconnect cleanly");
}

/// #5009: with default settings nothing is typed into the remote shell — no
/// setup text, no function, `PROMPT_COMMAND` / `precmd` / `PS1` untouched —
/// and the file browser still follows the shell: OSC 7 for the start
/// directory and after a `cd`, read over a side channel. (History is checked
/// by the hermetic local test: the fixture logs in as the real CI/dev user,
/// and on macOS/Linux its scratch home holds a history the other tests of
/// this binary write to as well.)
#[tokio::test]
async fn native_05e_default_session_follows_cwd_without_touching_the_shell() {
    let sshd = require_native_sshd!();
    if fixture_shell() != RemoteShell::Posix {
        eprintln!("cwd following over SSH needs a Unix host; skipping");
        return;
    }
    let target = tempfile::tempdir().expect("target dir");
    let target = std::fs::canonicalize(target.path()).expect("canonical");

    let mut ssh = Ssh::new();
    ssh.connect(sshd.key_settings()).await.expect("connect");
    let mut rx = ssh.subscribe_output();
    let mut seen = String::new();
    let mut read_until = async |seen: &mut String, what: &str, done: &dyn Fn(&str) -> bool| {
        let ok = tokio::time::timeout(Duration::from_secs(30), async {
            while !done(seen) {
                match rx.recv().await {
                    Some(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk)),
                    None => return false,
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        assert!(ok, "timed out waiting for {what}: {seen:?}");
    };
    read_until(&mut seen, "the start directory", &|s| {
        s.contains("\x1b]7;file://")
    })
    .await;

    ssh.write(format!("cd '{}'\n", target.display()).as_bytes())
        .expect("write");
    let name = target.file_name().unwrap().to_string_lossy().to_string();
    let report = format!("{name}\x07");
    read_until(&mut seen, "the new directory", &|s| s.contains(&report)).await;

    let probe = concat!(
        r#"echo "TH$((1)):$(typeset -f 2>/dev/null | grep -c termihub):"#,
        r#"${PROMPT_COMMAND}:${precmd_functions}:"#,
        r#"$(printf %s "$PS1" | grep -c 133):END""#,
        "\n"
    );
    ssh.write(probe.as_bytes()).expect("write");
    read_until(&mut seen, "the probe", &|s| s.contains("TH1:")).await;
    read_until(&mut seen, "the probe end", &|s| s.contains(":END")).await;
    let line = seen
        .lines()
        .rev()
        .find(|l| l.contains("TH1:"))
        .unwrap_or_default()
        .to_string();
    assert!(
        line.contains("TH1:0:"),
        "a termiHub function exists: {line:?}"
    );
    assert!(
        !line.contains("termihub") && line.ends_with(":0:END"),
        "the prompt hooks or PS1 were changed: {line:?}"
    );
    for leak in ["__termihub", "[termiHub]", "6973;", "\x1b]133;"] {
        assert!(
            !seen.contains(leak),
            "{leak:?} reached the terminal: {seen:?}"
        );
    }
    ssh.disconnect().await.expect("disconnect cleanly");
}

/// #5028: a Windows SSH host is NOT followed without the hook. With default
/// settings (no Command Marks) nothing is typed into the shell AND no OSC 7
/// is synthesised for it either — so a `cd` on the Git Bash host of the
/// `bash` leg moves the shell with no `file://` report. The documented
/// behaviour (Windows needs the hook) is pinned here; cwd following on
/// Windows is only reachable through the opt-in setting.
#[tokio::test]
async fn native_05g_windows_host_is_not_followed_without_the_hook() {
    let sshd = require_native_sshd!();
    if fixture_shell() != RemoteShell::WindowsPosix {
        eprintln!("this grade is for a Windows SSH host (the bash leg); skipping");
        return;
    }
    let mut ssh = Ssh::new();
    ssh.connect(sshd.key_settings()).await.expect("connect");
    let mut rx = ssh.subscribe_output();
    let mut seen = String::new();
    let mut read_until = async |seen: &mut String, what: &str, done: &dyn Fn(&str) -> bool| {
        let ok = tokio::time::timeout(Duration::from_secs(30), async {
            while !done(seen) {
                match rx.recv().await {
                    Some(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk)),
                    None => return false,
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        assert!(ok, "timed out waiting for {what}: {seen:?}");
    };

    // `cd /` moves the shell, then a marker proves the shell processed input
    // past the cd. A hook-free Windows session must show no OSC 7 directory
    // report at any point.
    ssh.write(
        b"cd /
",
    )
    .expect("write");
    ssh.write(
        b"echo th-5028-$((20+8))-done
",
    )
    .expect("write");
    read_until(&mut seen, "the marker", &|s| s.contains("th-5028-28-done")).await;
    // A little more output, so a late report would have arrived.
    ssh.write(
        b"echo th-5028-tail
",
    )
    .expect("write");
    read_until(&mut seen, "the tail", &|s| s.contains("th-5028-tail")).await;
    assert!(
        !seen.contains("\x1b]7;file://") && !seen.contains("]7;file://"),
        "a Windows host was followed without the hook: {seen:?}"
    );
    for leak in ["__termihub", "[termiHub]", "6973;", "\x1b]133;"] {
        assert!(
            !seen.contains(leak),
            "{leak:?} reached the terminal: {seen:?}"
        );
    }
    ssh.disconnect().await.expect("disconnect cleanly");
}

/// #5044: with the opt-in hook on, a Windows PowerShell host's login banner
/// stays and none of the typed setup is left on screen. The setup used to end
/// with `Clear-Host`; it now erases only its own echo rows. ConPTY streams
/// the echo before the erase, so the screen is graded — the raw stream
/// replayed through a small terminal model — plus the raw stream for any
/// screen clear after the banner. The `powershell` leg of the Windows SSH
/// Host lane runs it under Windows PowerShell 5.1 and PowerShell 7.
#[tokio::test]
async fn native_05h_powershell_hook_keeps_the_login_banner() {
    let sshd = require_native_sshd!();
    let banner = match std::env::var("TERMIHUB_NATIVE_SSHD_LOGIN_SHELL").as_deref() {
        Ok("powershell") if cfg!(windows) => "Windows PowerShell",
        Ok("pwsh") if cfg!(windows) => "PowerShell 7",
        _ => {
            eprintln!("this grade is for a Windows PowerShell SSH host; skipping");
            return;
        }
    };
    let (cols, rows) = (100usize, 60usize);
    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["shellIntegration"] = serde_json::Value::Bool(true);
    settings["cols"] = serde_json::json!(cols);
    settings["rows"] = serde_json::json!(rows);
    // A configured env var is typed with the hook (#4147) and must not stay
    // on screen either.
    settings["env"] = serde_json::json!({ "TH_5044_VAR": "th5044value" });
    ssh.connect(settings).await.expect("shell session connects");

    let line = "Write-Output ('[' + $env:TH_5044_VAR + '-' + (40+2) + ']')\r";
    let (done, mut seen) = type_and_wait(&mut ssh, line, |seen| {
        seen.contains("[th5044value-42]") && seen.contains("\x1b]7;file://")
    })
    .await;
    assert!(done, "the first command did not run: {seen:?}");
    // Let the prompt after it render.
    let mut rx = ssh.subscribe_output();
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(chunk) = rx.recv().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await;

    let at = seen
        .find(banner)
        .unwrap_or_else(|| panic!("no {banner:?} banner in the stream: {seen:?}"));
    for clear in ["\x1b[2J", "\x1b[3J", "\x1bc"] {
        assert!(
            !seen[at..].contains(clear),
            "{clear:?} cleared the screen after the banner: {seen:?}"
        );
    }
    let text = screen::render(seen.as_bytes(), cols, rows);
    eprintln!("---- rendered terminal ----\n{text}\n---------------------------");
    assert!(text.contains(banner), "the banner is gone: {text}");
    assert!(
        text.contains("[th5044value-42]"),
        "no command output: {text}"
    );
    for leak in [
        "__th_",
        "th5044value'",
        "TH_5044_VAR=",
        "PSConsoleReadLine",
        "133;",
    ] {
        assert!(
            !text.contains(leak),
            "setup text {leak:?} left on screen: {text}"
        );
    }
    // Only the user's own command line shows, once.
    assert_eq!(text.matches("Write-Output").count(), 1, "{text}");
    ssh.disconnect().await.expect("disconnect cleanly");
}

/// #5147: a session on a Windows PowerShell host loads the user's profile
/// exactly once, for its own shell. With a profile on the test user
/// (`$PROFILE.CurrentUserAllHosts`) that appends to a marker file and prints a
/// line, a hooked session with an env var runs it once, and so does a
/// hook-free one with an env var. Both need the login shell, and on a
/// Win32-OpenSSH host it is told from PowerShell's banner, not from an exec
/// channel that would run as `powershell -c` and load the profile again. The
/// profile and the marker are removed afterwards, also when the grade fails.
/// The `powershell` leg of the Windows SSH Host lane runs it under Windows
/// PowerShell 5.1 and PowerShell 7.
#[tokio::test]
async fn native_05j_powershell_profile_runs_once_per_session() {
    // The profile is the fixture user's, so no other test may log in while
    // it is counted (#5289).
    let sshd = require_native_sshd!(exclusive);
    if !cfg!(windows) || fixture_shell() != RemoteShell::PowerShell {
        eprintln!("this grade is for a Windows PowerShell SSH host; skipping");
        return;
    }
    let (session, _) = connect_and_authenticate(&sshd.key_config())
        .await
        .expect("key auth");
    // These execs run as `powershell -c`, so `$PROFILE` is the profile of
    // the DefaultShell under test (5.1's and 7's live apart). They may load
    // the profile themselves; the grade only counts what ran between them.
    // No double quotes: Win32-OpenSSH hands the command over in them.
    let set = ssh_exec(
        &session,
        &format!(
            "$p = $PROFILE.CurrentUserAllHosts; \
             Remove-Item -Force -ErrorAction SilentlyContinue {PROFILE_MARKER}; \
             $null = New-Item -ItemType Directory -Force -Path (Split-Path $p); \
             Set-Content -Path $p -Value '{PROFILE_BODY}'; \
             Write-Output ('th5147-set:' + $p)"
        ),
    )
    .await
    .expect("write the test profile");
    eprintln!("[5147] {}", set.trim());
    assert!(
        set.contains("th5147-set:"),
        "the test profile was not set up: {set:?}"
    );
    // Run the grade as its own task so a failure still reaches the cleanup.
    let grade = tokio::spawn(powershell_profile_grade(sshd.clone())).await;
    let cleanup = ssh_exec(
        &session,
        &format!(
            "Remove-Item -Force -ErrorAction SilentlyContinue \
             $PROFILE.CurrentUserAllHosts, {PROFILE_MARKER}; \
             Write-Output ('th5147-' + 'cleaned')"
        ),
    )
    .await;
    if let Err(e) = grade {
        std::panic::resume_unwind(e.into_panic());
    }
    let cleanup = cleanup.expect("remove the test profile");
    assert!(
        cleanup.contains("th5147-cleaned"),
        "the test profile was not removed: {cleanup:?}"
    );
}

/// The test profile's marker file (#5147), as a PowerShell expression.
const PROFILE_MARKER: &str = "(Join-Path $HOME 'th5147-profile.log')";

/// The test profile (#5147), inside a single-quoted PowerShell string: it
/// appends a line to [`PROFILE_MARKER`] and prints one, as a chatty profile
/// does before the first prompt.
const PROFILE_BODY: &str = "Add-Content -Path (Join-Path $HOME ''th5147-profile.log'') \
     -Value th5147-ran; Write-Output th5147-profile-says-hi";

/// How often the test profile has run so far, read in `ssh`'s PowerShell
/// with `Get-Content` (a cmdlet: no child process, so no profile of its own).
async fn profile_runs(ssh: &mut Ssh) -> usize {
    // Split in the typed line, so only its output has the whole tag.
    const TAG: &str = "[th5147-runs=";
    let line = format!(
        "Write-Output ('[th5147-' + 'runs=' + @(Get-Content -ErrorAction \
         SilentlyContinue {PROFILE_MARKER}).Count + ']')\r"
    );
    let count = |s: &str| {
        s.rmatch_indices(TAG).find_map(|(at, _)| {
            let rest = &s[at + TAG.len()..];
            rest.split(']').next()?.parse::<usize>().ok()
        })
    };
    let (done, seen) = type_and_wait(ssh, &line, |s| count(s).is_some()).await;
    assert!(done, "could not read the profile marker: {seen:?}");
    count(&seen).expect("a count")
}

async fn powershell_profile_grade(sshd: common::NativeSshd) {
    let line = "Write-Output ('[' + $env:TH_5147_VAR + '-' + (40+2) + ']')\r";

    // A hooked session with an env var: its setup is typed after the banner,
    // the profile's output and the first prompt.
    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["shellIntegration"] = serde_json::Value::Bool(true);
    settings["env"] = serde_json::json!({ "TH_5147_VAR": "th5147value" });
    ssh.connect(settings).await.expect("shell session connects");
    let (done, seen) = type_and_wait(&mut ssh, line, |s| {
        s.contains("[th5147value-42]") && s.contains("\x1b]7;file://")
    })
    .await;
    assert!(
        done,
        "the first command did not run with the hook: {seen:?}"
    );
    assert!(
        seen.contains("th5147-profile-says-hi"),
        "the test profile did not run in the session shell: {seen:?}"
    );
    let hooked_runs = profile_runs(&mut ssh).await;
    ssh.disconnect().await.expect("disconnect cleanly");

    // A hook-free session with an env var needs the login shell too.
    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["env"] = serde_json::json!({ "TH_5147_VAR": "th5147value" });
    ssh.connect(settings).await.expect("connect");
    let (done, seen) = type_and_wait(&mut ssh, line, |s| s.contains("[th5147value-42]")).await;
    assert!(done, "the first command did not run: {seen:?}");
    let all_runs = profile_runs(&mut ssh).await;
    ssh.disconnect().await.ok();

    eprintln!("[5147] profile runs: hooked session {hooked_runs}, both sessions {all_runs}");
    assert_eq!(
        hooked_runs, 1,
        "the hooked session loaded the profile other than once, for its shell"
    );
    assert_eq!(
        all_runs, 2,
        "the hook-free session with an env var loaded the profile other than once"
    );
}

/// #5109: with the opt-in hook on, a cmd.exe DefaultShell is followed: a
/// `cd` reports the new directory (OSC 7). The typed setup leaves nothing
/// behind: no setup text on screen (the raw stream replayed through the
/// terminal model), no entry in the console's command history (`doskey
/// /history`, Alt+F7 cleared it), `ERRORLEVEL` still 0 for the first command.
/// It also runs no extra AutoRun: with an AutoRun on the test user that
/// appends to a marker file, a hooked session runs it exactly once, for its
/// own shell, and so does a hook-free one with an env var configured — whose
/// setup is hidden and kept out of the history too (#5131). Both
/// need the login shell, and on a Win32-OpenSSH host it is told from cmd.exe's
/// banner, not from an exec channel that would run as `cmd.exe /c` (#5134).
/// The AutoRun is removed afterwards, also when the grade fails. The test
/// holds the fixture user to itself while it counts (#5289).
/// The `cmd` leg of the Windows SSH Host lane runs it.
#[tokio::test]
async fn native_05i_cmd_hook_follows_cd_and_leaves_no_history() {
    // The AutoRun is the fixture user's: every other test's login shell and
    // exec channel would run it too, so none may run while it is counted
    // (#5289).
    let sshd = require_native_sshd!(exclusive);
    if !cfg!(windows) || fixture_shell() != RemoteShell::Cmd {
        eprintln!("this grade is for a cmd.exe Windows SSH host; skipping");
        return;
    }
    let (session, _) = connect_and_authenticate(&sshd.key_config())
        .await
        .expect("key auth");
    // The value is expanded by this exec's cmd.exe, so it names the path.
    // Both AutoRun values are read back in the same exec (its own AutoRun ran
    // before the marker was set), for the grade's failure message (#5289).
    let keys = ssh_exec(
        &session,
        &format!(
            "del /q {AUTORUN_MARKER} 2>nul & reg add \"{AUTORUN_KEY}\" /v AutoRun /t REG_SZ \
             /d \"echo th5109-autorun>>{AUTORUN_MARKER}\" /f & reg query \"{AUTORUN_KEY}\" \
             /v AutoRun 2>&1 & reg query \"{AUTORUN_MACHINE_KEY}\" /v AutoRun 2>&1 & (call )"
        ),
    )
    .await
    .expect("set the test AutoRun");
    eprintln!("[5289] AutoRun values (HKCU, then HKLM):\n{}", keys.trim());
    // Run the grade as its own task so a failure still reaches the cleanup.
    let grade = tokio::spawn(cmd_hook_grade(sshd.clone(), keys)).await;
    let cleanup = ssh_exec(
        &session,
        &format!("reg delete \"{AUTORUN_KEY}\" /v AutoRun /f & del /q {AUTORUN_MARKER}"),
    )
    .await;
    if let Err(e) = grade {
        std::panic::resume_unwind(e.into_panic());
    }
    cleanup.expect("remove the test AutoRun");
}

/// The test AutoRun's registry key and marker file (#5109).
const AUTORUN_KEY: &str = r"HKCU\Software\Microsoft\Command Processor";
/// The machine-wide AutoRun key, read only for the grade's message (#5289):
/// its command, if any, cannot write [`AUTORUN_MARKER`].
const AUTORUN_MACHINE_KEY: &str = r"HKLM\Software\Microsoft\Command Processor";
const AUTORUN_MARKER: &str = r"%USERPROFILE%\th5109-autorun.log";

/// How often the test AutoRun has run so far, read in `ssh`'s shell with the
/// `type` builtin (no child process, so no AutoRun of its own).
/// Also returns what the read showed, for a failure message.
async fn autorun_runs(ssh: &mut Ssh) -> (usize, String) {
    let (done, seen) = type_and_wait(
        ssh,
        &format!("type {AUTORUN_MARKER}\recho th5109-%OS%-counted\r"),
        |s| s.contains("th5109-Windows_NT-counted"),
    )
    .await;
    assert!(done, "could not read the AutoRun marker: {seen:?}");
    let runs = seen.matches("th5109-autorun").count() - seen.matches("th5109-autorun.log").count();
    (runs, seen)
}

/// `keys` is what `reg query` showed for the HKCU and HKLM AutoRun, for the
/// failure message.
async fn cmd_hook_grade(sshd: common::NativeSshd, keys: String) {
    let (cols, rows) = (100usize, 60usize);
    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["shellIntegration"] = serde_json::Value::Bool(true);
    settings["cols"] = serde_json::json!(cols);
    settings["rows"] = serde_json::json!(rows);
    // A configured env var is typed with the hook and joined into its line.
    settings["env"] = serde_json::json!({ "TH_5109_VAR": "th5109value" });
    ssh.connect(settings).await.expect("shell session connects");

    let (done, mut all) =
        type_and_wait(&mut ssh, "echo [%TH_5109_VAR%-%OS%-%ERRORLEVEL%]\r", |s| {
            s.contains("[th5109value-Windows_NT-0]") && s.contains("\x1b]7;file://")
        })
        .await;
    assert!(done, "the first command did not run with the hook: {all:?}");

    let (done, seen) = type_and_wait(&mut ssh, "cd \\\recho th5109-cd-%OS%\r", |s| {
        s.contains("th5109-cd-Windows_NT")
    })
    .await;
    all.push_str(&seen);
    assert!(done, "the cd did not run: {seen:?}");
    assert!(
        seen.contains("/C:\\\x1b\\"),
        "no OSC 7 report of C:\\ after the cd: {seen:?}"
    );

    let (done, history) = type_and_wait(&mut ssh, "doskey /history\recho th5109-%OS%-end\r", |s| {
        s.contains("th5109-Windows_NT-end")
    })
    .await;
    all.push_str(&history);
    assert!(done, "doskey /history did not run: {history:?}");
    eprintln!("---- doskey /history ----\n{history:?}");
    assert!(
        history.contains("cd \\"),
        "the user's own commands are in the history: {history:?}"
    );
    for leak in ["PROMPT", "/d /k", "TH_5109_VAR=", "18;3~"] {
        assert!(
            !history.contains(leak),
            "the setup {leak:?} is in the command history: {history:?}"
        );
    }

    // Let the prompt after it render.
    let mut rx = ssh.subscribe_output();
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(chunk) = rx.recv().await {
            all.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await;
    let text = screen::render(all.as_bytes(), cols, rows);
    eprintln!("---- rendered terminal ----\n{text}\n---------------------------");
    let (hooked_runs, hooked_read) = autorun_runs(&mut ssh).await;
    if all.contains("Microsoft Windows") {
        assert!(
            text.contains("Microsoft Windows"),
            "the banner is gone: {text}"
        );
    }
    for clear in ["\x1b[3J", "\x1bc"] {
        assert!(
            !all.contains(clear),
            "{clear:?} cleared the screen: {all:?}"
        );
    }
    for leak in [
        "System32\\cmd.exe",
        "/d /k",
        "$E[",
        "PROMPT=",
        "TH_5109_VAR=",
        "133;",
    ] {
        assert!(
            !text.contains(leak),
            "setup text {leak:?} left on screen: {text}"
        );
    }
    // Only the user's own first command line shows, once, after a prompt
    // (the history listing shows it a second time, without one).
    assert_eq!(text.matches(">echo [%TH_5109_VAR%").count(), 1, "{text}");
    ssh.disconnect().await.expect("disconnect cleanly");

    // The hook expands `%PROMPT%`, so it relies on an interactive cmd.exe
    // defining PROMPT itself (as `$P$G`) when it starts with none (#5109):
    // otherwise `%PROMPT%` would stay literal in the prompt.
    // A configured env var makes this hook-free session need the host's login
    // shell too (#5134): it must not ask over an exec channel either.
    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["cols"] = serde_json::json!(cols);
    settings["rows"] = serde_json::json!(rows);
    settings["env"] = serde_json::json!({ "TH_5109_VAR": "th5109value" });
    ssh.connect(settings).await.expect("connect");
    hook_free_setup_leaves_nothing(&mut ssh, cols, rows).await;
    let (done, seen) = type_and_wait(
        &mut ssh,
        "set \"PROMPT=\"\rcmd /d\rset PROMPT\rexit\recho th5109-%OS%-probe\r",
        |s| s.contains("th5109-Windows_NT-probe"),
    )
    .await;
    assert!(done, "the PROMPT check did not run: {seen:?}");
    assert!(
        seen.contains("PROMPT=$P$G"),
        "a cmd.exe started without PROMPT did not define it: {seen:?}"
    );
    // Each session ran the AutoRun once, for its own shell (#5134): no
    // login-shell probe on an exec channel, and the hooked session's echo
    // erase runs its child cmd.exe with `/d` (the `cmd /d` above skips it too).
    let (all_runs, all_read) = autorun_runs(&mut ssh).await;
    eprintln!("[5134] AutoRun runs: hooked session {hooked_runs}, both sessions {all_runs}");
    assert_eq!(
        hooked_runs, 1,
        "the hooked session ran the AutoRun other than once, for its shell; \
         marker read: {hooked_read:?}; AutoRun values: {keys:?}"
    );
    assert_eq!(
        all_runs, 2,
        "the hook-free session with an env var ran the AutoRun other than once; \
         marker read: {all_read:?}; AutoRun values: {keys:?}"
    );
    ssh.disconnect().await.ok();
}

/// #5131: with the hook off, a cmd.exe session's env-var setup leaves no
/// trace either. The variable applies to the first command (`ERRORLEVEL`
/// still 0), but no `set` line is on screen (the raw stream replayed through
/// the terminal model) or in the console's command history (`doskey
/// /history`), while the user's own command is. The session sets no `PROMPT`
/// marks: no OSC 133 in its output.
async fn hook_free_setup_leaves_nothing(ssh: &mut Ssh, cols: usize, rows: usize) {
    let (done, mut all) = type_and_wait(ssh, "echo [%TH_5109_VAR%-%OS%-%ERRORLEVEL%]\r", |s| {
        s.contains("[th5109value-Windows_NT-0]")
    })
    .await;
    assert!(
        done,
        "the first command did not run without the hook: {all:?}"
    );

    let (done, history) = type_and_wait(ssh, "doskey /history\recho th5131-%OS%-end\r", |s| {
        s.contains("th5131-Windows_NT-end")
    })
    .await;
    all.push_str(&history);
    assert!(done, "doskey /history did not run: {history:?}");
    eprintln!("---- doskey /history (hook off) ----\n{history:?}");
    assert!(
        history.contains("echo [%TH_5109_VAR%"),
        "the user's own command is in the history: {history:?}"
    );
    for leak in ["TH_5109_VAR=", "set \"", "/d /k", "18;3~"] {
        assert!(
            !history.contains(leak),
            "the setup {leak:?} is in the command history (hook off): {history:?}"
        );
    }

    // Let the prompt after it render.
    let mut rx = ssh.subscribe_output();
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(chunk) = rx.recv().await {
            all.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await;
    let text = screen::render(all.as_bytes(), cols, rows);
    eprintln!("---- rendered terminal (hook off) ----\n{text}\n---------------------------");
    if all.contains("Microsoft Windows") {
        assert!(
            text.contains("Microsoft Windows"),
            "the banner is gone: {text}"
        );
    }
    for clear in ["\x1b[3J", "\x1bc"] {
        assert!(
            !all.contains(clear),
            "{clear:?} cleared the screen: {all:?}"
        );
    }
    assert!(
        !all.contains("\x1b]133;"),
        "the hook-free session set marks"
    );
    for leak in [
        "System32\\cmd.exe",
        "/d /k",
        "$E[",
        "TH_5109_VAR=",
        "set \"",
    ] {
        assert!(
            !text.contains(leak),
            "setup text {leak:?} left on screen (hook off): {text}"
        );
    }
    assert_eq!(text.matches(">echo [%TH_5109_VAR%").count(), 1, "{text}");
}

/// A minimal terminal model to grade what a raw stream leaves on screen
/// (#5044): printable text, CR / LF / BS / TAB, autowrap, scrolling (into
/// a scrollback that is kept), and the CSI cursor / erase / insert / delete
/// sequences ConPTY emits. OSC strings and other escapes are skipped.
mod screen {
    struct Term {
        cols: usize,
        rows: usize,
        grid: Vec<Vec<char>>,
        scrollback: Vec<Vec<char>>,
        x: usize,
        y: usize,
        wrap_pending: bool,
        saved: (usize, usize),
    }

    impl Term {
        fn line_feed(&mut self) {
            if self.y + 1 == self.rows {
                let top = self.grid.remove(0);
                self.scrollback.push(top);
                self.grid.push(vec![' '; self.cols]);
            } else {
                self.y += 1;
            }
        }

        fn put(&mut self, c: char) {
            if self.wrap_pending {
                self.x = 0;
                self.line_feed();
                self.wrap_pending = false;
            }
            self.grid[self.y][self.x] = c;
            if self.x + 1 == self.cols {
                self.wrap_pending = true;
            } else {
                self.x += 1;
            }
        }

        fn csi(&mut self, params: &str, fin: char) {
            let private = params.starts_with(['?', '>', '=']);
            let nums: Vec<usize> = params
                .trim_start_matches(['?', '>', '='])
                .split(';')
                .map(|p| p.parse().unwrap_or(0))
                .collect();
            let n = |i: usize| nums.get(i).copied().filter(|&v| v > 0).unwrap_or(1);
            let raw = |i: usize| nums.get(i).copied().unwrap_or(0);
            if private {
                return;
            }
            let (cols, rows) = (self.cols, self.rows);
            self.wrap_pending = false;
            match fin {
                'A' => self.y = self.y.saturating_sub(n(0)),
                'B' | 'e' => self.y = (self.y + n(0)).min(rows - 1),
                'C' | 'a' => self.x = (self.x + n(0)).min(cols - 1),
                'D' => self.x = self.x.saturating_sub(n(0)),
                'E' => (self.x, self.y) = (0, (self.y + n(0)).min(rows - 1)),
                'F' => (self.x, self.y) = (0, self.y.saturating_sub(n(0))),
                'G' | '`' => self.x = (n(0) - 1).min(cols - 1),
                'd' => self.y = (n(0) - 1).min(rows - 1),
                'H' | 'f' => {
                    self.y = (n(0) - 1).min(rows - 1);
                    self.x = (n(1) - 1).min(cols - 1);
                }
                'J' => {
                    let (x, y) = (self.x, self.y);
                    let rows_to_clear: Vec<usize> = match raw(0) {
                        0 => {
                            self.grid[y][x..].fill(' ');
                            (y + 1..rows).collect()
                        }
                        1 => {
                            self.grid[y][..=x].fill(' ');
                            (0..y).collect()
                        }
                        _ => (0..rows).collect(),
                    };
                    for r in rows_to_clear {
                        self.grid[r].fill(' ');
                    }
                }
                'K' => {
                    let (x, row) = (self.x, &mut self.grid[self.y]);
                    match raw(0) {
                        0 => row[x..].fill(' '),
                        1 => row[..=x].fill(' '),
                        _ => row.fill(' '),
                    }
                }
                'X' => {
                    let end = (self.x + n(0)).min(cols);
                    self.grid[self.y][self.x..end].fill(' ');
                }
                '@' => {
                    let row = &mut self.grid[self.y];
                    for _ in 0..n(0).min(cols - self.x) {
                        row.insert(self.x, ' ');
                        row.pop();
                    }
                }
                'P' => {
                    let row = &mut self.grid[self.y];
                    for _ in 0..n(0).min(cols - self.x) {
                        row.remove(self.x);
                        row.push(' ');
                    }
                }
                'L' => {
                    for _ in 0..n(0).min(rows - self.y) {
                        self.grid.insert(self.y, vec![' '; cols]);
                        self.grid.pop();
                    }
                }
                'M' => {
                    for _ in 0..n(0).min(rows - self.y) {
                        self.grid.remove(self.y);
                        self.grid.push(vec![' '; cols]);
                    }
                }
                'S' => {
                    for _ in 0..n(0) {
                        let top = self.grid.remove(0);
                        self.scrollback.push(top);
                        self.grid.push(vec![' '; cols]);
                    }
                }
                's' => self.saved = (self.x, self.y),
                'u' => (self.x, self.y) = self.saved,
                _ => {} // SGR, modes, margins, reports: no visible text.
            }
        }
    }

    /// Replay `data` on a `cols` x `rows` terminal; the scrollback and the
    /// screen as text, one line per row, trailing blanks trimmed.
    pub fn render(data: &[u8], cols: usize, rows: usize) -> String {
        let mut t = Term {
            cols,
            rows,
            grid: vec![vec![' '; cols]; rows],
            scrollback: Vec::new(),
            x: 0,
            y: 0,
            wrap_pending: false,
            saved: (0, 0),
        };
        let text = String::from_utf8_lossy(data);
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\x1b' => match chars.next() {
                    Some('[') => {
                        let mut params = String::new();
                        while let Some(&p) = chars.peek() {
                            if ('\x20'..='\x3f').contains(&p) {
                                params.push(p);
                                chars.next();
                            } else {
                                break;
                            }
                        }
                        if let Some(fin) = chars.next() {
                            t.csi(&params, fin);
                        }
                    }
                    Some(']' | 'P' | '_' | '^') => {
                        // A string, ended by BEL or ST (ESC \).
                        while let Some(s) = chars.next() {
                            if s == '\x07' || (s == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                                break;
                            }
                        }
                    }
                    Some('7') => t.saved = (t.x, t.y),
                    Some('8') => (t.x, t.y) = t.saved,
                    Some('(' | ')' | '#') => {
                        chars.next();
                    }
                    _ => {}
                },
                '\r' => {
                    t.x = 0;
                    t.wrap_pending = false;
                }
                '\n' | '\x0b' | '\x0c' => {
                    t.wrap_pending = false;
                    t.line_feed();
                }
                '\x08' => {
                    t.wrap_pending = false;
                    t.x = t.x.saturating_sub(1);
                }
                '\t' => {
                    t.x = ((t.x / 8 + 1) * 8).min(cols - 1);
                }
                c if c < ' ' || c == '\x7f' => {}
                c => t.put(c),
            }
        }
        t.scrollback
            .iter()
            .chain(t.grid.iter())
            .map(|r| r.iter().collect::<String>().trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn model_follows_wrap_cursor_moves_and_erases() {
        let out = render(b"banner\r\nPS> abcdefgh\r\nnext\x1b[2A\r\x1b[J$ ", 8, 5);
        assert_eq!(out.trim_end(), "banner\n$");
        assert_eq!(render(b"ab\x1b[1;1Hx\x1b[K", 4, 2).trim_end(), "x");
        assert_eq!(render(b"a\x1b]0;title\x07b", 4, 1), "ab");
    }
}

/// The initial command's hook-free cue on a real sshd (#5029): a default
/// session's prompt probe recognises the fixture login shell's prompt (zsh or
/// bash, cmd.exe on Windows) well before the cap, and a line typed then runs
/// once.
#[tokio::test]
async fn native_05f_prompt_probe_recognises_the_login_shells_prompt() {
    let sshd = require_native_sshd!();
    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["shellIntegration"] = serde_json::Value::Bool(false);
    ssh.connect(settings).await.expect("shell session connects");
    let mut rx = ssh.subscribe_output();
    let probe = ssh.prompt_probe().expect("an SSH session offers a probe");

    let seen = Arc::new(std::sync::Mutex::new(String::new()));
    let reader_seen = seen.clone();
    let reader = tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            reader_seen
                .lock()
                .unwrap()
                .push_str(&String::from_utf8_lossy(&chunk));
        }
    });
    let text = || seen.lock().unwrap().clone();

    let signal = wait_for_prompt(None, Some(&probe)).await;
    let at_prompt = text();
    assert_eq!(
        signal,
        PromptSignal::Probe,
        "the prompt was not recognised; output: {at_prompt:?}"
    );
    assert!(
        !at_prompt.trim().is_empty(),
        "ready before the shell printed anything"
    );

    let (line, expect) = first_command(fixture_shell());
    ssh.write(line.as_bytes()).expect("write to the shell");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !text().contains(expect) && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let out = text();
    assert!(out.contains(expect), "the line never ran: {out:?}");
    // ConPTY may repaint the screen, so only POSIX output is counted.
    if !cfg!(windows) {
        assert_eq!(
            out.matches(expect).count(),
            1,
            "ran more than once: {out:?}"
        );
    }
    ssh.disconnect().await.expect("disconnect cleanly");
    reader.abort();
}

#[tokio::test]
async fn native_06_sftp_file_journey_is_byte_exact() {
    let sshd = require_native_sshd!();

    let mut ssh = Ssh::new();
    let mut settings = sshd.key_settings();
    settings["enableFileBrowser"] = serde_json::Value::Bool(true);
    settings["shellIntegration"] = serde_json::Value::Bool(false);
    ssh.connect(settings)
        .await
        .expect("connect with file browser");
    let browser = ssh.file_browser().expect("file browser is available");
    let sftp = browser
        .as_any()
        .and_then(|any| any.downcast_ref::<SftpFileBrowser>())
        .expect("the SSH file browser is an SftpFileBrowser");

    // Home as the server reports it: `/Users/x`, `/home/x`, or `/C:/Users/x`.
    let home = sftp.realpath(".").await.expect("realpath of the home dir");
    assert!(home.starts_with('/'), "SFTP home is absolute: {home:?}");
    // The SFTP session starts in the login user's real home even under
    // `--scratch-home` (sshd changes into the passwd home), so work below the
    // fixture's scratch home when it has one (#5296). Only the Windows
    // fixture, whose user is a dedicated test account, has none.
    let root = sshd.scratch_home.clone().unwrap_or(home);
    let base = format!(
        "{}/termihub-native-{}-{}",
        root.trim_end_matches('/'),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    browser.mkdir(&base).await.expect("mkdir the test dir");
    let file = format!("{base}/payload.bin");
    let renamed = format!("{base}/renamed.bin");
    let data: Vec<u8> = (0..1_048_576u32).map(|i| (i % 251) as u8).collect();

    browser
        .write_file(&file, &data)
        .await
        .expect("upload 1 MiB");
    let entry = browser.stat(&file).await.expect("stat the upload");
    assert_eq!(
        entry.size,
        data.len() as u64,
        "stat reports the upload size"
    );
    let back = browser.read_file(&file).await.expect("download it back");
    assert!(back == data, "the round trip is byte-exact");

    browser.rename(&file, &renamed).await.expect("rename");
    let names: Vec<String> = browser
        .list_dir(&base)
        .await
        .expect("list the test dir")
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(
        names,
        vec!["renamed.bin".to_string()],
        "listing after rename"
    );

    browser.delete(&renamed).await.expect("delete the file");
    browser.delete(&base).await.expect("delete the dir");
    assert!(
        browser.stat(&base).await.is_err(),
        "the test dir is gone after delete"
    );
    ssh.disconnect().await.expect("disconnect cleanly");
}

#[tokio::test]
async fn native_07_local_forward_relays_tcp_over_ssh() {
    let sshd = require_native_sshd!();

    // A one-shot TCP echo server on loopback, reached only through the tunnel.
    let echo = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind echo server");
    let echo_port = echo.local_addr().expect("echo addr").port();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = echo.accept().await {
            let mut buf = vec![0u8; 1024];
            while let Ok(n) = sock.read(&mut buf).await {
                if n == 0 || sock.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        }
    });

    let (session, _) = connect_and_authenticate(&sshd.key_config())
        .await
        .expect("key auth should succeed");
    let forward = LocalForwardConfig {
        local_host: "127.0.0.1".to_string(),
        local_port: 0,
        remote_host: "127.0.0.1".to_string(),
        remote_port: echo_port,
    };
    let forwarder =
        LocalForwarder::start(&forward, Arc::new(session)).expect("bind the local forwarder");
    let listen_port = forwarder.local_addr().port();

    let mut client = tokio::net::TcpStream::connect(("127.0.0.1", listen_port))
        .await
        .expect("connect to the forwarded port");
    client
        .write_all(b"through-the-tunnel")
        .await
        .expect("send through the tunnel");
    let mut buf = [0u8; 18];
    tokio::time::timeout(Duration::from_secs(10), client.read_exact(&mut buf))
        .await
        .expect("echo arrives before the timeout")
        .expect("read the echo");
    assert_eq!(
        &buf, b"through-the-tunnel",
        "the tunnel relays bytes both ways"
    );
}
