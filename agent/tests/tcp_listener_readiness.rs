//! Regression test for #1579: the TCP listener must not advertise readiness
//! (`Listening on …`) before it can actually accept and answer a client.
//!
//! Before the fix, `run_tcp_listener` bound the socket and logged `Listening
//! on …` *first*, then did the expensive startup work (`SessionManager::new`'s
//! #1551 binary byte-compare, `ensure_default_shell`, `recover_sessions`) before
//! reaching its `accept()` loop. The kernel accepts connections into the listen
//! backlog the instant the socket is bound, so a client's `connect` succeeded
//! immediately — and then its `initialize` stalled with no reader until the
//! accept loop was finally reached. The bind log looked like a readiness signal
//! but was not one.
//!
//! This test makes that window deterministic with the `TERMIHUB_TEST_STARTUP_DELAY_MS`
//! gate, which stretches the startup path just before the bind in the fixed code.
//! With the fix, `Listening on …` only appears *after* the delay, so by the time
//! a client can read the address and connect, the accept loop is running and
//! `initialize` answers promptly. Reverting the ordering (bind before the delay)
//! makes this test fail: the log appears immediately but `initialize` blocks for
//! the whole delay.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use termihub_core::monitoring::BackoffSchedule;

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

/// Per-attempt connect timeout for [`connect_with_retry`].
///
/// A bare `TcpStream::connect` uses the OS default connect timeout, ~21s of
/// unforgiving SYN retransmits on **Windows**. Under heavy parallel CI load a
/// *ready* loopback listener's accept backlog can fill for a beat, Windows drops
/// the SYN, and a single connect hangs the whole way to that default —
/// `Os { code: 10060, kind: TimedOut }`, the #2490 / #1579 flake. Capping each
/// attempt short lets us abandon a stalled SYN and re-attempt quickly.
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(750);
/// Overall budget for establishing the client connection once the agent has
/// announced readiness. Matches [`STARTUP_TIMEOUT`]'s generosity for a loaded
/// runner; a listener that never accepts still fails the test after it elapses.
const CONNECT_DEADLINE: Duration = Duration::from_secs(30);

/// Connect to the agent's listener, retrying short-timeout connects with bounded
/// backoff until it accepts or [`CONNECT_DEADLINE`] elapses.
///
/// Polls on **connect success** (per the #2459 hardening lesson — not a fixed
/// sleep) so the transient Windows-CI SYN-drop window (see
/// [`CONNECT_ATTEMPT_TIMEOUT`]) cannot 10060 this test. The `initialize`
/// read-timing assertion below — the actual #1579 readiness check — is left
/// entirely untouched: this hardens the transport, it does not weaken the test.
fn connect_with_retry(addr: &str) -> TcpStream {
    let socket_addr: SocketAddr = addr
        .to_socket_addrs()
        .unwrap_or_else(|e| panic!("could not parse agent addr {addr}: {e}"))
        .next()
        .unwrap_or_else(|| panic!("agent addr {addr} resolved to no socket address"));
    let deadline = Instant::now() + CONNECT_DEADLINE;
    let mut backoff = BackoffSchedule::new(
        Duration::from_millis(20),
        Duration::from_millis(500),
        u32::MAX,
    );
    loop {
        match TcpStream::connect_timeout(&socket_addr, CONNECT_ATTEMPT_TIMEOUT) {
            Ok(stream) => return stream,
            Err(e) => {
                if Instant::now() >= deadline {
                    panic!(
                        "could not connect to agent at {addr} within {CONNECT_DEADLINE:?} \
                         — last error: {e}"
                    );
                }
            }
        }
        std::thread::sleep(backoff.next_delay().unwrap_or(Duration::from_millis(500)));
    }
}

/// How long the agent's startup path is stretched before it binds.
///
/// Widened (was 3000ms) alongside [`INITIALIZE_READ_TIMEOUT`] so the readiness
/// check tolerates a loaded Windows CI runner (#2493): the honest `initialize`
/// reply now has a 3s window, while this delay stays comfortably longer so a
/// still-in-startup agent (the #1579 bug) still cannot answer inside that window.
const STARTUP_DELAY: Duration = Duration::from_millis(5000);
/// Time allowed to observe the `Listening on …` line.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Read budget for `initialize` once we have connected. Deliberately shorter
/// than `STARTUP_DELAY`: if the agent were still in its startup delay when we
/// connected (the #1579 bug), the reply could not arrive inside this window.
///
/// Widened (was 1500ms) to absorb a slow-but-honest response on a loaded Windows
/// runner without 10060-flaking (#2493) — it stays well under [`STARTUP_DELAY`],
/// so the #1579 assertion (a stalled listener cannot answer in time) stays real.
const INITIALIZE_READ_TIMEOUT: Duration = Duration::from_millis(3000);

/// A spawned agent process, killed on drop so a failing assertion never leaks it.
struct AgentProcess {
    child: Child,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The agent does not advertise `Listening on …` until it is genuinely ready to
/// accept, and a client that connects on the strength of that log gets a timely
/// `initialize` response rather than an accepted-then-stalled socket.
#[test]
fn listening_log_is_a_true_readiness_signal() {
    let spawned_at = Instant::now();
    let mut child = Command::new(agent_binary())
        .arg("--listen")
        .arg("127.0.0.1:0")
        .env(
            "TERMIHUB_TEST_STARTUP_DELAY_MS",
            STARTUP_DELAY.as_millis().to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn agent");

    let stderr = child.stderr.take().expect("piped stderr");
    let agent = AgentProcess { child };

    // Block until the agent announces its bound address, exactly as the desktop
    // and the other integration tests key off this line.
    let (addr, listening_at) = read_listen_addr(stderr);

    // The bind must have been deferred until after the (simulated) slow init:
    // the log cannot appear before the startup delay has elapsed. With the old
    // ordering the log fires at ~0ms, far below this bound.
    let elapsed = listening_at.duration_since(spawned_at);
    assert!(
        elapsed >= STARTUP_DELAY / 2,
        "`Listening on` appeared after {elapsed:?}, before the {STARTUP_DELAY:?} startup delay \
         — the listener bound before it was ready (#1579)"
    );

    // Connect the instant we see the readiness signal and send `initialize`.
    // Retry the connect with bounded backoff so a transient Windows-CI SYN drop
    // does not 10060 before the read-timing assertion runs (#2490); the
    // `initialize` read budget below is unchanged and remains the #1579 check.
    let stream = connect_with_retry(&addr);
    stream
        .set_read_timeout(Some(INITIALIZE_READ_TIMEOUT))
        .expect("set read timeout");
    let mut writer = stream.try_clone().expect("clone stream");
    let mut reader = BufReader::new(stream);

    let request = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":"#,
        r#"{"protocolVersion":"0.3.0","client":"readiness-probe",""#,
        r#"clientVersion":"1.0.0","agentSettings":{}}}"#,
        "\n"
    );
    writer.write_all(request.as_bytes()).expect("write request");
    writer.flush().expect("flush request");

    // A readiness signal that is honest means this reply arrives well inside the
    // short read budget. Under the #1579 bug the socket is connected but has no
    // reader, so this read hits its timeout instead.
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => panic!("agent closed the connection before answering initialize"),
        Ok(_) => {}
        Err(e) => panic!(
            "no initialize response within {INITIALIZE_READ_TIMEOUT:?} after `Listening on` \
             — the agent accepted the connection but could not answer (#1579): {e}"
        ),
    }

    let value: serde_json::Value = serde_json::from_str(&line)
        .unwrap_or_else(|e| panic!("initialize reply not JSON: {e}: {line}"));
    assert_eq!(value["id"].as_i64(), Some(1), "unexpected reply: {line}");
    assert!(
        value["result"]["client_id"].is_string(),
        "initialize returned no client_id: {line}"
    );

    drop(agent);
}

/// Wait for the agent's `Listening on <addr>` line, returning the address and
/// the instant it was observed. Drains the rest of the pipe afterwards so a
/// full stderr buffer never blocks the agent mid-test.
fn read_listen_addr(stderr: std::process::ChildStderr) -> (String, Instant) {
    let mut reader = BufReader::new(stderr);
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut found = None;

    while Instant::now() < deadline {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // agent exited before binding
            Ok(_) => {
                if let Some(rest) = line.split("Listening on ").nth(1) {
                    found = Some((rest.trim().to_string(), Instant::now()));
                    break;
                }
            }
            Err(e) => panic!("reading agent stderr: {e}"),
        }
    }

    // Keep the pipe from filling for the rest of the agent's life.
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink);
    });

    found.expect("agent never logged a `Listening on` address")
}
