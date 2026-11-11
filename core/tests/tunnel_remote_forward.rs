#![cfg(feature = "ssh")]
//! Remote (`ssh -R`) forward integration tests against the `ssh-tunnel-target`
//! container (port 2207, `GatewayPorts yes`, `AllowTcpForwarding yes`).
//!
//! These drive the shared [`RemoteForwarder`] engine (`termihub_core::tunnel`)
//! end to end over a real SSH connection (#5169, COV-009) — the engine both the
//! desktop tunnel manager and an agent-hosted tunnel run. The twin of
//! `tunnel_local_forward.rs`:
//!
//! 1. A loopback echo server on this machine is the `-R` target.
//! 2. The forwarder asks the server to listen on `127.0.0.1:0`; the server
//!    picks an ephemeral port and reports it (`bound_port`).
//! 3. A **second** SSH session opens a `direct-tcpip` channel to the server's
//!    own `127.0.0.1:<bound_port>` — the server connects into its forwarded
//!    listener, which fans a `forwarded-tcpip` channel back to the forwarder,
//!    which relays it to the echo server. Driving it from the server side this
//!    way needs no container port mapping, so the ephemeral port stays safe for
//!    concurrent runs. Whether that `direct-tcpip` open succeeds is also how the
//!    tests see whether the server-side listener still exists.
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d
//! ssh-tunnel-target`. Skips gracefully when the container is not running
//! (hard-fails under `TERMIHUB_REQUIRE_DOCKER=1`, as in `integration-fixtures.yml`).

mod common;

use std::time::Duration;

use common::{port_ssh_tunnel, require_docker, ssh_password_config};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::tunnel::config::{RemoteForwardConfig, TunnelStats};
use termihub_core::tunnel::remote_forward::RemoteForwarder;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// How long any single step may take before the test fails.
const STEP: Duration = Duration::from_secs(10);

/// Spawn a loopback TCP echo server — the `-R` target — returning its port.
///
/// Each connection is echoed until the relay half-closes, then shut down
/// cleanly, so the relay's `copy_bidirectional` ends with `Ok` and records its
/// byte counts (an abrupt drop would RST and skip the stats, see #2395).
async fn spawn_echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind echo server");
    let port = listener.local_addr().expect("echo addr").port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut rd, mut wr) = sock.split();
                let _ = tokio::io::copy(&mut rd, &mut wr).await;
                let _ = wr.shutdown().await;
            });
        }
    });
    port
}

/// A `-R` forward asking the server for an ephemeral loopback port that relays
/// back to `target_port` on this machine.
fn forward_to(target_port: u16) -> RemoteForwardConfig {
    RemoteForwardConfig {
        remote_host: "127.0.0.1".to_string(),
        remote_port: 0,
        local_host: "127.0.0.1".to_string(),
        local_port: target_port,
    }
}

/// Open a fresh, authenticated session to the fixture.
async fn connect() -> (
    SshSession,
    termihub_core::backends::ssh::handler::ForwardedChannelRegistry,
) {
    tokio::time::timeout(
        STEP,
        connect_and_authenticate(&ssh_password_config(port_ssh_tunnel())),
    )
    .await
    .expect("SSH connect before timeout")
    .expect("SSH connect to ssh-tunnel-target should succeed")
}

/// Send `payload` through the server-side listener on `bound_port` (via a
/// `direct-tcpip` channel from `driver`), half-close, and return everything
/// that comes back.
async fn round_trip(driver: &SshSession, bound_port: u32, payload: &[u8]) -> Vec<u8> {
    let channel = tokio::time::timeout(
        STEP,
        driver.channel_open_direct_tcpip("127.0.0.1", bound_port, "127.0.0.1", 0),
    )
    .await
    .expect("direct-tcpip open before timeout")
    .expect("open a channel to the server-side forwarded listener");
    let mut stream = channel.into_stream();
    stream
        .write_all(payload)
        .await
        .expect("write into the forwarded listener");
    // EOF towards the server: it half-closes its connection into the listener,
    // the relay sees EOF on the forwarded channel, the echo drains and closes.
    stream.shutdown().await.expect("half-close the channel");
    let mut echoed = Vec::new();
    tokio::time::timeout(STEP, stream.read_to_end(&mut echoed))
        .await
        .expect("echo before timeout")
        .expect("read the echoed bytes");
    echoed
}

/// Whether the server still accepts a connection on its `127.0.0.1:<port>`.
///
/// The server opens a `direct-tcpip` channel only after its own TCP connect to
/// the target succeeded, so a refused open means nothing listens there.
async fn server_listens_on(driver: &SshSession, port: u32) -> bool {
    tokio::time::timeout(
        STEP,
        driver.channel_open_direct_tcpip("127.0.0.1", port, "127.0.0.1", 0),
    )
    .await
    .expect("direct-tcpip open (or refusal) before timeout")
    .is_ok()
}

/// Poll until the server-side listener on `port` is gone, or fail after
/// [`STEP`]. The server tears the listener down asynchronously after a
/// `cancel-tcpip-forward` or a disconnect, so one probe right away can race it.
async fn assert_listener_closes(driver: &SshSession, port: u32, after: &str) {
    let deadline = tokio::time::Instant::now() + STEP;
    while server_listens_on(driver, port).await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the server-side -R listener on 127.0.0.1:{port} must close after {after}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Poll the forwarder's stats until `done` holds (the relay records its byte
/// counts only once both directions of the copy have ended).
async fn wait_for_stats(
    forwarder: &RemoteForwarder,
    done: impl Fn(&TunnelStats) -> bool,
) -> TunnelStats {
    let deadline = tokio::time::Instant::now() + STEP;
    loop {
        let stats = forwarder.get_stats();
        if done(&stats) {
            return stats;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "stats never reached the expected state: {stats:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Bytes sent into the server-side listener reach the local echo target and
/// come back, and `get_stats` reports exactly that traffic. Uses the
/// synchronous `start` entry point the desktop tunnel manager calls.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_forward_relays_bytes_and_reports_stats() {
    require_docker!(port_ssh_tunnel());

    let target = spawn_echo_server().await;
    let (session, registry) = connect().await;
    let forwarder = RemoteForwarder::start(&forward_to(target), session, registry)
        .expect("server accepts the -R request");
    let bound = forwarder.bound_port();
    assert_ne!(bound, 0, "the server must report the ephemeral port it bound");

    let fresh = forwarder.get_stats();
    assert_eq!(
        (fresh.bytes_sent, fresh.bytes_received, fresh.active_connections),
        (0, 0, 0),
        "a new forward has moved no traffic"
    );

    let (driver, _driver_registry) = connect().await;
    let first = b"ping-through-R".as_slice();
    assert_eq!(round_trip(&driver, bound, first).await, first);
    let stats = wait_for_stats(&forwarder, |s| s.bytes_sent > 0).await;
    let len = first.len() as u64;
    assert_eq!(stats.bytes_sent, len, "bytes target -> channel: {stats:?}");
    assert_eq!(stats.bytes_received, len, "bytes channel -> target: {stats:?}");

    // A second connection accumulates on top of the first and its relay task
    // ends, so no connection is left counted as active.
    let second = vec![0x5a_u8; 64 * 1024];
    assert_eq!(round_trip(&driver, bound, &second).await, second);
    let total = len + second.len() as u64;
    let stats = wait_for_stats(&forwarder, |s| {
        s.bytes_sent == total && s.active_connections == 0
    })
    .await;
    assert_eq!(stats.bytes_received, total, "{stats:?}");
    assert_eq!(stats.total_connections, 2, "{stats:?}");
}

/// `stop` aborts the forward loop (the death signal fires) and the server-side
/// listener goes away, even while the forwarder value is still held. Uses the
/// async `start_async` entry point the agent calls.
#[tokio::test]
async fn remote_forward_stop_closes_the_server_listener() {
    require_docker!(port_ssh_tunnel());

    let target = spawn_echo_server().await;
    let (session, registry) = connect().await;
    let mut forwarder = RemoteForwarder::start_async(&forward_to(target), session, registry)
        .await
        .expect("server accepts the -R request");
    let bound = forwarder.bound_port();
    let death = forwarder.take_death_signal().expect("death signal");
    assert!(
        forwarder.take_death_signal().is_none(),
        "the death signal is handed out once"
    );

    let (driver, _driver_registry) = connect().await;
    assert_eq!(round_trip(&driver, bound, b"before-stop").await, b"before-stop");

    forwarder.stop();
    tokio::time::timeout(STEP, death)
        .await
        .expect("the forward loop should end after stop")
        .expect_err("the death signal resolves by its sender dropping");
    assert_listener_closes(&driver, bound, "stop").await;

    // Stop is idempotent, and the later drop (which stops again) is harmless.
    forwarder.stop();
    drop(forwarder);
}

/// Dropping the forwarder (the agent registry's and the tunnel manager's
/// teardown) stops the forward and the server-side listener goes away.
#[tokio::test]
async fn remote_forward_drop_closes_the_server_listener() {
    require_docker!(port_ssh_tunnel());

    let target = spawn_echo_server().await;
    let (session, registry) = connect().await;
    let mut forwarder = RemoteForwarder::start_async(&forward_to(target), session, registry)
        .await
        .expect("server accepts the -R request");
    let bound = forwarder.bound_port();
    let death = forwarder.take_death_signal().expect("death signal");

    let (driver, _driver_registry) = connect().await;
    assert!(server_listens_on(&driver, bound).await, "listening while up");

    drop(forwarder);
    tokio::time::timeout(STEP, death)
        .await
        .expect("the forward loop should end after drop")
        .expect_err("the death signal resolves by its sender dropping");
    assert_listener_closes(&driver, bound, "drop").await;
}

/// When the **server** ends the forwarder's SSH connection, the death signal
/// fires — that is how the desktop tunnel supervisor learns a remote forward
/// died (it gets no session liveness watch for `-R`), and the listener is gone.
#[tokio::test]
async fn remote_forward_death_signal_fires_when_the_server_closes() {
    require_docker!(port_ssh_tunnel());

    let target = spawn_echo_server().await;
    let (session, registry) = connect().await;
    // Open an exec channel on the forwarder's own session before handing the
    // session over: the command later kills this connection's sshd process
    // (the shell's parent), so the server closes exactly this connection.
    let killer = session
        .channel_open_session()
        .await
        .expect("open a session channel on the forwarder's connection");
    let mut forwarder = RemoteForwarder::start_async(&forward_to(target), session, registry)
        .await
        .expect("server accepts the -R request");
    let bound = forwarder.bound_port();
    let mut death = forwarder.take_death_signal().expect("death signal");

    let (driver, _driver_registry) = connect().await;
    assert_eq!(round_trip(&driver, bound, b"alive").await, b"alive");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut death)
            .await
            .is_err(),
        "the death signal must not fire while the server keeps the connection"
    );

    killer
        .exec(true, "kill -TERM $PPID")
        .await
        .expect("send the kill command");
    tokio::time::timeout(STEP, death)
        .await
        .expect("the death signal should fire once the server closed the connection")
        .expect_err("the death signal resolves by its sender dropping");
    assert_listener_closes(&driver, bound, "the server closed the connection").await;
    drop(forwarder);
}
