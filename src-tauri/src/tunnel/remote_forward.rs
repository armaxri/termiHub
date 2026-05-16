use std::sync::Arc;

use termihub_core::backends::ssh::handler::{
    ForwardedChannelRegistry, IncomingChannel, SshSession,
};

use super::config::{RemoteForwardConfig, TunnelStats};
use super::local_forward::ForwarderStats;

/// Manages a remote port forwarding tunnel.
///
/// Registers a `tcpip_forward` on the SSH server and receives incoming channels
/// via the [`ForwardedChannelRegistry`], then relays each to a local TCP target.
pub struct RemoteForwarder {
    task_handle: Option<tokio::task::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
    registry: ForwardedChannelRegistry,
    bound_port: u32,
    _session: SshSession,
}

impl RemoteForwarder {
    /// Start a remote port forwarding tunnel.
    ///
    /// Calls `tcpip_forward` on the SSH server to request it to listen on
    /// `config.remote_host:config.remote_port`. Incoming channels are routed
    /// via the `registry` and forwarded to `config.local_host:config.local_port`.
    pub fn start(
        config: &RemoteForwardConfig,
        mut session: SshSession,
        registry: ForwardedChannelRegistry,
    ) -> Result<Self, std::io::Error> {
        let remote_host = config.remote_host.clone();
        let remote_port = config.remote_port as u32;

        let bound_port = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(session.tcpip_forward(remote_host.clone(), remote_port))
        })
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

        let task_handle = tokio::spawn(async move {
            Self::forward_loop(rx, &local_host, local_port, stats_clone).await;
        });

        Ok(Self {
            task_handle: Some(task_handle),
            stats,
            registry,
            bound_port,
            _session: session,
        })
    }

    /// Get current tunnel statistics.
    pub fn get_stats(&self) -> TunnelStats {
        self.stats.to_tunnel_stats()
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
                relay_to_local(incoming, &local_addr, &stats).await;
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

async fn relay_to_local(incoming: IncomingChannel, local_addr: &str, stats: &ForwarderStats) {
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

    let mut channel_stream = incoming.channel.into_stream();
    if let Ok((sent, received)) = tokio::io::copy_bidirectional(&mut tcp, &mut channel_stream).await
    {
        stats.add_bytes_sent(sent);
        stats.add_bytes_received(received);
    }
}
