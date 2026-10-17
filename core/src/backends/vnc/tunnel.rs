//! The VNC transport: a direct TCP connect — optionally through the **Proxy**
//! group's outbound SOCKS/HTTP proxy (#4897) — or one through the shared SSH
//! local forward ([`crate::backends::ssh_tunnel`]) when the connection editor's
//! **SSH Tunnel** group is enabled.

use tokio::net::TcpStream;

pub use crate::backends::ssh_tunnel::SshTunnel;
use crate::errors::SessionError;

use super::config::VncConfig;

/// Connect the RFB transport for `cfg`, either directly or through an SSH tunnel.
///
/// Returns the connected [`TcpStream`] plus an optional [`SshTunnel`] guard that
/// must be kept alive for the lifetime of the session (dropping it closes the
/// tunnel).
pub async fn connect_transport(
    cfg: &VncConfig,
) -> Result<(TcpStream, Option<SshTunnel>), SessionError> {
    let host = cfg.host.clone();
    let port = cfg.effective_port();

    if cfg.use_ssh_tunnel {
        // Password, key file (with an optional passphrase), or ssh-agent —
        // chosen by the editor's SSH-tunnel "SSH Auth Method" field (#1714).
        let tunnel = SshTunnel::establish(&cfg.tunnel_ssh_config(), host, port).await?;
        let stream = TcpStream::connect(("127.0.0.1", tunnel.local_port))
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("tunnel local connect failed: {e}")))?;
        Ok((stream, Some(tunnel)))
    } else if let Some(proxy) = cfg.direct_proxy() {
        // The proxy opens the tunnel to the VNC server; the RFB handshake (and
        // any VeNCrypt TLS) then runs end to end over it (#4897).
        let stream = crate::backends::proxy_dial::connect_tcp(&host, port, Some(proxy)).await?;
        Ok((stream, None))
    } else {
        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("VNC connect failed: {e}")))?;
        Ok((stream, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tunnel_without_ssh_host_is_invalid_config() {
        let cfg = VncConfig {
            use_ssh_tunnel: true,
            ..VncConfig::default()
        };
        let err = connect_transport(&cfg).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn direct_transport_connect_error_is_surfaced() {
        // Port 1 with no tunnel resolves to an OS-refused connect, exercising the
        // direct (non-tunnel) error path deterministically.
        let cfg = VncConfig {
            host: "127.0.0.1".to_string(),
            port: 1, // privileged/closed on the test host → connect fails fast
            ..VncConfig::default()
        };
        let result = connect_transport(&cfg).await;
        assert!(result.is_err());
    }

    // --- Direct connection through an outbound proxy (#4897) ---

    use crate::config::{SshProxyConfig, SshProxyType};
    use crate::connection::proxy_settings::DirectProxy;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const PROXY_PASSWORD: &str = "proxy-s3cret";
    const RFB_VERSION: &[u8] = b"RFB 003.008\n";

    fn proxied(proxy_type: SshProxyType, proxy_port: u16, user: Option<&str>) -> VncConfig {
        VncConfig {
            // Only resolvable at the proxy: the dial must never resolve it locally.
            host: "vnc.internal".to_string(),
            port: 5901,
            proxy: DirectProxy(Some(SshProxyConfig {
                proxy_type,
                host: "127.0.0.1".to_string(),
                port: proxy_port,
                username: user.map(str::to_string),
                password: user.map(|_| PROXY_PASSWORD.to_string()),
            })),
            ..VncConfig::default()
        }
    }

    async fn read_vec(s: &mut TcpStream, n: usize) -> Vec<u8> {
        let mut buf = vec![0u8; n];
        s.read_exact(&mut buf).await.expect("read");
        buf
    }

    async fn read_to_blank_line(s: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        while !buf.ends_with(b"\r\n\r\n") {
            buf.push(s.read_u8().await.expect("read"));
        }
        String::from_utf8(buf).expect("utf8")
    }

    #[tokio::test]
    async fn direct_connection_dials_through_a_socks5_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let mock = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // Greeting offers no-auth and username/password.
            assert_eq!(read_vec(&mut s, 4).await, [5, 2, 0, 2]);
            s.write_all(&[5, 2]).await.unwrap();
            let mut auth = vec![1, 5];
            auth.extend_from_slice(b"carol");
            auth.push(PROXY_PASSWORD.len() as u8);
            auth.extend_from_slice(PROXY_PASSWORD.as_bytes());
            assert_eq!(read_vec(&mut s, auth.len()).await, auth);
            s.write_all(&[1, 0]).await.unwrap();
            // CONNECT to the VNC server by name, resolved at the proxy.
            let mut req = vec![5, 1, 0, 3, 12];
            req.extend_from_slice(b"vnc.internal");
            req.extend_from_slice(&5901u16.to_be_bytes());
            assert_eq!(read_vec(&mut s, req.len()).await, req);
            s.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                .await
                .unwrap();
            // The server's RFB greeting flows through the tunnel.
            s.write_all(RFB_VERSION).await.unwrap();
        });
        let cfg = proxied(SshProxyType::Socks5, proxy_port, Some("carol"));
        let (mut stream, tunnel) = connect_transport(&cfg).await.expect("proxied connect");
        assert!(tunnel.is_none());
        assert_eq!(read_vec(&mut stream, RFB_VERSION.len()).await, RFB_VERSION);
        mock.await.unwrap();
    }

    #[tokio::test]
    async fn direct_connection_dials_through_an_http_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let mock = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let head = read_to_blank_line(&mut s).await;
            assert!(
                head.starts_with("CONNECT vnc.internal:5901 HTTP/1.1\r\n"),
                "{head}"
            );
            assert!(!head.contains("Proxy-Authorization"), "{head}");
            // The RFB greeting follows the response head in the same write.
            let mut reply = b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec();
            reply.extend_from_slice(RFB_VERSION);
            s.write_all(&reply).await.unwrap();
        });
        let cfg = proxied(SshProxyType::Http, proxy_port, None);
        let (mut stream, _) = connect_transport(&cfg).await.expect("proxied connect");
        // Not a byte of the greeting is lost to the proxy handshake.
        assert_eq!(read_vec(&mut stream, RFB_VERSION.len()).await, RFB_VERSION);
        mock.await.unwrap();
    }

    #[tokio::test]
    async fn refused_proxy_credentials_fail_without_leaking_the_password() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let mock = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            read_to_blank_line(&mut s).await;
            s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });
        let cfg = proxied(SshProxyType::Http, proxy_port, Some("carol"));
        let err = connect_transport(&cfg).await.expect_err("407");
        let text = err.to_string();
        assert!(text.contains("proxy authentication failed"), "{text}");
        assert!(
            !text.contains(PROXY_PASSWORD),
            "error leaks the password: {text}"
        );
        mock.await.unwrap();
    }

    #[tokio::test]
    async fn unreachable_proxy_is_named_in_the_error() {
        // Bind then drop a listener: its port is (almost certainly) closed.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let cfg = proxied(SshProxyType::Socks5, port, None);
        let err = connect_transport(&cfg)
            .await
            .expect_err("closed proxy port");
        assert!(matches!(err, SessionError::ConnectionFailed(_)), "{err:?}");
        assert!(err.to_string().contains("SOCKS5 proxy"), "{err}");
    }

    #[tokio::test]
    async fn tunnel_ignores_the_direct_proxy() {
        // With the tunnel on, the direct proxy is never dialed: the tunnel's
        // own validation (no SSH host) fails first.
        let cfg = VncConfig {
            use_ssh_tunnel: true,
            ..proxied(SshProxyType::Socks5, 1, None)
        };
        let err = connect_transport(&cfg).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)), "{err:?}");
    }
}
