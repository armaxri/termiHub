//! A scripted RDP server for the system-test lane (#5175).
//!
//! The RDP suites in `tests/system/tests/test_rdp.py` need the Linux xrdp
//! container, so on macOS and Windows the sidecar never ran against any
//! server. This example serves the same scripted server the sidecar's own
//! redirection tests use (`src/redirect_broker.rs`, #5271), byte for byte on
//! `ironrdp-pdu`: X.224 selecting TLS, a TLS handshake with a throwaway
//! certificate, the MCS connect sequence and licensing, and then the chosen
//! act. It needs no container, so the harness can start it on every OS.
//!
//! Usage: `rdp_test_server [--bind <addr:port>] [--act activate|hangup]`
//!
//! - `--bind` (default `127.0.0.1:0`): where to listen.
//! - `--act` (default `activate`): what every connection gets once its Client
//!   Info arrived. `activate` brings the session up and holds it until the
//!   client hangs up; `hangup` drops the connection there.
//!
//! Stdout is line-based, for the harness (`termihub_harness.rdp_test_server`):
//! first `listening <port>`, then `dial #<n>` when connection `n` is accepted
//! and `client-info #<n> <username>` when its Client Info PDU arrived (only
//! after the client's certificate trust gate passed). The server exits when
//! stdin reaches end of file, so it never outlives the harness that owns it.

// Only the activate/hang-up acts of the shared scripted servers are played
// here; the redirection acts and the target's certificate serve the unit tests.
#[allow(dead_code)]
#[path = "../src/redirect_broker.rs"]
mod broker;

use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::net::TcpListener;

/// Accepted connections beyond this many hang up after their Client Info. A
/// Test connection costs two (a certificate preflight, then the session).
const MAX_CONNECTIONS: usize = 10_000;

struct Args {
    bind: String,
    act: broker::Act,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        bind: "127.0.0.1:0".to_string(),
        act: broker::Act::Activate,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--bind" => args.bind = it.next().ok_or("--bind needs an address")?,
            "--act" => {
                args.act = match it.next().as_deref() {
                    Some("activate") => broker::Act::Activate,
                    Some("hangup") => broker::Act::HangUp,
                    other => return Err(format!("--act: expected activate|hangup, got {other:?}")),
                }
            }
            "--help" | "-h" => {
                println!("usage: rdp_test_server [--bind <addr:port>] [--act activate|hangup]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(args)
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    // The harness reads these lines; a closed stdout just means nobody listens.
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("rdp_test_server: {e}");
            std::process::exit(2);
        }
    };
    let listener = match TcpListener::bind(&args.bind).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("rdp_test_server: cannot listen on {}: {e}", args.bind);
            std::process::exit(1);
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let events: broker::Log = Arc::default();
    let server = broker::spawn_server(
        listener,
        "server",
        broker::BROKER_CERT,
        broker::BROKER_KEY,
        vec![args.act; MAX_CONNECTIONS],
        Arc::clone(&events),
    );
    say(&format!("listening {port}"));

    // Report what happened, as it happens: the dial log, then each
    // connection's Client Info once it arrived.
    tokio::spawn(async move {
        let mut said_events = 0;
        let mut said_info = Vec::new();
        loop {
            let lines: Vec<String> = events.lock().unwrap()[said_events..].to_vec();
            said_events += lines.len();
            for line in lines {
                // "dial server #<n>" -> "dial #<n>"
                say(&line.replacen("dial server ", "dial ", 1));
            }
            for (index, conn) in server.conns().iter().enumerate() {
                if said_info.len() <= index {
                    said_info.push(false);
                }
                if let (false, Some(username)) = (said_info[index], &conn.username) {
                    said_info[index] = true;
                    say(&format!("client-info #{} {username}", index + 1));
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });

    // Run until the owner closes stdin (or exits, which closes it too).
    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 256];
    while matches!(stdin.read(&mut buf).await, Ok(n) if n > 0) {}
}
