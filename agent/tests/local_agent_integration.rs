//! Integration tests for the agent in TCP listener mode (`--listen`).
//!
//! These tests spawn a real `termihub-agent --listen` process and exercise the
//! JSON-RPC API over a local TCP connection. They run natively on macOS, Linux,
//! and Windows — no SSH, no Docker, no cross-compilation required — making them
//! the fastest way to iterate on agent behavior during development.
//!
//! # Running locally
//!
//! ```sh
//! cargo test -p termihub-agent --test local_agent_integration
//! ```
//!
//! The binary is built automatically by cargo before the tests run.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use tempfile::{NamedTempFile, TempDir};

// ── Binary path ───────────────────────────────────────────────────────────────

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

/// Read timeout for a single `initialize` / `connection.list` RPC round-trip.
///
/// Deliberately generous: on a loaded **Windows** CI runner the agent's cold
/// start and first response can momentarily exceed a few seconds, which flaked
/// these tests with `read_line failed: TimedOut (os error 10060)`. This matches
/// the 30 s the readiness probe already allows (and the #847 daemon-connect
/// bump). A higher ceiling never slows the passing path — the read returns as
/// soon as the response arrives; it only widens the window before we give up.
const RPC_READ_TIMEOUT: Duration = Duration::from_secs(30);

// ── Readiness retry backoff ───────────────────────────────────────────────────

/// Exponential-backoff schedule for the agent-readiness retry loop.
///
/// Starts small so a fast local start returns almost immediately, then doubles
/// the delay after each attempt up to a cap. This keeps the happy path snappy
/// (the first probe fires after only [`INITIAL`](Backoff::new) ms) while making
/// the loop gentle on a **starved CI runner**: instead of hammering `connect()`
/// hundreds of times a second for the whole timeout — the pattern that let #1398
/// flake with `connect: Connection refused` — retries space out as the agent
/// takes longer to come up.
struct Backoff {
    current: Duration,
    max: Duration,
}

impl Backoff {
    /// Create a schedule starting at `initial`, doubling up to `max`.
    fn new(initial: Duration, max: Duration) -> Self {
        Backoff {
            current: initial.min(max),
            max,
        }
    }

    /// Return the current delay, then advance the schedule (double, capped).
    fn next_delay(&mut self) -> Duration {
        let delay = self.current;
        self.current = (self.current * 2).min(self.max);
        delay
    }
}

// ── LocalAgent: process lifecycle manager ────────────────────────────────────

/// Spawns a `termihub-agent --listen` process on a free port.
/// Kills the process on drop.
struct LocalAgent {
    process: Child,
    pub addr: String,
    /// Temp config dir kept alive for the agent's lifetime (cleaned on drop).
    _config_dir: TempDir,
    /// Captured agent stderr, kept alive so `wait_for_agent_ready` can surface
    /// it in a panic if startup fails.
    _stderr: NamedTempFile,
}

impl LocalAgent {
    fn spawn() -> Self {
        let port = unique_agent_port();
        let addr = format!("127.0.0.1:{port}");

        // Isolate the agent's config/state from the developer's real
        // `~/.config/termihub-agent` (XDG_CONFIG_HOME is honored on every
        // platform). Without this, recover_sessions() reads real state at
        // startup and can block, widening the window before the accept loop is
        // live in which a connection could be reset.
        let config_dir = TempDir::new().expect("failed to create temp config dir");

        let (mut process, stderr) = spawn_listener_process(&addr, config_dir.path(), None);
        wait_for_agent_ready(&mut process, &addr, stderr.path(), ready_timeout());
        LocalAgent {
            process,
            addr,
            _config_dir: config_dir,
            _stderr: stderr,
        }
    }
}

impl Drop for LocalAgent {
    fn drop(&mut self) {
        self.process.kill().ok();
        self.process.wait().ok();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Atomic port counter to prevent TOCTOU collisions when many tests run in parallel.
///
/// `free_port()` (bind :0, get port, drop listener, return port) has a race window
/// between dropping the listener and the agent binding the same port: a concurrent
/// test can claim the same port in that gap, causing both agents to collide and one
/// test to connect to the other's agent, which gets killed before it can respond.
///
/// Using an incrementing counter means each test in this binary gets a unique port.
/// Ports 19200–19900 are IANA-unassigned and not in use by any well-known service.
static NEXT_TEST_PORT: AtomicU16 = AtomicU16::new(19200);

/// Reserve a unique TCP port for a test agent.
///
/// Advances a per-binary atomic counter so parallel tests never pick the same port.
/// Skips any port that happens to be in use by an external process (rare on a
/// dedicated CI runner, but handled to avoid spurious failures).
///
/// # Why a counter and not an ephemeral `:0` port
///
/// Binding `:0`, reading back the OS-assigned port, dropping the listener, and
/// letting the agent re-bind it opens a TOCTOU window: a concurrent test can
/// grab the same port in the gap. The incrementing counter (plus the bind
/// probe below, which skips ports already held by an unrelated process) gives
/// each test in this binary a private port with no such race.
fn unique_agent_port() -> u16 {
    loop {
        let port = NEXT_TEST_PORT.fetch_add(1, Ordering::Relaxed);
        assert!(port < 19900, "exhausted test port range 19200–19900");
        if TcpListener::bind(format!("127.0.0.1:{port}")).is_ok() {
            return port;
        }
    }
}

/// Readiness budget for [`wait_for_agent_ready`].
///
/// A loaded CI runner can take much longer than a dev box to cold-start the
/// agent process, so the default is deliberately generous (60s). Because the
/// wait returns the instant the agent is ready — and fails fast if the child
/// process dies (see [`wait_for_agent_ready`]) — a high ceiling never slows the
/// passing path; it only widens the window before we give up on a genuinely
/// slow start. CI can override it via `TERMIHUB_TEST_READY_TIMEOUT_SECS` without
/// a code change if a particular runner class needs even more headroom.
fn ready_timeout() -> Duration {
    std::env::var("TERMIHUB_TEST_READY_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(60))
}

/// Spawn a `termihub-agent --listen <addr>` with its stderr captured to a temp
/// file, isolated from the developer's real config via `XDG_CONFIG_HOME`.
///
/// Returns the child plus the [`NamedTempFile`] holding its stderr; the caller
/// passes the file's path to [`wait_for_agent_ready`] so a failed startup can be
/// diagnosed from the agent's own error output rather than an opaque timeout.
fn spawn_listener_process(
    addr: &str,
    config_home: &Path,
    rust_log: Option<&str>,
) -> (Child, NamedTempFile) {
    let stderr_file = NamedTempFile::new().expect("failed to create stderr capture file");
    let stderr_handle = stderr_file
        .reopen()
        .expect("failed to reopen stderr capture file");

    let mut cmd = Command::new(agent_binary());
    cmd.args(["--listen", addr])
        .env("XDG_CONFIG_HOME", config_home)
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_handle));
    if let Some(log) = rust_log {
        cmd.env("RUST_LOG", log);
    }

    let child = cmd.spawn().expect("failed to spawn termihub-agent");
    (child, stderr_file)
}

/// Read the captured agent stderr for inclusion in a diagnostic panic.
fn read_stderr(path: &Path) -> String {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => "(agent stderr was empty)".to_string(),
        Ok(s) => s,
        Err(e) => format!("(failed to read agent stderr: {e})"),
    }
}

/// Block until the agent's accept loop is live and idle, or panic on timeout.
///
/// A bare TCP `connect()` succeeds the instant the listener socket is bound,
/// which can happen while the agent is still in async startup *before* its
/// accept loop runs. Because the agent serves one client at a time, a real
/// test connection opened in that window sits in the backlog behind the
/// readiness probe and can be reset — the flaky "connection reset by peer".
///
/// Instead, this probe connects, half-closes (sends FIN), and reads until the
/// agent closes its end (EOF). Reaching EOF proves the agent accepted the
/// probe, ran its transport loop to completion, and looped back to `accept()` —
/// i.e. it is live and idle, leaving no overlapping connection for the test's
/// real connection to race against. Transient errors (not-yet-bound, read
/// timeout) are retried with [exponential backoff](Backoff) until the deadline.
///
/// # Robustness for loaded CI (#1398)
///
/// Two properties keep this from flaking when a starved runner is slow to start
/// the agent:
///
/// * **Fail fast on a dead child.** Between probes we poll [`Child::try_wait`].
///   If the agent process has already exited we panic immediately with its exit
///   status and captured stderr, instead of blindly retrying `connect()` for
///   the whole timeout against a port that will never open.
/// * **Rich timeout diagnostics.** On genuine timeout the panic reports whether
///   the process is still running plus its stderr — so a CI failure says
///   whether the agent never spawned, crashed, or is merely slow, rather than
///   just "connection refused".
fn wait_for_agent_ready(child: &mut Child, addr: &str, stderr_path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let mut backoff = Backoff::new(Duration::from_millis(20), Duration::from_millis(500));

    // One probe at a time: connect, half-close (send FIN), and wait for the
    // agent to serve it to completion and close its end (EOF). Reaching EOF
    // proves the accept loop ran, finished this connection's transport loop, and
    // looped back to accept() — i.e. it is live and idle, with no overlapping
    // probe left to race the test's real connection.
    //
    // A single probe can still fail transiently while the agent is mid-startup
    // under heavy parallel load (e.g. a brief listener hiccup resets the
    // connection). The agent's accept loop survives such errors, so we retry
    // with a fresh connection — spacing attempts out via exponential backoff —
    // until the deadline. Because each attempt runs to completion before the
    // next, retries never pile up a backlog.
    loop {
        match probe_once(addr, &deadline) {
            None => return,
            Some(err) => {
                // If the child has already died, there is no point waiting out
                // the rest of the timeout — surface the crash straight away.
                if let Ok(Some(status)) = child.try_wait() {
                    panic!(
                        "agent process exited before becoming ready — addr: {addr}, \
                         exit: {status}, last probe: {err}\n\
                         --- agent stderr ---\n{}",
                        read_stderr(stderr_path)
                    );
                }
                if Instant::now() >= deadline {
                    let still_running = matches!(child.try_wait(), Ok(None));
                    panic!(
                        "agent did not become ready within {timeout:?} — addr: {addr}, \
                         process still running: {still_running}, last probe: {err}\n\
                         --- agent stderr ---\n{}",
                        read_stderr(stderr_path)
                    );
                }
            }
        }
        std::thread::sleep(backoff.next_delay());
    }
}

/// One FIN-readiness probe. Returns `None` on success (EOF observed), or
/// `Some(reason)` describing a transient failure so the caller can retry.
fn probe_once(addr: &str, deadline: &Instant) -> Option<String> {
    let mut stream = match TcpStream::connect(addr) {
        Ok(stream) => stream,
        Err(e) => return Some(format!("connect: {e}")),
    };
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(500));
    if let Err(e) = stream.set_read_timeout(Some(remaining)) {
        return Some(format!("set_read_timeout: {e}"));
    }
    if let Err(e) = stream.shutdown(Shutdown::Write) {
        return Some(format!("shutdown: {e}"));
    }
    let mut buf = [0u8; 1];
    match stream.read(&mut buf) {
        Ok(0) => None,
        Ok(_) => Some("unexpected data before EOF".to_string()),
        Err(e) => Some(format!("read: {e}")),
    }
}

/// Send a single NDJSON line and return the first response line.
fn rpc(stream: &mut TcpStream, msg: &str) -> String {
    let mut line = msg.trim().to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).expect("write failed");

    let mut reader = BufReader::new(stream.try_clone().expect("clone failed"));
    let mut response = String::new();
    reader.read_line(&mut response).expect("read_line failed");
    response.trim().to_string()
}

// ── Backoff unit tests ────────────────────────────────────────────────────────

#[test]
fn backoff_starts_at_initial_and_doubles() {
    let mut b = Backoff::new(Duration::from_millis(20), Duration::from_millis(500));
    assert_eq!(b.next_delay(), Duration::from_millis(20));
    assert_eq!(b.next_delay(), Duration::from_millis(40));
    assert_eq!(b.next_delay(), Duration::from_millis(80));
    assert_eq!(b.next_delay(), Duration::from_millis(160));
    assert_eq!(b.next_delay(), Duration::from_millis(320));
}

#[test]
fn backoff_saturates_at_max_and_stays_there() {
    let mut b = Backoff::new(Duration::from_millis(20), Duration::from_millis(500));
    // 20 → 40 → 80 → 160 → 320 → 500 (capped, since 640 > 500) → 500 …
    let delays: Vec<Duration> = (0..8).map(|_| b.next_delay()).collect();
    assert_eq!(
        delays,
        vec![
            Duration::from_millis(20),
            Duration::from_millis(40),
            Duration::from_millis(80),
            Duration::from_millis(160),
            Duration::from_millis(320),
            Duration::from_millis(500),
            Duration::from_millis(500),
            Duration::from_millis(500),
        ]
    );
}

#[test]
fn backoff_clamps_initial_above_max() {
    // An initial larger than the cap must never exceed the cap.
    let mut b = Backoff::new(Duration::from_secs(10), Duration::from_millis(500));
    assert_eq!(b.next_delay(), Duration::from_millis(500));
    assert_eq!(b.next_delay(), Duration::from_millis(500));
}

/// A dead agent process must be reported immediately, not waited out.
///
/// Regression guard for #1398's diagnostics: if the child exits before the port
/// ever opens, `wait_for_agent_ready` must fail fast (via `try_wait`) with a
/// message that identifies the crash — never blindly retry `connect()` for the
/// whole timeout against a port that will never listen.
#[test]
fn wait_for_agent_ready_fails_fast_when_process_dies() {
    // `--version` makes the agent print and exit at once instead of listening,
    // standing in for a process that dies during startup.
    let port = unique_agent_port();
    let addr = format!("127.0.0.1:{port}");
    let stderr = NamedTempFile::new().expect("stderr temp file");
    let stderr_handle = stderr.reopen().expect("reopen stderr");
    let mut child = Command::new(agent_binary())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_handle))
        .spawn()
        .expect("spawn agent --version");

    let started = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Generous timeout: if fail-fast is broken this would hang ~10s, which
        // the elapsed-time assertion below still catches.
        wait_for_agent_ready(&mut child, &addr, stderr.path(), Duration::from_secs(10));
    }));
    let elapsed = started.elapsed();
    child.wait().ok();

    let panic = result.expect_err("readiness wait must panic on a dead child");
    let msg = panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(
        msg.contains("exited before becoming ready"),
        "panic must identify the dead child — got: {msg}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "readiness wait must fail fast, not wait out the timeout — took {elapsed:?}"
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn agent_starts_and_accepts_connections() {
    let agent = LocalAgent::spawn();
    // If we reach here, the agent bound a port and served the readiness probe
    // to completion (accept loop is live and idle).
    assert!(!agent.addr.is_empty());
}

#[test]
fn agent_responds_to_initialize() {
    let agent = LocalAgent::spawn();
    let mut stream = TcpStream::connect(&agent.addr).expect("connect failed");
    stream.set_read_timeout(Some(RPC_READ_TIMEOUT)).unwrap();

    let response = rpc(
        &mut stream,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"version":"0.1.0","capabilities":{}}}"#,
    );

    assert!(
        response.contains("\"id\":1"),
        "response missing id:1 — got: {response}"
    );
    // Either a result or an error is acceptable; the agent must respond.
    assert!(
        response.contains("\"result\"") || response.contains("\"error\""),
        "response is not a valid JSON-RPC envelope — got: {response}"
    );
}

#[test]
fn agent_returns_error_for_unknown_method_before_initialize() {
    let agent = LocalAgent::spawn();
    let mut stream = TcpStream::connect(&agent.addr).expect("connect failed");
    stream.set_read_timeout(Some(RPC_READ_TIMEOUT)).unwrap();

    let response = rpc(
        &mut stream,
        r#"{"jsonrpc":"2.0","id":2,"method":"connection.list","params":{}}"#,
    );

    // Agent must respond with an error (not initialized yet).
    assert!(
        response.contains("\"error\""),
        "expected error for uninitialized call — got: {response}"
    );
    assert!(
        response.contains("\"id\":2"),
        "response id must match request — got: {response}"
    );
}

#[test]
fn agent_handles_multiple_sequential_connections() {
    let agent = LocalAgent::spawn();

    for i in 0..3 {
        let mut stream = TcpStream::connect(&agent.addr).expect("connect failed");
        stream.set_read_timeout(Some(RPC_READ_TIMEOUT)).unwrap();

        let response = rpc(
            &mut stream,
            &format!(
                r#"{{"jsonrpc":"2.0","id":{i},"method":"initialize","params":{{"version":"0.1.0","capabilities":{{}}}}}}"#
            ),
        );

        assert!(
            response.contains(&format!("\"id\":{i}")),
            "connection {i}: wrong id in response — got: {response}"
        );
    }
}

#[test]
fn agent_version_flag_prints_version() {
    let output = Command::new(agent_binary())
        .arg("--version")
        .output()
        .expect("failed to run agent --version");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("termihub-agent"),
        "expected 'termihub-agent' in version output — got: {stdout}"
    );
    assert!(output.status.success(), "agent --version exited non-zero");
}

// ── AgentClient: stateful per-connection JSON-RPC client ──────────────────────

/// Stateful TCP client for the agent's JSON-RPC protocol.
///
/// Unlike the simple `rpc()` helper used in the basic connectivity tests,
/// `AgentClient` owns a single `BufReader` so output notifications buffered
/// between calls are not lost. This makes it suitable for tests that need to
/// interleave RPC calls with reading `connection.output` notifications.
struct AgentClient {
    /// Used only for writes so it is never consumed by a `BufReader`.
    writer: TcpStream,
    reader: BufReader<TcpStream>,
    next_id: u64,
}

impl AgentClient {
    fn connect(addr: &str) -> Self {
        let stream = TcpStream::connect(addr).expect("connect failed");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let writer = stream.try_clone().expect("clone failed");
        AgentClient {
            writer,
            reader: BufReader::new(stream),
            next_id: 1,
        }
    }

    /// Update the read timeout on the socket underlying the `BufReader`.
    ///
    /// `SO_RCVTIMEO` is a socket-level option so this affects the shared
    /// socket even though the `TcpStream` is owned by the `BufReader`.
    fn set_read_timeout(&self, timeout: Option<Duration>) {
        self.reader.get_ref().set_read_timeout(timeout).unwrap();
    }

    fn send(&mut self, msg: &str) {
        let line = format!("{}\n", msg.trim());
        self.writer
            .write_all(line.as_bytes())
            .expect("write failed");
    }

    /// Read and parse one NDJSON line from the agent.
    fn read_one(&mut self) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read_line failed");
        serde_json::from_str(line.trim()).expect("invalid JSON from agent")
    }

    /// Send a JSON-RPC request and return the matching response.
    ///
    /// Any `connection.output` or other notifications that arrive before the
    /// response are silently discarded so the caller sees a clean request/reply
    /// exchange.
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.send(&req.to_string());
        loop {
            let msg = self.read_one();
            if msg.get("id").is_some() {
                return msg;
            }
            // notification — discard and keep waiting for the response
        }
    }

    fn initialize(&mut self) -> Value {
        let resp = self.rpc(
            "initialize",
            json!({
                "protocolVersion": "0.2.0",
                "client": "test-client",
                "clientVersion": "0.0.1",
            }),
        );
        assert!(resp["result"].is_object(), "initialize failed: {resp}");
        resp["result"].clone()
    }

    fn create_shell_session(&mut self, title: &str) -> String {
        let resp = self.rpc(
            "connection.create",
            json!({"type": "shell", "title": title}),
        );
        assert!(
            resp["result"].is_object(),
            "connection.create failed: {resp}"
        );
        resp["result"]["session_id"]
            .as_str()
            .expect("missing session_id")
            .to_string()
    }

    fn attach(&mut self, session_id: &str) -> Value {
        self.rpc("connection.attach", json!({"session_id": session_id}))
    }

    fn close(&mut self, session_id: &str) -> Value {
        self.rpc("connection.close", json!({"session_id": session_id}))
    }

    fn list_sessions(&mut self) -> Vec<Value> {
        let resp = self.rpc("connection.list", json!({}));
        assert!(resp["result"].is_object(), "connection.list failed: {resp}");
        resp["result"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn write_input(&mut self, session_id: &str, data: &str) -> Value {
        let encoded = base64::engine::general_purpose::STANDARD.encode(data.as_bytes());
        self.rpc(
            "connection.write",
            json!({"session_id": session_id, "data": encoded}),
        )
    }

    /// Read `connection.output` notifications until one contains `needle` or
    /// the deadline is exceeded. Uses short per-read timeouts so the loop
    /// reacts promptly to new data without spinning.
    ///
    /// Returns `true` if `needle` was found in the decoded output.
    fn wait_for_output(&mut self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        self.set_read_timeout(Some(Duration::from_millis(100)));

        loop {
            if Instant::now() >= deadline {
                break;
            }
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                        if msg["method"] == "connection.output" {
                            let b64 = msg["params"]["data"].as_str().unwrap_or("");
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(b64)
                                .unwrap_or_default();
                            let text = String::from_utf8_lossy(&bytes);
                            if text.contains(needle) {
                                self.set_read_timeout(Some(Duration::from_secs(10)));
                                return true;
                            }
                        }
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    // per-read timeout, loop and check deadline
                }
                Err(_) => break,
            }
        }

        self.set_read_timeout(Some(Duration::from_secs(10)));
        false
    }
}

// ── Shell session tests ───────────────────────────────────────────────────────

/// Verify that creating a local shell session returns a valid session ID with
/// status "running". This is the prerequisite for all other shell tests.
#[test]
fn shell_session_create_returns_session_id() {
    let agent = LocalAgent::spawn();
    let mut client = AgentClient::connect(&agent.addr);
    client.initialize();

    let resp = client.rpc(
        "connection.create",
        json!({"type": "shell", "title": "create-test"}),
    );

    assert!(resp["result"].is_object(), "expected result object: {resp}");
    let session_id = resp["result"]["session_id"].as_str().unwrap_or("");
    assert!(
        !session_id.is_empty(),
        "session_id must not be empty: {resp}"
    );
    assert_eq!(
        resp["result"]["status"], "running",
        "expected status 'running': {resp}"
    );

    client.close(session_id);
}

/// Verify that after attaching to a shell and writing a command, the agent
/// delivers `connection.output` notifications containing the echoed text.
#[test]
fn shell_session_attach_and_receive_output() {
    let agent = LocalAgent::spawn();
    let mut client = AgentClient::connect(&agent.addr);
    client.initialize();
    let session_id = client.create_shell_session("output-test");

    let attach_resp = client.attach(&session_id);
    assert!(
        attach_resp["result"].is_object(),
        "attach failed: {attach_resp}"
    );

    let write_resp = client.write_input(&session_id, "echo termihub-output-marker\n");
    assert!(
        write_resp["result"].is_object(),
        "connection.write failed: {write_resp}"
    );

    let got = client.wait_for_output("termihub-output-marker", Duration::from_secs(10));
    assert!(
        got,
        "no connection.output notification containing 'termihub-output-marker' received"
    );

    client.close(&session_id);
}

/// Verify that a running shell session survives a TCP client disconnect.
///
/// The agent calls `detach_all()` when a connection drops and keeps sessions
/// alive in memory. A second client should see the same session in the list
/// with `attached: false`.
#[test]
fn shell_session_persists_across_client_disconnect() {
    let agent = LocalAgent::spawn();
    let session_id;

    {
        let mut client = AgentClient::connect(&agent.addr);
        client.initialize();
        session_id = client.create_shell_session("persist-test");
        // implicit drop → TCP connection closes → agent calls detach_all()
    }

    // Allow the agent's async runtime to process the disconnect.
    std::thread::sleep(Duration::from_millis(200));

    let mut client2 = AgentClient::connect(&agent.addr);
    client2.initialize();

    let sessions = client2.list_sessions();
    let entry = sessions
        .iter()
        .find(|s| s["session_id"].as_str() == Some(session_id.as_str()));

    assert!(
        entry.is_some(),
        "session {session_id} not found after reconnect; sessions: {sessions:?}"
    );
    let entry = entry.unwrap();
    assert_eq!(
        entry["status"], "running",
        "expected session still running: {entry}"
    );
    assert_eq!(
        entry["attached"], false,
        "expected session detached after reconnect: {entry}"
    );

    client2.close(&session_id);
}

/// Verify the full attach → disconnect → reconnect → re-attach lifecycle.
///
/// The first client creates and attaches to a shell, confirms it is alive via
/// echo, then disconnects. A second client reconnects, re-attaches to the same
/// session, and receives output — proving the shell process survived.
#[test]
fn shell_session_reattach_after_reconnect() {
    let agent = LocalAgent::spawn();
    let session_id;

    {
        let mut client = AgentClient::connect(&agent.addr);
        client.initialize();
        session_id = client.create_shell_session("reattach-test");

        let attach_resp = client.attach(&session_id);
        assert!(
            attach_resp["result"].is_object(),
            "first attach failed: {attach_resp}"
        );

        let write_resp = client.write_input(&session_id, "echo first-connection\n");
        assert!(
            write_resp["result"].is_object(),
            "write on first connection failed: {write_resp}"
        );

        let got = client.wait_for_output("first-connection", Duration::from_secs(10));
        assert!(got, "shell did not respond on first connection");
        // implicit drop → disconnects
    }

    std::thread::sleep(Duration::from_millis(200));

    let mut client2 = AgentClient::connect(&agent.addr);
    client2.initialize();

    let sessions = client2.list_sessions();
    let entry = sessions
        .iter()
        .find(|s| s["session_id"].as_str() == Some(session_id.as_str()))
        .expect("session not found after reconnect");
    assert_eq!(
        entry["attached"], false,
        "expected session detached before re-attach: {entry}"
    );

    let attach_resp = client2.attach(&session_id);
    assert!(
        attach_resp["result"].is_object(),
        "re-attach failed: {attach_resp}"
    );

    let write_resp = client2.write_input(&session_id, "echo second-connection\n");
    assert!(
        write_resp["result"].is_object(),
        "write after re-attach failed: {write_resp}"
    );

    let got = client2.wait_for_output("second-connection", Duration::from_secs(10));
    assert!(
        got,
        "no output after re-attach — shell may not have survived reconnect"
    );

    client2.close(&session_id);
}

// ── Persistent-shell (daemon-backed) tests ────────────────────────────────────
//
// These tests verify the ring-buffer replay feature for daemon-backed sessions.
//
// Mechanism: `termihub-agent --daemon` hosts a ConnectionType and stores all
// output in a RingBuffer. On every new connection (or reconnect) the daemon
// sends a MSG_BUFFER_REPLAY frame, which the agent converts to
// `connection.output` notifications. This lets a desktop client that closed and
// reopened a tab see the output it missed.
//
// Setup trick: because the local-shell type has `persistent: false`, the agent
// will not auto-spawn a daemon for it. We therefore spawn the daemon manually,
// write a minimal `state.json` to a temp directory, and start the TCP listener
// with `XDG_CONFIG_HOME` pointing there. The listener reads the state file on
// startup, calls `recover_sessions()`, and the DaemonClient connects to our
// pre-running daemon — wiring a daemon session into the JSON-RPC interface
// without needing SSH, Docker, or serial hardware.
//
// Run just these tests:
//   cargo test -p termihub-agent --test local_agent_integration persistent_shell

// ── Shared helpers ────────────────────────────────────────────────────────────

/// Poll until `path` exists or `timeout` expires.
#[cfg(unix)]
fn wait_for_socket(path: &std::path::Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if path.exists() {
            return;
        }
        if Instant::now() >= deadline {
            panic!(
                "daemon socket did not appear within {timeout:?}: {}",
                path.display()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Generate a test-unique session ID using PID + sub-second timestamp.
#[cfg(unix)]
fn test_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("test-{:08x}-{:08x}", std::process::id(), nanos)
}

/// Spawn `termihub-agent --daemon <session_id>` for a local shell.
///
/// The daemon writes its Unix socket to `socket_path` when it is ready.
/// Caller must call `wait_for_socket` before using it.
#[cfg(unix)]
fn spawn_daemon_for_local_shell(session_id: &str, socket_path: &std::path::Path) -> Child {
    Command::new(agent_binary())
        .arg("--daemon")
        .arg(session_id)
        .env("TERMIHUB_TYPE_ID", "local")
        .env("TERMIHUB_SOCKET_PATH", socket_path)
        .env("TERMIHUB_SETTINGS", "{}")
        .env("TERMIHUB_BUFFER_SIZE", "65536")
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn daemon")
}

/// A TCP listener agent isolated from the developer's real config by setting
/// `XDG_CONFIG_HOME` to a temporary directory.
#[cfg(unix)]
struct IsolatedAgent {
    process: Child,
    pub addr: String,
    /// Captured agent stderr, kept alive for startup-failure diagnostics.
    _stderr: NamedTempFile,
}

#[cfg(unix)]
impl IsolatedAgent {
    fn spawn(xdg_home: &std::path::Path) -> Self {
        let port = unique_agent_port();
        let addr = format!("127.0.0.1:{port}");
        let (mut process, stderr) = spawn_listener_process(&addr, xdg_home, Some("warn"));
        // The readiness probe waits until the accept loop is idle, which is
        // after recover_sessions() finishes — no fixed-sleep guess needed.
        wait_for_agent_ready(&mut process, &addr, stderr.path(), ready_timeout());
        IsolatedAgent {
            process,
            addr,
            _stderr: stderr,
        }
    }
}

#[cfg(unix)]
impl Drop for IsolatedAgent {
    fn drop(&mut self) {
        self.process.kill().ok();
        self.process.wait().ok();
    }
}

/// Encapsulates the full scaffold needed for persistent-shell tests:
///
/// 1. Temp directory (isolated from the user's real config)
/// 2. A `termihub-agent --daemon` process running a local shell
/// 3. An `AgentState` file pointing to the daemon socket
/// 4. A `termihub-agent --listen` that recovers the session on startup
///
/// Field drop order (first declared = first dropped in Rust):
///   agent → IsolatedAgent kills the TCP listener process
///   daemon → our Drop impl kills the daemon process
///   _tmp  → TempDir removes the temporary directory
#[cfg(unix)]
struct PersistentShellSetup {
    agent: IsolatedAgent,
    daemon: Child,
    _tmp: TempDir,
    pub session_id: String,
}

#[cfg(unix)]
impl PersistentShellSetup {
    fn new() -> Self {
        let tmp = TempDir::new().expect("failed to create temp dir");
        let tmp_path = tmp.path().to_path_buf();
        let session_id = test_session_id();
        let socket_path = tmp_path.join(format!("session-{session_id}.sock"));

        // Start daemon, wait for its socket to appear.
        let daemon = spawn_daemon_for_local_shell(&session_id, &socket_path);
        wait_for_socket(&socket_path, Duration::from_secs(5));

        // Write AgentState so the TCP listener's recover_sessions() finds this
        // daemon when it starts.
        let state_dir = tmp_path.join("termihub-agent");
        std::fs::create_dir_all(&state_dir).expect("create state dir");
        let state_json = json!({
            "sessions": {
                &session_id: {
                    "type_id": "local",
                    "title": "persistent-test-shell",
                    "created_at": "2024-01-01T00:00:00+00:00",
                    "daemon_socket": socket_path.to_str().expect("socket path not UTF-8"),
                    "settings": {}
                }
            }
        });
        std::fs::write(state_dir.join("state.json"), state_json.to_string())
            .expect("write state.json");

        // Spawn the TCP listener. It reads the state file at startup and calls
        // recover_sessions(), wiring the DaemonClient to our pre-running daemon.
        let agent = IsolatedAgent::spawn(&tmp_path);

        PersistentShellSetup {
            agent,
            daemon,
            _tmp: tmp,
            session_id,
        }
    }

    /// Connect a new JSON-RPC client to the agent and call initialize.
    fn connect_client(&self) -> AgentClient {
        let mut c = AgentClient::connect(&self.agent.addr);
        c.initialize();
        c
    }
}

#[cfg(unix)]
impl Drop for PersistentShellSetup {
    fn drop(&mut self) {
        // Kill the daemon explicitly before fields drop (before _tmp is deleted).
        self.daemon.kill().ok();
        self.daemon.wait().ok();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Verify that a persistent shell's ring buffer is replayed when `connection.attach`
/// is called on the **same** TCP connection after `connection.detach`.
///
/// This simulates "closing the tab instance" (detach) and "reopening it" (attach)
/// without dropping the TCP connection to the agent.
///
/// Flow: attach → run `ls`/`dir` → detach → attach → buffer replay contains output.
#[cfg(unix)]
#[test]
fn persistent_shell_buffer_replayed_on_same_connection_reattach() {
    let setup = PersistentShellSetup::new();
    let mut client = setup.connect_client();

    // Session must be present — recovered from the AgentState file.
    let sessions = client.list_sessions();
    let entry = sessions
        .iter()
        .find(|s| s["session_id"].as_str() == Some(setup.session_id.as_str()))
        .expect("recovered daemon session not found in connection.list");
    assert_eq!(
        entry["status"], "running",
        "recovered session not running: {entry}"
    );

    // First attach: DaemonClient connects to the daemon → daemon sends an
    // empty buffer replay (shell has not run yet) + MSG_READY.
    let ar = client.attach(&setup.session_id);
    assert!(ar["result"].is_object(), "first attach failed: {ar}");

    // Run ls (macOS/Linux) followed by a unique marker so we know exactly
    // what to search for in the buffer replay.
    let marker = "termihub-persistent-marker-42";
    let cmd = format!("ls\necho {marker}\n");

    let wr = client.write_input(&setup.session_id, &cmd);
    assert!(wr["result"].is_object(), "write failed: {wr}");
    assert!(
        client.wait_for_output(marker, Duration::from_secs(15)),
        "marker '{marker}' not received on first attach — shell not responding"
    );

    // Detach: daemon receives MSG_DETACH, stops forwarding output, but keeps
    // the shell running and the ring buffer intact.
    let dr = client.rpc(
        "connection.detach",
        json!({"session_id": &setup.session_id}),
    );
    assert!(dr["result"].is_object(), "detach failed: {dr}");

    // Re-attach on the same TCP connection: DaemonClient disconnects and
    // reconnects to the daemon socket → daemon sends MSG_BUFFER_REPLAY with
    // the full ring buffer (ls output + marker) → arrives as connection.output.
    let ra = client.attach(&setup.session_id);
    assert!(ra["result"].is_object(), "re-attach failed: {ra}");

    assert!(
        client.wait_for_output(marker, Duration::from_secs(10)),
        "buffer replay after re-attach did not contain '{marker}' — \
         persistent session ring buffer not working"
    );

    client.close(&setup.session_id);
}

/// Verify that a persistent shell's ring buffer is replayed after a full TCP
/// **disconnect → reconnect** — simulating closing and reopening the termiHub
/// application while the daemon keeps the shell alive in the background.
///
/// Flow: attach → run `ls`/`dir` → TCP disconnect → TCP reconnect → attach →
/// buffer replay contains previous output.
#[cfg(unix)]
#[test]
fn persistent_shell_buffer_replayed_after_tcp_reconnect() {
    let setup = PersistentShellSetup::new();

    let marker = "termihub-reconnect-marker-99";
    let cmd = format!("ls\necho {marker}\n");

    // ── Connection 1: attach, run ls + marker, TCP disconnect ─────────────────
    {
        let mut client = setup.connect_client();

        assert!(
            client
                .list_sessions()
                .iter()
                .any(|s| s["session_id"].as_str() == Some(setup.session_id.as_str())),
            "session not found on first connection"
        );

        let ar = client.attach(&setup.session_id);
        assert!(ar["result"].is_object(), "first attach failed: {ar}");

        let wr = client.write_input(&setup.session_id, &cmd);
        assert!(wr["result"].is_object(), "write failed: {wr}");
        assert!(
            client.wait_for_output(marker, Duration::from_secs(15)),
            "marker not received on first connection"
        );
        // Drop: TCP connection closes → agent calls detach_all() → DaemonClient
        // sends MSG_DETACH to daemon and disconnects from the Unix socket.
        // The daemon keeps the shell running and the ring buffer intact.
    }

    std::thread::sleep(Duration::from_millis(200));

    // ── Connection 2: TCP reconnect → re-attach → buffer replay ───────────────
    {
        let mut client = setup.connect_client();

        let sessions = client.list_sessions();
        let entry = sessions
            .iter()
            .find(|s| s["session_id"].as_str() == Some(setup.session_id.as_str()))
            .expect("session not found after TCP reconnect");
        assert_eq!(
            entry["attached"], false,
            "expected session detached after reconnect: {entry}"
        );

        // Re-attach: DaemonClient reconnects to daemon socket → daemon sends
        // MSG_BUFFER_REPLAY with everything in the ring buffer (including ls
        // output and the marker written on the first connection).
        let ar = client.attach(&setup.session_id);
        assert!(ar["result"].is_object(), "re-attach failed: {ar}");

        assert!(
            client.wait_for_output(marker, Duration::from_secs(10)),
            "buffer replay after TCP reconnect did not contain '{marker}' — \
             ring buffer may not have survived the disconnect"
        );

        client.close(&setup.session_id);
    }
}
