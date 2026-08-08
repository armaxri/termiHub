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
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use tempfile::{NamedTempFile, TempDir};
use termihub_core::monitoring::BackoffSchedule;

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

/// Cap on the readiness retry backoff (see [`readiness_backoff`]).
const READINESS_BACKOFF_CAP: Duration = Duration::from_millis(500);

/// Exponential-backoff schedule for the agent-readiness retry loops.
///
/// Reuses the production [`BackoffSchedule`] helper instead of a bespoke copy.
/// Starts at 20ms and doubles to [`READINESS_BACKOFF_CAP`], so a fast local
/// start returns almost immediately while a **starved CI runner** is not
/// hammered with hundreds of `connect()` attempts a second — the pattern that
/// let #1398 flake with `connect: Connection refused`. The attempt budget is
/// effectively unbounded (`u32::MAX`); these loops stop on their own wall-clock
/// deadline (or a dead child), never on an attempt count.
fn readiness_backoff() -> BackoffSchedule {
    BackoffSchedule::new(Duration::from_millis(20), READINESS_BACKOFF_CAP, u32::MAX)
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
        // Isolate the agent's config/state from the developer's real
        // `~/.config/termihub-agent` (XDG_CONFIG_HOME is honored on every
        // platform). Without this, recover_sessions() reads real state at
        // startup and can block, widening the window before the accept loop is
        // live in which a connection could be reset.
        let config_dir = TempDir::new().expect("failed to create temp config dir");

        let (process, addr, stderr) = spawn_ready_listener(config_dir.path(), None);
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

/// Low/high bounds of the test port range. 19200–20200 is IANA-unassigned and
/// not used by any well-known service.
const PORT_RANGE_LO: u16 = 19200;
const PORT_RANGE_HI: u16 = 20200;

/// Per-process port counter, seeded once to a **process-specific** base.
///
/// A plain counter starting at a fixed 19200 for every process means two
/// concurrent `cargo test` invocations (e.g. parallel CI jobs on one runner)
/// march through the *same* ports in lockstep and keep colliding. Seeding the
/// base from the PID desynchronises them so they walk different sub-ranges,
/// making a collision rare — and [`spawn_ready_listener`] retries on the rare
/// one that still lands on a `TIME_WAIT`/in-use port left by another run
/// (#1398).
fn port_counter() -> &'static AtomicU16 {
    static COUNTER: OnceLock<AtomicU16> = OnceLock::new();
    COUNTER.get_or_init(|| {
        let span = PORT_RANGE_HI - PORT_RANGE_LO;
        // Reserve headroom (span - 200) so a process starting near the top
        // still has room for its handful of ports + retries before wrapping.
        let base = PORT_RANGE_LO + (std::process::id() as u16 % (span - 200));
        AtomicU16::new(base)
    })
}

/// Reserve a candidate TCP port for a test agent.
///
/// Advances the per-process counter (wrapping within the range) so tests in the
/// same process never pick the same port, and skips any port currently held by
/// an unrelated process via a bind probe.
///
/// # Why a counter and not an ephemeral `:0` port
///
/// Binding `:0`, reading back the OS-assigned port, dropping the listener, and
/// letting the agent re-bind it opens a TOCTOU window: a concurrent test can
/// grab the same port in the gap. The counter (plus the bind probe here, and
/// [`spawn_ready_listener`]'s retry on a bind failure) gives each test a
/// private port far more reliably than `:0` round-tripping would.
fn unique_agent_port() -> u16 {
    let counter = port_counter();
    loop {
        // Wrap within [LO, HI) so a long-lived process never runs off the end.
        let raw = counter.fetch_add(1, Ordering::Relaxed);
        let port =
            PORT_RANGE_LO + (raw.wrapping_sub(PORT_RANGE_LO) % (PORT_RANGE_HI - PORT_RANGE_LO));
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

/// Poll `condition` until it returns `true` or `timeout` elapses, sleeping the
/// [`readiness_backoff`] schedule between attempts.
///
/// Returns `true` as soon as the condition holds — the happy path returns on the
/// **first** poll and never sleeps — or `false` once the ceiling is hit. This is
/// the eventually-consistent counterpart to the readiness waits: use it to await
/// an agent state that arrives asynchronously (e.g. a session flipping to
/// `attached: false` after a client TCP disconnect triggers `detach_all()`),
/// rather than a fixed sleep. A fixed budget is a guess — under a starved CI
/// runner the agent may not have processed the detach in time, so the next
/// `connection.list` still reports the stale `attached: true` and the test
/// flakes; polling with backoff is robust without slowing the normal case. The
/// ceiling reuses [`ready_timeout`] (env-overridable via
/// `TERMIHUB_TEST_READY_TIMEOUT_SECS`).
fn wait_until(mut condition: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut backoff = readiness_backoff();
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(backoff.next_delay().unwrap_or(READINESS_BACKOFF_CAP));
    }
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
/// timeout) are retried with exponential backoff (see [`readiness_backoff`])
/// until the deadline.
///
/// # Robustness for loaded CI (#1398)
///
/// Two properties keep this from flaking when a starved runner is slow to start
/// the agent:
///
/// * **Fail fast on a dead child.** Between probes we poll [`Child::try_wait`].
///   If the agent process has already exited we return
///   [`ReadyError::ProcessExited`] at once — with its exit status and captured
///   stderr — instead of blindly retrying `connect()` for the whole timeout
///   against a port that will never open. This lets [`spawn_ready_listener`]
///   retry on a fresh port when the exit was a bind collision (#1398).
/// * **Rich timeout diagnostics.** On genuine timeout the returned
///   [`ReadyError::Timeout`] reports whether the process is still running plus
///   its stderr — so a CI failure says whether the agent never spawned,
///   crashed, or is merely slow, rather than just "connection refused".
fn wait_for_agent_ready(
    child: &mut Child,
    addr: &str,
    stderr_path: &Path,
    timeout: Duration,
) -> Result<(), ReadyError> {
    let deadline = Instant::now() + timeout;
    let mut backoff = readiness_backoff();

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
            None => return Ok(()),
            Some(err) => {
                // If the child has already died, there is no point waiting out
                // the rest of the timeout — surface the crash straight away.
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(ReadyError::ProcessExited(format!(
                        "agent process exited before becoming ready — addr: {addr}, \
                         exit: {status}, last probe: {err}\n\
                         --- agent stderr ---\n{}",
                        read_stderr(stderr_path)
                    )));
                }
                if Instant::now() >= deadline {
                    let still_running = matches!(child.try_wait(), Ok(None));
                    return Err(ReadyError::Timeout(format!(
                        "agent did not become ready within {timeout:?} — addr: {addr}, \
                         process still running: {still_running}, last probe: {err}\n\
                         --- agent stderr ---\n{}",
                        read_stderr(stderr_path)
                    )));
                }
            }
        }
        std::thread::sleep(backoff.next_delay().unwrap_or(READINESS_BACKOFF_CAP));
    }
}

/// Why an agent listener never became ready.
#[derive(Debug)]
enum ReadyError {
    /// The process exited before the port opened — usually a port collision
    /// with a `TIME_WAIT`/in-use socket from another run, which retrying on a
    /// fresh port resolves. Carries the full diagnostic (exit status + stderr).
    ProcessExited(String),
    /// The deadline elapsed while the process was still running (genuinely slow
    /// or wedged). Carries the full diagnostic.
    Timeout(String),
}

/// Max attempts to bring up a `--listen` agent on a bindable port.
const MAX_SPAWN_ATTEMPTS: u32 = 5;

/// Spawn a `--listen` agent and block until it is ready, retrying on a fresh
/// port if the process dies during startup.
///
/// The fixed test-port range can collide with a socket left in `TIME_WAIT` (or
/// held) by a previous or concurrent run on the same host — the agent then
/// exits with `Address already in use` before its port ever opens (#1398). The
/// bind probe in [`unique_agent_port`] cannot prevent this because another
/// process owns the port, so we detect the early exit via
/// [`ReadyError::ProcessExited`] and simply try the next port. A genuine
/// startup bug fails the same way on every port and surfaces after the retry
/// budget with full diagnostics; a slow-but-alive start ([`ReadyError::Timeout`])
/// is not retried (that would just burn another full timeout).
fn spawn_ready_listener(
    config_home: &Path,
    rust_log: Option<&str>,
) -> (Child, String, NamedTempFile) {
    let mut last_diag = String::new();
    for attempt in 1..=MAX_SPAWN_ATTEMPTS {
        let port = unique_agent_port();
        let addr = format!("127.0.0.1:{port}");
        let (mut child, stderr) = spawn_listener_process(&addr, config_home, rust_log);
        match wait_for_agent_ready(&mut child, &addr, stderr.path(), ready_timeout()) {
            Ok(()) => return (child, addr, stderr),
            Err(ReadyError::ProcessExited(diag)) => {
                child.kill().ok();
                child.wait().ok();
                last_diag = format!("attempt {attempt}/{MAX_SPAWN_ATTEMPTS}: {diag}");
            }
            Err(ReadyError::Timeout(diag)) => {
                child.kill().ok();
                child.wait().ok();
                panic!("{diag}");
            }
        }
    }
    panic!(
        "agent listener failed to become ready after {MAX_SPAWN_ATTEMPTS} attempts \
         (each exited during startup) — {last_diag}"
    );
}

// ── Client connect with bounded retry ────────────────────────────────────────

/// Per-attempt connect timeout for [`connect_with_retry`] and [`probe_once`].
///
/// A bare `TcpStream::connect` uses the OS default connect timeout, which on
/// **Windows** is a long, unforgiving SYN-retransmit sequence (~21s). Under
/// heavy parallel CI load a *ready* loopback listener's accept backlog can fill
/// for a beat, so Windows silently drops the client SYN and a single `connect`
/// hangs the whole way to that default — surfacing as
/// `Os { code: 10060, kind: TimedOut }`, the #2490 / #1579 flake that reds a
/// random agent-integration test each run. Capping each attempt short turns that
/// one long hang into a fast poll: abandon a stalled SYN quickly and re-attempt
/// on the backoff schedule. On unix a bare connect refuses fast, so the cap is
/// only ever exercised there in pathological cases; it is harmless.
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(750);

/// Resolve a `host:port` string to a single `SocketAddr` for `connect_timeout`.
///
/// A malformed address is a test bug, not a transient condition, so this panics
/// rather than feeding a retry loop that could never succeed.
fn resolve_addr(addr: &str) -> SocketAddr {
    addr.to_socket_addrs()
        .unwrap_or_else(|e| panic!("could not parse agent addr {addr}: {e}"))
        .next()
        .unwrap_or_else(|| panic!("agent addr {addr} resolved to no socket address"))
}

/// Connect a client to a *ready* agent listener, retrying short-timeout connects
/// with bounded backoff until the listener accepts or [`ready_timeout`] elapses.
///
/// [`spawn_ready_listener`] already proves the accept loop is live before a test
/// runs, so this normally succeeds on the first attempt and never sleeps. Its job
/// is to survive the transient Windows-CI window described on
/// [`CONNECT_ATTEMPT_TIMEOUT`]: it polls on **connect success** (per the #2459
/// hardening lesson — never a fixed sleep-then-assume-ready) instead of betting
/// the whole test on one `connect` that can hang for ~21s.
///
/// The deadline is bounded and the **read side is untouched**: a listener that
/// never accepts still fails the test once the budget elapses — this only widens
/// the connect window, it does not mask a genuine hang or weaken any readiness
/// assertion.
fn connect_with_retry(addr: &str) -> TcpStream {
    let socket_addr = resolve_addr(addr);
    let deadline = Instant::now() + ready_timeout();
    let mut backoff = readiness_backoff();
    loop {
        match TcpStream::connect_timeout(&socket_addr, CONNECT_ATTEMPT_TIMEOUT) {
            Ok(stream) => return stream,
            Err(e) => {
                if Instant::now() >= deadline {
                    panic!(
                        "could not connect to agent at {addr} within {:?} — last error: {e}",
                        ready_timeout()
                    );
                }
            }
        }
        std::thread::sleep(backoff.next_delay().unwrap_or(READINESS_BACKOFF_CAP));
    }
}

/// One FIN-readiness probe. Returns `None` on success (EOF observed), or
/// `Some(reason)` describing a transient failure so the caller can retry.
fn probe_once(addr: &str, deadline: &Instant) -> Option<String> {
    // Use a short per-attempt connect timeout (see [`CONNECT_ATTEMPT_TIMEOUT`]):
    // a bare `connect` here would hang ~21s on a Windows SYN drop, stalling the
    // whole readiness backoff loop before it could retry.
    let mut stream = match TcpStream::connect_timeout(&resolve_addr(addr), CONNECT_ATTEMPT_TIMEOUT)
    {
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

/// A dead agent process must be reported immediately, not waited out.
///
/// Regression guard for #1398's diagnostics: if the child exits before the port
/// ever opens, `wait_for_agent_ready` must fail fast (via `try_wait`) with a
/// [`ReadyError::ProcessExited`] that identifies the crash — never blindly retry
/// `connect()` for the whole timeout against a port that will never listen. It
/// is this fast, classified exit that lets `spawn_ready_listener` retry on a
/// fresh port when the cause is a bind collision.
#[test]
fn wait_for_agent_ready_reports_dead_process_fast() {
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
    // Generous timeout: if fail-fast is broken this would take ~10s, which the
    // elapsed-time assertion below still catches.
    let result = wait_for_agent_ready(&mut child, &addr, stderr.path(), Duration::from_secs(10));
    let elapsed = started.elapsed();
    child.wait().ok();

    match result {
        Err(ReadyError::ProcessExited(diag)) => assert!(
            diag.contains("exited before becoming ready"),
            "diagnostic must identify the dead child — got: {diag}"
        ),
        other => panic!("expected ProcessExited on a dead child, got: {other:?}"),
    }
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
    let mut stream = connect_with_retry(&agent.addr);
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
    let mut stream = connect_with_retry(&agent.addr);
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
        let mut stream = connect_with_retry(&agent.addr);
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
        // Retry the connect with bounded backoff so a transient Windows-CI SYN
        // drop against a ready listener does not 10060 the test (#2490/#1579);
        // see [`connect_with_retry`].
        let stream = connect_with_retry(addr);
        // Match the simple `rpc()` helper's generous per-round-trip budget: a
        // loaded CI runner can momentarily take several seconds to answer an
        // RPC, and a 10s ceiling flaked under that load (#1398). The read still
        // returns as soon as the response arrives.
        stream.set_read_timeout(Some(RPC_READ_TIMEOUT)).unwrap();
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

    /// Return `true` if `connection.list` reports `session_id` with
    /// `attached: false` — the eventually-consistent state the agent reaches
    /// after a client TCP disconnect triggers `detach_all()`. Used with
    /// [`wait_until`] to await the detach instead of a fixed post-disconnect
    /// sleep.
    fn session_detached(&mut self, session_id: &str) -> bool {
        self.list_sessions()
            .iter()
            .any(|s| s["session_id"].as_str() == Some(session_id) && s["attached"] == false)
    }

    fn write_input(&mut self, session_id: &str, data: &str) -> Value {
        let encoded = base64::engine::general_purpose::STANDARD.encode(data.as_bytes());
        self.rpc(
            "connection.write",
            json!({"session_id": session_id, "data": encoded}),
        )
    }

    /// Read `connection.output` notifications until one contains `needle` or the
    /// shared readiness budget ([`ready_timeout`]) elapses. Uses short per-read
    /// timeouts so the loop reacts promptly to new data without spinning.
    ///
    /// # Why the ceiling is [`ready_timeout`] and not a per-call fixed budget
    ///
    /// A shell's cold start plus the command round-trip (write → PTY echo →
    /// forwarder → notification channel → TCP) can momentarily exceed a tight
    /// fixed budget on a loaded **Windows** CI runner. A hardcoded 10s ceiling
    /// here is what flaked the attach/reattach tests (#2194): the assertion fired
    /// "no connection.output … received" even though the output was merely late,
    /// not lost — and the very tests that flaked were exactly the ones using this
    /// fixed-budget wait, while the reconnect test that instead polls on
    /// [`ready_timeout`] never did. A fixed budget is a guess; this reuses the
    /// same generous, env-overridable ([`TERMIHUB_TEST_READY_TIMEOUT_SECS`])
    /// ceiling as the other readiness waits. Because the loop polls and returns
    /// the instant `needle` arrives, a higher ceiling never slows the passing
    /// path — it only widens the window before we give up.
    ///
    /// Returns `true` if `needle` was found in the decoded output.
    fn wait_for_output(&mut self, needle: &str) -> bool {
        let deadline = Instant::now() + ready_timeout();
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
                                self.set_read_timeout(Some(RPC_READ_TIMEOUT));
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

        self.set_read_timeout(Some(RPC_READ_TIMEOUT));
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

    let got = client.wait_for_output("termihub-output-marker");
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

    let mut client2 = AgentClient::connect(&agent.addr);
    client2.initialize();

    // Wait for the agent's async runtime to process the disconnect and mark the
    // session detached, rather than guessing with a fixed sleep (a starved CI
    // runner may need longer). Returns on the first successful poll.
    assert!(
        wait_until(|| client2.session_detached(&session_id), ready_timeout()),
        "session {session_id} not reported detached after client disconnect"
    );

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

        let got = client.wait_for_output("first-connection");
        assert!(got, "shell did not respond on first connection");
        // implicit drop → disconnects
    }

    let mut client2 = AgentClient::connect(&agent.addr);
    client2.initialize();

    // Poll until the agent reports the session detached instead of a fixed sleep
    // that flakes under CI load. Returns on the first successful poll.
    assert!(
        wait_until(|| client2.session_detached(&session_id), ready_timeout()),
        "session {session_id} not reported detached before re-attach"
    );

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

    let got = client2.wait_for_output("second-connection");
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

/// Poll until the daemon's `path` socket appears, or panic on timeout.
///
/// Hardened the same way as [`wait_for_agent_ready`] (#1398): the previous
/// version used a fixed non-overridable 5s budget, a flat 20ms spin, and threw
/// the daemon's stderr away — so a slow/loaded CI runner flaked and the panic
/// said nothing. Now it fails fast if the daemon process has already died
/// (with its exit status + captured stderr), uses the shared exponential
/// [`readiness_backoff`], and appends stderr on genuine timeout.
#[cfg(unix)]
fn wait_for_socket(child: &mut Child, path: &Path, stderr_path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let mut backoff = readiness_backoff();
    loop {
        if path.exists() {
            return;
        }
        // A dead daemon will never create the socket — surface the crash now
        // instead of spinning until the deadline.
        if let Ok(Some(status)) = child.try_wait() {
            panic!(
                "daemon process exited before creating its socket — exit: {status}, \
                 socket: {}\n--- daemon stderr ---\n{}",
                path.display(),
                read_stderr(stderr_path)
            );
        }
        if Instant::now() >= deadline {
            let still_running = matches!(child.try_wait(), Ok(None));
            panic!(
                "daemon socket did not appear within {timeout:?} — socket: {}, \
                 process still running: {still_running}\n--- daemon stderr ---\n{}",
                path.display(),
                read_stderr(stderr_path)
            );
        }
        std::thread::sleep(backoff.next_delay().unwrap_or(READINESS_BACKOFF_CAP));
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
/// Caller must call [`wait_for_socket`] before using it. Returns the child plus
/// the [`NamedTempFile`] capturing its stderr, so a startup failure can be
/// diagnosed from the daemon's own error output.
#[cfg(unix)]
fn spawn_daemon_for_local_shell(session_id: &str, socket_path: &Path) -> (Child, NamedTempFile) {
    let stderr_file = NamedTempFile::new().expect("failed to create daemon stderr capture file");
    let stderr_handle = stderr_file
        .reopen()
        .expect("failed to reopen daemon stderr capture file");
    let child = Command::new(agent_binary())
        .arg("--daemon")
        .arg(session_id)
        .env("TERMIHUB_TYPE_ID", "local")
        .env("TERMIHUB_SOCKET_PATH", socket_path)
        .env("TERMIHUB_SETTINGS", "{}")
        .env("TERMIHUB_BUFFER_SIZE", "65536")
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_handle))
        .spawn()
        .expect("failed to spawn daemon");
    (child, stderr_file)
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
        // spawn_ready_listener waits until the accept loop is idle (after
        // recover_sessions() finishes) and retries on a port collision.
        let (process, addr, stderr) = spawn_ready_listener(xdg_home, Some("warn"));
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
    /// Captured daemon stderr, kept alive for startup-failure diagnostics.
    _daemon_stderr: NamedTempFile,
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

        // Start daemon, wait for its socket to appear. Uses the shared
        // adaptive readiness budget so a loaded CI runner has headroom.
        let (mut daemon, daemon_stderr) = spawn_daemon_for_local_shell(&session_id, &socket_path);
        wait_for_socket(
            &mut daemon,
            &socket_path,
            daemon_stderr.path(),
            ready_timeout(),
        );

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
            _daemon_stderr: daemon_stderr,
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
        client.wait_for_output(marker),
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
        client.wait_for_output(marker),
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
            client.wait_for_output(marker),
            "marker not received on first connection"
        );
        // Drop: TCP connection closes → agent calls detach_all() → DaemonClient
        // sends MSG_DETACH to daemon and disconnects from the Unix socket.
        // The daemon keeps the shell running and the ring buffer intact.
    }

    // ── Connection 2: TCP reconnect → re-attach → buffer replay ───────────────
    {
        let mut client = setup.connect_client();

        // Poll until the daemon has processed the detach (session shows
        // `attached: false`) instead of a fixed sleep that flakes under CI load.
        // Returns on the first successful poll.
        let session_id = setup.session_id.clone();
        assert!(
            wait_until(|| client.session_detached(&session_id), ready_timeout()),
            "session {session_id} not reported detached after TCP reconnect"
        );

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
            client.wait_for_output(marker),
            "buffer replay after TCP reconnect did not contain '{marker}' — \
             ring buffer may not have survived the disconnect"
        );

        client.close(&setup.session_id);
    }
}
