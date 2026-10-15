//! SOCKS4 / SOCKS4a request parsing for the dynamic (`ssh -D`) forwarder (#4541).
//!
//! OpenSSH's `ssh -D` serves SOCKS4, SOCKS4a and SOCKS5 on the same listener;
//! the dynamic forwarder dispatches on the first byte (the protocol version) and
//! hands a SOCKS4 client to [`read_request`]. Only `CONNECT` is supported, there
//! is no authentication (the USERID field is read, bounded and ignored), and a
//! SOCKS4a hostname (`DSTIP = 0.0.0.x`, `x != 0`) is passed through unresolved so
//! the SSH server's network resolves it — the same as a SOCKS5 domain target.
//!
//! Wire format of a request (after the `VN = 0x04` byte the caller already read):
//!
//! ```text
//! +----+---------+---------+-------------+------+[-------------+------]
//! | CD | DSTPORT |  DSTIP  |   USERID    | NULL |[ HOSTNAME    | NULL ]
//! +----+---------+---------+-------------+------+[-------------+------]
//!   1       2         4      variable       1     4a only: variable  1
//! ```
//!
//! The reply is 8 bytes: `VN = 0x00`, `CD = 0x5A` (granted) or `0x5B`
//! (rejected or failed), then `DSTPORT` and `DSTIP`, which a CONNECT client
//! ignores. SOCKS4 has no finer failure codes than `0x5B`.

use std::net::Ipv4Addr;

use tokio::io::{AsyncRead, AsyncReadExt};

/// Protocol version byte that opens a SOCKS4/4a request.
pub(crate) const SOCKS4_VERSION: u8 = 0x04;
/// `CD` of a CONNECT request.
pub(crate) const SOCKS4_CMD_CONNECT: u8 = 0x01;
/// `CD` of a reply granting the request.
pub(crate) const SOCKS4_REP_GRANTED: u8 = 0x5A;
/// `CD` of a reply rejecting the request or reporting a failure.
pub(crate) const SOCKS4_REP_REJECTED: u8 = 0x5B;

/// Longest USERID accepted, excluding the terminating NUL. The field is
/// unauthenticated and ignored; the cap only stops a client from streaming an
/// unbounded "string" at the handshake.
pub(crate) const SOCKS4_MAX_USERID_LEN: usize = 255;
/// Longest SOCKS4a hostname accepted, excluding the terminating NUL. Matches the
/// 255-byte limit SOCKS5 imposes on a domain target.
pub(crate) const SOCKS4_MAX_HOSTNAME_LEN: usize = 255;

/// A parsed SOCKS4/4a CONNECT request: the target the channel is opened to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Socks4Connect {
    /// IPv4 address (SOCKS4) or unresolved hostname (SOCKS4a).
    pub(crate) host: String,
    /// Destination port.
    pub(crate) port: u16,
    /// The client's USERID, kept only for logging and tests — it is never used
    /// for authorization.
    pub(crate) userid: Vec<u8>,
}

/// Why a well-framed SOCKS4 request is refused. Every variant is answered with
/// [`SOCKS4_REP_REJECTED`]; the variant exists for logging and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Socks4Rejection {
    /// `CD` other than CONNECT (BIND, or an undefined command).
    UnsupportedCommand(u8),
    /// USERID longer than [`SOCKS4_MAX_USERID_LEN`].
    UserIdTooLong,
    /// SOCKS4a hostname longer than [`SOCKS4_MAX_HOSTNAME_LEN`].
    HostnameTooLong,
    /// SOCKS4a hostname that is empty or not valid UTF-8.
    InvalidHostname,
}

/// Read a SOCKS4/4a request whose leading `VN` byte has already been consumed.
///
/// Returns `Ok(Ok(connect))` for a valid CONNECT, `Ok(Err(rejection))` for a
/// request that must be answered with [`SOCKS4_REP_REJECTED`], and `Err` when the
/// stream fails or ends mid-request (a truncated request has nobody to answer).
///
/// The request is read byte-exactly — never past its final NUL — so payload a
/// client pipelines behind its request stays in the stream for the relay.
pub(crate) async fn read_request<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Result<Socks4Connect, Socks4Rejection>> {
    let mut fixed = [0u8; 7];
    reader.read_exact(&mut fixed).await?;
    let command = fixed[0];
    if command != SOCKS4_CMD_CONNECT {
        return Ok(Err(Socks4Rejection::UnsupportedCommand(command)));
    }
    let port = u16::from_be_bytes([fixed[1], fixed[2]]);
    let ip = Ipv4Addr::new(fixed[3], fixed[4], fixed[5], fixed[6]);

    let Some(userid) = read_nul_terminated(reader, SOCKS4_MAX_USERID_LEN).await? else {
        return Ok(Err(Socks4Rejection::UserIdTooLong));
    };

    let host = if is_socks4a_marker(ip) {
        let Some(raw) = read_nul_terminated(reader, SOCKS4_MAX_HOSTNAME_LEN).await? else {
            return Ok(Err(Socks4Rejection::HostnameTooLong));
        };
        match String::from_utf8(raw) {
            Ok(host) if !host.is_empty() => host,
            _ => return Ok(Err(Socks4Rejection::InvalidHostname)),
        }
    } else {
        ip.to_string()
    };

    Ok(Ok(Socks4Connect { host, port, userid }))
}

/// The 8-byte SOCKS4 reply carrying `cd` (`DSTPORT`/`DSTIP` zeroed — a CONNECT
/// client ignores them).
pub(crate) fn reply(cd: u8) -> [u8; 8] {
    [0x00, cd, 0, 0, 0, 0, 0, 0]
}

/// SOCKS4a signals "hostname follows" with an IP of `0.0.0.x`, `x` non-zero —
/// an address no client would legitimately CONNECT to.
fn is_socks4a_marker(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    a == 0 && b == 0 && c == 0 && d != 0
}

/// Read a NUL-terminated field of at most `max` bytes (NUL excluded).
///
/// Returns `Ok(None)` once `max` bytes have been read with no NUL. Reads one
/// byte at a time so it never consumes past the terminator; the field is short
/// and the whole handshake runs under the forwarder's timeout.
async fn read_nul_terminated<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut field = Vec::new();
    loop {
        let byte = reader.read_u8().await?;
        if byte == 0 {
            return Ok(Some(field));
        }
        if field.len() == max {
            return Ok(None);
        }
        field.push(byte);
    }
}

#[cfg(test)]
mod tests {
    //! Parser tests over in-memory byte slices: good and malformed input, the
    //! 4a hostname path, the USERID field and the size caps.

    use super::*;

    /// Build a request body (everything after `VN`).
    fn request(cd: u8, port: u16, ip: [u8; 4], userid: &[u8], host: Option<&[u8]>) -> Vec<u8> {
        let mut bytes = vec![cd];
        bytes.extend_from_slice(&port.to_be_bytes());
        bytes.extend_from_slice(&ip);
        bytes.extend_from_slice(userid);
        bytes.push(0);
        if let Some(host) = host {
            bytes.extend_from_slice(host);
            bytes.push(0);
        }
        bytes
    }

    async fn parse(bytes: &[u8]) -> std::io::Result<Result<Socks4Connect, Socks4Rejection>> {
        let mut reader = bytes;
        read_request(&mut reader).await
    }

    #[tokio::test]
    async fn parses_ipv4_connect_with_empty_userid() {
        let bytes = request(SOCKS4_CMD_CONNECT, 443, [93, 184, 216, 34], b"", None);
        let parsed = parse(&bytes).await.expect("io ok").expect("accepted");
        assert_eq!(
            parsed,
            Socks4Connect {
                host: "93.184.216.34".to_string(),
                port: 443,
                userid: Vec::new(),
            }
        );
    }

    #[tokio::test]
    async fn userid_is_read_and_kept() {
        let bytes = request(SOCKS4_CMD_CONNECT, 22, [10, 0, 0, 1], b"alice", None);
        let parsed = parse(&bytes).await.expect("io ok").expect("accepted");
        assert_eq!(parsed.userid, b"alice");
        assert_eq!(parsed.host, "10.0.0.1");
    }

    #[tokio::test]
    async fn userid_at_cap_is_accepted_and_over_cap_rejected() {
        let at_cap = vec![b'u'; SOCKS4_MAX_USERID_LEN];
        let bytes = request(SOCKS4_CMD_CONNECT, 80, [10, 0, 0, 1], &at_cap, None);
        let parsed = parse(&bytes).await.expect("io ok").expect("accepted");
        assert_eq!(parsed.userid.len(), SOCKS4_MAX_USERID_LEN);

        let over = vec![b'u'; SOCKS4_MAX_USERID_LEN + 1];
        let bytes = request(SOCKS4_CMD_CONNECT, 80, [10, 0, 0, 1], &over, None);
        assert_eq!(
            parse(&bytes).await.expect("io ok"),
            Err(Socks4Rejection::UserIdTooLong)
        );
    }

    #[tokio::test]
    async fn socks4a_hostname_is_passed_through_unresolved() {
        let bytes = request(
            SOCKS4_CMD_CONNECT,
            80,
            [0, 0, 0, 1],
            b"bob",
            Some(b"example.com"),
        );
        let parsed = parse(&bytes).await.expect("io ok").expect("accepted");
        assert_eq!(parsed.host, "example.com");
        assert_eq!(parsed.port, 80);
        assert_eq!(parsed.userid, b"bob");
    }

    #[tokio::test]
    async fn socks4a_marker_with_any_nonzero_last_octet() {
        let bytes = request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 255], b"", Some(b"h.test"));
        let parsed = parse(&bytes).await.expect("io ok").expect("accepted");
        assert_eq!(parsed.host, "h.test");
    }

    #[tokio::test]
    async fn all_zero_ip_is_plain_socks4_not_4a() {
        // 0.0.0.0 is not the 4a marker (the last octet must be non-zero), so no
        // hostname is read — trailing bytes stay unread.
        let mut bytes = request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 0], b"", None);
        bytes.extend_from_slice(b"payload");
        let mut reader: &[u8] = &bytes;
        let parsed = read_request(&mut reader)
            .await
            .expect("io ok")
            .expect("accepted");
        assert_eq!(parsed.host, "0.0.0.0");
        assert_eq!(reader, b"payload", "parser must not read past the request");
    }

    #[tokio::test]
    async fn socks4a_request_leaves_pipelined_payload_unread() {
        let mut bytes = request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 7], b"u", Some(b"a.b"));
        bytes.extend_from_slice(b"GET /");
        let mut reader: &[u8] = &bytes;
        read_request(&mut reader)
            .await
            .expect("io ok")
            .expect("accepted");
        assert_eq!(reader, b"GET /");
    }

    #[tokio::test]
    async fn socks4a_hostname_over_cap_is_rejected() {
        let long = vec![b'h'; SOCKS4_MAX_HOSTNAME_LEN + 1];
        let bytes = request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 1], b"", Some(&long));
        assert_eq!(
            parse(&bytes).await.expect("io ok"),
            Err(Socks4Rejection::HostnameTooLong)
        );

        let at_cap = vec![b'h'; SOCKS4_MAX_HOSTNAME_LEN];
        let bytes = request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 1], b"", Some(&at_cap));
        assert!(parse(&bytes).await.expect("io ok").is_ok());
    }

    #[tokio::test]
    async fn socks4a_empty_or_non_utf8_hostname_is_rejected() {
        let empty = request(SOCKS4_CMD_CONNECT, 80, [0, 0, 0, 1], b"", Some(b""));
        assert_eq!(
            parse(&empty).await.expect("io ok"),
            Err(Socks4Rejection::InvalidHostname)
        );
        let bad = request(
            SOCKS4_CMD_CONNECT,
            80,
            [0, 0, 0, 1],
            b"",
            Some(&[0xFF, 0xFE]),
        );
        assert_eq!(
            parse(&bad).await.expect("io ok"),
            Err(Socks4Rejection::InvalidHostname)
        );
    }

    #[tokio::test]
    async fn bind_and_unknown_commands_are_rejected() {
        for cd in [0x02u8, 0x00, 0x03, 0xFF] {
            let bytes = request(cd, 80, [10, 0, 0, 1], b"", None);
            assert_eq!(
                parse(&bytes).await.expect("io ok"),
                Err(Socks4Rejection::UnsupportedCommand(cd)),
                "CD {cd:#04x}"
            );
        }
    }

    #[tokio::test]
    async fn truncated_requests_are_io_errors() {
        let full = request(
            SOCKS4_CMD_CONNECT,
            80,
            [0, 0, 0, 1],
            b"user",
            Some(b"host.test"),
        );
        // Every proper prefix is cut off before the hostname's NUL.
        for len in 0..full.len() {
            let err = parse(&full[..len])
                .await
                .expect_err(&format!("prefix of {len} bytes must not parse"));
            assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
        }
    }

    #[test]
    fn reply_layout() {
        assert_eq!(reply(SOCKS4_REP_GRANTED), [0x00, 0x5A, 0, 0, 0, 0, 0, 0]);
        assert_eq!(reply(SOCKS4_REP_REJECTED), [0x00, 0x5B, 0, 0, 0, 0, 0, 0]);
    }
}
