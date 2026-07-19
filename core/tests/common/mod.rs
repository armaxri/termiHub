//! Shared test utilities for termiHub core integration tests.
//!
//! Provides Docker container availability checks, SSH configuration builders,
//! and output accumulation helpers. All integration tests in this directory
//! depend on Docker containers from `tests/docker/docker-compose.yml`.

// Each integration test is compiled as its own crate, so not every test file
// uses every function from this shared module. Suppress dead_code warnings.
#![allow(dead_code)]

use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

// SSH-only imports: the SSH helpers below need the `ssh` feature (and its
// optional `russh` dependency). Gating them keeps this shared module compilable
// for feature-scoped integration binaries — e.g. `--features ftp` alone, which
// the FTP browser test relies on.
#[cfg(feature = "ssh")]
use russh::ChannelMsg;
#[cfg(feature = "ssh")]
use termihub_core::backends::ssh::handler::SshSession;

/// Check if a TCP port is reachable on the given host.
///
/// Returns `true` if a TCP connection can be established within 2 seconds.
pub fn is_port_reachable(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    if let Ok(addr) = addr.parse() {
        TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
    } else {
        false
    }
}

/// Skip the current test if a Docker container is not reachable on the given port.
///
/// Prints a message to stderr and returns early. This follows the agent crate's
/// existing skip convention (runtime check instead of `#[ignore]`).
macro_rules! require_docker {
    ($port:expr) => {
        if !common::is_port_reachable("127.0.0.1", $port) {
            eprintln!(
                "SKIPPED: Docker container not reachable on port {} \
                 (start with: cd tests/docker && docker compose up -d)",
                $port
            );
            return;
        }
    };
}
pub(crate) use require_docker;

/// Path to the `tests/fixtures/ssh-keys/` directory.
pub fn ssh_keys_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate should be in workspace root")
        .join("tests")
        .join("fixtures")
        .join("ssh-keys")
}

/// Build SSH settings JSON for password authentication.
pub fn ssh_password_settings(port: u16) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "testuser",
        "authMethod": "password",
        "password": "testpass"
    })
}

/// Build SSH settings JSON for key-based authentication (no passphrase).
pub fn ssh_key_settings(port: u16, key_name: &str) -> serde_json::Value {
    let key_path = ssh_keys_dir().join(key_name);
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "testuser",
        "authMethod": "key",
        "keyPath": key_path.to_str().unwrap()
    })
}

/// Build SSH settings JSON for key-based authentication with passphrase.
///
/// All passphrase-protected test keys use `testpass123`.
pub fn ssh_key_passphrase_settings(port: u16, key_name: &str) -> serde_json::Value {
    let key_path = ssh_keys_dir().join(key_name);
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "testuser",
        "authMethod": "key",
        "keyPath": key_path.to_str().unwrap(),
        "password": "testpass123"
    })
}

/// Build an `SshConfig` for password authentication.
///
/// Useful for tests that call `connect_and_authenticate` directly.
pub fn ssh_password_config(port: u16) -> termihub_core::config::SshConfig {
    termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..Default::default()
    }
}

/// Build an `SshConfig` for key-based authentication (no passphrase).
pub fn ssh_key_config(port: u16, key_name: &str) -> termihub_core::config::SshConfig {
    let key_path = ssh_keys_dir().join(key_name);
    termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key_path.to_str().unwrap().to_string()),
        ..Default::default()
    }
}

/// Build an `SshConfig` for key-based authentication with passphrase.
pub fn ssh_key_passphrase_config(port: u16, key_name: &str) -> termihub_core::config::SshConfig {
    let key_path = ssh_keys_dir().join(key_name);
    termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key_path.to_str().unwrap().to_string()),
        password: Some("testpass123".to_string()),
        ..Default::default()
    }
}

/// Execute a command on an authenticated SSH session and return the output.
#[cfg(feature = "ssh")]
pub async fn ssh_exec(session: &SshSession, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open channel: {e}"))?;

    channel
        .exec(false, command)
        .await
        .map_err(|e| format!("Failed to exec: {e}"))?;

    let mut output = String::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                if let Ok(s) = std::str::from_utf8(data) {
                    output.push_str(s);
                }
            }
            Some(ChannelMsg::ExitStatus { .. }) => {}
            Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }
    Ok(output)
}

/// Name of the network-fault container for the active checkout.
///
/// The container is namespaced by the Compose project (`TERMIHUB_TEST_PROJECT`,
/// default `termihub`), so a `docker exec` must target this checkout's instance —
/// `<project>-network-fault` — not a hardcoded name shared across checkouts.
fn network_fault_container() -> String {
    let project = std::env::var("TERMIHUB_TEST_PROJECT").unwrap_or_else(|_| "termihub".into());
    format!("{project}-network-fault")
}

/// Guard that resets network faults on the network-fault container when dropped.
/// Ensures fault state is always cleaned up, even on panic.
pub struct FaultGuard;

impl FaultGuard {
    pub fn new() -> Self {
        // Reset any leftover faults from previous runs.
        let _ = std::process::Command::new("docker")
            .args(["exec", &network_fault_container(), "reset-faults"])
            .output();
        FaultGuard
    }
}

impl Drop for FaultGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("docker")
            .args(["exec", &network_fault_container(), "reset-faults"])
            .output();
    }
}

/// Apply a network fault to the network-fault container.
pub fn apply_fault(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("docker")
        .arg("exec")
        .arg(network_fault_container())
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run docker exec: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Fault injection failed: {stderr}"));
    }
    Ok(())
}

// --- Docker container ports (per-checkout offset aware) ---
//
// Each port is `base + offset`, where `offset` comes from
// `TERMIHUB_TEST_PORT_OFFSET` (or an explicit per-service `TERMIHUB_TEST_*_PORT`
// override) — the env the shell resolver `scripts/internal/dev-local-env.sh`
// exports from `dev.local.json`. With no env (a lone checkout / bare `cargo
// test`) every port falls back to its historical base, so behaviour is
// unchanged. This keeps the integration tests pointed at *this* checkout's
// containers so parallel checkouts never share one. See `docs/testing.md` →
// "Parallel test isolation".

/// Resolve a container host port: an explicit `env_var` wins, else `base` plus
/// `TERMIHUB_TEST_PORT_OFFSET` (default offset `0`).
fn resolve_port(env_var: &str, base: u16) -> u16 {
    if let Some(p) = std::env::var(env_var).ok().and_then(|v| v.parse().ok()) {
        return p;
    }
    let offset: u16 = std::env::var("TERMIHUB_TEST_PORT_OFFSET")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    base + offset
}

/// ssh-password container (password auth, OpenSSH latest).
pub fn port_ssh_password() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201)
}
/// ssh-legacy container (OpenSSH 7.x compatibility).
pub fn port_ssh_legacy() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_LEGACY_PORT", 2202)
}
/// ssh-keys container (key auth only, all key types).
pub fn port_ssh_keys() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_KEYS_PORT", 2203)
}
/// ssh-jumphost-bastion container (ProxyJump entry point).
pub fn port_ssh_bastion() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_BASTION_PORT", 2204)
}
/// ssh-restricted container (rbash limited shell).
pub fn port_ssh_restricted() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_RESTRICTED_PORT", 2205)
}
/// ssh-banner container (pre-auth banner + MOTD).
pub fn port_ssh_banner() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_BANNER_PORT", 2206)
}
/// ssh-tunnel-target container (internal HTTP + echo services).
pub fn port_ssh_tunnel() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_TUNNEL_PORT", 2207)
}
/// ssh-x11 container (X11 forwarding).
pub fn port_ssh_x11() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_X11_PORT", 2208)
}
/// network-fault-proxy container (tc/netem fault injection).
pub fn port_network_fault() -> u16 {
    resolve_port("TERMIHUB_TEST_NETWORK_FAULT_PORT", 2209)
}
/// sftp-stress container (pre-populated SFTP test data).
pub fn port_sftp_stress() -> u16 {
    resolve_port("TERMIHUB_TEST_SFTP_STRESS_PORT", 2210)
}
/// ssh-sftp-only container (`ForceCommand internal-sftp` — no exec channel).
pub fn port_ssh_sftp_only() -> u16 {
    resolve_port("TERMIHUB_TEST_SSH_SFTP_ONLY_PORT", 2211)
}
/// telnet-server container.
pub fn port_telnet() -> u16 {
    resolve_port("TERMIHUB_TEST_TELNET_PORT", 2301)
}
/// vnc-server container (x11vnc + Xvfb, static test pattern, VncAuth).
pub fn port_vnc() -> u16 {
    resolve_port("TERMIHUB_TEST_VNC_PORT", 2501)
}
/// vnc-vencrypt-server container (TigerVNC Xvnc, static test pattern, VeNCrypt
/// X509Vnc over TLS).
pub fn port_vnc_vencrypt() -> u16 {
    resolve_port("TERMIHUB_TEST_VNC_VENCRYPT_PORT", 2502)
}
/// ftp-server container control port (plain FTP + explicit FTPS on :21).
pub fn port_ftp() -> u16 {
    resolve_port("TERMIHUB_TEST_FTP_PORT", 2401)
}
