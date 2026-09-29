//! The daemon's half of the session heartbeat (#3140).
//!
//! The agent reader tests run in paused tokio time over an in-memory duplex, so
//! the probe interval and reap bound elapse instantly and exactly. The last test
//! drives the real `daemon_loop` over a real endpoint to prove the capability is
//! advertised and a ping is answered with a bare pong — no output, no replay.

use std::time::Duration;

use tokio::io::DuplexStream;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::super::{agent_reader_loop, AgentCommand};
use crate::daemon::heartbeat::{HEARTBEAT_MAX_MISSED, HEARTBEAT_REAP_BOUND};
use crate::daemon::protocol::{
    self, CAP_HEARTBEAT, INTENT_TAKEOVER, MSG_AGENT_CAPABILITIES, MSG_AGENT_PONG,
    MSG_ATTACH_INTENT, MSG_CAPABILITIES, MSG_PING, MSG_PONG, MSG_READY,
};
use crate::daemon::transport::{self, BoxedReader};

/// A simulated day.
const LONG_IDLE: Duration = Duration::from_secs(24 * 60 * 60);

/// Start the daemon's agent reader on `server`, returning its command stream.
fn start_reader(server: DuplexStream, gen: u64) -> mpsc::Receiver<AgentCommand> {
    let (tx, rx) = mpsc::channel::<AgentCommand>(64);
    let reader: BoxedReader = Box::new(server);
    tokio::spawn(async move {
        agent_reader_loop(reader, tx, gen).await;
    });
    rx
}

/// Drain commands until `Disconnected`, counting everything else seen before it.
/// `None` if the reader never disconnected within `limit`.
async fn until_disconnected(
    rx: &mut mpsc::Receiver<AgentCommand>,
    limit: Duration,
) -> Option<(u64, usize)> {
    let run = async {
        let mut others = 0;
        while let Some(cmd) = rx.recv().await {
            match cmd {
                AgentCommand::Disconnected(gen) => return Some((gen, others)),
                _ => others += 1,
            }
        }
        None
    };
    tokio::time::timeout(limit, run).await.ok().flatten()
}

/// A worker that advertised heartbeat support and then went fully silent —
/// connected, but sending nothing and answering no probe — is dropped by the
/// daemon at exactly the reap bound, after one probe request per interval.
#[tokio::test(start_paused = true)]
async fn a_silent_heartbeat_worker_is_disconnected_within_the_bound() {
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    protocol::write_frame_async(&mut client, MSG_AGENT_CAPABILITIES, &[CAP_HEARTBEAT])
        .await
        .unwrap();

    let mut rx = start_reader(server, 5);
    let start = Instant::now();
    let (gen, probes) = until_disconnected(&mut rx, LONG_IDLE)
        .await
        .expect("a wedged heartbeat worker must be disconnected");

    assert_eq!(
        gen, 5,
        "the wedged worker disconnects with its own generation"
    );
    assert_eq!(start.elapsed(), HEARTBEAT_REAP_BOUND);
    assert_eq!(
        probes, HEARTBEAT_MAX_MISSED as usize,
        "one probe request per silent interval"
    );
    drop(client);
}

/// A pre-heartbeat worker (it never sends `MSG_AGENT_CAPABILITIES`) is never
/// probed and never dropped, however long it idles — the swap-window case.
#[tokio::test(start_paused = true)]
async fn a_pre_heartbeat_worker_is_never_probed_or_disconnected() {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let mut rx = start_reader(server, 1);

    let outcome = until_disconnected(&mut rx, LONG_IDLE).await;
    assert!(outcome.is_none(), "a legacy idle worker must stay attached");
    assert!(rx.try_recv().is_err(), "and must never be probed");
    drop(client);
}

/// A worker that advertised heartbeat support but set no heartbeat flag (an
/// empty feature set) is treated as not supporting it.
#[tokio::test(start_paused = true)]
async fn a_worker_advertising_no_heartbeat_flag_is_never_reaped() {
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    protocol::write_frame_async(&mut client, MSG_AGENT_CAPABILITIES, &[0])
        .await
        .unwrap();
    let mut rx = start_reader(server, 1);

    assert!(until_disconnected(&mut rx, LONG_IDLE).await.is_none());
    drop(client);
}

/// An idle heartbeat worker that answers every probe stays attached for a day.
#[tokio::test(start_paused = true)]
async fn an_idle_heartbeat_worker_that_answers_stays_attached() {
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    protocol::write_frame_async(&mut client, MSG_AGENT_CAPABILITIES, &[CAP_HEARTBEAT])
        .await
        .unwrap();
    let mut rx = start_reader(server, 2);

    // Play the worker: answer each probe request the reader raises with a pong.
    let run = async {
        let mut answered = 0usize;
        while let Some(cmd) = rx.recv().await {
            match cmd {
                AgentCommand::Disconnected(_) => return answered,
                _ => {
                    protocol::write_frame_async(&mut client, MSG_AGENT_PONG, &[])
                        .await
                        .unwrap();
                    answered += 1;
                }
            }
        }
        answered
    };
    let outcome = tokio::time::timeout(LONG_IDLE, run).await;
    assert!(
        outcome.is_err(),
        "an idle worker that answers probes must never be disconnected"
    );
}

/// A worker's ping reaches the main loop as a `Ping` command (to be answered
/// with a pong) — never as input or any other side-effecting command.
#[tokio::test(start_paused = true)]
async fn a_worker_ping_becomes_a_ping_command() {
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let mut rx = start_reader(server, 3);
    protocol::write_frame_async(&mut client, MSG_PING, &[])
        .await
        .unwrap();

    let cmd = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("the ping is forwarded promptly")
        .expect("a command");
    assert!(matches!(cmd, AgentCommand::Ping), "a ping must map to Ping");
    drop(client);
}

/// End to end over a real endpoint: the daemon advertises [`CAP_HEARTBEAT`] and
/// answers a ping with an empty pong and nothing else.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_daemon_advertises_heartbeat_and_answers_a_ping_with_a_bare_pong() {
    let id = format!(
        "itest-3140-hb-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let endpoint = transport::session_endpoint(&id);
    let _daemon = super::recovery_guard::spawn_daemon(&endpoint).await;

    let (mut reader, mut writer) = transport::connect(&endpoint).await.expect("connect");
    protocol::write_frame_async(&mut writer, MSG_ATTACH_INTENT, &[INTENT_TAKEOVER])
        .await
        .unwrap();
    protocol::write_frame_async(&mut writer, MSG_AGENT_CAPABILITIES, &[CAP_HEARTBEAT])
        .await
        .unwrap();

    let mut flags = 0u8;
    loop {
        let frame = protocol::read_frame_async(&mut reader)
            .await
            .unwrap()
            .expect("handshake frame");
        match frame.msg_type {
            MSG_CAPABILITIES => flags = frame.payload[0],
            MSG_READY => break,
            _ => {}
        }
    }
    assert_ne!(flags & CAP_HEARTBEAT, 0, "the daemon advertises heartbeat");

    protocol::write_frame_async(&mut writer, MSG_PING, &[])
        .await
        .unwrap();
    let reply = tokio::time::timeout(
        Duration::from_secs(10),
        protocol::read_frame_async(&mut reader),
    )
    .await
    .expect("the daemon answers promptly")
    .unwrap()
    .expect("a reply frame");
    assert_eq!(
        reply.msg_type, MSG_PONG,
        "a ping is answered with a pong only"
    );
    assert!(reply.payload.is_empty());
}
