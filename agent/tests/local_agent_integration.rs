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
//!
//! # Windows CI quarantine + contention control (#2495)
//!
//! These tests each spawn a live `termihub-agent --listen` process and drive it
//! over a TCP client, and cargo runs them in parallel. They used to flake **only
//! on Windows CI** with `Os { code: 10060, kind: TimedOut }` — a *random* one each
//! run — not from too-tight timeouts (two transport fixes, #2492 connect-retry and
//! #2494 read-deadline, had already ruled that out) but because the agent was
//! genuinely slow to respond under a loaded runner. Root cause (#2495): each agent
//! process spun up `num_cpus` Tokio worker threads AND spawned a `docker info`
//! child on every `initialize`, so N parallel agents oversubscribed the runner's
//! few cores until the agent answered past even the generous deadline.
//!
//! The mitigation has three layers, all test-harness-only (production keeps the
//! default `num_cpus` runtime and real Docker probe):
//!
//! 1. **Per-process caps (#2501)**, applied by [`spawn_listener_process`]:
//!    `TERMIHUB_AGENT_WORKER_THREADS=2` caps each agent's runtime and
//!    `TERMIHUB_AGENT_SKIP_DOCKER_PROBE=1` stops `initialize` from spawning a
//!    `docker info` child. These bound each *individual* agent.
//! 2. **An aggregate concurrency gate (#2495, this change)** — see
//!    [`AgentSlot`]/[`agent_slots`]. The per-process caps could not stop ~11
//!    agents *cold-starting at once* from oversubscribing a few-core runner
//!    (11 × 2 worker threads still swamp 2–4 cores). The gate is a process-global
//!    counting semaphore acquired **before** each spawn and held for the agent's
//!    lifetime, so at most [`max_concurrent_agents`] agents are alive/starting at
//!    a time (Windows default 2; other platforms unbounded → no change to the
//!    green lanes). Tune with `TERMIHUB_AGENT_TEST_MAX_CONCURRENT`.
//! 3. **Phase-timing instrumentation (#2495, this change)** — the spawn path and
//!    the response reads time the gate wait, the process cold-start, and the
//!    first-RPC round-trip. A Windows-CI failure now names the slow phase in its
//!    panic, and `TERMIHUB_TEST_TIMING=1` + `--nocapture` prints the full
//!    distribution on a passing run so we can see how close the runner is to the
//!    deadline. See [`log_timing`]/[`read_response_line`].
//!
//! The #2501 per-process caps **reduced but did not eliminate** the flake — the
//! random 10060 recurred on the Windows leg after they landed. Per the flake
//! stop-condition, the `#[cfg_attr(windows, ignore … #2495)]` quarantine is
//! therefore **kept in this change too**: the aggregate gate is a candidate
//! deeper fix that must be *graded on Windows before* the tests are re-enabled
//! per-PR, so unrelated PRs stay unblocked meanwhile. To grade it, run the
//! quarantined subset on a Windows runner, stress-looped:
//!
//! ```sh
//! cargo test -p termihub-agent --test local_agent_integration -- \
//!   --ignored --nocapture   # with TERMIHUB_TEST_TIMING=1 for the phase breakdown
//! ```
//!
//! Un-quarantine (remove the attributes) only once that holds across many
//! consecutive runs — 3 green is not enough for a chronic flake. The timing
//! lines tell us whether the gate closed the gap (small gate_wait + small
//! cold_start + fast first response) or whether a residual phase is still slow.
//! Tests that do not drive a live agent over TCP (the raw-socket read-deadline
//! test, the dead-process fast-fail, the `--version` check, and the gate's own
//! unit tests) are unaffected and stay enabled everywhere.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use tempfile::{NamedTempFile, TempDir};
use termihub_core::monitoring::BackoffSchedule;

// ── Binary path ───────────────────────────────────────────────────────────────

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

// ── Global agent-process concurrency gate (#2495, facet 3) ────────────────────
//
// The two transport facets were already fixed (#2492 connect-retry, #2494
// read-deadline) and #2501 added *per-process* contention control
// (`TERMIHUB_AGENT_WORKER_THREADS=2` + `TERMIHUB_AGENT_SKIP_DOCKER_PROBE=1`).
// Those reduced but did **not** eliminate the residual Windows-CI flake
// (`Os { code: 10060, kind: TimedOut }`), because they bound only *each* agent,
// not the *aggregate*: cargo runs ~11 of these tests in parallel and each spawns
// a full `termihub-agent` process, so on a 2–4-core Windows runner ~11 agents
// cold-start at once and oversubscribe every core until an agent answers past
// even the generous 60s deadline. The decisive evidence is that
// `agent_handles_multiple_sequential_connections` creates **no shell** (pure
// connect→initialize→disconnect) yet still ran >60s on Windows — ruling out every
// shell/ConPTY/spawn-cost hypothesis and pointing squarely at scheduler
// starvation from too many concurrent agent processes.
//
// This gate bounds that aggregate directly with a process-global counting
// semaphore: at most [`max_concurrent_agents`] agent processes are alive (and,
// crucially, *cold-starting*) at any moment. It is acquired **before** the spawn
// in [`spawn_ready_listener`] and held for the whole life of the agent process
// (stored in [`LocalAgent`]), so it caps both concurrent starts — where the CPU
// spike is — and concurrent live agents. On non-Windows platforms the default is
// unbounded, so the green ubuntu/macOS lanes stay fully parallel with no
// behavior change; the only cost there is one mutex lock/unlock per spawn.

/// Env override for the maximum number of concurrently-live agent processes.
///
/// A positive integer caps the [`agent_slots`] semaphore to that many permits;
/// absent/empty/non-numeric/zero falls back to [`DEFAULT_MAX_CONCURRENT`]. Lets
/// CI (or a local repro) tune the cap — or force one on a normally-unbounded
/// platform to grade the gate — without a code change.
const MAX_CONCURRENT_ENV: &str = "TERMIHUB_AGENT_TEST_MAX_CONCURRENT";

/// Default cap on concurrently-live agent processes.
///
/// Windows caps low (the leg that flaked under aggregate oversubscription);
/// every other platform is effectively unbounded — they never exhibited the
/// flake and stay fully parallel, so there is no throughput regression there.
#[cfg(windows)]
const DEFAULT_MAX_CONCURRENT: usize = 2;
#[cfg(not(windows))]
const DEFAULT_MAX_CONCURRENT: usize = usize::MAX;

/// Parse a concurrency cap, falling back to `default` for
/// absent/empty/non-numeric/zero. Split out so it is unit-testable without the
/// process env (see [`max_concurrent_parses_*`]).
fn parse_max_concurrent(raw: Option<String>, default: usize) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

/// Resolve the concurrency cap from the env override, falling back to the
/// platform default.
fn max_concurrent_agents() -> usize {
    parse_max_concurrent(
        std::env::var(MAX_CONCURRENT_ENV).ok(),
        DEFAULT_MAX_CONCURRENT,
    )
}

/// A tiny std-only counting semaphore gating concurrently-live agent processes.
struct AgentSlots {
    available: Mutex<usize>,
    slot_freed: Condvar,
}

impl AgentSlots {
    fn with_permits(permits: usize) -> Self {
        AgentSlots {
            available: Mutex::new(permits),
            slot_freed: Condvar::new(),
        }
    }

    /// Block until a permit is free, then take it.
    fn take(&self) {
        let mut available = self.available.lock().expect("agent-slots mutex poisoned");
        while *available == 0 {
            available = self
                .slot_freed
                .wait(available)
                .expect("agent-slots mutex poisoned");
        }
        *available -= 1;
    }

    /// Return a permit and wake one waiter.
    fn give(&self) {
        let mut available = self.available.lock().expect("agent-slots mutex poisoned");
        *available += 1;
        // A single returned permit only unblocks one acquirer.
        self.slot_freed.notify_one();
    }
}

/// The process-global agent-process concurrency gate, sized once on first use.
fn agent_slots() -> &'static AgentSlots {
    static SLOTS: OnceLock<AgentSlots> = OnceLock::new();
    SLOTS.get_or_init(|| AgentSlots::with_permits(max_concurrent_agents()))
}

/// RAII permit for one live agent process; returns its slot to the gate on drop.
///
/// Held for the entire lifetime of the agent process (a field of [`LocalAgent`]),
/// so a slot is only released once that process has been killed and reaped.
struct AgentSlot;

impl AgentSlot {
    /// Block until a slot is free, then take it. Returns immediately (after one
    /// mutex round-trip) whenever the cap is not saturated — the common case, and
    /// always the case on the effectively-unbounded non-Windows default.
    fn acquire() -> Self {
        agent_slots().take();
        AgentSlot
    }
}

impl Drop for AgentSlot {
    fn drop(&mut self) {
        agent_slots().give();
    }
}

// ── Phase-timing instrumentation (#2495, facet 3) ─────────────────────────────
//
// Facet 3 is "the agent is genuinely slow to respond on the loaded Windows
// runner" — but *which phase* is slow was never measured: the gate wait, the
// process cold-start (spawn→accept-loop-live), or the first RPC round-trip. This
// instrumentation times each phase so a Windows-CI failure is self-diagnosing
// (the panic names the phase and its elapsed time) and, under
// `TERMIHUB_TEST_TIMING=1` + `--nocapture`, a *passing* run prints the full
// distribution so we can see how close the runner is to the deadline even when
// it does not flake. It changes no assertion — it only enriches diagnostics.

/// Whether per-phase timing lines should be emitted (`TERMIHUB_TEST_TIMING=1`).
fn timing_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        matches!(
            std::env::var("TERMIHUB_TEST_TIMING").ok().as_deref(),
            Some("1") | Some("true") | Some("yes")
        )
    })
}

/// Emit one timing line to stderr when [`timing_enabled`].
///
/// libtest captures a passing test's output, so these surface only with
/// `cargo test … -- --nocapture` (the grading invocation); a *failing* test's
/// captured output is shown regardless, and the timing is also folded into the
/// failure panics directly, so a flake is diagnosable without `--nocapture`.
fn log_timing(args: std::fmt::Arguments) {
    if timing_enabled() {
        eprintln!("[termihub-test-timing] {args}");
    }
}

/// Read one response line, timing it and attributing a stall to a named call.
///
/// Replaces a bare `read_line_until_deadline(...).expect("read_line failed")`:
/// on the bounded-deadline expiry it panics with the call label and how long it
/// waited, so a Windows-CI 10060 says *first-response-slow for `initialize`*
/// rather than an opaque "read_line failed" — the exact signal facet 3 needs to
/// separate a slow first response from a slow spawn. The read still fails a
/// genuinely non-responding agent once the deadline elapses (unchanged).
fn read_response_line(reader: &mut BufReader<TcpStream>, line: &mut String, label: &str) {
    let start = Instant::now();
    let result = read_line_until_deadline(reader, line, read_deadline());
    let elapsed = start.elapsed();
    log_timing(format_args!(
        "response[{label}] elapsed={elapsed:?} ok={}",
        result.is_ok()
    ));
    if let Err(e) = result {
        panic!(
            "no agent response for {label:?} within {:?} (waited {elapsed:?}) — agent \
             slow-to-respond on this runner (#2495 facet 3): {e}",
            ready_timeout()
        );
    }
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
    /// Concurrency-gate permit for this live agent process (#2495). Held for the
    /// whole process lifetime and returned to [`agent_slots`] on drop — after the
    /// explicit [`Drop`] below has killed and reaped the process (fields drop
    /// after the impl body runs), so a freed slot always corresponds to a
    /// genuinely gone agent.
    _slot: AgentSlot,
}

impl LocalAgent {
    fn spawn() -> Self {
        // Isolate the agent's config/state from the developer's real
        // `~/.config/termihub-agent` (XDG_CONFIG_HOME is honored on every
        // platform). Without this, recover_sessions() reads real state at
        // startup and can block, widening the window before the accept loop is
        // live in which a connection could be reset.
        let config_dir = TempDir::new().expect("failed to create temp config dir");

        // Point the agent's host-wide registry (ADR-11) at a per-agent endpoint
        // inside this temp dir rather than the shared per-user default
        // (`/tmp/termihub/{user}/registry.sock`). Without this override the agent
        // spawns/joins the developer's real registry daemon — leaking a detached
        // process into shared state and letting parallel checkouts fight over one
        // registry. See [`registry_endpoint_in`].
        let registry_endpoint = registry_endpoint_in(config_dir.path(), "reg");
        let (process, addr, stderr, slot) =
            spawn_ready_listener(config_dir.path(), &registry_endpoint, None);
        LocalAgent {
            process,
            addr,
            _config_dir: config_dir,
            _stderr: stderr,
            _slot: slot,
        }
    }

    /// Spawn an agent pointed at an explicit, caller-owned registry endpoint.
    ///
    /// Used by the fresh-after-reconnect test to stand a second agent process up
    /// against a registry daemon a **prior** agent already spawned — the headless
    /// analog of a reconnect re-establishing the transport with a fresh
    /// `termihub-agent --stdio` while the host-wide registry survives the swap.
    fn spawn_with_registry(registry_endpoint: &str) -> Self {
        let config_dir = TempDir::new().expect("failed to create temp config dir");
        let (process, addr, stderr, slot) =
            spawn_ready_listener(config_dir.path(), registry_endpoint, None);
        LocalAgent {
            process,
            addr,
            _config_dir: config_dir,
            _stderr: stderr,
            _slot: slot,
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

/// A unique host-wide-registry (ADR-11) endpoint scoped to `dir`.
///
/// Mirrors `registry_daemon_integration.rs`'s `unique_endpoint`: on unix the
/// per-test `TempDir` scopes the socket file, so the endpoint lives (and is
/// cleaned up) inside the agent's own config dir; on windows the `\\.\pipe\`
/// namespace is machine-global with no directory to scope it, so uniqueness must
/// live in the name (pid + a per-process counter). Either way the endpoint never
/// collides with a parallel checkout or the developer's live registry — the
/// isolation the shared per-user default (`/tmp/termihub/{user}/registry.sock`)
/// does **not** provide on its own.
#[cfg(unix)]
fn registry_endpoint_in(dir: &Path, tag: &str) -> String {
    dir.join(format!("registry-{tag}.sock"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn registry_endpoint_in(_dir: &Path, tag: &str) -> String {
    static COUNTER: AtomicU16 = AtomicU16::new(0);
    format!(
        r"\\.\pipe\termihub-lai-{}-{}-{tag}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Whether the registry daemon is currently listening at `endpoint`.
///
/// A connect probe, not a `Path::exists`: a `\\.\pipe\` name is not a filesystem
/// path, and on unix the socket *file* can linger after the daemon dies, so only
/// a connect answers the question the fresh-after-reconnect test actually asks —
/// is a registry from the prior agent still reachable.
#[cfg(unix)]
fn endpoint_reachable(endpoint: &str) -> bool {
    std::os::unix::net::UnixStream::connect(endpoint).is_ok()
}

#[cfg(windows)]
fn endpoint_reachable(endpoint: &str) -> bool {
    const ERROR_PIPE_BUSY: i32 = 231;
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(endpoint)
    {
        Ok(_) => true,
        Err(e) => e.raw_os_error() == Some(ERROR_PIPE_BUSY),
    }
}

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
    registry_endpoint: &str,
    rust_log: Option<&str>,
) -> (Child, NamedTempFile) {
    let stderr_file = NamedTempFile::new().expect("failed to create stderr capture file");
    let stderr_handle = stderr_file
        .reopen()
        .expect("failed to reopen stderr capture file");

    let mut cmd = Command::new(agent_binary());
    cmd.args(["--listen", addr])
        .env("XDG_CONFIG_HOME", config_home)
        // Isolate the host-wide registry (ADR-11) from the shared per-user
        // default so the test never spawns/joins the developer's real registry
        // daemon (see [`LocalAgent::spawn`]).
        .env("TERMIHUB_REGISTRY_ENDPOINT", registry_endpoint)
        // Contention control for the Windows CI leg (#2495). Each test spawns its
        // own agent process and cargo runs the tests in parallel; without these
        // two knobs every agent would start `num_cpus` Tokio worker threads AND
        // spawn a `docker info` child on every `initialize`, oversubscribing a
        // loaded runner until the agent answers past even the generous deadline
        // (the random 10060). Cap the worker threads low and skip the Docker
        // probe entirely — neither changes what these tests assert.
        .env("TERMIHUB_AGENT_WORKER_THREADS", "2")
        .env("TERMIHUB_AGENT_SKIP_DOCKER_PROBE", "1")
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
    registry_endpoint: &str,
    rust_log: Option<&str>,
) -> (Child, String, NamedTempFile, AgentSlot) {
    // Acquire the concurrency-gate permit BEFORE spawning so the CPU-heavy cold
    // start is what the gate bounds, not just the idle steady state (#2495). The
    // wait is timed: on Windows CI the gate wait is the direct measure of how
    // oversubscribed the runner is.
    let gate_started = Instant::now();
    let slot = AgentSlot::acquire();
    let gate_wait = gate_started.elapsed();

    let mut last_diag = String::new();
    for attempt in 1..=MAX_SPAWN_ATTEMPTS {
        let port = unique_agent_port();
        let addr = format!("127.0.0.1:{port}");
        let spawn_started = Instant::now();
        let (mut child, stderr) =
            spawn_listener_process(&addr, config_home, registry_endpoint, rust_log);
        match wait_for_agent_ready(&mut child, &addr, stderr.path(), ready_timeout()) {
            Ok(()) => {
                log_timing(format_args!(
                    "spawn[{addr}] gate_wait={gate_wait:?} cold_start={:?} attempts={attempt}",
                    spawn_started.elapsed()
                ));
                return (child, addr, stderr, slot);
            }
            Err(ReadyError::ProcessExited(diag)) => {
                child.kill().ok();
                child.wait().ok();
                last_diag = format!("attempt {attempt}/{MAX_SPAWN_ATTEMPTS}: {diag}");
            }
            Err(ReadyError::Timeout(diag)) => {
                let cold_start = spawn_started.elapsed();
                child.kill().ok();
                child.wait().ok();
                // Attribute the stall: a large `cold_start` with a small
                // `gate_wait` means the agent process itself was slow to bring
                // its accept loop up (facet 3, spawn side); a large `gate_wait`
                // means the runner was saturated by other agents (the gate is
                // working but the cap is still too high for this runner).
                panic!(
                    "{diag}\n--- #2495 spawn timing --- gate_wait={gate_wait:?}, \
                     cold_start={cold_start:?} before the ready deadline, attempt \
                     {attempt}/{MAX_SPAWN_ATTEMPTS}, concurrency_cap={}",
                    max_concurrent_agents()
                );
            }
        }
    }
    panic!(
        "agent listener failed to become ready after {MAX_SPAWN_ATTEMPTS} attempts \
         (each exited during startup) — {last_diag} (#2495 gate_wait={gate_wait:?})"
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

// ── Response reads robust to slow Windows-CI responses ────────────────────────

/// Short per-read socket timeout used inside [`read_line_until_deadline`].
///
/// Kept small so the read loop re-checks its wall-clock deadline promptly. Each
/// expiry is a `WouldBlock` (unix) / `WSAETIMEDOUT` os error 10060 (Windows)
/// that the loop simply retries; it is never the budget that fails a test.
const READ_POLL_TIMEOUT: Duration = Duration::from_millis(500);

/// A fresh total budget for reading a single response line.
///
/// Reuses the same generous, env-overridable ([`TERMIHUB_TEST_READY_TIMEOUT_SECS`])
/// ceiling as the other readiness waits — a loaded Windows runner's first or
/// reconnect/replay response can arrive several seconds late without the agent
/// being unhealthy.
fn read_deadline() -> Instant {
    Instant::now() + ready_timeout()
}

/// Read one NDJSON line from `reader`, retrying transient per-read timeouts until
/// `deadline`.
///
/// # Why this exists (#2493)
///
/// A socket read timeout (`SO_RCVTIMEO`) is a hard cutoff: a single `read_line`
/// fails the instant that timeout expires. On **Windows** the expiry maps to
/// `WSAETIMEDOUT` — `Os { code: 10060, kind: TimedOut }` — so a loaded Windows CI
/// runner that answers an RPC (or replays a reconnect buffer) slower than one
/// tight timeout would 10060 the whole test even though the agent is healthy and
/// the response is merely late. The connect facet was fixed by
/// [`connect_with_retry`] (#2492); this is its read-side mirror, covering every
/// response read in the suite (the [`AgentClient`] and the simple [`rpc`] helper).
///
/// Instead of one tight cutoff this loops a *short* per-read timeout
/// ([`READ_POLL_TIMEOUT`]) up to a generous total `deadline`: every
/// `WouldBlock`/`TimedOut` expiry just re-checks the clock and retries. Partial
/// bytes already appended by a timed-out `read_line` are preserved by
/// `BufRead::read_until` (the wire is ASCII JSON, so a per-read boundary never
/// splits a multi-byte char), so a retry resumes the same line rather than losing
/// it.
///
/// The deadline is **bounded**, so the assertion stays genuine: a genuinely
/// stalled or never-responding agent still fails once `deadline` elapses — the
/// read never blocks forever and no real hang is swallowed. Returns the bytes
/// appended (`0` = clean EOF), or the last timeout error once the deadline passes.
fn read_line_until_deadline(
    reader: &mut BufReader<TcpStream>,
    line: &mut String,
    deadline: Instant,
) -> std::io::Result<usize> {
    reader
        .get_ref()
        .set_read_timeout(Some(READ_POLL_TIMEOUT))
        .expect("set_read_timeout");
    let start_len = line.len();
    loop {
        match reader.read_line(line) {
            // `read_line` returns `Ok` only at a newline or EOF — either way this
            // line is complete (or the stream ended). Report total bytes read.
            Ok(_) => return Ok(line.len() - start_len),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                // Slow-but-responding agent: the per-read window lapsed with the
                // line not yet complete. Retry until the bounded deadline, then
                // surface the timeout so a real hang still fails the test.
                if Instant::now() >= deadline {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// Send a single NDJSON line and return the first response line.
fn rpc(stream: &mut TcpStream, msg: &str) -> String {
    let mut line = msg.trim().to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).expect("write failed");

    let mut reader = BufReader::new(stream.try_clone().expect("clone failed"));
    let mut response = String::new();
    // Label the read with the request method so a slow first response is
    // attributed to the right call in a Windows-CI failure (#2495 facet 3).
    let label = serde_json::from_str::<Value>(msg)
        .ok()
        .and_then(|v| v.get("method").and_then(|m| m.as_str()).map(str::to_owned))
        .unwrap_or_else(|| "rpc".to_string());
    read_response_line(&mut reader, &mut response, &label);
    response.trim().to_string()
}

/// The bounded read must still FAIL on a genuinely non-responding peer once its
/// deadline elapses — it widens the window for a slow-but-live agent, it does not
/// turn a real hang into a pass (#2493). Uses a raw listener that accepts but
/// never answers, so no agent binary is involved.
#[test]
fn read_line_until_deadline_fails_fast_on_silent_peer() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    // Accept the connection and hold it open without ever writing a byte.
    let server = std::thread::spawn(move || {
        if let Ok((sock, _)) = listener.accept() {
            std::thread::sleep(Duration::from_secs(5));
            drop(sock);
        }
    });

    let stream = TcpStream::connect(addr).expect("connect");
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let started = Instant::now();
    let deadline = started + Duration::from_millis(750);
    let result = read_line_until_deadline(&mut reader, &mut line, deadline);
    let elapsed = started.elapsed();

    assert!(
        result.is_err(),
        "a silent peer must time out at the deadline, not read a line: {result:?}"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "bounded read must fail near its deadline, not block indefinitely — took {elapsed:?}"
    );

    drop(reader);
    server.join().ok();
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

// ── Concurrency-gate unit tests (#2495) ──────────────────────────────────────

/// The env parser accepts a positive integer and rejects everything else
/// (falling back to the platform default), so an absent/garbage override never
/// silently disables the gate or panics.
#[test]
fn max_concurrent_parses_positive_and_falls_back_otherwise() {
    assert_eq!(parse_max_concurrent(Some("3".to_string()), 99), 3);
    assert_eq!(
        parse_max_concurrent(Some("  4 ".to_string()), 99),
        4,
        "surrounding whitespace is tolerated"
    );
    // Absent / empty / non-numeric / zero all mean "use the default".
    assert_eq!(parse_max_concurrent(None, 99), 99);
    assert_eq!(parse_max_concurrent(Some(String::new()), 99), 99);
    assert_eq!(parse_max_concurrent(Some("nope".to_string()), 99), 99);
    assert_eq!(
        parse_max_concurrent(Some("0".to_string()), 99),
        99,
        "zero is meaningless as a cap — fall back rather than deadlock"
    );
}

/// The counting semaphore blocks a would-be third holder while two permits are
/// out, and hands the slot on the instant one is returned — proving the gate
/// bounds concurrency without deadlocking or dropping a permit. Runs on every
/// platform against a *local* `AgentSlots`, so it exercises the primitive that
/// backs the global gate without touching the process-wide `OnceLock`.
#[test]
fn agent_slots_bounds_concurrency_and_hands_off() {
    use std::sync::Arc;

    let slots = Arc::new(AgentSlots::with_permits(2));
    // Take both permits: the gate is now saturated.
    slots.take();
    slots.take();

    // A third acquirer must block until a permit is returned.
    let acquired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let waiter = {
        let slots = Arc::clone(&slots);
        let acquired = Arc::clone(&acquired);
        std::thread::spawn(move || {
            slots.take();
            acquired.store(true, Ordering::SeqCst);
        })
    };

    // Give the waiter a moment; it must still be blocked (no permit free).
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !acquired.load(Ordering::SeqCst),
        "third acquirer must block while both permits are out"
    );

    // Return one permit → the waiter must proceed promptly.
    slots.give();
    let started = Instant::now();
    while !acquired.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        acquired.load(Ordering::SeqCst),
        "waiter must acquire the freed permit within the timeout"
    );
    waiter.join().expect("waiter thread panicked");

    // Balance the books so no permit is leaked (two still held by this test).
    slots.give();
    slots.give();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
fn agent_starts_and_accepts_connections() {
    let agent = LocalAgent::spawn();
    // If we reach here, the agent bound a port and served the readiness probe
    // to completion (accept loop is live and idle).
    assert!(!agent.addr.is_empty());
}

#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
    ///
    /// Uses the bounded, timeout-retrying [`read_line_until_deadline`] so a slow
    /// Windows-CI response — the reconnect/replay read is the slowest — does not
    /// 10060 the test on a single `SO_RCVTIMEO` expiry (#2493), while a genuinely
    /// stalled agent still fails once the deadline elapses.
    fn read_one(&mut self, label: &str) -> Value {
        let mut line = String::new();
        read_response_line(&mut self.reader, &mut line, label);
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
            let msg = self.read_one(method);
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

    /// Accumulate `connection.output` and track the **highest** integer that
    /// follows `prefix` (e.g. `TICK=` → the max `N` in `TICK=N`). Returns as soon
    /// as `done(max)` is satisfied (with that max), or the running max seen when
    /// `timeout` elapses, or `None` if no such counter was ever observed.
    ///
    /// Decoded output is appended to a single accumulator and re-parsed each round
    /// so a counter split across two output notifications (PTY chunking, or a big
    /// buffer replay arriving in pieces) is still recognised once both halves land.
    fn track_counter(
        &mut self,
        prefix: &str,
        timeout: Duration,
        mut done: impl FnMut(u64) -> bool,
    ) -> Option<u64> {
        let deadline = Instant::now() + timeout;
        self.set_read_timeout(Some(Duration::from_millis(100)));
        let mut acc = String::new();
        let mut max: Option<u64> = None;
        while Instant::now() < deadline {
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
                            acc.push_str(&String::from_utf8_lossy(&bytes));
                            for v in counters_in(&acc, prefix) {
                                if max.is_none_or(|m| v > m) {
                                    max = Some(v);
                                }
                            }
                            if let Some(m) = max {
                                if done(m) {
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    // per-read timeout — loop and re-check the overall deadline
                }
                Err(_) => break,
            }
        }
        self.set_read_timeout(Some(RPC_READ_TIMEOUT));
        max
    }

    /// Count how many times `needle` appears across all `connection.output`
    /// delivered on this connection, reading until output goes quiet for `settle`
    /// after the first sighting (an idle shell naturally stops emitting once its
    /// buffer replay is delivered) or `overall` elapses. Occurrences are counted
    /// over one accumulator so a needle split across notifications still counts
    /// once, and only non-overlapping matches are counted.
    fn count_output_occurrences(
        &mut self,
        needle: &str,
        settle: Duration,
        overall: Duration,
    ) -> usize {
        let deadline = Instant::now() + overall;
        self.set_read_timeout(Some(Duration::from_millis(100)));
        let mut acc = String::new();
        let mut seen = false;
        let mut last_data = Instant::now();
        while Instant::now() < deadline {
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
                            acc.push_str(&String::from_utf8_lossy(&bytes));
                            last_data = Instant::now();
                            if acc.contains(needle) {
                                seen = true;
                            }
                        }
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    // Once the token has arrived and output has been quiet for
                    // `settle`, a duplicate replay would already have landed — stop.
                    if seen && last_data.elapsed() >= settle {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        self.set_read_timeout(Some(RPC_READ_TIMEOUT));
        acc.matches(needle).count()
    }
}

/// Extract every unsigned integer that immediately follows `prefix` in `text`,
/// in order of appearance. `counters_in("a TICK=1 b TICK=42", "TICK=")` →
/// `[1, 42]`. A `prefix` occurrence not followed by a digit (e.g. the shell's
/// echo of the literal loop command `echo TICK=$i`) contributes nothing.
fn counters_in(text: &str, prefix: &str) -> Vec<u64> {
    // `match_indices` yields each non-overlapping match start (a valid char
    // boundary), and `idx + prefix.len()` is also a boundary because `prefix` is
    // ASCII — so slicing here is always safe even though `text` carries ANSI
    // escapes and multibyte prompt glyphs. Trailing digits are read via `chars()`.
    text.match_indices(prefix)
        .filter_map(|(idx, _)| {
            let after = &text[idx + prefix.len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().ok()
        })
        .collect()
}

// ── Shell session tests ───────────────────────────────────────────────────────

/// Verify that creating a local shell session returns a valid session ID with
/// status "running". This is the prerequisite for all other shell tests.
#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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

// ── Fresh-after-reconnect create over a surviving registry (#2476 / #2480) ─────
//
// The ventilator hot path the maintainer hit live: an agent connected with a
// live session, its SSH transport drops, the transport is re-established, and
// the desktop stands a **fresh** `termihub-agent` process up over it and drives
// a fresh `connection.create` — yet the tab stays stuck "Reconnecting", no
// connection comes back (#2476). #2480 localises the suspicion to the ADR-11
// host-wide **registry-daemon handshake** stalling for that fresh agent when a
// registry daemon from the *prior* agent is still running.
//
// This is the headless analog: the agent crate can stand up a real agent over a
// real local transport with no GUI/webview, so the registry-daemon handshake and
// the fresh `connection.create` are exercised for real, and a stall FAILS the
// test instead of hanging a display-backed run.

/// A fresh agent process, standing up over a re-established transport while a
/// registry daemon spawned by the *prior* agent is still alive, must complete
/// `initialize` + a fresh `connection.create` and reach a usable session —
/// without stalling on the ADR-11 registry-daemon handshake (#2476 / #2480).
///
/// Regression contract: [`crate::registry_daemon::client`]'s registry client is
/// non-blocking and infallible by design (register is fire-and-forget, `list`
/// times out to a fallback), so a surviving-registry handshake must never sit on
/// the `connection.create` path. This test proves that end to end over a real
/// transport; a real stall makes `create_elapsed` blow past the ceiling (or the
/// echo never arrives) rather than wedging the suite forever.
#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
fn fresh_agent_after_reconnect_creates_session_over_surviving_registry() {
    // A registry endpoint the *test* owns, so it survives agent A's death — the
    // headless stand-in for the host-wide registry daemon that outlives an agent
    // process swap (ADR-11). Both agents point here.
    let registry_dir = TempDir::new().expect("failed to create registry temp dir");
    let registry_endpoint = registry_endpoint_in(registry_dir.path(), "shared");

    // ── Agent A: connect, create a live session (this spawns the registry) ────
    {
        let agent_a = LocalAgent::spawn_with_registry(&registry_endpoint);
        let mut client = AgentClient::connect(&agent_a.addr);
        client.initialize();
        let sid = client.create_shell_session("pre-drop");
        let attach = client.attach(&sid);
        assert!(
            attach["result"].is_object(),
            "agent A attach failed: {attach}"
        );
        client.write_input(&sid, "echo agent-a-alive-marker\n");
        assert!(
            client.wait_for_output("agent-a-alive-marker"),
            "agent A shell never produced output — precondition not met"
        );

        // The registry daemon must genuinely be up: it is the "surviving
        // registry" the fresh agent will meet. `initialize` starts the join in
        // the background, so poll rather than assume it has bound yet.
        assert!(
            wait_until(|| endpoint_reachable(&registry_endpoint), ready_timeout()),
            "registry daemon never became reachable at {registry_endpoint} — \
             precondition not met"
        );
        // `agent_a` drops here: the listener process is killed, modelling the
        // transport drop that takes the remote agent with it. The detached
        // registry daemon is designed to outlive it.
    }

    // The registry must have survived the agent that spawned it — otherwise this
    // would not exercise the "fresh agent meets a *pre-existing* registry" case
    // #2480 points at.
    assert!(
        endpoint_reachable(&registry_endpoint),
        "registry daemon did not survive the agent process that spawned it — \
         cannot exercise the surviving-registry handshake"
    );

    // ── Agent B: the fresh agent the reconnect stands up over the re-established
    // transport. `initialize` + `connection.create` must complete even though a
    // registry daemon from agent A is already running. Time the whole path so a
    // stall on the registry handshake is caught as a bounded FAILURE.
    let started = Instant::now();
    let agent_b = LocalAgent::spawn_with_registry(&registry_endpoint);
    let mut client = AgentClient::connect(&agent_b.addr);
    client.initialize();
    let sid = client.create_shell_session("post-reconnect");
    let create_elapsed = started.elapsed();

    let attach = client.attach(&sid);
    assert!(
        attach["result"].is_object(),
        "agent B attach failed: {attach}"
    );
    client.write_input(&sid, "echo agent-b-fresh-marker\n");
    assert!(
        client.wait_for_output("agent-b-fresh-marker"),
        "fresh-after-reconnect agent shell never produced output — the session \
         reached over the surviving registry is unusable (the live 'stuck \
         Reconnecting' symptom)"
    );

    // The registry join is background + non-blocking by contract, so a fresh
    // create must not wait on it. The ceiling reuses the shared readiness budget
    // (env-overridable) so a slow CI shell cold-start never flakes it, while a
    // genuine handshake stall — which in the field looked like a wedged connect —
    // still trips it.
    assert!(
        create_elapsed < ready_timeout(),
        "fresh-after-reconnect initialize+create took {create_elapsed:?}, over the \
         {:?} ceiling — the registry-daemon handshake appears to stall the create \
         path (#2480)",
        ready_timeout()
    );

    client.close(&sid);
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
    /// Concurrency-gate permit for this live agent process (#2495), released on
    /// drop after the process is reaped.
    _slot: AgentSlot,
}

#[cfg(unix)]
impl IsolatedAgent {
    fn spawn(xdg_home: &std::path::Path) -> Self {
        // spawn_ready_listener waits until the accept loop is idle (after
        // recover_sessions() finishes) and retries on a port collision.
        let registry_endpoint = registry_endpoint_in(xdg_home, "reg");
        let (process, addr, stderr, slot) =
            spawn_ready_listener(xdg_home, &registry_endpoint, Some("warn"));
        IsolatedAgent {
            process,
            addr,
            _stderr: stderr,
            _slot: slot,
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

/// A **detached, `setsid`'d session daemon** plus its persisted `AgentState`,
/// deliberately owned by the *test* rather than by any agent process. This is the
/// scaffold for the cross-agent recovery tests: an agent spawned against
/// [`Self::tmp_path`] recovers this daemon on startup (`recover_sessions()`), and
/// killing that agent process never touches the daemon — exactly the invariant a
/// faithful SSH-transport drop preserves (the daemon reparents to PID 1 and lives
/// on). See [`fresh_agent_recovers_daemon_session_from_dead_prior_agent`], which
/// this generalises.
#[cfg(unix)]
struct RecoverableDaemon {
    _tmp: TempDir,
    tmp_path: PathBuf,
    daemon: Child,
    /// Captured daemon stderr, kept alive for startup-failure diagnostics.
    _daemon_stderr: NamedTempFile,
    socket_path: PathBuf,
    session_id: String,
}

#[cfg(unix)]
impl RecoverableDaemon {
    fn new() -> Self {
        let tmp = TempDir::new().expect("failed to create temp dir");
        let tmp_path = tmp.path().to_path_buf();
        let session_id = test_session_id();
        let socket_path = tmp_path.join(format!("session-{session_id}.sock"));

        let (mut daemon, daemon_stderr) = spawn_daemon_for_local_shell(&session_id, &socket_path);
        wait_for_socket(
            &mut daemon,
            &socket_path,
            daemon_stderr.path(),
            ready_timeout(),
        );

        // Persist the daemon session so every agent started against this config dir
        // recovers it on startup — the same record a persistent session's
        // `connection.create` writes.
        let state_dir = tmp_path.join("termihub-agent");
        std::fs::create_dir_all(&state_dir).expect("create state dir");
        let state_json = json!({
            "sessions": {
                &session_id: {
                    "type_id": "local",
                    "title": "reattach-mechanic-shell",
                    "created_at": "2024-01-01T00:00:00+00:00",
                    "daemon_socket": socket_path.to_str().expect("socket path not UTF-8"),
                    "settings": {}
                }
            }
        });
        std::fs::write(state_dir.join("state.json"), state_json.to_string())
            .expect("write state.json");

        RecoverableDaemon {
            _tmp: tmp,
            tmp_path,
            daemon,
            _daemon_stderr: daemon_stderr,
            socket_path,
            session_id,
        }
    }

    /// The daemon's socket still exists and its process has not exited — i.e. the
    /// detached session genuinely survived whatever agent process was attached to
    /// it. A `false` here is the #2508 drop-harness signature (the daemon reaped
    /// with the agent).
    fn alive(&mut self) -> bool {
        self.socket_path.exists() && matches!(self.daemon.try_wait(), Ok(None))
    }
}

#[cfg(unix)]
impl Drop for RecoverableDaemon {
    fn drop(&mut self) {
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
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

/// A **fresh agent process** must recover a session daemon spawned under a
/// **prior, now-dead** agent process and re-attach the *original* session —
/// not fall back to a brand-new one.
///
/// This is the headless analog of the live #2476 agent-reconnect recovery path,
/// and the exact positive case that had no automated coverage and that failed in
/// the live grade (because the drop harness was killing the detached daemon; see
/// #2508). The real reconnect flow is:
///
///   1. an agent process is attached to a detached, `setsid`'d session daemon;
///   2. the SSH transport drops and takes the agent process with it (its stdio
///      hits EOF and it exits) — but the daemon, reparented to PID 1, survives;
///   3. the reconnect stands up a *fresh* agent process against the same per-user
///      state/socket dir, which calls `recover_sessions()` and re-attaches the
///      surviving daemon, replaying its ring buffer.
///
/// The test reproduces that with an agent-process swap over a genuinely surviving
/// daemon: agent A recovers the daemon session and writes a marker into it; agent
/// A's **process** is then killed (like [`LocalAgent`]/[`IsolatedAgent`]'s `Drop`
/// — leaving the separately-spawned daemon alive); a fresh agent B, pointed at the
/// same config/state dir, must recover the **same** session id and replay the
/// marker on re-attach. A regression that reaped the daemon with the agent (the
/// #2508 drop-harness bug) fails here: agent B would find a dead endpoint, drop
/// the session from state, and expose no session to re-attach.
#[cfg(unix)]
#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
fn fresh_agent_recovers_daemon_session_from_dead_prior_agent() {
    // ── Shared, agent-independent state: a temp dir + a manually-spawned daemon.
    // The daemon stands in for the detached, `setsid`'d session daemon that
    // outlives any single agent process. Because it is spawned by the *test*
    // (not a child of either agent), killing an agent process never touches it —
    // exactly the invariant a faithful transport drop preserves.
    let tmp = TempDir::new().expect("failed to create temp dir");
    let tmp_path = tmp.path().to_path_buf();
    let session_id = test_session_id();
    let socket_path = tmp_path.join(format!("session-{session_id}.sock"));

    let (mut daemon, daemon_stderr) = spawn_daemon_for_local_shell(&session_id, &socket_path);
    wait_for_socket(
        &mut daemon,
        &socket_path,
        daemon_stderr.path(),
        ready_timeout(),
    );

    // Persist the daemon session so every agent that starts against this config
    // dir recovers it on startup (`recover_sessions()`), the same record a real
    // persistent session's `connection.create` writes.
    let state_dir = tmp_path.join("termihub-agent");
    std::fs::create_dir_all(&state_dir).expect("create state dir");
    let state_json = json!({
        "sessions": {
            &session_id: {
                "type_id": "local",
                "title": "reconnect-recovery-shell",
                "created_at": "2024-01-01T00:00:00+00:00",
                "daemon_socket": socket_path.to_str().expect("socket path not UTF-8"),
                "settings": {}
            }
        }
    });
    std::fs::write(state_dir.join("state.json"), state_json.to_string()).expect("write state.json");

    let marker = "termihub-agent-swap-marker-2508";

    // ── Agent A: recover the daemon session, attach, write a marker ───────────
    {
        let agent_a = IsolatedAgent::spawn(&tmp_path);
        let mut client = AgentClient::connect(&agent_a.addr);
        client.initialize();

        // The session recovered from state must be present and match our id.
        let entry = client
            .list_sessions()
            .into_iter()
            .find(|s| s["session_id"].as_str() == Some(session_id.as_str()))
            .expect("agent A did not recover the daemon session from state.json");
        assert_eq!(
            entry["status"], "running",
            "recovered session not running under agent A: {entry}"
        );

        let ar = client.attach(&session_id);
        assert!(ar["result"].is_object(), "agent A attach failed: {ar}");

        let wr = client.write_input(&session_id, &format!("echo {marker}\n"));
        assert!(wr["result"].is_object(), "agent A write failed: {wr}");
        assert!(
            client.wait_for_output(marker),
            "agent A never saw its marker echoed — precondition (a live daemon \
             session under the prior agent) not met"
        );

        // `agent_a` drops here: its process is killed (SIGKILL, as
        // `IsolatedAgent::Drop` does), modelling the transport drop that takes
        // the remote agent process with it. The separately-spawned daemon is
        // untouched and stays alive.
    }

    // The daemon must have survived the agent process that was attached to it —
    // otherwise this would not exercise the "fresh agent recovers a *surviving*
    // daemon" case, and would instead be the #2508 false-failure it guards against.
    assert!(
        socket_path.exists() && matches!(daemon.try_wait(), Ok(None)),
        "session daemon did not survive agent A's death — cannot exercise \
         cross-agent recovery (this is the #2508 drop-harness bug's signature)"
    );

    // ── Agent B: a *fresh* process recovers the surviving daemon ──────────────
    let agent_b = IsolatedAgent::spawn(&tmp_path);
    let mut client = AgentClient::connect(&agent_b.addr);
    client.initialize();

    // Agent B must re-attach the ORIGINAL session, not create a new one: the
    // recovered list must hold exactly the same id agent A used.
    let sessions = client.list_sessions();
    let recovered_ids: Vec<&str> = sessions
        .iter()
        .filter_map(|s| s["session_id"].as_str())
        .collect();
    assert!(
        recovered_ids.contains(&session_id.as_str()),
        "fresh agent B did not recover the original session {session_id} — \
         recovery fell back to a new session instead of re-attaching the \
         surviving daemon (the live 'stuck Reconnecting -> new shell' symptom); \
         recovered ids: {recovered_ids:?}"
    );
    assert_eq!(
        recovered_ids.len(),
        1,
        "expected exactly the one surviving session after cross-agent recovery, \
         got {recovered_ids:?}"
    );

    // Re-attach over the fresh agent: the daemon replays its ring buffer, which
    // must still contain the marker agent A wrote before it died — proving the
    // ORIGINAL session state survived the agent-process swap.
    let ar = client.attach(&session_id);
    assert!(ar["result"].is_object(), "agent B re-attach failed: {ar}");
    assert!(
        client.wait_for_output(marker),
        "buffer replay after cross-agent recovery did not contain '{marker}' — \
         the fresh agent did not re-attach the original daemon session's state"
    );

    client.close(&session_id);

    // Explicitly reap the daemon (the test owns it; no scaffold Drop does it).
    daemon.kill().ok();
    daemon.wait().ok();
}

/// The recovered shell is the **same live process**, so in-memory shell state set
/// before a reconnect survives it. A variable set under agent A must still be
/// readable after agent A's process dies and a fresh agent B recovers the
/// surviving daemon — the mechanic the live agent-reattach feature promises
/// (#2512): the process (and its state) genuinely continues across the drop, it
/// is not restarted.
///
/// The read-back token is composed so a false positive is impossible: agent A
/// sets `MYVAR=hello123` (whose keystroke echo, replayed to agent B on attach,
/// contains only the bare value), while agent B reads it via
/// `echo VARWAS-${MYVAR}-END`. The composed string `VARWAS-hello123-END` can be
/// produced **only** by the live shell expanding a still-set `MYVAR` — it never
/// appears in the replayed keystroke echo of either command. If recovery had
/// silently minted a fresh shell, `MYVAR` would be unset and the expansion would
/// yield `VARWAS--END`, so the probe would never arrive.
#[cfg(unix)]
#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
fn recovered_shell_preserves_environment_variable_across_agent_swap() {
    let mut daemon = RecoverableDaemon::new();
    let value = "hello123";

    // ── Agent A: recover the daemon session, attach, set a shell variable ──────
    {
        let agent_a = IsolatedAgent::spawn(&daemon.tmp_path);
        let mut client = AgentClient::connect(&agent_a.addr);
        client.initialize();

        let entry = client
            .list_sessions()
            .into_iter()
            .find(|s| s["session_id"].as_str() == Some(daemon.session_id.as_str()))
            .expect("agent A did not recover the daemon session from state.json");
        assert_eq!(
            entry["status"], "running",
            "recovered session not running under agent A: {entry}"
        );

        let ar = client.attach(&daemon.session_id);
        assert!(ar["result"].is_object(), "agent A attach failed: {ar}");

        // Set the variable, then echo a readiness marker so we know the shell has
        // executed the assignment before agent A's process is killed.
        client.write_input(&daemon.session_id, &format!("MYVAR={value}\n"));
        let ready = "termihub-varset-ready";
        client.write_input(&daemon.session_id, &format!("echo {ready}\n"));
        assert!(
            client.wait_for_output(ready),
            "agent A shell never echoed the readiness marker — the assignment may \
             not have been applied before the drop"
        );

        // agent_a drops → its process is SIGKILL'd; the daemon (and the live shell
        // holding MYVAR in memory) is untouched and keeps running.
    }

    assert!(
        daemon.alive(),
        "session daemon did not survive agent A's death — cannot exercise \
         cross-agent state persistence (the #2508 drop-harness signature)"
    );

    // ── Agent B: a fresh process recovers the surviving shell and reads MYVAR ──
    let agent_b = IsolatedAgent::spawn(&daemon.tmp_path);
    let mut client = AgentClient::connect(&agent_b.addr);
    client.initialize();

    assert!(
        client
            .list_sessions()
            .iter()
            .any(|s| s["session_id"].as_str() == Some(daemon.session_id.as_str())),
        "fresh agent B did not recover the original session {} — recovery fell \
         back to a new shell instead of re-attaching the surviving daemon",
        daemon.session_id
    );

    let ar = client.attach(&daemon.session_id);
    assert!(ar["result"].is_object(), "agent B attach failed: {ar}");

    // Read the variable back through a composed token that cannot be satisfied by
    // the replayed keystroke echo — only by the live shell still holding MYVAR.
    let probe = format!("VARWAS-{value}-END");
    client.write_input(&daemon.session_id, "echo VARWAS-${MYVAR}-END\n");
    assert!(
        client.wait_for_output(&probe),
        "'{probe}' never arrived — MYVAR did not survive the agent-process swap, \
         so the recovered shell was NOT the same live process (it was restarted)"
    );

    client.close(&daemon.session_id);
}

/// The headline guarantee of live reattach: the shell **and its running work keep
/// executing while nothing is attached**, then continue after recovery — it never
/// pauses or restarts across the disconnect (#2512).
///
/// A self-incrementing loop (`TICK=$i`, +1 every 0.2 s) runs under agent A. Agent
/// A's process is killed (the daemon + loop survive), and the test waits a bounded
/// "disconnected" gap during which no agent is attached at all. A fresh agent B
/// then recovers the session; because the loop kept running through the gap, its
/// counter has advanced **strictly beyond** the last value seen before the drop —
/// a restart would have reset it to 0, and a pause would have left it unchanged.
/// After draining the replay, a further strictly-greater value proves the same
/// live loop is still producing output post-recovery (not merely replaying old
/// buffer). Both checks use bounded polling on the counter value, never fixed
/// sleeps keyed to output timing, so they are deterministic under CI load.
#[cfg(unix)]
#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
fn daemon_shell_keeps_running_during_disconnect_and_after_recovery() {
    let mut daemon = RecoverableDaemon::new();
    let prefix = "TICK=";

    // ── Agent A: attach, start the self-incrementing loop, note its progress ───
    let before;
    {
        let agent_a = IsolatedAgent::spawn(&daemon.tmp_path);
        let mut client = AgentClient::connect(&agent_a.addr);
        client.initialize();

        let ar = client.attach(&daemon.session_id);
        assert!(ar["result"].is_object(), "agent A attach failed: {ar}");

        // A POSIX loop that emits a monotonically increasing counter forever. Its
        // keystroke echo contains `TICK=$i` (no digit after `TICK=`), which
        // `counters_in` ignores, so only executed output contributes counters.
        client.write_input(
            &daemon.session_id,
            "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n",
        );

        before = client
            .track_counter(prefix, ready_timeout(), |m| m >= 3)
            .expect("loop never produced TICK counters under agent A");
        assert!(
            before >= 3,
            "loop not clearly running before the drop: before={before}"
        );

        // agent_a drops → process SIGKILL'd; the daemon + looping shell live on.
    }

    assert!(
        daemon.alive(),
        "session daemon did not survive agent A while the loop was running \
         (the #2508 drop-harness signature)"
    );

    // Disconnected gap: NO agent is attached, yet the shell must keep ticking.
    // ~0.2 s cadence over 1.5 s ⇒ several increments produced with nobody watching.
    std::thread::sleep(Duration::from_millis(1500));

    // ── Agent B: recover + attach; the replay must carry gap-produced ticks ────
    let agent_b = IsolatedAgent::spawn(&daemon.tmp_path);
    let mut client = AgentClient::connect(&agent_b.addr);
    client.initialize();

    let ar = client.attach(&daemon.session_id);
    assert!(ar["result"].is_object(), "agent B attach failed: {ar}");

    // Advanced ACROSS the disconnect: a counter strictly greater than the last
    // pre-drop value proves the loop neither paused (would be unchanged) nor
    // restarted (would reset to 0) while detached.
    let after_gap = client
        .track_counter(prefix, ready_timeout(), |m| m > before)
        .expect("no TICK counters after recovery — the loop did not survive");
    assert!(
        after_gap > before,
        "counter did not advance across the disconnect: before={before}, \
         after_gap={after_gap} — the process paused or was restarted"
    );

    // Drain the (small, instantly-delivered) replay to catch up to the live head,
    // then require a further strictly-greater value: that can come only from NEW
    // output the still-running loop produces after recovery, not from the replay.
    let base = client
        .track_counter(prefix, Duration::from_millis(600), |_| false)
        .expect("no output while draining the replay");
    let after_live = client
        .track_counter(prefix, ready_timeout(), |m| m > base)
        .expect("counter stopped advancing after recovery");
    assert!(
        after_live > base,
        "counter stopped advancing after recovery: base={base}, \
         after_live={after_live} — the live process did not continue"
    );

    client.close(&daemon.session_id);
}

/// The recovered session's ring buffer must be replayed **exactly once** to a
/// freshly-attached client — the agent layer must not duplicate it. This guards
/// the layer directly beneath the frontend duplicate-render bug seen in live
/// testing: if the double appears here, it is an agent bug; if the agent delivers
/// exactly one copy, any user-visible duplication is above this layer (frontend).
///
/// A token that occurs exactly once in the buffer is produced via a variable so
/// neither command's keystroke echo contains it: `M=<tag>` then `echo mark-${M}-end`
/// yields the composed `mark-<tag>-end` only in the executed output. A *fresh* TCP
/// connection then re-attaches (it never saw the live output), so every occurrence
/// it receives comes from the replay — and there must be exactly one.
#[cfg(unix)]
#[test]
#[cfg_attr(
    windows,
    ignore = "flaky under Windows-runner oversubscription; see #2495"
)]
fn recovered_session_buffer_replayed_exactly_once_on_reattach() {
    let setup = PersistentShellSetup::new();
    let tag = "REPLAYONCE-7f3a2b1c";
    let composed = format!("mark-{tag}-end");

    // ── Connection 1: attach, produce the token exactly once, TCP disconnect ───
    {
        let mut client = setup.connect_client();

        let ar = client.attach(&setup.session_id);
        assert!(ar["result"].is_object(), "first attach failed: {ar}");

        client.write_input(&setup.session_id, &format!("M={tag}\n"));
        client.write_input(&setup.session_id, "echo mark-${M}-end\n");
        assert!(
            client.wait_for_output(&composed),
            "token '{composed}' not produced on the first connection — shell not \
             responding"
        );
        // Drop: TCP closes → agent detaches; daemon keeps the shell + ring buffer.
    }

    // ── Connection 2: fresh TCP; the replay must deliver the token exactly once ─
    let mut client = setup.connect_client();
    let session_id = setup.session_id.clone();
    assert!(
        wait_until(|| client.session_detached(&session_id), ready_timeout()),
        "session {session_id} not reported detached after TCP reconnect"
    );

    let ar = client.attach(&setup.session_id);
    assert!(ar["result"].is_object(), "re-attach failed: {ar}");

    let count =
        client.count_output_occurrences(&composed, Duration::from_millis(800), ready_timeout());
    assert_eq!(
        count, 1,
        "recovered buffer delivered '{composed}' {count} time(s) to a fresh \
         client, expected exactly once — an agent-layer duplicate replay"
    );

    client.close(&setup.session_id);
}
