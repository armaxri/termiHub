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
//! Implemented: **local** (`ssh -L`), **remote** (`ssh -R`), and **dynamic**
//! (`ssh -D`, SOCKS5) forwarding (#2185, #2198). In each the agent opens its own
//! SSH session to the tunnel's "via" server, reusing the shared core forward
//! engines. For `-L` the agent binds the listen socket (loopback by default) and
//! forwards to a target on the server's network. For `-R` the **SSH server**
//! binds the listen socket (via `tcpip_forward`) and each incoming channel is
//! relayed to a target resolved from the **agent** (the tunnel host) — SSH's
//! semantics are invariant, only the tunnel host moves. For `-D` the agent binds
//! the SOCKS5 proxy listen socket (loopback by default) and each proxied
//! connection's target — chosen by the SOCKS client — is reached from the SSH
//! server's network (see
//! `docs/concepts/future/stateless-ui-agent-tunnel-endpoints.html`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, SshSession};
use termihub_core::config::SshConfig;
use termihub_core::tunnel::config::{
    DynamicForwardConfig, LocalForwardConfig, RemoteForwardConfig, TunnelStats,
};
use termihub_core::tunnel::dynamic_forward::DynamicForwarder;
use termihub_core::tunnel::local_forward::LocalForwarder;
use termihub_core::tunnel::remote_forward::RemoteForwarder;
use termihub_core::tunnel::{classify_reachability, ActiveForwarder, ReachableFrom};
use tokio::sync::Mutex;

/// A tunnel currently forwarding on this agent: the live forwarder plus any SSH
/// session it rides.
///
/// Dropping this value stops the forward — each forwarder's `Drop` aborts its
/// task — so `stop`/`stop_all` need only remove the entry from the map.
struct RunningTunnel {
    forwarder: ActiveForwarder,
    /// Held for a **local** tunnel's lifetime so the SSH session outlives the
    /// forwarder. `None` for a remote tunnel — [`RemoteForwarder`] owns its own
    /// dedicated session (`tcpip_forward` needs an owned handle).
    _session: Option<Arc<SshSession>>,
    /// The `host:port` the listen socket bound (on the agent for `-L`, on the
    /// SSH server for `-R`).
    bound_address: String,
    /// Who can reach the listen socket.
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

/// Everything a forward-kind-specific setup produces once the agent's SSH
/// session is up: the live forwarder, the session to hold for the tunnel's
/// lifetime (if any), and the bound-address / reachability to record and report.
///
/// This is the only part that differs between local (`-L`), remote (`-R`), and
/// dynamic (`-D`) starts — the connect / duplicate-check / register scaffold
/// around it is shared (see [`AgentTunnelRegistry::start`]).
struct PreparedForward {
    /// The live forward engine, wrapped in its [`ActiveForwarder`] variant.
    forwarder: ActiveForwarder,
    /// The SSH session to hold for the tunnel's lifetime, or `None` when the
    /// forwarder owns its own session (the remote/`-R` case).
    session: Option<Arc<SshSession>>,
    /// The `host:port` the listen socket bound.
    bound_address: String,
    /// Who can reach the listen socket.
    reachable_from: ReachableFrom,
}

impl PreparedForward {
    /// A local (`-L`) forward whose listen socket is bound on this agent.
    fn local(forwarder: LocalForwarder, session: Option<Arc<SshSession>>, host: &str) -> Self {
        let listen = forwarder.local_addr();
        Self::agent_listener(ActiveForwarder::Local(forwarder), listen, session, host)
    }

    /// A dynamic (`-D`, SOCKS5) forward whose listen socket is bound on this
    /// agent.
    fn dynamic(forwarder: DynamicForwarder, session: Option<Arc<SshSession>>, host: &str) -> Self {
        let listen = forwarder.local_addr();
        Self::agent_listener(ActiveForwarder::Dynamic(forwarder), listen, session, host)
    }

    /// Shared shape of an agent-side listener: report the address the socket
    /// actually bound — for a port-0 config the OS-assigned port, not the
    /// configured `0` (#3550) — with reachability classified from the
    /// configured bind host.
    fn agent_listener(
        forwarder: ActiveForwarder,
        listen: SocketAddr,
        session: Option<Arc<SshSession>>,
        local_host: &str,
    ) -> Self {
        Self {
            forwarder,
            session,
            bound_address: listen.to_string(),
            reachable_from: classify_reachability(local_host),
        }
    }
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

    /// Shared scaffold for the three `start_*` entry points.
    ///
    /// Every kind of agent-hosted tunnel is started the same way: reject a
    /// duplicate `tunnel_id`, open the agent's SSH session (the agent runs the
    /// SSH client — this is the hop that moves in-network, agent ↔ server,
    /// instead of desktop ↔ server), hand the session and its forwarded-channel
    /// registry to `prepare` for the forward-kind-specific setup, then register
    /// the running tunnel and report its outcome. Only `prepare` differs between
    /// local (`-L`), remote (`-R`), and dynamic (`-D`); it returns the live
    /// forwarder plus the bound-address / reachability to record (see
    /// [`PreparedForward`]).
    ///
    /// Fails if a tunnel with `tunnel_id` is already running here, if the SSH
    /// connect fails, or if `prepare` fails (e.g. bind or forward-request error).
    async fn start<F, Fut>(
        &self,
        tunnel_id: &str,
        ssh_config: &SshConfig,
        prepare: F,
    ) -> Result<TunnelStartOutcome>
    where
        F: FnOnce(SshSession, ForwardedChannelRegistry) -> Fut,
        Fut: std::future::Future<Output = Result<PreparedForward>>,
    {
        {
            let tunnels = self.tunnels.lock().await;
            if tunnels.contains_key(tunnel_id) {
                anyhow::bail!("tunnel '{tunnel_id}' is already running on this agent");
            }
        }

        let (session, registry) = connect_and_authenticate(ssh_config)
            .await
            .context("agent SSH connect for tunnel failed")?;

        let prepared = prepare(session, registry).await?;

        let mut tunnels = self.tunnels.lock().await;
        // Re-check under the write lock in case a concurrent start raced us.
        if tunnels.contains_key(tunnel_id) {
            anyhow::bail!("tunnel '{tunnel_id}' is already running on this agent");
        }
        tunnels.insert(
            tunnel_id.to_string(),
            RunningTunnel {
                forwarder: prepared.forwarder,
                _session: prepared.session,
                bound_address: prepared.bound_address.clone(),
                reachable_from: prepared.reachable_from,
            },
        );

        Ok(TunnelStartOutcome {
            bound_address: prepared.bound_address,
            reachable_from: prepared.reachable_from,
        })
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
        self.start(tunnel_id, ssh_config, |session, _registry| async move {
            let session = Arc::new(session);
            let forwarder = LocalForwarder::start(forward, Arc::clone(&session))
                .context("failed to bind agent-hosted local forwarder")?;
            Ok(PreparedForward::local(
                forwarder,
                Some(session),
                &forward.local_host,
            ))
        })
        .await
    }

    /// Start a remote (`ssh -R`) forward on this agent.
    ///
    /// Opens an SSH session to `ssh_config`'s server and requests a
    /// `tcpip_forward` so the **SSH server** binds the listen socket at
    /// `forward.remote_host:remote_port`. Each incoming channel is relayed to
    /// `forward.local_host:local_port` resolved from **this agent's** network —
    /// the agent is the tunnel host, so `-R`'s target vantage moves onto it (see
    /// the endpoint-semantics concept). The reported `reachable_from` is
    /// [`ReachableFrom::SshServer`]: the listen socket lives on the server, not
    /// the agent. Fails if a tunnel with `tunnel_id` is already running here, if
    /// the SSH connect fails, or if the server refuses the forward.
    pub async fn start_remote(
        &self,
        tunnel_id: &str,
        ssh_config: &SshConfig,
        forward: &RemoteForwardConfig,
    ) -> Result<TunnelStartOutcome> {
        // `-R` needs the forwarded-channel registry from the same session, so a
        // dedicated (non-shared) session is used — `RemoteForwarder` takes
        // ownership of it, hence `session: None` below.
        self.start(tunnel_id, ssh_config, |session, registry| async move {
            let forwarder = RemoteForwarder::start_async(forward, session, registry)
                .await
                .context("failed to request agent-hosted remote forward")?;
            // The listen socket lives on the SSH server; report the port it
            // actually bound (an ephemeral port when `remote_port == 0`).
            Ok(PreparedForward {
                bound_address: format!("{}:{}", forward.remote_host, forwarder.bound_port()),
                forwarder: ActiveForwarder::Remote(forwarder),
                session: None,
                reachable_from: ReachableFrom::SshServer,
            })
        })
        .await
    }

    /// Start a dynamic (`ssh -D`, SOCKS5) forward on this agent.
    ///
    /// Opens an SSH session to `ssh_config`'s server and binds the SOCKS5 proxy
    /// listen socket on the agent per `forward.local_host:local_port` (loopback
    /// by default). Each proxied connection's target is chosen by the SOCKS
    /// client per-connection and resolved from the SSH server's network — the
    /// agent is the tunnel host, so the listen socket moves onto it while the
    /// per-connection target vantage stays on the server (see the
    /// endpoint-semantics concept). The reported `reachable_from` is classified
    /// from the bind host (loopback → [`ReachableFrom::AgentOnly`]), the same
    /// loopback-safe default as `-L`. Fails if a tunnel with `tunnel_id` is
    /// already running here, if the SSH connect fails, or if the bind fails
    /// (e.g. address in use).
    pub async fn start_dynamic(
        &self,
        tunnel_id: &str,
        ssh_config: &SshConfig,
        forward: &DynamicForwardConfig,
    ) -> Result<TunnelStartOutcome> {
        self.start(tunnel_id, ssh_config, |session, _registry| async move {
            let session = Arc::new(session);
            let forwarder = DynamicForwarder::start(forward, Arc::clone(&session))
                .context("failed to bind agent-hosted dynamic (SOCKS5) forwarder")?;
            Ok(PreparedForward::dynamic(
                forwarder,
                Some(session),
                &forward.local_host,
            ))
        })
        .await
    }

    /// Stop a running tunnel, returning whether one was found.
    ///
    /// Removing the entry drops the `RunningTunnel`, which stops the forwarder
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

    /// Number of tunnels currently forwarding on this agent. Public (not
    /// test-gated) so `tests/tunnel_integration.rs` can assert on it (#4288).
    pub async fn active_count(&self) -> usize {
        self.tunnels.lock().await.len()
    }

    /// Take a running tunnel's forwarder-death receiver (once).
    ///
    /// Resolves only after the forwarder's accept task — and the listen socket it
    /// owns — has been dropped, so tests can assert a stop actually closed the
    /// listener without probing the freed port (#3551). Public (not test-gated)
    /// so `tests/tunnel_integration.rs` can use it (#4288).
    pub async fn take_death_signal(
        &self,
        tunnel_id: &str,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.tunnels
            .lock()
            .await
            .get_mut(tunnel_id)
            .and_then(|t| t.forwarder.take_death_signal())
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

    // ── Reported bound address (#3550) ────────────────────────────────────────

    /// In-memory [`ChannelOpener`] whose "channels" echo every byte back, so a
    /// forwarder's accept/relay path runs without a live SSH server.
    struct EchoOpener;

    impl termihub_core::tunnel::ChannelOpener for EchoOpener {
        type Stream = tokio::io::DuplexStream;

        async fn open_direct_tcpip(
            &self,
            _host: String,
            _port: u16,
        ) -> std::io::Result<Self::Stream> {
            let (ours, theirs) = tokio::io::duplex(1024);
            tokio::spawn(async move {
                let (mut rd, mut wr) = tokio::io::split(theirs);
                let _ = tokio::io::copy(&mut rd, &mut wr).await;
            });
            Ok(ours)
        }
    }

    /// Port parsed from a reported `host:port` / `[v6]:port` bound address.
    fn reported_port(bound_address: &str) -> u16 {
        bound_address
            .rsplit_once(':')
            .and_then(|(_, p)| p.parse().ok())
            .expect("bound_address ends in :port")
    }

    #[tokio::test]
    async fn local_forward_on_port_zero_reports_real_bound_port() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let forward = loopback_forward(0);
        let forwarder = LocalForwarder::start_with_opener(&forward, EchoOpener).expect("bind");
        let prepared = PreparedForward::local(forwarder, None, &forward.local_host);

        let port = reported_port(&prepared.bound_address);
        assert_ne!(port, 0, "reported {:?}", prepared.bound_address);
        assert_eq!(prepared.reachable_from, ReachableFrom::AgentOnly);

        // A client connecting to the reported port reaches the forwarder.
        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect to the reported port");
        client.write_all(b"ping").await.expect("write");
        let mut echoed = [0u8; 4];
        client.read_exact(&mut echoed).await.expect("echo");
        assert_eq!(&echoed, b"ping");
    }

    #[tokio::test]
    async fn dynamic_forward_on_port_zero_reports_real_bound_port() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let forward = DynamicForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 0,
        };
        let forwarder = DynamicForwarder::start_with_opener(&forward, EchoOpener).expect("bind");
        let prepared = PreparedForward::dynamic(forwarder, None, &forward.local_host);

        let port = reported_port(&prepared.bound_address);
        assert_ne!(port, 0, "reported {:?}", prepared.bound_address);

        // The reported port speaks SOCKS5: a no-auth greeting is accepted.
        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect to the reported port");
        client.write_all(&[0x05, 0x01, 0x00]).await.expect("greet");
        let mut method = [0u8; 2];
        client.read_exact(&mut method).await.expect("method");
        assert_eq!(method, [0x05, 0x00]);
    }

    /// Two forwards racing for one fixed port: at most one binds, and the one
    /// that does reports exactly the port it holds.
    #[tokio::test]
    async fn concurrent_local_forwards_on_same_port_bind_at_most_once() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let forward = loopback_forward(port);

        let (a, b) = tokio::join!(
            async { LocalForwarder::start_with_opener(&forward, EchoOpener) },
            async { LocalForwarder::start_with_opener(&forward, EchoOpener) },
        );
        let bound: Vec<_> = [a, b].into_iter().filter_map(Result::ok).collect();
        assert!(bound.len() <= 1, "two forwarders bound port {port}");
        for forwarder in bound {
            let prepared = PreparedForward::local(forwarder, None, &forward.local_host);
            assert_eq!(reported_port(&prepared.bound_address), port);
        }
    }

    #[tokio::test]
    async fn empty_registry_reports_no_tunnel() {
        let registry = AgentTunnelRegistry::new();
        assert_eq!(registry.active_count().await, 0);
        assert!(registry.status("nope").await.is_none());
        assert!(!registry.stop("nope").await);
    }

    fn remote_forward(bind_port: u16, target_port: u16) -> RemoteForwardConfig {
        RemoteForwardConfig {
            remote_host: "127.0.0.1".to_string(),
            remote_port: bind_port,
            local_host: "127.0.0.1".to_string(),
            local_port: target_port,
        }
    }

    #[test]
    fn loopback_forward_is_agent_only() {
        let forward = loopback_forward(15432);
        assert_eq!(
            classify_reachability(&forward.local_host),
            ReachableFrom::AgentOnly
        );
    }

    #[test]
    fn remote_forward_config_carries_server_bind_and_agent_target() {
        // `-R` binds `remote_host:remote_port` on the SSH server and forwards to
        // `local_host:local_port` resolved from the agent (the tunnel host). The
        // reported vantage is always `SshServer` (set in `start_remote`), never
        // classified from the agent's loopback the way `-L` is.
        let forward = remote_forward(0, 3000);
        assert_eq!(forward.remote_host, "127.0.0.1");
        assert_eq!(forward.remote_port, 0, "0 lets the server pick the port");
        assert_eq!(forward.local_port, 3000);
        assert_ne!(ReachableFrom::SshServer, ReachableFrom::AgentOnly);
    }
}
