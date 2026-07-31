//! Dynamic (`ssh -D`, SOCKS5) port-forward engine, shared by desktop and agent
//! (#2185, #2198).
//!
//! Binds a TCP listener on the tunnel host as a SOCKS5 proxy. For each accepted
//! connection it performs the SOCKS5 handshake (CONNECT only, no auth), then
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

const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_NO_AUTH: u8 = 0x00;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_ATYP_IPV4: u8 = 0x01;
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
const SOCKS5_REP_SUCCESS: u8 = 0x00;
const SOCKS5_REP_GENERAL_FAILURE: u8 = 0x01;
const SOCKS5_REP_CMD_NOT_SUPPORTED: u8 = 0x07;

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
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    stats.increment_active();
                    let opener = Arc::clone(&opener);
                    let stats = Arc::clone(&stats);
                    tokio::spawn(async move {
                        Self::handle_socks5(stream, opener, &stats).await;
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
    ) {
        if tokio::time::timeout(
            Duration::from_secs(10),
            Self::do_socks5(&mut stream, opener, stats),
        )
        .await
        .is_err()
        {
            tracing::debug!("SOCKS5 handshake timed out");
        }
    }

    async fn do_socks5<O: ChannelOpener>(
        stream: &mut tokio::net::TcpStream,
        opener: Arc<O>,
        stats: &ForwarderStats,
    ) -> std::io::Result<()> {
        // Greeting
        let mut header = [0u8; 2];
        stream.read_exact(&mut header).await?;
        if header[0] != SOCKS5_VERSION {
            return Ok(());
        }

        let nmethods = header[1] as usize;
        let mut methods = vec![0u8; nmethods];
        stream.read_exact(&mut methods).await?;

        if !methods.contains(&SOCKS5_NO_AUTH) {
            stream.write_all(&[SOCKS5_VERSION, 0xFF]).await?;
            return Ok(());
        }
        stream.write_all(&[SOCKS5_VERSION, SOCKS5_NO_AUTH]).await?;

        // Request
        let mut req = [0u8; 4];
        stream.read_exact(&mut req).await?;
        if req[0] != SOCKS5_VERSION {
            return Ok(());
        }
        if req[1] != SOCKS5_CMD_CONNECT {
            Self::send_reply(stream, SOCKS5_REP_CMD_NOT_SUPPORTED).await?;
            return Ok(());
        }

        let (dest_host, dest_port) = match req[3] {
            SOCKS5_ATYP_IPV4 => {
                let mut addr = [0u8; 4];
                stream.read_exact(&mut addr).await?;
                let host = format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]);
                let mut port_buf = [0u8; 2];
                stream.read_exact(&mut port_buf).await?;
                let port = u16::from_be_bytes(port_buf);
                (host, port)
            }
            SOCKS5_ATYP_DOMAIN => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await?;
                let mut domain = vec![0u8; len[0] as usize];
                stream.read_exact(&mut domain).await?;
                let host = String::from_utf8(domain).map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid domain")
                })?;
                let mut port_buf = [0u8; 2];
                stream.read_exact(&mut port_buf).await?;
                let port = u16::from_be_bytes(port_buf);
                (host, port)
            }
            _ => {
                Self::send_reply(stream, SOCKS5_REP_CMD_NOT_SUPPORTED).await?;
                return Ok(());
            }
        };

        let mut channel_stream = match opener.open_direct_tcpip(dest_host.clone(), dest_port).await
        {
            Ok(ch) => ch,
            Err(e) => {
                tracing::debug!(
                    "SOCKS5 channel_open_direct_tcpip to {}:{} failed: {}",
                    dest_host,
                    dest_port,
                    e
                );
                Self::send_reply(stream, SOCKS5_REP_GENERAL_FAILURE).await?;
                return Ok(());
            }
        };

        Self::send_reply(stream, SOCKS5_REP_SUCCESS).await?;

        if let Ok((sent, received)) =
            tokio::io::copy_bidirectional(stream, &mut channel_stream).await
        {
            stats.add_bytes_sent(sent);
            stats.add_bytes_received(received);
        }

        Ok(())
    }

    async fn send_reply(stream: &mut tokio::net::TcpStream, rep: u8) -> std::io::Result<()> {
        let reply = [
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
        ];
        stream.write_all(&reply).await
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
    async fn unsupported_address_type_is_rejected() {
        let (forwarder, mut client, targets) = start_and_connect(EchoChannelOpener::new()).await;
        greet_no_auth(&mut client).await;
        // ATYP 0x04 (IPv6) is not handled.
        client
            .write_all(&[SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, 0x04])
            .await
            .expect("write request");
        let reply = read_reply(&mut client).await;
        assert_eq!(reply[1], SOCKS5_REP_CMD_NOT_SUPPORTED);
        assert!(targets.lock().unwrap().is_empty());
        drop(forwarder);
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
    async fn teardown_closes_the_listener() {
        let forwarder =
            DynamicForwarder::start_with_opener(&ephemeral_config(), EchoChannelOpener::new())
                .expect("start forwarder");
        let addr = forwarder.local_addr();
        TcpStream::connect(addr)
            .await
            .expect("connect while active");

        drop(forwarder);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match TcpStream::connect(addr).await {
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => break,
                _ if tokio::time::Instant::now() >= deadline => {
                    panic!("listener still accepting after teardown");
                }
                _ => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
    }
}
