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
//! points its agents at a unique endpoint in a `TempDir` via
//! `TERMIHUB_REGISTRY_ENDPOINT`, which the spawned agents pass on to any
//! registry they spawn through the inherited environment. Without this, these
//! tests would fight each other, the developer's own agents, and the parallel
//! development checkouts, all over one socket.
//!
//! ```sh
//! cargo test -p termihub-agent --test registry_daemon_integration
//! ```

#![cfg(unix)]

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
    let mut child = Command::new(agent_binary())
        .arg("--listen")
        .arg("127.0.0.1:0")
        .env("TERMIHUB_REGISTRY_ENDPOINT", registry_endpoint)
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

/// Wait for the registry's endpoint to appear on disk.
fn wait_for_endpoint(endpoint: &str) -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if std::path::Path::new(endpoint).exists() {
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

fn unique_endpoint(dir: &TempDir, tag: &str) -> String {
    dir.path()
        .join(format!("registry-{tag}.sock"))
        .to_string_lossy()
        .into_owned()
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
    assert!(wait_for_endpoint(&endpoint), "registry never bound {endpoint}");

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
        !std::path::Path::new(&endpoint).exists(),
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
        std::path::Path::new(&endpoint).exists(),
        "the auto-spawned registry should own {endpoint}"
    );
    // The auto-spawned registry is not ours to kill — it exits on its own once
    // idle. Its endpoint is unique to this test, so it can affect nothing else.
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
    // A path inside a non-existent directory: unconnectable, and un-bindable by
    // a spawned registry, so the worker's auto-spawn fails too.
    let endpoint = dir
        .path()
        .join("no-such-dir")
        .join("registry.sock")
        .to_string_lossy()
        .into_owned();

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

/// A worker speaking the registry protocol directly, standing in for the agent
/// worker that #1351 will make broadcast.
struct RawWorker {
    stream: std::os::unix::net::UnixStream,
}

impl RawWorker {
    fn connect(endpoint: &str) -> Self {
        let stream = std::os::unix::net::UnixStream::connect(endpoint).expect("connect registry");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("set read timeout");
        Self { stream }
    }

    /// `[type: 1][length: 4 BE][payload]` — the session daemons' framing.
    fn send(&mut self, msg_type: u8, payload: &[u8]) {
        let mut frame = Vec::with_capacity(5 + payload.len());
        frame.push(msg_type);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush frame");
    }

    fn recv(&mut self) -> Option<(u8, Vec<u8>)> {
        use std::io::Read;
        let mut header = [0u8; 5];
        self.stream.read_exact(&mut header).ok()?;
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        let mut payload = vec![0u8; len];
        self.stream.read_exact(&mut payload).ok()?;
        Some((header[0], payload))
    }

    /// Register and wait for the ACK, so the caller knows the registry has
    /// recorded this worker before it asserts on fan-out.
    fn register(&mut self, client_id: &str) {
        let record = json!({
            "client_id": client_id,
            "client": "termihub-desktop",
            "client_version": "1.2.3",
            "connected_since": "2026-07-17T10:00:00+00:00",
            "pid": std::process::id(),
        });
        self.send(MSG_REGISTER, &serde_json::to_vec(&record).expect("encode"));
        let (msg_type, _) = self.recv().expect("registry must ACK a REGISTER");
        assert_eq!(msg_type, MSG_ACK, "expected ACK for {client_id}");
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
    sender.send(MSG_BROADCAST, &serde_json::to_vec(&envelope).expect("encode"));

    let (msg_type, payload) = receiver.recv().expect("the other worker must get the event");
    assert_eq!(msg_type, MSG_EVENT, "expected an EVENT frame");
    let got: Value = serde_json::from_slice(&payload).expect("decode envelope");
    assert_eq!(
        got, envelope,
        "the envelope must arrive byte-for-byte: the registry carries notifications, it does not interpret them"
    );

    // The sender must not receive its own broadcast. Its client already handled
    // the event locally; echoing it back would double-deliver.
    sender
        .stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .expect("shorten timeout");
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
    lonely.send(MSG_BROADCAST, &serde_json::to_vec(&envelope).expect("encode"));

    // The registry must still be serving: a later REGISTER on a fresh connection
    // proves the broadcast did not take it down.
    let mut peer = RawWorker::connect(&endpoint);
    peer.register("desktop-b");
}
