//! An update installs to the agent's custom POSIX `agentPath` (#5532).
//!
//! The next connect launches the stored `agentPath`, so an update that ignored
//! a custom path and installed to `~/.local/bin` left the old binary in use.
//! These tests run [`update_agent_with`] + [`deploy_agent_with`] against the
//! in-process host with a custom path, the default path, a custom path that
//! holds someone else's file (refused), and a broken new binary (rolled back
//! at the custom path).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::fake_host::{self, broken_binary, fake_binary, HostState, DEFAULT_INSTALLED, HOME};
use super::host_tests::{on_blocking, resolved_binary, BINARY_SIZE};
use super::prologue_tests::{config, local_resolver, Requests};
use super::*;
use crate::terminal::agent_install::POSIX_BACKUP_SUFFIX;

/// A custom install path outside the SSH home.
const CUSTOM: &str = "/opt/termihub/termihub-agent";

fn agent_config(port: u16, agent_path: Option<&str>) -> RemoteAgentConfig {
    RemoteAgentConfig {
        agent_path: agent_path.map(str::to_string),
        ..config(port)
    }
}

/// Run a forced update (no guard) of the agent with `agent_path` on `port`.
async fn update(
    port: u16,
    agent_path: Option<&str>,
    binary: PathBuf,
) -> Result<AgentDeployResult, TerminalError> {
    let config = agent_config(port, agent_path);
    on_blocking(move || {
        update_agent_with(
            "agent-1",
            true,
            || Ok(vec![]),
            || Ok(0),
            || {
                deploy_agent_with(
                    "agent-1",
                    &config,
                    &AgentDeployConfig { remote_path: None },
                    None,
                    local_resolver(binary, Requests::default()),
                )
            },
        )
    })
    .await
}

fn file(state: &Arc<Mutex<HostState>>, path: &str) -> Option<Vec<u8>> {
    state.lock().expect("host").files.get(path).cloned()
}

fn new_binary(dir: &tempfile::TempDir) -> (Vec<u8>, PathBuf) {
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(dir, &bytes, None);
    (bytes, binary)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_replaces_the_agent_at_its_custom_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (bytes, binary) = new_binary(&dir);
    let (port, state) = fake_host::listen(&[(CUSTOM, fake_binary("0.8.0", 1024))]).await;

    let result = update(port, Some(CUSTOM), binary).await.expect("update");

    assert_eq!(
        result,
        AgentDeployResult::Deployed {
            success: true,
            installed_version: Some("0.9.0".to_string()),
            installed_path: Some(CUSTOM.to_string()),
        }
    );
    assert_eq!(
        file(&state, CUSTOM),
        Some(bytes),
        "the new agent is at the custom path"
    );
    assert_eq!(
        file(&state, DEFAULT_INSTALLED),
        None,
        "nothing is installed at the default the connect does not run"
    );
    assert_eq!(
        file(&state, &format!("{CUSTOM}{POSIX_BACKUP_SUFFIX}")),
        None
    );
    assert!(state.lock().expect("host").staged_files().is_empty());

    // The stored path already names the new binary: nothing to record, and the
    // next connect launches exactly what was installed and verified.
    let path = result
        .launchable_install_path()
        .expect("a launchable install");
    assert_eq!(
        agent_install::adopted_agent_path(Some(CUSTOM), path, "~/.local/bin/termihub-agent"),
        None
    );
    assert_eq!(
        agent_config(port, Some(CUSTOM)).agent_exec_command(),
        format!("{CUSTOM} --stdio")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_without_a_custom_path_installs_to_the_default() {
    for agent_path in [None, Some(""), Some("~/.local/bin/termihub-agent")] {
        let dir = tempfile::tempdir().expect("tempdir");
        let (bytes, binary) = new_binary(&dir);
        let (port, state) =
            fake_host::listen(&[(DEFAULT_INSTALLED, fake_binary("0.8.0", 1024))]).await;

        let result = update(port, agent_path, binary).await.expect("update");

        assert!(
            matches!(
                &result,
                AgentDeployResult::Deployed { success: true, installed_path: Some(p), .. }
                    if p == DEFAULT_REMOTE_PATH
            ),
            "{agent_path:?}: {result:?}"
        );
        assert_eq!(
            file(&state, DEFAULT_INSTALLED),
            Some(bytes),
            "{agent_path:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_installs_to_a_custom_path_with_nothing_there_yet() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (bytes, binary) = new_binary(&dir);
    let (port, state) = fake_host::listen(&[]).await;

    let result = update(port, Some(CUSTOM), binary).await.expect("update");

    assert!(
        matches!(result, AgentDeployResult::Deployed { success: true, .. }),
        "{result:?}"
    );
    assert_eq!(file(&state, CUSTOM), Some(bytes));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_installs_to_a_home_relative_custom_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (bytes, binary) = new_binary(&dir);
    let absolute = format!("{HOME}/bin/termihub-agent");
    let (port, state) = fake_host::listen(&[(absolute.as_str(), fake_binary("0.8.0", 64))]).await;

    let result = update(port, Some("~/bin/termihub-agent"), binary)
        .await
        .expect("update");

    assert!(
        matches!(result, AgentDeployResult::Deployed { success: true, .. }),
        "{result:?}"
    );
    assert_eq!(file(&state, &absolute), Some(bytes));
    assert_eq!(file(&state, DEFAULT_INSTALLED), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_refuses_to_replace_a_file_that_is_not_a_termihub_agent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, binary) = new_binary(&dir);
    let theirs = b"#!/bin/sh\necho some other tool\n".to_vec();
    let (port, state) = fake_host::listen(&[(CUSTOM, theirs.clone())]).await;

    let err = update(port, Some(CUSTOM), binary)
        .await
        .expect_err("a foreign file must not be replaced");

    assert!(err.to_string().contains("not a termiHub agent"), "{err}");
    assert_eq!(
        file(&state, CUSTOM),
        Some(theirs),
        "their file is untouched"
    );
    let st = state.lock().expect("host");
    assert!(
        !st.files.keys().any(|p| p.ends_with(POSIX_BACKUP_SUFFIX)),
        "no backup was made: {:?}",
        st.files.keys()
    );
    assert!(
        st.dirs.is_empty(),
        "no upload dir was prepared: {:?}",
        st.dirs
    );
    assert!(st.staged_files().is_empty());
    assert!(!st
        .commands
        .iter()
        .any(|c| c.starts_with("mv ") || c.starts_with("cp ")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_refuses_a_directory_at_the_custom_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, binary) = new_binary(&dir);
    let inside = format!("{CUSTOM}/README");
    let (port, state) = fake_host::listen(&[(inside.as_str(), b"docs".to_vec())]).await;

    let err = update(port, Some(CUSTOM), binary)
        .await
        .expect_err("a directory is not an agent");

    assert!(err.to_string().contains("not a termiHub agent"), "{err}");
    assert_eq!(file(&state, &inside), Some(b"docs".to_vec()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_refuses_a_shell_unsafe_custom_path_before_touching_the_host() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, binary) = new_binary(&dir);
    let (port, state) = fake_host::listen(&[]).await;

    let err = update(port, Some("/opt/my agent;rm -rf ~"), binary)
        .await
        .expect_err("an unsafe path is refused");

    assert!(err.to_string().contains("cannot be used"), "{err}");
    let st = state.lock().expect("host");
    assert_eq!(
        st.commands,
        ["uname -s", "uname -m"],
        "only the OS was detected"
    );
    assert!(st.files.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_broken_new_binary_is_rolled_back_at_the_custom_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Not an ELF header (the arch check would refuse it first), and its
    // `--version` fails like a binary that refuses to start.
    let mut broken = b"crashes on start\n".to_vec();
    broken.resize(BINARY_SIZE, 0);
    let binary = resolved_binary(&dir, &broken, None);
    let old = fake_binary("0.8.0", 1024);
    let (port, state) = fake_host::listen(&[(CUSTOM, old.clone())]).await;

    let result = update(port, Some(CUSTOM), binary)
        .await
        .expect("a rollback is reported, not an error");

    match &result {
        AgentDeployResult::RolledBack {
            restored_version,
            installed_path,
            ..
        } => {
            assert_eq!(restored_version, "0.8.0");
            assert_eq!(installed_path.as_deref(), Some(CUSTOM));
        }
        other => panic!("expected RolledBack, got {other:?}"),
    }
    assert_eq!(
        file(&state, CUSTOM),
        Some(old),
        "the previous agent is back"
    );
    assert_eq!(
        file(&state, &format!("{CUSTOM}{POSIX_BACKUP_SUFFIX}")),
        None
    );
    assert_eq!(file(&state, DEFAULT_INSTALLED), None);
    assert_eq!(result.launchable_install_path(), Some(CUSTOM));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_broken_agent_with_a_working_backup_at_the_custom_path_is_recovered() {
    // An earlier update died after the move: the custom path holds a binary
    // that does not start, and its `.previous` backup is the working agent.
    let dir = tempfile::tempdir().expect("tempdir");
    let (bytes, binary) = new_binary(&dir);
    let backup = format!("{CUSTOM}{POSIX_BACKUP_SUFFIX}");
    let (port, state) = fake_host::listen(&[
        (CUSTOM, broken_binary(512)),
        (backup.as_str(), fake_binary("0.8.0", 512)),
    ])
    .await;

    let result = update(port, Some(CUSTOM), binary).await.expect("update");

    assert!(
        matches!(result, AgentDeployResult::Deployed { success: true, .. }),
        "{result:?}"
    );
    assert_eq!(file(&state, CUSTOM), Some(bytes));
    assert_eq!(file(&state, &backup), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_explicit_remote_path_overrides_the_stored_agent_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (bytes, binary) = new_binary(&dir);
    let (port, state) = fake_host::listen(&[]).await;
    let config = agent_config(port, Some(CUSTOM));

    let result = on_blocking(move || {
        deploy_agent_with(
            "agent-1",
            &config,
            &AgentDeployConfig {
                remote_path: Some("/srv/termihub-agent".to_string()),
            },
            None,
            local_resolver(binary, Requests::default()),
        )
    })
    .await
    .expect("deploy");

    assert!(
        matches!(result, AgentDeployResult::Deployed { success: true, .. }),
        "{result:?}"
    );
    assert_eq!(file(&state, "/srv/termihub-agent"), Some(bytes));
    assert_eq!(file(&state, CUSTOM), None);
}
