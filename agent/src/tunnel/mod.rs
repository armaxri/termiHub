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
    #[cfg_attr(not(test), allow(dead_code))]
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

    #[test]
    fn loopback_forward_is_agent_only() {
        let forward = loopback_forward(15432);
        assert_eq!(
            classify_reachability(&forward.local_host),
            ReachableFrom::AgentOnly
        );
    }

    /// Full end-to-end start against the `ssh-tunnel-target` container (port
    /// 2207: internal HTTP on 8080, unreachable from the host). Drives the real
    /// agent registry — `start_local` opens the SSH session, binds on the agent,
    /// and forwards — then fetches HTTP through it and stops it. Skips gracefully
    /// when the container is not running (per-PR CI has no SSH server), matching
    /// the core integration-test convention.
    #[tokio::test]
    async fn start_local_forwards_http_over_ssh() {
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let port: u16 = std::env::var("TERMIHUB_TEST_SSH_TUNNEL_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2207);

        // Runtime skip: the container must be up and accepting SSH.
        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            eprintln!("skipping: ssh-tunnel-target not reachable on 127.0.0.1:{port}");
            return;
        }

        // Trust the local fixture host key (the container's key is not in this
        // machine's known_hosts). Process-wide, set-once — mirrors the core
        // integration-test harness's `trust_fixture_host_keys`.
        {
            use termihub_core::backends::ssh::host_key::{
                set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
            };
            struct TrustAll;
            #[async_trait::async_trait]
            impl HostKeyVerifier for TrustAll {
                async fn verify(&self, _info: &HostKeyInfo) -> bool {
                    true
                }
            }
            let _ = set_host_key_verifier(Arc::new(TrustAll));
        }

        let ssh_config = SshConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: "testuser".to_string(),
            auth_method: "password".to_string(),
            password: Some("testpass".to_string()),
            ..Default::default()
        };
        let listen_port = {
            std::net::TcpListener::bind("127.0.0.1:0")
                .expect("bind ephemeral")
                .local_addr()
                .expect("local addr")
                .port()
        };
        let forward = LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: listen_port,
            remote_host: "localhost".to_string(),
            remote_port: 8080,
        };

        let registry = AgentTunnelRegistry::new();
        let outcome = registry
            .start_local("t-http", &ssh_config, &forward)
            .await
            .expect("agent-hosted local forward should start");
        assert_eq!(outcome.reachable_from, ReachableFrom::AgentOnly);
        assert_eq!(outcome.bound_address, format!("127.0.0.1:{listen_port}"));
        assert_eq!(registry.active_count().await, 1);
        assert!(registry.status("t-http").await.is_some());

        // Fetch HTTP through the agent-hosted forward.
        let mut client = TcpStream::connect(("127.0.0.1", listen_port))
            .await
            .expect("connect to the agent-bound port");
        client
            .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await
            .expect("send request through agent tunnel");
        client.shutdown().await.ok();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut response))
            .await
            .expect("HTTP response before timeout")
            .expect("read HTTP response");
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/"),
            "expected HTTP response through the agent-hosted tunnel"
        );

        // Stopping removes the forward and frees the port.
        assert!(registry.stop("t-http").await);
        assert_eq!(registry.active_count().await, 0);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match TcpStream::connect(("127.0.0.1", listen_port)).await {
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => break,
                _ if tokio::time::Instant::now() >= deadline => {
                    panic!("agent forward still accepting after stop")
                }
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }
}
