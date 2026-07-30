//! Remote (`ssh -R`) port-forward engine, shared by desktop and agent (#2185).
//!
//! Requests a `tcpip_forward` on the SSH server so the **server** binds the
//! listen socket, then receives each incoming channel via the
//! [`ForwardedChannelRegistry`] and relays it to a target resolved from the
//! tunnel host's network (`local_host:local_port`). Lifted from the desktop
//! `tunnel` module into core so the identical engine runs on the desktop **or**
//! on a remote agent — SSH's own semantics are invariant, only the machine that
//! hosts the tunnel (and thus resolves the forward target) moves (S3, part of
//! #2139). See `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`.

use std::sync::Arc;

use crate::backends::ssh::handler::{ForwardedChannelRegistry, IncomingChannel, SshSession};

use super::config::{RemoteForwardConfig, TunnelStats};
use super::local_forward::ForwarderStats;

/// Manages a remote port forwarding tunnel.
///
/// Registers a `tcpip_forward` on the SSH server and receives incoming channels
/// via the [`ForwardedChannelRegistry`], then relays each to a target reachable
/// from the tunnel host (`local_host:local_port`).
pub struct RemoteForwarder {
    task_handle: Option<tokio::task::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
    registry: ForwardedChannelRegistry,
    bound_port: u32,
    _session: SshSession,
    /// Fires when the forward loop exits (the server-side channel source closed),
    /// so the tunnel supervisor can observe forwarder death (#1243, GAP 2).
    death: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl RemoteForwarder {
    /// Start a remote port forwarding tunnel (synchronous entry point).
    ///
    /// Wraps [`start_async`](Self::start_async) with `block_in_place` so the
    /// desktop's synchronous forwarder-build path is unchanged. Requires a
    /// multi-thread tokio runtime (the desktop and agent both use one).
    ///
    /// Calls `tcpip_forward` on the SSH server to request it to listen on
    /// `config.remote_host:config.remote_port`. Incoming channels are routed
    /// via the `registry` and forwarded to `config.local_host:config.local_port`.
    pub fn start(
        config: &RemoteForwardConfig,
        session: SshSession,
        registry: ForwardedChannelRegistry,
    ) -> Result<Self, std::io::Error> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(Self::start_async(config, session, registry))
        })
    }

    /// Start a remote port forwarding tunnel from an async context.
    ///
    /// The agent-hosted path calls this directly (it is already async), avoiding
    /// the `block_in_place` hop the desktop needs from its synchronous builder.
    pub async fn start_async(
        config: &RemoteForwardConfig,
        session: SshSession,
        registry: ForwardedChannelRegistry,
    ) -> Result<Self, std::io::Error> {
        let remote_host = config.remote_host.clone();
        let remote_port = config.remote_port as u32;

        let bound_port = session
            .tcpip_forward(remote_host.clone(), remote_port)
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        tracing::info!(
            "Remote forward listening on {}:{} (bound port {})",
            config.remote_host,
            config.remote_port,
            bound_port
        );

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<IncomingChannel>();
        registry.lock().unwrap().insert(bound_port, tx);

        let stats = Arc::new(ForwarderStats::new());
        let stats_clone = Arc::clone(&stats);
        let local_host = config.local_host.clone();
        let local_port = config.local_port;

        let (death_tx, death_rx) = tokio::sync::oneshot::channel();
        let task_handle = tokio::spawn(async move {
            let _death = death_tx;
            Self::forward_loop(rx, &local_host, local_port, stats_clone).await;
        });

        Ok(Self {
            task_handle: Some(task_handle),
            stats,
            registry,
            bound_port,
            _session: session,
            death: Some(death_rx),
        })
    }

    /// The port the SSH server actually bound. Equals `config.remote_port` for a
    /// fixed request; when `0` was requested the server picks an ephemeral port
    /// and returns it here.
    pub fn bound_port(&self) -> u32 {
        self.bound_port
    }

    /// Get current tunnel statistics.
    pub fn get_stats(&self) -> TunnelStats {
        self.stats.to_tunnel_stats()
    }

    /// Take the forwarder-death receiver (once) for the tunnel supervisor.
    pub fn take_death_signal(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.death.take()
    }

    /// Stop the forwarder and deregister from the channel registry.
    pub fn stop(&mut self) {
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
        if let Ok(mut reg) = self.registry.lock() {
            reg.remove(&self.bound_port);
        }
    }

    async fn forward_loop(
        mut rx: tokio::sync::mpsc::UnboundedReceiver<IncomingChannel>,
        local_host: &str,
        local_port: u16,
        stats: Arc<ForwarderStats>,
    ) {
        while let Some(incoming) = rx.recv().await {
            stats.increment_active();
            let local_addr = format!("{}:{}", local_host, local_port);
            let stats = Arc::clone(&stats);
            tokio::spawn(async move {
                relay_to_local(incoming.channel.into_stream(), &local_addr, &stats).await;
                stats.decrement_active();
            });
        }
    }
}

impl Drop for RemoteForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Relay a single incoming forwarded channel to the configured local target.
///
/// Generic over the channel byte stream so the relay/stats-accounting logic is
/// unit-testable with an in-memory stream — the production caller passes the
/// russh `ChannelStream` from `incoming.channel.into_stream()` (#2044).
async fn relay_to_local<S>(mut channel_stream: S, local_addr: &str, stats: &ForwarderStats)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut tcp = match tokio::net::TcpStream::connect(local_addr).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                "Remote forward: failed to connect to local {}: {}",
                local_addr,
                e
            );
            return;
        }
    };

    if let Ok((sent, received)) = tokio::io::copy_bidirectional(&mut tcp, &mut channel_stream).await
    {
        stats.add_bytes_sent(sent);
        stats.add_bytes_received(received);
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests for the remote forwarder's per-channel relay to a local
    //! target, driven with an in-memory duplex standing in for the SSH channel
    //! plus a loopback echo server as the local target (#2044). The
    //! `tcpip_forward` request itself needs a live SSH session and is covered by
    //! the integration lanes; here we lock in the relay + stats-accounting path
    //! that previously sat at 0% coverage.

    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// Spawn a loopback TCP echo server, returning its `host:port`.
    async fn spawn_echo_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind echo server");
        let addr = listener.local_addr().expect("addr").to_string();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if sock.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        addr
    }

    fn free_local_addr() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        // Drop the listener so the port is free (nothing listening -> refused).
        addr.to_string()
    }

    #[tokio::test]
    async fn relays_channel_to_local_target_and_records_stats() {
        let addr = spawn_echo_server().await;
        let stats = Arc::new(ForwarderStats::new());

        // `channel_stream` stands in for the SSH channel; `peer` is the remote
        // side that would write into it.
        let (channel_stream, mut peer) = tokio::io::duplex(64 * 1024);
        let stats_clone = Arc::clone(&stats);
        let addr_clone = addr.clone();
        let relay = tokio::spawn(async move {
            relay_to_local(channel_stream, &addr_clone, &stats_clone).await;
        });

        peer.write_all(b"hello").await.expect("write to channel");
        let mut echoed = [0u8; 5];
        peer.read_exact(&mut echoed).await.expect("read echo");
        assert_eq!(&echoed, b"hello", "channel <-> local relay round-trips");

        peer.shutdown().await.expect("half-close channel");
        drop(peer);

        tokio::time::timeout(Duration::from_secs(3), relay)
            .await
            .expect("relay finished")
            .expect("relay task ok");

        let snap = stats.to_tunnel_stats();
        assert_eq!(snap.bytes_sent, 5);
        assert_eq!(snap.bytes_received, 5);
    }

    #[tokio::test]
    async fn relay_to_unreachable_local_target_is_a_no_op() {
        let addr = free_local_addr(); // nothing is listening here
        let stats = Arc::new(ForwarderStats::new());
        let (channel_stream, _peer) = tokio::io::duplex(1024);

        // Should return promptly without panicking and without recording bytes.
        tokio::time::timeout(
            Duration::from_secs(3),
            relay_to_local(channel_stream, &addr, &stats),
        )
        .await
        .expect("relay returns on connect failure");

        let snap = stats.to_tunnel_stats();
        assert_eq!(snap.bytes_sent, 0);
        assert_eq!(snap.bytes_received, 0);
    }
}
