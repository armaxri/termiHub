//! Tests for a direct RDP connection's outbound proxy (#4899): the Proxy rows
//! are read apart from the sidecar's payload and only without the SSH tunnel,
//! and — with the proxy dialer — the sidecar is handed a loopback forward that
//! a mock proxy carries to the server.

use super::*;
use crate::config::SshProxyType;
use serde_json::json;

fn tunnel_on() -> SshTunnelSettings {
    SshTunnelSettings {
        use_ssh_tunnel: true,
        ..SshTunnelSettings::default()
    }
}

#[test]
fn no_direct_proxy_by_default_or_for_none() {
    let off = SshTunnelSettings::default();
    assert!(direct_proxy(&json!({"host": "desk"}), &off).is_none());
    assert!(direct_proxy(&json!({"proxyType": "none", "proxyHost": "p"}), &off).is_none());
    // A proxy type without a host is no proxy.
    assert!(direct_proxy(&json!({"proxyType": "socks5"}), &off).is_none());
}

#[test]
fn direct_proxy_reads_the_proxy_rows_only_without_the_tunnel() {
    let settings = json!({
        "host": "desk",
        "proxyType": "http", "proxyHost": "proxy.corp", "proxyPort": 3128,
        "proxyUsername": "carol", "proxyPassword": "direct-pw",
        "sshProxyType": "socks5", "sshProxyHost": "tunnel-proxy",
    });
    let p = direct_proxy(&settings, &SshTunnelSettings::default()).expect("proxy");
    assert_eq!(p.proxy_type, SshProxyType::Http);
    assert_eq!(p.host, "proxy.corp");
    assert_eq!(p.port, 3128);
    assert_eq!(p.username.as_deref(), Some("carol"));
    assert_eq!(p.password.as_deref(), Some("direct-pw"));
    // With the tunnel on, its own proxy rows reach the SSH hop instead.
    assert!(direct_proxy(&settings, &tunnel_on()).is_none());
}

#[cfg(feature = "proxy-dial")]
mod forward {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::backends::rdp_sidecar::config::RdpConfig;
    use crate::backends::rdp_sidecar::tunnel::{open, RdpForward};
    use crate::config::SshProxyConfig;
    use crate::errors::SessionError;

    const PROXY_PASSWORD: &str = "proxy-s3cret";
    /// The first bytes of an X.224 Connection Request, standing in for the
    /// sidecar's opening of the RDP handshake.
    const CLIENT_HELLO: &[u8] = &[0x03, 0x00, 0x00, 0x13];
    /// The server's answer, carried back through the proxy.
    const SERVER_HELLO: &[u8] = &[0x03, 0x00, 0x00, 0x0b];

    fn proxy(proxy_type: SshProxyType, port: u16, user: Option<&str>) -> SshProxyConfig {
        SshProxyConfig {
            proxy_type,
            host: "127.0.0.1".to_string(),
            port,
            username: user.map(str::to_string),
            password: user.map(|_| PROXY_PASSWORD.to_string()),
        }
    }

    fn desk() -> RdpConfig {
        RdpConfig {
            // Only resolvable at the proxy: never resolved locally.
            host: "desk.corp".to_string(),
            port: 3390,
            ..RdpConfig::default()
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

    async fn listener() -> (TcpListener, u16) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    /// A SOCKS5 proxy that authenticates `carol`, opens the tunnel to
    /// `desk.corp:3390` and then plays the RDP server: it expects
    /// [`CLIENT_HELLO`], answers [`SERVER_HELLO`] and returns the stream.
    async fn socks5_server(l: TcpListener) -> TcpStream {
        let (mut s, _) = l.accept().await.unwrap();
        assert_eq!(read_vec(&mut s, 4).await, [5, 2, 0, 2]);
        s.write_all(&[5, 2]).await.unwrap();
        let mut auth = vec![1, 5];
        auth.extend_from_slice(b"carol");
        auth.push(PROXY_PASSWORD.len() as u8);
        auth.extend_from_slice(PROXY_PASSWORD.as_bytes());
        assert_eq!(read_vec(&mut s, auth.len()).await, auth);
        s.write_all(&[1, 0]).await.unwrap();
        let mut req = vec![5, 1, 0, 3, 9];
        req.extend_from_slice(b"desk.corp");
        req.extend_from_slice(&3390u16.to_be_bytes());
        assert_eq!(read_vec(&mut s, req.len()).await, req);
        s.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .unwrap();
        assert_eq!(read_vec(&mut s, CLIENT_HELLO.len()).await, CLIENT_HELLO);
        s.write_all(SERVER_HELLO).await.unwrap();
        s
    }

    fn local_port(forward: &RdpForward) -> u16 {
        match forward {
            RdpForward::Proxy(f) => f.local_port,
            RdpForward::Ssh(_) => panic!("expected the proxy forward"),
        }
    }

    #[tokio::test]
    async fn the_sidecar_dials_a_loopback_forward_through_a_socks5_proxy() {
        let (l, proxy_port) = listener().await;
        let server = tokio::spawn(socks5_server(l));
        let mut cfg = desk();
        let p = proxy(SshProxyType::Socks5, proxy_port, Some("carol"));
        let forward = open(&SshTunnelSettings::default(), Some(&p), &mut cfg)
            .await
            .expect("proxied open")
            .expect("a forward");
        let port = local_port(&forward);

        // The sidecar is pointed at the loopback forward, while TLS SNI and
        // CredSSP keep naming the real server.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.effective_port(), port);
        assert_eq!(cfg.server_name(), "desk.corp");

        // Bytes flow both ways through the forward and the proxy.
        let mut sidecar = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        sidecar.write_all(CLIENT_HELLO).await.unwrap();
        assert_eq!(
            read_vec(&mut sidecar, SERVER_HELLO.len()).await,
            SERVER_HELLO
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn the_proxy_credentials_never_reach_the_sidecar_payload() {
        let (l, proxy_port) = listener().await;
        let server = tokio::spawn(async move {
            let _keep = socks5_server(l).await;
        });
        let p = proxy(SshProxyType::Socks5, proxy_port, Some("carol"));
        let settings = json!({
            "host": "desk.corp", "port": 3390,
            "proxyType": "socks5", "proxyHost": "127.0.0.1", "proxyPort": proxy_port,
            "proxyUsername": "carol", "proxyPassword": PROXY_PASSWORD,
        });
        // The payload is parsed from the very settings that carry the proxy.
        let mut cfg = RdpConfig::from_settings(settings).unwrap();
        let forward = open(&SshTunnelSettings::default(), Some(&p), &mut cfg)
            .await
            .expect("proxied open")
            .expect("a forward");
        let wire = serde_json::to_string(&cfg).unwrap();
        for leaked in [PROXY_PASSWORD, "carol", "proxyType", "proxyHost"] {
            assert!(!wire.contains(leaked), "{leaked}: {wire}");
        }
        // Complete the mock's handshake so it exits cleanly.
        let mut sidecar = TcpStream::connect(("127.0.0.1", local_port(&forward)))
            .await
            .unwrap();
        sidecar.write_all(CLIENT_HELLO).await.unwrap();
        read_vec(&mut sidecar, SERVER_HELLO.len()).await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn refused_proxy_credentials_fail_before_any_forward_is_bound() {
        let (l, proxy_port) = listener().await;
        let mock = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let head = read_to_blank_line(&mut s).await;
            assert!(
                head.starts_with("CONNECT desk.corp:3390 HTTP/1.1\r\n"),
                "{head}"
            );
            s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });
        let mut cfg = desk();
        let before = cfg.clone();
        let p = proxy(SshProxyType::Http, proxy_port, Some("carol"));
        let err = open(&SshTunnelSettings::default(), Some(&p), &mut cfg)
            .await
            .expect_err("407");
        let text = err.to_string();
        assert!(text.contains("proxy authentication failed"), "{text}");
        assert!(!text.contains(PROXY_PASSWORD), "leaks the password: {text}");
        assert_eq!(cfg, before, "a failed proxy leaves the target alone");
        mock.await.unwrap();
    }

    #[tokio::test]
    async fn an_unreachable_proxy_is_named_in_the_error() {
        let port = listener().await.1; // dropped: closed port
        let mut cfg = desk();
        let p = proxy(SshProxyType::Socks5, port, None);
        let err = open(&SshTunnelSettings::default(), Some(&p), &mut cfg)
            .await
            .expect_err("closed proxy port");
        assert!(matches!(err, SessionError::ConnectionFailed(_)), "{err:?}");
        assert!(err.to_string().contains("SOCKS5 proxy"), "{err}");
        assert_eq!(cfg.host, "desk.corp");
    }

    #[tokio::test]
    async fn a_silent_proxy_is_bounded_by_the_connect_timeout() {
        let (l, proxy_port) = listener().await;
        let mock = tokio::spawn(async move {
            // Accept, then never answer the greeting.
            let (s, _) = l.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(s);
        });
        let mut cfg = RdpConfig {
            connect_timeout_secs: Some(1),
            ..desk()
        };
        let p = proxy(SshProxyType::Socks5, proxy_port, None);
        let err = open(&SshTunnelSettings::default(), Some(&p), &mut cfg)
            .await
            .expect_err("timeout");
        assert!(matches!(err, SessionError::ConnectionFailed(_)), "{err:?}");
        assert!(err.to_string().contains("Timed out"), "{err}");
        mock.abort();
    }

    #[tokio::test]
    async fn the_tunnel_ignores_the_direct_proxy() {
        // With the tunnel on, the proxy is never dialed: the tunnel's own
        // validation (no SSH host) fails first.
        let mut cfg = desk();
        let p = proxy(SshProxyType::Socks5, 1, None);
        let err = open(&tunnel_on(), Some(&p), &mut cfg)
            .await
            .expect_err("no ssh host");
        assert!(matches!(err, SessionError::InvalidConfig(_)), "{err:?}");
    }

    /// Open a forward through a no-auth SOCKS5 mock whose server end is
    /// returned once the tunnel is up.
    async fn open_plain_forward() -> (ProxyForward, tokio::task::JoinHandle<TcpStream>) {
        let (l, proxy_port) = listener().await;
        let server = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            assert_eq!(read_vec(&mut s, 3).await, [5, 1, 0]);
            s.write_all(&[5, 0]).await.unwrap();
            let mut req = vec![5, 1, 0, 3, 9];
            req.extend_from_slice(b"desk.corp");
            req.extend_from_slice(&3390u16.to_be_bytes());
            assert_eq!(read_vec(&mut s, req.len()).await, req);
            s.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                .await
                .unwrap();
            s
        });
        let p = proxy(SshProxyType::Socks5, proxy_port, None);
        let forward = ProxyForward::establish(&p, "desk.corp", 3390, Duration::from_secs(5))
            .await
            .expect("forward");
        (forward, server)
    }

    /// The server end sees EOF within a bounded wait.
    async fn assert_closed(server: &mut TcpStream) {
        let mut buf = [0u8; 1];
        let n = tokio::time::timeout(Duration::from_secs(5), server.read(&mut buf))
            .await
            .expect("the proxied connection must close")
            .unwrap_or(0);
        assert_eq!(n, 0, "expected EOF");
    }

    #[tokio::test]
    async fn the_session_ending_closes_the_proxied_connection() {
        // Teardown or the sidecar exiting fires the session's token.
        let (forward, server) = open_plain_forward().await;
        let _sidecar = TcpStream::connect(("127.0.0.1", forward.local_port))
            .await
            .unwrap();
        let mut server = server.await.unwrap();
        let session = CancellationToken::new();
        forward.close_with(&session);
        session.cancel();
        assert_closed(&mut server).await;
        assert!(forward.is_closed());
    }

    #[tokio::test]
    async fn dropping_the_forward_closes_the_proxied_connection() {
        // A reconnect drops the old runtime (and its forward) before dialing a
        // fresh one.
        let (forward, server) = open_plain_forward().await;
        let mut server = server.await.unwrap();
        drop(forward);
        assert_closed(&mut server).await;
    }

    #[tokio::test]
    async fn the_forward_accepts_only_the_sidecar() {
        let (forward, server) = open_plain_forward().await;
        let port = forward.local_port;
        let mut sidecar = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut server = server.await.unwrap();
        // The first connection is carried through.
        sidecar.write_all(CLIENT_HELLO).await.unwrap();
        assert_eq!(
            read_vec(&mut server, CLIENT_HELLO.len()).await,
            CLIENT_HELLO
        );
        // The listener is gone: a second local client cannot ride the proxy.
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
        drop(forward);
    }
}
