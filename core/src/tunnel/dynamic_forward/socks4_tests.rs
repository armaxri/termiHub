//! Loopback tests for SOCKS4/4a on the dynamic forwarder's listener (#4541):
//! CONNECT and relay, the 4a hostname path, reject codes, the USERID field,
//! SOCKS4 and SOCKS5 clients sharing one listener, the handshake timeout, and an
//! end-to-end run through a real TCP echo server.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::super::channel::test_support::EchoChannelOpener;
use super::super::channel::ChannelOpener;
use super::super::config::DynamicForwardConfig;
use super::super::socks4::{
    SOCKS4_CMD_CONNECT, SOCKS4_MAX_USERID_LEN, SOCKS4_REP_GRANTED, SOCKS4_REP_REJECTED,
    SOCKS4_VERSION,
};
use super::*;

fn ephemeral_config() -> DynamicForwardConfig {
    DynamicForwardConfig {
        local_host: "127.0.0.1".to_string(),
        local_port: 0,
    }
}

fn start<O: ChannelOpener>(opener: O) -> DynamicForwarder {
    DynamicForwarder::start_with_opener(&ephemeral_config(), opener).expect("start forwarder")
}

async fn connect(forwarder: &DynamicForwarder) -> TcpStream {
    TcpStream::connect(forwarder.local_addr())
        .await
        .expect("connect to socks proxy")
}

/// A full SOCKS4 request: `VN CD DSTPORT DSTIP USERID NUL [HOST NUL]`.
fn socks4_request(cd: u8, port: u16, ip: [u8; 4], userid: &[u8], host: Option<&[u8]>) -> Vec<u8> {
    let mut bytes = vec![SOCKS4_VERSION, cd];
    bytes.extend_from_slice(&port.to_be_bytes());
    bytes.extend_from_slice(&ip);
    bytes.extend_from_slice(userid);
    bytes.push(0);
    if let Some(host) = host {
        bytes.extend_from_slice(host);
        bytes.push(0);
    }
    bytes
}

async fn read_socks4_reply(client: &mut TcpStream) -> [u8; 8] {
    let mut reply = [0u8; 8];
    client
        .read_exact(&mut reply)
        .await
        .expect("read socks4 reply");
    reply
}

/// Write `payload`, half-close, and return everything echoed back.
async fn round_trip(client: &mut TcpStream, payload: &[u8]) -> Vec<u8> {
    client.write_all(payload).await.expect("write payload");
    client.shutdown().await.expect("half-close");
    let mut echoed = Vec::new();
    client.read_to_end(&mut echoed).await.expect("read echo");
    echoed
}

#[tokio::test]
async fn socks4_ipv4_connect_parses_target_and_relays() {
    let opener = EchoChannelOpener::new();
    let targets = opener.targets_handle();
    let forwarder = start(opener);
    let mut client = connect(&forwarder).await;

    let req = socks4_request(SOCKS4_CMD_CONNECT, 443, [93, 184, 216, 34], b"", None);
    client.write_all(&req).await.expect("write request");
    let reply = read_socks4_reply(&mut client).await;
    assert_eq!(reply[0], 0x00, "SOCKS4 reply version is 0");
    assert_eq!(reply[1], SOCKS4_REP_GRANTED);

    assert_eq!(round_trip(&mut client, b"ping").await, b"ping");
    assert_eq!(
        targets.lock().unwrap().clone(),
        vec![("93.184.216.34".to_string(), 443)]
    );
    assert_eq!(forwarder.get_stats().total_connections, 1);
}

#[tokio::test]
async fn socks4a_hostname_is_forwarded_unresolved() {
    let opener = EchoChannelOpener::new();
    let targets = opener.targets_handle();
    let forwarder = start(opener);
    let mut client = connect(&forwarder).await;

    let req = socks4_request(
        SOCKS4_CMD_CONNECT,
        80,
        [0, 0, 0, 1],
        b"alice",
        Some(b"internal.example"),
    );
    client.write_all(&req).await.expect("write request");
    assert_eq!(read_socks4_reply(&mut client).await[1], SOCKS4_REP_GRANTED);
    assert_eq!(round_trip(&mut client, b"4a").await, b"4a");

    assert_eq!(
        targets.lock().unwrap().clone(),
        vec![("internal.example".to_string(), 80)],
        "the SSH server resolves the 4a hostname, not the forwarder"
    );
}

#[tokio::test]
async fn payload_pipelined_behind_the_request_is_relayed() {
    // The parser must not over-read: bytes sent in the same write as the
    // request belong to the relay.
    let forwarder = start(EchoChannelOpener::new());
    let mut client = connect(&forwarder).await;
    let mut bytes = socks4_request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 9], b"u", Some(b"h"));
    bytes.extend_from_slice(b"early");
    client.write_all(&bytes).await.expect("write request");
    assert_eq!(read_socks4_reply(&mut client).await[1], SOCKS4_REP_GRANTED);
    assert_eq!(round_trip(&mut client, b"-late").await, b"early-late");
}

#[tokio::test]
async fn bind_is_rejected_without_opening_a_channel() {
    let opener = EchoChannelOpener::new();
    let targets = opener.targets_handle();
    let forwarder = start(opener);
    let mut client = connect(&forwarder).await;

    // BIND (CD 0x02) followed by payload the server never parses.
    let mut bytes = socks4_request(0x02, 80, [10, 0, 0, 1], b"", None);
    bytes.extend_from_slice(&[0xAB; 4096]);
    client.write_all(&bytes).await.expect("write request");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(read_socks4_reply(&mut client).await[1], SOCKS4_REP_REJECTED);
    assert!(targets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn malformed_requests_get_the_reject_code() {
    let over_long_userid = vec![b'u'; SOCKS4_MAX_USERID_LEN + 1];
    let cases: Vec<Vec<u8>> = vec![
        socks4_request(0x7F, 80, [10, 0, 0, 1], b"", None),
        socks4_request(
            SOCKS4_CMD_CONNECT,
            80,
            [10, 0, 0, 1],
            &over_long_userid,
            None,
        ),
        socks4_request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 1], b"", Some(b"")),
        socks4_request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 1], b"", Some(&[0xFF])),
    ];
    for request in cases {
        let opener = EchoChannelOpener::new();
        let targets = opener.targets_handle();
        let forwarder = start(opener);
        let mut client = connect(&forwarder).await;
        client.write_all(&request).await.expect("write request");
        let reply = read_socks4_reply(&mut client).await;
        assert_eq!(reply, [0x00, SOCKS4_REP_REJECTED, 0, 0, 0, 0, 0, 0]);
        assert!(targets.lock().unwrap().is_empty(), "{request:?}");
    }
}

#[tokio::test]
async fn channel_open_failure_replies_rejected() {
    // SOCKS4 has no finer failure codes: every open failure is 0x5B.
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::HostUnreachable,
        std::io::ErrorKind::Other,
    ] {
        let forwarder = start(EchoChannelOpener::failing_with(kind));
        let mut client = connect(&forwarder).await;
        let req = socks4_request(SOCKS4_CMD_CONNECT, 80, [10, 0, 0, 1], b"", None);
        client.write_all(&req).await.expect("write request");
        assert_eq!(
            read_socks4_reply(&mut client).await[1],
            SOCKS4_REP_REJECTED,
            "{kind:?}"
        );
    }
}

#[tokio::test]
async fn unknown_protocol_version_is_closed_without_a_reply() {
    let forwarder = start(EchoChannelOpener::new());
    let mut client = connect(&forwarder).await;
    client
        .write_all(&[0x47, 0x45, 0x54, 0x20])
        .await
        .expect("write");
    let mut buf = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut buf))
        .await
        .expect("server closes promptly");
    // Either a clean EOF or a reset — but never a reply.
    if read.is_ok() {
        assert!(buf.is_empty(), "no reply for an unknown version: {buf:?}");
    }
}

#[tokio::test]
async fn socks4_and_socks5_clients_share_one_listener() {
    let opener = EchoChannelOpener::new();
    let targets = opener.targets_handle();
    let forwarder = start(opener);

    // Open both connections before either handshakes, so they are in flight
    // on the same listener at once.
    let mut v4 = connect(&forwarder).await;
    let mut v5 = connect(&forwarder).await;

    v5.write_all(&[0x05, 0x01, 0x00]).await.expect("v5 greet");
    let req = socks4_request(SOCKS4_CMD_CONNECT, 8080, [10, 1, 2, 3], b"mixed", None);
    v4.write_all(&req).await.expect("v4 request");

    let mut method = [0u8; 2];
    v5.read_exact(&mut method).await.expect("v5 method");
    assert_eq!(method, [0x05, 0x00]);
    let mut v5_req = vec![0x05, 0x01, 0x00, 0x03, 4];
    v5_req.extend_from_slice(b"five");
    v5_req.extend_from_slice(&5555u16.to_be_bytes());
    v5.write_all(&v5_req).await.expect("v5 request");

    assert_eq!(read_socks4_reply(&mut v4).await[1], SOCKS4_REP_GRANTED);
    let mut v5_reply = [0u8; 10];
    v5.read_exact(&mut v5_reply).await.expect("v5 reply");
    assert_eq!(v5_reply[..2], [0x05, 0x00]);

    assert_eq!(round_trip(&mut v4, b"four").await, b"four");
    assert_eq!(round_trip(&mut v5, b"five").await, b"five");

    let mut seen = targets.lock().unwrap().clone();
    seen.sort();
    assert_eq!(
        seen,
        vec![("10.1.2.3".to_string(), 8080), ("five".to_string(), 5555)]
    );
}

#[tokio::test]
async fn stalled_socks4_handshake_is_closed_by_the_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind proxy listener");
    let addr = listener.local_addr().expect("listener addr");
    let opener = EchoChannelOpener::new();
    let targets = opener.targets_handle();
    let stats = Arc::new(ForwarderStats::new());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept client");
        DynamicForwarder::handle_socks(
            stream,
            Arc::new(opener),
            &stats,
            Duration::from_millis(100),
        )
        .await;
    });

    let mut client = TcpStream::connect(addr).await.expect("connect");
    // A USERID that never terminates: the server must give up at the deadline.
    client
        .write_all(&[SOCKS4_VERSION, SOCKS4_CMD_CONNECT, 0, 80, 10, 0, 0, 1, b'x'])
        .await
        .expect("write partial request");
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("handshake bounded by the timeout")
        .expect("server task ok");
    assert!(targets.lock().unwrap().is_empty());
}

/// A [`ChannelOpener`] that dials the target over real TCP, standing in for
/// the SSH server's `direct-tcpip` connect.
struct TcpDialOpener;

impl ChannelOpener for TcpDialOpener {
    type Stream = TcpStream;

    async fn open_direct_tcpip(&self, host: String, port: u16) -> std::io::Result<TcpStream> {
        TcpStream::connect((host.as_str(), port)).await
    }
}

/// A real TCP echo server on loopback; returns its port.
async fn spawn_echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind echo");
    let port = listener.local_addr().expect("echo addr").port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut rd, mut wr) = stream.split();
                let _ = tokio::io::copy(&mut rd, &mut wr).await;
            });
        }
    });
    port
}

#[tokio::test]
async fn end_to_end_socks4_and_socks4a_through_a_real_tcp_target() {
    let echo_port = spawn_echo_server().await;
    let forwarder = start(TcpDialOpener);

    // SOCKS4 with an IPv4 target.
    let mut client = connect(&forwarder).await;
    let req = socks4_request(SOCKS4_CMD_CONNECT, echo_port, [127, 0, 0, 1], b"e2e", None);
    client.write_all(&req).await.expect("write request");
    assert_eq!(read_socks4_reply(&mut client).await[1], SOCKS4_REP_GRANTED);
    assert_eq!(round_trip(&mut client, b"over tcp").await, b"over tcp");

    // SOCKS4a: the hostname is resolved by the dialing side.
    let mut client = connect(&forwarder).await;
    let req = socks4_request(
        SOCKS4_CMD_CONNECT,
        echo_port,
        [0, 0, 0, 1],
        b"",
        Some(b"127.0.0.1"),
    );
    client.write_all(&req).await.expect("write request");
    assert_eq!(read_socks4_reply(&mut client).await[1], SOCKS4_REP_GRANTED);
    assert_eq!(round_trip(&mut client, b"by name").await, b"by name");

    // A closed port: the dial fails and the client gets the reject code.
    let closed = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let closed_port = closed.local_addr().expect("addr").port();
    drop(closed);
    let mut client = connect(&forwarder).await;
    let req = socks4_request(SOCKS4_CMD_CONNECT, closed_port, [127, 0, 0, 1], b"", None);
    client.write_all(&req).await.expect("write request");
    assert_eq!(read_socks4_reply(&mut client).await[1], SOCKS4_REP_REJECTED);
}
