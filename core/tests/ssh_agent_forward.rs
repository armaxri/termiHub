#![cfg(all(feature = "ssh", unix))]
//! SSH agent forwarding (#1699) against live Docker fixtures (#4005).
//!
//! Each test starts a private `ssh-agent` holding one test key, points this
//! process's `SSH_AUTH_SOCK` at it, opens a real shell through termiHub's own
//! connector ([`RusshSshConnector::open_shell`]) with `forward_agent` set, and
//! runs `ssh-add -l` on the remote. The remote can only list the key if the
//! forwarded `auth-agent@openssh.com` channel reached termiHub's bridge and was
//! pumped to the local agent.
//!
//! - AFWD-01: direct connect to `ssh-jumphost-bastion` lists the key.
//! - AFWD-02: `ssh-jumphost-target` through a ProxyJump hop lists the key — the
//!   target has no host port, so this proves forwarding end to end through
//!   the chain.
//! - AFWD-03: `forward_agent` with **no** local agent connects cleanly and the
//!   shell works; the remote simply has no agent.
//! - AFWD-04: a running local agent is **not** exposed when `forward_agent` is
//!   off.
//!
//! The agent key (`ecdsa_256`) differs from the login key (`ed25519`), so a
//! listed fingerprint can only have come from the forwarded agent.
//!
//! The connector reads the process-global `SSH_AUTH_SOCK`, and every test uses
//! the shared bastion, so the tests are serialized with `#[serial(ssh_bastion)]`
//! (see `ssh_advanced.rs` for why the bastion needs it). Unix only: the agent
//! is a Unix-socket `ssh-agent`.
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d` and
//! `ssh-agent` / `ssh-add` / `ssh-keygen` on `PATH`.

mod common;

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{port_ssh_bastion, require_docker, ssh_key_config, ssh_keys_dir};
use serial_test::serial;
use termihub_core::backends::ssh::connector::{RusshSshConnector, SshConnector};
use termihub_core::config::{JumpHostConfig, SshConfig};

/// The key loaded into the test agent. Not the login key, on purpose.
const AGENT_KEY: &str = "ecdsa_256";

/// A private `ssh-agent` on a socket in its own temp dir, killed by PID on drop.
struct TestAgent {
    child: Child,
    sock: PathBuf,
    _dir: tempfile::TempDir,
}

impl TestAgent {
    /// Start an agent and load [`AGENT_KEY`] into it.
    fn start() -> Self {
        let dir = tempfile::tempdir().expect("temp dir for ssh-agent");
        let sock = dir.path().join("agent.sock");
        // `-D`: stay in the foreground, so `child` IS the agent and killing it
        // by PID on drop is exact.
        let child = Command::new("ssh-agent")
            .arg("-D")
            .arg("-a")
            .arg(&sock)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ssh-agent (is OpenSSH installed?)");
        let agent = TestAgent {
            child,
            sock,
            _dir: dir,
        };

        let deadline = Instant::now() + Duration::from_secs(10);
        while !agent.sock.exists() {
            assert!(
                Instant::now() < deadline,
                "ssh-agent never created its socket"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        // ssh-add refuses a private key readable by others, and a git checkout
        // does not preserve 0600, so load a private copy.
        let key = agent._dir.path().join(AGENT_KEY);
        std::fs::copy(ssh_keys_dir().join(AGENT_KEY), &key).expect("copy agent key");
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))
            .expect("chmod agent key");
        let out = Command::new("ssh-add")
            .arg(&key)
            .env("SSH_AUTH_SOCK", &agent.sock)
            .output()
            .expect("run ssh-add");
        assert!(
            out.status.success(),
            "ssh-add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        agent.sock_env();
        agent
    }

    /// Point this process's `SSH_AUTH_SOCK` at the agent (what the connector
    /// reads). Safe here: every test in this binary is `#[serial]`.
    fn sock_env(&self) {
        std::env::set_var("SSH_AUTH_SOCK", &self.sock);
    }
}

impl Drop for TestAgent {
    fn drop(&mut self) {
        std::env::remove_var("SSH_AUTH_SOCK");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `SHA256:…` fingerprint of a public key, as `ssh-add -l` prints it.
fn fingerprint(pub_key: &Path) -> String {
    let out = Command::new("ssh-keygen")
        .arg("-lf")
        .arg(pub_key)
        .output()
        .expect("run ssh-keygen");
    assert!(out.status.success(), "ssh-keygen -lf failed");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .find(|t| t.starts_with("SHA256:"))
        .expect("fingerprint in ssh-keygen output")
        .to_string()
}

fn agent_key_fingerprint() -> String {
    fingerprint(&ssh_keys_dir().join(format!("{AGENT_KEY}.pub")))
}

/// The bastion, connected to directly.
fn bastion_config(forward_agent: bool) -> SshConfig {
    SshConfig {
        forward_agent,
        ..ssh_key_config(port_ssh_bastion(), "ed25519")
    }
}

/// `ssh-jumphost-target` through one ProxyJump hop (the bastion).
fn jumped_target_config(forward_agent: bool) -> SshConfig {
    let key = ssh_keys_dir().join("ed25519");
    let key = key.to_str().expect("key path is valid UTF-8").to_string();
    SshConfig {
        host: "ssh-jumphost-target".to_string(),
        port: 22,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key.clone()),
        forward_agent,
        proxy_jump: vec![JumpHostConfig {
            host: "127.0.0.1".to_string(),
            port: port_ssh_bastion(),
            username: "testuser".to_string(),
            auth_method: "key".to_string(),
            key_path: Some(key),
            ..Default::default()
        }],
        ..Default::default()
    }
}

/// What `ssh-add -l` reported on the remote.
struct AgentListing {
    /// Everything the shell printed.
    output: String,
    /// `ssh-add -l`'s exit code: 0 = keys listed, 1 = agent has no keys,
    /// 2 = no agent reachable.
    rc: Option<u32>,
}

/// Open a shell with `config`, run `ssh-add -l`, and report what it printed.
async fn remote_ssh_add_list(config: &SshConfig) -> AgentListing {
    let alive = Arc::new(AtomicBool::new(true));
    let handle = RusshSshConnector
        .open_shell(config, alive.clone(), None)
        .await
        .unwrap_or_else(|e| panic!("connect to {} failed: {e}", config.host));

    // The end marker is split in the command, so the terminal echo of the
    // input line cannot match it.
    (handle.write)(b"ssh-add -l; echo \"TH_RC=$?\" \"TH_\"\"END\"\n").expect("write to shell");
    let output = read_until(handle.reader, "TH_END").await;

    alive.store(false, Ordering::SeqCst);
    let _ = (handle.close)();

    let rc = output
        .split("TH_RC=")
        .skip(1)
        .filter_map(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .last();
    AgentListing { output, rc }
}

/// Read from the shell until `needle` appears or 20 s pass.
async fn read_until(mut reader: Box<dyn Read + Send>, needle: &'static str) -> String {
    tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    // The marker must be the printed one, not the echoed input
                    // (which carries `"TH_""END"`, never `TH_END`).
                    if String::from_utf8_lossy(&out).contains(needle) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    })
    .await
    .expect("reader task")
}

/// AFWD-01: a direct connect with `forward_agent` exposes the local agent's
/// key to the host.
#[tokio::test(flavor = "multi_thread")]
#[serial(ssh_bastion)]
async fn afwd_01_direct_connect_lists_forwarded_key() {
    require_docker!(port_ssh_bastion());
    let _agent = TestAgent::start();

    let listing = remote_ssh_add_list(&bastion_config(true)).await;

    assert_eq!(
        listing.rc,
        Some(0),
        "AFWD-01: ssh-add -l on the bastion should list keys, got: {:?}",
        listing.output
    );
    let fp = agent_key_fingerprint();
    assert!(
        listing.output.contains(&fp),
        "AFWD-01: the forwarded agent should list {fp}, got: {:?}",
        listing.output
    );
}

/// AFWD-02: forwarding reaches a target behind a ProxyJump hop. The agent
/// request rides the session channel to the final target, so the key must be
/// listed there — not merely on the bastion.
#[tokio::test(flavor = "multi_thread")]
#[serial(ssh_bastion)]
async fn afwd_02_proxy_jump_target_lists_forwarded_key() {
    require_docker!(port_ssh_bastion());
    let _agent = TestAgent::start();

    let listing = remote_ssh_add_list(&jumped_target_config(true)).await;

    assert_eq!(
        listing.rc,
        Some(0),
        "AFWD-02: ssh-add -l on the jumped target should list keys, got: {:?}",
        listing.output
    );
    let fp = agent_key_fingerprint();
    assert!(
        listing.output.contains(&fp),
        "AFWD-02: the forwarded agent should list {fp} on the target, got: {:?}",
        listing.output
    );
}

/// AFWD-03: `forward_agent` with no local agent is a graceful no-op: the
/// connect succeeds, the shell runs, and the remote sees no agent (rc 2).
#[tokio::test(flavor = "multi_thread")]
#[serial(ssh_bastion)]
async fn afwd_03_no_local_agent_connects_cleanly() {
    require_docker!(port_ssh_bastion());
    std::env::remove_var("SSH_AUTH_SOCK");

    let listing = remote_ssh_add_list(&jumped_target_config(true)).await;

    assert_eq!(
        listing.rc,
        Some(2),
        "AFWD-03: with no local agent the target must report no agent (rc 2), got: {:?}",
        listing.output
    );
}

/// AFWD-04: a running local agent stays private when `forward_agent` is off.
#[tokio::test(flavor = "multi_thread")]
#[serial(ssh_bastion)]
async fn afwd_04_disabled_forwarding_does_not_expose_agent() {
    require_docker!(port_ssh_bastion());
    let _agent = TestAgent::start();

    let listing = remote_ssh_add_list(&bastion_config(false)).await;

    assert_eq!(
        listing.rc,
        Some(2),
        "AFWD-04: with forwarding off the bastion must see no agent (rc 2), got: {:?}",
        listing.output
    );
    assert!(
        !listing.output.contains(&agent_key_fingerprint()),
        "AFWD-04: the local key leaked with forwarding off: {:?}",
        listing.output
    );
}
