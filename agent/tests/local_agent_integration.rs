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

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

// ── Binary path ───────────────────────────────────────────────────────────────

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

// ── LocalAgent: process lifecycle manager ────────────────────────────────────

/// Spawns a `termihub-agent --listen` process on a free port.
/// Kills the process on drop.
struct LocalAgent {
    process: Child,
    pub addr: String,
}

impl LocalAgent {
    fn spawn() -> Self {
        let port = free_port();
        let addr = format!("127.0.0.1:{port}");

        let process = Command::new(agent_binary())
            .args(["--listen", &addr])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn termihub-agent");

        wait_for_tcp(&addr, Duration::from_secs(5));
        LocalAgent { process, addr }
    }
}

impl Drop for LocalAgent {
    fn drop(&mut self) {
        self.process.kill().ok();
        self.process.wait().ok();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Find a free local TCP port by binding to port 0 and reading the OS assignment.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("failed to bind port 0")
        .local_addr()
        .expect("no local addr")
        .port()
}

/// Retry-connect to `addr` until it accepts or the deadline is exceeded.
fn wait_for_tcp(addr: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect(addr).is_ok() {
            return;
        }
        if Instant::now() >= deadline {
            panic!("agent did not start within {timeout:?} — addr: {addr}");
        }
        std::thread::sleep(Duration::from_millis(20));
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn agent_starts_and_accepts_connections() {
    let agent = LocalAgent::spawn();
    // If we reach here, the agent bound a port and accepted at least one
    // connection probe from wait_for_tcp.
    assert!(!agent.addr.is_empty());
}

#[test]
fn agent_responds_to_initialize() {
    let agent = LocalAgent::spawn();
    let mut stream = TcpStream::connect(&agent.addr).expect("connect failed");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

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
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

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
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

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
