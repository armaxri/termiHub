//! The deploy / stage / update prologues against the in-process host (#5208).
//!
//! [`deploy_agent`], [`stage_agent_binary`] and [`update_agent`] open their own
//! SSH session, detect the remote system and resolve the binary through the
//! Tauri `AppHandle` before the install half that [`super::host_tests`] covers.
//! These tests run that prologue for real: the fake host listens on a loopback
//! TCP port, the production `connect_and_authenticate` dials it, and a local
//! file stands in for the `AppHandle`-bound binary resolution (the
//! `*_with` variants take the resolver, or the re-deploy, as an argument).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use super::fake_host::{self, fake_binary, HostState, DEFAULT_INSTALLED};
use super::host_tests::{installed, on_blocking, resolved_binary, BINARY_SIZE, VERSION};
use super::*;

/// A password-auth agent config for the fake host on `port`.
fn config(port: u16) -> RemoteAgentConfig {
    RemoteAgentConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "deploy".to_string(),
        auth_method: "password".to_string(),
        password: Some("pw".to_string()),
        ..Default::default()
    }
}

/// What the resolver was asked for: `(version, arch_suffix)`.
type Requests = Arc<Mutex<Vec<(String, String)>>>;

/// A resolver that hands out `binary` and records each request.
fn local_resolver(
    binary: PathBuf,
    requests: Requests,
) -> impl FnOnce(&str, &str, &dyn Fn(u64, u64)) -> anyhow::Result<PathBuf> {
    move |version, arch_suffix, progress| {
        requests
            .lock()
            .expect("requests")
            .push((version.to_string(), arch_suffix.to_string()));
        progress(0, 0);
        progress(1, 2);
        Ok(binary)
    }
}

/// A resolver the test expects never to be reached.
fn unreachable_resolver(
    requests: Requests,
) -> impl FnOnce(&str, &str, &dyn Fn(u64, u64)) -> anyhow::Result<PathBuf> {
    local_resolver(PathBuf::from("/nonexistent/termihub-agent"), requests)
}

/// The fake host reports `os` from `uname -s` (and `arch` from `uname -m`).
fn report(state: &Arc<Mutex<HostState>>, os: &str, arch: &str) {
    let mut st = state.lock().expect("host");
    st.faults.uname_s = Some(os.to_string());
    st.faults.uname_m = Some(arch.to_string());
}

/// A minimal little-endian ELF header for machine `e_machine`.
fn elf_binary(dir: &tempfile::TempDir, e_machine: u16) -> PathBuf {
    let mut header = vec![0u8; 64];
    header[0..4].copy_from_slice(b"\x7fELF");
    header[4] = 2; // 64-bit
    header[5] = 1; // little endian
    header[18..20].copy_from_slice(&e_machine.to_le_bytes());
    let path = dir.path().join("termihub-agent-linux-x64");
    std::fs::write(&path, header).expect("write ELF");
    path
}

async fn deploy(
    port: u16,
    cancel: Option<CancellationToken>,
    resolve: impl FnOnce(&str, &str, &dyn Fn(u64, u64)) -> anyhow::Result<PathBuf> + Send + 'static,
) -> Result<AgentDeployResult, TerminalError> {
    on_blocking(move || {
        deploy_agent_with(
            "agent-1",
            &config(port),
            &AgentDeployConfig { remote_path: None },
            cancel.as_ref(),
            resolve,
        )
    })
    .await
}

async fn stage(
    port: u16,
    resolve: impl FnOnce(&str, &str, &dyn Fn(u64, u64)) -> anyhow::Result<PathBuf> + Send + 'static,
) -> Result<StagedBinary, TerminalError> {
    on_blocking(move || {
        stage_agent_binary_with(
            "agent-1",
            &config(port),
            &AgentDeployConfig { remote_path: None },
            None,
            resolve,
        )
    })
    .await
}

fn requested(requests: &Requests) -> Vec<(String, String)> {
    requests.lock().expect("requests").clone()
}

fn linux_x64() -> String {
    crate::terminal::agent_binary::artifact_name_for_os_arch("Linux", "x86_64")
        .expect("linux x64 is a release artifact")
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_connects_detects_resolves_and_installs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(&dir, &bytes, None);
    let (port, state) = fake_host::listen(&[]).await;
    let requests = Requests::default();

    let result = deploy(port, None, local_resolver(binary, requests.clone()))
        .await
        .expect("deploy");

    assert!(
        matches!(result, AgentDeployResult::Deployed { success: true, .. }),
        "{result:?}"
    );
    assert_eq!(
        requested(&requests),
        vec![(VERSION.to_string(), linux_x64())],
        "the binary is resolved for this desktop's version and the detected host"
    );
    assert_eq!(installed(&state), Some(bytes));
    let st = state.lock().expect("host");
    assert_eq!(
        &st.commands[..2],
        ["uname -s", "uname -m"],
        "{:?}",
        st.commands
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_cancelled_before_connecting_touches_nothing() {
    let (port, state) = fake_host::listen(&[]).await;
    let requests = Requests::default();
    let cancel = CancellationToken::new();
    cancel.cancel();

    let err = deploy(port, Some(cancel), unreachable_resolver(requests.clone()))
        .await
        .expect_err("a cancelled deploy must not run");

    assert!(matches!(err, TerminalError::Cancelled), "{err:?}");
    assert!(requested(&requests).is_empty());
    assert!(state.lock().expect("host").commands.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_to_an_unsupported_platform_fails_before_resolving() {
    let (port, state) = fake_host::listen(&[]).await;
    report(&state, "Plan9", "mips");
    let requests = Requests::default();

    let err = deploy(port, None, unreachable_resolver(requests.clone()))
        .await
        .expect_err("no release artifact exists for this host");

    assert!(
        err.to_string().contains("Unsupported remote platform"),
        "{err}"
    );
    assert!(requested(&requests).is_empty(), "nothing to resolve");
    assert!(
        state.lock().expect("host").files.is_empty(),
        "nothing uploaded"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_reports_a_failed_resolution_and_uploads_nothing() {
    let (port, state) = fake_host::listen(&[]).await;

    let err = deploy(port, None, |_, _, _| anyhow::bail!("offline"))
        .await
        .expect_err("an unresolvable binary fails the deploy");

    assert!(
        err.to_string()
            .contains("Failed to resolve binary: offline"),
        "{err}"
    );
    assert!(
        state.lock().expect("host").files.is_empty(),
        "nothing uploaded"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_refuses_a_binary_built_for_another_architecture() {
    let dir = tempfile::tempdir().expect("tempdir");
    let aarch64 = elf_binary(&dir, 0xB7);
    let old = fake_binary("0.8.0", 1024);
    let (port, state) = fake_host::listen(&[(DEFAULT_INSTALLED, old.clone())]).await;
    let requests = Requests::default();

    let err = deploy(port, None, local_resolver(aarch64, requests))
        .await
        .expect_err("an aarch64 binary must not reach an x86_64 host");

    assert!(err.to_string().contains("Architecture mismatch"), "{err}");
    assert_eq!(installed(&state), Some(old), "the running agent is kept");
    assert!(state.lock().expect("host").staged_files().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_runs_the_prologue_then_uploads_without_installing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(&dir, &bytes, None);
    let old = fake_binary("0.8.0", 1024);
    let (port, state) = fake_host::listen(&[(DEFAULT_INSTALLED, old.clone())]).await;
    let requests = Requests::default();

    let staged = stage(port, local_resolver(binary, requests.clone()))
        .await
        .expect("stage");

    assert_eq!(staged.remote_os, "Linux");
    assert!(!staged.is_windows);
    assert_eq!(
        requested(&requests),
        vec![(VERSION.to_string(), linux_x64())]
    );
    let upload_path = staged.upload_path.expect("a Unix stage has a path");
    assert_eq!(
        state.lock().expect("host").files.get(&upload_path),
        Some(&bytes)
    );
    assert_eq!(installed(&state), Some(old), "staging never installs");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_on_a_windows_host_uploads_nothing() {
    let (port, state) = fake_host::listen(&[]).await;
    report(&state, "MINGW64_NT-10.0-19045", "x86_64");
    let requests = Requests::default();

    let staged = stage(port, unreachable_resolver(requests.clone()))
        .await
        .expect("a Windows host falls back to an immediate deploy");

    assert_eq!(
        staged,
        StagedBinary {
            remote_os: "MINGW64_NT-10.0-19045".to_string(),
            is_windows: true,
            upload_path: None,
            expected_sha256: String::new(),
            signature: None,
        }
    );
    assert!(requested(&requests).is_empty(), "nothing is resolved");
    assert!(
        state.lock().expect("host").files.is_empty(),
        "nothing uploaded"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_to_an_unsupported_platform_fails_before_resolving() {
    let (port, state) = fake_host::listen(&[]).await;
    report(&state, "Plan9", "mips");
    let requests = Requests::default();

    let err = stage(port, unreachable_resolver(requests.clone()))
        .await
        .expect_err("no release artifact exists for this host");

    assert!(
        err.to_string().contains("Unsupported remote platform"),
        "{err}"
    );
    assert!(requested(&requests).is_empty());
}

/// Run [`update_agent_with`] against the fake host on `port`.
async fn update(
    port: u16,
    force: bool,
    other_hosts: Vec<ConnectedHost>,
    shutdown: Result<u32, TerminalError>,
    binary: PathBuf,
) -> (Result<AgentDeployResult, TerminalError>, bool, bool) {
    let listed = Arc::new(Mutex::new(false));
    let shut_down = Arc::new(Mutex::new(false));
    let (l, s) = (listed.clone(), shut_down.clone());
    let result = on_blocking(move || {
        update_agent_with(
            "agent-1",
            force,
            move || {
                *l.lock().expect("listed") = true;
                Ok(other_hosts)
            },
            move || {
                *s.lock().expect("shut down") = true;
                shutdown
            },
            || {
                deploy_agent_with(
                    "agent-1",
                    &config(port),
                    &AgentDeployConfig { remote_path: None },
                    None,
                    local_resolver(binary, Requests::default()),
                )
            },
        )
    })
    .await;
    let listed = *listed.lock().expect("listed");
    let shut_down = *shut_down.lock().expect("shut down");
    (result, listed, shut_down)
}

fn other_host() -> ConnectedHost {
    ConnectedHost {
        client_id: "other".to_string(),
        client: "termihub-desktop".to_string(),
        client_version: "0.1.0".to_string(),
        connected_since: "2026-01-01T00:00:00Z".to_string(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_with_other_hosts_connected_is_refused_before_the_shutdown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = resolved_binary(&dir, &fake_binary("0.9.0", 4096), None);
    let old = fake_binary("0.8.0", 1024);
    let (port, state) = fake_host::listen(&[(DEFAULT_INSTALLED, old.clone())]).await;

    let (result, listed, shut_down) = update(port, false, vec![other_host()], Ok(0), binary).await;

    assert!(
        matches!(
            result,
            Ok(AgentDeployResult::OtherHostsConnected { ref hosts }) if hosts.len() == 1
        ),
        "{result:?}"
    );
    assert!(listed, "the guard asks the agent who is connected");
    assert!(!shut_down, "a refused update never shuts the agent down");
    assert_eq!(installed(&state), Some(old));
    assert!(state.lock().expect("host").commands.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_shuts_the_agent_down_then_deploys() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(&dir, &bytes, None);
    let (port, state) = fake_host::listen(&[(DEFAULT_INSTALLED, fake_binary("0.8.0", 1024))]).await;

    let (result, listed, shut_down) = update(port, false, vec![], Ok(2), binary).await;

    assert!(
        matches!(
            result,
            Ok(AgentDeployResult::Deployed { success: true, .. })
        ),
        "{result:?}"
    );
    assert!(listed && shut_down);
    assert_eq!(installed(&state), Some(bytes));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forced_update_skips_the_guard_and_survives_a_failed_shutdown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(&dir, &bytes, None);
    let (port, state) = fake_host::listen(&[(DEFAULT_INSTALLED, fake_binary("0.8.0", 1024))]).await;

    let (result, listed, shut_down) = update(
        port,
        true,
        vec![other_host()],
        Err(TerminalError::RemoteError(
            "agent already stopped".to_string(),
        )),
        binary,
    )
    .await;

    assert!(
        matches!(
            result,
            Ok(AgentDeployResult::Deployed { success: true, .. })
        ),
        "{result:?}"
    );
    assert!(!listed, "force bypasses the connected-host guard");
    assert!(shut_down, "the shutdown is still attempted");
    assert_eq!(installed(&state), Some(bytes));
}

async fn probe(port: u16) -> Result<AgentProbeResult, TerminalError> {
    on_blocking(move || probe_remote_agent(&config(port), VERSION)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_reports_the_installed_agent_version() {
    let installed_version = VERSION;
    let (port, _state) =
        fake_host::listen(&[(DEFAULT_INSTALLED, fake_binary(installed_version, 1024))]).await;

    let probe = probe(port).await.expect("probe");

    assert!(probe.found, "{probe:?}");
    assert_eq!(probe.version.as_deref(), Some(installed_version));
    assert!(probe.compatible, "{probe:?}");
    assert_eq!(
        (probe.remote_os.as_str(), probe.remote_arch.as_str()),
        ("Linux", "x86_64")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_of_a_host_without_the_agent_reports_not_found() {
    let (port, _state) = fake_host::listen(&[]).await;

    let probe = probe(port).await.expect("probe");

    assert!(!probe.found && !probe.compatible, "{probe:?}");
    assert_eq!(probe.version, None);
}
