//! The deploy against a Windows host whose login shell is Git Bash (#5449).
//!
//! Win32-OpenSSH runs every exec in the account's `DefaultShell`. When that is
//! neither `cmd.exe` nor PowerShell, the deploy must install the agent `.exe`
//! with PowerShell anyway — each step as `powershell.exe -EncodedCommand` —
//! and never fall back to POSIX commands. The in-process host stands in for
//! such a host: `uname -s` reports MinGW, `echo` behaves like `sh`, and
//! `powershell.exe` answers the decoded scripts per [`Faults::powershell`].
//! Anything unexpected (no PowerShell, an unusable install path, a binary for
//! another architecture) must stop the deploy before anything is uploaded.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::fake_host::{self, HostState, HOME};
use super::host_tests::{resolved_binary, VERSION};
use super::prologue_tests::{deploy, local_resolver, report, Requests};
use super::*;
use crate::terminal::agent_install::{
    windows_install_plan, WindowsShell, WINDOWS_POWERSHELL_EXE, WINDOWS_UPLOAD_NAME,
};
use crate::utils::remote_exec::{PE_MACHINE_AMD64, PE_MACHINE_ARM64};

const MINGW: &str = "MINGW64_NT-10.0-19045";

/// What the fake `powershell.exe` resolves the install path to.
const RESOLVED: &str = r"C:\Users\deploy\AppData\Local\termiHub\agent\termihub-agent.exe";

/// The launch path the deploy must store for a Git Bash host.
const LAUNCH_PATH: &str = "C:/Users/deploy/AppData/Local/termiHub/agent/termihub-agent.exe";

/// A minimal PE image for `machine`, padded to a plausible size.
fn pe_bytes(machine: u16) -> Vec<u8> {
    let mut bytes = vec![0u8; 4096];
    bytes[0..2].copy_from_slice(b"MZ");
    bytes[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
    bytes[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
    bytes
}

/// Replies of a healthy Windows PowerShell, keyed by a word of each script the
/// deploy sends (first match wins, so the more specific keys come first).
fn healthy_powershell(resolved: &str) -> Vec<(&'static str, String)> {
    vec![
        ("PROCESSOR_ARCHITECTURE", "AMD64".to_string()),
        ("Join-Path", resolved.to_string()),
        ("New-Item", String::new()),
        ("Copy-Item", String::new()),
        ("--version", format!("termihub-agent {VERSION}")),
        ("Get-ChildItem", String::new()),
        ("Remove-Item", String::new()),
    ]
}

/// A Git Bash host with `powershell` as its `powershell.exe`.
async fn git_bash_host(
    powershell: Option<Vec<(&'static str, String)>>,
) -> (u16, Arc<Mutex<HostState>>) {
    let (port, state) = fake_host::listen(&[]).await;
    report(&state, MINGW, "x86_64");
    state.lock().expect("host").faults.powershell = powershell;
    (port, state)
}

async fn deploy_bytes(
    port: u16,
    dir: &tempfile::TempDir,
    bytes: &[u8],
) -> Result<AgentDeployResult, TerminalError> {
    let binary: PathBuf = resolved_binary(dir, bytes, None);
    deploy(port, None, local_resolver(binary, Requests::default())).await
}

fn commands(state: &Arc<Mutex<HostState>>) -> Vec<String> {
    state.lock().expect("host").commands.clone()
}

fn assert_nothing_uploaded(state: &Arc<Mutex<HostState>>) {
    let st = state.lock().expect("host");
    assert!(
        st.files.is_empty(),
        "nothing may be uploaded: {:?}",
        st.files.keys()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn git_bash_host_deploys_through_encoded_powershell() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = pe_bytes(PE_MACHINE_AMD64);
    let (port, state) = git_bash_host(Some(healthy_powershell(RESOLVED))).await;

    let result = deploy_bytes(port, &dir, &bytes).await.expect("deploy");

    assert_eq!(
        result,
        AgentDeployResult::Deployed {
            success: true,
            installed_version: Some(VERSION.to_string()),
            installed_path: Some(LAUNCH_PATH.to_string()),
        }
    );
    let st = state.lock().expect("host");
    assert_eq!(
        st.files.get(&format!("{HOME}/{WINDOWS_UPLOAD_NAME}")),
        Some(&bytes),
        "the .exe is uploaded over SFTP"
    );
    let posix_steps = ["mkdir", "mv ", "cp ", "rm ", "chmod", "rmdir", "sh -c"];
    for command in &st.commands {
        assert!(
            command == "uname -s"
                || command == "uname -m"
                || command.starts_with("echo ")
                || command.starts_with(&format!("{WINDOWS_POWERSHELL_EXE} ")),
            "a Git Bash host gets only PowerShell steps, got {command:?}"
        );
        assert!(
            !posix_steps.iter().any(|p| command.starts_with(p)),
            "{command:?}"
        );
    }
    let native = windows_install_plan(WindowsShell::PowerShell);
    assert!(
        st.powershell_scripts.contains(&native.install_command),
        "the install step is the PowerShell plan's, unchanged: {:?}",
        st.powershell_scripts
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn git_bash_host_without_powershell_fails_closed_before_upload() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (port, state) = git_bash_host(None).await;

    let err = deploy_bytes(port, &dir, &pe_bytes(PE_MACHINE_AMD64))
        .await
        .expect_err("no PowerShell, no deploy");

    assert!(err.to_string().contains(WINDOWS_POWERSHELL_EXE), "{err}");
    assert_nothing_uploaded(&state);
    assert!(
        !commands(&state).iter().any(|c| c.contains("New-Item")),
        "no install step is attempted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_install_path_with_a_space_fails_closed_before_upload() {
    let dir = tempfile::tempdir().expect("tempdir");
    let spaced = r"C:\Users\John Doe\AppData\Local\termiHub\agent\termihub-agent.exe";
    let (port, state) = git_bash_host(Some(healthy_powershell(spaced))).await;

    let err = deploy_bytes(port, &dir, &pe_bytes(PE_MACHINE_AMD64))
        .await
        .expect_err("a path the login shell would split is refused");

    assert!(err.to_string().contains("install path"), "{err}");
    assert_nothing_uploaded(&state);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_windows_binary_for_another_architecture_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (port, state) = git_bash_host(Some(healthy_powershell(RESOLVED))).await;

    let err = deploy_bytes(port, &dir, &pe_bytes(PE_MACHINE_ARM64))
        .await
        .expect_err("an ARM64 agent must not reach an x64 host");

    assert!(err.to_string().contains("Architecture mismatch"), "{err}");
    assert_nothing_uploaded(&state);
    assert!(state.lock().expect("host").powershell_scripts.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_non_windows_binary_for_a_windows_host_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (port, state) = git_bash_host(Some(healthy_powershell(RESOLVED))).await;

    let err = deploy_bytes(port, &dir, &fake_host::fake_binary(VERSION, 4096))
        .await
        .expect_err("a non-PE binary is not a Windows agent");

    assert!(
        err.to_string().contains("not a Windows executable"),
        "{err}"
    );
    assert_nothing_uploaded(&state);
}
