//! Hop-by-hop traceroute using TTL-limited probes via `socket2`.
//!
//! Sends UDP probes with incrementing TTL values and listens for ICMP
//! "Time Exceeded" replies. On platforms where raw sockets require elevated
//! privileges the function returns [`NetworkError::InsufficientPrivileges`].

use std::mem::MaybeUninit;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use tokio_util::sync::CancellationToken;

use super::error::NetworkError;
use super::types::TracerouteHop;

const PROBE_TIMEOUT_MS: u64 = 3000;
const UDP_DEST_PORT: u16 = 33434;

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

    // Allocate a zeroed buffer compatible with MaybeUninit<u8>.
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
                Ok((_len, src_addr)) => {
                    let rtt = started.elapsed().as_secs_f64() * 1000.0;
                    *rtt_slot = Some(rtt);
                    if router_ip.is_none() {
                        if let Some(ip) = src_addr.as_socket().map(|s| s.ip()) {
                            router_ip = Some(ip);
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
