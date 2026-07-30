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
use std::sync::Arc;

use anyhow::{Context, Result};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::config::SshConfig;
use termihub_core::tunnel::config::{
    DynamicForwardConfig, LocalForwardConfig, RemoteForwardConfig, TunnelStats,
};
use termihub_core::tunnel::dynamic_forward::DynamicForwarder;
use termihub_core::tunnel::local_forward::LocalForwarder;
use termihub_core::tunnel::remote_forward::RemoteForwarder;
use termihub_core::tunnel::{classify_reachability, ReachableFrom};
use tokio::sync::Mutex;

/// The live forward engine backing a running agent-hosted tunnel.
///
/// Both variants stop on `Drop` (each forwarder aborts its task and releases its
/// SSH resources), so `stop`/`stop_all` need only remove the map entry.
enum ActiveForwarder {
    /// A local (`ssh -L`) forward; the listen socket binds on the agent.
    Local(LocalForwarder),
    /// A remote (`ssh -R`) forward; the SSH server binds the listen socket and
    /// the [`RemoteForwarder`] owns the SSH session it rides.
    Remote(RemoteForwarder),
    /// A dynamic (`ssh -D`, SOCKS5) forward; the SOCKS proxy listen socket binds
    /// on the agent.
    Dynamic(DynamicForwarder),
}

impl ActiveForwarder {
    fn get_stats(&self) -> TunnelStats {
        match self {
            ActiveForwarder::Local(f) => f.get_stats(),
            ActiveForwarder::Remote(f) => f.get_stats(),
            ActiveForwarder::Dynamic(f) => f.get_stats(),
        }
    }
}

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
                forwarder: ActiveForwarder::Local(forwarder),
                _session: Some(session),
                bound_address: bound_address.clone(),
                reachable_from,
            },
        );

        Ok(TunnelStartOutcome {
            bound_address,
            reachable_from,
        })
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
        {
            let tunnels = self.tunnels.lock().await;
            if tunnels.contains_key(tunnel_id) {
                anyhow::bail!("tunnel '{tunnel_id}' is already running on this agent");
            }
        }

        // The agent runs the SSH client. `-R` needs the forwarded-channel
        // registry from the same session, so a dedicated (non-shared) session is
        // used — `RemoteForwarder` takes ownership of it.
        let (session, registry) = connect_and_authenticate(ssh_config)
            .await
            .context("agent SSH connect for tunnel failed")?;

        let forwarder = RemoteForwarder::start_async(forward, session, registry)
            .await
            .context("failed to request agent-hosted remote forward")?;

        // The listen socket lives on the SSH server; report the port it actually
        // bound (an ephemeral port when `remote_port == 0` was requested).
        let bound_address = format!("{}:{}", forward.remote_host, forwarder.bound_port());
        let reachable_from = ReachableFrom::SshServer;

        let mut tunnels = self.tunnels.lock().await;
        if tunnels.contains_key(tunnel_id) {
            anyhow::bail!("tunnel '{tunnel_id}' is already running on this agent");
        }
        tunnels.insert(
            tunnel_id.to_string(),
            RunningTunnel {
                forwarder: ActiveForwarder::Remote(forwarder),
                _session: None,
                bound_address: bound_address.clone(),
                reachable_from,
            },
        );

        Ok(TunnelStartOutcome {
            bound_address,
            reachable_from,
        })
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

        let forwarder = DynamicForwarder::start(forward, Arc::clone(&session))
            .context("failed to bind agent-hosted dynamic (SOCKS5) forwarder")?;

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
                forwarder: ActiveForwarder::Dynamic(forwarder),
                _session: Some(session),
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

    /// Full end-to-end start of an agent-hosted **remote** (`-R`) forward against
    /// the `ssh-tunnel-target` container. The listen socket is bound on the SSH
    /// server; the target is resolved from **this agent** (the tunnel host):
    ///
    /// 1. Stand up a loopback echo server on the agent — this is the `-R` target.
    /// 2. `start_remote` asks the server to listen on `127.0.0.1:0` and forward
    ///    back to the agent's echo server; the server picks an ephemeral port.
    /// 3. Drive traffic through the server-side listener by opening a
    ///    `direct-tcpip` channel from a **second** SSH session to the server's
    ///    own `127.0.0.1:<bound_port>` — the server connects to its own forwarded
    ///    listener, which fans a `forwarded-tcpip` channel back to the forwarder,
    ///    which relays it to the agent's echo server. Bytes round-trip.
    ///
    /// Skips gracefully when the container is not running (per-PR CI has no SSH
    /// server), matching the local test above.
    #[tokio::test]
    async fn start_remote_forwards_over_ssh() {
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        let port: u16 = std::env::var("TERMIHUB_TEST_SSH_TUNNEL_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2207);

        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            eprintln!("skipping: ssh-tunnel-target not reachable on 127.0.0.1:{port}");
            return;
        }

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

        // 1. A loopback echo server on the agent — the `-R` forward target.
        let echo = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind agent echo server");
        let agent_target_port = echo.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = echo.accept().await {
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

        let ssh_config = SshConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: "testuser".to_string(),
            auth_method: "password".to_string(),
            password: Some("testpass".to_string()),
            ..Default::default()
        };

        // 2. Ask the SSH server to bind an ephemeral loopback port and forward
        //    back to the agent's echo server.
        let forward = RemoteForwardConfig {
            remote_host: "127.0.0.1".to_string(),
            remote_port: 0,
            local_host: "127.0.0.1".to_string(),
            local_port: agent_target_port,
        };

        let registry = AgentTunnelRegistry::new();
        let outcome = registry
            .start_remote("t-remote", &ssh_config, &forward)
            .await
            .expect("agent-hosted remote forward should start");
        assert_eq!(
            outcome.reachable_from,
            ReachableFrom::SshServer,
            "an -R listen socket lives on the SSH server"
        );
        assert_eq!(registry.active_count().await, 1);
        assert!(registry.status("t-remote").await.is_some());

        let bound_port: u16 = outcome
            .bound_address
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .expect("server-bound port in bound_address");
        assert_ne!(bound_port, 0, "server must report the port it bound");

        // 3. Drive traffic: a second SSH session opens a direct-tcpip channel to
        //    the server's own forwarded listener, so the server connects into it.
        let (driver, _reg) = connect_and_authenticate(&ssh_config)
            .await
            .expect("second SSH session to drive the forwarded listener");
        let channel = driver
            .channel_open_direct_tcpip("127.0.0.1", bound_port as u32, "127.0.0.1", 0)
            .await
            .expect("open channel to the server-side forwarded listener");
        let mut stream = channel.into_stream();

        stream
            .write_all(b"ping-through-R")
            .await
            .expect("write into the forwarded channel");
        let mut echoed = [0u8; 14];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut echoed))
            .await
            .expect("echo before timeout")
            .expect("read echoed bytes");
        assert_eq!(
            &echoed, b"ping-through-R",
            "bytes should relay server -> agent target and back"
        );

        // Stopping removes the forward and the server tears down its listener.
        assert!(registry.stop("t-remote").await);
        assert_eq!(registry.active_count().await, 0);
    }

    /// Full end-to-end start of an agent-hosted **dynamic** (`-D`, SOCKS5)
    /// forward against the `ssh-tunnel-target` container (port 2207: internal
    /// HTTP on 8080, unreachable from the host). The SOCKS proxy listen socket
    /// binds on the agent; the per-connection target is chosen by the SOCKS
    /// client and reached from the SSH server:
    ///
    /// 1. `start_dynamic` opens the SSH session and binds the SOCKS5 proxy on an
    ///    ephemeral agent loopback port.
    /// 2. A SOCKS5 client negotiates no-auth and issues `CONNECT localhost:8080`
    ///    — the container's internal HTTP server, resolved from the **server**.
    /// 3. An HTTP request flows through the proxied channel and a response comes
    ///    back, proving the agent-hosted SOCKS proxy reaches a server-only target.
    ///
    /// Skips gracefully when the container is not running (per-PR CI has no SSH
    /// server), matching the local/remote tests above.
    #[tokio::test]
    async fn start_dynamic_socks_forwards_http_over_ssh() {
        use std::time::Duration;
        use termihub_core::tunnel::config::DynamicForwardConfig;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let port: u16 = std::env::var("TERMIHUB_TEST_SSH_TUNNEL_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2207);

        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            eprintln!("skipping: ssh-tunnel-target not reachable on 127.0.0.1:{port}");
            return;
        }

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
        let forward = DynamicForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: listen_port,
        };

        let registry = AgentTunnelRegistry::new();
        let outcome = registry
            .start_dynamic("t-socks", &ssh_config, &forward)
            .await
            .expect("agent-hosted dynamic forward should start");
        assert_eq!(
            outcome.reachable_from,
            ReachableFrom::AgentOnly,
            "a loopback SOCKS bind is reachable only from the agent"
        );
        assert_eq!(outcome.bound_address, format!("127.0.0.1:{listen_port}"));
        assert_eq!(registry.active_count().await, 1);

        // Drive an HTTP request through the SOCKS proxy: negotiate no-auth, then
        // `CONNECT localhost:8080` (resolved from the SSH server) and speak HTTP.
        let mut client = TcpStream::connect(("127.0.0.1", listen_port))
            .await
            .expect("connect to the agent-bound SOCKS port");
        client
            .write_all(&[0x05, 0x01, 0x00])
            .await
            .expect("send SOCKS5 no-auth greeting");
        let mut method = [0u8; 2];
        client
            .read_exact(&mut method)
            .await
            .expect("read method selection");
        assert_eq!(method, [0x05, 0x00], "server selects no-auth");

        let host = b"localhost";
        let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
        req.extend_from_slice(host);
        req.extend_from_slice(&8080u16.to_be_bytes());
        client
            .write_all(&req)
            .await
            .expect("send SOCKS5 CONNECT localhost:8080");
        let mut reply = [0u8; 10];
        client
            .read_exact(&mut reply)
            .await
            .expect("read SOCKS5 CONNECT reply");
        assert_eq!(reply[1], 0x00, "CONNECT should succeed through the server");

        client
            .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await
            .expect("send HTTP request through the SOCKS tunnel");
        client.shutdown().await.ok();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut response))
            .await
            .expect("HTTP response before timeout")
            .expect("read HTTP response");
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/"),
            "expected an HTTP response proxied through the agent-hosted SOCKS tunnel"
        );

        // Stopping removes the forward and frees the SOCKS listen port.
        assert!(registry.stop("t-socks").await);
        assert_eq!(registry.active_count().await, 0);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match TcpStream::connect(("127.0.0.1", listen_port)).await {
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => break,
                _ if tokio::time::Instant::now() >= deadline => {
                    panic!("agent SOCKS forward still accepting after stop")
                }
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }
}
