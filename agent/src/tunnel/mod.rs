//! Agent-hosted SSH tunnel forwarding (S3, #2185, part of #2139).
//!
//! When a tunnel's run-location is an agent, the SSH client and the listen
//! socket move onto the agent — only the *tunnel host* changes; SSH's own
//! local/remote/dynamic semantics are invariant (see
//! `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`). The
//! desktop keeps ownership of *control* (start/stop/status over the agent RPC);
//! the *data* path — listen socket, SSH channel, target connection — lives
//! entirely here.
//!
//! This first slice implements **local** (`ssh -L`) forwarding: the agent opens
//! its own SSH session to the tunnel's "via" server and binds the listen socket
//! on the agent (loopback by default), reusing the shared
//! [`LocalForwarder`](termihub_core::tunnel::local_forward::LocalForwarder)
//! engine. Remote (`-R`) and dynamic (`-D`) agent hosting are tracked as
//! follow-ups to #2185.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::config::SshConfig;
use termihub_core::tunnel::config::{LocalForwardConfig, TunnelStats};
use termihub_core::tunnel::local_forward::LocalForwarder;
use termihub_core::tunnel::{classify_reachability, ReachableFrom};
use tokio::sync::Mutex;

/// A tunnel currently forwarding on this agent: the live forwarder plus the SSH
/// session it rides.
///
/// Dropping this value stops the forward — `LocalForwarder`'s `Drop` aborts the
/// accept loop and closing the last `Arc<SshSession>` tears the SSH connection
/// down — so `stop`/`stop_all` need only remove the entry from the map.
struct RunningTunnel {
    forwarder: LocalForwarder,
    /// Held for the tunnel's lifetime so the SSH session outlives the forwarder.
    _session: Arc<SshSession>,
    /// The `host:port` the listen socket bound on the agent.
    bound_address: String,
    /// Who can reach the listen socket (loopback → agent-only).
    reachable_from: ReachableFrom,
}

/// Outcome of starting an agent-hosted tunnel, reported back to the desktop for
/// the projection (badge + reachability warning).
pub struct TunnelStartOutcome {
    /// The `host:port` the listen socket bound on the agent.
    pub bound_address: String,
    /// Who can reach the listen socket.
    pub reachable_from: ReachableFrom,
}

/// A status snapshot of a running agent-hosted tunnel.
pub struct TunnelStatusSnapshot {
    /// Live traffic counters.
    pub stats: TunnelStats,
    /// The `host:port` the listen socket bound on the agent.
    pub bound_address: String,
    /// Who can reach the listen socket.
    pub reachable_from: ReachableFrom,
}

/// Registry of tunnels currently forwarding on this agent, keyed by tunnel id.
///
/// Long-lived, id-keyed, and behind an async `Mutex` — the same shape as the
/// agent's other resource registries (e.g. the session manager). Held in
/// `HandlerState` so the `tunnel.*` RPC methods can start, stop, and inspect
/// tunnels.
#[derive(Default)]
pub struct AgentTunnelRegistry {
    tunnels: Mutex<HashMap<String, RunningTunnel>>,
}

impl AgentTunnelRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a local (`ssh -L`) forward on this agent.
    ///
    /// Opens an SSH session to `ssh_config`'s server, binds the listen socket on
    /// the agent per `forward.local_host:local_port`, and relays each accepted
    /// connection to `forward.remote_host:remote_port` resolved from the SSH
    /// server. Fails if a tunnel with `tunnel_id` is already running here, if the
    /// SSH connect fails, or if the bind fails (e.g. address in use).
    pub async fn start_local(
        &self,
        tunnel_id: &str,
        ssh_config: &SshConfig,
        forward: &LocalForwardConfig,
    ) -> Result<TunnelStartOutcome> {
        {
            let tunnels = self.tunnels.lock().await;
            if tunnels.contains_key(tunnel_id) {
                anyhow::bail!("tunnel '{tunnel_id}' is already running on this agent");
            }
        }

        // The agent runs the SSH client — this is the hop that moves in-network
        // (agent ↔ server) instead of desktop ↔ server.
        let (session, _registry) = connect_and_authenticate(ssh_config)
            .await
            .context("agent SSH connect for tunnel failed")?;
        let session = Arc::new(session);

        let forwarder = LocalForwarder::start(forward, Arc::clone(&session))
            .context("failed to bind agent-hosted local forwarder")?;

        let bound_address = format!("{}:{}", forward.local_host, forward.local_port);
        let reachable_from = classify_reachability(&forward.local_host);

        let mut tunnels = self.tunnels.lock().await;
        // Re-check under the write lock in case a concurrent start raced us.
        if tunnels.contains_key(tunnel_id) {
            anyhow::bail!("tunnel '{tunnel_id}' is already running on this agent");
        }
        tunnels.insert(
            tunnel_id.to_string(),
            RunningTunnel {
                forwarder,
                _session: session,
                bound_address: bound_address.clone(),
                reachable_from,
            },
        );

        Ok(TunnelStartOutcome {
            bound_address,
            reachable_from,
        })
    }

    /// Stop a running tunnel, returning whether one was found.
    ///
    /// Removing the entry drops the [`RunningTunnel`], which stops the forwarder
    /// and releases the SSH session.
    pub async fn stop(&self, tunnel_id: &str) -> bool {
        self.tunnels.lock().await.remove(tunnel_id).is_some()
    }

    /// A status snapshot for a running tunnel, or `None` if not running here.
    pub async fn status(&self, tunnel_id: &str) -> Option<TunnelStatusSnapshot> {
        let tunnels = self.tunnels.lock().await;
        tunnels.get(tunnel_id).map(|t| TunnelStatusSnapshot {
            stats: t.forwarder.get_stats(),
            bound_address: t.bound_address.clone(),
            reachable_from: t.reachable_from,
        })
    }

    /// Number of tunnels currently forwarding on this agent.
    pub async fn active_count(&self) -> usize {
        self.tunnels.lock().await.len()
    }

    /// Stop every running tunnel (used on agent shutdown).
    pub async fn stop_all(&self) {
        self.tunnels.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::tunnel::config::LocalForwardConfig;

    fn loopback_forward(port: u16) -> LocalForwardConfig {
        LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: port,
            remote_host: "db.internal".to_string(),
            remote_port: 5432,
        }
    }

    #[tokio::test]
    async fn empty_registry_reports_no_tunnel() {
        let registry = AgentTunnelRegistry::new();
        assert_eq!(registry.active_count().await, 0);
        assert!(registry.status("nope").await.is_none());
        assert!(!registry.stop("nope").await);
    }

    // A full start requires a live SSH server, exercised by the local-container
    // integration run rather than a unit test (per-PR CI has no SSH server).
    // The forwarder's accept/relay path itself is unit-tested in
    // `termihub_core::tunnel::local_forward`.
    #[test]
    fn loopback_forward_is_agent_only() {
        let forward = loopback_forward(15432);
        assert_eq!(
            classify_reachability(&forward.local_host),
            ReachableFrom::AgentOnly
        );
    }
}
