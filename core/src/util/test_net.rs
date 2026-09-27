//! Deterministic network fixtures for tests.

use std::net::{Ipv4Addr, SocketAddr};

use socket2::{Domain, Protocol, Socket, Type};

/// A loopback TCP address that no connection can succeed against for as long as
/// the returned socket is alive.
///
/// The socket is bound but never `listen`s, and — without `SO_REUSEADDR` — no
/// other socket can bind the port while it is held. A connect to it fails:
/// Linux and Windows answer with a reset (connection refused), macOS silently
/// drops the SYN so the connect times out. Callers must therefore assert only
/// that the connect *fails*, with a short timeout. This replaces the racy
/// "bind a listener, read its port, drop it" idiom, whose freed ephemeral port
/// can be reassigned to a concurrent test's live listener before the connect,
/// turning an expected refusal into a success (#3532).
pub(crate) fn unconnectable_tcp_addr() -> (Socket, SocketAddr) {
    let socket =
        Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).expect("create TCP socket");
    socket
        .bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, 0)).into())
        .expect("bind loopback TCP socket");
    let addr = socket
        .local_addr()
        .expect("local addr")
        .as_socket()
        .expect("an IP socket address");
    (socket, addr)
}

/// A loopback UDP address that no other socket receives on, and that no other
/// socket can bind, for as long as the returned socket is alive.
///
/// The socket is bound to an ephemeral port and then `connect`ed to *itself*, so
/// the kernel delivers it only datagrams whose source is its own address. A
/// datagram from any other socket therefore finds no receiver — exactly like a
/// closed port (Linux and macOS answer with ICMP port-unreachable, which Windows
/// surfaces on the sender as `WSAECONNRESET`) — while the held bind keeps the
/// port from being reassigned to a concurrent test's server. This replaces the
/// racy "bind a UDP socket, read its port, drop it" idiom (#3533).
pub(crate) fn unreachable_udp_addr() -> (std::net::UdpSocket, SocketAddr) {
    let socket = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback UDP");
    let addr = socket.local_addr().expect("local addr");
    socket.connect(addr).expect("connect UDP socket to itself");
    (socket, addr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_held_addr_rejects_connections() {
        let (_held, addr) = unconnectable_tcp_addr();
        assert!(std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err());
    }

    #[test]
    fn a_held_addr_cannot_be_bound_by_a_listener() {
        let (_held, addr) = unconnectable_tcp_addr();
        assert!(std::net::TcpListener::bind(addr).is_err());
    }

    #[test]
    fn a_held_udp_addr_receives_nothing_from_other_sockets() {
        let (held, addr) = unreachable_udp_addr();
        let sender = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind sender");
        // The send itself may already fail on a platform that reports the
        // unreachable port eagerly; either way nothing may be delivered.
        let _ = sender.send_to(b"stray", addr);
        held.set_read_timeout(Some(Duration::from_millis(200)))
            .expect("set read timeout");
        let mut buf = [0u8; 16];
        assert!(
            held.recv(&mut buf).is_err(),
            "a self-connected socket must not receive another socket's datagram"
        );
    }

    #[test]
    fn a_held_udp_addr_cannot_be_bound() {
        let (_held, addr) = unreachable_udp_addr();
        assert!(std::net::UdpSocket::bind(addr).is_err());
    }
}
