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
const UDP_DEST_PORT: u16 = 33434;

/// Returns `true` if `buf` (raw bytes from a raw ICMP/ICMPv6 socket) is an
/// ICMP Time Exceeded or Destination Unreachable packet — the two types that
/// indicate a traceroute hop or final destination reached.
///
/// For IPv4, `buf` includes the IP header (socket2 includes it on all
/// platforms). For IPv6, `buf` starts directly with the ICMPv6 header.
fn is_valid_icmp_reply(buf: &[u8], is_ipv6: bool) -> bool {
    if is_ipv6 {
        Icmpv6Packet::new(buf)
            .map(|pkt| {
                matches!(
                    pkt.get_icmpv6_type(),
                    Icmpv6Types::TimeExceeded | Icmpv6Types::DestinationUnreachable
                )
            })
            .unwrap_or(false)
    } else {
        // IPv4 raw socket: buf starts with the IP header; use it to locate the ICMP payload.
        let Some(ip) = Ipv4Packet::new(buf) else {
            return false;
        };
        let Some(pkt) = IcmpPacket::new(ip.payload()) else {
            return false;
        };
        matches!(
            pkt.get_icmp_type(),
            IcmpTypes::TimeExceeded | IcmpTypes::DestinationUnreachable
        )
    }
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
    recv_sock
        .set_read_timeout(Some(Duration::from_millis(PROBE_TIMEOUT_MS)))
        .map_err(NetworkError::Io)?;

    // Send socket for UDP probes.
    let send_sock =
        Socket::new(domain, Type::DGRAM, Some(Protocol::UDP)).map_err(NetworkError::Io)?;

    let dest_addr = SocketAddr::new(dest_ip, UDP_DEST_PORT);
    let dest_sock_addr = SockAddr::from(dest_addr);

    let mut buf = vec![MaybeUninit::new(0u8); 512];

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

            let started = Instant::now();
            // Send a tiny UDP datagram.
            let _ = send_sock.send_to(&[0u8; 20], &dest_sock_addr);

            // Wait for ICMP Time Exceeded or Destination Unreachable.
            match recv_sock.recv_from(&mut buf) {
                Ok((len, src_addr)) => {
                    // SAFETY: socket2 initializes the first `len` bytes on success;
                    // MaybeUninit<u8> and u8 share the same memory layout.
                    let filled = unsafe {
                        std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), len)
                    };
                    if is_valid_icmp_reply(filled, dest_ip.is_ipv6()) {
                        let rtt = started.elapsed().as_secs_f64() * 1000.0;
                        *rtt_slot = Some(rtt);
                        if router_ip.is_none() {
                            if let Some(ip) = src_addr.as_socket().map(|s| s.ip()) {
                                router_ip = Some(ip);
                            }
                        }
                    }
                }
                Err(_) => {
                    // Timeout — rtt stays None.
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

    // ── is_valid_icmp_reply tests ─────────────────────────────────────────────

    // Builds bytes as returned by a raw IPv4 ICMP socket:
    // 20-byte IPv4 header (version=4, IHL=5, protocol=ICMP) + 8-byte ICMP header.
    fn ipv4_icmp_bytes(icmp_type: u8) -> Vec<u8> {
        let mut buf = vec![0u8; 28]; // 20B IPv4 header + 8B ICMP header
        buf[0] = 0x45; // version=4, IHL=5 (20-byte header)
        buf[2] = 0x00; // total length = 28 (big-endian high byte)
        buf[3] = 28; // total length = 28 (big-endian low byte)
        buf[9] = 1; // protocol = ICMP
        buf[20] = icmp_type;
        buf
    }

    // Builds raw ICMPv6 bytes as returned by a raw ICMPv6 socket (no IPv6 header).
    fn icmpv6_bytes(icmp_type: u8) -> Vec<u8> {
        let mut buf = vec![0u8; 8];
        buf[0] = icmp_type;
        buf
    }

    #[test]
    fn icmp_time_exceeded_is_valid() {
        // ICMP type 11 = Time Exceeded — a valid traceroute hop reply
        assert!(is_valid_icmp_reply(&ipv4_icmp_bytes(11), false));
    }

    #[test]
    fn icmp_dest_unreachable_is_valid() {
        // ICMP type 3 = Destination Unreachable — final hop reached
        assert!(is_valid_icmp_reply(&ipv4_icmp_bytes(3), false));
    }

    #[test]
    fn icmp_echo_reply_is_not_valid() {
        // ICMP type 0 = Echo Reply — unrelated, must be ignored
        assert!(!is_valid_icmp_reply(&ipv4_icmp_bytes(0), false));
    }

    #[test]
    fn empty_bytes_ipv4_is_not_valid() {
        assert!(!is_valid_icmp_reply(&[], false));
    }

    #[test]
    fn icmpv6_time_exceeded_is_valid() {
        // ICMPv6 type 3 = Time Exceeded
        assert!(is_valid_icmp_reply(&icmpv6_bytes(3), true));
    }

    #[test]
    fn icmpv6_dest_unreachable_is_valid() {
        // ICMPv6 type 1 = Destination Unreachable
        assert!(is_valid_icmp_reply(&icmpv6_bytes(1), true));
    }

    #[test]
    fn icmpv6_echo_reply_is_not_valid() {
        // ICMPv6 type 129 = Echo Reply — unrelated, must be ignored
        assert!(!is_valid_icmp_reply(&icmpv6_bytes(129), true));
    }

    #[test]
    fn empty_bytes_ipv6_is_not_valid() {
        assert!(!is_valid_icmp_reply(&[], true));
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
