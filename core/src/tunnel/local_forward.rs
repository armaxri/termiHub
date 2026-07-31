//! Local (`ssh -L`) port-forward engine, shared by desktop and agent (#2185).
//!
//! Binds a TCP listener on the tunnel host and, for each accepted connection,
//! opens an SSH `direct-tcpip` channel to the configured target and relays
//! bytes bidirectionally. Lifted from the desktop `tunnel` module into core so
//! the identical engine runs on the desktop **or** on a remote agent — only the
//! machine that hosts the listen socket moves (S3, part of #2139). See
//! `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use crate::backends::ssh::handler::SshSession;

use super::channel::{ChannelOpener, SshChannelOpener};
use super::config::{LocalForwardConfig, TunnelStats};

/// Manages a local port forwarding tunnel.
///
/// Binds a local TCP listener and spawns async relay tasks for each incoming
/// connection, forwarding traffic through an SSH `channel_open_direct_tcpip`.
pub struct LocalForwarder {
    task_handle: Option<tokio::task::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
    /// The address the listener actually bound. When `config.local_port` is `0`
    /// the OS assigns an ephemeral port; this reads it back so callers (and
    /// tests) can connect to the real port instead of racily re-binding a probed
    /// one (#2280).
    local_addr: std::net::SocketAddr,
    /// Fires when the accept loop exits (bind lost / listener error), so the
    /// tunnel supervisor can observe forwarder death and drive the tunnel to
    /// `Error` instead of leaving it green-forever (#1243, GAP 2). Taken once by
    /// the supervisor; `None` afterwards.
    death: Option<tokio::sync::oneshot::Receiver<()>>,
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

impl Default for ForwarderStats {
    fn default() -> Self {
        Self::new()
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
        Self::start_with_opener(config, SshChannelOpener::new(session))
    }

    /// Start a local port forwarding tunnel over an injected [`ChannelOpener`].
    ///
    /// Production goes through [`start`](Self::start) (which wraps the SSH
    /// session in an [`SshChannelOpener`]); tests inject an in-memory opener to
    /// exercise the accept/relay path without a live SSH server (#2044).
    pub fn start_with_opener<O: ChannelOpener>(
        config: &LocalForwardConfig,
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
        let remote_host = config.remote_host.clone();
        let remote_port = config.remote_port;

        // `death_tx` is moved into the accept task and dropped when it ends — on
        // a clean `break` (listener error) or an `abort()` from `stop()`. The
        // receiver resolves either way; the supervisor distinguishes a real death
        // from a user stop via its own cancel token (#1243).
        let (death_tx, death_rx) = tokio::sync::oneshot::channel();
        let task_handle = tokio::spawn(async move {
            let _death = death_tx;
            Self::accept_loop(listener, opener, remote_host, remote_port, stats_clone).await;
        });

        Ok(Self {
            task_handle: Some(task_handle),
            stats,
            local_addr,
            death: Some(death_rx),
        })
    }

    /// The address the listener actually bound.
    ///
    /// Equals `config.local_host:config.local_port` for a fixed request; when
    /// port `0` was requested the OS picked an ephemeral port and this returns
    /// the real one (#2280).
    pub fn local_addr(&self) -> std::net::SocketAddr {
        self.local_addr
    }

    /// Take the forwarder-death receiver (once) for the tunnel supervisor.
    pub fn take_death_signal(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.death.take()
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

    async fn accept_loop<O: ChannelOpener>(
        listener: tokio::net::TcpListener,
        opener: Arc<O>,
        remote_host: String,
        remote_port: u16,
        stats: Arc<ForwarderStats>,
    ) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    stats.increment_active();
                    let opener = Arc::clone(&opener);
                    let remote_host = remote_host.clone();
                    let stats = Arc::clone(&stats);
                    tokio::spawn(async move {
                        Self::relay_connection(stream, opener, remote_host, remote_port, &stats)
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

    async fn relay_connection<O: ChannelOpener>(
        mut stream: tokio::net::TcpStream,
        opener: Arc<O>,
        remote_host: String,
        remote_port: u16,
        stats: &ForwarderStats,
    ) {
        let mut channel_stream = match opener.open_direct_tcpip(remote_host, remote_port).await {
            Ok(ch) => ch,
            Err(e) => {
                tracing::error!("Failed to open direct-tcpip channel: {}", e);
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
}

impl Drop for LocalForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests for the local forwarder's relay path and stats, driven over a
    //! loopback listener plus an in-memory [`ChannelOpener`] fake so no live SSH
    //! server or network is needed (#2044). Before this the forwarder sat near
    //! 0% coverage because [`SshSession`] cannot be fabricated without a server.

    use std::io;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::super::channel::test_support::EchoChannelOpener;
    use super::super::config::LocalForwardConfig;
    use super::*;

    /// A config that binds an ephemeral loopback port. Passing port `0` lets the
    /// OS assign a free port the forwarder keeps, so the test reads the real port
    /// back via [`LocalForwarder::local_addr`] instead of racily re-binding a
    /// probed one (#2280).
    fn ephemeral_config() -> LocalForwardConfig {
        LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 0,
            remote_host: "db.internal".to_string(),
            remote_port: 5432,
        }
    }

    /// Poll `get_stats()` until `pred` holds or the deadline passes.
    async fn wait_for_stats(
        forwarder: &LocalForwarder,
        pred: impl Fn(&TunnelStats) -> bool,
    ) -> TunnelStats {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let stats = forwarder.get_stats();
            if pred(&stats) {
                return stats;
            }
            if tokio::time::Instant::now() >= deadline {
                return stats;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn relays_bytes_bidirectionally_and_records_stats() {
        let opener = EchoChannelOpener::new();
        let targets = opener.targets_handle();
        let forwarder = LocalForwarder::start_with_opener(&ephemeral_config(), opener)
            .expect("start forwarder");

        let mut client = TcpStream::connect(forwarder.local_addr())
            .await
            .expect("connect to local forward");
        client.write_all(b"hello world").await.expect("write");
        // Half-close so `copy_bidirectional` sees EOF client->channel; the echo
        // task then closes its end, ending the copy so stats are recorded.
        client.shutdown().await.expect("shutdown write half");

        let mut echoed = Vec::new();
        client
            .read_to_end(&mut echoed)
            .await
            .expect("read echoed bytes");
        assert_eq!(&echoed, b"hello world", "bytes should relay round-trip");

        let stats = wait_for_stats(&forwarder, |s| s.bytes_received == 11).await;
        assert_eq!(stats.bytes_sent, 11, "client->remote byte count");
        assert_eq!(stats.bytes_received, 11, "remote->client byte count");
        assert_eq!(stats.total_connections, 1);

        // The forwarder opened a channel to the configured remote target.
        let recorded = targets.lock().unwrap().clone();
        assert_eq!(recorded, vec![("db.internal".to_string(), 5432)]);
    }

    #[tokio::test]
    async fn teardown_closes_the_listener() {
        let forwarder =
            LocalForwarder::start_with_opener(&ephemeral_config(), EchoChannelOpener::new())
                .expect("start forwarder");
        let addr = forwarder.local_addr();

        // Sanity: the port accepts while running.
        TcpStream::connect(addr)
            .await
            .expect("connect while active");

        drop(forwarder); // Drop -> stop() aborts the accept task, freeing the port.

        // The listener should stop accepting shortly after teardown.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match TcpStream::connect(addr).await {
                Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => break,
                _ if tokio::time::Instant::now() >= deadline => {
                    panic!("listener still accepting after teardown");
                }
                _ => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
    }

    #[tokio::test]
    async fn channel_open_failure_counts_connection_but_relays_nothing() {
        let forwarder =
            LocalForwarder::start_with_opener(&ephemeral_config(), EchoChannelOpener::failing())
                .expect("start forwarder");

        let mut client = TcpStream::connect(forwarder.local_addr())
            .await
            .expect("connect to local forward");
        // The relay bails out when the channel fails to open, so the connection
        // closes with no bytes relayed.
        let mut buf = Vec::new();
        let _ = client.read_to_end(&mut buf).await;
        assert!(buf.is_empty(), "no bytes should be relayed on open failure");

        let stats = wait_for_stats(&forwarder, |s| s.total_connections == 1).await;
        assert_eq!(stats.total_connections, 1);
        assert_eq!(stats.bytes_sent, 0);
        assert_eq!(stats.bytes_received, 0);
    }

    #[test]
    fn stats_counters_track_traffic_and_connections() {
        let stats = ForwarderStats::new();
        let initial = stats.to_tunnel_stats();
        assert_eq!(initial.bytes_sent, 0);
        assert_eq!(initial.bytes_received, 0);
        assert_eq!(initial.active_connections, 0);
        assert_eq!(initial.total_connections, 0);

        stats.add_bytes_sent(100);
        stats.add_bytes_received(250);
        stats.increment_active();
        stats.increment_active();
        stats.decrement_active();

        let snap = stats.to_tunnel_stats();
        assert_eq!(snap.bytes_sent, 100);
        assert_eq!(snap.bytes_received, 250);
        assert_eq!(snap.active_connections, 1, "two opened, one closed");
        assert_eq!(snap.total_connections, 2, "total is monotonic");
    }
}
