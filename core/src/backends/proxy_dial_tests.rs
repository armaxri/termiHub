//! Tests for the outbound proxy dialer (#4867), against in-process mock
//! SOCKS4/SOCKS5/HTTP proxies.

use super::*;
use tokio::io::{duplex, DuplexStream};
use tokio::net::TcpListener;

const PASSWORD: &str = "s3cret-pw";

fn proxy(proxy_type: SshProxyType, user: Option<&str>, password: Option<&str>) -> SshProxyConfig {
    SshProxyConfig {
        proxy_type,
        host: "proxy.test".to_string(),
        port: 1080,
        username: user.map(str::to_string),
        password: password.map(str::to_string),
    }
}

/// Run `establish_tunnel` against a mock proxy `script` on the other end of an
/// in-memory pipe. Returns the client result and the client stream (to check
/// the tunnel carries bytes afterwards).
async fn run<F, Fut>(
    cfg: &SshProxyConfig,
    host: &str,
    port: u16,
    script: F,
) -> (Result<(), SessionError>, DuplexStream)
where
    F: FnOnce(DuplexStream) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (mut client, server) = duplex(64 * 1024);
    let task = tokio::spawn(script(server));
    let res = establish_tunnel(&mut client, cfg, host, port).await;
    task.await.expect("mock proxy task");
    (res, client)
}

async fn read_n(s: &mut DuplexStream, n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    s.read_exact(&mut buf).await.expect("read");
    buf
}

async fn read_to_blank_line(s: &mut DuplexStream) -> String {
    let mut buf = Vec::new();
    while !buf.ends_with(b"\r\n\r\n") {
        buf.push(s.read_u8().await.expect("read"));
    }
    String::from_utf8(buf).expect("utf8")
}

fn err_text(res: Result<(), SessionError>) -> (SessionError, String) {
    let e = res.expect_err("expected an error");
    let text = e.to_string();
    assert!(!text.contains(PASSWORD), "error leaks the password: {text}");
    (e, text)
}

// ── SOCKS5 ─────────────────────────────────────────────────────────

#[tokio::test]
async fn socks5_no_auth_connects_by_domain_and_carries_bytes() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, mut client) = run(&cfg, "target.example", 22, |mut s| async move {
        assert_eq!(read_n(&mut s, 3).await, [5, 1, 0]);
        s.write_all(&[5, 0]).await.unwrap();
        let mut expected = vec![5, 1, 0, 3, 14];
        expected.extend_from_slice(b"target.example");
        expected.extend_from_slice(&22u16.to_be_bytes());
        assert_eq!(read_n(&mut s, expected.len()).await, expected);
        // Success with an IPv4 bound address, then the SSH banner in the
        // same write — none of it may be swallowed by the handshake.
        s.write_all(&[5, 0, 0, 1, 10, 0, 0, 1, 0, 22])
            .await
            .unwrap();
        s.write_all(b"SSH-2.0-mock\r\n").await.unwrap();
    })
    .await;
    res.expect("tunnel established");
    assert_eq!(read_n(&mut client, 14).await, b"SSH-2.0-mock\r\n");
}

#[tokio::test]
async fn socks5_user_password_auth_sends_rfc1929_request() {
    let cfg = proxy(SshProxyType::Socks5, Some("alice"), Some(PASSWORD));
    let (res, _) = run(&cfg, "10.1.2.3", 2222, |mut s| async move {
        assert_eq!(read_n(&mut s, 4).await, [5, 2, 0, 2]);
        s.write_all(&[5, 2]).await.unwrap();
        let mut auth = vec![1, 5];
        auth.extend_from_slice(b"alice");
        auth.push(PASSWORD.len() as u8);
        auth.extend_from_slice(PASSWORD.as_bytes());
        assert_eq!(read_n(&mut s, auth.len()).await, auth);
        s.write_all(&[1, 0]).await.unwrap();
        let mut req = vec![5, 1, 0, 1, 10, 1, 2, 3];
        req.extend_from_slice(&2222u16.to_be_bytes());
        assert_eq!(read_n(&mut s, req.len()).await, req);
        // Domain-typed bound address exercises the variable-length read.
        s.write_all(&[5, 0, 0, 3, 3, b'a', b'b', b'c', 0, 1])
            .await
            .unwrap();
    })
    .await;
    res.expect("tunnel established");
}

#[tokio::test]
async fn socks5_ipv6_target_uses_address_type_4() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, _) = run(&cfg, "[2001:db8::1]", 22, |mut s| async move {
        read_n(&mut s, 3).await;
        s.write_all(&[5, 0]).await.unwrap();
        let head = read_n(&mut s, 4).await;
        assert_eq!(head, [5, 1, 0, 4]);
        let addr = read_n(&mut s, 16).await;
        assert_eq!(
            addr,
            "2001:db8::1"
                .parse::<std::net::Ipv6Addr>()
                .unwrap()
                .octets()
        );
        read_n(&mut s, 2).await;
        let mut reply = vec![5, 0, 0, 4];
        reply.extend_from_slice(&[0u8; 18]);
        s.write_all(&reply).await.unwrap();
    })
    .await;
    res.expect("tunnel established");
}

#[tokio::test]
async fn socks5_auth_failure_fails_closed_without_leaking_the_password() {
    let cfg = proxy(SshProxyType::Socks5, Some("alice"), Some(PASSWORD));
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_n(&mut s, 4).await;
        s.write_all(&[5, 2]).await.unwrap();
        read_n(&mut s, 3 + 5 + PASSWORD.len()).await;
        s.write_all(&[1, 1]).await.unwrap();
    })
    .await;
    let (e, text) = err_text(res);
    assert!(matches!(e, SessionError::SpawnFailed(_)), "{e:?}");
    assert!(text.contains("authentication failed"), "{text}");
}

#[tokio::test]
async fn socks5_proxy_requiring_auth_without_credentials_is_refused() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_n(&mut s, 3).await;
        s.write_all(&[5, 0xFF]).await.unwrap();
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("requires authentication"), "{text}");
}

#[tokio::test]
async fn socks5_unoffered_method_is_refused() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_n(&mut s, 3).await;
        // Username/password was not offered (no credentials configured).
        s.write_all(&[5, 2]).await.unwrap();
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("not offered"), "{text}");
}

#[tokio::test]
async fn socks5_wrong_version_is_refused() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_n(&mut s, 3).await;
        s.write_all(b"HT").await.unwrap();
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("not a SOCKS5 proxy"), "{text}");
}

#[tokio::test]
async fn socks5_connect_failure_is_a_connection_failure() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_n(&mut s, 3).await;
        s.write_all(&[5, 0]).await.unwrap();
        read_n(&mut s, 5 + 14 + 2).await;
        s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
    })
    .await;
    let (e, text) = err_text(res);
    assert!(matches!(e, SessionError::ConnectionFailed(_)), "{e:?}");
    assert!(text.contains("connection refused by the target"), "{text}");
}

#[tokio::test]
async fn socks5_proxy_closing_mid_handshake_is_an_error() {
    let cfg = proxy(SshProxyType::Socks5, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_n(&mut s, 3).await;
        drop(s);
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("closed the connection"), "{text}");
}

// ── SOCKS4 / 4a ────────────────────────────────────────────────────

#[tokio::test]
async fn socks4a_sends_the_host_name_after_the_user_id() {
    let cfg = proxy(SshProxyType::Socks4, Some("bob"), None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        let mut expected = vec![4, 1, 0, 22, 0, 0, 0, 1];
        expected.extend_from_slice(b"bob\0target.example\0");
        assert_eq!(read_n(&mut s, expected.len()).await, expected);
        s.write_all(&[0, 0x5A, 0, 0, 0, 0, 0, 0]).await.unwrap();
    })
    .await;
    res.expect("tunnel established");
}

#[tokio::test]
async fn socks4_ipv4_target_and_rejection() {
    let cfg = proxy(SshProxyType::Socks4, None, None);
    let (res, _) = run(&cfg, "192.0.2.7", 22, |mut s| async move {
        assert_eq!(read_n(&mut s, 9).await, [4, 1, 0, 22, 192, 0, 2, 7, 0]);
        s.write_all(&[0, 0x5B, 0, 0, 0, 0, 0, 0]).await.unwrap();
    })
    .await;
    let (e, _) = err_text(res);
    assert!(matches!(e, SessionError::ConnectionFailed(_)), "{e:?}");
}

#[tokio::test]
async fn socks4_never_sends_a_password() {
    let cfg = proxy(SshProxyType::Socks4, Some("bob"), Some(PASSWORD));
    let (res, _) = run(&cfg, "192.0.2.7", 22, |mut s| async move {
        let req = read_n(&mut s, 12).await;
        assert_eq!(req, [4, 1, 0, 22, 192, 0, 2, 7, b'b', b'o', b'b', 0]);
        s.write_all(&[0, 0x5A, 0, 0, 0, 0, 0, 0]).await.unwrap();
    })
    .await;
    res.expect("tunnel established");
}

#[tokio::test]
async fn socks4_cannot_reach_ipv6() {
    let cfg = proxy(SshProxyType::Socks4, None, None);
    let (res, _) = run(&cfg, "::1", 22, |_s| async move {}).await;
    let (_, text) = err_text(res);
    assert!(text.contains("IPv6"), "{text}");
}

// ── HTTP CONNECT ───────────────────────────────────────────────────

#[tokio::test]
async fn http_connect_succeeds_and_leaves_the_banner_unread() {
    let cfg = proxy(SshProxyType::Http, None, None);
    let (res, mut client) = run(&cfg, "target.example", 22, |mut s| async move {
        let req = read_to_blank_line(&mut s).await;
        assert_eq!(
            req,
            "CONNECT target.example:22 HTTP/1.1\r\nHost: target.example:22\r\n\r\n"
        );
        s.write_all(b"HTTP/1.1 200 Connection established\r\nVia: mock\r\n\r\nSSH-2.0-mock\r\n")
            .await
            .unwrap();
    })
    .await;
    res.expect("tunnel established");
    assert_eq!(read_n(&mut client, 14).await, b"SSH-2.0-mock\r\n");
}

#[tokio::test]
async fn http_connect_sends_basic_proxy_authorization() {
    let cfg = proxy(SshProxyType::Http, Some("alice"), Some(PASSWORD));
    let (res, _) = run(&cfg, "[2001:db8::2]", 2200, |mut s| async move {
        let req = read_to_blank_line(&mut s).await;
        let encoded = data_encoding::BASE64.encode(format!("alice:{PASSWORD}").as_bytes());
        assert_eq!(
            req,
            format!(
                "CONNECT [2001:db8::2]:2200 HTTP/1.1\r\nHost: [2001:db8::2]:2200\r\n\
                 Proxy-Authorization: Basic {encoded}\r\n\r\n"
            )
        );
        s.write_all(b"HTTP/1.0 200 OK\r\n\r\n").await.unwrap();
    })
    .await;
    res.expect("tunnel established");
}

#[tokio::test]
async fn http_407_with_credentials_is_an_auth_failure() {
    let cfg = proxy(SshProxyType::Http, Some("alice"), Some(PASSWORD));
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_to_blank_line(&mut s).await;
        s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .await
            .unwrap();
    })
    .await;
    let (e, text) = err_text(res);
    assert!(matches!(e, SessionError::SpawnFailed(_)), "{e:?}");
    assert!(text.contains("authentication failed"), "{text}");
}

#[tokio::test]
async fn http_407_without_credentials_asks_for_them() {
    let cfg = proxy(SshProxyType::Http, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_to_blank_line(&mut s).await;
        s.write_all(b"HTTP/1.1 407 Nope\r\n\r\n").await.unwrap();
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("requires authentication"), "{text}");
}

#[tokio::test]
async fn http_refusal_quotes_a_sanitised_reason() {
    let cfg = proxy(SshProxyType::Http, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_to_blank_line(&mut s).await;
        s.write_all(b"HTTP/1.1 403 Forbidden\x1b[31m by policy\r\n\r\n")
            .await
            .unwrap();
    })
    .await;
    let (e, text) = err_text(res);
    assert!(matches!(e, SessionError::ConnectionFailed(_)), "{e:?}");
    assert!(text.contains("403 Forbidden[31m by policy"), "{text}");
    assert!(!text.contains('\x1b'), "{text}");
}

#[tokio::test]
async fn http_malformed_status_line_is_refused() {
    for bad in [
        &b"SSH-2.0-not-a-proxy\r\n\r\n"[..],
        b"HTTP/1.1 2000 OK\r\n\r\n",
        b"HTTP/2 200\r\n\r\n",
        b"HTTP/1.1 abc\r\n\r\n",
    ] {
        let cfg = proxy(SshProxyType::Http, None, None);
        let (res, _) = run(&cfg, "target.example", 22, move |mut s| async move {
            read_to_blank_line(&mut s).await;
            s.write_all(bad).await.unwrap();
        })
        .await;
        let (_, text) = err_text(res);
        assert!(text.contains("invalid response"), "{text}");
    }
}

#[tokio::test]
async fn http_oversized_response_headers_are_bounded() {
    let cfg = proxy(SshProxyType::Http, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_to_blank_line(&mut s).await;
        let mut flood = b"HTTP/1.1 200 OK\r\n".to_vec();
        flood.extend(std::iter::repeat_n(
            b'x',
            MAX_HTTP_RESPONSE_HEADER_BYTES * 2,
        ));
        // The client stops reading at the cap; ignore the broken pipe.
        let _ = s.write_all(&flood).await;
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("exceeds"), "{text}");
}

#[tokio::test]
async fn http_eof_before_headers_end_is_an_error() {
    let cfg = proxy(SshProxyType::Http, None, None);
    let (res, _) = run(&cfg, "target.example", 22, |mut s| async move {
        read_to_blank_line(&mut s).await;
        s.write_all(b"HTTP/1.1 200 OK\r\n").await.unwrap();
    })
    .await;
    let (_, text) = err_text(res);
    assert!(text.contains("closed the connection"), "{text}");
}

#[tokio::test]
async fn http_rejects_header_injection_in_host_and_user() {
    let cfg = proxy(SshProxyType::Http, None, None);
    let (res, _) = run(&cfg, "evil\r\nX-Injected: 1", 22, |_s| async move {}).await;
    assert!(
        matches!(res, Err(SessionError::InvalidConfig(_))),
        "{res:?}"
    );

    let cfg = proxy(SshProxyType::Http, Some("al:ice"), Some(PASSWORD));
    let (res, _) = run(&cfg, "target.example", 22, |_s| async move {}).await;
    assert!(
        matches!(res, Err(SessionError::InvalidConfig(_))),
        "{res:?}"
    );
}

// ── Config / end to end ────────────────────────────────────────────

#[test]
fn proxy_debug_output_redacts_the_password() {
    let cfg = proxy(SshProxyType::Http, Some("alice"), Some(PASSWORD));
    let dbg = format!("{cfg:?}");
    assert!(!dbg.contains(PASSWORD), "{dbg}");
    assert!(dbg.contains("<redacted>"), "{dbg}");
}

#[tokio::test]
async fn connect_tcp_dials_through_a_real_socks5_proxy() {
    // Target: echoes one line back.
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_port = target.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = target.accept().await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        s.write_all(&buf).await.unwrap();
    });

    // Proxy: SOCKS5 no-auth, IPv4 CONNECT only, then splices to the target.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut c, _) = listener.accept().await.unwrap();
        let mut greet = [0u8; 3];
        c.read_exact(&mut greet).await.unwrap();
        c.write_all(&[5, 0]).await.unwrap();
        let mut req = [0u8; 10];
        c.read_exact(&mut req).await.unwrap();
        assert_eq!(&req[..4], &[5, 1, 0, 1]);
        let port = u16::from_be_bytes([req[8], req[9]]);
        let mut upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        c.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .unwrap();
        let _ = tokio::io::copy_bidirectional(&mut c, &mut upstream).await;
    });

    let cfg = SshProxyConfig {
        proxy_type: SshProxyType::Socks5,
        host: "127.0.0.1".to_string(),
        port: proxy_port,
        username: None,
        password: None,
    };
    let mut stream = connect_tcp("127.0.0.1", target_port, Some(&cfg))
        .await
        .expect("connected through proxy");
    stream.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");
}

#[tokio::test]
async fn connect_tcp_reports_an_unreachable_proxy() {
    // Bind then drop to get a port nothing listens on.
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let cfg = SshProxyConfig {
        proxy_type: SshProxyType::Http,
        host: "127.0.0.1".to_string(),
        port,
        username: Some("alice".to_string()),
        password: Some(PASSWORD.to_string()),
    };
    let err = connect_tcp("target.example", 22, Some(&cfg))
        .await
        .expect_err("proxy is down");
    let text = err.to_string();
    assert!(matches!(err, SessionError::ConnectionFailed(_)), "{err:?}");
    assert!(text.contains("Could not reach the HTTP proxy"), "{text}");
    assert!(!text.contains(PASSWORD), "{text}");
}
