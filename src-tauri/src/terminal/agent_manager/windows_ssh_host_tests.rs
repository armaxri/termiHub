//! Live agent deploy → install → connect → reattach against a **real Windows
//! OpenSSH server** (#3684; MT-AGENT-18/19/20/24).
//!
//! The unit tests in `agent_install` prove the per-shell command strings; these
//! drive the real thing end to end, once per OpenSSH `DefaultShell`:
//!
//! 1. **Deploy + install (MT-AGENT-18 cmd.exe / MT-AGENT-19 PowerShell)** — SSH
//!    in, detect a Windows host, detect the `DefaultShell` flavour, then run the
//!    production [`install_agent_bytes`] (SFTP upload to the SFTP home, the
//!    shell-specific `md`/`move` or `New-Item`/`Move-Item` install, the
//!    `--version` verify, the `%LOCALAPPDATA%` path resolution).
//! 2. **Connect (MT-AGENT-20)** — launch the freshly installed agent over SSH
//!    exec `--stdio` with [`reconnect_agent`] (the desktop's full establishment:
//!    connect, exec, `initialize`) and prove a shell session round-trips I/O.
//! 3. **Persistent session survives reconnect (MT-AGENT-24)** — a daemon-backed
//!    session keeps a counter running while the desktop is disconnected (the
//!    `--stdio` agent exits, the named-pipe session daemon lives on); after the
//!    reconnect the SAME session id is listed, re-attached, and the counter is
//!    beyond its pre-drop value and still advancing.
//!
//! Binary *resolution* (cache → bundled → download, plus the release-signature
//! check) needs a Tauri `AppHandle` and a signed release asset, so the lane
//! uploads a locally built `termihub-agent.exe` instead; everything from the
//! upload on is the production deploy path.
//!
//! # Fixture and gate
//!
//! The host is the **native sshd fixture** (`scripts/internal/native-sshd-fixture.sh`
//! → `native-sshd-fixture.ps1` on Windows: Win32-OpenSSH on a loopback port,
//! the key-auth local user `termihubssh`). The recipe
//! `scripts/internal/run-windows-ssh-host-suite.sh <cmd|powershell>` sets
//! `HKLM\SOFTWARE\OpenSSH\DefaultShell`, brings the fixture up and runs the
//! matching test; the `Windows SSH Host` workflow
//! (`.github/workflows/windows-ssh-host.yml`) runs it once per shell. Inputs:
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `TERMIHUB_NATIVE_SSHD_PORT` / `_USER` / `_KEY` | the fixture's port, login user, client key |
//! | `TERMIHUB_NATIVE_SSHD_AGENT_BIN` (or `TERMIHUB_TEST_AGENT_BIN`) | the `termihub-agent.exe` to deploy |
//! | `TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL` | `cmd` or `powershell` — the configured `DefaultShell` |
//! | `TERMIHUB_REQUIRE_WINDOWS_SSH` | truthy → a missing fixture fails instead of skipping |
//!
//! Without them (every local and per-PR run, and the macOS/Linux native-sshd
//! lanes, which never set the Windows `DefaultShell` variable) each test prints
//! a visible `SKIPPED:` line naming the missing variable and passes. A test
//! whose shell differs from the configured `DefaultShell` skips with that reason
//! too — the recipe runs exactly one shell's test and fails on any `SKIPPED:`
//! line, so a skip there can never pass for a green.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

use super::live_channel_support::{channel_rpc, read_counter_until};
use super::{read_handshake_line, reconnect_agent, serialize_request};
use crate::connection::config::AgentSettings;
use crate::terminal::agent_binary::is_windows_os;
use crate::terminal::agent_deploy::{install_agent_bytes, AgentDeployResult};
use crate::terminal::agent_install::{
    detect_windows_shell, windows_install_plan, WindowsShell, WINDOWS_AGENT_EXE,
    WINDOWS_UPLOAD_NAME,
};
use crate::terminal::backend::{RemoteAgentConfig, SshConfig};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{detect_remote_info, run_remote_command};
use crate::utils::ssh_auth::connect_and_authenticate;

const PORT_ENV: &str = "TERMIHUB_NATIVE_SSHD_PORT";
const USER_ENV: &str = "TERMIHUB_NATIVE_SSHD_USER";
const KEY_ENV: &str = "TERMIHUB_NATIVE_SSHD_KEY";
const FIXTURE_AGENT_BIN_ENV: &str = "TERMIHUB_NATIVE_SSHD_AGENT_BIN";
const AGENT_BIN_ENV: &str = "TERMIHUB_TEST_AGENT_BIN";
const DEFAULT_SHELL_ENV: &str = "TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL";
const REQUIRE_ENV: &str = "TERMIHUB_REQUIRE_WINDOWS_SSH";

/// Ceiling for each live wait (agent establishment, a shell's first output).
/// Generous: a cold Windows PowerShell plus a fresh user profile is slow on a
/// hosted runner.
const LIVE_CEILING: Duration = Duration::from_secs(90);

/// Ceiling for one `reconnect_agent` establishment. Without it a broken host
/// would sit through the full 10-attempt backoff (minutes) before failing.
const ESTABLISH_CEILING: Duration = Duration::from_secs(120);

/// The fixture sshd listens on loopback only.
const FIXTURE_HOST: &str = "127.0.0.1";

/// The live Windows SSH host the tests deploy to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fixture {
    port: u16,
    user: String,
    key: String,
    default_shell: WindowsShell,
    agent_bin: PathBuf,
}

impl Fixture {
    fn ssh_config(&self) -> SshConfig {
        SshConfig {
            host: FIXTURE_HOST.to_string(),
            port: self.port,
            username: self.user.clone(),
            auth_method: "key".to_string(),
            key_path: Some(self.key.clone()),
            ..Default::default()
        }
    }

    fn agent_config(&self, agent_path: &str) -> RemoteAgentConfig {
        RemoteAgentConfig {
            host: FIXTURE_HOST.to_string(),
            port: self.port,
            username: self.user.clone(),
            auth_method: "key".to_string(),
            key_path: Some(self.key.clone()),
            agent_path: Some(agent_path.to_string()),
            ..Default::default()
        }
    }
}

/// Parse a `TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL` value.
fn parse_default_shell(value: &str) -> Option<WindowsShell> {
    match value.trim().to_ascii_lowercase().as_str() {
        "cmd" | "cmd.exe" => Some(WindowsShell::Cmd),
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => Some(WindowsShell::PowerShell),
        _ => None,
    }
}

/// Interpret a `TERMIHUB_REQUIRE_WINDOWS_SSH` value (truthy: `1`, `true`,
/// `yes`, `on`; case-insensitive), mirroring `TERMIHUB_REQUIRE_DOCKER`.
fn parse_required(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Build the fixture from `var` (an env lookup), or the reason it is
/// unavailable. `is_file` probes the agent binary path.
fn resolve_fixture(
    var: impl Fn(&str) -> Option<String>,
    is_file: impl Fn(&std::path::Path) -> bool,
) -> Result<Fixture, String> {
    let get = |name: &str| var(name).filter(|v| !v.trim().is_empty());
    let need = |name: &str| get(name).ok_or_else(|| format!("{name} is unset"));
    let port_raw = need(PORT_ENV)?;
    let port = port_raw
        .trim()
        .parse()
        .map_err(|_| format!("{PORT_ENV}={port_raw:?} is not a port number"))?;
    let user = need(USER_ENV)?;
    let key = need(KEY_ENV)?;
    let shell_raw = need(DEFAULT_SHELL_ENV)?;
    let default_shell = parse_default_shell(&shell_raw).ok_or_else(|| {
        format!("{DEFAULT_SHELL_ENV}={shell_raw:?} is neither `cmd` nor `powershell`")
    })?;
    let agent_bin = get(FIXTURE_AGENT_BIN_ENV)
        .or_else(|| get(AGENT_BIN_ENV))
        .map(PathBuf::from)
        .ok_or_else(|| format!("neither {FIXTURE_AGENT_BIN_ENV} nor {AGENT_BIN_ENV} is set"))?;
    if !is_file(&agent_bin) {
        return Err(format!(
            "agent binary {} is not a file (run `cargo build -p termihub-agent`)",
            agent_bin.display()
        ));
    }
    Ok(Fixture {
        port,
        user,
        key,
        default_shell,
        agent_bin,
    })
}

/// Apply the gate: `Some` to run, `None` after a visible `SKIPPED:` line, a
/// panic when the fixture is missing but required.
fn gate(resolved: Result<Fixture, String>, required: bool) -> Option<Fixture> {
    match resolved {
        Ok(fixture) => Some(fixture),
        Err(reason) if required => panic!(
            "REQUIRED Windows SSH-host fixture unavailable ({reason}) but {REQUIRE_ENV} is \
             set — a missing fixture is a hard failure here, not a skip"
        ),
        Err(reason) => {
            eprintln!(
                "SKIPPED: no Windows SSH-host fixture ({reason}); run it with \
                 scripts/internal/run-windows-ssh-host-suite.sh on Windows (the \
                 `Windows SSH Host` nightly lane does)"
            );
            None
        }
    }
}

/// The process's fixture, or `None` (after a `SKIPPED:` line) to skip.
fn live_fixture() -> Option<Fixture> {
    gate(
        resolve_fixture(|name| std::env::var(name).ok(), |p| p.is_file()),
        parse_required(std::env::var(REQUIRE_ENV).ok().as_deref()),
    )
}

/// Trust the fixture's sshd host key (process-wide, set-once): it is a
/// loopback fixture with a key generated per `up`, never in `known_hosts`.
fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

/// A command (in the host's `DefaultShell` syntax) printing whether the SFTP
/// upload temp file is still in the user's home.
fn upload_leftover_probe(shell: WindowsShell) -> String {
    match shell {
        WindowsShell::Cmd => format!(
            r#"if exist "%USERPROFILE%\{WINDOWS_UPLOAD_NAME}" (echo PRESENT) else (echo ABSENT)"#
        ),
        WindowsShell::PowerShell => format!(
            r#"if (Test-Path "$env:USERPROFILE\{WINDOWS_UPLOAD_NAME}") {{ 'PRESENT' }} else {{ 'ABSENT' }}"#
        ),
    }
}

/// What the blocking deploy half observed.
#[derive(Debug)]
struct DeployOutcome {
    remote_os: String,
    detected_shell: WindowsShell,
    result: AgentDeployResult,
    progress_steps: Vec<String>,
    upload_leftover: String,
    /// Probe results gathered when the verify step printed no version (empty
    /// otherwise), so a failure names its cause instead of just "no version".
    diagnostics: String,
}

/// Run `command` through the host's `DefaultShell` and report its stdout,
/// stderr and exit status — unlike [`run_remote_command`], which keeps only
/// UTF-8 stdout. Diagnostics only.
fn exec_detailed(
    session: &termihub_core::backends::ssh::handler::SshSession,
    command: &str,
) -> String {
    use russh::ChannelMsg;
    let run = async {
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("channel open failed: {e}"))?;
        channel
            .exec(false, command)
            .await
            .map_err(|e| format!("exec failed: {e}"))?;
        let (mut out, mut err, mut status) = (Vec::new(), Vec::new(), None);
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => err.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Eof => break,
                _ => {}
            }
        }
        Ok::<_, String>(format!(
            "exit={status:?} stdout={:?} stdout_bytes={:02x?} stderr={:?}",
            String::from_utf8_lossy(&out),
            &out[..out.len().min(48)],
            String::from_utf8_lossy(&err),
        ))
    };
    let probe = tokio::time::timeout(Duration::from_secs(30), run);
    match tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(probe)) {
        Ok(Ok(report)) => report,
        Ok(Err(e)) => e,
        Err(_) => "timed out after 30s".to_string(),
    }
}

/// Probe why the verify step printed no version: is the exe in place, what
/// does the verify command really print (stdout, stderr, exit status), and how
/// did sshd launch the shell.
fn verify_diagnostics(
    session: &termihub_core::backends::ssh::handler::SshSession,
    shell: WindowsShell,
) -> String {
    let plan = windows_install_plan(shell);
    let mut probes: Vec<(&str, String)> = vec![("verify command", plan.verify_command.clone())];
    match shell {
        WindowsShell::Cmd => probes.extend([
            (
                "installed exe present",
                format!(r#"if exist "{}" (echo PRESENT) else (echo ABSENT)"#, plan.install_path),
            ),
            ("shell command line", "echo %CMDCMDLINE%".to_string()),
        ]),
        WindowsShell::PowerShell => probes.extend([
            (
                "installed exe present",
                format!(r#"Test-Path "{}""#, plan.install_path),
            ),
            (
                "shell command line",
                "[Environment]::CommandLine; $PSVersionTable.PSVersion.ToString()".to_string(),
            ),
            (
                "verify, merged streams",
                format!(
                    r#"& "{}" --version 2>&1 | Out-String; "exit=$LASTEXITCODE""#,
                    plan.install_path
                ),
            ),
            (
                "verify via Start-Process",
                format!(
                    r#"$p = Start-Process -FilePath "{}" -ArgumentList '--version' -NoNewWindow -Wait -PassThru; "exit=$($p.ExitCode)""#,
                    plan.install_path
                ),
            ),
        ]),
    }
    probes
        .into_iter()
        .map(|(label, command)| {
            format!(
                "\n  [{label}] {command}\n    => {}",
                exec_detailed(session, &command)
            )
        })
        .collect()
}

/// SSH in, detect the host + shell, and run the production install
/// (MT-AGENT-18/19). Blocking: the remote-exec helpers use `block_in_place`,
/// so this runs on a `spawn_blocking` thread like the real deploy.
fn deploy(fixture: &Fixture) -> Result<DeployOutcome, TerminalError> {
    let session = connect_and_authenticate(&fixture.ssh_config())?;
    let (remote_os, _arch) = detect_remote_info(&session)?;
    let detected_shell = detect_windows_shell(&session);
    let bytes = std::fs::read(&fixture.agent_bin)
        .map_err(|e| TerminalError::RemoteError(format!("read agent binary: {e}")))?;
    let steps = Mutex::new(Vec::new());
    let progress = |step: &str, _message: &str, _pct: f64| {
        steps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(step.to_string());
    };
    let result = install_agent_bytes(
        &session,
        &remote_os,
        crate::terminal::agent_install::POSIX_DEFAULT_INSTALL_PATH,
        &bytes,
        &progress,
        None,
    )?;
    let upload_leftover = run_remote_command(&session, &upload_leftover_probe(detected_shell))?;
    let diagnostics = match &result {
        AgentDeployResult::Deployed {
            installed_version: None,
            ..
        } => verify_diagnostics(&session, detected_shell),
        _ => String::new(),
    };
    Ok(DeployOutcome {
        remote_os,
        detected_shell,
        result,
        progress_steps: steps
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        upload_leftover,
        diagnostics,
    })
}

/// Assert the deploy matched MT-AGENT-18/19's expected results and return the
/// absolute install path.
fn assert_deployed(outcome: &DeployOutcome, want: WindowsShell) -> String {
    assert!(
        is_windows_os(&outcome.remote_os),
        "host not detected as Windows: remote_os={:?}",
        outcome.remote_os
    );
    assert_eq!(
        outcome.detected_shell, want,
        "detected OpenSSH DefaultShell does not match the configured one"
    );
    for step in ["uploading", "installing", "verifying", "done"] {
        assert!(
            outcome.progress_steps.iter().any(|s| s == step),
            "deploy never reported step {step:?}: {:?}",
            outcome.progress_steps
        );
    }
    let AgentDeployResult::Deployed {
        success,
        installed_version,
        installed_path,
    } = &outcome.result
    else {
        panic!("unexpected deploy result: {:?}", outcome.result);
    };
    let version = installed_version.as_deref().unwrap_or_else(|| {
        panic!(
            "verify step printed no version: {:?}\ndiagnostics:{}",
            outcome.result, outcome.diagnostics
        )
    });
    assert!(*success, "deploy reported failure: {:?}", outcome.result);
    assert!(
        version.starts_with(env!("CARGO_PKG_VERSION")),
        "installed agent reports version {version:?}, expected {}",
        env!("CARGO_PKG_VERSION")
    );
    let path = installed_path
        .clone()
        .unwrap_or_else(|| panic!("no installed path: {:?}", outcome.result));
    let bytes = path.as_bytes();
    assert!(
        bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && &path[1..3] == ":\\",
        "install path is not an absolute drive path: {path:?}"
    );
    assert!(
        !path.contains('%') && !path.contains("$env:"),
        "install path still carries an unexpanded variable: {path:?}"
    );
    let suffix = format!(r"\appdata\local\termihub\agent\{WINDOWS_AGENT_EXE}");
    assert!(
        path.to_ascii_lowercase().ends_with(&suffix),
        "agent not installed under %LOCALAPPDATA%\\termiHub\\agent: {path:?}"
    );
    assert_eq!(
        outcome.upload_leftover.trim(),
        "ABSENT",
        "the SFTP upload was not moved into place (temp file left in %USERPROFILE%)"
    );
    path
}

/// Strip ANSI CSI / OSC escape sequences so text matching is not broken by the
/// colouring and cursor control a ConPTY interleaves with shell output.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters/intermediates until a final byte in 0x40..=0x7e.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: until BEL or ST (ESC \).
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{07}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Read `connection.output` until the accumulated, escape-stripped text
/// contains `needle`, or the deadline passes. Accumulating (unlike the
/// per-chunk Unix helper) tolerates a ConPTY splitting a line across chunks.
async fn wait_for_text(
    channel: &mut russh::Channel<russh::client::Msg>,
    needle: &str,
    deadline: Instant,
) -> Result<(), String> {
    let mut buf = String::new();
    let mut raw = Vec::new();
    while Instant::now() < deadline {
        let read = tokio::time::timeout(
            Duration::from_millis(500),
            read_handshake_line(channel, "windows-agent", &mut buf),
        )
        .await;
        match read {
            Ok(Some(line)) if !line.is_empty() => {
                if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                    jsonrpc::parse_message(&line)
                {
                    if method == "connection.output" {
                        if let Some(bytes) =
                            params["data"].as_str().and_then(|d| B64.decode(d).ok())
                        {
                            raw.extend_from_slice(&bytes);
                            if strip_ansi(&String::from_utf8_lossy(&raw)).contains(needle) {
                                return Ok(());
                            }
                        }
                    }
                }
            }
            Ok(Some(_)) | Err(_) => continue,
            Ok(None) => return Err("agent channel closed".to_string()),
        }
    }
    Err(format!(
        "no {needle:?} in the session output; saw: {:?}",
        strip_ansi(&String::from_utf8_lossy(&raw))
    ))
}

/// Send keyboard input to a session (`connection.write` is fire-and-forget).
async fn write_input(
    channel: &mut russh::Channel<russh::client::Msg>,
    request_id: &mut u64,
    session_id: &str,
    text: &str,
) {
    *request_id += 1;
    let line = serialize_request(
        *request_id,
        "connection.write",
        serde_json::json!({ "session_id": session_id, "data": B64.encode(text.as_bytes()) }),
    )
    .expect("serialize connection.write");
    channel
        .data(line.as_bytes())
        .await
        .expect("write session input");
}

/// Establish the agent over SSH exec `--stdio` (connect, exec, `initialize`).
async fn establish(
    config: &RemoteAgentConfig,
    request_id: &mut u64,
) -> (
    termihub_core::backends::ssh::handler::SshSession,
    russh::Channel<russh::client::Msg>,
) {
    let alive = Arc::new(AtomicBool::new(true));
    let settings = AgentSettings::default();
    let established = tokio::time::timeout(
        ESTABLISH_CEILING,
        reconnect_agent(config, &settings, request_id, &alive),
    )
    .await
    .unwrap_or_else(|_| panic!("agent establishment did not finish in {ESTABLISH_CEILING:?}"))
    .unwrap_or_else(|e| panic!("agent establishment over SSH exec --stdio failed: {e}"));
    (established.0, established.1)
}

/// Create + attach a persistent PowerShell session; returns its id.
async fn create_powershell_session(
    channel: &mut russh::Channel<russh::client::Msg>,
    request_id: &mut u64,
    title: &str,
) -> String {
    let created = channel_rpc(
        channel,
        request_id,
        "connection.create",
        serde_json::json!({ "type": "local", "title": title, "config": { "shell": "powershell" } }),
    )
    .await
    .unwrap_or_else(|e| panic!("connection.create ({title}) failed: {e}"));
    let sid = created["session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
        .to_string();
    channel_rpc(
        channel,
        request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .unwrap_or_else(|e| panic!("connection.attach ({title}) failed: {e}"));
    sid
}

/// The whole MT-AGENT-18/19 → 20 → 24 walkthrough for one `DefaultShell`.
async fn deploy_install_connect_reattach(want: WindowsShell) {
    let Some(fixture) = live_fixture() else {
        return;
    };
    if fixture.default_shell != want {
        eprintln!(
            "SKIPPED: the fixture's OpenSSH DefaultShell is {:?}, this test needs {want:?} \
             (the lane runs each shell's test in its own step)",
            fixture.default_shell
        );
        return;
    }
    trust_all_host_keys();

    // ── MT-AGENT-18/19: deploy + install through the configured DefaultShell.
    let deploy_fixture = fixture.clone();
    let outcome = tokio::task::spawn_blocking(move || deploy(&deploy_fixture))
        .await
        .expect("deploy thread panicked")
        .unwrap_or_else(|e| panic!("deploy to the Windows host failed: {e}"));
    let agent_path = assert_deployed(&outcome, want);
    eprintln!("deployed agent to {agent_path} via {want:?}");

    // ── MT-AGENT-20: connect to the freshly installed agent over SSH exec
    // `--stdio` (through the same DefaultShell) and round-trip shell I/O.
    let config = fixture.agent_config(&agent_path);
    let mut request_id = 0u64;
    let (session, mut channel) = establish(&config, &mut request_id).await;
    let sid = create_powershell_session(&mut channel, &mut request_id, "mt-agent-20").await;
    // The keystroke echo shows the quoted halves; only executed output joins them.
    write_input(
        &mut channel,
        &mut request_id,
        &sid,
        "'CONNECT-' + 'OK-MT20'\r",
    )
    .await;
    wait_for_text(
        &mut channel,
        "CONNECT-OK-MT20",
        Instant::now() + LIVE_CEILING,
    )
    .await
    .unwrap_or_else(|e| panic!("session through the Windows agent is not usable: {e}"));

    // ── MT-AGENT-24: start a counter, disconnect, reconnect, re-attach.
    // `"TICK=$i"` echoes without a digit after `TICK=`, so only executed output
    // carries a counter value.
    write_input(
        &mut channel,
        &mut request_id,
        &sid,
        "$i=0; while ($true) { \"TICK=$i\"; $i++; Start-Sleep -Milliseconds 200 }\r",
    )
    .await;
    let before = read_counter_until(&mut channel, |m| m >= 3, Instant::now() + LIVE_CEILING)
        .await
        .expect("counter never produced TICK values before the disconnect");
    assert!(before >= 3, "counter not clearly running before disconnect");

    // Desktop-side disconnect: the SSH transport goes away, the `--stdio` agent
    // sees EOF and exits; the named-pipe session daemon must keep running.
    drop(channel);
    drop(session);
    tokio::time::sleep(Duration::from_millis(2000)).await;

    let (session2, mut channel2) = establish(&config, &mut request_id).await;
    let list = channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.list",
        serde_json::json!({}),
    )
    .await
    .expect("connection.list after reconnect failed");
    let sessions = list["sessions"].as_array().cloned().unwrap_or_default();
    assert!(
        sessions
            .iter()
            .any(|s| s["session_id"].as_str() == Some(sid.as_str())),
        "session {sid} did not survive the disconnect (named-pipe daemon gone) — list: {list}"
    );
    assert_eq!(
        sessions.len(),
        1,
        "expected exactly the one surviving session, no second shell — list: {list}"
    );
    channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .unwrap_or_else(|e| panic!("re-attach to the surviving session {sid} failed: {e}"));

    // The replay/live output must carry a value beyond the pre-drop one: the
    // loop kept running while nobody was attached (no restart, no pause).
    let after = read_counter_until(&mut channel2, |m| m > before, Instant::now() + LIVE_CEILING)
        .await
        .expect("no counter output after re-attach");
    assert!(
        after > before,
        "counter did not advance across the disconnect: before={before}, after={after}"
    );
    let base = read_counter_until(
        &mut channel2,
        |_| false,
        Instant::now() + Duration::from_millis(800),
    )
    .await
    .unwrap_or(after);
    let live = read_counter_until(&mut channel2, |m| m > base, Instant::now() + LIVE_CEILING)
        .await
        .expect("counter stopped after re-attach");
    assert!(
        live > base,
        "re-attached session is not live: {base} → {live}"
    );

    let _ = channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.close",
        serde_json::json!({ "session_id": sid }),
    )
    .await;
    drop(channel2);
    drop(session2);
}

/// MT-AGENT-18 + 20 + 24 with the OpenSSH `DefaultShell` left at `cmd.exe`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cmd_default_shell_deploy_install_connect_reattach() {
    deploy_install_connect_reattach(WindowsShell::Cmd).await;
}

/// MT-AGENT-19 + 20 + 24 with the OpenSSH `DefaultShell` set to PowerShell.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn powershell_default_shell_deploy_install_connect_reattach() {
    deploy_install_connect_reattach(WindowsShell::PowerShell).await;
}

// ── Gate unit tests (run everywhere) ───────────────────────────────────

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: std::collections::HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |name: &str| map.get(name).cloned()
}

const FULL_ENV: &[(&str, &str)] = &[
    (PORT_ENV, "22400"),
    (USER_ENV, "termihubssh"),
    (
        KEY_ENV,
        r"C:\ProgramData\termihub-native-sshd\client_ed25519_key",
    ),
    (DEFAULT_SHELL_ENV, "PowerShell"),
    (
        FIXTURE_AGENT_BIN_ENV,
        r"C:\ProgramData\termihub-native-sshd\agent\termihub-agent.exe",
    ),
];

/// `FULL_ENV` with `name` replaced by `value` (or dropped when `None`).
fn env_with(name: &str, value: Option<&'static str>) -> Vec<(&'static str, &'static str)> {
    let mut env: Vec<_> = FULL_ENV
        .iter()
        .copied()
        .filter(|(k, _)| *k != name)
        .collect();
    if let Some(value) = value {
        let key = FULL_ENV
            .iter()
            .map(|(k, _)| *k)
            .chain([AGENT_BIN_ENV])
            .find(|k| *k == name)
            .expect("known variable");
        env.push((key, value));
    }
    env
}

#[test]
fn resolve_fixture_reads_the_native_sshd_environment() {
    let fixture = resolve_fixture(env_of(FULL_ENV), |_| true).expect("fixture");
    assert_eq!(fixture.port, 22400);
    assert_eq!(fixture.user, "termihubssh");
    assert!(fixture.key.ends_with("client_ed25519_key"));
    assert_eq!(fixture.default_shell, WindowsShell::PowerShell);
    assert!(fixture
        .agent_bin
        .to_string_lossy()
        .ends_with(r"agent\termihub-agent.exe"));
    let config = fixture.ssh_config();
    assert_eq!((config.host.as_str(), config.port), (FIXTURE_HOST, 22400));
    assert_eq!(config.auth_method, "key");

    let cmd = resolve_fixture(env_of(&env_with(DEFAULT_SHELL_ENV, Some("cmd"))), |_| true);
    assert_eq!(cmd.expect("fixture").default_shell, WindowsShell::Cmd);
}

#[test]
fn resolve_fixture_falls_back_to_the_test_agent_binary() {
    let mut env = env_with(FIXTURE_AGENT_BIN_ENV, None);
    env.push((AGENT_BIN_ENV, "target/debug/termihub-agent.exe"));
    let fixture = resolve_fixture(env_of(&env), |_| true).expect("fixture");
    assert_eq!(
        fixture.agent_bin,
        PathBuf::from("target/debug/termihub-agent.exe")
    );
}

#[test]
fn resolve_fixture_names_the_missing_piece() {
    let err = resolve_fixture(env_of(&[]), |_| true).unwrap_err();
    assert!(err.contains(PORT_ENV), "{err}");
    // The macOS/Linux native-sshd lanes export the fixture but never the
    // Windows DefaultShell, so the tests skip there by name.
    let err = resolve_fixture(env_of(&env_with(DEFAULT_SHELL_ENV, None)), |_| true).unwrap_err();
    assert!(err.contains(DEFAULT_SHELL_ENV), "{err}");
    let err =
        resolve_fixture(env_of(&env_with(DEFAULT_SHELL_ENV, Some("bash"))), |_| true).unwrap_err();
    assert!(err.contains("neither"), "{err}");
    let err = resolve_fixture(env_of(&env_with(PORT_ENV, Some("ssh"))), |_| true).unwrap_err();
    assert!(err.contains("not a port number"), "{err}");
    let err =
        resolve_fixture(env_of(&env_with(FIXTURE_AGENT_BIN_ENV, None)), |_| true).unwrap_err();
    assert!(err.contains(AGENT_BIN_ENV), "{err}");
    let err = resolve_fixture(env_of(FULL_ENV), |_| false).unwrap_err();
    assert!(err.contains("not a file"), "{err}");
}

#[test]
fn gate_skips_when_absent_and_panics_only_when_required() {
    assert!(gate(Err("x unset".into()), false).is_none());
    let fixture = resolve_fixture(env_of(FULL_ENV), |_| true).unwrap();
    assert_eq!(gate(Ok(fixture.clone()), true), Some(fixture));
    let required = std::panic::catch_unwind(|| gate(Err("x unset".into()), true));
    assert!(required.is_err(), "a required, missing fixture must panic");
}

#[test]
fn parse_required_and_default_shell_values() {
    for v in ["1", "true", "YES", " on "] {
        assert!(parse_required(Some(v)), "{v:?}");
    }
    assert!(!parse_required(None));
    assert!(!parse_required(Some("0")));
    assert_eq!(parse_default_shell("cmd.exe"), Some(WindowsShell::Cmd));
    assert_eq!(parse_default_shell("pwsh"), Some(WindowsShell::PowerShell));
    assert_eq!(parse_default_shell(""), None);
}

#[test]
fn strip_ansi_removes_csi_and_osc_sequences() {
    let raw = "\u{1b}[32mCONNECT-\u{1b}[0mOK\u{1b}]0;title\u{07}-MT20\u{1b}]7;file://h/\u{1b}\\!";
    assert_eq!(strip_ansi(raw), "CONNECT-OK-MT20!");
}

#[test]
fn upload_leftover_probe_uses_each_shells_syntax() {
    let cmd = upload_leftover_probe(WindowsShell::Cmd);
    assert!(cmd.starts_with("if exist \"%USERPROFILE%\\termihub-agent-upload.exe\""));
    let ps = upload_leftover_probe(WindowsShell::PowerShell);
    assert!(ps.starts_with("if (Test-Path \"$env:USERPROFILE\\termihub-agent-upload.exe\")"));
}
