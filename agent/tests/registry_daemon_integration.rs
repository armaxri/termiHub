//! End-to-end tests for the host-wide registry daemon (#1574, ADR-11).
//!
//! These spawn **real** `termihub-agent` processes — two `--listen` workers and
//! a `--registry-daemon` — and drive them over real sockets. Nothing here is
//! mocked, because the claim being tested is exactly the one a mock cannot
//! support: that two *separate agent processes* on one host can see each other.
//!
//! # Isolation
//!
//! The registry endpoint is a fixed per-user path by design (that is what makes
//! it findable). Tests must therefore never touch the live one: every test
//! points its agents at a **unique** endpoint via `TERMIHUB_REGISTRY_ENDPOINT`,
//! which the spawned agents pass on to any registry they spawn through the
//! inherited environment. Without this, these tests would fight each other, the
//! developer's own agents, and the parallel development checkouts, all over one
//! rendezvous. On unix the endpoint is a `.sock` inside a per-test `TempDir`; on
//! windows it is a per-test `\\.\pipe\` name (the `\\.\pipe\` namespace has no
//! directory to scope it, so uniqueness comes from the name itself — see
//! [`unique_endpoint`]).
//!
//! # Cross-platform
//!
//! The registry speaks the same length-prefixed frames over a **unix domain
//! socket** on unix and a **windows named pipe** on windows, and the named-pipe
//! endpoint is a genuinely distinct code path (its name embeds `%USERNAME%`
//! because there is no `0o700` socket-dir analog to scope it). So this suite
//! runs on **both** platforms: the process-spawning and TCP JSON-RPC scaffolding
//! is already portable, and the two things that were not — the raw
//! frame-speaking [`RawWorker`] transport and the endpoint-readiness probe — are
//! abstracted over the platform ([`RawTransport`], [`endpoint_reachable`]) so
//! every scenario is proven on the wire the production agent actually uses.
//!
//! ```sh
//! cargo test -p termihub-agent --test registry_daemon_integration
//! ```

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::TempDir;

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

/// Generous per-RPC read timeout: a cold-started agent's first response can be
/// slow on a loaded runner, and a timeout here would read as a registry failure
/// when it is really just a slow start.
const RPC_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait for an agent's TCP port to accept connections.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

// ── Process handles ───────────────────────────────────────────────────────────

/// A spawned agent process, killed on drop so a failing assertion never leaks it.
struct AgentProcess {
    child: Child,
    addr: String,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A spawned registry daemon, killed on drop.
struct RegistryProcess {
    child: Child,
}

impl Drop for RegistryProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn an agent in `--listen` mode pointed at `registry_endpoint`, and learn
/// the port it actually bound.
///
/// Asks the OS for a port via `:0` and reads the real one back off the agent's
/// own startup log, rather than reserving a port in the test and handing it over
/// to the agent. That handover looks harmless and is not: between the test
/// releasing the port and the agent binding it, another concurrently running
/// agent can take it — and then the test's readiness probe *succeeds against the
/// wrong process* while its own agent has already died on `AddrInUse`. The
/// symptom is a "Connection reset by peer" halfway through an unrelated
/// assertion. Binding `:0` in the agent itself closes the window completely:
/// the port cannot be taken because it is never free.
fn spawn_agent(registry_endpoint: &str) -> AgentProcess {
    spawn_agent_inner(registry_endpoint, false)
}

/// Like [`spawn_agent`] but with `TERMIHUB_AGENT_SKIP_REGISTRY_DAEMON=1`, the
/// single-client opt-out the system-test harness sets (#2480). The agent must
/// still serve `initialize`/RPC, but must never spawn a registry daemon.
fn spawn_agent_skipping_registry(registry_endpoint: &str) -> AgentProcess {
    spawn_agent_inner(registry_endpoint, true)
}

fn spawn_agent_inner(registry_endpoint: &str, skip_registry_daemon: bool) -> AgentProcess {
    let mut command = Command::new(agent_binary());
    command
        .arg("--listen")
        .arg("127.0.0.1:0")
        .env("TERMIHUB_REGISTRY_ENDPOINT", registry_endpoint);
    if skip_registry_daemon {
        command.env("TERMIHUB_AGENT_SKIP_REGISTRY_DAEMON", "1");
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn agent");

    let stderr = child.stderr.take().expect("piped stderr");
    let addr = read_listen_addr(stderr);
    AgentProcess { child, addr }
}

/// Read the agent's `Listening on <addr>` startup line, then keep the pipe
/// drained.
///
/// The log line is emitted immediately after a successful `bind`, so seeing it
/// means the port is already accepting — no readiness polling needed. The
/// draining thread matters: a piped stderr nobody reads eventually fills its
/// buffer and blocks the agent mid-test.
fn read_listen_addr(stderr: std::process::ChildStderr) -> String {
    let mut reader = BufReader::new(stderr);
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut addr = None;

    while Instant::now() < deadline {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // agent exited before binding
            Ok(_) => {
                if let Some(rest) = line.split("Listening on ").nth(1) {
                    addr = Some(rest.trim().to_string());
                    break;
                }
            }
            Err(e) => panic!("reading agent stderr: {e}"),
        }
    }

    // Keep the pipe from filling for the rest of the agent's life.
    std::thread::spawn(move || {
        let mut sink = String::new();
        while reader.read_line(&mut sink).unwrap_or(0) > 0 {
            sink.clear();
        }
    });

    addr.expect("agent never logged a `Listening on` address")
}

/// Spawn the registry daemon explicitly, so the test owns its lifetime.
fn spawn_registry(registry_endpoint: &str) -> RegistryProcess {
    let child = Command::new(agent_binary())
        .arg("--registry-daemon")
        .env("TERMIHUB_REGISTRY_ENDPOINT", registry_endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn registry daemon");
    RegistryProcess { child }
}

/// Whether something is currently listening at `endpoint`.
///
/// A connect attempt, not a `Path::exists`: a `\\.\pipe\` name is not a
/// filesystem path, so `exists` is meaningless for it, whereas a connect probe
/// answers the only question that matters — is the registry actually reachable —
/// identically on both transports. The probe opens and immediately drops an
/// anonymous connection (it never registers), which the registry treats as any
/// short-lived client.
#[cfg(unix)]
fn endpoint_reachable(endpoint: &str) -> bool {
    std::os::unix::net::UnixStream::connect(endpoint).is_ok()
}

/// Windows connect-probe: open the named pipe as a file. A present pipe opens; a
/// missing one yields `ERROR_FILE_NOT_FOUND`; a momentarily busy one yields
/// `ERROR_PIPE_BUSY` (231) — which still means the registry is up.
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

/// Wait for the registry's endpoint to start accepting connections.
fn wait_for_endpoint(endpoint: &str) -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if endpoint_reachable(endpoint) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// ── JSON-RPC client ───────────────────────────────────────────────────────────

/// A desktop client attached to one agent.
struct Client {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: i64,
}

impl Client {
    fn connect(addr: &str) -> Self {
        let stream = TcpStream::connect(addr).expect("connect to agent");
        stream
            .set_read_timeout(Some(RPC_TIMEOUT))
            .expect("set read timeout");
        let reader = BufReader::new(stream.try_clone().expect("clone stream"));
        Self {
            reader,
            writer: stream,
            next_id: 1,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.writer, "{request}").expect("write request");
        self.writer.flush().expect("flush request");

        // Skip notifications (they carry no `id`) until the matching response.
        loop {
            let mut line = String::new();
            let n = self.reader.read_line(&mut line).expect("read response");
            assert!(n > 0, "agent closed the connection during {method}");
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                return value;
            }
        }
    }

    /// Complete `initialize` as a named desktop, returning our `client_id`.
    fn initialize(&mut self, client: &str) -> String {
        let response = self.call(
            "initialize",
            json!({
                "protocolVersion": "0.3.0",
                "client": client,
                "clientVersion": "1.0.0",
                "agentSettings": {},
            }),
        );
        // `InitializeResult` serializes snake_case (unlike `InitializeParams`,
        // which is camelCase).
        response["result"]["client_id"]
            .as_str()
            .unwrap_or_else(|| panic!("initialize returned no client_id: {response}"))
            .to_string()
    }

    /// Wait for a JSON-RPC notification named `method`, ignoring any others.
    ///
    /// Returns `None` if nothing matching arrives within `timeout` — which is
    /// how "the requester must *not* hear its own broadcast" is asserted, so a
    /// timeout here is a legitimate expected outcome and not always a failure.
    fn next_notification(&mut self, method: &str, timeout: Duration) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            // The socket timeout is what actually bounds the blocking read; the
            // deadline above only stops us looping past it on noisy traffic.
            self.reader
                .get_ref()
                .set_read_timeout(Some(remaining))
                .expect("set read timeout");
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => return None,
                Ok(_) => {}
                Err(_) => return None,
            }
            let Ok(value): Result<Value, _> = serde_json::from_str(&line) else {
                continue;
            };
            if value.get("id").is_none() && value["method"].as_str() == Some(method) {
                self.reader
                    .get_ref()
                    .set_read_timeout(Some(RPC_TIMEOUT))
                    .expect("restore read timeout");
                return Some(value);
            }
        }
    }

    /// `agent.list_connections`, as `client` names.
    fn list_connection_names(&mut self) -> Vec<String> {
        let response = self.call("agent.list_connections", json!({}));
        let connections = response["result"]["connections"]
            .as_array()
            .unwrap_or_else(|| panic!("list_connections returned no array: {response}"));
        let mut names: Vec<String> = connections
            .iter()
            .map(|c| c["client"].as_str().expect("client name").to_string())
            .collect();
        names.sort();
        names
    }
}

/// Poll `list_connections` until it matches `expected` or the deadline passes.
///
/// Registration crosses a process boundary asynchronously — `initialize` never
/// waits for the registry, by design — so the host-wide view becomes correct a
/// moment after `initialize` returns, not during it. Polling asserts the
/// eventual state without encoding a fixed sleep.
fn wait_for_connections(client: &mut Client, expected: &[&str]) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last = Vec::new();
    while Instant::now() < deadline {
        last = client.list_connection_names();
        if last == expected {
            return last;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    last
}

/// A unique, reachable registry endpoint for one test.
///
/// On unix the per-test `TempDir` scopes the socket; on windows the `\\.\pipe\`
/// namespace is machine-global with no directory to scope it, so uniqueness must
/// live in the name (pid + a per-process counter), exactly as the production
/// registry's per-user pipe name carries the user rather than relying on a dir.
/// Two test processes in one CI job therefore never collide, and neither fights
/// the developer's live registry.
#[cfg(unix)]
fn unique_endpoint(dir: &TempDir, tag: &str) -> String {
    dir.path()
        .join(format!("registry-{tag}.sock"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn unique_endpoint(_dir: &TempDir, tag: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    format!(
        r"\\.\pipe\termihub-itest-{}-{}-{tag}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// An endpoint that can be neither connected to nor bound, so a worker pointed at
/// it fails to connect *and* fails to auto-spawn a registry — the setup for
/// "the registry cannot run at all".
///
/// On unix that is a socket path inside a non-existent directory. On windows a
/// pipe *name* has no parent directory, so instead we make the name itself
/// invalid: a backslash is the one character a pipe name may not contain, so
/// `CreateFile`/`CreateNamedPipe` reject it.
#[cfg(unix)]
fn unbindable_endpoint(dir: &TempDir) -> String {
    dir.path()
        .join("no-such-dir")
        .join("registry.sock")
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn unbindable_endpoint(_dir: &TempDir) -> String {
    format!(
        r"\\.\pipe\termihub-itest-noreg-{}\invalid",
        std::process::id()
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// The issue's "Done when", end to end: a second desktop attached to the same
/// host is visible to the first, through the registry, **while neither holds any
/// sessions**.
///
/// Before this change each agent process could only ever see its own client, so
/// the two lists here would each have been `["desktop-a"]` and `["desktop-b"]`.
#[test]
fn a_second_session_less_desktop_is_visible_to_the_first() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "visible");
    let _registry = spawn_registry(&endpoint);
    assert!(
        wait_for_endpoint(&endpoint),
        "registry never bound {endpoint}"
    );

    // Two independent agent processes — the real topology: one agent process
    // per desktop, exactly as the SSH-exec transport produces.
    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);

    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");

    // Neither desktop has created a single session. Before the registry, a
    // session-less desktop had no daemon at all and was invisible — which is
    // the exact client an agent binary swap kills without warning.
    let seen_by_a = wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]);
    assert_eq!(
        seen_by_a,
        vec!["desktop-a", "desktop-b"],
        "desktop A must see the session-less desktop B through the registry"
    );

    let seen_by_b = wait_for_connections(&mut desktop_b, &["desktop-a", "desktop-b"]);
    assert_eq!(
        seen_by_b,
        vec!["desktop-a", "desktop-b"],
        "visibility must be symmetric"
    );
}

/// A worker that finds no registry must start one. Nothing else spawns it —
/// there is no installer, no service, and no supervisor — so if this does not
/// hold, the whole feature is dead on a fresh host.
#[test]
fn a_worker_spawns_the_registry_when_none_is_running() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "autospawn");
    assert!(
        !endpoint_reachable(&endpoint),
        "test must start with no registry"
    );

    // No `spawn_registry` here — only agents.
    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");

    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
        "a worker should have spawned a registry and both should be visible"
    );
    assert!(
        endpoint_reachable(&endpoint),
        "the auto-spawned registry should own {endpoint}"
    );
    // The auto-spawned registry is not ours to kill — it exits on its own once
    // idle. Its endpoint is unique to this test, so it can affect nothing else.
}

/// The single-client opt-out (#2480): with `TERMIHUB_AGENT_SKIP_REGISTRY_DAEMON`
/// set, a worker that finds no registry must **not** spawn one, yet must still
/// serve the desktop — `initialize` succeeds and the per-process fallback view
/// reports the client. This is the headless proof (over a direct TCP transport,
/// no SSH) that suppressing the ADR-11 registry-daemon spawn leaves the connect
/// path intact; it is the exact inverse of
/// [`a_worker_spawns_the_registry_when_none_is_running`].
#[test]
fn a_worker_with_the_skip_env_never_spawns_the_registry_but_still_serves() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "skip");
    assert!(
        !endpoint_reachable(&endpoint),
        "test must start with no registry"
    );

    // A single agent with the opt-out env set — the harness's single-client shape.
    let agent = spawn_agent_skipping_registry(&endpoint);
    let mut desktop = Client::connect(&agent.addr);

    // The connect path is unaffected: initialize completes and returns a client_id.
    let client_id = desktop.initialize("skip-desktop");
    assert!(
        !client_id.is_empty(),
        "initialize must still succeed with the registry-daemon spawn suppressed"
    );

    // The host-wide registry never answers (none was spawned), so
    // `list_connections` falls back to this worker's per-process view — which
    // still includes the connected desktop.
    assert_eq!(
        wait_for_connections(&mut desktop, &["skip-desktop"]),
        vec!["skip-desktop"],
        "the per-process fallback must still report the connected client"
    );

    // The decisive assertion: nothing ever bound the registry endpoint. Poll a
    // short window so a (buggy) delayed spawn would still be caught, then confirm
    // the endpoint stayed unreachable the whole time.
    let watch_deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < watch_deadline {
        assert!(
            !endpoint_reachable(&endpoint),
            "the skip env must prevent any registry-daemon spawn ({endpoint} became reachable)"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A desktop that disconnects must stop being reported host-wide — otherwise
/// #1351 would broadcast to, and block an update on, desktops that left.
#[test]
fn a_disconnected_desktop_disappears_from_the_host_wide_view() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "disconnect");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");
    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
        "both should be visible before the disconnect"
    );

    // B's desktop goes away.
    drop(desktop_b);

    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a"]),
        vec!["desktop-a"],
        "a disconnected desktop must be withdrawn from the host-wide view"
    );
}

/// A worker whose process is killed outright never gets to say goodbye. The
/// registry must still drop it — its record's liveness is the socket, not a
/// polite deregister.
#[test]
fn a_killed_worker_is_garbage_collected_by_the_registry() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "killed");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent_a = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    desktop_a.initialize("desktop-a");

    {
        let agent_b = spawn_agent(&endpoint);
        let mut desktop_b = Client::connect(&agent_b.addr);
        desktop_b.initialize("desktop-b");
        assert_eq!(
            wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
            vec!["desktop-a", "desktop-b"],
            "both should be visible before the kill"
        );
        // `agent_b`'s Drop kills the process — no clean shutdown, no goodbye.
    }

    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a"]),
        vec!["desktop-a"],
        "a killed worker's record must be reaped when its socket closes"
    );
}

/// The registry is **optional infrastructure**. With none reachable and none
/// spawnable, an agent must still initialize, still answer, and still report
/// its own client — never an empty host, and never an error.
#[test]
fn an_agent_works_and_reports_itself_when_the_registry_cannot_run() {
    let dir = TempDir::new().expect("temp dir");
    // An endpoint that is unconnectable *and* un-bindable by a spawned registry,
    // so the worker's auto-spawn fails too and it must fall back to its own view.
    let endpoint = unbindable_endpoint(&dir);

    let agent = spawn_agent(&endpoint);
    let mut desktop = Client::connect(&agent.addr);
    desktop.initialize("desktop-a");

    assert_eq!(
        desktop.list_connection_names(),
        vec!["desktop-a"],
        "a registry-less agent must fall back to its own per-process view"
    );

    // And it is still a fully working agent, not a degraded one.
    let health = desktop.call("health.check", json!({}));
    assert!(
        health.get("error").is_none(),
        "a missing registry must not break unrelated RPCs: {health}"
    );
}

/// A registry that dies must not take the host-wide view with it permanently:
/// workers reconnect and **re-announce**, so the view heals with no action from
/// any desktop. This is the property an agent binary swap depends on.
#[test]
fn the_host_wide_view_heals_after_the_registry_restarts() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "restart");
    let registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");
    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
        "both should be visible before the restart"
    );

    // Kill the registry outright and stand a fresh one up in its place.
    drop(registry);
    let _replacement = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "replacement never bound");

    // Nobody re-initializes; the workers must repair this themselves.
    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
        "workers must reconnect and re-announce after a registry restart"
    );
}

/// A second registry must never displace a live one — if it could, a spawn race
/// between two starting workers would split the host into two registries that
/// cannot see each other, which is the failure this whole design exists to
/// avoid.
#[test]
fn a_second_registry_exits_rather_than_stealing_a_live_endpoint() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "race");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent = spawn_agent(&endpoint);
    let mut desktop = Client::connect(&agent.addr);
    desktop.initialize("desktop-a");
    assert_eq!(
        wait_for_connections(&mut desktop, &["desktop-a"]),
        vec!["desktop-a"],
        "the first registry should be serving"
    );

    // A second registry starts on the same endpoint — as a racing worker's
    // spawn would. It must lose and exit cleanly.
    let mut loser = spawn_registry(&endpoint);
    let status = loser
        .child
        .wait()
        .expect("second registry should exit on its own");
    assert!(
        status.success(),
        "losing the bind race is a success, not a failure: {status}"
    );

    // The original is untouched and still serving the same client.
    assert_eq!(
        desktop.list_connection_names(),
        vec!["desktop-a"],
        "the live registry must keep its endpoint and its clients"
    );
}

// ── Raw registry-protocol worker ──────────────────────────────────────────────
//
// The broadcast fan-out has no production caller yet — #1351 owns the update
// notification that will send one. Its unit tests cover the registry's routing
// and the client's delivery, but neither crosses a process boundary, and the
// issue's "Done when" is specifically that *#1351 could broadcast to a non-empty
// set*. So these tests speak the registry's frame vocabulary directly over the
// real socket: that is the substrate contract #1351 will build on, proven on the
// wire rather than in a unit harness.

/// Frame type/payload constants, duplicated rather than imported: `termihub-agent`
/// is a binary crate, so an integration test cannot `use` its modules. Keeping
/// them here also makes these tests a genuine *external* check of the wire
/// format — if a refactor changes a type byte, this fails, which is the point.
const MSG_REGISTER: u8 = 0x10;
const MSG_BROADCAST: u8 = 0x13;
const MSG_ACK: u8 = 0x90;
const MSG_EVENT: u8 = 0x92;

/// The transport under a [`RawWorker`]: a unix domain socket on unix, a windows
/// named pipe on windows. Both carry the identical length-prefixed frames, so
/// only the connect/read/write/timeout primitives differ — every scenario above
/// them is shared.
trait RawTransport {
    /// Write a whole frame, then flush.
    fn write_frame(&mut self, buf: &[u8]);
    /// Fill `buf` completely, or return `false` on timeout / EOF / error.
    fn read_full(&mut self, buf: &mut [u8]) -> bool;
    /// Set the timeout applied to subsequent [`read_full`](Self::read_full) calls.
    fn set_read_timeout(&mut self, timeout: Duration);
}

/// Connect a raw transport to the registry endpoint, with a generous read
/// timeout matching the unix suite's original 10 s.
fn connect_transport(endpoint: &str) -> Box<dyn RawTransport> {
    platform::connect(endpoint)
}

#[cfg(unix)]
mod platform {
    use super::{Duration, RawTransport};
    use std::io::{Read, Write};

    struct UnixTransport {
        stream: std::os::unix::net::UnixStream,
    }

    impl RawTransport for UnixTransport {
        fn write_frame(&mut self, buf: &[u8]) {
            self.stream.write_all(buf).expect("write frame");
            self.stream.flush().expect("flush frame");
        }

        fn read_full(&mut self, buf: &mut [u8]) -> bool {
            self.stream.read_exact(buf).is_ok()
        }

        fn set_read_timeout(&mut self, timeout: Duration) {
            self.stream
                .set_read_timeout(Some(timeout))
                .expect("set read timeout");
        }
    }

    pub(super) fn connect(endpoint: &str) -> Box<dyn RawTransport> {
        let stream =
            std::os::unix::net::UnixStream::connect(endpoint).expect("connect registry socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("set read timeout");
        Box::new(UnixTransport { stream })
    }
}

#[cfg(windows)]
mod platform {
    use super::{Duration, Instant, RawTransport};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    /// A windows named-pipe client driven by its own current-thread runtime.
    ///
    /// The named pipe has no `SO_RCVTIMEO`, so a real read timeout — which the
    /// suite needs to prove "a broadcast is *not* echoed to its sender" — comes
    /// from `tokio::time::timeout` around an async `read_exact`, rather than a
    /// blocking-socket option as on unix.
    struct PipeTransport {
        // Field order is drop order: the client must drop (deregister from the
        // IO driver, close the handle) *before* the runtime it is bound to.
        client: NamedPipeClient,
        read_timeout: Duration,
        rt: tokio::runtime::Runtime,
    }

    impl RawTransport for PipeTransport {
        fn write_frame(&mut self, buf: &[u8]) {
            let Self { rt, client, .. } = self;
            rt.block_on(async {
                client.write_all(buf).await.expect("write frame");
                client.flush().await.expect("flush frame");
            });
        }

        fn read_full(&mut self, buf: &mut [u8]) -> bool {
            let Self {
                rt,
                client,
                read_timeout,
            } = self;
            rt.block_on(async {
                matches!(
                    tokio::time::timeout(*read_timeout, client.read_exact(buf)).await,
                    Ok(Ok(_))
                )
            })
        }

        fn set_read_timeout(&mut self, timeout: Duration) {
            self.read_timeout = timeout;
        }
    }

    pub(super) fn connect(endpoint: &str) -> Box<dyn RawTransport> {
        // A pipe instance can be momentarily busy between the registry accepting
        // one client and staging the next; ERROR_PIPE_BUSY (231) is worth a brief
        // retry, anything else is fatal.
        const ERROR_PIPE_BUSY: i32 = 231;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build runtime");
        let client = rt.block_on(async {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match ClientOptions::new().open(endpoint) {
                    Ok(client) => break client,
                    Err(e)
                        if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                            && Instant::now() < deadline =>
                    {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => panic!("connect registry pipe {endpoint}: {e}"),
                }
            }
        });
        Box::new(PipeTransport {
            rt,
            client,
            read_timeout: Duration::from_secs(10),
        })
    }
}

/// A worker speaking the registry protocol directly, standing in for the agent
/// worker that #1351 will make broadcast.
struct RawWorker {
    conn: Box<dyn RawTransport>,
}

impl RawWorker {
    fn connect(endpoint: &str) -> Self {
        Self {
            conn: connect_transport(endpoint),
        }
    }

    /// `[type: 1][length: 4 BE][payload]` — the session daemons' framing.
    fn send(&mut self, msg_type: u8, payload: &[u8]) {
        let mut frame = Vec::with_capacity(5 + payload.len());
        frame.push(msg_type);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        self.conn.write_frame(&frame);
    }

    fn recv(&mut self) -> Option<(u8, Vec<u8>)> {
        let mut header = [0u8; 5];
        if !self.conn.read_full(&mut header) {
            return None;
        }
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        let mut payload = vec![0u8; len];
        if !self.conn.read_full(&mut payload) {
            return None;
        }
        Some((header[0], payload))
    }

    /// Shorten (or lengthen) the read timeout for subsequent [`recv`](Self::recv)
    /// calls — used to assert that *nothing* arrives within a bound.
    fn set_read_timeout(&mut self, timeout: Duration) {
        self.conn.set_read_timeout(timeout);
    }

    /// Register and wait for the ACK, so the caller knows the registry has
    /// recorded this worker before it asserts on fan-out.
    ///
    /// The ACK is not necessarily the *next* frame. The registry fans a
    /// broadcast out to every connection except its sender — registered or not —
    /// so a worker that connects while another worker's broadcast is in flight
    /// can be handed the `MSG_EVENT` before its own `MSG_ACK`. That ordering is
    /// harmless in production (a real worker dispatches on frame type and never
    /// waits on the ACK), but a helper that assumed "next frame == ACK" made this
    /// suite fail about 1 run in 20 under load. Skipping to the ACK asserts what
    /// this helper actually means to assert.
    fn register(&mut self, client_id: &str) {
        let record = json!({
            "client_id": client_id,
            "client": "termihub-desktop",
            "client_version": "1.2.3",
            "connected_since": "2026-07-17T10:00:00+00:00",
            "pid": std::process::id(),
        });
        self.send(MSG_REGISTER, &serde_json::to_vec(&record).expect("encode"));
        loop {
            let (msg_type, _) = self.recv().expect("registry must ACK a REGISTER");
            if msg_type == MSG_ACK {
                return;
            }
            assert_eq!(
                msg_type, MSG_EVENT,
                "expected an ACK for {client_id}, or a broadcast racing it — got 0x{msg_type:02x}"
            );
        }
    }
}

/// The broadcast half of the "Done when": a notification from one worker reaches
/// the *other* worker's process — across a real socket, not a channel — and is
/// not echoed to its sender.
///
/// This is the set #1351 will broadcast an impending update to. Before the
/// registry existed, `io/tcp.rs`'s `mpsc` was multi-producer/single-consumer, so
/// a notification could not leave the process that raised it at all.
#[test]
fn a_broadcast_from_one_worker_reaches_another_workers_process() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "broadcast");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let mut sender = RawWorker::connect(&endpoint);
    let mut receiver = RawWorker::connect(&endpoint);
    sender.register("desktop-a");
    receiver.register("desktop-b");

    let envelope = json!({
        "origin_client_id": "desktop-a",
        "method": "agent.update_pending",
        "params": { "version": "9.9.9" },
    });
    sender.send(
        MSG_BROADCAST,
        &serde_json::to_vec(&envelope).expect("encode"),
    );

    let (msg_type, payload) = receiver
        .recv()
        .expect("the other worker must get the event");
    assert_eq!(msg_type, MSG_EVENT, "expected an EVENT frame");
    let got: Value = serde_json::from_slice(&payload).expect("decode envelope");
    assert_eq!(
        got, envelope,
        "the envelope must arrive byte-for-byte: the registry carries notifications, it does not interpret them"
    );

    // The sender must not receive its own broadcast. Its client already handled
    // the event locally; echoing it back would double-deliver.
    sender.set_read_timeout(Duration::from_millis(500));
    assert!(
        sender.recv().is_none(),
        "a broadcast must never be echoed to its origin"
    );
}

/// A broadcast with no peers must not fail the sender — the registry has to
/// tolerate a host holding exactly one desktop, which is the common case.
#[test]
fn a_broadcast_with_no_other_workers_is_harmless() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "broadcast-alone");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let mut lonely = RawWorker::connect(&endpoint);
    lonely.register("desktop-a");

    let envelope = json!({
        "origin_client_id": "desktop-a",
        "method": "agent.update_pending",
        "params": {},
    });
    lonely.send(
        MSG_BROADCAST,
        &serde_json::to_vec(&envelope).expect("encode"),
    );

    // The registry must still be serving: a later REGISTER on a fresh connection
    // proves the broadcast did not take it down.
    let mut peer = RawWorker::connect(&endpoint);
    peer.register("desktop-b");
}

// ── Coordinated update (#1351) ────────────────────────────────────────────────

/// Ask for a coordinated update from `client`, on a thread.
///
/// `agent.request_update` blocks for as long as it is waiting for the other
/// hosts to leave, so the requester cannot also be the thing watching them
/// leave. The caller drives the peers while this runs.
///
/// No binary is staged, so the *apply* always fails with "no pending update" —
/// deliberately. Staging a real one would exec-replace the agent mid-test; what
/// these tests are about is the coordination that happens strictly *before* the
/// apply, and the failure arriving at all is itself proof the window closed.
fn request_update_async(
    mut client: Client,
    ack_timeout_secs: u64,
) -> std::thread::JoinHandle<(Value, Duration)> {
    std::thread::spawn(move || {
        let started = Instant::now();
        let response = client.call(
            "agent.request_update",
            json!({ "ackTimeoutSecs": ack_timeout_secs }),
        );
        (response, started.elapsed())
    })
}

/// The issue's acceptance criterion, end to end: initiating a coordinated update
/// **shows the notice on another host** — one that is attached to a *different
/// agent process* and holds *no sessions at all*.
///
/// The session-less half is the part that could not have worked before #1574:
/// registration keyed to `initialize` rather than to a session is exactly what
/// makes an idle desktop visible to broadcast. And the cross-process half could
/// not have worked before either — `io/tcp.rs`'s notification channel is
/// single-consumer, so this notice provably could not have reached desktop B
/// through any pre-existing path.
#[test]
fn the_update_notice_reaches_a_second_session_less_desktop() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "update-notice");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");

    // Neither desktop creates a session — they are visible purely by having
    // initialized. Wait until A can actually see B, or the broadcast would
    // legitimately go to an empty set and prove nothing.
    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
        "desktop-b must be host-wide visible before the update is requested"
    );

    let requester = request_update_async(desktop_a, 2);

    let notice = desktop_b
        .next_notification("agent.update_pending", Duration::from_secs(15))
        .expect("desktop-b must receive the agent.update_pending notice");

    // The desktop renders these two fields; a casing slip is invisible to the
    // agent and fatal to the toast.
    assert_eq!(
        notice["params"]["requestedByVersion"], "1.0.0",
        "the notice must name the version of the desktop that asked: {notice}"
    );
    assert!(
        notice["params"]["estimatedRestartSecs"].as_u64().is_some(),
        "the notice must carry a restart estimate for the progress display: {notice}"
    );

    let (response, _) = requester.join().expect("requester thread");
    assert!(
        response["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("No pending update")),
        "coordination must complete and hand over to the apply: {response}"
    );
}

/// The ack *is* the disconnect, proven across processes: a desktop that takes
/// the notice and leaves releases the update immediately, rather than the agent
/// sitting out the full window.
///
/// The window here is 20 s — far longer than the test tolerates — so the only
/// way this passes is if the agent actually noticed desktop-b go.
#[test]
fn a_desktop_that_disconnects_releases_the_update_early() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "update-early");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");
    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
    );

    let requester = request_update_async(desktop_a, 20);

    desktop_b
        .next_notification("agent.update_pending", Duration::from_secs(15))
        .expect("desktop-b must receive the notice");
    // Exactly what a real desktop does once it has suspended its sessions.
    drop(desktop_b);

    let (response, elapsed) = requester.join().expect("requester thread");
    assert!(
        response.get("error").is_some(),
        "coordination must still hand over to the apply: {response}"
    );
    assert!(
        elapsed < Duration::from_secs(18),
        "the update must proceed on the disconnect, not sit out the 20 s window: took {elapsed:?}"
    );
}

/// "Host B never acks" — the timeout path the issue calls out explicitly. A
/// desktop that ignores the notice must not be able to hold an update hostage.
#[test]
fn a_desktop_that_never_leaves_does_not_block_the_update() {
    let dir = TempDir::new().expect("temp dir");
    let endpoint = unique_endpoint(&dir, "update-timeout");
    let _registry = spawn_registry(&endpoint);
    assert!(wait_for_endpoint(&endpoint), "registry never bound");

    let agent_a = spawn_agent(&endpoint);
    let agent_b = spawn_agent(&endpoint);
    let mut desktop_a = Client::connect(&agent_a.addr);
    let mut desktop_b = Client::connect(&agent_b.addr);
    desktop_a.initialize("desktop-a");
    desktop_b.initialize("desktop-b");
    assert_eq!(
        wait_for_connections(&mut desktop_a, &["desktop-a", "desktop-b"]),
        vec!["desktop-a", "desktop-b"],
    );

    // desktop-b stays attached and does nothing about the notice.
    let requester = request_update_async(desktop_a, 2);

    let (response, elapsed) = requester.join().expect("requester thread");
    assert!(
        response.get("error").is_some(),
        "the update must proceed to the apply despite the stuck host: {response}"
    );
    assert!(
        elapsed >= Duration::from_secs(2),
        "the stuck host must get its full window first: took {elapsed:?}"
    );
    // desktop-b is still there — the agent proceeded without it, it did not
    // mistake it for gone.
    assert!(
        desktop_b
            .list_connection_names()
            .contains(&"desktop-b".to_string()),
        "desktop-b must still be attached; the update proceeded on the timeout"
    );
}
