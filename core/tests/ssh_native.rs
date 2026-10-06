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
//! eval "$(scripts/internal/native-sshd-fixture.sh up)"
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
/// sshd whose `ForceCommand` wraps `pwsh -l` — run only `native_05b..05d`).
fn fixture_shell() -> RemoteShell {
    if cfg!(windows) {
        return RemoteShell::Cmd;
    }
    match std::env::var("TERMIHUB_NATIVE_SSHD_LOGIN_SHELL").as_deref() {
        Ok("pwsh") => RemoteShell::UnixPowerShell,
        _ => RemoteShell::Posix,
    }
}

/// [`SHELL_LINE`] / [`SHELL_EXPECT`] in the fixture login shell's syntax.
fn first_command(shell: RemoteShell) -> (&'static str, &'static str) {
    match shell {
        RemoteShell::UnixPowerShell => (
            "Write-Output ('native-' + (40+2) + '-ok')\r",
            "native-42-ok",
        ),
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
/// Plays the terminal's part for cursor-position queries (`ESC [6n`), as the
/// app's xterm does: PSReadLine on Unix sends them and waits for the reply,
/// so a pwsh login shell stalls without one. bash / zsh / cmd.exe never ask.
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
    if shell != RemoteShell::Posix {
        assert!(
            !seen.contains("PROMPT_COMMAND"),
            "{shell:?} must not be sent the POSIX setup; output: {seen:?}"
        );
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
        RemoteShell::UnixPowerShell => "Write-Output ('[' + $env:TH_4147_VAR + ']')\r",
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
    if shell != RemoteShell::Posix {
        assert!(
            !seen.contains("export "),
            "{shell:?} got the POSIX export: {seen:?}"
        );
    }

    ssh.disconnect().await.expect("disconnect cleanly");
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
    let base = format!(
        "{}/termihub-native-{}-{}",
        home.trim_end_matches('/'),
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
