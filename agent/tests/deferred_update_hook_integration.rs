//! Live-agent integration test for the **env-gated pending-update test hook**
//! (#1546) — the enabling infrastructure for the deferred-update E2E in #1519 /
//! #1520.
//!
//! ## What this proves
//!
//! The desktop's update banner decides "applied now" vs "deferred (busy)" from
//! what the *agent* answers, and the agent answers from an in-memory
//! `pending_update` that a live agent never holds under test — `state.json` is
//! read once at startup, the only runtime seeder is `#[cfg(test)]`, a staged
//! update is never replayed on attach, and the genuine signal arrives only from
//! a 24-hour timer. So the deferred path was unreachable from a system test.
//!
//! These cases assert the hook closes exactly that gap against a **real child
//! `termihub-agent --listen` process**:
//!
//! 1. Armed, the agent sends `agent.update_available` **on attach** — and again
//!    to the *next* client to attach, since a test may reconnect.
//! 2. Armed and **busy**, `agent.request_deferred_update` reports
//!    `applied: false` with the active-session count: the banner's deferred
//!    branch, driven live for the first time.
//! 3. **Unarmed**, none of it happens: no notification, and the same call fails
//!    with "no pending update". This is the production path, and it is the case
//!    that matters most here — a test hook that leaks into a shipped agent would
//!    be worse than no hook at all.
//!
//! ## Why this is a separate suite from `self_update_integration.rs`
//!
//! That suite exercises the *self-update* cycle: a `wiremock` GitHub server, a
//! real download + SHA-256 verify, and a genuine binary-swap + re-exec, all
//! behind `--allow-self-update`. The hook under test here deliberately shares
//! none of it — no network, no timer, no swap — so it needs none of that
//! machinery, and a much smaller harness says so more clearly than a flag
//! threaded through the larger one.
//!
//! The agent still runs from a throwaway **copy** of the built binary. Nothing
//! here should ever swap it (see below), and the copy is what makes that a
//! checked expectation rather than a hope: a regression that did apply would
//! clobber the copy, not cargo's build artifact.
//!
//! ## The staged binary is never applied
//!
//! A `pending_update` is live: the last-session-disconnect hook tries to apply
//! it. The hook's default staged path does not exist, so an apply that does fire
//! fails harmlessly and — per #1401 — keeps the record. `close_session` in the
//! busy case takes the agent to zero sessions and therefore fires exactly that
//! path; `deferred_hook_does_not_swap_the_agent_binary` pins the outcome by
//! inode.
//!
//! Unix-only, matching `self_update_integration.rs`: the apply path this hook
//! deliberately fails is Unix-only, so the guarantee is only meaningful here.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::TempDir;

/// The hook's gate and its binary override — mirrored from
/// `agent/src/update/test_hook.rs`.
const HOOK_ENV: &str = "TERMIHUB_AGENT_TEST_PENDING_UPDATE";

/// Version the hook advertises for a plain truthy gate. Mirrors
/// `test_hook::DEFAULT_VERSION`.
const HOOK_DEFAULT_VERSION: &str = "99.99.99";

/// How long to wait for a notification, or for the agent to log its bind.
/// Generous: CI hosts are slow and this suite has no timing-sensitive assertion
/// to protect.
const TIMEOUT: Duration = Duration::from_secs(15);

/// Overall budget for connecting and completing the `initialize` handshake.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Per-attempt read budget for the handshake — deliberately far below
/// [`CONNECT_TIMEOUT`] so a slow start costs a retry, not the whole run. See
/// [`Client::connect`].
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

fn agent_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_termihub-agent"))
}

fn inode(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.ino())
}

// ── Live agent process ──────────────────────────────────────────────────────

/// A running `termihub-agent --listen` child with an isolated `XDG_CONFIG_HOME`,
/// optionally armed with the #1546 hook.
struct LiveAgent {
    child: Child,
    /// The address the agent actually bound, read back from its log.
    addr: String,
    bin_path: PathBuf,
    stderr_path: PathBuf,
    _install_dir: TempDir,
    config_home: TempDir,
}

impl Drop for LiveAgent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LiveAgent {
    /// Spawn an agent with the hook armed to `gate`, or unarmed when `None`.
    ///
    /// Note what is *not* passed: no `--allow-self-update`, so the 24h timer is
    /// never spawned and nothing here touches the network. Any pending update the
    /// agent holds came from the hook and nowhere else.
    ///
    /// The agent binds port **0** and we read the port it actually got back out
    /// of its log. The obvious alternative — bind `:0` in the test, note the
    /// port, drop the listener, hand the number to the agent — leaves a window
    /// in which a sibling test (these run in parallel) can be handed the very
    /// same port and win the re-bind, killing this agent at startup. Letting the
    /// OS assign the port to the process that keeps it closes that window.
    fn spawn(gate: Option<&str>) -> Self {
        let install_dir = TempDir::new().expect("install dir");
        let bin_path = install_dir.path().join("termihub-agent");
        std::fs::copy(agent_binary(), &bin_path).expect("copy agent binary");
        std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod agent copy");

        let config_home = TempDir::new().expect("config home");

        let stderr_file = tempfile::NamedTempFile::new().expect("stderr file");
        let stderr_path = stderr_file.path().to_path_buf();
        let (stderr_handle, _keep) = stderr_file.keep().expect("persist stderr file");

        let mut cmd = Command::new(&bin_path);
        cmd.arg("--listen")
            .arg("127.0.0.1:0")
            .env("XDG_CONFIG_HOME", config_home.path())
            // Pin the log level the port is parsed from, so a developer with
            // RUST_LOG exported cannot silence it.
            .env("RUST_LOG", "info")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_handle));
        match gate {
            Some(value) => {
                cmd.env(HOOK_ENV, value);
            }
            // Explicitly cleared, not merely unset: the suite must not pass just
            // because the developer running it happens to have the var exported.
            None => {
                cmd.env_remove(HOOK_ENV);
            }
        }

        let child = cmd.spawn().expect("spawn agent process");
        let addr = read_listen_addr(&stderr_path);
        LiveAgent {
            child,
            addr,
            bin_path,
            stderr_path,
            _install_dir: install_dir,
            config_home,
        }
    }

    fn state_json_path(&self) -> PathBuf {
        self.config_home
            .path()
            .join("termihub-agent")
            .join("state.json")
    }

    /// The agent's captured log. Included in connect/notification failures —
    /// without it a stuck agent is just a timeout with no story.
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    /// The agent's persisted `state.json`, or `Null` before it is first written.
    fn state(&self) -> Value {
        match std::fs::read_to_string(self.state_json_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    }
}

/// Wait for the agent's `Listening on <addr>` log line and return that address.
///
/// Panics with the captured log on timeout — an agent that never announced a
/// bind either died at startup or changed this line, and both are worth seeing.
fn read_listen_addr(stderr_path: &Path) -> String {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        let log = std::fs::read_to_string(stderr_path).unwrap_or_default();
        if let Some(addr) = log
            .lines()
            .find_map(|line| line.split("Listening on ").nth(1))
        {
            return addr.trim().to_string();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let log = std::fs::read_to_string(stderr_path).unwrap_or_default();
    panic!("agent never logged a listen address within {TIMEOUT:?}. stderr:\n{log}");
}

// ── Minimal NDJSON JSON-RPC client ──────────────────────────────────────────

struct Client {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: i64,
    /// Notifications seen while waiting for an RPC response. The hook's
    /// `agent.update_available` races the `initialize` reply, so it must be
    /// buffered rather than dropped on the floor.
    notifications: Vec<Value>,
}

impl Client {
    /// Connect and complete the `initialize` handshake, retrying until the agent
    /// answers or [`CONNECT_TIMEOUT`] elapses.
    ///
    /// The handshake read uses the short [`HANDSHAKE_TIMEOUT`], not the full
    /// budget: the agent binds (and logs the address `spawn` waits for) *before*
    /// it finishes starting up, so a client can connect and be left waiting
    /// while the agent is still initialising. Giving one read the whole deadline
    /// turns that ordinary slowness into a hard failure with no retry left —
    /// which is exactly how this suite failed under a loaded host. A short read
    /// plus a fresh attempt rides it out; the socket is dropped and remade each
    /// time, so no half-finished handshake is reused.
    fn connect(agent: &LiveAgent) -> Client {
        let addr = &agent.addr;
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(stream) = TcpStream::connect(addr) {
                stream
                    .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
                    .expect("set read timeout");
                let writer = stream.try_clone().expect("clone stream");
                let mut client = Client {
                    reader: BufReader::new(stream),
                    writer,
                    next_id: 1,
                    notifications: Vec::new(),
                };
                let resp = client.rpc(
                    "initialize",
                    json!({"protocolVersion": "0.3.0", "client": "hook-it", "clientVersion": "0.1.0"}),
                );
                if resp.get("result").is_some() {
                    // Handshake done; give later reads the full budget, since a
                    // notification may legitimately take a moment to arrive.
                    client
                        .reader
                        .get_ref()
                        .set_read_timeout(Some(TIMEOUT))
                        .expect("set read timeout");
                    return client;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "agent at {addr} never completed a handshake within {CONNECT_TIMEOUT:?}. stderr:\n{}",
            agent.stderr()
        );
    }

    /// Send an RPC and return its response, buffering any notification seen on
    /// the way.
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.writer, "{req}").expect("write request");
        self.writer.flush().expect("flush");

        loop {
            let Some(msg) = self.read_message() else {
                return Value::Null;
            };
            if msg.get("id").and_then(Value::as_i64) == Some(id) {
                return msg;
            }
            self.buffer_notification(msg);
        }
    }

    /// Read one NDJSON message, or `None` on close/timeout/garbage.
    fn read_message(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(line.trim()).ok(),
        }
    }

    fn buffer_notification(&mut self, msg: Value) {
        if msg.get("method").is_some() && msg.get("id").is_none() {
            self.notifications.push(msg);
        }
    }

    /// Wait for a notification with `method`, returning its `params`.
    ///
    /// Checks what was already buffered by `initialize` first — on a fast agent
    /// the hook's notification arrives before the handshake reply.
    fn wait_for_notification(&mut self, method: &str) -> Option<Value> {
        if let Some(found) = self.take_buffered(method) {
            return Some(found);
        }
        let deadline = Instant::now() + TIMEOUT;
        while Instant::now() < deadline {
            let Some(msg) = self.read_message() else {
                return None;
            };
            self.buffer_notification(msg);
            if let Some(found) = self.take_buffered(method) {
                return Some(found);
            }
        }
        None
    }

    fn take_buffered(&mut self, method: &str) -> Option<Value> {
        let idx = self
            .notifications
            .iter()
            .position(|n| n.get("method").and_then(Value::as_str) == Some(method))?;
        Some(self.notifications.remove(idx)["params"].clone())
    }

    fn create_shell_session(&mut self) -> String {
        let resp = self.rpc(
            "connection.create",
            json!({"type": "shell", "config": {}, "title": "hook-test"}),
        );
        resp["result"]["session_id"]
            .as_str()
            .unwrap_or_else(|| panic!("connection.create failed: {resp}"))
            .to_string()
    }

    fn close_session(&mut self, session_id: &str) {
        self.rpc("connection.close", json!({"session_id": session_id}));
    }

    /// Ask the agent to apply the update it is holding — the banner's
    /// "Apply Now".
    fn request_deferred_update(&mut self) -> Value {
        self.rpc("agent.request_deferred_update", json!({}))
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

/// Armed, the agent announces the staged update to a client the moment it
/// attaches — the notification the desktop's banner listens for, which a live
/// agent otherwise never sends without the 24h timer.
#[test]
fn armed_hook_notifies_the_client_on_attach() {
    let agent = LiveAgent::spawn(Some("1"));
    let mut client = Client::connect(&agent);

    let params = client
        .wait_for_notification("agent.update_available")
        .expect("armed agent must announce its staged update on attach");

    assert_eq!(params["availableVersion"], HOOK_DEFAULT_VERSION);
    assert_eq!(
        params["staged"], true,
        "the update is staged, which is what makes Apply Now reach the deferred path"
    );
    assert!(
        params["currentVersion"]
            .as_str()
            .is_some_and(|v| !v.is_empty()),
        "the notification must carry the agent's real running version: {params}"
    );

    // The record really is in the agent's state, not just on the wire.
    assert_eq!(
        agent.state()["update"]["pending_update"]["version"],
        HOOK_DEFAULT_VERSION
    );
}

/// An explicit gate value is advertised verbatim, so a test can pin the version
/// the banner displays.
#[test]
fn armed_hook_advertises_an_explicit_version() {
    let agent = LiveAgent::spawn(Some("1.2.3"));
    let mut client = Client::connect(&agent);

    let params = client
        .wait_for_notification("agent.update_available")
        .expect("armed agent must announce on attach");
    assert_eq!(params["availableVersion"], "1.2.3");
}

/// The notification is sent to **every** client that attaches, not just the
/// first — a test that reconnects (or a desktop that drops and comes back) must
/// still see the banner.
#[test]
fn armed_hook_notifies_each_client_that_attaches() {
    let agent = LiveAgent::spawn(Some("1"));

    {
        let mut first = Client::connect(&agent);
        first
            .wait_for_notification("agent.update_available")
            .expect("first client must be notified");
    } // dropped: the agent sees the client disconnect

    let mut second = Client::connect(&agent);
    let params = second
        .wait_for_notification("agent.update_available")
        .expect("a re-attaching client must be notified again");
    assert_eq!(params["availableVersion"], HOOK_DEFAULT_VERSION);
}

/// **The point of #1546.** With the hook armed and a session open, "Apply Now"
/// takes the deferred branch and reports the active-session count — the banner's
/// busy path, reachable live for the first time.
#[test]
fn armed_hook_makes_the_deferred_busy_path_reachable() {
    let agent = LiveAgent::spawn(Some("1"));
    let mut client = Client::connect(&agent);
    client
        .wait_for_notification("agent.update_available")
        .expect("armed agent must announce on attach");

    let session_id = client.create_shell_session();

    let resp = client.request_deferred_update();
    let result = &resp["result"];
    assert_eq!(
        result["applied"], false,
        "a busy agent must defer, never apply: {resp}"
    );
    assert_eq!(
        result["activeSessions"], 1,
        "the deferred response must report the sessions holding it up: {resp}"
    );

    client.close_session(&session_id);
}

/// The hook must not put the agent at risk of a real binary swap: the default
/// staged path does not exist, so the apply fired by the last session closing
/// fails and the agent keeps running the binary it started with (and keeps the
/// record, per #1401).
#[test]
fn deferred_hook_does_not_swap_the_agent_binary() {
    let agent = LiveAgent::spawn(Some("1"));
    let inode_before = inode(&agent.bin_path).expect("binary present at start");

    let mut client = Client::connect(&agent);
    client
        .wait_for_notification("agent.update_available")
        .expect("armed agent must announce on attach");

    // Open and close a session: closing the last one is what fires the
    // deferred-apply hook.
    let session_id = client.create_shell_session();
    client.close_session(&session_id);

    // The agent is still there and still answering on the same connection —
    // i.e. it did not re-exec.
    let resp = client.rpc("connection.list", json!({}));
    assert!(
        resp.get("result").is_some(),
        "the agent must survive an apply against the non-existent staged path: {resp}"
    );
    assert_eq!(
        inode(&agent.bin_path),
        Some(inode_before),
        "the agent binary must not be swapped by the test hook"
    );
    // #1401: a failed apply keeps the record for a later retry.
    assert_eq!(
        agent.state()["update"]["pending_update"]["version"],
        HOOK_DEFAULT_VERSION,
        "a failed apply must keep the pending update"
    );
}

/// **Production path.** Unarmed, the agent holds no pending update, announces
/// nothing, and rejects an apply — every observable of the hook is absent.
#[test]
fn unarmed_agent_has_no_pending_update_and_never_notifies() {
    let agent = LiveAgent::spawn(None);
    let mut client = Client::connect(&agent);

    // A round-trip the agent must answer, so "no notification" means the agent
    // was up and chose not to send one — not that we asked too early.
    let resp = client.rpc("connection.list", json!({}));
    assert!(resp.get("result").is_some(), "agent must be responsive");
    assert!(
        client.take_buffered("agent.update_available").is_none(),
        "an unarmed agent must never announce an update"
    );

    let resp = client.request_deferred_update();
    assert!(
        resp["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("No pending update")),
        "an unarmed agent must hold nothing to apply: {resp}"
    );

    let state = agent.state();
    assert!(
        state["update"]["pending_update"].is_null(),
        "an unarmed agent must not stage anything: {state}"
    );
}

/// A falsy gate is the same as no gate — so a harness can pass the variable
/// through unconditionally and switch the hook with its value.
#[test]
fn falsy_gate_leaves_the_agent_unarmed() {
    let agent = LiveAgent::spawn(Some("0"));
    let mut client = Client::connect(&agent);

    let resp = client.rpc("connection.list", json!({}));
    assert!(resp.get("result").is_some(), "agent must be responsive");
    assert!(
        client.take_buffered("agent.update_available").is_none(),
        "a falsy gate must leave the hook disarmed"
    );
    assert!(agent.state()["update"]["pending_update"].is_null());
}
