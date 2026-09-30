//! End-to-end test of relayed SSH keyboard-interactive (OTP / 2FA) prompts
//! (#3436, follow-up to #3375).
//!
//! Every hop of the relay has unit coverage with a mock on the far side. This
//! suite drives the **real** chain instead:
//!
//! ```text
//! test (desktop stand-in) ⇄ agent worker (--stdio) ⇄ session daemon ⇄ sshd
//! ```
//!
//! - The "sshd" is core's in-process keyboard-interactive server
//!   (`termihub_core::backends::ssh::ki_test_server`, exposed through the
//!   `ssh-test-support` feature) listening on a loopback TCP port. It asks a
//!   password round, then a one-time-code round — the shape of a PAM stack that
//!   adds an OTP after the password. No Docker, so this runs in per-PR CI.
//! - The worker is the real `termihub-agent --stdio` binary. The SSH connect of
//!   an agent-hosted session happens in a **separate session-daemon process**
//!   the worker spawns, whose prompts reach the worker over the per-session
//!   relay socket and the desktop as `ssh.keyboard_interactive.prompt`.
//!
//! Host-key trust: the daemon checks the server key against
//! `~/.ssh/known_hosts` (no verifier is registered in an agent). Each agent runs
//! with `HOME` pointed at a temp dir whose `known_hosts` trusts only this
//! server's fixed key, which also isolates the agent's config and state from
//! the developer's real ones.
//!
//! Unix only: the daemon, relay and known-hosts plumbing are the same code on
//! Windows, but the Windows leg's live-agent tests are quarantined for runner
//! slowness (#2495); this suite would join them.
//!
//! ```sh
//! cargo test -p termihub-agent --test ki_prompt_integration
//! ```

#![cfg(unix)]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use tempfile::TempDir;
use termihub_core::backends::ssh::ki_test_server::{
    host_public_key_openssh, serve_tcp, PasswordPolicy, Round, Script, TcpServer,
};
use termihub_core::protocol::errors;
use termihub_core::protocol::methods as pm;

mod common;

use common::daemon_reaper::{session_endpoint, DaemonGuard};
use common::parent_death::GuardedSpawn;

/// The saved password the connection carries (auto-answered, never relayed).
const PASSWORD: &str = "hunter2";
/// The one-time code the server accepts.
const GOOD_CODE: &str = "123456";
/// The OTP prompt text — must not look like a password prompt, so core relays
/// it instead of auto-answering it.
const OTP_PROMPT: &str = "Verification code: ";

/// Budget for one step (a response or a notification). Generous: a create
/// spawns a daemon process and runs a full SSH handshake, which can be slow on
/// a loaded runner; a passing run returns as soon as the message arrives.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

/// How often [`wait_until`] re-checks its condition.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Poll `observe` until it returns `want` or [`STEP_TIMEOUT`] passes; panics
/// with the last value seen and `context` on timeout.
///
/// For server-side counters the client gets no acknowledgement for: the
/// value lands on the server's own runtime at some point after the client's
/// message was sent, so reading it once right after is a race (#3999). A
/// passing run returns on the first check that matches.
fn wait_until<T: PartialEq + std::fmt::Debug>(
    what: &str,
    want: T,
    mut observe: impl FnMut() -> T,
    context: impl Fn() -> String,
) {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let seen = observe();
        if seen == want {
            return;
        }
        if Instant::now() >= deadline {
            panic!(
                "{what}: expected {want:?}, still {seen:?} after {STEP_TIMEOUT:?}; {}",
                context()
            );
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

/// Password round (auto-answered from the saved password), then an OTP round.
fn two_factor_script() -> Script {
    Script {
        rounds: vec![
            Round::new(vec![("Password: ", false)], vec![PASSWORD]),
            Round::new(vec![(OTP_PROMPT, false)], vec![GOOD_CODE]),
        ],
        password: PasswordPolicy::Disabled,
    }
}

/// The 2FA server, driven by its own runtime (the agent side is plain
/// blocking process I/O). Field order matters: the server drops before the
/// runtime that drives it.
struct Fixture {
    server: TcpServer,
    _rt: tokio::runtime::Runtime,
}

impl Fixture {
    fn start() -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        let server = rt
            .block_on(serve_tcp(two_factor_script()))
            .expect("start keyboard-interactive server");
        Self { server, _rt: rt }
    }

    fn port(&self) -> u16 {
        self.server.addr.port()
    }

    /// Responses the server received, per round, across all connections.
    fn responses(&self) -> Vec<Vec<String>> {
        self.server.observed.lock().unwrap().responses.clone()
    }

    fn authenticated(&self) -> usize {
        self.server.observed.lock().unwrap().authenticated
    }

    /// Shell requests the server has processed. The SSH backend sends the
    /// shell request without asking for a reply (`want_reply = false`), so
    /// nothing the client sees orders it before this read — wait for it with
    /// [`wait_until`], never assert it directly.
    fn shells(&self) -> usize {
        self.server.observed.lock().unwrap().shells
    }

    /// Settings for an agent `ssh` session to this server.
    fn ssh_config(&self, auth_method: &str) -> Value {
        json!({
            "host": "127.0.0.1",
            "port": self.port(),
            "username": "alice",
            "authMethod": auth_method,
            "password": PASSWORD,
            "enableMonitoring": false,
            "enableFileBrowser": false,
        })
    }
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
    /// Spawn an agent whose `HOME` trusts `fixture`'s host key.
    fn spawn(fixture: &Fixture) -> Self {
        let home = TempDir::new().expect("temp home");
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).expect("create .ssh");
        std::fs::write(
            ssh_dir.join("known_hosts"),
            format!(
                "[127.0.0.1]:{} {}\n",
                fixture.port(),
                host_public_key_openssh()
            ),
        )
        .expect("write known_hosts");
        let stderr = std::fs::File::create(home.path().join("agent.stderr")).expect("stderr file");

        let mut cmd = Command::new(agent_binary());
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

    /// Send a request and return its id.
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

    fn response(&mut self, id: u64) -> Value {
        self.wait_for(&format!("response to request {id}"), |m| {
            m["id"] == json!(id) && m.get("method").is_none()
        })
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.response(id)
    }

    /// `initialize`, advertising the prompt relay or not (an older desktop).
    /// The agent advertises its own relay support either way; what an older
    /// desktop changes is whether the agent may send it prompts.
    fn initialize(&mut self, prompt_capable: bool) {
        let mut params = json!({
            "protocolVersion": "0.23.0",
            "client": "ki-prompt-e2e",
            "clientVersion": "0.0.1",
        });
        if prompt_capable {
            params["clientCapabilities"] = json!({"keyboardInteractivePrompts": true});
        }
        let resp = self.rpc("initialize", params);
        assert_eq!(
            resp["result"]["capabilities"]["keyboardInteractivePrompts"], true,
            "initialize: {resp}"
        );
    }

    /// Start an `ssh` create; returns the request id.
    fn start_create(&mut self, config: Value) -> u64 {
        self.send(
            pm::CONNECTION_CREATE,
            json!({"type": "ssh", "title": "otp-e2e", "config": config}),
        )
    }

    /// Wait for the relayed OTP round and check what the desktop is shown.
    fn expect_otp_prompt(&mut self, port: u16) -> String {
        let prompt = self.wait_for("ssh.keyboard_interactive.prompt", |m| {
            m["method"] == pm::SSH_KEYBOARD_INTERACTIVE_PROMPT
        });
        let p = &prompt["params"];
        assert_eq!(p["host"], "127.0.0.1", "{prompt}");
        assert_eq!(p["port"], json!(port), "{prompt}");
        assert_eq!(p["username"], "alice", "{prompt}");
        assert_eq!(p["prompts"].as_array().map(Vec::len), Some(1), "{prompt}");
        assert_eq!(p["prompts"][0]["prompt"], OTP_PROMPT, "{prompt}");
        assert_eq!(p["prompts"][0]["echo"], false, "{prompt}");
        p["requestId"]
            .as_str()
            .expect("prompt requestId")
            .to_string()
    }

    /// Answer a relayed round (`None` = the user cancelled the dialog).
    fn respond(&mut self, request_id: &str, answer: Option<&str>) {
        let responses = answer.map(|a| json!([a])).unwrap_or(Value::Null);
        let resp = self.rpc(
            pm::SSH_KEYBOARD_INTERACTIVE_RESPOND,
            json!({"requestId": request_id, "responses": responses}),
        );
        assert_eq!(resp["result"]["accepted"], true, "respond: {resp}");
    }

    /// Whether any relayed prompt reached this desktop.
    fn saw_prompt(&self) -> bool {
        self.stash
            .iter()
            .any(|m| m["method"] == pm::SSH_KEYBOARD_INTERACTIVE_PROMPT)
    }
}

impl Drop for StdioAgent {
    fn drop(&mut self) {
        // Kill by the exact PID we spawned; session daemons are reaped by
        // their `DaemonGuard`s (endpoint-verified PIDs) as `daemons` drops.
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The isolated registry lives in `home`; reap it by the PID serving it.
        let registry = self.home.path().join("registry.sock");
        drop(DaemonGuard::discover(&registry.to_string_lossy()));
    }
}

fn decode_output(msg: &Value) -> String {
    let b64 = msg["params"]["data"].as_str().unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// A correct one-time code completes the connect: the session is created, the
/// daemon's SSH session reaches the server's shell, and data round-trips.
#[test]
fn answered_otp_prompt_connects_the_session() {
    let fixture = Fixture::start();
    let mut agent = StdioAgent::spawn(&fixture);
    agent.initialize(true);

    let create = agent.start_create(fixture.ssh_config("password"));
    let request_id = agent.expect_otp_prompt(fixture.port());
    agent.respond(&request_id, Some(GOOD_CODE));

    let resp = agent.response(create);
    let session_id = resp["result"]["session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create failed: {resp}"))
        .to_string();
    if let Some(guard) = DaemonGuard::discover(&session_endpoint(&session_id)) {
        agent.daemons.push(guard);
    }

    // The saved password was auto-answered; only the OTP was relayed.
    assert_eq!(
        fixture.responses(),
        vec![vec![PASSWORD.to_string()], vec![GOOD_CODE.to_string()]]
    );
    assert_eq!(fixture.authenticated(), 1);

    let attach = agent.rpc(pm::CONNECTION_ATTACH, json!({"session_id": session_id}));
    assert!(attach["result"].is_object(), "attach failed: {attach}");
    // The shell request carries no reply, so attach can return before the
    // server has handled it (#3999): wait for the count, bounded.
    wait_until(
        "shell requests the server processed",
        1,
        || fixture.shells(),
        || format!("agent stderr:\n{}", agent.stderr_log()),
    );

    // Round-trip data through the daemon's SSH channel: the server's shell
    // echoes what it receives.
    let marker = "otp-e2e-echo-marker";
    let write = agent.rpc(
        pm::CONNECTION_WRITE,
        json!({
            "session_id": session_id,
            "data": base64::engine::general_purpose::STANDARD.encode(format!("{marker}\n")),
        }),
    );
    assert!(write.get("error").is_none(), "write failed: {write}");
    agent.wait_for("the echoed marker", |m| {
        m["method"] == pm::CONNECTION_OUTPUT && decode_output(m).contains(marker)
    });

    let close = agent.rpc(pm::CONNECTION_CLOSE, json!({"session_id": session_id}));
    assert!(close.get("error").is_none(), "close failed: {close}");
}

/// Dismissing the dialog fails the create with the typed `AUTH_CANCELLED`, and
/// the code is never sent to the server.
#[test]
fn cancelled_otp_prompt_fails_with_auth_cancelled() {
    let fixture = Fixture::start();
    let mut agent = StdioAgent::spawn(&fixture);
    agent.initialize(true);

    let create = agent.start_create(fixture.ssh_config("password"));
    let request_id = agent.expect_otp_prompt(fixture.port());
    agent.respond(&request_id, None);

    let resp = agent.response(create);
    assert_eq!(
        resp["error"]["code"],
        json!(errors::AUTH_CANCELLED),
        "{resp}"
    );
    assert_eq!(fixture.responses(), vec![vec![PASSWORD.to_string()]]);
    assert_eq!(fixture.authenticated(), 0);
}

/// A wrong code after the accepted password is a second-factor failure
/// (`SECOND_FACTOR_FAILED`), not a credential rejection — so the desktop keeps
/// the saved password.
#[test]
fn wrong_otp_code_fails_with_second_factor_failed() {
    let fixture = Fixture::start();
    let mut agent = StdioAgent::spawn(&fixture);
    agent.initialize(true);

    let create = agent.start_create(fixture.ssh_config("password"));
    let request_id = agent.expect_otp_prompt(fixture.port());
    agent.respond(&request_id, Some("000000"));

    let resp = agent.response(create);
    assert_eq!(
        resp["error"]["code"],
        json!(errors::SECOND_FACTOR_FAILED),
        "{resp}"
    );
    assert_eq!(
        fixture.responses(),
        vec![vec![PASSWORD.to_string()], vec!["000000".to_string()]]
    );
    assert_eq!(fixture.authenticated(), 0);
}

/// An older desktop never advertises the prompt relay: the agent must not send
/// it a prompt it cannot show, and a server that insists on an OTP fails the
/// create with the "no prompt is available here" message.
#[test]
fn old_desktop_without_the_capability_gets_no_prompt_and_a_clear_error() {
    let fixture = Fixture::start();
    let mut agent = StdioAgent::spawn(&fixture);
    agent.initialize(false);

    let create = agent.start_create(fixture.ssh_config("keyboard-interactive"));
    let resp = agent.response(create);
    let message = resp["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("no prompt is available here"),
        "expected the no-prompt error, got: {resp}"
    );
    assert!(!agent.saw_prompt(), "an old desktop was sent a prompt");
    // The saved password was still auto-answered; the OTP round was not.
    assert_eq!(fixture.responses(), vec![vec![PASSWORD.to_string()]]);
    assert_eq!(fixture.authenticated(), 0);
}
