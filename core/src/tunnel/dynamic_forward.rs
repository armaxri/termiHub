//! Dynamic (`ssh -D`, SOCKS5) port-forward engine, shared by desktop and agent
//! (#2185, #2198).
//!
//! Binds a TCP listener on the tunnel host as a SOCKS5 proxy. For each accepted
//! connection it performs the SOCKS5 handshake (CONNECT only, no auth; IPv4,
//! IPv6 and domain targets), then
//! opens an SSH `direct-tcpip` channel to the client-chosen target and relays
//! bytes bidirectionally. Lifted from the desktop `tunnel` module into core so
//! the identical engine runs on the desktop **or** on a remote agent — only the
//! machine that hosts the SOCKS listen socket moves (S3, part of #2139); the
//! per-connection target is always resolved from the SSH server's network. See
//! `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::backends::ssh::handler::SshSession;

use super::channel::{ChannelOpener, SshChannelOpener};
use super::config::{DynamicForwardConfig, TunnelStats};
use super::local_forward::ForwarderStats;
use super::MAX_CONCURRENT_FORWARDED_CONNECTIONS;

/// Manages a dynamic (SOCKS5) forwarding tunnel.
///
/// Binds a local TCP listener as a SOCKS5 proxy. For each incoming connection,
/// performs the SOCKS5 handshake (CONNECT only, no auth) and then relays
/// traffic through an SSH `channel_open_direct_tcpip`.
pub struct DynamicForwarder {
    task_handle: Option<tokio::task::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
    /// The address the listener actually bound. When `config.local_port` is `0`
    /// the OS assigns an ephemeral port; this reads it back so callers (and
    /// tests) can connect to the real port instead of racily re-binding a probed
    /// one (#2280).
    local_addr: std::net::SocketAddr,
    /// Fires when the accept loop exits, so the tunnel supervisor can observe
    /// forwarder death and drive the tunnel to `Error` (#1243, GAP 2).
    death: Option<tokio::sync::oneshot::Receiver<()>>,
}

/// Upper bound on the SOCKS5 negotiation (greeting, method select, request
/// parse, channel open, success reply). It bounds **only** the handshake so a
/// slow or absent client cannot tie up a task forever; the established relay
/// runs with no deadline (#2329).
const SOCKS5_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a rejected connection is drained before it is closed, and the most
/// bytes read while draining (see `DynamicForwarder::reject`).
const SOCKS5_REJECT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const SOCKS5_REJECT_DRAIN_LIMIT: usize = 64 * 1024;

const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_NO_AUTH: u8 = 0x00;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_ATYP_IPV4: u8 = 0x01;
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
const SOCKS5_ATYP_IPV6: u8 = 0x04;

// RFC 1928 §6 reply codes.
const SOCKS5_REP_SUCCESS: u8 = 0x00;
const SOCKS5_REP_GENERAL_FAILURE: u8 = 0x01;
const SOCKS5_REP_NOT_ALLOWED: u8 = 0x02;
const SOCKS5_REP_NETWORK_UNREACHABLE: u8 = 0x03;
const SOCKS5_REP_HOST_UNREACHABLE: u8 = 0x04;
const SOCKS5_REP_CONNECTION_REFUSED: u8 = 0x05;
const SOCKS5_REP_CMD_NOT_SUPPORTED: u8 = 0x07;
const SOCKS5_REP_ATYP_NOT_SUPPORTED: u8 = 0x08;

impl DynamicForwarder {
    /// Start a dynamic SOCKS5 forwarding tunnel.
    pub fn start(
        config: &DynamicForwardConfig,
        session: Arc<SshSession>,
    ) -> Result<Self, std::io::Error> {
        Self::start_with_opener(config, SshChannelOpener::new(session))
    }

    /// Start a dynamic SOCKS5 forwarding tunnel over an injected
    /// [`ChannelOpener`].
    ///
    /// Production goes through [`start`](Self::start) (which wraps the SSH
    /// session in an [`SshChannelOpener`]); tests inject an in-memory opener to
    /// exercise the SOCKS5 handshake, target parsing, and relay path without a
    /// live SSH server (#2044).
    pub fn start_with_opener<O: ChannelOpener>(
        config: &DynamicForwardConfig,
        opener: O,
    ) -> Result<Self, std::io::Error> {
        let addr = format!("{}:{}", config.local_host, config.local_port);
        let std_listener = std::net::TcpListener::bind(&addr)?;
        std_listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(std_listener)?;
        let local_addr = listener.local_addr()?;

        let stats = Arc::new(ForwarderStats::new());
        let stats_clone = Arc::clone(&stats);
        let opener = Arc::new(opener);

        let (death_tx, death_rx) = tokio::sync::oneshot::channel();
        let task_handle = tokio::spawn(async move {
            // Bound before the accept-loop future, so it is dropped after it: the
            // signal fires only once the listener (owned by that future) is closed,
            // which teardown tests rely on instead of probing the freed port (#3551).
            let _death = death_tx;
            Self::accept_loop(listener, opener, stats_clone).await;
        });

        Ok(Self {
            task_handle: Some(task_handle),
            stats,
            local_addr,
            death: Some(death_rx),
        })
    }

    /// The address the SOCKS listener actually bound.
    ///
    /// Equals `config.local_host:config.local_port` for a fixed request; when
    /// port `0` was requested the OS picked an ephemeral port and this returns
    /// the real one (#2280).
    pub fn local_addr(&self) -> std::net::SocketAddr {
        self.local_addr
    }

    /// Get current tunnel statistics.
    pub fn get_stats(&self) -> TunnelStats {
        self.stats.to_tunnel_stats()
    }

    /// Take the forwarder-death receiver (once) for the tunnel supervisor.
    pub fn take_death_signal(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.death.take()
    }

    /// Stop the forwarder by aborting the accept task.
    pub fn stop(&mut self) {
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
    }

    async fn accept_loop<O: ChannelOpener>(
        listener: tokio::net::TcpListener,
        opener: Arc<O>,
        stats: Arc<ForwarderStats>,
    ) {
        // Bound the number of concurrently-relayed connections (CORE-027). A
        // permit is acquired before spawning the relay and held inside the task
        // via an owned permit, so it frees automatically when the relay ends.
        let limiter = Arc::new(tokio::sync::Semaphore::new(
            MAX_CONCURRENT_FORWARDED_CONNECTIONS,
        ));
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    // At capacity: drop (close) the excess connection instead of
                    // spawning an unbounded task. `try_acquire_owned` never
                    // blocks the accept loop.
                    let permit = match Arc::clone(&limiter).try_acquire_owned() {
                        Ok(permit) => permit,
                        Err(_) => {
                            tracing::warn!(
                                "SOCKS5 forward at capacity ({} concurrent connections); \
                                 dropping incoming connection",
                                MAX_CONCURRENT_FORWARDED_CONNECTIONS
                            );
                            drop(stream);
                            continue;
                        }
                    };
                    stats.increment_active();
                    let opener = Arc::clone(&opener);
                    let stats = Arc::clone(&stats);
                    tokio::spawn(async move {
                        let _permit = permit;
                        Self::handle_socks5(stream, opener, &stats, SOCKS5_HANDSHAKE_TIMEOUT).await;
                        stats.decrement_active();
                    });
                }
                Err(e) => {
                    tracing::error!("SOCKS5 accept error: {}", e);
                    break;
                }
            }
        }
    }

    async fn handle_socks5<O: ChannelOpener>(
        mut stream: tokio::net::TcpStream,
        opener: Arc<O>,
        stats: &ForwarderStats,
        handshake_timeout: Duration,
    ) {
        // Only the negotiation is time-bounded: a client that stalls mid-handshake
        // must not tie up a task forever. Once the handshake succeeds the relay
        // runs with no deadline — a SOCKS proxy holds connections open for as long
        // as the client needs (downloads, long-lived streams), so bounding the
        // relay by the handshake timeout would kill every session (#2329).
        let mut channel_stream = match tokio::time::timeout(
            handshake_timeout,
            Self::socks5_handshake(&mut stream, opener),
        )
        .await
        {
            // Handshake succeeded and the success reply was sent — relay is ready.
            Ok(Ok(Some(ch))) => ch,
            // Request was handled but there is nothing to relay (rejected auth,
            // non-CONNECT command, unsupported address type, or channel-open
            // failure — each already sent its own reply).
            Ok(Ok(None)) => return,
            Ok(Err(e)) => {
                tracing::debug!("SOCKS5 handshake error: {}", e);
                return;
            }
            Err(_) => {
                tracing::debug!("SOCKS5 handshake timed out");
                return;
            }
        };

        if let Ok((sent, received)) =
            tokio::io::copy_bidirectional(&mut stream, &mut channel_stream).await
        {
            stats.add_bytes_sent(sent);
            stats.add_bytes_received(received);
        }
    }

    /// Perform the SOCKS5 negotiation (greeting, method select, request parse,
    /// channel open, success reply).
    ///
    /// Returns `Ok(Some(stream))` with the opened channel byte stream when the
    /// connection is negotiated and ready to relay (the success reply has already
    /// been sent). Returns `Ok(None)` when the request was fully handled but there
    /// is nothing to relay — a rejected auth negotiation, a non-CONNECT command, an
    /// unsupported address type, or a failed channel open — each of which has
    /// already written its own SOCKS5 reply.
    async fn socks5_handshake<O: ChannelOpener>(
        stream: &mut tokio::net::TcpStream,
        opener: Arc<O>,
    ) -> std::io::Result<Option<O::Stream>> {
        // Greeting
        let mut header = [0u8; 2];
        stream.read_exact(&mut header).await?;
        if header[0] != SOCKS5_VERSION {
            return Ok(None);
        }

        let nmethods = header[1] as usize;
        let mut methods = vec![0u8; nmethods];
        stream.read_exact(&mut methods).await?;

        if !methods.contains(&SOCKS5_NO_AUTH) {
            Self::reject(stream, &[SOCKS5_VERSION, 0xFF]).await?;
            return Ok(None);
        }
        stream.write_all(&[SOCKS5_VERSION, SOCKS5_NO_AUTH]).await?;

        // Request
        let mut req = [0u8; 4];
        stream.read_exact(&mut req).await?;
        if req[0] != SOCKS5_VERSION {
            return Ok(None);
        }
        if req[1] != SOCKS5_CMD_CONNECT {
            Self::reject(stream, &Self::reply(SOCKS5_REP_CMD_NOT_SUPPORTED)).await?;
            return Ok(None);
        }

        let dest_host = match req[3] {
            SOCKS5_ATYP_IPV4 => {
                let mut addr = [0u8; 4];
                stream.read_exact(&mut addr).await?;
                std::net::Ipv4Addr::from(addr).to_string()
            }
            SOCKS5_ATYP_DOMAIN => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await?;
                let mut domain = vec![0u8; len[0] as usize];
                stream.read_exact(&mut domain).await?;
                match String::from_utf8(domain) {
                    Ok(host) => host,
                    Err(_) => {
                        Self::reject(stream, &Self::reply(SOCKS5_REP_GENERAL_FAILURE)).await?;
                        return Ok(None);
                    }
                }
            }
            SOCKS5_ATYP_IPV6 => {
                let mut addr = [0u8; 16];
                stream.read_exact(&mut addr).await?;
                // `direct-tcpip` takes the bare address — no `[...]` brackets.
                std::net::Ipv6Addr::from(addr).to_string()
            }
            _ => {
                Self::reject(stream, &Self::reply(SOCKS5_REP_ATYP_NOT_SUPPORTED)).await?;
                return Ok(None);
            }
        };
        let mut port_buf = [0u8; 2];
        stream.read_exact(&mut port_buf).await?;
        let dest_port = u16::from_be_bytes(port_buf);

        let channel_stream = match opener.open_direct_tcpip(dest_host.clone(), dest_port).await {
            Ok(ch) => ch,
            Err(e) => {
                tracing::debug!(
                    "SOCKS5 channel_open_direct_tcpip to {}:{} failed: {}",
                    dest_host,
                    dest_port,
                    e
                );
                Self::reject(stream, &Self::reply(Self::reply_for_open_error(&e))).await?;
                return Ok(None);
            }
        };

        Self::send_reply(stream, SOCKS5_REP_SUCCESS).await?;

        Ok(Some(channel_stream))
    }

    /// Map a failed channel open to the RFC 1928 reply code sent to the client.
    ///
    /// [`SshChannelOpener`] encodes the SSH channel-open failure reason in the
    /// error's kind (see `channel::open_failure_kind`); anything unclassified is
    /// a general failure (#4337).
    fn reply_for_open_error(err: &std::io::Error) -> u8 {
        use std::io::ErrorKind;
        match err.kind() {
            ErrorKind::PermissionDenied => SOCKS5_REP_NOT_ALLOWED,
            ErrorKind::NetworkUnreachable => SOCKS5_REP_NETWORK_UNREACHABLE,
            ErrorKind::HostUnreachable | ErrorKind::TimedOut => SOCKS5_REP_HOST_UNREACHABLE,
            ErrorKind::ConnectionRefused => SOCKS5_REP_CONNECTION_REFUSED,
            ErrorKind::Unsupported => SOCKS5_REP_CMD_NOT_SUPPORTED,
            _ => SOCKS5_REP_GENERAL_FAILURE,
        }
    }

    /// Send a final rejection and close the connection gracefully.
    ///
    /// The client may already have sent bytes the server never read (the rest
    /// of a request, or pipelined payload). Closing a socket with unread input
    /// makes Windows — and Linux — send an RST, which can discard the reply
    /// still in flight, so the client sees "connection reset" instead of the
    /// reply code. Instead: write, flush, half-close our side (the client sees
    /// the reply then EOF), and drain what the client still sends for a short,
    /// bounded window before the socket is dropped (#4337).
    async fn reject(stream: &mut tokio::net::TcpStream, reply: &[u8]) -> std::io::Result<()> {
        stream.write_all(reply).await?;
        stream.flush().await?;
        stream.shutdown().await?;

        let mut buf = [0u8; 4096];
        let mut drained = 0usize;
        let _ = tokio::time::timeout(SOCKS5_REJECT_DRAIN_TIMEOUT, async {
            while drained < SOCKS5_REJECT_DRAIN_LIMIT {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => drained += n,
                }
            }
        })
        .await;
        Ok(())
    }

    /// The 10-byte RFC 1928 reply for `rep` (BND.ADDR 0.0.0.0, BND.PORT 0).
    fn reply(rep: u8) -> [u8; 10] {
        [
            SOCKS5_VERSION,
            rep,
            0x00, // RSV
            SOCKS5_ATYP_IPV4,
            0,
            0,
            0,
            0, // BND.ADDR (0.0.0.0)
            0,
            0, // BND.PORT (0)
        ]
    }

    async fn send_reply(stream: &mut tokio::net::TcpStream, rep: u8) -> std::io::Result<()> {
        stream.write_all(&Self::reply(rep)).await
    }
}

impl Drop for DynamicForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests for the SOCKS5 handshake, target-address parsing, and relay,
    //! driven over a loopback listener plus an in-memory [`ChannelOpener`] fake
    //! (#2044). The forwarder previously sat at 0% coverage because
    //! [`SshSession`] cannot be fabricated without a live SSH server.

    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::super::channel::test_support::EchoChannelOpener;
    use super::super::config::DynamicForwardConfig;
    use super::*;

    /// A config that binds an ephemeral loopback port. Passing port `0` lets the
    /// OS assign a free port the forwarder keeps, so the test reads the real port
    /// back via [`DynamicForwarder::local_addr`] instead of racily re-binding a
    /// probed one (#2280).
    fn ephemeral_config() -> DynamicForwardConfig {
        DynamicForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 0,
        }
    }

    /// Start a SOCKS proxy forwarder and connect a client to it, returning the
    /// client stream and a handle to the opener's recorded targets.
    async fn start_and_connect(
        opener: EchoChannelOpener,
    ) -> (DynamicForwarder, TcpStream, Arc<Mutex<Vec<(String, u16)>>>) {
        let targets = opener.targets_handle();
        let forwarder = DynamicForwarder::start_with_opener(&ephemeral_config(), opener)
            .expect("start forwarder");
        let client = TcpStream::connect(forwarder.local_addr())
            .await
            .expect("connect to socks proxy");
        (forwarder, client, targets)
    }

    /// Send the no-auth greeting and assert the server selects it.
    async fn greet_no_auth(client: &mut TcpStream) {
        client
            .write_all(&[SOCKS5_VERSION, 0x01, SOCKS5_NO_AUTH])
            .await
            .expect("write greeting");
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method reply");
        assert_eq!(resp, [SOCKS5_VERSION, SOCKS5_NO_AUTH]);
    }

    async fn read_reply(client: &mut TcpStream) -> [u8; 10] {
        let mut reply = [0u8; 10];
        client
            .read_exact(&mut reply)
            .await
            .expect("read socks reply");
        reply
    }

    #[tokio::test]
    async fn ipv4_connect_parses_target_and_relays() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;

        // CONNECT 93.184.216.34:443
        client
            .write_all(&[
                SOCKS5_VERSION,
                SOCKS5_CMD_CONNECT,
                0x00,
                SOCKS5_ATYP_IPV4,
                93,
                184,
                216,
                34,
                0x01,
                0xBB,
            ])
            .await
            .expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_SUCCESS, "connect should succeed");

        // Relay: bytes past the handshake round-trip through the echo channel.
        client.write_all(b"ping").await.expect("write payload");
        client.shutdown().await.expect("half-close");
        let mut echoed = Vec::new();
        client.read_to_end(&mut echoed).await.expect("read echo");
        assert_eq!(&echoed, b"ping");

        assert_eq!(
            targets.lock().unwrap().clone(),
            vec![("93.184.216.34".to_string(), 443)],
            "IPv4 host and port parsed"
        );

        let stats = forwarder.get_stats();
        assert_eq!(stats.total_connections, 1);
        drop(forwarder);
    }

    #[tokio::test]
    async fn domain_connect_parses_hostname() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;

        let host = b"example.com";
        let mut req = vec![
            SOCKS5_VERSION,
            SOCKS5_CMD_CONNECT,
            0x00,
            SOCKS5_ATYP_DOMAIN,
            host.len() as u8,
        ];
        req.extend_from_slice(host);
        req.extend_from_slice(&80u16.to_be_bytes());
        client.write_all(&req).await.expect("write request");

        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_SUCCESS);

        assert_eq!(
            targets.lock().unwrap().clone(),
            vec![("example.com".to_string(), 80)],
            "domain host and port parsed"
        );
        drop(forwarder);
    }

    #[tokio::test]
    async fn rejects_when_no_acceptable_auth_method() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        // Offer only username/password (0x02) — server has no matching method.
        client
            .write_all(&[SOCKS5_VERSION, 0x01, 0x02])
            .await
            .expect("write greeting");
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method reply");
        assert_eq!(resp, [SOCKS5_VERSION, 0xFF], "no acceptable methods");
        assert!(
            targets.lock().unwrap().is_empty(),
            "no channel opened when auth negotiation fails"
        );
        drop(forwarder);
    }

    #[tokio::test]
    async fn unsupported_command_is_rejected() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;
        // BIND (0x02) is not supported — only CONNECT is.
        client
            .write_all(&[SOCKS5_VERSION, 0x02, 0x00, SOCKS5_ATYP_IPV4])
            .await
            .expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_CMD_NOT_SUPPORTED);
        assert!(targets.lock().unwrap().is_empty());
        drop(forwarder);
    }

    #[tokio::test]
    async fn ipv6_connect_parses_target_and_relays() {
        // Regression for #4337 (LIBBE2-001): ATYP 0x04 used to be rejected.
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;

        let ip: std::net::Ipv6Addr = "2001:db8::1".parse().expect("ipv6 literal");
        let mut req = vec![SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, SOCKS5_ATYP_IPV6];
        req.extend_from_slice(&ip.octets());
        req.extend_from_slice(&443u16.to_be_bytes());
        client.write_all(&req).await.expect("write request");

        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_SUCCESS, "IPv6 connect should succeed");

        client.write_all(b"v6").await.expect("write payload");
        client.shutdown().await.expect("half-close");
        let mut echoed = Vec::new();
        client.read_to_end(&mut echoed).await.expect("read echo");
        assert_eq!(&echoed, b"v6");

        assert_eq!(
            targets.lock().unwrap().clone(),
            vec![("2001:db8::1".to_string(), 443)],
            "IPv6 host is passed to direct-tcpip without brackets"
        );
        drop(forwarder);
    }

    #[tokio::test]
    async fn ipv6_loopback_target_is_formatted_compactly() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;

        let mut req = vec![SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, SOCKS5_ATYP_IPV6];
        req.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        req.extend_from_slice(&22u16.to_be_bytes());
        client.write_all(&req).await.expect("write request");

        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_SUCCESS);
        assert_eq!(
            targets.lock().unwrap().clone(),
            vec![("::1".to_string(), 22)]
        );
        drop(forwarder);
    }

    #[tokio::test]
    async fn unknown_address_type_gets_address_type_not_supported() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;
        // ATYP 0x05 is not defined by RFC 1928.
        client
            .write_all(&[SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, 0x05])
            .await
            .expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(
            reply[1], SOCKS5_REP_ATYP_NOT_SUPPORTED,
            "RFC 1928 reply 0x08, not 0x07 (command not supported)"
        );
        assert!(targets.lock().unwrap().is_empty());
        drop(forwarder);
    }

    #[tokio::test]
    async fn non_utf8_domain_gets_general_failure_reply() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;
        let mut req = vec![
            SOCKS5_VERSION,
            SOCKS5_CMD_CONNECT,
            0x00,
            SOCKS5_ATYP_DOMAIN,
            2,
            0xFF,
            0xFE,
        ];
        req.extend_from_slice(&80u16.to_be_bytes());
        client.write_all(&req).await.expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_GENERAL_FAILURE);
        assert!(targets.lock().unwrap().is_empty());
        drop(forwarder);
    }

    /// Every early-reject path must deliver its reply even when the client has
    /// already sent more bytes than the server reads. Closing a socket with
    /// unread input makes Windows (and Linux) answer with an RST that discards
    /// the reply still in flight, so the server must close gracefully (#4337).
    #[tokio::test]
    async fn rejection_reply_survives_unread_client_bytes() {
        let trailing = vec![0xAB; 4096];
        let mut requests: Vec<(Vec<u8>, u8)> = Vec::new();

        // BIND with a full IPv4 address + port, then payload.
        let mut bind = vec![SOCKS5_VERSION, 0x02, 0x00, SOCKS5_ATYP_IPV4, 10, 0, 0, 1];
        bind.extend_from_slice(&80u16.to_be_bytes());
        requests.push((bind, SOCKS5_REP_CMD_NOT_SUPPORTED));

        // Unknown ATYP 0x05 followed by bytes the server never parses.
        requests.push((
            vec![SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, 0x05, 1, 2, 3, 4],
            SOCKS5_REP_ATYP_NOT_SUPPORTED,
        ));

        // Non-UTF-8 domain with its port.
        let mut bad_domain = vec![
            SOCKS5_VERSION,
            SOCKS5_CMD_CONNECT,
            0x00,
            SOCKS5_ATYP_DOMAIN,
            2,
            0xFF,
            0xFE,
        ];
        bad_domain.extend_from_slice(&80u16.to_be_bytes());
        requests.push((bad_domain, SOCKS5_REP_GENERAL_FAILURE));

        for (request, rep) in requests {
            let (forwarder, mut client, _targets) =
                start_and_connect(EchoChannelOpener::new()).await;
            greet_no_auth(&mut client).await;
            let mut bytes = request.clone();
            bytes.extend_from_slice(&trailing);
            client.write_all(&bytes).await.expect("write request");
            // Give the server time to reply and close before we read.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let reply = read_reply(&mut client).await;
            assert_eq!(reply[1], rep, "request {request:?}");
            drop(forwarder);
        }

        // A failed channel open, with payload already pipelined behind it.
        let (forwarder, mut client, _targets) = start_and_connect(EchoChannelOpener::failing_with(
            std::io::ErrorKind::HostUnreachable,
        ))
        .await;
        greet_no_auth(&mut client).await;
        let mut bytes = vec![
            SOCKS5_VERSION,
            SOCKS5_CMD_CONNECT,
            0x00,
            SOCKS5_ATYP_IPV4,
            10,
            0,
            0,
            1,
        ];
        bytes.extend_from_slice(&80u16.to_be_bytes());
        bytes.extend_from_slice(&trailing);
        client.write_all(&bytes).await.expect("write request");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_HOST_UNREACHABLE);
        drop(forwarder);
    }

    #[tokio::test]
    async fn auth_rejection_survives_unread_client_bytes() {
        let (forwarder, mut client, _targets) = start_and_connect(EchoChannelOpener::new()).await;
        // Greeting offering only user/pass, with a request pipelined behind it.
        let mut bytes = vec![SOCKS5_VERSION, 0x01, 0x02];
        bytes.extend_from_slice(&[0xAB; 4096]);
        client.write_all(&bytes).await.expect("write greeting");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method reply");
        assert_eq!(resp, [SOCKS5_VERSION, 0xFF]);
        drop(forwarder);
    }

    #[test]
    fn open_errors_map_to_rfc1928_reply_codes() {
        use std::io::{Error, ErrorKind};
        let cases = [
            (ErrorKind::PermissionDenied, SOCKS5_REP_NOT_ALLOWED),
            (
                ErrorKind::NetworkUnreachable,
                SOCKS5_REP_NETWORK_UNREACHABLE,
            ),
            (ErrorKind::HostUnreachable, SOCKS5_REP_HOST_UNREACHABLE),
            (ErrorKind::TimedOut, SOCKS5_REP_HOST_UNREACHABLE),
            (ErrorKind::ConnectionRefused, SOCKS5_REP_CONNECTION_REFUSED),
            (ErrorKind::Unsupported, SOCKS5_REP_CMD_NOT_SUPPORTED),
            (ErrorKind::Other, SOCKS5_REP_GENERAL_FAILURE),
            (ErrorKind::BrokenPipe, SOCKS5_REP_GENERAL_FAILURE),
        ];
        for (kind, rep) in cases {
            assert_eq!(
                DynamicForwarder::reply_for_open_error(&Error::new(kind, "x")),
                rep,
                "{kind:?}"
            );
        }
    }

    #[tokio::test]
    async fn channel_open_failure_reasons_reach_the_client() {
        use std::io::ErrorKind;
        let cases = [
            (ErrorKind::PermissionDenied, SOCKS5_REP_NOT_ALLOWED),
            (ErrorKind::HostUnreachable, SOCKS5_REP_HOST_UNREACHABLE),
            (ErrorKind::ConnectionRefused, SOCKS5_REP_CONNECTION_REFUSED),
            (ErrorKind::Unsupported, SOCKS5_REP_CMD_NOT_SUPPORTED),
        ];
        for (kind, rep) in cases {
            let (forwarder, mut client, _targets) =
                start_and_connect(EchoChannelOpener::failing_with(kind)).await;
            greet_no_auth(&mut client).await;
            client
                .write_all(&[
                    SOCKS5_VERSION,
                    SOCKS5_CMD_CONNECT,
                    0x00,
                    SOCKS5_ATYP_IPV4,
                    10,
                    0,
                    0,
                    1,
                    0x00,
                    0x50,
                ])
                .await
                .expect("write request");
            let reply = read_reply(&mut client).await;
            assert_eq!(reply[1], rep, "{kind:?}");
            drop(forwarder);
        }
    }

    #[tokio::test]
    async fn channel_open_failure_replies_general_failure() {
        // The address still parses (and is recorded) before the open is tried.
        let (forwarder, mut client, targets) =
            start_and_connect(EchoChannelOpener::failing()).await;
        greet_no_auth(&mut client).await;
        client
            .write_all(&[
                SOCKS5_VERSION,
                SOCKS5_CMD_CONNECT,
                0x00,
                SOCKS5_ATYP_IPV4,
                10,
                0,
                0,
                1,
                0x00,
                0x50,
            ])
            .await
            .expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_GENERAL_FAILURE);
        assert_eq!(
            targets.lock().unwrap().clone(),
            vec![("10.0.0.1".to_string(), 80)],
            "target parsed even though the channel open failed"
        );
        drop(forwarder);
    }

    #[tokio::test]
    async fn established_relay_outlives_the_handshake_timeout() {
        // Regression for #2329: the handshake timeout must bound ONLY the SOCKS5
        // negotiation, not the established relay. Previously the timeout wrapped
        // the whole session (handshake + copy_bidirectional), so every proxied
        // connection was force-closed once the window elapsed — regardless of
        // activity. Here the handshake completes, then we idle well past a tiny
        // handshake timeout and confirm bytes still relay.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind proxy listener");
        let addr = listener.local_addr().expect("listener addr");
        let stats = Arc::new(ForwarderStats::new());
        let stats_clone = Arc::clone(&stats);

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept client");
            DynamicForwarder::handle_socks5(
                stream,
                Arc::new(EchoChannelOpener::new()),
                &stats_clone,
                Duration::from_millis(100),
            )
            .await;
        });

        let mut client = TcpStream::connect(addr).await.expect("connect to proxy");
        greet_no_auth(&mut client).await;
        // CONNECT 10.0.0.1:80 (IPv4) — the echo opener accepts any target.
        client
            .write_all(&[
                SOCKS5_VERSION,
                SOCKS5_CMD_CONNECT,
                0x00,
                SOCKS5_ATYP_IPV4,
                10,
                0,
                0,
                1,
                0x00,
                0x50,
            ])
            .await
            .expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_SUCCESS, "handshake should succeed");

        // Idle past the handshake timeout, then drive traffic. With the bug the
        // whole session is cancelled at 100ms, so the connection is dead here.
        tokio::time::sleep(Duration::from_millis(300)).await;
        client
            .write_all(b"late-bytes")
            .await
            .expect("write payload");
        client.shutdown().await.expect("half-close");
        let mut echoed = Vec::new();
        client
            .read_to_end(&mut echoed)
            .await
            .expect("read echoed bytes");
        assert_eq!(
            &echoed, b"late-bytes",
            "relay must survive well past the handshake timeout"
        );

        server.await.expect("server task ok");
        assert_eq!(
            stats.to_tunnel_stats().bytes_sent,
            10,
            "relayed bytes should be recorded"
        );
    }

    #[tokio::test]
    async fn teardown_closes_the_listener() {
        let mut forwarder =
            DynamicForwarder::start_with_opener(&ephemeral_config(), EchoChannelOpener::new())
                .expect("start forwarder");
        let addr = forwarder.local_addr();
        let death = forwarder.take_death_signal().expect("death signal");
        TcpStream::connect(addr)
            .await
            .expect("connect while active");

        drop(forwarder);

        // The death signal fires only once the accept task's future — which owns
        // the listener — has been dropped, so awaiting it proves the listener
        // closed without probing the freed port, which a concurrent test's
        // port-0 bind may already have re-taken (#3551).
        tokio::time::timeout(Duration::from_secs(3), death)
            .await
            .expect("accept task (and its listener) should end after teardown")
            .expect_err("the death signal resolves by its sender dropping");
    }
}
