//! A direct RDP connection's optional outbound proxy (#4899).
//!
//! The IronRDP sidecar only ever dials a TCP address, so — exactly like the SSH
//! tunnel ([`super::tunnel`]) — the proxy runs here in the host process: the
//! **Proxy** group's SOCKS4/SOCKS5/HTTP proxy is dialed through the shared
//! [`crate::backends::proxy_dial`] dialer, a loopback port is bound, and the
//! sidecar's connect payload is pointed at that port. The proxy credentials
//! stay in this process: the Proxy rows are parsed separately from
//! [`RdpConfig`](super::config::RdpConfig), which crosses the sidecar's IPC
//! boundary, so the proxy password never reaches the sidecar.
//!
//! The proxy is dialed **before** the loopback port is bound, so an unreachable
//! proxy or refused credentials fail the connect before a sidecar is spawned.
//! One sidecar process is one RDP connection, so the forward carries a single
//! connection; a reconnect is a fresh `connect`, which dials a fresh one.

use crate::config::SshProxyConfig;
use crate::connection::graphical_ssh_tunnel::SshTunnelSettings;
use crate::connection::proxy_settings::{parse_proxy_with_keys, DIRECT_PROXY_KEYS};

/// The direct connection's proxy from the **Proxy** group's rows; `None` for
/// no proxy, or with the SSH tunnel on — the tunnel's own proxy rows then reach
/// its SSH hop, and the RDP server is reached through the tunnel.
pub(super) fn direct_proxy(
    settings: &serde_json::Value,
    tunnel: &SshTunnelSettings,
) -> Option<SshProxyConfig> {
    if tunnel.use_ssh_tunnel {
        return None;
    }
    parse_proxy_with_keys(settings, &DIRECT_PROXY_KEYS)
}

/// The live loopback forward a proxied RDP session keeps for its lifetime.
#[cfg(feature = "proxy-dial")]
pub(super) use enabled::ProxyForward;

/// Without the proxy dialer (the sidecar's own slim core build) no forward can
/// exist; [`super::tunnel::open`] refuses a proxied connection instead.
#[cfg(not(feature = "proxy-dial"))]
#[derive(Debug)]
pub(super) enum ProxyForward {}

#[cfg(not(feature = "proxy-dial"))]
impl ProxyForward {
    pub(super) fn close_with(&self, _parent: &tokio_util::sync::CancellationToken) {
        match *self {}
    }
}

#[cfg(feature = "proxy-dial")]
mod enabled {
    use std::time::Duration;

    use tokio::io::copy_bidirectional;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_util::sync::CancellationToken;
    use tracing::{debug, warn};

    use crate::backends::proxy_dial::connect_tcp;
    use crate::config::SshProxyConfig;
    use crate::errors::SessionError;

    /// A connection to the RDP server through an outbound proxy, offered to the
    /// sidecar on a loopback port.
    ///
    /// Dropping it — or the parent token given to [`close_with`] firing —
    /// cancels the forwarder, which closes both the loopback connection and
    /// the proxied one.
    ///
    /// [`close_with`]: Self::close_with
    pub struct ProxyForward {
        /// Loopback `127.0.0.1:<port>` the sidecar connects to.
        pub local_port: u16,
        cancel: CancellationToken,
    }

    impl std::fmt::Debug for ProxyForward {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("ProxyForward")
                .field("local_port", &self.local_port)
                .field("cancelled", &self.cancel.is_cancelled())
                .finish_non_exhaustive()
        }
    }

    impl ProxyForward {
        /// Dial `target_host:target_port` through `proxy` — bounded by
        /// `timeout` — then bind the loopback port the sidecar dials.
        pub async fn establish(
            proxy: &SshProxyConfig,
            target_host: &str,
            target_port: u16,
            timeout: Duration,
        ) -> Result<Self, SessionError> {
            let remote =
                tokio::time::timeout(timeout, connect_tcp(target_host, target_port, Some(proxy)))
                    .await
                    .map_err(|_| {
                        SessionError::ConnectionFailed(format!(
                            "Timed out after {}s connecting through the {} proxy {}:{}",
                            timeout.as_secs(),
                            proxy.proxy_type.label(),
                            proxy.host,
                            proxy.port
                        ))
                    })??;

            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
                SessionError::SpawnFailed(format!("proxy forward listener bind failed: {e}"))
            })?;
            let local_port = listener
                .local_addr()
                .map_err(|e| {
                    SessionError::SpawnFailed(format!("proxy forward listener addr failed: {e}"))
                })?
                .port();

            let cancel = CancellationToken::new();
            tokio::spawn(run_forwarder(listener, remote, cancel.clone()));
            Ok(Self { local_port, cancel })
        }

        /// Tear the forward down once `parent` fires, as well as on drop — so a
        /// session that ends on its own (the sidecar exiting) closes the proxied
        /// connection without waiting for its owner to be dropped.
        pub fn close_with(&self, parent: &CancellationToken) {
            let parent = parent.clone();
            let cancel = self.cancel.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = parent.cancelled() => cancel.cancel(),
                    _ = cancel.cancelled() => {}
                }
            });
        }

        /// Whether the forward has been torn down.
        #[cfg(test)]
        pub fn is_closed(&self) -> bool {
            self.cancel.is_cancelled()
        }
    }

    impl Drop for ProxyForward {
        fn drop(&mut self) {
            self.cancel.cancel();
        }
    }

    /// Accept the sidecar's single loopback connection and pump it over the
    /// proxied `remote` stream until either side closes or the forward is
    /// cancelled.
    async fn run_forwarder(
        listener: TcpListener,
        mut remote: TcpStream,
        cancel: CancellationToken,
    ) {
        let mut local = tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((sock, _)) => sock,
                Err(e) => {
                    warn!(error = %e, "rdp proxy forward accept failed");
                    return;
                }
            },
        };
        // One client per forward: stop listening so nothing else on this
        // computer can ride the proxied connection.
        drop(listener);

        tokio::select! {
            _ = cancel.cancelled() => {}
            result = copy_bidirectional(&mut local, &mut remote) => {
                if let Err(e) = result {
                    debug!(error = %e, "rdp proxy forward ended");
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
