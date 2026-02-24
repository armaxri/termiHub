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
pub fn ssh_exec(session: &ssh2::Session, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Failed to open channel: {e}"))?;
    channel
        .exec(command)
        .map_err(|e| format!("Failed to exec: {e}"))?;

    let mut output = String::new();
    std::io::Read::read_to_string(&mut channel, &mut output)
        .map_err(|e| format!("Failed to read output: {e}"))?;

    channel.wait_close().ok();
    Ok(output)
}

/// Guard that resets network faults on the `termihub-network-fault` container
/// when dropped. Ensures fault state is always cleaned up, even on panic.
pub struct FaultGuard;

impl FaultGuard {
    pub fn new() -> Self {
        // Reset any leftover faults from previous runs.
        let _ = std::process::Command::new("docker")
            .args(["exec", "termihub-network-fault", "reset-faults"])
            .output();
        FaultGuard
    }
}

impl Drop for FaultGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("docker")
            .args(["exec", "termihub-network-fault", "reset-faults"])
            .output();
    }
}

/// Apply a network fault to the `termihub-network-fault` container.
pub fn apply_fault(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("docker")
        .arg("exec")
        .arg("termihub-network-fault")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run docker exec: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Fault injection failed: {stderr}"));
    }
    Ok(())
}

// --- Docker container port constants ---

/// ssh-password container (password auth, OpenSSH latest).
pub const PORT_SSH_PASSWORD: u16 = 2201;
/// ssh-legacy container (OpenSSH 7.x compatibility).
pub const PORT_SSH_LEGACY: u16 = 2202;
/// ssh-keys container (key auth only, all key types).
pub const PORT_SSH_KEYS: u16 = 2203;
/// ssh-jumphost-bastion container (ProxyJump entry point).
pub const PORT_SSH_BASTION: u16 = 2204;
/// ssh-restricted container (rbash limited shell).
pub const PORT_SSH_RESTRICTED: u16 = 2205;
/// ssh-banner container (pre-auth banner + MOTD).
pub const PORT_SSH_BANNER: u16 = 2206;
/// ssh-tunnel-target container (internal HTTP + echo services).
pub const PORT_SSH_TUNNEL: u16 = 2207;
/// ssh-x11 container (X11 forwarding).
pub const PORT_SSH_X11: u16 = 2208;
/// network-fault-proxy container (tc/netem fault injection).
pub const PORT_NETWORK_FAULT: u16 = 2209;
/// sftp-stress container (pre-populated SFTP test data).
pub const PORT_SFTP_STRESS: u16 = 2210;
/// telnet-server container.
pub const PORT_TELNET: u16 = 2301;
