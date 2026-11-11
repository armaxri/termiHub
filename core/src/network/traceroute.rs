//! Hop-by-hop traceroute using TTL-limited probes via `socket2`.
//!
//! Sends UDP probes with incrementing TTL values and listens for ICMP
//! "Time Exceeded" replies. ICMP response bytes are validated with
//! [`pnet_packet`] to filter out unrelated ICMP packets before recording a hop.
//! On platforms where raw sockets require elevated privileges the function
//! returns [`NetworkError::InsufficientPrivileges`] — except on Linux, where an
//! unprivileged process falls back to `IP_RECVERR` on the UDP probe socket
//! (the `recverr` submodule, #4964), so no root or capability is needed.

use std::mem::MaybeUninit;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use pnet_packet::icmp::{IcmpPacket, IcmpTypes};
use pnet_packet::icmpv6::{Icmpv6Packet, Icmpv6Types};
use pnet_packet::ipv4::Ipv4Packet;
use pnet_packet::Packet;
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use tokio_util::sync::CancellationToken;

use super::error::NetworkError;
use super::types::TracerouteHop;

#[cfg(target_os = "linux")]
mod recverr;

const PROBE_TIMEOUT_MS: u64 = 3000;
/// Base UDP destination port. Each probe uses `UDP_DEST_PORT + probe_index` so
/// the ICMP error a router quotes back can be correlated to the exact probe that
/// triggered it (CORE-026), the same scheme classic `traceroute(8)` uses.
const UDP_DEST_PORT: u16 = 33434;

/// Returns `true` if the ICMP error in `buf` quotes a UDP datagram addressed to
/// `expected_dst_port` — i.e. it is the reply provoked by *our* probe rather
/// than unrelated ICMP traffic that happened to arrive on the shared raw socket
/// (CORE-026).
///
/// An ICMP Time Exceeded / Destination Unreachable message embeds the IP header
/// plus the first 8 bytes (the UDP header) of the datagram that triggered it.
/// Because each probe uses a unique destination port, matching that quoted port
/// disambiguates replies. Only Time Exceeded and Destination Unreachable are
/// accepted; other ICMP types (echo replies, another app's traffic) are ignored.
///
/// For IPv4, `buf` includes the outer IP header (socket2 delivers it on all
/// platforms); for IPv6, `buf` starts at the ICMPv6 header.
fn icmp_reply_matches_probe(buf: &[u8], is_ipv6: bool, expected_dst_port: u16) -> bool {
    let quoted = if is_ipv6 {
        quoted_udp_dst_port_v6(buf)
    } else {
        quoted_udp_dst_port_v4(buf)
    };
    quoted == Some(expected_dst_port)
}

/// Extract the destination port of the UDP datagram quoted inside an IPv4 ICMP
/// error. `buf` is the raw-socket bytes: outer IPv4 header, ICMP header (4-byte
/// header + 4-byte unused), then the embedded original IPv4 header + UDP header.
/// Returns `None` if `buf` is not a Time Exceeded / Destination Unreachable
/// error or does not quote enough of a UDP datagram to read the port.
///
/// The ICMP message is located by the outer header's IHL alone, never by its
/// `ip_len`: BSD-derived raw sockets (Darwin among them) can hand that field
/// over in host byte order with the header length subtracted, which on an
/// extended (RFC 4884) reply reads as a tiny length and hid the hop (#5288).
fn quoted_udp_dst_port_v4(buf: &[u8]) -> Option<u16> {
    let outer = Ipv4Packet::new(buf)?;
    let header_len = usize::from(outer.get_header_length()) * 4;
    if header_len < 20 {
        return None;
    }
    let icmp = IcmpPacket::new(buf.get(header_len..)?)?;
    if !matches!(
        icmp.get_icmp_type(),
        IcmpTypes::TimeExceeded | IcmpTypes::DestinationUnreachable
    ) {
        return None;
    }
    // ICMP payload = 4-byte unused/rest-of-header, then the quoted datagram.
    let embedded = icmp.payload().get(4..)?;
    quoted_udp_dst_port_from_inner(embedded, false)
}

/// Extract the destination port of the UDP datagram quoted inside an ICMPv6
/// error. `buf` starts at the ICMPv6 header (4-byte header + 4-byte unused),
/// then the embedded original IPv6 header + UDP header. Returns `None` on any
/// non-matching type or a too-short quote.
fn quoted_udp_dst_port_v6(buf: &[u8]) -> Option<u16> {
    let icmp = Icmpv6Packet::new(buf)?;
    if !matches!(
        icmp.get_icmpv6_type(),
        Icmpv6Types::TimeExceeded | Icmpv6Types::DestinationUnreachable
    ) {
        return None;
    }
    let embedded = icmp.payload().get(4..)?;
    quoted_udp_dst_port_from_inner(embedded, true)
}

/// Parse the destination port from an embedded original datagram (the IP header
/// plus at least the first 4 bytes of the UDP header). `is_ipv6` selects the
/// inner IP header layout. Done by byte offset so a router that quotes only the
/// mandatory IP-header + 8 bytes (a truncated UDP header) still correlates, and
/// non-UDP quotes are rejected.
fn quoted_udp_dst_port_from_inner(inner: &[u8], is_ipv6: bool) -> Option<u16> {
    let (udp_offset, proto) = if is_ipv6 {
        // Fixed 40-byte IPv6 header; our UDP probes carry no extension headers,
        // so the Next Header field (byte 6) is UDP and the UDP header follows.
        (40usize, *inner.get(6)?)
    } else {
        // IPv4: IHL (low nibble of byte 0) gives the header length in 32-bit
        // words; the protocol field is byte 9.
        let ihl = ((*inner.first()? & 0x0f) as usize) * 4;
        if ihl < 20 {
            return None;
        }
        (ihl, *inner.get(9)?)
    };
    // 17 = UDP. A quote for any other protocol is not one of our probes.
    if proto != 17 {
        return None;
    }
    // UDP destination port occupies bytes 2..4 of the UDP header.
    let dst = inner.get(udp_offset + 2..udp_offset + 4)?;
    Some(u16::from_be_bytes([dst[0], dst[1]]))
}

/// Run a traceroute to `host`, streaming each hop via `on_hop`.
///
/// * `max_hops` – Maximum TTL / hop count (typically 30).
/// * `cancel` – Token to abort the trace.
pub async fn traceroute(
    host: &str,
    max_hops: u8,
    on_hop: impl Fn(TracerouteHop) + Send + 'static,
    cancel: CancellationToken,
) -> Result<(), NetworkError> {
    let dest_ip = resolve(host).await?;

    let cancel_clone = cancel.clone();
    tokio::task::spawn_blocking(move || run_trace(dest_ip, max_hops, on_hop, cancel_clone))
        .await
        .map_err(|e| NetworkError::Platform(e.to_string()))?
}

fn run_trace(
    dest_ip: IpAddr,
    max_hops: u8,
    on_hop: impl Fn(TracerouteHop),
    cancel: CancellationToken,
) -> Result<(), NetworkError> {
    let domain = if dest_ip.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };

    // Receive socket for ICMP replies (requires raw socket / elevated privileges).
    let recv_proto = if dest_ip.is_ipv6() {
        Protocol::ICMPV6
    } else {
        Protocol::ICMPV4
    };
    let recv_sock = match Socket::new(domain, Type::RAW, Some(recv_proto)) {
        Ok(sock) => sock,
        // Linux: no CAP_NET_RAW — trace unprivileged via IP_RECVERR (#4964).
        #[cfg(target_os = "linux")]
        Err(_) => return recverr::run_trace(dest_ip, max_hops, on_hop, cancel),
        #[cfg(not(target_os = "linux"))]
        Err(e) => {
            return Err(NetworkError::InsufficientPrivileges {
                operation: "traceroute".into(),
                reason: e.to_string(),
            })
        }
    };
    // Send socket for UDP probes.
    let send_sock =
        Socket::new(domain, Type::DGRAM, Some(Protocol::UDP)).map_err(NetworkError::Io)?;

    let mut buf = vec![MaybeUninit::new(0u8); 512];

    // Monotonically increasing per-probe offset added to `UDP_DEST_PORT`, so
    // each datagram carries a distinct destination port for reply correlation
    // (CORE-026). `max_hops * 3` probes stays well within the u16 range from the
    // base port, so saturation only guards the theoretical extreme.
    let mut probe_index: u16 = 0;

    for ttl in 1..=max_hops {
        if cancel.is_cancelled() {
            break;
        }

        // Set TTL on send socket.
        if dest_ip.is_ipv6() {
            send_sock
                .set_unicast_hops_v6(ttl as u32)
                .map_err(NetworkError::Io)?;
        } else {
            send_sock.set_ttl(ttl as u32).map_err(NetworkError::Io)?;
        }

        let mut rtts: [Option<f64>; 3] = [None; 3];
        let mut router_ip: Option<IpAddr> = None;

        for rtt_slot in rtts.iter_mut() {
            if cancel.is_cancelled() {
                break;
            }

            let dst_port = UDP_DEST_PORT.saturating_add(probe_index);
            probe_index = probe_index.saturating_add(1);
            let dest_sock_addr = SockAddr::from(SocketAddr::new(dest_ip, dst_port));

            let started = Instant::now();
            // Send a tiny UDP datagram to this probe's unique destination port.
            let _ = send_sock.send_to(&[0u8; 20], &dest_sock_addr);

            // Read ICMP replies until one quotes *our* probe (matched by the
            // unique destination port) or the per-probe budget expires. Unrelated
            // ICMP arriving on the shared raw socket is skipped without resetting
            // the clock, so a stray reply can never be misattributed to this hop.
            let deadline = started + Duration::from_millis(PROBE_TIMEOUT_MS);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                if recv_sock.set_read_timeout(Some(remaining)).is_err() {
                    break;
                }
                match recv_sock.recv_from(&mut buf) {
                    Ok((len, src_addr)) => {
                        // SAFETY: `buf` is fully initialised (every element was
                        // `MaybeUninit::new(0u8)`), and socket2 writes the first
                        // `len` bytes; `MaybeUninit<u8>` and `u8` share layout.
                        let filled =
                            unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), len) };
                        if icmp_reply_matches_probe(filled, dest_ip.is_ipv6(), dst_port) {
                            let rtt = started.elapsed().as_secs_f64() * 1000.0;
                            *rtt_slot = Some(rtt);
                            if router_ip.is_none() {
                                if let Some(ip) = src_addr.as_socket().map(|s| s.ip()) {
                                    router_ip = Some(ip);
                                }
                            }
                            break;
                        }
                        // Not our probe — keep reading within the remaining budget.
                    }
                    Err(_) => break, // timeout or error — this probe gets no reply
                }
            }
        }

        let (hop, reached_dest) = hop_record(ttl, router_ip, rtts, dest_ip);
        on_hop(hop);

        if reached_dest {
            break;
        }
    }

    Ok(())
}

/// Build the hop reported for `ttl` from what its probes collected, and whether
/// the trace has reached `dest_ip` (so it stops).
///
/// `router_ip` is the first responder that answered one of the hop's probes;
/// `None` (every probe timed out) is the `* * *` hop, reported with no address.
/// The host is the bare address: no reverse lookup happens here.
fn hop_record(
    ttl: u8,
    router_ip: Option<IpAddr>,
    rtt_ms: [Option<f64>; 3],
    dest_ip: IpAddr,
) -> (TracerouteHop, bool) {
    let addr = router_ip.map(|ip| ip.to_string());
    let hop = TracerouteHop {
        hop: ttl,
        host: addr.clone(),
        ip: addr,
        rtt_ms,
    };
    (hop, router_ip == Some(dest_ip))
}

async fn resolve(host: &str) -> Result<IpAddr, NetworkError> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    let host = host.to_string();
    tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        format!("{host}:0")
            .to_socket_addrs()
            .map_err(|e| NetworkError::DnsResolution {
                host: host.clone(),
                reason: e.to_string(),
            })?
            .map(|a| a.ip())
            .next()
            .ok_or_else(|| NetworkError::DnsResolution {
                host: host.clone(),
                reason: "no addresses returned".into(),
            })
    })
    .await
    .map_err(|e| NetworkError::Platform(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── probe-correlation tests (CORE-026) ────────────────────────────────────

    // ICMP type numbers.
    const V4_TIME_EXCEEDED: u8 = 11;
    const V4_DEST_UNREACHABLE: u8 = 3;
    const V4_ECHO_REPLY: u8 = 0;
    const V6_TIME_EXCEEDED: u8 = 3;
    const V6_DEST_UNREACHABLE: u8 = 1;
    const V6_ECHO_REPLY: u8 = 129;
    const UDP: u8 = 17;
    const TCP: u8 = 6;

    /// Build the bytes a raw IPv4 ICMP socket delivers for a Time Exceeded /
    /// Destination Unreachable error: outer IPv4 header + ICMP header (4B) +
    /// 4B unused + the embedded original IPv4 header + UDP header carrying
    /// `inner_dst_port`.
    fn ipv4_icmp_error(icmp_type: u8, inner_proto: u8, inner_dst_port: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 20 + 4 + 4 + 20 + 8];
        // Outer IPv4 header.
        buf[0] = 0x45; // version 4, IHL 5 (20-byte header)
        let total = buf.len() as u16;
        buf[2..4].copy_from_slice(&total.to_be_bytes()); // total length (pnet reads it)
        buf[9] = 1; // protocol = ICMP
                    // ICMP header at offset 20 (type, code, checksum, then 4B unused).
        buf[20] = icmp_type;
        // Embedded original IPv4 header at offset 28.
        let inner = 28;
        buf[inner] = 0x45; // version 4, IHL 5
        buf[inner + 9] = inner_proto;
        // Embedded UDP header at offset 48; destination port at +2.
        let udp = inner + 20;
        buf[udp + 2..udp + 4].copy_from_slice(&inner_dst_port.to_be_bytes());
        buf
    }

    /// Build the bytes a raw ICMPv6 socket delivers (no outer IP header):
    /// ICMPv6 header (4B) + 4B unused + embedded IPv6 header (40B) + UDP header.
    fn icmpv6_error(icmp_type: u8, inner_proto: u8, inner_dst_port: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 4 + 4 + 40 + 8];
        buf[0] = icmp_type;
        // Embedded IPv6 packet starts after the 4B header + 4B unused.
        let inner = 8;
        buf[inner + 6] = inner_proto; // IPv6 Next Header
                                      // Embedded UDP header at offset 48; destination port at +2.
        let udp = inner + 40;
        buf[udp + 2..udp + 4].copy_from_slice(&inner_dst_port.to_be_bytes());
        buf
    }

    #[test]
    fn v4_reply_quoting_our_probe_matches() {
        let reply = ipv4_icmp_error(V4_TIME_EXCEEDED, UDP, 33434);
        assert!(icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_reply_quoting_different_probe_is_rejected() {
        // A reply for a different probe (port 33434) must not answer probe 33435.
        let reply = ipv4_icmp_error(V4_TIME_EXCEEDED, UDP, 33434);
        assert!(!icmp_reply_matches_probe(&reply, false, 33435));
    }

    #[test]
    fn v4_dest_unreachable_matches() {
        let reply = ipv4_icmp_error(V4_DEST_UNREACHABLE, UDP, 33500);
        assert!(icmp_reply_matches_probe(&reply, false, 33500));
    }

    #[test]
    fn v4_echo_reply_type_is_rejected() {
        // Wrong ICMP type: not one of our hop replies even if the port matches.
        let reply = ipv4_icmp_error(V4_ECHO_REPLY, UDP, 33434);
        assert!(!icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_non_udp_quote_is_rejected() {
        // A quoted TCP datagram is not one of our UDP probes.
        let reply = ipv4_icmp_error(V4_TIME_EXCEEDED, TCP, 33434);
        assert!(!icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_truncated_reply_is_rejected() {
        assert!(!icmp_reply_matches_probe(&[], false, 33434));
        assert!(!icmp_reply_matches_probe(&[0x45, 0, 0, 0], false, 33434));
    }

    #[test]
    fn v6_reply_quoting_our_probe_matches() {
        let reply = icmpv6_error(V6_TIME_EXCEEDED, UDP, 33434);
        assert!(icmp_reply_matches_probe(&reply, true, 33434));
    }

    #[test]
    fn v6_reply_quoting_different_probe_is_rejected() {
        let reply = icmpv6_error(V6_TIME_EXCEEDED, UDP, 33434);
        assert!(!icmp_reply_matches_probe(&reply, true, 33435));
    }

    #[test]
    fn v6_dest_unreachable_matches() {
        let reply = icmpv6_error(V6_DEST_UNREACHABLE, UDP, 33500);
        assert!(icmp_reply_matches_probe(&reply, true, 33500));
    }

    #[test]
    fn v6_echo_reply_type_is_rejected() {
        let reply = icmpv6_error(V6_ECHO_REPLY, UDP, 33434);
        assert!(!icmp_reply_matches_probe(&reply, true, 33434));
    }

    #[test]
    fn v6_non_udp_quote_is_rejected() {
        let reply = icmpv6_error(V6_TIME_EXCEEDED, TCP, 33434);
        assert!(!icmp_reply_matches_probe(&reply, true, 33434));
    }

    #[test]
    fn v6_truncated_reply_is_rejected() {
        assert!(!icmp_reply_matches_probe(&[], true, 33434));
        assert!(!icmp_reply_matches_probe(&[3, 0, 0, 0], true, 33434));
    }

    // ── Raw-socket reply fixtures (#5288) ─────────────────────────────────────
    //
    // termiHub does not shell out to `traceroute(8)` / `tracert.exe`: every
    // platform traces with its own probes, and on macOS and Windows the
    // "output" it parses is the raw ICMP socket's bytes. These fixtures spell
    // those bytes out field by field, as a raw socket delivers them, for the
    // hop shapes a real trace meets. Checksums are plausible but not
    // verified, matching the parser, which does not check them.

    /// Decode a whitespace-separated hex fixture into bytes.
    fn hex(fixture: &str) -> Vec<u8> {
        let digits: String = fixture.split_whitespace().collect();
        assert_eq!(digits.len() % 2, 0, "odd-length hex fixture");
        (0..digits.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).expect("hex digit"))
            .collect()
    }

    /// Our probe as a router quotes it back: IPv4 header (TTL 1, UDP,
    /// 192.168.1.23 -> 8.8.8.8, total 48) + the 8-byte UDP header
    /// (54321 -> 33434, length 28).
    const QUOTED_V4_PROBE: &str = "
        45 00 00 30  ab cd 00 00  01 11 3c 2e  c0 a8 01 17  08 08 08 08
        d4 31 82 9a  00 1c 00 00";

    /// A home router's ICMP Time Exceeded (type 11, code 0) for TTL 1:
    /// outer IPv4 header (192.168.1.1 -> 192.168.1.23, total 56), ICMP
    /// header + 4 unused bytes, then the classic RFC 792 quote.
    fn v4_time_exceeded_from_gateway() -> Vec<u8> {
        hex(&format!(
            "45 c0 00 38  1a 2b 00 00  40 01 dc 9e  c0 a8 01 01  c0 a8 01 17
             0b 00 f4 ff  00 00 00 00  {QUOTED_V4_PROBE}"
        ))
    }

    #[test]
    fn v4_gateway_time_exceeded_fixture_matches_its_probe() {
        let reply = v4_time_exceeded_from_gateway();
        assert_eq!(reply.len(), 56);
        assert_eq!(quoted_udp_dst_port_v4(&reply), Some(33434));
        assert!(icmp_reply_matches_probe(&reply, false, 33434));
        assert!(!icmp_reply_matches_probe(&reply, false, 33435));
    }

    #[test]
    fn v4_port_unreachable_from_the_destination_matches() {
        // The last hop: the target answers the probe with Destination
        // Unreachable / Port Unreachable (type 3, code 3).
        let reply = hex(&format!(
            "45 00 00 38  00 00 00 00  79 01 a9 4f  08 08 08 08  c0 a8 01 17
             03 03 fc fc  00 00 00 00  {QUOTED_V4_PROBE}"
        ));
        assert!(icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_router_with_ip_options_in_the_outer_header_matches() {
        // IHL 6: a 4-byte option (NOP padding) sits between the outer header
        // and the ICMP message, so the ICMP offset must follow the IHL.
        let reply = hex(&format!(
            "46 c0 00 3c  1a 2b 00 00  40 01 00 00  0a 00 00 01  c0 a8 01 17
             01 01 01 00
             0b 00 f4 ff  00 00 00 00  {QUOTED_V4_PROBE}"
        ));
        assert!(icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_quote_with_inner_ip_options_matches() {
        // The quoted original header carries a 4-byte option (IHL 6), so the
        // UDP header starts at byte 24 of the quote, not 20.
        let reply = hex(
            "45 c0 00 3c  1a 2b 00 00  40 01 00 00  0a 00 00 01  c0 a8 01 17
             0b 00 f4 ff  00 00 00 00
             46 00 00 34  ab cd 00 00  01 11 00 00  c0 a8 01 17  08 08 08 08
             01 01 01 00
             d4 31 82 a0  00 1c 00 00",
        );
        assert!(icmp_reply_matches_probe(&reply, false, 33440));
    }

    #[test]
    fn v4_quote_with_a_bogus_inner_ihl_is_rejected() {
        // An inner IHL below 5 cannot be a real header; nothing to correlate.
        let reply = hex(
            "45 c0 00 38  1a 2b 00 00  40 01 00 00  0a 00 00 01  c0 a8 01 17
             0b 00 f4 ff  00 00 00 00
             44 00 00 30  ab cd 00 00  01 11 00 00  c0 a8 01 17  08 08 08 08
             d4 31 82 9a  00 1c 00 00",
        );
        assert_eq!(quoted_udp_dst_port_v4(&reply), None);
    }

    #[test]
    fn v4_quote_cut_inside_the_udp_ports_is_rejected() {
        // The quote ends after the UDP source port: no destination port.
        let mut reply = v4_time_exceeded_from_gateway();
        reply.truncate(20 + 8 + 20 + 2);
        assert_eq!(quoted_udp_dst_port_v4(&reply), None);
    }

    #[test]
    fn v4_darwin_host_order_ip_len_still_matches() {
        // BSD-derived raw IPv4 sockets (Darwin among them) can deliver the
        // outer `ip_len` in host byte order with the header length already
        // subtracted: 56 - 20 = 36 is `24 00` on a little-endian Mac.
        let mut reply = v4_time_exceeded_from_gateway();
        reply[2..4].copy_from_slice(&36u16.to_le_bytes());
        assert!(icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_darwin_host_order_ip_len_of_an_extended_reply_still_matches() {
        // RFC 4884 extended Time Exceeded (an MPLS-labelled path): the quote
        // is padded to 128 bytes and followed by an extension structure,
        // 276 bytes in all. With that quirk `ip_len` as 276 - 20 = 256 in host
        // order, `00 01`, which reads as 1 in network order. The parser must
        // not trust that field to find the ICMP message.
        let mut reply = v4_time_exceeded_from_gateway();
        reply[20 + 5] = 32; // RFC 4884 length: 32 words (128 bytes) of quote.
        reply.resize(20 + 8 + 128, 0);
        reply.extend_from_slice(&hex("20 00 00 00")); // extension header
        reply.resize(276, 0); // extension objects (contents irrelevant here)
        reply[2..4].copy_from_slice(&256u16.to_le_bytes());
        assert!(icmp_reply_matches_probe(&reply, false, 33434));
    }

    #[test]
    fn v4_unrelated_icmp_on_the_shared_socket_is_ignored() {
        // Another app's `ping`: an Echo Request (type 8) arriving on the raw
        // socket. Not a hop reply.
        let echo_request = hex(
            "45 00 00 54  00 00 40 00  40 01 00 00  c0 a8 01 32  c0 a8 01 17
             08 00 f7 ff  12 34 00 01  00 00 00 00  00 00 00 00",
        );
        assert_eq!(quoted_udp_dst_port_v4(&echo_request), None);

        // A Time Exceeded for someone else's ICMP-based trace quotes an ICMP
        // echo (protocol 1), not one of our UDP probes.
        let foreign_trace = hex(
            "45 c0 00 38  1a 2b 00 00  40 01 00 00  c0 a8 01 01  c0 a8 01 17
             0b 00 f4 ff  00 00 00 00
             45 00 00 54  00 00 40 00  01 01 00 00  c0 a8 01 17  01 01 01 01
             08 00 82 9a  12 34 00 01",
        );
        assert!(!icmp_reply_matches_probe(&foreign_trace, false, 33434));
    }

    /// The IPv6 probe as quoted: fixed header (payload 28, UDP, hop limit 1,
    /// 2001:db8::23 -> 2001:4860:4860::8888) + the 8-byte UDP header.
    const QUOTED_V6_PROBE: &str = "
        60 00 00 00  00 1c 11 01
        20 01 0d b8  00 00 00 00  00 00 00 00  00 00 00 23
        20 01 48 60  48 60 00 00  00 00 00 00  00 00 88 88
        d4 31 82 9a  00 1c 00 00";

    #[test]
    fn v6_router_time_exceeded_fixture_matches_its_probe() {
        // ICMPv6 Time Exceeded (type 3, code 0) + 4 unused bytes + the quote.
        // A raw ICMPv6 socket delivers no outer IPv6 header.
        let reply = hex(&format!("03 00 7a 1c  00 00 00 00  {QUOTED_V6_PROBE}"));
        assert!(icmp_reply_matches_probe(&reply, true, 33434));
        assert!(!icmp_reply_matches_probe(&reply, true, 33436));
    }

    #[test]
    fn v6_port_unreachable_from_the_destination_matches() {
        // ICMPv6 Destination Unreachable / Port Unreachable (type 1, code 4).
        let reply = hex(&format!("01 04 3b 9e  00 00 00 00  {QUOTED_V6_PROBE}"));
        assert!(icmp_reply_matches_probe(&reply, true, 33434));
    }

    #[test]
    fn v6_neighbor_discovery_on_the_shared_socket_is_ignored() {
        // Neighbor Solicitation (135) and Router Advertisement (134) arrive on
        // every raw ICMPv6 socket on a live link. Neither is a hop reply.
        for nd_type in ["87", "86"] {
            let nd = hex(&format!(
                "{nd_type} 00 00 00  00 00 00 00
                 fe 80 00 00  00 00 00 00  00 00 00 00  00 00 00 01"
            ));
            assert_eq!(quoted_udp_dst_port_v6(&nd), None, "type 0x{nd_type}");
        }
    }

    #[test]
    fn v6_quote_cut_before_the_udp_header_is_rejected() {
        let mut reply = hex(&format!("03 00 7a 1c  00 00 00 00  {QUOTED_V6_PROBE}"));
        reply.truncate(8 + 40);
        assert_eq!(quoted_udp_dst_port_v6(&reply), None);
    }

    #[test]
    fn v4_outer_header_with_a_bogus_ihl_is_rejected() {
        let mut reply = v4_time_exceeded_from_gateway();
        reply[0] = 0x44; // IHL 4: shorter than any real IPv4 header.
        assert_eq!(quoted_udp_dst_port_v4(&reply), None);
    }

    // ── Hop records ───────────────────────────────────────────────────────────

    const DEST_V4: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(8, 8, 8, 8));

    #[test]
    fn all_probes_timed_out_is_an_anonymous_hop() {
        // `* * *`: no responder, no RTTs, and the trace goes on.
        let (hop, reached) = hop_record(4, None, [None; 3], DEST_V4);
        assert_eq!(hop.hop, 4);
        assert_eq!(hop.host, None);
        assert_eq!(hop.ip, None);
        assert_eq!(hop.rtt_ms, [None; 3]);
        assert!(!reached);
    }

    #[test]
    fn partially_answered_hop_keeps_the_gaps() {
        // One probe of three lost: the hop still names its router.
        let router = IpAddr::from([10, 0, 0, 1]);
        let rtts = [Some(1.25), None, Some(1.5)];
        let (hop, reached) = hop_record(2, Some(router), rtts, DEST_V4);
        assert_eq!(hop.ip.as_deref(), Some("10.0.0.1"));
        assert_eq!(hop.host, hop.ip);
        assert_eq!(hop.rtt_ms, rtts);
        assert!(!reached, "an intermediate router does not end the trace");
    }

    #[test]
    fn the_destination_answering_ends_the_trace() {
        let (hop, reached) = hop_record(9, Some(DEST_V4), [Some(12.0); 3], DEST_V4);
        assert_eq!(hop.ip.as_deref(), Some("8.8.8.8"));
        assert!(reached);
    }

    #[test]
    fn ipv6_hops_use_the_compressed_address_form() {
        let dest: IpAddr = "2001:4860:4860::8888".parse().unwrap();
        let router: IpAddr = "2001:db8::1".parse().unwrap();
        let (hop, reached) = hop_record(1, Some(router), [Some(0.5), None, None], dest);
        assert_eq!(hop.ip.as_deref(), Some("2001:db8::1"));
        assert!(!reached);
        let (last, reached) = hop_record(7, Some(dest), [None, Some(20.0), None], dest);
        assert_eq!(last.ip.as_deref(), Some("2001:4860:4860::8888"));
        assert!(reached);
    }

    // ── Existing tests ────────────────────────────────────────────────────────

    #[test]
    fn traceroute_hop_has_three_rtt_slots() {
        let hop = TracerouteHop {
            hop: 1,
            host: Some("router".into()),
            ip: Some("192.168.1.1".into()),
            rtt_ms: [Some(1.0), Some(1.1), Some(0.9)],
        };
        assert_eq!(hop.rtt_ms.len(), 3);
    }

    #[tokio::test]
    async fn resolve_ip_passthrough() {
        let ip = resolve("127.0.0.1").await.unwrap();
        assert_eq!(ip, IpAddr::from([127, 0, 0, 1]));
    }

    #[tokio::test]
    async fn resolve_localhost() {
        let ip = resolve("localhost").await.unwrap();
        assert!(ip.is_loopback());
    }
}
