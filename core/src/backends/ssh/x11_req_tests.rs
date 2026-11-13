//! `x11-req` forwarding (#5570): the byte-level cookie swap on the X11
//! connection setup, the bridge to the local X server, and the request /
//! grant life cycle against an in-process russh server.

// Test code: a failed setup step is a bug in the test.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::server::{Auth, Msg as ServerMsg, Session};
use russh::{Channel, ChannelId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use super::*;
use crate::backends::ssh::handler::{HandshakeContext, SshSession, TermiHubHandler};
use crate::backends::ssh::host_key::{HostKeyInfo, HostKeyVerifier};
use crate::backends::ssh::ki_test_server::server_config;

const FAKE: [u8; 16] = [0xfa; 16];
const REAL: [u8; 16] = [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
];
const REAL_HEX: &str = "00112233445566778899aabbccddeeff";
const STEP: Duration = Duration::from_secs(10);

fn cookies(real: Option<&[u8]>) -> X11Cookies {
    X11Cookies::from_parts(FAKE.to_vec(), real.map(<[u8]>::to_vec))
}

/// An X11 connection setup as a client sends it, in `order` (`b'B'`/`b'l'`).
fn setup(order: u8, name: &[u8], data: &[u8]) -> Vec<u8> {
    let enc = |n: usize| {
        let n = n as u16;
        if order == b'B' {
            n.to_be_bytes()
        } else {
            n.to_le_bytes()
        }
    };
    let mut out = vec![order, 0];
    out.extend_from_slice(&enc(11)); // protocol major
    out.extend_from_slice(&enc(0)); // protocol minor
    out.extend_from_slice(&enc(name.len()));
    out.extend_from_slice(&enc(data.len()));
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(name);
    out.resize(12 + pad4(name.len()), 0);
    out.extend_from_slice(data);
    out.resize(12 + pad4(name.len()) + pad4(data.len()), 0);
    out
}

fn mit(order: u8, data: &[u8]) -> Vec<u8> {
    setup(order, MIT_MAGIC_COOKIE_1.as_bytes(), data)
}

// ── Cookie swap, byte level ─────────────────────────────────────────────

#[test]
fn fake_cookie_is_swapped_for_the_real_one_in_both_byte_orders() {
    for order in *b"Bl" {
        let SetupRewrite::Rewritten {
            setup: out,
            consumed,
        } = rewrite_setup(&mit(order, &FAKE), &cookies(Some(&REAL)))
        else {
            panic!("byte order {order}: a setup with the fake cookie must pass");
        };
        assert_eq!(consumed, mit(order, &FAKE).len());
        // Byte for byte what a client holding the real cookie would send.
        assert_eq!(out, mit(order, &REAL), "byte order {order}");
        let fake_at = out.windows(FAKE.len()).position(|w| w == FAKE);
        assert!(
            fake_at.is_none(),
            "the fake cookie must not reach the local server"
        );
    }
}

#[test]
fn big_endian_lengths_are_read_big_endian() {
    let bytes = mit(b'B', &FAKE);
    assert_eq!(&bytes[6..10], &[0, 18, 0, 16]);
    let bytes = mit(b'l', &FAKE);
    assert_eq!(&bytes[6..10], &[18, 0, 16, 0]);
}

#[test]
fn a_cookieless_local_server_gets_no_authorization() {
    for order in *b"Bl" {
        let SetupRewrite::Rewritten { setup: out, .. } =
            rewrite_setup(&mit(order, &FAKE), &cookies(None))
        else {
            panic!("a fake-cookie setup must pass");
        };
        assert_eq!(out, setup(order, b"", b""));
    }
}

#[test]
fn bytes_after_the_setup_are_not_consumed() {
    let mut bytes = mit(b'l', &FAKE);
    let len = bytes.len();
    bytes.extend_from_slice(b"next request");
    match rewrite_setup(&bytes, &cookies(Some(&REAL))) {
        SetupRewrite::Rewritten { consumed, .. } => assert_eq!(consumed, len),
        other => panic!("expected a rewrite, got {other:?}"),
    }
}

#[test]
fn a_partial_setup_is_incomplete_at_every_length() {
    let bytes = mit(b'B', &FAKE);
    for cut in 0..bytes.len() {
        assert_eq!(
            rewrite_setup(&bytes[..cut], &cookies(Some(&REAL))),
            SetupRewrite::Incomplete,
            "cut at {cut}"
        );
    }
}

#[test]
fn setups_that_do_not_carry_the_fake_cookie_are_rejected() {
    let c = cookies(Some(&REAL));
    let reject = |bytes: Vec<u8>| match rewrite_setup(&bytes, &c) {
        SetupRewrite::Rejected(why) => why,
        other => panic!("expected a rejection, got {other:?}"),
    };
    for order in *b"Bl" {
        // The real cookie itself is not accepted from the remote side.
        assert_eq!(reject(mit(order, &REAL)), SetupRejection::WrongCookie);
        let mut one_off = FAKE;
        one_off[15] ^= 1;
        assert_eq!(reject(mit(order, &one_off)), SetupRejection::WrongCookie);
        assert_eq!(reject(mit(order, &FAKE[..8])), SetupRejection::WrongCookie);
        assert_eq!(reject(mit(order, b"")), SetupRejection::WrongCookie);
        assert_eq!(
            reject(setup(order, b"", b"")),
            SetupRejection::WrongProtocol
        );
        assert_eq!(
            reject(setup(order, b"XDM-AUTHORIZATION-1", &FAKE)),
            SetupRejection::WrongProtocol
        );
    }
    let mut bad_order = mit(b'B', &FAKE);
    bad_order[0] = b'X';
    assert_eq!(reject(bad_order), SetupRejection::BadByteOrder);
    // A bad byte order is refused from the very first byte.
    assert_eq!(reject(vec![0]), SetupRejection::BadByteOrder);
}

#[test]
fn generated_fake_cookie_matches_the_real_length_and_is_random() {
    let a = X11Cookies::generate(Some(REAL_HEX));
    let b = X11Cookies::generate(Some(REAL_HEX));
    assert_eq!(a.fake.len(), 16);
    assert_eq!(a.real.as_deref(), Some(&REAL[..]));
    assert_ne!(a.fake, b.fake);
    assert_ne!(a.fake, REAL);
    let none = X11Cookies::generate(None);
    assert_eq!(none.fake.len(), 16);
    assert!(none.real.is_none());
    assert!(X11Cookies::generate(Some("not hex")).real.is_none());
}

#[test]
fn debug_output_never_shows_a_cookie() {
    let shown = format!("{:?}", X11Cookies::generate(Some(REAL_HEX)));
    assert!(!shown.contains(REAL_HEX), "{shown}");
    assert!(!shown.contains("0, 17, 34"), "{shown}");
    assert!(shown.contains("redacted"));
}

#[test]
fn the_mode_is_described_for_the_user() {
    assert!(X11Mode::ChannelRequest.describe().contains("x11-req"));
    assert!(X11Mode::TypedFallback.describe().contains("fallback"));
}

#[test]
fn the_session_mode_follows_the_reply_and_the_fallback() {
    use X11ForwardingMode as M;
    assert_eq!(forwarding_mode(Ok(()), false), M::ServerForwarded);
    assert_eq!(forwarding_mode(Ok(()), true), M::ServerForwarded);
    let refused = Err(X11ReqRefusal::Refused);
    assert_eq!(forwarding_mode(refused, true), M::FallbackRefused);
    assert_eq!(
        forwarding_mode(Err(X11ReqRefusal::NoReply), true),
        M::FallbackNoReply
    );
    assert_eq!(
        forwarding_mode(Err(X11ReqRefusal::ChannelGone), true),
        M::FallbackNoReply
    );
    for refusal in [
        X11ReqRefusal::Refused,
        X11ReqRefusal::NoReply,
        X11ReqRefusal::ChannelGone,
    ] {
        assert_eq!(
            forwarding_mode(Err(refusal), false),
            M::Failed,
            "{refusal:?}"
        );
    }
}

#[test]
fn the_session_reason_follows_the_reply_and_the_fallback() {
    use crate::connection::X11ForwardingReason as R;
    assert_eq!(forwarding_reason(None, true), None, "server-forwarded");
    assert_eq!(forwarding_reason(None, false), None, "server-forwarded");
    assert_eq!(
        forwarding_reason(Some(&X11ReqRefusal::Refused), true),
        Some(R::ServerRefused)
    );
    assert_eq!(
        forwarding_reason(Some(&X11ReqRefusal::NoReply), true),
        Some(R::ServerNoReply)
    );
    assert_eq!(
        forwarding_reason(Some(&X11ReqRefusal::ChannelGone), true),
        Some(R::ServerNoReply)
    );
    for refusal in [
        X11ReqRefusal::Refused,
        X11ReqRefusal::NoReply,
        X11ReqRefusal::ChannelGone,
    ] {
        assert_eq!(
            forwarding_reason(Some(&refusal), false),
            Some(R::FallbackFailed),
            "{refusal:?}"
        );
    }
}

#[test]
fn the_session_reason_serializes_for_the_ui() {
    use crate::connection::X11ForwardingReason as R;
    for (reason, wire) in [
        (R::NoLocalXServer, "noLocalXServer"),
        (R::ServerRefused, "serverRefused"),
        (R::ServerNoReply, "serverNoReply"),
        (
            R::UntrustedNoSecurityExtension,
            "untrustedNoSecurityExtension",
        ),
        (R::UntrustedXauthMissing, "untrustedXauthMissing"),
        (R::UntrustedXauthFailed, "untrustedXauthFailed"),
        (R::FallbackFailed, "fallbackFailed"),
    ] {
        assert_eq!(serde_json::to_value(reason).unwrap(), wire);
    }
}

#[test]
fn the_session_mode_serializes_for_the_ui() {
    use X11ForwardingMode as M;
    for (mode, wire) in [
        (M::ServerForwarded, "serverForwarded"),
        (M::FallbackRefused, "fallbackRefused"),
        (M::FallbackNoReply, "fallbackNoReply"),
        (M::Failed, "failed"),
    ] {
        assert_eq!(serde_json::to_value(mode).unwrap(), wire);
    }
}

/// The mode a session reports for the server's answer, with the fallback up.
fn reported(
    result: &Result<(X11ReqForwarder, VecDeque<russh::ChannelMsg>), X11ReqRefusal>,
) -> X11ForwardingMode {
    forwarding_mode(result.as_ref().map(|_| ()).map_err(|r| *r), true)
}

// ── Bridge to the local X server ────────────────────────────────────────

/// A fake local X server: records the first connection's bytes, answers `ok`.
async fn fake_x_server() -> (
    LocalXServerInfo,
    tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut got = vec![0u8; 256];
                let n = sock.read(&mut got).await.unwrap_or(0);
                got.truncate(n);
                let _ = sock.write_all(b"ok").await;
                let _ = tx.send(got);
            });
        }
    });
    let info = LocalXServerInfo {
        display_number: 0,
        connection: LocalXConnection::Tcp("127.0.0.1".into(), port),
    };
    (info, rx)
}

#[tokio::test]
async fn bridge_sends_the_real_cookie_and_relays_both_ways() {
    let (local, mut seen) = fake_x_server().await;
    let (mut client, server_side) = tokio::io::duplex(4096);
    let task = tokio::spawn(async move {
        serve_x11_connection(server_side, &cookies(Some(&REAL)), &local).await
    });
    let mut sent = mit(b'l', &FAKE);
    sent.extend_from_slice(b"REQ");
    client.write_all(&sent).await.unwrap();
    let got = tokio::time::timeout(STEP, seen.recv())
        .await
        .unwrap()
        .unwrap();
    let mut want = mit(b'l', &REAL);
    want.extend_from_slice(b"REQ");
    // The setup and the request after it may arrive in one or two reads.
    assert!(want.starts_with(&got) && got.len() >= mit(b'l', &REAL).len());
    let mut answer = [0u8; 2];
    tokio::time::timeout(STEP, client.read_exact(&mut answer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&answer, b"ok");
    drop(client);
    assert_eq!(task.await.unwrap(), Ok(()));
}

#[tokio::test]
async fn bridge_refuses_a_wrong_cookie_without_contacting_the_local_server() {
    let (local, mut seen) = fake_x_server().await;
    let (mut client, server_side) = tokio::io::duplex(4096);
    let task = tokio::spawn(async move {
        serve_x11_connection(server_side, &cookies(Some(&REAL)), &local).await
    });
    client.write_all(&mit(b'B', &REAL)).await.unwrap();
    assert_eq!(task.await.unwrap(), Err(SetupRejection::WrongCookie));
    let mut rest = Vec::new();
    let _ = client.read_to_end(&mut rest).await;
    assert!(rest.is_empty(), "nothing is answered on a refused setup");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), seen.recv())
            .await
            .is_err(),
        "the local X server must not be contacted"
    );
}

#[tokio::test]
async fn bridge_refuses_a_truncated_setup() {
    let (local, _seen) = fake_x_server().await;
    let (mut client, server_side) = tokio::io::duplex(4096);
    let task = tokio::spawn(async move {
        serve_x11_connection(server_side, &cookies(Some(&REAL)), &local).await
    });
    client.write_all(&mit(b'B', &FAKE)[..20]).await.unwrap();
    client.shutdown().await.unwrap();
    assert_eq!(task.await.unwrap(), Err(SetupRejection::Truncated));
}

// ── x11-req against an in-process server ───────────────────────────────

const USER: &str = "alice";
const PASSWORD: &str = "hunter2";

struct TrustAll;

#[async_trait::async_trait]
impl HostKeyVerifier for TrustAll {
    async fn verify(&self, _info: &HostKeyInfo) -> bool {
        true
    }
}

/// What the server saw in `x11-req`: protocol and (hex) cookie.
type SeenReq = Arc<Mutex<Option<(String, String, bool)>>>;

/// A server that answers `x11-req` with success or failure and keeps the
/// session channels open.
/// How the test server answers `x11-req`.
#[derive(Clone, Copy)]
enum Reply {
    Accept,
    Refuse,
    /// Never answers, as a server that ignores the request.
    Silent,
}

struct X11Server {
    reply: Reply,
    seen: SeenReq,
    channels: Vec<Channel<ServerMsg>>,
}

impl russh::server::Handler for X11Server {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == USER && password == PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<ServerMsg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.push(channel);
        reply.accept().await;
        Ok(())
    }

    async fn x11_request(
        &mut self,
        channel: ChannelId,
        single_connection: bool,
        protocol: &str,
        cookie: &str,
        _screen: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.seen.lock().unwrap() = Some((protocol.into(), cookie.into(), single_connection));
        match self.reply {
            Reply::Accept => session.channel_success(channel)?,
            Reply::Refuse => session.channel_failure(channel)?,
            Reply::Silent => {}
        }
        Ok(())
    }
}

struct Connected {
    _client: SshSession,
    channel: russh::Channel<russh::client::Msg>,
    server: russh::server::Handle,
    registry: crate::backends::ssh::handler::ForwardedChannelRegistry,
    seen: SeenReq,
}

async fn connect(accept_x11: bool) -> Connected {
    connect_replying(if accept_x11 {
        Reply::Accept
    } else {
        Reply::Refuse
    })
    .await
}

async fn connect_replying(reply: Reply) -> Connected {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let seen = SeenReq::default();
    let handler = X11Server {
        reply,
        seen: seen.clone(),
        channels: Vec::new(),
    };
    let (handle_tx, handle_rx) = oneshot::channel();
    tokio::spawn(async move {
        let running = russh::server::run_stream(server_config(), server_io, handler)
            .await
            .expect("server handshake");
        let _ = handle_tx.send(running.handle());
        let _ = running.await;
    });
    let (handler, registry, _watch) =
        TermiHubHandler::new_with_forwarding("x11-5570.invalid".into(), 22, false);
    let handler = handler.with_handshake(HandshakeContext {
        verifier: Some(Arc::new(TrustAll)),
        ..HandshakeContext::default()
    });
    let mut client = russh::client::connect_stream(
        Arc::new(russh::client::Config::default()),
        client_io,
        handler,
    )
    .await
    .expect("client handshake");
    assert!(client
        .authenticate_password(USER, PASSWORD)
        .await
        .expect("authenticate")
        .success());
    let channel = client.channel_open_session().await.expect("session");
    let server = tokio::time::timeout(STEP, handle_rx)
        .await
        .unwrap()
        .unwrap();
    Connected {
        _client: client,
        channel,
        server,
        registry,
        seen,
    }
}

fn resolved(local: &LocalXServerInfo, cookie: Option<&str>) -> ResolvedXServer {
    ResolvedXServer {
        info: local.clone(),
        cookie: cookie.map(str::to_string),
    }
}

/// Open an `x11` channel from the server and send a setup with `cookie`.
async fn open_and_send(
    server: &russh::server::Handle,
    cookie: &[u8],
) -> Result<Channel<ServerMsg>, russh::Error> {
    let channel = server.channel_open_x11("127.0.0.1", 40000).await?;
    channel
        .data(&mit(b'l', cookie)[..])
        .await
        .expect("send setup");
    Ok(channel)
}

#[tokio::test]
async fn accepted_x11_req_forwards_with_the_real_cookie_locally_only() {
    let (local, mut seen_local) = fake_x_server().await;
    let mut c = connect(true).await;
    let alive = Arc::new(AtomicBool::new(true));
    let forwarder = request_x11_forwarding(
        &mut c.channel,
        &c.registry,
        &resolved(&local, Some(REAL_HEX)),
        alive,
        None,
        None,
    )
    .await;
    assert_eq!(reported(&forwarder), X11ForwardingMode::ServerForwarded);
    let (forwarder, _early) = forwarder.expect("the server accepted x11-req");

    let (protocol, fake_hex, single) = c.seen.lock().unwrap().clone().expect("x11-req seen");
    assert_eq!(protocol, MIT_MAGIC_COOKIE_1);
    assert!(!single, "single_connection must be false");
    assert_eq!(fake_hex.len(), 32);
    assert_ne!(
        fake_hex, REAL_HEX,
        "the real cookie must never go to the server"
    );
    let fake = hex::decode(&fake_hex).unwrap();

    let _x = open_and_send(&c.server, &fake).await.expect("x11 accepted");
    let got = tokio::time::timeout(STEP, seen_local.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        got,
        mit(b'l', &REAL),
        "the local server gets the real cookie"
    );

    // A connection with any other cookie is closed before the local server.
    let _bad = open_and_send(&c.server, &REAL).await.expect("x11 accepted");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), seen_local.recv())
            .await
            .is_err(),
        "a wrong-cookie connection must not reach the local server"
    );

    // Session over: later x11 opens are refused.
    drop(forwarder);
    let after = c.server.channel_open_x11("127.0.0.1", 40001).await;
    assert!(
        matches!(
            after,
            Err(russh::Error::ChannelOpenFailure(
                russh::ChannelOpenFailure::AdministrativelyProhibited
            ))
        ),
        "an x11 channel after teardown must be refused"
    );
}

#[tokio::test]
async fn the_grant_lapses_when_the_session_is_no_longer_alive() {
    let (local, _seen_local) = fake_x_server().await;
    let mut c = connect(true).await;
    let alive = Arc::new(AtomicBool::new(true));
    let (_forwarder, _early) = request_x11_forwarding(
        &mut c.channel,
        &c.registry,
        &resolved(&local, None),
        alive.clone(),
        None,
        None,
    )
    .await
    .expect("accepted");
    alive.store(false, std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(ALIVE_POLL * 3).await;
    assert!(c.registry.x11_listener().is_none());
    let open = c.server.channel_open_x11("127.0.0.1", 40000).await;
    assert!(open.is_err(), "no x11 channel once the session is dead");
}

#[tokio::test]
async fn refused_x11_req_selects_the_fallback_and_grants_nothing() {
    let (local, _seen_local) = fake_x_server().await;
    let mut c = connect(false).await;
    let result = request_x11_forwarding(
        &mut c.channel,
        &c.registry,
        &resolved(&local, Some(REAL_HEX)),
        Arc::new(AtomicBool::new(true)),
        None,
        None,
    )
    .await;
    assert_eq!(reported(&result), X11ForwardingMode::FallbackRefused);
    assert_eq!(result.err(), Some(X11ReqRefusal::Refused));
    assert!(c.registry.x11_listener().is_none());
    let open = c.server.channel_open_x11("127.0.0.1", 40000).await;
    assert!(open.is_err(), "no x11 channel without an accepted x11-req");
}

#[tokio::test]
async fn new_x11_channels_are_refused_after_the_untrusted_timeout() {
    let (local, mut seen_local) = fake_x_server().await;
    let mut c = connect(true).await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(400);
    let (_forwarder, _early) = request_x11_forwarding(
        &mut c.channel,
        &c.registry,
        &resolved(&local, Some(REAL_HEX)),
        Arc::new(AtomicBool::new(true)),
        None,
        Some(deadline),
    )
    .await
    .expect("accepted");
    let (_, fake_hex, _) = c.seen.lock().unwrap().clone().expect("x11-req seen");
    let fake = hex::decode(&fake_hex).unwrap();

    // Before the timeout: served as usual.
    let before = open_and_send(&c.server, &fake).await.expect("x11 accepted");
    let got = tokio::time::timeout(STEP, seen_local.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got, mit(b'l', &REAL));

    // After it: refused at the SSH level, like OpenSSH's ForwardX11Timeout.
    tokio::time::sleep_until(deadline + ALIVE_POLL).await;
    let after = c.server.channel_open_x11("127.0.0.1", 40001).await;
    assert!(
        matches!(
            after,
            Err(russh::Error::ChannelOpenFailure(
                russh::ChannelOpenFailure::AdministrativelyProhibited
            ))
        ),
        "an x11 channel after the timeout must be refused"
    );
    drop(before);
}

#[tokio::test]
async fn unanswered_x11_req_selects_the_fallback_and_grants_nothing() {
    let (local, _seen_local) = fake_x_server().await;
    let mut c = connect_replying(Reply::Silent).await;
    let result = request_x11_forwarding_within(
        &mut c.channel,
        &c.registry,
        &resolved(&local, Some(REAL_HEX)),
        Arc::new(AtomicBool::new(true)),
        None,
        Duration::from_millis(200),
        None,
    )
    .await;
    assert!(c.seen.lock().unwrap().is_some(), "x11-req was sent");
    assert_eq!(reported(&result), X11ForwardingMode::FallbackNoReply);
    assert_eq!(result.err(), Some(X11ReqRefusal::NoReply));
    assert!(c.registry.x11_listener().is_none());
}
