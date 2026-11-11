//! A followed Server Redirection driven end to end against a scripted
//! connection broker (#5271, follow-up to #5137).
//!
//! The broker and the servers behind it are small RDP servers scripted here
//! byte for byte on `ironrdp-pdu`: X.224 (TLS selected), a TLS handshake with
//! a throwaway certificate (`testdata/redirect_*.der`), the MCS connect
//! sequence, licensing, and then a Server Redirection PDU — during the
//! capability exchange, mid-session, or inside a reactivation. Each records
//! every byte it receives. The real [`run_session`](super::run_session) is
//! the client, with a scripted host answering its certificate prompts.
//!
//! The servers run TLS-only (no NLA): a CredSSP acceptor would need a
//! server-side NTLM stack. What the tests prove about CredSSP is that nothing
//! at all follows the preflight's TLS handshake until the trust gate passed.
//!
//! A redirection names no port, so every hop keeps the configured one: the
//! broker listens on `127.0.0.1:P` and the target on `[::1]:P`.

#[path = "redirect_broker.rs"]
mod broker;

use std::sync::Arc;
use std::time::Duration;

use ironrdp_pdu::gcc::RedirectionFlags;
use ironrdp_pdu::rdp::server_redirection::ServerRedirectionPdu;
use termihub_core::backends::rdp_sidecar::config::RdpConfig;
use termihub_core::backends::rdp_sidecar::protocol::{
    read_message, write_message, HostMessage, SidecarFailureKind, SidecarMessage,
};
use termihub_core::connection::GraphicalState;
use tokio::io::DuplexStream;

use crate::redirect::RedirectRefused;
use broker::*;

const BROKER_NAME: &str = "redirect-broker.test";
const TARGET_NAME: &str = "redirect-target.test";
const ROUTING_TOKEN: &str = "Cookie: msts=3640205228.15629.0000";
const SESSION_ID: u32 = 7;
const REDIRECT_USER: &str = "bob";
const PASSWORD_COOKIE: &[u8] = b"one-time-cookie";

/// A Server Redirection to `address` (named `fqdn`) with the routing token,
/// session, username and password cookie a broker hands out.
fn redirect_to(address: &str, fqdn: &str, session_id: u32) -> ServerRedirectionPdu {
    ServerRedirectionPdu {
        session_id,
        target_net_address: Some(address.to_string()),
        target_fqdn: Some(fqdn.to_string()),
        load_balance_info: Some(format!("{ROUTING_TOKEN}\r\n").into_bytes()),
        username: Some(REDIRECT_USER.to_string()),
        password: Some(PASSWORD_COOKIE.to_vec()),
        ..ServerRedirectionPdu::default()
    }
}

fn to_target(session_id: u32) -> ServerRedirectionPdu {
    redirect_to("::1", TARGET_NAME, session_id)
}

fn to_broker(session_id: u32) -> ServerRedirectionPdu {
    redirect_to("127.0.0.1", BROKER_NAME, session_id)
}

/// The scripted host: answers every certificate prompt, accepting the
/// connection's own host and any target `trust` approves, and returns
/// everything the sidecar sent.
async fn host(
    mut from_sidecar: DuplexStream,
    mut to_sidecar: DuplexStream,
    events: Log,
    trust: fn(&str) -> bool,
) -> Vec<SidecarMessage> {
    let mut received = Vec::new();
    while let Ok(message) = read_message::<_, SidecarMessage>(&mut from_sidecar).await {
        match &message {
            SidecarMessage::CertPrompt { host, .. } => {
                let accept = host.as_deref().is_none_or(trust);
                let name = host.as_deref().unwrap_or("origin");
                log(&events, format!("prompt {name}"));
                log(
                    &events,
                    format!("{} {name}", if accept { "accept" } else { "reject" }),
                );
                let decision = HostMessage::CertDecision {
                    accept,
                    remember: false,
                };
                let _ = write_message(&mut to_sidecar, &decision).await;
            }
            SidecarMessage::State(GraphicalState::Active) => log(&events, "active".to_string()),
            _ => {}
        }
        received.push(message);
    }
    received
}

struct Run {
    result: anyhow::Result<()>,
    messages: Vec<SidecarMessage>,
    events: Vec<String>,
    broker: Server,
    target: Server,
}

/// Run the real sidecar session against a broker and a target playing
/// `broker` and `target`, with the host answering `trust` for redirect
/// targets.
async fn run(broker: Vec<Act>, target: Vec<Act>, trust: fn(&str) -> bool) -> Run {
    let (broker_listener, target_listener, port) = bind_pair().await;
    let events: Log = Arc::default();
    let broker = spawn_server(
        broker_listener,
        "broker",
        BROKER_CERT,
        BROKER_KEY,
        broker,
        Arc::clone(&events),
    );
    let target = spawn_server(
        target_listener,
        "target",
        TARGET_CERT,
        TARGET_KEY,
        target,
        Arc::clone(&events),
    );

    let cfg = RdpConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "alice".to_string(),
        password: "saved-password".to_string(),
        domain: "CORP".to_string(),
        connect_timeout_secs: Some(5),
        ..RdpConfig::default()
    };
    let (host_writer, mut sidecar_in) = tokio::io::duplex(64 * 1024);
    let (mut sidecar_out, host_reader) = tokio::io::duplex(1024 * 1024);
    let host = tokio::spawn(host(host_reader, host_writer, Arc::clone(&events), trust));

    let result = tokio::time::timeout(
        Duration::from_secs(60),
        super::run_session(cfg, &mut sidecar_in, &mut sidecar_out),
    )
    .await
    .expect("the session ends");
    drop(sidecar_out);
    let messages = host.await.unwrap();
    let events = events.lock().unwrap().clone();
    Run {
        result,
        messages,
        events,
        broker,
        target,
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn fingerprint(cert_der: &[u8]) -> String {
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(cert_der).unwrap();
    super::server_identity(&cert).unwrap().fingerprint
}

fn prompts(messages: &[SidecarMessage]) -> Vec<(Option<String>, String)> {
    messages
        .iter()
        .filter_map(|m| match m {
            SidecarMessage::CertPrompt {
                host, fingerprint, ..
            } => Some((host.clone(), fingerprint.clone())),
            _ => None,
        })
        .collect()
}

fn refusal(result: &anyhow::Result<()>) -> RedirectRefused {
    let error = result.as_ref().expect_err("the redirection is refused");
    assert_eq!(
        crate::failure::classify(error),
        SidecarFailureKind::Protocol,
        "{error:#}"
    );
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<RedirectRefused>())
        .cloned()
        .unwrap_or_else(|| panic!("not a typed refusal: {error:#}"))
}

/// A preflight: an X.224 request naming nobody, a TLS handshake, then
/// nothing — no Connect Initial, no Client Info, no CredSSP.
fn assert_preflight(conn: &Conn) {
    assert!(!conn.x224_request.is_empty(), "an X.224 request was sent");
    for secret in [&b"Cookie"[..], b"msts", b"mstshash", b"alice", b"bob"] {
        assert!(
            !contains(&conn.x224_request, secret),
            "{} in the preflight X.224 request",
            String::from_utf8_lossy(secret)
        );
    }
    assert!(
        conn.after_tls.is_empty(),
        "the preflight sent {} bytes after TLS",
        conn.after_tls.len()
    );
}

/// The reconnect to a redirect target: the routing token in the X.224
/// request, the session in the cluster data, the redirection's username and
/// password cookie in the Client Info.
fn assert_reconnect(conn: &Conn, session_id: u32) {
    assert!(
        contains(
            &conn.x224_request,
            format!("{ROUTING_TOKEN}\r\n").as_bytes()
        ),
        "routing token in {:?}",
        String::from_utf8_lossy(&conn.x224_request)
    );
    assert!(
        !contains(&conn.x224_request, b"mstshash"),
        "a routing token replaces the username cookie"
    );
    let cluster = conn.cluster.as_ref().expect("cluster data");
    assert!(cluster
        .flags
        .contains(RedirectionFlags::REDIRECTED_SESSION_FIELD_VALID));
    assert_eq!(cluster.redirected_session_id, session_id);
    assert_eq!(conn.username.as_deref(), Some(REDIRECT_USER));
    assert_eq!(conn.password_cookie.as_deref(), Some(PASSWORD_COOKIE));
}

fn trust_all(_: &str) -> bool {
    true
}

fn trust_none(_: &str) -> bool {
    false
}

#[tokio::test]
async fn an_accepted_target_gets_the_routing_token_and_session_after_the_gate() {
    let run = run(
        vec![Act::Redirect(to_target(SESSION_ID))],
        vec![Act::HangUp, Act::HangUp],
        trust_all,
    )
    .await;

    // The origin connect advertises redirection support, nothing more.
    let broker = run.broker.conns();
    assert_eq!(broker.len(), 1);
    let cluster = broker[0].cluster.as_ref().expect("cluster data");
    assert_eq!(cluster.flags, RedirectionFlags::REDIRECTION_SUPPORTED);
    assert_eq!(broker[0].username.as_deref(), Some("alice"));

    // The target's certificate is prompted under the target's own name.
    assert_eq!(
        prompts(&run.messages),
        vec![
            (None, fingerprint(BROKER_CERT)),
            (Some(TARGET_NAME.to_string()), fingerprint(TARGET_CERT)),
        ]
    );
    // The preflight, then the gate, then the reconnect.
    assert_eq!(
        run.events,
        [
            "dial broker #1",
            "prompt origin",
            "accept origin",
            "dial target #1",
            &format!("prompt {TARGET_NAME}"),
            &format!("accept {TARGET_NAME}"),
            "dial target #2",
        ]
    );
    let target = run.target.conns();
    assert_eq!(target.len(), 2);
    assert_preflight(&target[0]);
    assert_reconnect(&target[1], SESSION_ID);
    // The scripted target hangs up after the Client Info.
    assert!(run.result.is_err());
}

#[tokio::test]
async fn a_rejected_target_gets_nothing_beyond_the_preflight() {
    let run = run(
        vec![Act::Redirect(to_target(SESSION_ID))],
        vec![Act::HangUp, Act::HangUp],
        trust_none,
    )
    .await;

    let error = run.result.expect_err("the rejection ends the session");
    assert!(format!("{error:#}").contains("not trusted"), "{error:#}");
    assert_eq!(
        prompts(&run.messages).last(),
        Some(&(Some(TARGET_NAME.to_string()), fingerprint(TARGET_CERT)))
    );
    // One preflight, and no reconnect: no routing token, no Client Info, no
    // CredSSP ever reached the target.
    let target = run.target.conns();
    assert_eq!(target.len(), 1, "{:?}", run.events);
    assert_preflight(&target[0]);
    assert_eq!(run.events.last().unwrap(), &format!("reject {TARGET_NAME}"));
}

#[tokio::test]
async fn a_redirection_straight_back_to_the_origin_is_a_loop() {
    // A → B → A, with B naming the configured server and no token.
    let back = ServerRedirectionPdu {
        target_net_address: Some("127.0.0.1".to_string()),
        ..ServerRedirectionPdu::default()
    };
    let run = run(
        vec![Act::Redirect(to_target(0)), Act::HangUp],
        vec![Act::HangUp, Act::Redirect(back)],
        trust_all,
    )
    .await;

    assert!(matches!(refusal(&run.result), RedirectRefused::Loop { .. }));
    assert_eq!(
        run.broker.conns().len(),
        1,
        "the origin is not dialled again"
    );
    assert_eq!(run.target.conns().len(), 2);
}

#[tokio::test]
async fn a_ping_pong_with_the_same_token_and_session_is_a_loop() {
    // A → B → A → B, each redirection with the same token and session: the
    // second visit to B is the loop.
    let run = run(
        vec![
            Act::Redirect(to_target(SESSION_ID)),
            Act::HangUp,
            Act::Redirect(to_target(SESSION_ID)),
        ],
        vec![Act::HangUp, Act::Redirect(to_broker(SESSION_ID))],
        trust_all,
    )
    .await;

    assert_eq!(
        refusal(&run.result),
        RedirectRefused::Loop {
            target: TARGET_NAME.to_string()
        }
    );
    // The broker: origin, preflight, reconnect. The target: preflight,
    // reconnect, and no third connection.
    let broker = run.broker.conns();
    assert_eq!(broker.len(), 3);
    assert_preflight(&broker[1]);
    assert_reconnect(&broker[2], SESSION_ID);
    assert_eq!(run.target.conns().len(), 2, "{:?}", run.events);
    assert!(run.events.contains(&format!("prompt {BROKER_NAME}")));
}

#[tokio::test]
async fn a_fourth_redirection_is_refused() {
    // A → B → A → B, three hops, each to a new session; B's fourth
    // redirection is refused before anything is dialled.
    let run = run(
        vec![
            Act::Redirect(to_target(1)),
            Act::HangUp,
            Act::Redirect(to_target(3)),
        ],
        vec![
            Act::HangUp,
            Act::Redirect(to_broker(2)),
            Act::HangUp,
            Act::Redirect(to_broker(4)),
        ],
        trust_all,
    )
    .await;

    assert_eq!(
        refusal(&run.result),
        RedirectRefused::TooManyHops {
            target: BROKER_NAME.to_string()
        }
    );
    assert_eq!(run.broker.conns().len(), 3, "{:?}", run.events);
    let target = run.target.conns();
    assert_eq!(target.len(), 4);
    assert_reconnect(&target[3], 3);
}

#[tokio::test]
async fn a_mid_session_redirection_is_followed_through_the_gate() {
    let run = run(
        vec![Act::RedirectMidSession(to_target(SESSION_ID))],
        vec![Act::HangUp, Act::HangUp],
        trust_all,
    )
    .await;

    // The session went active on the broker before it was redirected.
    let active = run
        .events
        .iter()
        .position(|e| e == "active")
        .expect("active");
    let prompt = run
        .events
        .iter()
        .position(|e| e == &format!("prompt {TARGET_NAME}"))
        .expect("target prompt");
    assert!(active < prompt, "{:?}", run.events);
    let target = run.target.conns();
    assert_eq!(target.len(), 2);
    assert_preflight(&target[0]);
    assert_reconnect(&target[1], SESSION_ID);
}

#[tokio::test]
async fn a_redirection_inside_a_reactivation_is_followed_through_the_gate() {
    let run = run(
        vec![Act::RedirectOnReactivation(to_target(SESSION_ID))],
        vec![Act::HangUp, Act::HangUp],
        trust_all,
    )
    .await;

    assert!(run.events.iter().any(|e| e == "active"), "{:?}", run.events);
    assert_eq!(
        prompts(&run.messages).last(),
        Some(&(Some(TARGET_NAME.to_string()), fingerprint(TARGET_CERT)))
    );
    let target = run.target.conns();
    assert_eq!(target.len(), 2);
    assert_preflight(&target[0]);
    assert_reconnect(&target[1], SESSION_ID);
}

/// Each refusal reaches the host as a typed Protocol state before `main`
/// sends the failure.
#[tokio::test]
async fn a_refused_redirection_reports_a_protocol_failure_state() {
    let back = ServerRedirectionPdu {
        target_net_address: Some("127.0.0.1".to_string()),
        ..ServerRedirectionPdu::default()
    };
    let run = run(
        vec![Act::Redirect(to_target(0))],
        vec![Act::HangUp, Act::Redirect(back)],
        trust_all,
    )
    .await;
    refusal(&run.result);
    let last_state = run.messages.iter().rev().find_map(|m| match m {
        SidecarMessage::State(state) => Some(*state),
        _ => None,
    });
    assert_eq!(
        last_state,
        Some(crate::failure::failure_state(SidecarFailureKind::Protocol))
    );
}

/// The plain server the system lane serves on every OS (#5175,
/// `examples/rdp_test_server.rs`): the session goes active behind the
/// certificate gate and stays up, with the Client Info carrying the user.
#[tokio::test]
async fn an_activating_server_brings_the_session_up_and_keeps_it() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let events: Log = Arc::default();
    let server = spawn_server(
        listener,
        "server",
        BROKER_CERT,
        BROKER_KEY,
        vec![Act::Activate; 4],
        Arc::clone(&events),
    );
    let cfg = RdpConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "alice".to_string(),
        password: "saved-password".to_string(),
        connect_timeout_secs: Some(5),
        ..RdpConfig::default()
    };
    let (host_writer, mut sidecar_in) = tokio::io::duplex(64 * 1024);
    let (mut sidecar_out, host_reader) = tokio::io::duplex(1024 * 1024);
    let host = tokio::spawn(host(
        host_reader,
        host_writer,
        Arc::clone(&events),
        trust_all,
    ));
    let session = super::run_session(cfg, &mut sidecar_in, &mut sidecar_out);
    let watch = async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !events.lock().unwrap().iter().any(|e| e == "active") {
            assert!(
                tokio::time::Instant::now() < deadline,
                "never active: {:?}",
                events.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Still up a moment later: the server holds the session.
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    tokio::select! {
        result = session => panic!("the session ended on its own: {result:?}"),
        () = watch => {}
    }
    drop(sidecar_out);
    drop(sidecar_in);
    let _ = host.await;

    let events = events.lock().unwrap().clone();
    let prompt = events.iter().position(|e| e == "prompt origin");
    let active = events.iter().position(|e| e == "active");
    assert!(
        prompt.expect("a certificate prompt") < active.unwrap(),
        "{events:?}"
    );
    let conns = server.conns();
    let session_conn = conns.last().expect("a connection");
    assert_eq!(session_conn.username.as_deref(), Some("alice"));
}
