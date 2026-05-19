use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use termihub_core::backends::ssh::handler::SshSession;

use super::config::{LocalForwardConfig, TunnelStats};

/// Manages a local port forwarding tunnel.
///
/// Binds a local TCP listener and spawns async relay tasks for each incoming
/// connection, forwarding traffic through an SSH `channel_open_direct_tcpip`.
pub struct LocalForwarder {
    task_handle: Option<tokio::task::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
}

/// Shared atomic counters for tracking tunnel statistics.
pub struct ForwarderStats {
    bytes_sent: AtomicU64,
    bytes_received: AtomicU64,
    active_connections: AtomicU32,
    total_connections: AtomicU64,
}

impl ForwarderStats {
    pub fn new() -> Self {
        Self {
            bytes_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            active_connections: AtomicU32::new(0),
            total_connections: AtomicU64::new(0),
        }
    }

    pub fn to_tunnel_stats(&self) -> TunnelStats {
        TunnelStats {
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            active_connections: self.active_connections.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
        }
    }

    pub fn add_bytes_sent(&self, n: u64) {
        self.bytes_sent.fetch_add(n, Ordering::Relaxed);
    }

    pub fn add_bytes_received(&self, n: u64) {
        self.bytes_received.fetch_add(n, Ordering::Relaxed);
    }

    pub fn increment_active(&self) {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        self.total_connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn decrement_active(&self) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

impl LocalForwarder {
    /// Start a local port forwarding tunnel.
    ///
    /// Binds to `config.local_host:config.local_port` and for each incoming
    /// connection opens an SSH `channel_open_direct_tcpip` to
    /// `config.remote_host:config.remote_port` and relays data bidirectionally.
    pub fn start(
        config: &LocalForwardConfig,
        session: Arc<SshSession>,
    ) -> Result<Self, std::io::Error> {
        let addr = format!("{}:{}", config.local_host, config.local_port);
        let std_listener = std::net::TcpListener::bind(&addr)?;
        std_listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(std_listener)?;

        let stats = Arc::new(ForwarderStats::new());
        let stats_clone = Arc::clone(&stats);
        let remote_host = config.remote_host.clone();
        let remote_port = config.remote_port;

        let task_handle = tokio::spawn(async move {
            Self::accept_loop(listener, session, remote_host, remote_port, stats_clone).await;
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
        remote_host: String,
        remote_port: u16,
        stats: Arc<ForwarderStats>,
    ) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    stats.increment_active();
                    let session = Arc::clone(&session);
                    let remote_host = remote_host.clone();
                    let stats = Arc::clone(&stats);
                    tokio::spawn(async move {
                        Self::relay_connection(stream, session, &remote_host, remote_port, &stats)
                            .await;
                        stats.decrement_active();
                    });
                }
                Err(e) => {
                    tracing::error!("Local forward accept error: {}", e);
                    break;
                }
            }
        }
    }

    async fn relay_connection(
        mut stream: tokio::net::TcpStream,
        session: Arc<SshSession>,
        remote_host: &str,
        remote_port: u16,
        stats: &ForwarderStats,
    ) {
        let channel = match session
            .channel_open_direct_tcpip(remote_host, remote_port as u32, "localhost", 0)
            .await
        {
            Ok(ch) => ch,
            Err(e) => {
                tracing::error!("Failed to open direct-tcpip channel: {}", e);
                return;
            }
        };

        let mut channel_stream = channel.into_stream();
        if let Ok((sent, received)) =
            tokio::io::copy_bidirectional(&mut stream, &mut channel_stream).await
        {
            stats.add_bytes_sent(sent);
            stats.add_bytes_received(received);
        }
    }
}

impl Drop for LocalForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}
