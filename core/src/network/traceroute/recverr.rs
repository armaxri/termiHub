//! Unprivileged traceroute for Linux via `IP_RECVERR` / `IPV6_RECVERR` (#4964).
//!
//! The raw-socket path in the parent module needs `CAP_NET_RAW` (root). Linux
//! offers an unprivileged alternative, the one `tracepath(8)` and the default
//! UDP method of `traceroute(8)` use: enable `IP_RECVERR` on the ordinary UDP
//! probe socket, and the kernel queues every ICMP error a probe provokes on the
//! socket's *error queue*. Reading it with `recvmsg(MSG_ERRQUEUE)` yields:
//!
//! * the probe's original destination (as `msg_name`), whose port identifies
//!   the probe exactly like the quoted UDP header does on the raw path;
//! * a `sock_extended_err` control message with the ICMP type and the address
//!   of the router that sent it (`SO_EE_OFFENDER`).
//!
//! No raw socket, capability or sysctl is involved, so a normal user can trace
//! on Linux, and the Linux integration lane grades the tool without privileges.

use std::io;
use std::mem::{size_of, size_of_val, zeroed};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::os::fd::{AsRawFd, RawFd};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use tokio_util::sync::CancellationToken;

use super::{NetworkError, TracerouteHop, PROBE_TIMEOUT_MS, UDP_DEST_PORT};

// ICMP types a hop answers with (IPv4 / ICMPv6).
const V4_TIME_EXCEEDED: u8 = 11;
const V4_DEST_UNREACHABLE: u8 = 3;
const V6_TIME_EXCEEDED: u8 = 3;
const V6_DEST_UNREACHABLE: u8 = 1;

/// One entry read from the socket's error queue.
#[derive(Debug, Clone, Copy, PartialEq)]
struct QueuedError {
    /// Destination port of the probe that provoked the error.
    dst_port: Option<u16>,
    /// `ee_origin` of the extended error (`SO_EE_ORIGIN_ICMP[6]` for ICMP).
    origin: u8,
    /// ICMP type the router sent.
    icmp_type: u8,
    /// The router (or the destination) that sent the ICMP error.
    offender: Option<IpAddr>,
}

/// Whether an extended error is an ICMP Time Exceeded / Destination Unreachable
/// — the replies a traceroute hop is made of. Anything else (a local error, an
/// ICMP type we never provoke) is not a hop answer.
fn is_hop_reply(origin: u8, icmp_type: u8, is_ipv6: bool) -> bool {
    if is_ipv6 {
        origin == libc::SO_EE_ORIGIN_ICMP6
            && matches!(icmp_type, V6_TIME_EXCEEDED | V6_DEST_UNREACHABLE)
    } else {
        origin == libc::SO_EE_ORIGIN_ICMP
            && matches!(icmp_type, V4_TIME_EXCEEDED | V4_DEST_UNREACHABLE)
    }
}

/// Run the trace on an unprivileged UDP socket. Same streaming contract as the
/// raw path: one [`TracerouteHop`] per TTL, stopping at the destination.
pub(super) fn run_trace(
    dest_ip: IpAddr,
    max_hops: u8,
    on_hop: impl Fn(TracerouteHop),
    cancel: CancellationToken,
) -> Result<(), NetworkError> {
    let is_ipv6 = dest_ip.is_ipv6();
    let domain = if is_ipv6 { Domain::IPV6 } else { Domain::IPV4 };
    let sock = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP)).map_err(NetworkError::Io)?;
    enable_recverr(sock.as_raw_fd(), is_ipv6).map_err(NetworkError::Io)?;
    let fd = sock.as_raw_fd();

    let mut probe_index: u16 = 0;
    for ttl in 1..=max_hops {
        if cancel.is_cancelled() {
            break;
        }
        if is_ipv6 {
            sock.set_unicast_hops_v6(ttl as u32)
                .map_err(NetworkError::Io)?;
        } else {
            sock.set_ttl(ttl as u32).map_err(NetworkError::Io)?;
        }

        let mut rtts: [Option<f64>; 3] = [None; 3];
        let mut router_ip: Option<IpAddr> = None;

        for rtt_slot in rtts.iter_mut() {
            if cancel.is_cancelled() {
                break;
            }
            let dst_port = UDP_DEST_PORT.saturating_add(probe_index);
            probe_index = probe_index.saturating_add(1);
            let dest = SockAddr::from(SocketAddr::new(dest_ip, dst_port));

            // A late error from an earlier, timed-out probe sets the socket's
            // pending error, which would fail this send; drain it first.
            drain_error_queue(fd);
            let started = Instant::now();
            if sock.send_to(&[0u8; 20], &dest).is_err() {
                drain_error_queue(fd);
                let _ = sock.send_to(&[0u8; 20], &dest);
            }

            let deadline = started + Duration::from_millis(PROBE_TIMEOUT_MS);
            while let Some(queued) = next_error(fd, deadline) {
                if queued.dst_port == Some(dst_port)
                    && is_hop_reply(queued.origin, queued.icmp_type, is_ipv6)
                {
                    *rtt_slot = Some(started.elapsed().as_secs_f64() * 1000.0);
                    if router_ip.is_none() {
                        router_ip = queued.offender;
                    }
                    break;
                }
                // Not this probe's answer (a straggler) — keep waiting.
            }
        }

        let host_str = router_ip.map(|ip| ip.to_string());
        let reached_dest = router_ip == Some(dest_ip);
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

fn enable_recverr(fd: RawFd, is_ipv6: bool) -> io::Result<()> {
    let (level, name) = if is_ipv6 {
        (libc::SOL_IPV6, libc::IPV6_RECVERR)
    } else {
        (libc::SOL_IP, libc::IP_RECVERR)
    };
    let on: libc::c_int = 1;
    // SAFETY: `on` outlives the call and the length matches its type.
    let rc = unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            (&on as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Discard everything currently on the error queue (non-blocking).
fn drain_error_queue(fd: RawFd) {
    while let Ok(Some(_)) = read_error_queue(fd) {}
}

/// Wait until `deadline` for the next error-queue entry. `None` on timeout or
/// a socket error. Stray datagrams (a target that answers our probe) are read
/// and dropped so they cannot keep `poll` busy.
fn next_error(fd: RawFd, deadline: Instant) -> Option<QueuedError> {
    loop {
        match read_error_queue(fd) {
            Ok(Some(queued)) => return Some(queued),
            Ok(None) => {}
            Err(_) => return None,
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
        // SAFETY: one valid pollfd, count 1.
        let rc = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if rc < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return None;
        }
        if rc == 0 {
            return None;
        }
        if pfd.revents & libc::POLLIN != 0 {
            let mut scratch = [0u8; 512];
            // SAFETY: `scratch` is a valid writable buffer of the given length.
            unsafe {
                libc::recv(
                    fd,
                    scratch.as_mut_ptr().cast(),
                    scratch.len(),
                    libc::MSG_DONTWAIT,
                )
            };
        }
        // POLLERR (or after draining POLLIN): loop round to read the queue.
    }
}

/// Read one entry from the error queue without blocking. `Ok(None)` when the
/// queue is empty.
fn read_error_queue(fd: RawFd) -> io::Result<Option<QueuedError>> {
    // SAFETY: all-zero is a valid `sockaddr_storage` / `msghdr`.
    let mut name: libc::sockaddr_storage = unsafe { zeroed() };
    let mut data = [0u8; 64];
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr().cast(),
        iov_len: data.len(),
    };
    // u64 elements keep the control buffer aligned for `cmsghdr`.
    let mut control = [0u64; 64];
    let mut msg: libc::msghdr = unsafe { zeroed() };
    msg.msg_name = (&mut name as *mut libc::sockaddr_storage).cast();
    msg.msg_namelen = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = size_of_val(&control) as _;

    // SAFETY: every pointer in `msg` refers to a live local buffer of the
    // advertised length.
    let n = unsafe { libc::recvmsg(fd, &mut msg, libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT) };
    if n < 0 {
        let err = io::Error::last_os_error();
        return match err.kind() {
            io::ErrorKind::WouldBlock => Ok(None),
            io::ErrorKind::Interrupted => read_error_queue(fd),
            _ => Err(err),
        };
    }

    // SAFETY: the kernel filled `name` with `msg_namelen` bytes of a sockaddr.
    let dst_port =
        unsafe { sockaddr_to_socket_addr((&name as *const libc::sockaddr_storage).cast()) }
            .map(|addr| addr.port());

    let mut queued = QueuedError {
        dst_port,
        origin: 0,
        icmp_type: 0,
        offender: None,
    };
    // SAFETY: standard cmsg walk over the control buffer the kernel filled.
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            let header = &*cmsg;
            let is_recverr = (header.cmsg_level == libc::SOL_IP
                && header.cmsg_type == libc::IP_RECVERR)
                || (header.cmsg_level == libc::SOL_IPV6 && header.cmsg_type == libc::IPV6_RECVERR);
            if is_recverr {
                let ee = libc::CMSG_DATA(cmsg) as *const libc::sock_extended_err;
                let err = std::ptr::read_unaligned(ee);
                queued.origin = err.ee_origin;
                queued.icmp_type = err.ee_type;
                queued.offender =
                    sockaddr_to_socket_addr(libc::SO_EE_OFFENDER(ee) as *const libc::sockaddr)
                        .map(|addr| addr.ip());
                break;
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    Ok(Some(queued))
}

/// Decode an IPv4 / IPv6 `sockaddr`; `None` for any other family (e.g. the
/// `AF_UNSPEC` offender of a local error).
///
/// # Safety
/// `addr` must point to at least `sizeof(sockaddr_in6)` readable bytes when the
/// family is `AF_INET6`, `sizeof(sockaddr_in)` when `AF_INET`.
unsafe fn sockaddr_to_socket_addr(addr: *const libc::sockaddr) -> Option<SocketAddr> {
    let family = std::ptr::read_unaligned(std::ptr::addr_of!((*addr).sa_family));
    match libc::c_int::from(family) {
        libc::AF_INET => {
            let sin = std::ptr::read_unaligned(addr as *const libc::sockaddr_in);
            let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
            Some(SocketAddr::new(IpAddr::V4(ip), u16::from_be(sin.sin_port)))
        }
        libc::AF_INET6 => {
            let sin6 = std::ptr::read_unaligned(addr as *const libc::sockaddr_in6);
            let ip = Ipv6Addr::from(sin6.sin6_addr.s6_addr);
            Some(SocketAddr::new(
                IpAddr::V6(ip),
                u16::from_be(sin6.sin6_port),
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn hop_reply_types_v4() {
        assert!(is_hop_reply(
            libc::SO_EE_ORIGIN_ICMP,
            V4_TIME_EXCEEDED,
            false
        ));
        assert!(is_hop_reply(
            libc::SO_EE_ORIGIN_ICMP,
            V4_DEST_UNREACHABLE,
            false
        ));
        // Echo reply (0) is never a hop answer.
        assert!(!is_hop_reply(libc::SO_EE_ORIGIN_ICMP, 0, false));
        // A local error (origin 1) is not an ICMP reply at all.
        assert!(!is_hop_reply(1, V4_TIME_EXCEEDED, false));
        // ICMPv6 origin on an IPv4 trace is rejected.
        assert!(!is_hop_reply(
            libc::SO_EE_ORIGIN_ICMP6,
            V4_TIME_EXCEEDED,
            false
        ));
    }

    #[test]
    fn hop_reply_types_v6() {
        assert!(is_hop_reply(
            libc::SO_EE_ORIGIN_ICMP6,
            V6_TIME_EXCEEDED,
            true
        ));
        assert!(is_hop_reply(
            libc::SO_EE_ORIGIN_ICMP6,
            V6_DEST_UNREACHABLE,
            true
        ));
        assert!(!is_hop_reply(libc::SO_EE_ORIGIN_ICMP6, 129, true));
        assert!(!is_hop_reply(
            libc::SO_EE_ORIGIN_ICMP,
            V6_TIME_EXCEEDED,
            true
        ));
    }

    /// Unprivileged end-to-end: tracing loopback needs no raw socket. The
    /// closed UDP port answers with ICMP Port Unreachable from 127.0.0.1, so
    /// the trace is one hop that reached the destination with all three RTTs.
    #[test]
    fn unprivileged_trace_reaches_loopback_in_one_hop() {
        let hops = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&hops);
        run_trace(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            5,
            move |hop| sink.lock().unwrap().push(hop),
            CancellationToken::new(),
        )
        .expect("unprivileged trace runs without CAP_NET_RAW");
        let hops = hops.lock().unwrap();
        assert_eq!(hops.len(), 1, "loopback is a single hop: {hops:?}");
        assert_eq!(hops[0].hop, 1);
        assert_eq!(hops[0].ip.as_deref(), Some("127.0.0.1"));
        assert!(hops[0].rtt_ms.iter().all(Option::is_some), "{hops:?}");
    }
}
