//! Outbound connection proxies (#4867, #4897).
//!
//! Dials a TCP stream through a SOCKS4/4a, SOCKS5 (RFC 1928, username/password
//! auth per RFC 1929) or HTTP `CONNECT` proxy — the equivalent of OpenSSH's
//! `ProxyCommand nc -X …`. The SSH backend dials its session (or its first jump
//! host) this way, and a direct VNC connection its RFB stream (#4897). The proxy
//! only carries bytes: the protocol handshake — for SSH, with it host-key
//! verification — still runs end to end against the **target** host over the
//! returned stream.
//!
//! Every reply is validated strictly and read with bounded lengths. The HTTP
//! response is read one byte at a time up to the blank line so no byte of the
//! server's greeting (the SSH banner, the RFB version) is consumed, and its
//! headers are capped at [`MAX_HTTP_RESPONSE_HEADER_BYTES`]. A proxy that
//! refuses the credentials fails the connect with a clear error; credentials
//! are never logged and never echoed in an error message.
//!
//! The dialer carries no SSH dependency: it is compiled with the internal
//! `proxy-dial` feature, which the `ssh` and `vnc` features both enable, and
//! stays reachable as `backends::ssh::proxy` for the SSH backend.

use std::net::{IpAddr, Ipv4Addr};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use zeroize::Zeroizing;

use crate::config::{SshProxyConfig, SshProxyType};
use crate::errors::SessionError;

/// Upper bound on the HTTP proxy's `CONNECT` response (status line and
/// headers). Anything longer is refused rather than buffered.
pub const MAX_HTTP_RESPONSE_HEADER_BYTES: usize = 8 * 1024;

/// Longest reason phrase / status text quoted back in an error message.
const MAX_QUOTED_REASON_CHARS: usize = 80;

/// Open a TCP stream to `host:port`, through `proxy` when one is set.
///
/// Without a proxy this is a plain async connect. With one, the proxy is
/// connected first and asked to open a tunnel to `host:port`; the returned
/// stream then carries the tunnelled bytes. Name resolution of `host` happens
/// at the proxy for SOCKS4a/SOCKS5/HTTP, so a target only resolvable on the
/// proxy's side is reachable. The caller bounds the whole call with its
/// connect timeout / cancellation.
pub async fn connect_tcp(
    host: &str,
    port: u16,
    proxy: Option<&SshProxyConfig>,
) -> Result<TcpStream, SessionError> {
    let Some(proxy) = proxy else {
        // Typed, locale-independent discriminant so consumers classify an
        // unreachable host structurally (I18N-002 / ERR-003).
        // `host:port` text, as before #4867, so a bracketed IPv6 literal works.
        return TcpStream::connect(format!("{host}:{port}"))
            .await
            .map_err(|e| SessionError::ConnectionFailed(e.to_string()));
    };

    let kind = proxy.proxy_type.label();
    let mut stream = TcpStream::connect(format!("{}:{}", proxy.host, proxy.port))
        .await
        .map_err(|e| {
            SessionError::ConnectionFailed(format!(
                "Could not reach the {kind} proxy {}:{}: {e}",
                proxy.host, proxy.port
            ))
        })?;
    tracing::debug!(
        proxy_type = kind,
        proxy_host = %proxy.host,
        proxy_port = proxy.port,
        target_host = %host,
        target_port = port,
        "Opening connection through proxy"
    );
    establish_tunnel(&mut stream, proxy, host, port).await?;
    Ok(stream)
}

/// Run `proxy`'s tunnel handshake on an already-connected `stream`, asking it
/// to connect to `host:port`. On success the stream carries the tunnel.
///
/// Generic over the stream so tests can drive it against in-process proxies.
pub async fn establish_tunnel<S>(
    stream: &mut S,
    proxy: &SshProxyConfig,
    host: &str,
    port: u16,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let target = TargetAddr::parse(host)?;
    match proxy.proxy_type {
        SshProxyType::Socks4 => socks4_connect(stream, proxy, &target, port).await,
        SshProxyType::Socks5 => socks5_connect(stream, proxy, &target, port).await,
        SshProxyType::Http => http_connect(stream, proxy, &target, port).await,
    }
}

/// The target as the proxy protocols address it.
enum TargetAddr<'a> {
    Ip(IpAddr),
    Domain(&'a str),
}

impl<'a> TargetAddr<'a> {
    fn parse(host: &'a str) -> Result<Self, SessionError> {
        // Accept a bracketed IPv6 literal (`[::1]`) as well as a bare one.
        let unbracketed = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        if let Ok(ip) = unbracketed.parse::<IpAddr>() {
            return Ok(Self::Ip(ip));
        }
        let valid = !host.is_empty()
            && host.len() <= 255
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
        if !valid {
            return Err(SessionError::InvalidConfig(format!(
                "Cannot reach {host:?} through a proxy: not a valid host name"
            )));
        }
        Ok(Self::Domain(host))
    }

    /// `host:port` as used in an HTTP request target (IPv6 in brackets).
    fn authority(&self, port: u16) -> String {
        match self {
            Self::Ip(IpAddr::V6(ip)) => format!("[{ip}]:{port}"),
            Self::Ip(IpAddr::V4(ip)) => format!("{ip}:{port}"),
            Self::Domain(name) => format!("{name}:{port}"),
        }
    }
}

/// A proxy protocol error (`SpawnFailed`, prefixed with the proxy identity).
fn proxy_error(proxy: &SshProxyConfig, msg: impl std::fmt::Display) -> SessionError {
    SessionError::SpawnFailed(format!(
        "{} proxy {}:{}: {msg}",
        proxy.proxy_type.label(),
        proxy.host,
        proxy.port
    ))
}

/// The proxy reached, but it could not reach the target (`ConnectionFailed`).
fn target_unreachable(proxy: &SshProxyConfig, msg: impl std::fmt::Display) -> SessionError {
    SessionError::ConnectionFailed(format!(
        "{} proxy {}:{}: {msg}",
        proxy.proxy_type.label(),
        proxy.host,
        proxy.port
    ))
}

/// Map an I/O error during the proxy handshake to a proxy error.
fn io_error(proxy: &SshProxyConfig, e: std::io::Error) -> SessionError {
    if e.kind() == std::io::ErrorKind::UnexpectedEof {
        proxy_error(
            proxy,
            "the proxy closed the connection during the handshake",
        )
    } else {
        proxy_error(proxy, format!("handshake failed: {e}"))
    }
}

fn non_empty(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|s| !s.is_empty())
}

// ── SOCKS4 / SOCKS4a ───────────────────────────────────────────────

async fn socks4_connect<S>(
    stream: &mut S,
    proxy: &SshProxyConfig,
    target: &TargetAddr<'_>,
    port: u16,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if non_empty(proxy.password.as_ref()).is_some() {
        // SOCKS4 has no password field; never send the secret anywhere.
        tracing::warn!("A proxy password is set but SOCKS4 has no password support; ignoring it");
    }
    let user = non_empty(proxy.username.as_ref()).unwrap_or("");
    if user.as_bytes().contains(&0) || user.len() > 255 {
        return Err(SessionError::InvalidConfig(
            "SOCKS4 proxy user id must be at most 255 bytes without NUL characters".to_string(),
        ));
    }

    let mut req = vec![0x04, 0x01];
    req.extend_from_slice(&port.to_be_bytes());
    match target {
        TargetAddr::Ip(IpAddr::V4(ip)) => req.extend_from_slice(&ip.octets()),
        TargetAddr::Ip(IpAddr::V6(_)) => {
            return Err(proxy_error(
                proxy,
                "SOCKS4 cannot connect to an IPv6 address; use SOCKS5 or HTTP",
            ));
        }
        // SOCKS4a: an invalid IP 0.0.0.x (x != 0) tells the proxy a host name
        // follows the user id.
        TargetAddr::Domain(_) => req.extend_from_slice(&Ipv4Addr::new(0, 0, 0, 1).octets()),
    }
    req.extend_from_slice(user.as_bytes());
    req.push(0);
    if let TargetAddr::Domain(name) = target {
        req.extend_from_slice(name.as_bytes());
        req.push(0);
    }
    stream
        .write_all(&req)
        .await
        .map_err(|e| io_error(proxy, e))?;

    let mut reply = [0u8; 8];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|e| io_error(proxy, e))?;
    if reply[0] != 0x00 {
        return Err(proxy_error(
            proxy,
            format!("invalid SOCKS4 reply (version byte {:#04x})", reply[0]),
        ));
    }
    match reply[1] {
        0x5A => Ok(()),
        0x5B => Err(target_unreachable(
            proxy,
            "the proxy rejected or could not complete the connection",
        )),
        0x5C | 0x5D => Err(proxy_error(
            proxy,
            "the proxy refused the request (identd check failed)",
        )),
        other => Err(proxy_error(
            proxy,
            format!("invalid SOCKS4 reply code {other:#04x}"),
        )),
    }
}

// ── SOCKS5 ─────────────────────────────────────────────────────────

const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_NO_AUTH: u8 = 0x00;
const SOCKS5_USER_PASS: u8 = 0x02;
const SOCKS5_NO_ACCEPTABLE: u8 = 0xFF;

async fn socks5_connect<S>(
    stream: &mut S,
    proxy: &SshProxyConfig,
    target: &TargetAddr<'_>,
    port: u16,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let user = non_empty(proxy.username.as_ref());
    let password = non_empty(proxy.password.as_ref());
    if let Some(user) = user {
        if user.len() > 255 || password.is_some_and(|p| p.len() > 255) {
            return Err(SessionError::InvalidConfig(
                "SOCKS5 proxy user and password must each be at most 255 bytes".to_string(),
            ));
        }
    }

    // Greeting: offer username/password only when credentials are configured.
    let greeting: &[u8] = if user.is_some() {
        &[SOCKS5_VERSION, 2, SOCKS5_NO_AUTH, SOCKS5_USER_PASS]
    } else {
        &[SOCKS5_VERSION, 1, SOCKS5_NO_AUTH]
    };
    stream
        .write_all(greeting)
        .await
        .map_err(|e| io_error(proxy, e))?;
    let mut choice = [0u8; 2];
    stream
        .read_exact(&mut choice)
        .await
        .map_err(|e| io_error(proxy, e))?;
    if choice[0] != SOCKS5_VERSION {
        return Err(proxy_error(
            proxy,
            format!("not a SOCKS5 proxy (version byte {:#04x})", choice[0]),
        ));
    }
    match (choice[1], user) {
        (SOCKS5_NO_AUTH, _) => {}
        (SOCKS5_USER_PASS, Some(user)) => {
            socks5_authenticate(stream, proxy, user, password.unwrap_or("")).await?;
        }
        (SOCKS5_NO_ACCEPTABLE, None) => {
            return Err(proxy_error(
                proxy,
                "the proxy requires authentication; set a proxy user and password",
            ));
        }
        (SOCKS5_NO_ACCEPTABLE, Some(_)) => {
            return Err(proxy_error(
                proxy,
                "the proxy accepted none of the offered authentication methods",
            ));
        }
        (other, _) => {
            // Includes a method we never offered (e.g. 0x02 without credentials).
            return Err(proxy_error(
                proxy,
                format!(
                    "the proxy chose an authentication method that was not offered ({other:#04x})"
                ),
            ));
        }
    }

    // CONNECT request.
    let mut req = vec![SOCKS5_VERSION, 0x01, 0x00];
    match target {
        TargetAddr::Ip(IpAddr::V4(ip)) => {
            req.push(0x01);
            req.extend_from_slice(&ip.octets());
        }
        TargetAddr::Ip(IpAddr::V6(ip)) => {
            req.push(0x04);
            req.extend_from_slice(&ip.octets());
        }
        TargetAddr::Domain(name) => {
            req.push(0x03);
            // `TargetAddr::parse` caps a name at 255 bytes.
            req.push(name.len() as u8);
            req.extend_from_slice(name.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&req)
        .await
        .map_err(|e| io_error(proxy, e))?;

    // Reply: VER REP RSV ATYP BND.ADDR BND.PORT — read exactly its length.
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| io_error(proxy, e))?;
    if head[0] != SOCKS5_VERSION {
        return Err(proxy_error(
            proxy,
            format!("invalid SOCKS5 reply (version byte {:#04x})", head[0]),
        ));
    }
    if head[1] != 0x00 {
        let reason = match head[1] {
            0x01 => "general proxy failure",
            0x02 => "connection not allowed by the proxy's rules",
            0x03 => "network unreachable",
            0x04 => "host unreachable",
            0x05 => "connection refused by the target",
            0x06 => "TTL expired",
            0x07 => "command not supported by the proxy",
            0x08 => "address type not supported by the proxy",
            _ => "unknown SOCKS5 error",
        };
        return Err(target_unreachable(
            proxy,
            format!("could not connect to the target: {reason}"),
        ));
    }
    let addr_len = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| io_error(proxy, e))?;
            usize::from(len[0])
        }
        other => {
            return Err(proxy_error(
                proxy,
                format!("invalid SOCKS5 reply address type {other:#04x}"),
            ));
        }
    };
    // Bound address + port; at most 255 + 2 bytes.
    let mut rest = vec![0u8; addr_len + 2];
    stream
        .read_exact(&mut rest)
        .await
        .map_err(|e| io_error(proxy, e))?;
    Ok(())
}

/// RFC 1929 username/password sub-negotiation. Fails closed on any status
/// other than success.
async fn socks5_authenticate<S>(
    stream: &mut S,
    proxy: &SshProxyConfig,
    user: &str,
    password: &str,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut req = Zeroizing::new(Vec::with_capacity(3 + user.len() + password.len()));
    req.push(0x01);
    req.push(user.len() as u8);
    req.extend_from_slice(user.as_bytes());
    req.push(password.len() as u8);
    req.extend_from_slice(password.as_bytes());
    stream
        .write_all(&req)
        .await
        .map_err(|e| io_error(proxy, e))?;
    let mut reply = [0u8; 2];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|e| io_error(proxy, e))?;
    // RFC 1929 says the reply version is 0x01; some proxies echo 0x05.
    if reply[0] != 0x01 && reply[0] != SOCKS5_VERSION {
        return Err(proxy_error(
            proxy,
            format!(
                "invalid authentication reply (version byte {:#04x})",
                reply[0]
            ),
        ));
    }
    if reply[1] != 0x00 {
        return Err(proxy_error(
            proxy,
            "proxy authentication failed; check the proxy user and password",
        ));
    }
    Ok(())
}

// ── HTTP CONNECT ───────────────────────────────────────────────────

async fn http_connect<S>(
    stream: &mut S,
    proxy: &SshProxyConfig,
    target: &TargetAddr<'_>,
    port: u16,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let authority = target.authority(port);
    let mut req = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
    ));
    let user = non_empty(proxy.username.as_ref());
    if let Some(user) = user {
        if user.contains(':') || user.chars().any(char::is_control) {
            return Err(SessionError::InvalidConfig(
                "HTTP proxy user must not contain ':' or control characters".to_string(),
            ));
        }
        let password = proxy.password.as_deref().unwrap_or("");
        let credentials = Zeroizing::new(format!("{user}:{password}"));
        let encoded = Zeroizing::new(data_encoding::BASE64.encode(credentials.as_bytes()));
        req.push_str("Proxy-Authorization: Basic ");
        req.push_str(&encoded);
        req.push_str("\r\n");
    }
    req.push_str("\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| io_error(proxy, e))?;
    stream.flush().await.map_err(|e| io_error(proxy, e))?;

    let head = read_http_response_head(stream, proxy).await?;
    let status_line = head.lines().next().unwrap_or("");
    let (code, reason) = parse_http_status_line(status_line).ok_or_else(|| {
        proxy_error(
            proxy,
            format!(
                "invalid response to CONNECT: {:?}",
                quote_reason(status_line)
            ),
        )
    })?;
    match code {
        200..=299 => Ok(()),
        407 if user.is_some() => Err(proxy_error(
            proxy,
            "proxy authentication failed (407); check the proxy user and password",
        )),
        407 => Err(proxy_error(
            proxy,
            "the proxy requires authentication (407); set a proxy user and password",
        )),
        _ => Err(target_unreachable(
            proxy,
            format!("CONNECT refused: {code} {}", quote_reason(reason)),
        )),
    }
}

/// Read the proxy's response up to and including the blank line, one byte at
/// a time so nothing past it (the server's greeting) is consumed. Bounded by
/// [`MAX_HTTP_RESPONSE_HEADER_BYTES`].
async fn read_http_response_head<S>(
    stream: &mut S,
    proxy: &SshProxyConfig,
) -> Result<String, SessionError>
where
    S: AsyncRead + Unpin,
{
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    loop {
        if buf.len() >= MAX_HTTP_RESPONSE_HEADER_BYTES {
            return Err(proxy_error(
                proxy,
                format!(
                    "response to CONNECT exceeds {MAX_HTTP_RESPONSE_HEADER_BYTES} bytes of headers"
                ),
            ));
        }
        let byte = stream.read_u8().await.map_err(|e| io_error(proxy, e))?;
        buf.push(byte);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(buf).map_err(|_| proxy_error(proxy, "response to CONNECT is not valid text"))
}

/// Parse `HTTP/1.x NNN reason`; `None` unless it is a well-formed HTTP/1.0 or
/// HTTP/1.1 status line with a three-digit code.
fn parse_http_status_line(line: &str) -> Option<(u16, &str)> {
    let rest = line
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| line.strip_prefix("HTTP/1.0 "))?;
    let code_str = rest.get(..3)?;
    if !code_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let after = &rest[3..];
    if !(after.is_empty() || after.starts_with(' ')) {
        return None;
    }
    let code: u16 = code_str.parse().ok()?;
    if !(100..=599).contains(&code) {
        return None;
    }
    Some((code, after.trim()))
}

/// A reason phrase made safe to quote in an error: printable ASCII only,
/// truncated.
fn quote_reason(reason: &str) -> String {
    reason
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(MAX_QUOTED_REASON_CHARS)
        .collect()
}

#[cfg(test)]
#[path = "proxy_dial_tests.rs"]
mod tests;
