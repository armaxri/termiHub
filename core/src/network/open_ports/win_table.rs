//! Platform-independent formatting of the Windows socket-owner tables into
//! [`OpenPort`] rows (#3814).
//!
//! The Windows listing reads `GetExtendedTcpTable` / `GetExtendedUdpTable` and
//! a Toolhelp process snapshot instead of spawning `netstat` + one `tasklist`
//! per socket. This module holds the pure half — address/port decoding and PID
//! → name resolution — so it is unit-tested on every CI leg. The output matches
//! what the old `netstat -ano` + `tasklist` path produced:
//!
//! - `local_addr` is `a.b.c.d:port` for IPv4 and `[addr]:port` (with a `%scope`
//!   suffix for a scoped address) for IPv6, exactly as `netstat` prints it.
//! - `process` is the image name without its `.exe` suffix; PID 0 is
//!   `System Idle Process`, as `tasklist` names it.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};

use crate::network::types::{OpenPort, Protocol};

/// Name `tasklist` gives PID 0 (the Toolhelp snapshot calls it
/// `[System Process]`).
const IDLE_PROCESS_NAME: &str = "System Idle Process";

/// One socket row decoded from a Win32 owner-PID table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SocketRow {
    pub protocol: Protocol,
    pub local_addr: String,
    pub pid: u32,
}

/// Decode a table's `dwLocalPort`: the port in network byte order in the low
/// 16 bits.
pub(super) fn port_from_dword(port: u32) -> u16 {
    u16::from_be((port & 0xFFFF) as u16)
}

/// Format an IPv4 endpoint from a table's `dwLocalAddr` (network byte order)
/// and `dwLocalPort`, as `netstat` prints it (`0.0.0.0:135`).
pub(super) fn format_ipv4_endpoint(addr: u32, port: u32) -> String {
    let ip = Ipv4Addr::from(addr.to_ne_bytes());
    format!("{ip}:{}", port_from_dword(port))
}

/// Format an IPv6 endpoint from a table's `ucLocalAddr`, `dwLocalScopeId` and
/// `dwLocalPort`, as `netstat` prints it (`[::]:135`, `[fe80::1%12]:1900`).
pub(super) fn format_ipv6_endpoint(addr: [u8; 16], scope_id: u32, port: u32) -> String {
    let ip = Ipv6Addr::from(addr);
    let port = port_from_dword(port);
    if scope_id == 0 {
        format!("[{ip}]:{port}")
    } else {
        format!("[{ip}%{scope_id}]:{port}")
    }
}

/// Decode a NUL-terminated UTF-16 `szExeFile` buffer.
pub(super) fn exe_name_from_wide(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len])
}

/// The display name for a process, consistent with the Unix listing: the image
/// name without a trailing `.exe`, and `tasklist`'s name for PID 0.
pub(super) fn process_display_name(pid: u32, exe: &str) -> String {
    if pid == 0 {
        return IDLE_PROCESS_NAME.to_string();
    }
    exe.trim_end_matches(".exe").to_string()
}

/// Build a PID → display-name map from `(pid, szExeFile)` snapshot entries.
pub(super) fn process_name_map<I>(entries: I) -> HashMap<u32, String>
where
    I: IntoIterator<Item = (u32, String)>,
{
    entries
        .into_iter()
        .map(|(pid, exe)| (pid, process_display_name(pid, &exe)))
        .collect()
}

/// Join socket rows with the process-name map. A PID missing from the map
/// (the process exited between the two snapshots) yields `process: None`.
pub(super) fn build_open_ports(
    rows: Vec<SocketRow>,
    names: &HashMap<u32, String>,
) -> Vec<OpenPort> {
    rows.into_iter()
        .map(|row| OpenPort {
            process: names.get(&row.pid).cloned(),
            protocol: row.protocol,
            local_addr: row.local_addr,
            pid: Some(row.pid),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `dwLocalPort` exactly as the Win32 table stores it on a little-endian
    /// host: the network-order bytes in the low word.
    fn wire_port(port: u16) -> u32 {
        u32::from(u16::from_ne_bytes(port.to_be_bytes()))
    }

    /// `dwLocalAddr` exactly as the Win32 table stores it: network-order bytes.
    fn wire_ipv4(a: u8, b: u8, c: u8, d: u8) -> u32 {
        u32::from_ne_bytes([a, b, c, d])
    }

    #[test]
    fn decodes_network_order_port() {
        assert_eq!(port_from_dword(wire_port(22)), 22);
        assert_eq!(port_from_dword(wire_port(135)), 135);
        assert_eq!(port_from_dword(wire_port(49664)), 49664);
        // Garbage in the high word is ignored.
        assert_eq!(port_from_dword(wire_port(445) | 0xABCD_0000), 445);
    }

    #[test]
    fn formats_ipv4_like_netstat() {
        assert_eq!(
            format_ipv4_endpoint(wire_ipv4(0, 0, 0, 0), wire_port(135)),
            "0.0.0.0:135"
        );
        assert_eq!(
            format_ipv4_endpoint(wire_ipv4(127, 0, 0, 1), wire_port(5354)),
            "127.0.0.1:5354"
        );
        assert_eq!(
            format_ipv4_endpoint(wire_ipv4(192, 168, 1, 23), wire_port(139)),
            "192.168.1.23:139"
        );
    }

    #[test]
    fn formats_ipv6_like_netstat() {
        assert_eq!(format_ipv6_endpoint([0; 16], 0, wire_port(135)), "[::]:135");
        let mut loopback = [0u8; 16];
        loopback[15] = 1;
        assert_eq!(
            format_ipv6_endpoint(loopback, 0, wire_port(49664)),
            "[::1]:49664"
        );
        let link_local = "fe80::1c2a:3bff:fe4d:5e6f"
            .parse::<Ipv6Addr>()
            .unwrap()
            .octets();
        assert_eq!(
            format_ipv6_endpoint(link_local, 12, wire_port(1900)),
            "[fe80::1c2a:3bff:fe4d:5e6f%12]:1900"
        );
    }

    #[test]
    fn decodes_wide_exe_name() {
        let mut wide = [0u16; 260];
        for (i, c) in "svchost.exe".encode_utf16().enumerate() {
            wide[i] = c;
        }
        assert_eq!(exe_name_from_wide(&wide), "svchost.exe");
        assert_eq!(exe_name_from_wide(&[]), "");
        let full: Vec<u16> = "no-nul.exe".encode_utf16().collect();
        assert_eq!(exe_name_from_wide(&full), "no-nul.exe");
    }

    #[test]
    fn process_names_match_tasklist() {
        let names = process_name_map([
            (0, "[System Process]".to_string()),
            (4, "System".to_string()),
            (1044, "svchost.exe".to_string()),
            (3312, "sshd.exe".to_string()),
            (7788, "termihub.exe".to_string()),
        ]);
        assert_eq!(names[&0], "System Idle Process");
        assert_eq!(names[&4], "System");
        assert_eq!(names[&1044], "svchost");
        assert_eq!(names[&3312], "sshd");
        assert_eq!(names[&7788], "termihub");
    }

    #[test]
    fn builds_rows_with_resolved_names_in_table_order() {
        let rows = vec![
            SocketRow {
                protocol: Protocol::Tcp,
                local_addr: format_ipv4_endpoint(wire_ipv4(0, 0, 0, 0), wire_port(22)),
                pid: 3312,
            },
            SocketRow {
                protocol: Protocol::Tcp,
                local_addr: format_ipv6_endpoint([0; 16], 0, wire_port(135)),
                pid: 1044,
            },
            SocketRow {
                protocol: Protocol::Udp,
                local_addr: format_ipv4_endpoint(wire_ipv4(0, 0, 0, 0), wire_port(68)),
                pid: 5678,
            },
        ];
        let names = process_name_map([
            (3312, "sshd.exe".to_string()),
            (1044, "svchost.exe".to_string()),
        ]);
        let ports = build_open_ports(rows, &names);
        assert_eq!(ports.len(), 3);

        assert_eq!(ports[0].protocol, Protocol::Tcp);
        assert_eq!(ports[0].local_addr, "0.0.0.0:22");
        assert_eq!(ports[0].pid, Some(3312));
        assert_eq!(ports[0].process.as_deref(), Some("sshd"));

        assert_eq!(ports[1].local_addr, "[::]:135");
        assert_eq!(ports[1].process.as_deref(), Some("svchost"));

        // PID that exited between the socket and process snapshots.
        assert_eq!(ports[2].protocol, Protocol::Udp);
        assert_eq!(ports[2].local_addr, "0.0.0.0:68");
        assert_eq!(ports[2].pid, Some(5678));
        assert_eq!(ports[2].process, None);
    }
}
