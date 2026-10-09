//! Files-only SSH sessions hosted on an agent (#4081), against the Docker
//! `ssh-sftp-only` fixture (`ForceCommand internal-sftp`).
//!
//! Drives the real chain:
//!
//! ```text
//! test (desktop stand-in) ⇄ agent worker (--stdio) ⇄ session daemon ⇄ sshd
//! ```
//!
//! The host refuses the shell but serves SFTP. The session daemon's SSH backend
//! keeps the session up files-only, and the desktop must hear it as a
//! `connection.filesOnly` notification — on create and again on a later attach
//! — while `connection.files.*` keep working on the session id.
//!
//! The daemon checks the host key against `~/.ssh/known_hosts`, so each agent
//! runs with `HOME` pointed at a temp dir whose `known_hosts` holds the
//! fixture's key (read with `ssh-keyscan`).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d
//! ssh-sftp-only` (ports offset by `TERMIHUB_TEST_PORT_OFFSET`). Skips when it is
//! not reachable, unless `TERMIHUB_REQUIRE_DOCKER=1`.
//!
//! ```sh
//! cargo test -p termihub-agent --test ssh_files_only_integration
//! ```

#![cfg(unix)]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::TempDir;
use termihub_core::protocol::methods as pm;
use termihub_core::test_fixtures;

mod common;

use common::daemon_reaper::{session_endpoint, DaemonGuard};
use common::parent_death::GuardedSpawn;

/// Budget for one step: a create spawns a daemon and runs an SSH handshake,
/// and files-only then waits for the SFTP probe.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

/// The `ssh-sftp-only` fixture's port, honouring this checkout's test-port
/// offset (see `docs/testing.md` → "Parallel test isolation").
fn port_ssh_sftp_only() -> u16 {
    test_fixtures::fixture_port("TERMIHUB_TEST_SSH_SFTP_ONLY_PORT", 2215)
}

/// Whether the fixture is up; panics instead of skipping when it is required.
fn fixture_available(port: u16) -> bool {
    let reachable = ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok());
    test_fixtures::require(
        reachable,
        test_fixtures::REQUIRE_DOCKER_ENV,
        &format!("ssh-sftp-only fixture not reachable on 127.0.0.1:{port}"),
        "start with: cd tests/docker && docker compose up -d ssh-sftp-only",
    )
}

/// The fixture's host keys as `known_hosts` lines.
fn known_hosts_for(port: u16) -> String {
    let out = Command::new("ssh-keyscan")
        .args(["-p", &port.to_string(), "-T", "10", "127.0.0.1"])
        .stderr(Stdio::null())
        .output()
        .expect("run ssh-keyscan");
    let keys = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        !keys.trim().is_empty(),
        "ssh-keyscan returned no host key for 127.0.0.1:{port}"
    );
    keys
}

/// A real `termihub-agent --stdio` worker playing against a test "desktop".
struct StdioAgent {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    /// Messages read while waiting for something else, in arrival order.
    stash: VecDeque<Value>,
    next_id: u64,
    home: TempDir,
    /// Session daemons to reap if a test fails before closing them.
    daemons: Vec<DaemonGuard>,
}

impl StdioAgent {
    fn spawn(known_hosts: &str) -> Self {
        let home = TempDir::new().expect("temp home");
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).expect("create .ssh");
        std::fs::write(ssh_dir.join("known_hosts"), known_hosts).expect("write known_hosts");
        let stderr = std::fs::File::create(home.path().join("agent.stderr")).expect("stderr file");

        let mut cmd = Command::new(env!("CARGO_BIN_EXE_termihub-agent"));
        cmd.arg("--stdio")
            .env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path().join(".config"))
            .env("XDG_DATA_HOME", home.path().join(".local/share"))
            .env("XDG_STATE_HOME", home.path().join(".local/state"))
            .envs(common::isolated_registry_env(home.path()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        let mut child = {
            let _fork = common::fork_guard();
            cmd.spawn_guarded().expect("spawn agent")
        };
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
            stash: VecDeque::new(),
            next_id: 1,
            home,
            daemons: Vec::new(),
        }
    }

    fn stderr_log(&self) -> String {
        std::fs::read_to_string(self.home.path().join("agent.stderr")).unwrap_or_default()
    }

    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{line}").expect("write to agent");
        self.stdin.flush().expect("flush agent stdin");
        id
    }

    /// The first message (stashed or new) matching `pred`; others are stashed.
    fn wait_for(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(pos) = self.stash.iter().position(&pred) {
            return self.stash.remove(pos).expect("stashed message");
        }
        let deadline = Instant::now() + STEP_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = match self.lines.recv_timeout(left) {
                Ok(line) => line,
                Err(e) => panic!(
                    "no {what} from the agent ({e}); agent stderr:\n{}",
                    self.stderr_log()
                ),
            };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if pred(&msg) {
                return msg;
            }
            self.stash.push_back(msg);
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.wait_for(&format!("response to {method}"), |m| {
            m["id"] == json!(id) && m.get("method").is_none()
        })
    }

    fn expect_files_only(&mut self, session_id: &str) {
        let n = self.wait_for("connection.filesOnly", |m| {
            m["method"] == pm::CONNECTION_FILES_ONLY && m["params"]["session_id"] == session_id
        });
        assert_eq!(n["params"]["session_id"], session_id, "{n}");
    }
}

impl Drop for StdioAgent {
    fn drop(&mut self) {
        // Kill by the exact PID we spawned; session daemons are reaped by
        // their `DaemonGuard`s (endpoint-verified PIDs) as `daemons` drops.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let registry = self.home.path().join("registry.sock");
        drop(DaemonGuard::discover(&registry.to_string_lossy()));
    }
}

#[test]
fn sftp_only_host_through_an_agent_is_files_only() {
    let port = port_ssh_sftp_only();
    if !fixture_available(port) {
        return;
    }
    let mut agent = StdioAgent::spawn(&known_hosts_for(port));
    let init = agent.rpc(
        pm::INITIALIZE,
        json!({
            "protocolVersion": "0.24.0",
            "client": "files-only-e2e",
            "clientVersion": "0.0.1",
        }),
    );
    assert!(init["result"].is_object(), "initialize: {init}");

    let created = agent.rpc(
        pm::CONNECTION_CREATE,
        json!({
            "type": "ssh",
            "title": "sftp-only",
            "config": {
                "host": "127.0.0.1",
                "port": port,
                "username": "testuser",
                "authMethod": "password",
                "password": "testpass",
                "shellIntegration": false,
                "enableMonitoring": false,
            },
        }),
    );
    let session_id = created["result"]["session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create failed: {created}"))
        .to_string();
    if let Some(guard) = DaemonGuard::discover(&session_endpoint(&session_id)) {
        agent.daemons.push(guard);
    }

    // The refused shell settles files-only, and the desktop hears it.
    agent.expect_files_only(&session_id);

    // Attaching (as the desktop does after create, or after a transport break)
    // repeats the verdict, and the session is still alive.
    let attach = agent.rpc(pm::CONNECTION_ATTACH, json!({"session_id": session_id}));
    assert!(attach["result"].is_object(), "attach failed: {attach}");
    agent.expect_files_only(&session_id);
    assert!(
        !agent
            .stash
            .iter()
            .any(|m| m["method"] == pm::CONNECTION_EXIT && m["params"]["session_id"] == session_id),
        "a files-only session must not exit"
    );

    // Files work on the session id, through the daemon's SFTP browser.
    let listed = agent.rpc(
        pm::CONNECTION_FILES_LIST,
        json!({"connection_id": session_id, "path": "/etc"}),
    );
    let entries = listed["result"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("files.list failed: {listed}"));
    assert!(
        entries.iter().any(|e| e["name"] == "hostname"),
        "listing /etc on the sftp-only host must show hostname: {listed}"
    );

    let closed = agent.rpc(pm::CONNECTION_CLOSE, json!({"session_id": session_id}));
    assert!(closed["result"].is_object(), "close failed: {closed}");
}
