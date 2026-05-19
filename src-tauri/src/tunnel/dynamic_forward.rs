use std::sync::Arc;
use std::time::Duration;

use termihub_core::backends::ssh::handler::SshSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        let addr = format!("{}:{}", config.local_host, config.local_port);
        let std_listener = std::net::TcpListener::bind(&addr)?;
        std_listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(std_listener)?;

        let stats = Arc::new(ForwarderStats::new());
        let stats_clone = Arc::clone(&stats);

        let task_handle = tokio::spawn(async move {
            Self::accept_loop(listener, session, stats_clone).await;
        });

        Ok(Self {
            task_handle: Some(task_handle),
            stats,
        })
    }

    /// Get current tunnel statistics.
    pub fn get_stats(&self) -> TunnelStats {
        self.stats.to_tunnel_stats()
    }

    /// Stop the forwarder by aborting the accept task.
    pub fn stop(&mut self) {
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
    }

    async fn accept_loop(
        listener: tokio::net::TcpListener,
        session: Arc<SshSession>,
        stats: Arc<ForwarderStats>,
    ) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    stats.increment_active();
                    let session = Arc::clone(&session);
                    let stats = Arc::clone(&stats);
                    tokio::spawn(async move {
                        Self::handle_socks5(stream, session, &stats).await;
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

    async fn handle_socks5(
        mut stream: tokio::net::TcpStream,
        session: Arc<SshSession>,
        stats: &ForwarderStats,
    ) {
        if tokio::time::timeout(
            Duration::from_secs(10),
            Self::do_socks5(&mut stream, session, stats),
        )
        .await
        .is_err()
        {
            tracing::debug!("SOCKS5 handshake timed out");
        }
    }

    async fn do_socks5(
        stream: &mut tokio::net::TcpStream,
        session: Arc<SshSession>,
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

        let channel = match session
            .channel_open_direct_tcpip(&dest_host, dest_port as u32, "localhost", 0)
            .await
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

        let mut channel_stream = channel.into_stream();
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
