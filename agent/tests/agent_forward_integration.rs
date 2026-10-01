//! SSH agent forwarding through a real `termihub-agent` (#1719, #1727) against
//! the `ssh-jumphost-bastion` Docker fixture (#4005).
//!
//! ```text
//! test (desktop stand-in + its ssh-agent) ⇄ termihub-agent ⇄ session daemon ⇄ sshd
//! ```
//!
//! The test plays the desktop: it runs a private `ssh-agent` holding one test
//! key and answers the agent's `agent.forward.open` / `.data` / `.close` relay
//! messages by pumping bytes to that ssh-agent, exactly as the desktop's
//! `terminal/agent_forward.rs` does. The agent opens an SSH session with
//! `forwardAgent` to the bastion and runs `ssh-add -l` there. The key can only
//! be listed if the whole chain worked: sshd's forwarded agent channel → the
//! daemon's core bridge → the per-session relay socket → JSON-RPC → the test's
//! ssh-agent. The agent process runs with `SSH_AUTH_SOCK` removed, so no key on
//! the agent host can stand in for the relayed one.
//!
//! Both transports are covered:
//!
//! - **stdio** — the transport the desktop drives over its SSH exec channel to
//!   a deployed remote agent (#1719). The agent runs on the test host rather
//!   than inside the `remote-agent` container (which needs a cross-compiled
//!   musl build staged into it); the SSH leg to that container only carries
//!   these same stdio bytes.
//! - **TCP `--listen`** (#1727) — no SSH leg at all, so the relay is the only
//!   way the operator's keys can reach the target.
//!
//! For each, a desktop with no ssh-agent must still connect cleanly: it answers
//! `open` with `close`, and the remote shell keeps working with no keys.
//!
//! Unix only (the relay endpoint and the test's ssh-agent are Unix sockets).
//! Skips without the fixture; `TERMIHUB_REQUIRE_DOCKER=1` makes that a failure.
//!
//! ```sh
//! docker compose -f tests/docker/docker-compose.yml up -d ssh-jumphost-bastion
//! cargo test -p termihub-agent --test agent_forward_integration
//! ```

#![cfg(unix)]

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use tempfile::TempDir;
use termihub_core::protocol::methods as pm;

mod common;

use common::daemon_reaper::{session_endpoint, DaemonGuard};
use common::parent_death::GuardedSpawn;

/// Budget for one step. A create spawns a daemon and runs a full SSH
/// handshake, so leave room for a loaded runner.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

/// The key loaded into the desktop's ssh-agent (not the login key).
const AGENT_KEY: &str = "ecdsa_256";

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

fn ssh_keys_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ssh-keys")
}

/// The bastion's host port: `TERMIHUB_TEST_SSH_BASTION_PORT`, else 2204 plus
/// this checkout's `TERMIHUB_TEST_PORT_OFFSET` (same scheme as core/tests).
fn bastion_port() -> u16 {
    if let Some(p) = std::env::var("TERMIHUB_TEST_SSH_BASTION_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return p;
    }
    let offset: u16 = std::env::var("TERMIHUB_TEST_PORT_OFFSET")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    2204 + offset
}

/// Skip (or, under `TERMIHUB_REQUIRE_DOCKER=1`, fail) without the fixture.
fn fixture_available() -> bool {
    let port = bastion_port();
    let reachable = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("socket addr"),
        Duration::from_secs(2),
    )
    .is_ok();
    if reachable {
        return true;
    }
    let required = std::env::var("TERMIHUB_REQUIRE_DOCKER")
        .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
        .unwrap_or(false);
    assert!(
        !required,
        "REQUIRED fixture unavailable: ssh-jumphost-bastion not reachable on port {port} \
         but TERMIHUB_REQUIRE_DOCKER is set"
    );
    eprintln!("SKIPPED: ssh-jumphost-bastion not reachable on port {port}");
    false
}

/// `SHA256:…` fingerprint of [`AGENT_KEY`], as `ssh-add -l` prints it.
fn agent_key_fingerprint() -> String {
    let out = {
        let _fork = common::fork_guard();
        Command::new("ssh-keygen")
            .arg("-lf")
            .arg(ssh_keys_dir().join(format!("{AGENT_KEY}.pub")))
            .output()
            .expect("run ssh-keygen")
    };
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .find(|t| t.starts_with("SHA256:"))
        .expect("fingerprint in ssh-keygen output")
        .to_string()
}

/// The desktop's private `ssh-agent`, killed by PID on drop.
struct DesktopAgent {
    child: Child,
    sock: PathBuf,
    _dir: TempDir,
}

impl DesktopAgent {
    fn start() -> Self {
        let dir = TempDir::new().expect("temp dir for ssh-agent");
        let sock = dir.path().join("agent.sock");
        // `-D` keeps it in the foreground, so `child` is the agent itself.
        let child = {
            let _fork = common::fork_guard();
            Command::new("ssh-agent")
                .arg("-D")
                .arg("-a")
                .arg(&sock)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn_guarded()
                .expect("spawn ssh-agent")
        };
        let agent = DesktopAgent {
            child,
            sock,
            _dir: dir,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !agent.sock.exists() {
            assert!(Instant::now() < deadline, "ssh-agent never made its socket");
            std::thread::sleep(Duration::from_millis(20));
        }
        // ssh-add refuses a group/world-readable key; git does not keep 0600.
        let key = agent._dir.path().join(AGENT_KEY);
        std::fs::copy(ssh_keys_dir().join(AGENT_KEY), &key).expect("copy agent key");
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))
            .expect("chmod agent key");
        let out = {
            let _fork = common::fork_guard();
            Command::new("ssh-add")
                .arg(&key)
                .env("SSH_AUTH_SOCK", &agent.sock)
                .output()
                .expect("run ssh-add")
        };
        assert!(
            out.status.success(),
            "ssh-add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        agent
    }
}

impl Drop for DesktopAgent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Sends JSON-RPC lines to the agent; shared by the test and the relay pump.
#[derive(Clone)]
struct Wire {
    writer: SharedWriter,
    next_id: Arc<AtomicU64>,
}

impl Wire {
    fn request(&self, method: &str, params: Value) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut w = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        // A write after the agent exited is not this test's failure to report.
        let _ = writeln!(w, "{line}").and_then(|()| w.flush());
        id
    }
}

/// Reads every line from the agent, answers the ssh-agent relay itself (the
/// desktop's job) and hands everything else to the test.
fn spawn_pump(
    reader: Box<dyn Read + Send>,
    wire: Wire,
    desktop_agent: Option<PathBuf>,
    to_test: Sender<Value>,
) {
    std::thread::spawn(move || {
        let mut streams: HashMap<String, UnixStream> = HashMap::new();
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let method = msg["method"].as_str().unwrap_or_default();
            let stream_id = msg["params"]["stream_id"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            if method == pm::AGENT_FORWARD_OPEN {
                match desktop_agent.as_ref().map(UnixStream::connect) {
                    Some(Ok(sock)) => {
                        let replies = sock.try_clone().expect("clone agent socket");
                        streams.insert(stream_id.clone(), sock);
                        relay_replies(replies, stream_id, wire.clone());
                    }
                    // No desktop agent: refuse the stream, like the desktop.
                    _ => {
                        wire.request(pm::AGENT_FORWARD_CLOSE, json!({"stream_id": stream_id}));
                    }
                }
            } else if method == pm::AGENT_FORWARD_DATA && msg.get("id").is_none() {
                let data = B64
                    .decode(msg["params"]["data"].as_str().unwrap_or_default())
                    .unwrap_or_default();
                if let Some(sock) = streams.get_mut(&stream_id) {
                    let _ = sock.write_all(&data);
                }
            } else if method == pm::AGENT_FORWARD_CLOSE && msg.get("id").is_none() {
                if let Some(sock) = streams.remove(&stream_id) {
                    let _ = sock.shutdown(Shutdown::Both);
                }
            } else if to_test.send(msg).is_err() {
                break;
            }
        }
    });
}

/// Pump the desktop ssh-agent's replies on one stream back to the agent.
fn relay_replies(mut sock: UnixStream, stream_id: String, wire: Wire) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match sock.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    wire.request(
                        pm::AGENT_FORWARD_DATA,
                        json!({"stream_id": stream_id, "data": B64.encode(&buf[..n])}),
                    );
                }
            }
        }
        wire.request(pm::AGENT_FORWARD_CLOSE, json!({"stream_id": stream_id}));
    });
}

/// Which transport the test desktop talks to the agent over.
#[derive(Clone, Copy, Debug)]
enum Transport {
    Stdio,
    Tcp,
}

/// A real `termihub-agent` driven by the test desktop.
struct Desktop {
    child: Child,
    wire: Wire,
    msgs: Receiver<Value>,
    stash: VecDeque<Value>,
    home: TempDir,
    daemons: Vec<DaemonGuard>,
}

impl Desktop {
    fn spawn(transport: Transport, desktop_agent: Option<&DesktopAgent>) -> Self {
        let home = TempDir::new().expect("temp home");
        trust_bastion_host_key(home.path());
        let stderr_path = home.path().join("agent.stderr");
        let stderr = std::fs::File::create(&stderr_path).expect("stderr file");

        let mut cmd = Command::new(agent_binary());
        match transport {
            Transport::Stdio => cmd.arg("--stdio"),
            Transport::Tcp => cmd.arg("--listen").arg("127.0.0.1:0"),
        };
        cmd.env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path().join(".config"))
            .env("XDG_DATA_HOME", home.path().join(".local/share"))
            .env("XDG_STATE_HOME", home.path().join(".local/state"))
            .envs(common::isolated_registry_env(home.path()))
            // No ssh-agent on the agent host: only the relay can supply keys.
            .env_remove("SSH_AUTH_SOCK")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        let mut child = {
            let _fork = common::fork_guard();
            cmd.spawn_guarded().expect("spawn agent")
        };

        let (reader, writer): (Box<dyn Read + Send>, Box<dyn Write + Send>) = match transport {
            Transport::Stdio => (
                Box::new(child.stdout.take().expect("piped stdout")),
                Box::new(child.stdin.take().expect("piped stdin")),
            ),
            Transport::Tcp => {
                let addr = common::wait_for_listen_addr(&stderr_path, 0, STEP_TIMEOUT)
                    .unwrap_or_else(|| {
                        panic!(
                            "agent never announced its listener; stderr:\n{}",
                            std::fs::read_to_string(&stderr_path).unwrap_or_default()
                        )
                    });
                let mut stream = TcpStream::connect(&addr).expect("connect to agent");
                let token = common::read_listen_token(&home.path().join(".config"));
                common::authenticate_raw(&mut stream, &token);
                (
                    Box::new(stream.try_clone().expect("clone tcp stream")),
                    Box::new(stream),
                )
            }
        };

        let wire = Wire {
            writer: Arc::new(Mutex::new(writer)),
            next_id: Arc::new(AtomicU64::new(1)),
        };
        let (tx, msgs) = mpsc::channel();
        spawn_pump(
            reader,
            wire.clone(),
            desktop_agent.map(|a| a.sock.clone()),
            tx,
        );
        Self {
            child,
            wire,
            msgs,
            stash: VecDeque::new(),
            home,
            daemons: Vec::new(),
        }
    }

    fn stderr_log(&self) -> String {
        std::fs::read_to_string(self.home.path().join("agent.stderr")).unwrap_or_default()
    }

    /// The first message (stashed or new) matching `pred`; others are stashed.
    fn wait_for(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(pos) = self.stash.iter().position(&pred) {
            return self.stash.remove(pos).expect("stashed message");
        }
        let deadline = Instant::now() + STEP_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.msgs.recv_timeout(left) {
                Ok(msg) if pred(&msg) => return msg,
                Ok(msg) => self.stash.push_back(msg),
                Err(e) => panic!(
                    "no {what} from the agent ({e}); agent stderr:\n{}",
                    self.stderr_log()
                ),
            }
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.wire.request(method, params);
        self.wait_for(&format!("response to {method}"), |m| {
            m["id"] == json!(id) && m.get("method").is_none()
        })
    }

    /// Create an SSH session with `forwardAgent` on the bastion and attach.
    fn open_forwarding_session(&mut self) -> String {
        let init = self.rpc(
            "initialize",
            json!({
                "protocolVersion": "0.23.0",
                "client": "agent-forward-e2e",
                "clientVersion": "0.0.1",
            }),
        );
        assert!(init["result"].is_object(), "initialize failed: {init}");

        let key = ssh_keys_dir().join("ed25519");
        let create = self.rpc(
            pm::CONNECTION_CREATE,
            json!({
                "type": "ssh",
                "title": "agent-forward-e2e",
                "config": {
                    "host": "127.0.0.1",
                    "port": bastion_port(),
                    "username": "testuser",
                    "authMethod": "key",
                    "keyPath": key.to_string_lossy(),
                    "forwardAgent": true,
                    "enableMonitoring": false,
                    "enableFileBrowser": false,
                },
            }),
        );
        let session_id = create["result"]["session_id"]
            .as_str()
            .unwrap_or_else(|| {
                panic!(
                    "create failed: {create}; agent stderr:\n{}",
                    self.stderr_log()
                )
            })
            .to_string();
        if let Some(guard) = DaemonGuard::discover(&session_endpoint(&session_id)) {
            self.daemons.push(guard);
        }
        let attach = self.rpc(pm::CONNECTION_ATTACH, json!({"session_id": session_id}));
        assert!(attach["result"].is_object(), "attach failed: {attach}");
        session_id
    }

    /// Run `ssh-add -l` in the session; returns everything printed up to the
    /// end marker and the command's exit code.
    fn remote_ssh_add_list(&mut self, session_id: &str) -> (String, Option<u32>) {
        // The marker is split in the command so the echoed input cannot match.
        let cmd = "ssh-add -l; echo \"TH_RC=$?\" \"TH_\"\"END\"\n";
        let write = self.rpc(
            pm::CONNECTION_WRITE,
            json!({"session_id": session_id, "data": B64.encode(cmd)}),
        );
        assert!(write.get("error").is_none(), "write failed: {write}");

        let mut output = String::new();
        while !output.contains("TH_END") {
            let msg = self.wait_for("shell output with the end marker", |m| {
                m["method"] == pm::CONNECTION_OUTPUT && m["params"]["session_id"] == session_id
            });
            let bytes = B64
                .decode(msg["params"]["data"].as_str().unwrap_or_default())
                .unwrap_or_default();
            output.push_str(&String::from_utf8_lossy(&bytes));
        }
        let rc = output
            .split("TH_RC=")
            .skip(1)
            .filter_map(|rest| {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .last();
        (output, rc)
    }

    fn close(&mut self, session_id: &str) {
        let close = self.rpc(pm::CONNECTION_CLOSE, json!({"session_id": session_id}));
        assert!(close.get("error").is_none(), "close failed: {close}");
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        // Kill by the exact PID we spawned; daemons are reaped by their
        // endpoint-verified `DaemonGuard`s as `daemons` drops.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let registry = self.home.path().join("registry.sock");
        drop(DaemonGuard::discover(&registry.to_string_lossy()));
    }
}

/// Record the bastion's host keys in `home`'s `known_hosts`: an agent has no
/// host-key verifier of its own and refuses an unknown server.
fn trust_bastion_host_key(home: &Path) {
    let out = {
        let _fork = common::fork_guard();
        Command::new("ssh-keyscan")
            .args(["-p", &bastion_port().to_string(), "127.0.0.1"])
            .stderr(Stdio::null())
            .output()
            .expect("run ssh-keyscan")
    };
    assert!(
        !out.stdout.is_empty(),
        "ssh-keyscan returned no host keys for the bastion"
    );
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).expect("create .ssh");
    std::fs::write(ssh_dir.join("known_hosts"), &out.stdout).expect("write known_hosts");
}

/// With a desktop ssh-agent, the bastion lists the desktop's key.
fn forwards_desktop_key(transport: Transport) {
    if !fixture_available() {
        return;
    }
    let agent = DesktopAgent::start();
    let mut desktop = Desktop::spawn(transport, Some(&agent));
    let session = desktop.open_forwarding_session();

    let (output, rc) = desktop.remote_ssh_add_list(&session);

    assert_eq!(
        rc,
        Some(0),
        "{transport:?}: ssh-add -l should list the relayed keys, got: {output:?}"
    );
    let fp = agent_key_fingerprint();
    assert!(
        output.contains(&fp),
        "{transport:?}: the desktop key {fp} should reach the target, got: {output:?}"
    );
    desktop.close(&session);
}

/// With no desktop ssh-agent, the session still connects and the shell runs;
/// the target just sees an agent with no keys to offer.
fn no_desktop_agent_is_a_clean_no_op(transport: Transport) {
    if !fixture_available() {
        return;
    }
    let mut desktop = Desktop::spawn(transport, None);
    let session = desktop.open_forwarding_session();

    let (output, rc) = desktop.remote_ssh_add_list(&session);

    assert!(
        matches!(rc, Some(rc) if rc != 0),
        "{transport:?}: with no desktop agent ssh-add -l must fail, got: {output:?}"
    );
    assert!(
        !output.contains(&agent_key_fingerprint()),
        "{transport:?}: no key can be listed without a desktop agent: {output:?}"
    );
    desktop.close(&session);
}

/// #1719: forwarding through an agent the desktop reaches over stdio.
#[test]
fn stdio_agent_forwards_desktop_key_to_target() {
    forwards_desktop_key(Transport::Stdio);
}

/// #1719: no desktop agent over stdio is a clean no-op.
#[test]
fn stdio_agent_without_desktop_agent_connects_cleanly() {
    no_desktop_agent_is_a_clean_no_op(Transport::Stdio);
}

/// #1727: forwarding over the TCP `--listen` transport.
#[test]
fn tcp_agent_forwards_desktop_key_to_target() {
    forwards_desktop_key(Transport::Tcp);
}

/// #1727: no desktop agent over TCP is a clean no-op.
#[test]
fn tcp_agent_without_desktop_agent_connects_cleanly() {
    no_desktop_agent_is_a_clean_no_op(Transport::Tcp);
}
