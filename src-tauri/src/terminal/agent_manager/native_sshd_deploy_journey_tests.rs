//! Live agent **deploy → probe → update → reattach** journey against the
//! platform's own OpenSSH server (#5208), on Linux, macOS and Windows.
//!
//! `agent_deploy_host_tests` (#5162) covers the deploy/update/rollback logic on
//! every PR against an in-process SSH + SFTP host. This is its live half: a
//! real sshd (the native sshd fixture) and two real agent builds.
//!
//! 1. **Deploy** — the production [`install_agent_bytes`] installs build A
//!    (SFTP upload, `mkdir`/`mv`/`chmod` or the Windows `DefaultShell` plan,
//!    the `--version` verify). The result must report A's exact version line.
//! 2. **Probe** — [`probe_remote_agent`] finds the installed agent and reports
//!    its version as compatible.
//! 3. **Session** — the desktop's full establishment ([`establish`]: SSH exec
//!    `--stdio` + `initialize`) on A, a persistent session running a counter,
//!    then a desktop disconnect: the `--stdio` agent exits, the session daemon
//!    keeps the counter going.
//! 4. **Update** — install build B over A while that daemon runs. The result
//!    must report B's version line, leave no backup behind, and the probe must
//!    now see B.
//! 5. **Reattach** — reconnect (now B's `--stdio`), find the SAME session id,
//!    re-attach, and see the counter past its pre-update value and advancing.
//!
//! A and B are the same source built with different `TERMIHUB_BUILD_BRANCH`
//! values, so their `--version` lines differ (`… (branch: <label>)`) while the
//! protocol stays the same, as with a real patch update.
//!
//! # Fixture and gate
//!
//! The recipe `scripts/internal/run-native-sshd-deploy-journey.sh` builds both
//! agents, brings the fixture up (`native-sshd-fixture.sh up --scratch-home`)
//! and runs this test with `TERMIHUB_REQUIRE_NATIVE_SSHD_DEPLOY=1`; the
//! `native-sshd` job of `integration-fixtures.yml` runs it on all three OSes.
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `TERMIHUB_NATIVE_SSHD_PORT` / `_USER` / `_KEY` | the fixture's port, login user, client key |
//! | `TERMIHUB_NATIVE_SSHD_HOME` | macOS/Linux: the scratch HOME sshd gives every session (`--scratch-home`); the agent is installed below it, never in the real home |
//! | `TERMIHUB_TEST_AGENT_BIN` | build A, installed first |
//! | `TERMIHUB_TEST_AGENT_UPDATE_BIN` | build B, the update |
//! | `TERMIHUB_REQUIRE_NATIVE_SSHD_DEPLOY` | truthy → a missing fixture fails instead of skipping |
//!
//! Without them (every local and per-PR `cargo test`) the test prints a
//! visible `SKIPPED:` line naming what is missing and passes; the recipe fails
//! on any `SKIPPED:` line.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::live_channel_support::{channel_rpc, read_counter_until};
use super::windows_ssh_host_tests::{
    create_powershell_session, establish, rollback, trust_all_host_keys, write_input,
};
use crate::terminal::agent_binary::is_windows_os;
use crate::terminal::agent_deploy::{install_agent_bytes, probe_remote_agent, AgentDeployResult};
use crate::terminal::agent_install::{
    detect_windows_shell, windows_install_plan, POSIX_BACKUP_SUFFIX,
};
use crate::terminal::backend::{RemoteAgentConfig, SshConfig};
use crate::utils::remote_exec::{detect_remote_info, run_remote_command};
use crate::utils::ssh_auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::SshSession;

const PORT_ENV: &str = "TERMIHUB_NATIVE_SSHD_PORT";
const USER_ENV: &str = "TERMIHUB_NATIVE_SSHD_USER";
const KEY_ENV: &str = "TERMIHUB_NATIVE_SSHD_KEY";
const HOME_ENV: &str = "TERMIHUB_NATIVE_SSHD_HOME";
const AGENT_BIN_ENV: &str = "TERMIHUB_TEST_AGENT_BIN";
const UPDATE_BIN_ENV: &str = "TERMIHUB_TEST_AGENT_UPDATE_BIN";
const REQUIRE_ENV: &str = "TERMIHUB_REQUIRE_NATIVE_SSHD_DEPLOY";

/// Ceiling for each live wait (a shell's first counter values, the replay).
const LIVE_CEILING: Duration = Duration::from_secs(90);

/// The fixture sshd listens on loopback only.
const FIXTURE_HOST: &str = "127.0.0.1";

/// The live host and the two agent builds.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Journey {
    port: u16,
    user: String,
    key: String,
    /// The sessions' scratch HOME (macOS/Linux; `None` on a Windows host,
    /// whose fixture user is a dedicated test account).
    home: Option<String>,
    agent_bin: PathBuf,
    update_bin: PathBuf,
}

impl Journey {
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

    /// The POSIX install path: below the scratch HOME, absolute (a relative
    /// path would land in the session's working directory, the real home).
    fn posix_install_path(&self) -> String {
        let home = self
            .home
            .as_deref()
            .unwrap_or_else(|| panic!("{HOME_ENV} is required for a POSIX host"));
        format!("{home}/.local/bin/termihub-agent")
    }
}

/// Build the journey from `var` (an env lookup), or the reason it is
/// unavailable. `is_file` probes the agent binary paths. `home` is required
/// unless the test process runs on Windows (the fixture's host OS).
fn resolve_journey(
    var: impl Fn(&str) -> Option<String>,
    is_file: impl Fn(&Path) -> bool,
    windows_host: bool,
) -> Result<Journey, String> {
    let get = |name: &str| var(name).filter(|v| !v.trim().is_empty());
    let need = |name: &str| get(name).ok_or_else(|| format!("{name} is unset"));
    let port_raw = need(PORT_ENV)?;
    let port = port_raw
        .trim()
        .parse()
        .map_err(|_| format!("{PORT_ENV}={port_raw:?} is not a port number"))?;
    let user = need(USER_ENV)?;
    let key = need(KEY_ENV)?;
    let home = if windows_host {
        None
    } else {
        Some(need(HOME_ENV).map_err(|e| {
            format!("{e} (bring the fixture up with --scratch-home, so nothing lands in the real home)")
        })?)
    };
    let mut bins = Vec::new();
    for name in [AGENT_BIN_ENV, UPDATE_BIN_ENV] {
        let bin = PathBuf::from(need(name)?);
        if !is_file(&bin) {
            return Err(format!("{name}={} is not a file", bin.display()));
        }
        bins.push(bin);
    }
    let update_bin = bins.pop().expect("two binaries");
    let agent_bin = bins.pop().expect("two binaries");
    if agent_bin == update_bin {
        return Err(format!(
            "{AGENT_BIN_ENV} and {UPDATE_BIN_ENV} name the same file; the update needs a second build"
        ));
    }
    Ok(Journey {
        port,
        user,
        key,
        home,
        agent_bin,
        update_bin,
    })
}

/// Apply the gate: `Some` to run, `None` after a visible `SKIPPED:` line, a
/// panic when the fixture is missing but required.
fn gate(resolved: Result<Journey, String>, required: bool) -> Option<Journey> {
    let reason = match resolved {
        Ok(journey) => return Some(journey),
        Err(reason) => reason,
    };
    termihub_core::test_fixtures::require_reported(
        false,
        required,
        format_args!(
            "no native-sshd deploy fixture ({reason}); run it with \
             scripts/internal/run-native-sshd-deploy-journey.sh (the nightly \
             integration-fixtures lane does)"
        ),
        format_args!(
            "native-sshd deploy fixture unavailable ({reason}) but {REQUIRE_ENV} is \
             set — a missing fixture is a hard failure here, not a skip"
        ),
    );
    None
}

/// The process's journey, or `None` (after a `SKIPPED:` line) to skip.
fn live_journey() -> Option<Journey> {
    gate(
        resolve_journey(
            |name| std::env::var(name).ok(),
            |p| p.is_file(),
            cfg!(windows),
        ),
        termihub_core::test_fixtures::flag_set(REQUIRE_ENV),
    )
}

/// The version line `install_agent_bytes` reports for `--version` output:
/// without the `termihub-agent ` prefix, trimmed (`0.1.0 (branch: x)`).
fn reported_version(output: &str) -> String {
    let output = output.trim();
    output
        .strip_prefix("termihub-agent ")
        .unwrap_or(output)
        .trim()
        .to_string()
}

/// What `bin --version` prints here, as [`reported_version`] reports it.
fn local_version(bin: &Path) -> String {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .unwrap_or_else(|e| panic!("running {} --version failed: {e}", bin.display()));
    assert!(
        out.status.success(),
        "{} --version exited {:?}",
        bin.display(),
        out.status
    );
    reported_version(&String::from_utf8_lossy(&out.stdout))
}

/// The host side of one install.
#[derive(Debug)]
struct Installed {
    result: AgentDeployResult,
    steps: Vec<String>,
}

/// Run the production install of `bytes` over `session`.
fn install(session: &SshSession, remote_os: &str, remote_path: &str, bytes: &[u8]) -> Installed {
    let steps = Mutex::new(Vec::new());
    let progress = |step: &str, _message: &str, _pct: f64| {
        steps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(step.to_string());
    };
    let result = install_agent_bytes(session, remote_os, remote_path, bytes, &progress, None)
        .unwrap_or_else(|e| panic!("install_agent_bytes failed: {e}"));
    Installed {
        result,
        steps: steps
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    }
}

/// Assert `installed` is a clean deploy reporting `want_version`; return the
/// installed path.
fn assert_deployed(installed: &Installed, want_version: &str, what: &str) -> String {
    for step in ["uploading", "installing", "verifying", "done"] {
        assert!(
            installed.steps.iter().any(|s| s == step),
            "{what}: the deploy never reported step {step:?}: {:?}",
            installed.steps
        );
    }
    let AgentDeployResult::Deployed {
        success: true,
        installed_version: Some(version),
        installed_path: Some(path),
    } = &installed.result
    else {
        panic!("{what}: not a clean deploy: {:?}", installed.result);
    };
    assert_eq!(
        version, want_version,
        "{what}: the installed agent reports another build"
    );
    path.clone()
}

/// The host OS, its install path and the backup's `--version` command, plus
/// a fresh start: no agent, no backup.
struct Host {
    remote_os: String,
    remote_path: String,
    backup_verify: String,
}

fn prepare_host(journey: &Journey, session: &SshSession) -> Host {
    let (remote_os, _arch) =
        detect_remote_info(session).unwrap_or_else(|e| panic!("detecting the host failed: {e}"));
    if is_windows_os(&remote_os) {
        let shell = detect_windows_shell(session);
        let plan = windows_install_plan(shell);
        rollback::reset(session, shell, &plan);
        Host {
            remote_os,
            // Ignored for Windows hosts (the plan installs to %LOCALAPPDATA%).
            remote_path: crate::terminal::agent_install::POSIX_DEFAULT_INSTALL_PATH.to_string(),
            backup_verify: plan.backup_verify_command,
        }
    } else {
        let remote_path = journey.posix_install_path();
        let backup = format!("{remote_path}{POSIX_BACKUP_SUFFIX}");
        run_remote_command(session, &format!("rm -f '{remote_path}' '{backup}'; echo RESET"))
            .unwrap_or_else(|e| panic!("resetting the install path failed: {e}"));
        Host {
            remote_os,
            backup_verify: format!("{backup} --version 2>/dev/null"),
            remote_path,
        }
    }
}

/// Run `f` with a fresh SSH session on a blocking thread (the remote-exec
/// helpers use `block_in_place`, like the real deploy).
async fn with_session<T: Send + 'static>(
    journey: &Journey,
    f: impl FnOnce(&SshSession) -> T + Send + 'static,
) -> T {
    let ssh = journey.ssh_config();
    tokio::task::spawn_blocking(move || {
        let session = connect_and_authenticate(&ssh)
            .unwrap_or_else(|e| panic!("SSH to the fixture failed: {e}"));
        f(&session)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()))
}

/// Probe the installed agent with the production probe and its full version
/// line; both must match `want_version`.
fn assert_probe_reports(
    journey: &Journey,
    session: &SshSession,
    agent_path: &str,
    want_version: &str,
    remote_os: &str,
) {
    let config = journey.agent_config(agent_path);
    let probe = probe_remote_agent(&config, env!("CARGO_PKG_VERSION"))
        .unwrap_or_else(|e| panic!("probe_remote_agent failed: {e}"));
    assert!(probe.found, "the probe found no agent: {probe:?}");
    assert_eq!(
        probe.version.as_deref(),
        Some(env!("CARGO_PKG_VERSION")),
        "the probe reports another version: {probe:?}"
    );
    assert!(probe.compatible, "the probe reports it incompatible: {probe:?}");
    assert_eq!(probe.remote_os, remote_os, "probe: {probe:?}");
    // The probe keeps only the version token, the same for both builds; the
    // full line tells them apart.
    let line = run_remote_command(session, &config.agent_version_command())
        .unwrap_or_else(|e| panic!("running the installed agent's --version failed: {e}"));
    assert_eq!(
        reported_version(&line),
        want_version,
        "the installed agent is another build"
    );
}

/// Create + attach a persistent shell session running a `TICK=<n>` counter;
/// returns its id.
async fn start_counter_session(
    journey: &Journey,
    channel: &mut russh::Channel<russh::client::Msg>,
    request_id: &mut u64,
    windows_host: bool,
) -> String {
    let sid = if windows_host {
        let sid = create_powershell_session(channel, request_id, "journey-5208").await;
        write_input(
            channel,
            request_id,
            &sid,
            "$i=0; while ($true) { \"TICK=$i\"; $i++; Start-Sleep -Milliseconds 200 }\r",
        )
        .await;
        sid
    } else {
        // `sh`, not the login shell: it keeps no history and reads no rc file.
        let home = journey.home.clone().expect("POSIX host has a scratch home");
        let created = channel_rpc(
            channel,
            request_id,
            "connection.create",
            serde_json::json!({
                "type": "local",
                "title": "journey-5208",
                "config": { "shell": "sh", "startingDirectory": home },
            }),
        )
        .await
        .unwrap_or_else(|e| panic!("connection.create failed: {e}"));
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
        .unwrap_or_else(|e| panic!("connection.attach failed: {e}"));
        write_input(
            channel,
            request_id,
            &sid,
            "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n",
        )
        .await;
        sid
    };
    sid
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deploy_probe_update_and_reattach_journey() {
    let Some(journey) = live_journey() else {
        return;
    };
    trust_all_host_keys();

    let version_a = local_version(&journey.agent_bin);
    let version_b = local_version(&journey.update_bin);
    assert_ne!(
        version_a, version_b,
        "the two builds report the same version line; build B with another \
         TERMIHUB_BUILD_BRANCH"
    );
    for v in [&version_a, &version_b] {
        assert!(
            v.starts_with(env!("CARGO_PKG_VERSION")),
            "a build reports {v:?}, expected {}",
            env!("CARGO_PKG_VERSION")
        );
    }
    let bytes_a = std::fs::read(&journey.agent_bin).expect("read build A");
    let bytes_b = std::fs::read(&journey.update_bin).expect("read build B");

    // ── 1 + 2. Deploy build A, then probe it.
    let j = journey.clone();
    let want_a = version_a.clone();
    let (host, agent_path) = with_session(&journey, move |session| {
        let host = prepare_host(&j, session);
        let installed = install(session, &host.remote_os, &host.remote_path, &bytes_a);
        let path = assert_deployed(&installed, &want_a, "first deploy (build A)");
        assert_probe_reports(&j, session, &path, &want_a, &host.remote_os);
        (host, path)
    })
    .await;
    let windows_host = is_windows_os(&host.remote_os);
    eprintln!("journey: build A {version_a:?} installed at {agent_path} on {}", host.remote_os);

    // ── 3. A persistent session on build A, then a desktop disconnect.
    let config = journey.agent_config(&agent_path);
    let mut request_id = 0u64;
    let (session, mut channel) = establish(&config, &mut request_id).await;
    let sid = start_counter_session(&journey, &mut channel, &mut request_id, windows_host).await;
    let before = read_counter_until(&mut channel, |m| m >= 3, Instant::now() + LIVE_CEILING)
        .await
        .expect("the session never produced TICK values on build A");
    drop(channel);
    drop(session);
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // ── 4. Update to build B under the running session daemon.
    let j = journey.clone();
    let want_b = version_b.clone();
    let (remote_os, remote_path, backup_verify) =
        (host.remote_os.clone(), host.remote_path.clone(), host.backup_verify.clone());
    let first_path = agent_path.clone();
    with_session(&journey, move |session| {
        let installed = install(session, &remote_os, &remote_path, &bytes_b);
        let path = assert_deployed(&installed, &want_b, "update (build B)");
        assert_eq!(path, first_path, "the update installed somewhere else");
        let backup = run_remote_command(session, &backup_verify).unwrap_or_default();
        assert!(
            backup.trim().is_empty(),
            "the update left a runnable backup behind: {backup:?}"
        );
        assert_probe_reports(&j, session, &path, &want_b, &remote_os);
    })
    .await;
    eprintln!("journey: updated to build B {version_b:?} under the running session");

    // ── 5. Reattach through build B: the same session, still counting.
    let (session, mut channel) = establish(&config, &mut request_id).await;
    let list = channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.list",
        serde_json::json!({}),
    )
    .await
    .expect("connection.list after the update failed");
    let survived = list["sessions"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s["session_id"].as_str() == Some(sid.as_str())));
    assert!(
        survived,
        "session {sid} did not survive the update — list: {list}"
    );
    channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .unwrap_or_else(|e| panic!("re-attach to {sid} after the update failed: {e}"));
    let after = read_counter_until(&mut channel, |m| m > before, Instant::now() + LIVE_CEILING)
        .await
        .unwrap_or_else(|| panic!("no TICK values after the reattach (before: {before})"));
    assert!(
        after > before,
        "the counter did not continue across the update: {before} -> {after}"
    );
    let later = read_counter_until(&mut channel, |m| m > after, Instant::now() + LIVE_CEILING)
        .await
        .unwrap_or(after);
    assert!(
        later > after,
        "the reattached counter is not advancing: stuck at {after}"
    );
    eprintln!("journey: reattached {sid}; counter {before} -> {after} -> {later}");

    let _ = channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.close",
        serde_json::json!({ "session_id": sid }),
    )
    .await;
    drop(channel);
    drop(session);

    // Leave the host as found: no agent at the install path.
    let j = journey.clone();
    with_session(&journey, move |session| {
        prepare_host(&j, session);
    })
    .await;
}

// ── Gate unit tests (run everywhere) ───────────────────────────────────

mod gate_tests {
    use super::*;
    use std::collections::HashMap;

    fn full_env() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            (PORT_ENV, "22400"),
            (USER_ENV, "tester"),
            (KEY_ENV, "/k/client"),
            (HOME_ENV, "/state/home"),
            (AGENT_BIN_ENV, "/bin/a"),
            (UPDATE_BIN_ENV, "/bin/b"),
        ])
    }

    fn resolve(env: &HashMap<&str, &str>, windows: bool) -> Result<Journey, String> {
        resolve_journey(
            |name| env.get(name).map(|v| v.to_string()),
            |_| true,
            windows,
        )
    }

    #[test]
    fn a_full_env_resolves() {
        let journey = resolve(&full_env(), false).expect("resolves");
        assert_eq!(journey.port, 22400);
        assert_eq!(journey.home.as_deref(), Some("/state/home"));
        assert_eq!(
            journey.posix_install_path(),
            "/state/home/.local/bin/termihub-agent"
        );
        assert_eq!(journey.agent_bin, PathBuf::from("/bin/a"));
        assert_eq!(journey.update_bin, PathBuf::from("/bin/b"));
    }

    #[test]
    fn a_posix_host_needs_the_scratch_home() {
        let mut env = full_env();
        env.remove(HOME_ENV);
        let err = resolve(&env, false).unwrap_err();
        assert!(err.contains(HOME_ENV) && err.contains("--scratch-home"), "{err}");
        // A Windows fixture logs in as its own test user: no scratch home.
        assert_eq!(resolve(&env, true).expect("resolves").home, None);
    }

    #[test]
    fn each_missing_variable_is_named() {
        for name in [PORT_ENV, USER_ENV, KEY_ENV, AGENT_BIN_ENV, UPDATE_BIN_ENV] {
            let mut env = full_env();
            env.remove(name);
            let err = resolve(&env, false).unwrap_err();
            assert!(err.contains(name), "{name}: {err}");
        }
    }

    #[test]
    fn the_update_must_be_a_second_build() {
        let mut env = full_env();
        env.insert(UPDATE_BIN_ENV, "/bin/a");
        let err = resolve(&env, false).unwrap_err();
        assert!(err.contains("second build"), "{err}");
    }

    #[test]
    fn a_missing_binary_file_is_reported() {
        let err = resolve_journey(
            |name| full_env().get(name).map(|v| v.to_string()),
            |p| p != Path::new("/bin/b"),
            false,
        )
        .unwrap_err();
        assert!(err.contains(UPDATE_BIN_ENV) && err.contains("not a file"), "{err}");
    }

    #[test]
    fn a_missing_fixture_skips_unless_required() {
        assert_eq!(gate(Err("x is unset".to_string()), false), None);
        let journey = resolve(&full_env(), false).expect("resolves");
        assert_eq!(gate(Ok(journey.clone()), true), Some(journey));
    }

    #[test]
    #[should_panic(expected = "REQUIRED")]
    fn a_missing_required_fixture_fails() {
        gate(Err("x is unset".to_string()), true);
    }

    #[test]
    fn reported_version_drops_the_prefix_only() {
        assert_eq!(
            reported_version("termihub-agent 0.1.0 (branch: a)\n"),
            "0.1.0 (branch: a)"
        );
        assert_eq!(reported_version("0.1.0"), "0.1.0");
    }
}
