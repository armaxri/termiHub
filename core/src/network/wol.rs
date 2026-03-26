//! Wake-on-LAN magic packet sender.
//!
//! Builds the standard 102-byte magic packet (6×0xFF + 16×MAC address) and
//! broadcasts it via UDP. WoL is fire-and-forget — there is no acknowledgement.

use std::net::UdpSocket;

use super::error::NetworkError;

/// Send a WoL magic packet for `mac` to `broadcast:port`.
///
/// # Arguments
/// * `mac` – MAC address in any common format (`AA:BB:CC:DD:EE:FF`,
///   `AA-BB-CC-DD-EE-FF`, or `AABBCCDDEEFF`).
/// * `broadcast` – Broadcast address string (e.g. `"255.255.255.255"` or
///   `"192.168.1.255"`).
/// * `port` – UDP port (conventionally 7 or 9).
pub fn send_magic_packet(mac: &str, broadcast: &str, port: u16) -> Result<(), NetworkError> {
    let mac_bytes = parse_mac(mac)?;
    let packet = build_magic_packet(&mac_bytes);

    let target: std::net::SocketAddr = format!("{broadcast}:{port}").parse().map_err(|_| {
        NetworkError::InvalidParameter(format!("invalid broadcast address: '{broadcast}:{port}'"))
    })?;

    // Bind to 0.0.0.0:0, enable broadcast, send.
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.set_broadcast(true)?;
    socket.send_to(&packet, target)?;

    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Parse a MAC address string into 6 bytes.
pub fn parse_mac(mac: &str) -> Result<[u8; 6], NetworkError> {
    // Normalise: remove colons, hyphens, and dots.
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();

    if hex.len() != 12 {
        return Err(NetworkError::InvalidParameter(format!(
            "invalid MAC address '{mac}': expected 12 hex digits, got {}",
            hex.len()
        )));
    }

    let mut bytes = [0u8; 6];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| NetworkError::InvalidParameter(format!("invalid MAC address '{mac}'")))?;
    }
    Ok(bytes)
}

fn build_magic_packet(mac: &[u8; 6]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(102);
    // 6 bytes of 0xFF
    packet.extend_from_slice(&[0xFF; 6]);
    // 16 repetitions of the MAC address
    for _ in 0..16 {
        packet.extend_from_slice(mac);
    }
    packet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_colon_mac() {
        let bytes = parse_mac("AA:BB:CC:DD:EE:FF").unwrap();
        assert_eq!(bytes, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_hyphen_mac() {
        let bytes = parse_mac("AA-BB-CC-DD-EE-FF").unwrap();
        assert_eq!(bytes, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_bare_mac() {
        let bytes = parse_mac("AABBCCDDEEFF").unwrap();
        assert_eq!(bytes, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_lowercase_mac() {
        let bytes = parse_mac("aa:bb:cc:dd:ee:ff").unwrap();
        assert_eq!(bytes, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_invalid_mac_too_short() {
        assert!(parse_mac("AA:BB:CC").is_err());
    }

    #[test]
    fn parse_invalid_mac_bad_chars() {
        assert!(parse_mac("ZZ:BB:CC:DD:EE:FF").is_err());
    }

    #[test]
    fn magic_packet_length() {
        let mac = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
        let packet = build_magic_packet(&mac);
        assert_eq!(packet.len(), 102);
    }

    #[test]
    fn magic_packet_header() {
        let mac = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
        let packet = build_magic_packet(&mac);
        assert_eq!(&packet[0..6], &[0xFF; 6]);
    }

    #[test]
    fn magic_packet_mac_repetitions() {
        let mac = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
        let packet = build_magic_packet(&mac);
        for i in 0..16 {
            let offset = 6 + i * 6;
            assert_eq!(&packet[offset..offset + 6], &mac);
        }
    }
}
