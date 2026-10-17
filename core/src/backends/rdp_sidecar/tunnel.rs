//! The RDP connection's optional SSH tunnel (#4865).
//!
//! The IronRDP sidecar only ever dials a TCP address, so the tunnel runs here in
//! the host process, on the shared SSH local forward
//! ([`crate::backends::ssh_tunnel`]) VNC uses: the SSH gateway is authenticated
//! — its host key checked through the normal SSH trust flow — a loopback port
//! is bound, and the sidecar's connect payload is pointed at that port. The
//! gateway credentials stay in this process: [`SshTunnelSettings`] is parsed
//! separately from [`RdpConfig`], which crosses the sidecar's IPC boundary.
//!
//! One sidecar process is one RDP connection: the Deactivation-Reactivation
//! Sequence of a resize (#4845, #4859) runs over the same TCP stream, so the
//! tunnel's single forwarded connection carries the whole session. A reconnect
//! is a fresh `connect`, which opens a fresh tunnel.
//!
//! A direct connection's outbound proxy (#4899, [`super::proxy`]) is offered
//! to the sidecar the same way: [`open`] returns whichever loopback forward the
//! settings ask for as one [`RdpForward`].

use crate::config::SshProxyConfig;
use crate::connection::graphical_ssh_tunnel::SshTunnelSettings;
use crate::errors::SessionError;

use super::config::RdpConfig;
use super::proxy::ProxyForward;

/// The live tunnel a tunnelled RDP session keeps for its lifetime.
#[cfg(feature = "ssh")]
pub(super) type RdpTunnel = crate::backends::ssh_tunnel::SshTunnel;

/// Without the `ssh` feature (the sidecar's own slim core build) no tunnel can
/// exist; [`open`] refuses a tunnelled connection instead.
#[cfg(not(feature = "ssh"))]
#[derive(Debug)]
pub(super) enum RdpTunnel {}

#[cfg(not(feature = "ssh"))]
impl RdpTunnel {
    pub(super) fn close_with(&self, _parent: &tokio_util::sync::CancellationToken) {
        match *self {}
    }
}

/// The loopback forward a session's sidecar dials instead of the server: the
/// SSH tunnel (#4865) or the direct connection's outbound proxy (#4899). Kept
/// alive for the session and torn down with it.
#[derive(Debug)]
pub(super) enum RdpForward {
    /// The SSH tunnel's local forward.
    Ssh(RdpTunnel),
    /// The outbound proxy's loopback forward.
    Proxy(ProxyForward),
}

impl RdpForward {
    /// Tear the forward down once `parent` fires (teardown, or the sidecar
    /// exiting on its own), as well as on drop.
    pub(super) fn close_with(&self, parent: &tokio_util::sync::CancellationToken) {
        match self {
            Self::Ssh(tunnel) => tunnel.close_with(parent),
            Self::Proxy(forward) => forward.close_with(parent),
        }
    }
}

/// Read the SSH Tunnel rows of `settings`.
pub(super) fn tunnel_settings(
    settings: &serde_json::Value,
) -> Result<SshTunnelSettings, SessionError> {
    SshTunnelSettings::from_settings(settings)
        .map_err(|e| SessionError::InvalidConfig(format!("Invalid RDP SSH tunnel settings: {e}")))
}

/// Point the sidecar at the loopback end of a forward on `local_port`: the
/// sidecar dials `127.0.0.1:<local_port>` while TLS SNI and CredSSP keep
/// naming the real server (see [`RdpConfig::server_name`]).
#[cfg(any(feature = "ssh", feature = "proxy-dial", test))]
pub(super) fn point_at_loopback(cfg: &mut RdpConfig, local_port: u16) {
    if cfg.tls_server_name.is_none() {
        cfg.tls_server_name = Some(cfg.host.clone());
    }
    cfg.host = "127.0.0.1".to_string();
    cfg.port = local_port;
}

/// Open the forward the settings ask for to `cfg`'s server and repoint `cfg`
/// at it: the SSH tunnel when `tunnel` is on, else the direct connection's
/// outbound `proxy` (see [`super::proxy::direct_proxy`]). `None` (and `cfg`
/// untouched) for a plain direct connection. On an error `cfg` is untouched.
pub(super) async fn open(
    tunnel: &SshTunnelSettings,
    proxy: Option<&SshProxyConfig>,
    cfg: &mut RdpConfig,
) -> Result<Option<RdpForward>, SessionError> {
    if tunnel.use_ssh_tunnel {
        return open_enabled(tunnel, cfg)
            .await
            .map(|t| Some(RdpForward::Ssh(t)));
    }
    match proxy {
        Some(proxy) => open_proxy(proxy, cfg)
            .await
            .map(|f| Some(RdpForward::Proxy(f))),
        None => Ok(None),
    }
}

#[cfg(feature = "proxy-dial")]
async fn open_proxy(
    proxy: &SshProxyConfig,
    cfg: &mut RdpConfig,
) -> Result<ProxyForward, SessionError> {
    let forward = ProxyForward::establish(
        proxy,
        &cfg.host,
        cfg.effective_port(),
        cfg.connect_timeout(),
    )
    .await?;
    point_at_loopback(cfg, forward.local_port);
    Ok(forward)
}

#[cfg(not(feature = "proxy-dial"))]
async fn open_proxy(
    _proxy: &SshProxyConfig,
    _cfg: &mut RdpConfig,
) -> Result<ProxyForward, SessionError> {
    Err(SessionError::InvalidConfig(
        "Connection proxies are not available in this build".to_string(),
    ))
}

#[cfg(feature = "ssh")]
async fn open_enabled(
    tunnel: &SshTunnelSettings,
    cfg: &mut RdpConfig,
) -> Result<RdpTunnel, SessionError> {
    let live =
        RdpTunnel::establish(&tunnel.ssh_config(), cfg.host.clone(), cfg.effective_port()).await?;
    point_at_loopback(cfg, live.local_port);
    Ok(live)
}

#[cfg(not(feature = "ssh"))]
async fn open_enabled(
    _tunnel: &SshTunnelSettings,
    _cfg: &mut RdpConfig,
) -> Result<RdpTunnel, SessionError> {
    Err(SessionError::InvalidConfig(
        "SSH tunnels are not available in this build".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_at_loopback_dials_loopback_but_keeps_the_server_name() {
        let mut cfg = RdpConfig {
            host: "desk.corp".to_string(),
            port: 3390,
            ..RdpConfig::default()
        };
        point_at_loopback(&mut cfg, 50123);
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.effective_port(), 50123);
        assert_eq!(cfg.server_name(), "desk.corp");
    }

    #[test]
    fn point_at_loopback_keeps_an_explicit_server_name() {
        let mut cfg = RdpConfig {
            host: "10.0.0.5".to_string(),
            tls_server_name: Some("desk.corp".to_string()),
            ..RdpConfig::default()
        };
        point_at_loopback(&mut cfg, 1);
        assert_eq!(cfg.server_name(), "desk.corp");
    }

    #[tokio::test]
    async fn a_direct_connection_opens_no_tunnel_and_keeps_its_target() {
        let mut cfg = RdpConfig {
            host: "desk".to_string(),
            ..RdpConfig::default()
        };
        let before = cfg.clone();
        let tunnel = open(&SshTunnelSettings::default(), None, &mut cfg)
            .await
            .unwrap();
        assert!(tunnel.is_none());
        assert_eq!(cfg, before);
    }

    #[tokio::test]
    async fn a_tunnel_without_an_ssh_host_is_refused_and_keeps_the_target() {
        let mut cfg = RdpConfig {
            host: "desk".to_string(),
            ..RdpConfig::default()
        };
        let settings = SshTunnelSettings {
            use_ssh_tunnel: true,
            ..SshTunnelSettings::default()
        };
        let err = open(&settings, None, &mut cfg).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)), "{err:?}");
        assert_eq!(cfg.host, "desk", "a failed tunnel leaves the target alone");
    }

    #[test]
    fn tunnel_settings_reject_a_malformed_row() {
        let err = tunnel_settings(&serde_json::json!({ "sshPort": "not-a-port" })).unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }
}
