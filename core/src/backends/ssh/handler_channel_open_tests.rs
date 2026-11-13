//! Server-opened channels and host certificates against [`TermiHubHandler`]
//! (#5498), over an in-process russh server so the real protocol runs.
//!
//! Since russh 0.65 a server-opened channel is confirmed only when the client
//! handler accepts it, and russh's defaults accept. These pin that termiHub
//! confirms only the channels it asked for — a `forwarded-tcpip` channel with a
//! registered listener, or an `x11` channel while the connection holds a live
//! X11 grant (#5570) — and refuses everything else with
//! `SSH_OPEN_ADMINISTRATIVELY_PROHIBITED`. Agent forwarding with the opt-in is
//! not exercised here: accepting it bridges to the local `ssh-agent`, and tests
//! must never reach the user's real agent.

// Test code: a failed setup step is a bug in the test.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::server::{Auth, Msg as ServerMsg};
use russh::ChannelOpenFailure;
use tokio::sync::{mpsc, oneshot};

use super::*;
use crate::backends::ssh::host_key::{HostKeyInfo, HostKeyVerifier};
use crate::backends::ssh::ki_test_server::server_config;

const USER: &str = "alice";
const PASSWORD: &str = "hunter2";
const STEP: Duration = Duration::from_secs(10);

/// Trusts every host key: these tests are about channels, not host keys.
struct TrustAll;

#[async_trait]
impl HostKeyVerifier for TrustAll {
    async fn verify(&self, _info: &HostKeyInfo) -> bool {
        true
    }
}

/// A password-only server whose session handle the test uses to open
/// channels towards the client.
struct OpeningServer;

impl russh::server::Handler for OpeningServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == USER && password == PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
}

/// A connected, authenticated client session plus the server's handle and the
/// client's forwarded-channel registry.
struct Connected {
    _client: SshSession,
    server: russh::server::Handle,
    registry: ForwardedChannelRegistry,
}

async fn connect(forward_agent: bool) -> Connected {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (handle_tx, handle_rx) = oneshot::channel();
    tokio::spawn(async move {
        let running = russh::server::run_stream(server_config(), server_io, OpeningServer)
            .await
            .expect("server handshake");
        let _ = handle_tx.send(running.handle());
        let _ = running.await;
    });

    let (handler, registry, _watch) =
        TermiHubHandler::new_with_forwarding("chan-5498.invalid".into(), 22, forward_agent);
    let handler = handler.with_handshake(HandshakeContext {
        verifier: Some(Arc::new(TrustAll)),
        ..HandshakeContext::default()
    });
    let mut client = tokio::time::timeout(
        STEP,
        russh::client::connect_stream(
            Arc::new(russh::client::Config::default()),
            client_io,
            handler,
        ),
    )
    .await
    .expect("connect in time")
    .expect("client handshake");
    let auth = client
        .authenticate_password(USER, PASSWORD)
        .await
        .expect("authenticate");
    assert!(auth.success(), "password auth must succeed");
    let server = tokio::time::timeout(STEP, handle_rx)
        .await
        .expect("server handle in time")
        .expect("server handle");
    Connected {
        _client: client,
        server,
        registry,
    }
}

/// The open must fail with `AdministrativelyProhibited` — refused by the
/// client handler, not confirmed and then dropped.
fn assert_prohibited(result: Result<russh::Channel<ServerMsg>, russh::Error>, what: &str) {
    match result {
        Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited)) => {}
        Err(e) => panic!("{what}: expected AdministrativelyProhibited, got {e:?}"),
        Ok(_) => panic!("{what}: an unsolicited channel must not be confirmed"),
    }
}

#[tokio::test]
async fn forwarded_tcpip_without_a_listener_is_refused() {
    let c = connect(false).await;
    let open = tokio::time::timeout(
        STEP,
        c.server
            .channel_open_forwarded_tcpip("localhost", 6010, "127.0.0.1", 40000),
    )
    .await
    .expect("open answered in time");
    assert_prohibited(open, "forwarded-tcpip with no listener");
}

#[tokio::test]
async fn forwarded_tcpip_with_a_listener_is_confirmed_and_routed() {
    let c = connect(false).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    c.registry.lock().unwrap().insert(6010, tx);

    let open = tokio::time::timeout(
        STEP,
        c.server
            .channel_open_forwarded_tcpip("localhost", 6010, "127.0.0.1", 40000),
    )
    .await
    .expect("open answered in time");
    let server_channel = open.expect("a listened-for forward must be confirmed");

    let incoming = tokio::time::timeout(STEP, rx.recv())
        .await
        .expect("listener got the channel in time")
        .expect("listener got the channel");
    assert_eq!(incoming.connected_port, 6010);
    assert_eq!(incoming.connected_address, "localhost");

    // The confirmed channel carries data end to end.
    server_channel
        .data(&b"ping"[..])
        .await
        .expect("server write");
    let mut client_channel = incoming.channel;
    let got = tokio::time::timeout(STEP, async {
        while let Some(msg) = client_channel.wait().await {
            if let russh::ChannelMsg::Data { data } = msg {
                return data.to_vec();
            }
        }
        Vec::new()
    })
    .await
    .expect("data in time");
    assert_eq!(got, b"ping");
}

#[tokio::test]
async fn forwarded_tcpip_with_a_closed_listener_is_refused() {
    let c = connect(false).await;
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    c.registry.lock().unwrap().insert(6010, tx);
    let open = tokio::time::timeout(
        STEP,
        c.server
            .channel_open_forwarded_tcpip("localhost", 6010, "127.0.0.1", 40000),
    )
    .await
    .expect("open answered in time");
    assert_prohibited(open, "forwarded-tcpip whose listener is gone");
}

#[tokio::test]
async fn agent_forward_without_opt_in_is_refused() {
    let c = connect(false).await;
    let open = tokio::time::timeout(STEP, c.server.channel_open_agent())
        .await
        .expect("open answered in time");
    assert_prohibited(open, "agent forward without opt-in");
}

#[tokio::test]
async fn unsolicited_channel_kinds_are_refused() {
    let c = connect(false).await;
    let s = &c.server;
    let session = tokio::time::timeout(STEP, s.channel_open_session())
        .await
        .expect("session open answered");
    assert_prohibited(session, "session");
    let direct = tokio::time::timeout(
        STEP,
        s.channel_open_direct_tcpip("127.0.0.1", 22, "127.0.0.1", 40000),
    )
    .await
    .expect("direct-tcpip open answered");
    assert_prohibited(direct, "direct-tcpip");
    let x11 = tokio::time::timeout(STEP, s.channel_open_x11("127.0.0.1", 40000))
        .await
        .expect("x11 open answered");
    assert_prohibited(x11, "x11");
    let fwd_sl = tokio::time::timeout(
        STEP,
        s.channel_open_forwarded_streamlocal("/tmp/termihub-5498.sock"),
    )
    .await
    .expect("forwarded-streamlocal open answered");
    assert_prohibited(fwd_sl, "forwarded-streamlocal");
    let direct_sl = tokio::time::timeout(
        STEP,
        s.channel_open_direct_streamlocal("/tmp/termihub-5498.sock"),
    )
    .await
    .expect("direct-streamlocal open answered");
    assert_prohibited(direct_sl, "direct-streamlocal");
}

/// A host *certificate* is refused outright — termiHub trusts no certificate
/// authority — and recorded as `NotTrusted`, even when the verifier would
/// trust any bare key.
#[tokio::test]
async fn host_certificate_is_refused() {
    use russh::client::Handler;
    use russh::keys::ssh_key::certificate::{Builder, CertType};
    use russh::keys::ssh_key::private::Ed25519Keypair;
    use russh::keys::PrivateKey;

    let ca = PrivateKey::from(Ed25519Keypair::from_seed(&[1u8; 32]));
    let host = PrivateKey::from(Ed25519Keypair::from_seed(&[2u8; 32]));
    let mut builder =
        Builder::new([0u8; 16], host.public_key().key_data().clone(), 0, u64::MAX).unwrap();
    builder.cert_type(CertType::Host).unwrap();
    builder.all_principals_valid().unwrap();
    let cert = builder.sign(&ca).unwrap();

    let outcome = HostKeyOutcome::default();
    let (handler, _registry, _watch) =
        TermiHubHandler::new_with_forwarding("cert-5498.invalid".into(), 22, false);
    let mut handler = handler.with_handshake(HandshakeContext {
        verifier: Some(Arc::new(TrustAll)),
        outcome: outcome.clone(),
        ..HandshakeContext::default()
    });
    let trusted = handler
        .check_server_key(&russh::keys::PublicKeyOrCertificate::Certificate(cert))
        .await
        .unwrap();
    assert!(!trusted, "a host certificate must be refused");
    assert_eq!(*outcome.lock().unwrap(), Some(HostKeyRefusal::NotTrusted));

    // The same verifier does accept the bare key, so the refusal above is the
    // certificate rule and not the verifier.
    let (handler, _registry, _watch) =
        TermiHubHandler::new_with_forwarding("cert-5498.invalid".into(), 22, false);
    let mut handler = handler.with_handshake(HandshakeContext {
        verifier: Some(Arc::new(TrustAll)),
        ..HandshakeContext::default()
    });
    let bare = russh::keys::PublicKeyOrCertificate::PublicKey {
        key: host.public_key().clone(),
        hash_alg: None,
    };
    assert!(handler.check_server_key(&bare).await.unwrap());
}

// ── x11 channel acceptance policy (#5570) ──────────────────────────────

async fn open_x11(c: &Connected) -> Result<russh::Channel<ServerMsg>, russh::Error> {
    tokio::time::timeout(STEP, c.server.channel_open_x11("127.0.0.1", 40000))
        .await
        .expect("x11 open answered in time")
}

#[tokio::test]
async fn x11_without_a_grant_is_refused() {
    let c = connect(false).await;
    assert_prohibited(open_x11(&c).await, "x11 without x11-req");
}

#[tokio::test]
async fn x11_with_a_live_grant_is_confirmed_and_routed() {
    let c = connect(false).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    c.registry.grant_x11(tx);
    let server_channel = open_x11(&c).await.expect("a granted x11 open is confirmed");
    let incoming = tokio::time::timeout(STEP, rx.recv())
        .await
        .expect("forwarder got the channel in time")
        .expect("forwarder got the channel");
    assert_eq!(incoming.originator_address, "127.0.0.1");
    assert_eq!(incoming.originator_port, 40000);
    server_channel.data(&b"x"[..]).await.expect("server write");
}

#[tokio::test]
async fn x11_after_the_grant_is_revoked_is_refused() {
    let c = connect(false).await;
    let (tx, _rx) = mpsc::unbounded_channel();
    c.registry.grant_x11(tx.clone());
    c.registry.revoke_x11(&tx);
    assert_prohibited(open_x11(&c).await, "x11 after revoke");
}

#[tokio::test]
async fn x11_whose_forwarder_is_gone_is_refused() {
    let c = connect(false).await;
    let (tx, rx) = mpsc::unbounded_channel();
    c.registry.grant_x11(tx);
    drop(rx);
    assert_prohibited(open_x11(&c).await, "x11 whose forwarder is gone");
}

#[tokio::test]
async fn revoking_a_stale_grant_keeps_the_current_one() {
    let c = connect(false).await;
    let (old, _old_rx) = mpsc::unbounded_channel();
    let (new, mut new_rx) = mpsc::unbounded_channel();
    c.registry.grant_x11(old.clone());
    c.registry.grant_x11(new);
    c.registry.revoke_x11(&old);
    let _ch = open_x11(&c).await.expect("the current grant still holds");
    assert!(tokio::time::timeout(STEP, new_rx.recv())
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn an_x11_grant_does_not_open_other_channel_kinds() {
    let c = connect(false).await;
    let (tx, _rx) = mpsc::unbounded_channel();
    c.registry.grant_x11(tx);
    let fwd = tokio::time::timeout(
        STEP,
        c.server
            .channel_open_forwarded_tcpip("localhost", 6010, "127.0.0.1", 40000),
    )
    .await
    .expect("open answered in time");
    assert_prohibited(fwd, "forwarded-tcpip with only an x11 grant");
    let agent = tokio::time::timeout(STEP, c.server.channel_open_agent())
        .await
        .expect("open answered in time");
    assert_prohibited(agent, "agent with only an x11 grant");
}
