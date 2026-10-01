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
//! The `Windows SSH Host` workflow (`.github/workflows/windows-ssh-host.yml`)
//! enables the runner's OpenSSH server, creates one throwaway local user per
//! `DefaultShell`, switches `HKLM\SOFTWARE\OpenSSH\DefaultShell` between the
//! steps and exports:
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `TERMIHUB_WINDOWS_SSH_HOST` / `_PORT` | sshd address (default `127.0.0.1:22`) |
//! | `TERMIHUB_WINDOWS_SSH_USER` / `_PASSWORD` | password-auth account |
//! | `TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL` | `cmd` or `powershell` — the configured `DefaultShell` |
//! | `TERMIHUB_TEST_AGENT_BIN` | the `termihub-agent.exe` to deploy |
//! | `TERMIHUB_REQUIRE_WINDOWS_SSH` | truthy → a missing fixture fails instead of skipping |
//!
//! Without the fixture (every local and per-PR run) each test prints a visible
//! `SKIPPED:` line naming the missing variable and passes. A test whose shell
//! differs from the configured `DefaultShell` skips with that reason too — the
//! lane runs each shell's test in its own step and fails on any `SKIPPED:` line,
//! so a skip there can never pass for a green.

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
    detect_windows_shell, WindowsShell, WINDOWS_AGENT_EXE, WINDOWS_UPLOAD_NAME,
};
use crate::terminal::backend::{RemoteAgentConfig, SshConfig};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{detect_remote_info, run_remote_command};
use crate::utils::ssh_auth::connect_and_authenticate;

const HOST_ENV: &str = "TERMIHUB_WINDOWS_SSH_HOST";
const PORT_ENV: &str = "TERMIHUB_WINDOWS_SSH_PORT";
const USER_ENV: &str = "TERMIHUB_WINDOWS_SSH_USER";
const PASSWORD_ENV: &str = "TERMIHUB_WINDOWS_SSH_PASSWORD";
const DEFAULT_SHELL_ENV: &str = "TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL";
const AGENT_BIN_ENV: &str = "TERMIHUB_TEST_AGENT_BIN";
const REQUIRE_ENV: &str = "TERMIHUB_REQUIRE_WINDOWS_SSH";

/// Ceiling for each live wait (agent establishment, a shell's first output).
/// Generous: a cold Windows PowerShell plus a fresh user profile is slow on a
/// hosted runner.
const LIVE_CEILING: Duration = Duration::from_secs(90);

/// Ceiling for one `reconnect_agent` establishment. Without it a broken host
/// would sit through the full 10-attempt backoff (minutes) before failing.
const ESTABLISH_CEILING: Duration = Duration::from_secs(120);

/// The live Windows SSH host the tests deploy to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fixture {
    host: String,
    port: u16,
    user: String,
    password: String,
    default_shell: WindowsShell,
    agent_bin: PathBuf,
}

impl Fixture {
    fn ssh_config(&self) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.user.clone(),
            auth_method: "password".to_string(),
            password: Some(self.password.clone()),
            ..Default::default()
        }
    }

    fn agent_config(&self, agent_path: &str) -> RemoteAgentConfig {
        RemoteAgentConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.user.clone(),
            auth_method: "password".to_string(),
            password: Some(self.password.clone()),
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
    let user = get(USER_ENV).ok_or_else(|| format!("{USER_ENV} is unset"))?;
    let password = get(PASSWORD_ENV).ok_or_else(|| format!("{PASSWORD_ENV} is unset"))?;
    let shell_raw =
        get(DEFAULT_SHELL_ENV).ok_or_else(|| format!("{DEFAULT_SHELL_ENV} is unset"))?;
    let default_shell = parse_default_shell(&shell_raw).ok_or_else(|| {
        format!("{DEFAULT_SHELL_ENV}={shell_raw:?} is neither `cmd` nor `powershell`")
    })?;
    let port = match get(PORT_ENV) {
        None => 22,
        Some(p) => p
            .trim()
            .parse()
            .map_err(|_| format!("{PORT_ENV}={p:?} is not a port number"))?,
    };
    let agent_bin = get(AGENT_BIN_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{AGENT_BIN_ENV} is unset"))?;
    if !is_file(&agent_bin) {
        return Err(format!(
            "{AGENT_BIN_ENV}={} is not a file (run `cargo build -p termihub-agent`)",
            agent_bin.display()
        ));
    }
    Ok(Fixture {
        host: get(HOST_ENV).unwrap_or_else(|| "127.0.0.1".to_string()),
        port,
        user,
        password,
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
                "SKIPPED: no Windows SSH-host fixture ({reason}); this test runs in the \
                 `Windows SSH Host` nightly lane (.github/workflows/windows-ssh-host.yml)"
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

/// Trust the runner's own sshd host key (process-wide, set-once): it is a
/// loopback fixture regenerated per runner, never in `known_hosts`.
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
    Ok(DeployOutcome {
        remote_os,
        detected_shell,
        result,
        progress_steps: steps
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        upload_leftover,
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
    let version = installed_version
        .as_deref()
        .unwrap_or_else(|| panic!("verify step printed no version: {:?}", outcome.result));
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
    (USER_ENV, "thssh"),
    (PASSWORD_ENV, "secret"),
    (DEFAULT_SHELL_ENV, "PowerShell"),
    (AGENT_BIN_ENV, "C:/agent/termihub-agent.exe"),
];

#[test]
fn resolve_fixture_reads_the_full_environment_with_defaults() {
    let fixture = resolve_fixture(env_of(FULL_ENV), |_| true).expect("fixture");
    assert_eq!(fixture.host, "127.0.0.1");
    assert_eq!(fixture.port, 22);
    assert_eq!(fixture.user, "thssh");
    assert_eq!(fixture.default_shell, WindowsShell::PowerShell);
    let mut env = FULL_ENV.to_vec();
    env.extend([(HOST_ENV, "winhost"), (PORT_ENV, "2222")]);
    env.retain(|(k, _)| *k != DEFAULT_SHELL_ENV);
    env.push((DEFAULT_SHELL_ENV, "cmd"));
    let fixture = resolve_fixture(env_of(&env), |_| true).expect("fixture");
    assert_eq!((fixture.host.as_str(), fixture.port), ("winhost", 2222));
    assert_eq!(fixture.default_shell, WindowsShell::Cmd);
}

#[test]
fn resolve_fixture_names_the_missing_piece() {
    let err = resolve_fixture(env_of(&[]), |_| true).unwrap_err();
    assert!(err.contains(USER_ENV), "{err}");
    let mut env = FULL_ENV.to_vec();
    env.retain(|(k, _)| *k != DEFAULT_SHELL_ENV);
    env.push((DEFAULT_SHELL_ENV, "bash"));
    let err = resolve_fixture(env_of(&env), |_| true).unwrap_err();
    assert!(err.contains("neither"), "{err}");
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
