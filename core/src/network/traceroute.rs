//! Hop-by-hop traceroute using TTL-limited probes via `socket2`.
//!
//! Sends UDP probes with incrementing TTL values and listens for ICMP
//! "Time Exceeded" replies. ICMP response bytes are validated with
//! [`pnet_packet`] to filter out unrelated ICMP packets before recording a hop.
//! On platforms where raw sockets require elevated privileges the function
//! returns [`NetworkError::InsufficientPrivileges`].

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
fn quoted_udp_dst_port_v4(buf: &[u8]) -> Option<u16> {
    let outer = Ipv4Packet::new(buf)?;
    let icmp = IcmpPacket::new(outer.payload())?;
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
    let recv_sock = Socket::new(domain, Type::RAW, Some(recv_proto)).map_err(|e| {
        NetworkError::InsufficientPrivileges {
            operation: "traceroute".into(),
            reason: e.to_string(),
        }
    })?;
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

        let host_str = router_ip.map(|ip| ip.to_string());
        let reached_dest = router_ip.map(|ip| ip == dest_ip).unwrap_or(false);

        on_hop(TracerouteHop {
            hop: ttl,
            host: host_str.clone(),
            ip: host_str,
            rtt_ms: rtts,
        });

        if reached_dest {
            break;
        }
    }

    Ok(())
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
