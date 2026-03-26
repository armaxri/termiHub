//! Open ports listing for Unix platforms (macOS + Linux).
//!
//! - **macOS**: spawns `lsof -iTCP -sTCP:LISTEN -iUDP -P -n` and parses output.
//! - **Linux**: reads `/proc/net/tcp`, `/proc/net/tcp6`, `/proc/net/udp`,
//!   `/proc/net/udp6` and correlates PIDs via `/proc/<pid>/fd/`.

#[cfg(target_os = "linux")]
use std::collections::HashMap;

use crate::network::error::NetworkError;
use crate::network::types::{OpenPort, Protocol};

pub fn list_open_ports() -> Result<Vec<OpenPort>, NetworkError> {
    #[cfg(target_os = "macos")]
    {
        list_via_lsof()
    }
    #[cfg(target_os = "linux")]
    {
        list_via_proc()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        // FreeBSD and other Unixes: fall back to lsof if available.
        list_via_lsof()
    }
}

// ── macOS (and other BSDs): lsof ─────────────────────────────────────────────

#[cfg(any(
    target_os = "macos",
    not(any(target_os = "macos", target_os = "linux"))
))]
fn list_via_lsof() -> Result<Vec<OpenPort>, NetworkError> {
    let output = std::process::Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-iUDP", "-P", "-n"])
        .output()
        .map_err(|e| NetworkError::Platform(format!("lsof failed: {e}")))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Err(NetworkError::Platform("lsof returned no output".into()));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    parse_lsof_output(&text)
}

fn parse_lsof_output(text: &str) -> Result<Vec<OpenPort>, NetworkError> {
    let mut ports = Vec::new();

    for line in text.lines().skip(1) {
        // COMMAND   PID   USER   FD   TYPE  DEVICE  ...  NAME
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 {
            continue;
        }
        let process = cols[0].to_string();
        let pid: Option<u32> = cols[1].parse().ok();
        let name_col = cols[cols.len() - 1]; // last column is the address
        let proto_col = cols[7]; // TYPE column (TCP or UDP)

        let protocol = if proto_col.contains("TCP") || name_col.contains("TCP") {
            Protocol::Tcp
        } else if proto_col.contains("UDP") || name_col.contains("UDP") {
            Protocol::Udp
        } else {
            continue;
        };

        // NAME column looks like: *:22 or 127.0.0.1:5432 or [::1]:443
        // For UDP it may be *:5353 (LISTEN) or just *:5353
        let local_addr = name_col
            .split("->")
            .next()
            .unwrap_or(name_col)
            .trim()
            .to_string();

        if local_addr.is_empty() {
            continue;
        }

        ports.push(OpenPort {
            protocol,
            local_addr,
            pid,
            process: Some(process),
        });
    }

    Ok(ports)
}

// ── Linux: /proc/net ──────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn list_via_proc() -> Result<Vec<OpenPort>, NetworkError> {
    let inode_to_pid = build_inode_to_pid_map();
    let mut ports = Vec::new();

    for (path, proto) in &[
        ("/proc/net/tcp", Protocol::Tcp),
        ("/proc/net/tcp6", Protocol::Tcp),
        ("/proc/net/udp", Protocol::Udp),
        ("/proc/net/udp6", Protocol::Udp),
    ] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines().skip(1) {
                if let Some(port) = parse_proc_net_line(line, proto.clone(), &inode_to_pid) {
                    ports.push(port);
                }
            }
        }
    }

    Ok(ports)
}

/// TCP state 0x0A = LISTEN; UDP has no state — treat all as listening.
#[cfg(target_os = "linux")]
fn parse_proc_net_line(
    line: &str,
    protocol: Protocol,
    inode_to_pid: &HashMap<u64, (u32, String)>,
) -> Option<OpenPort> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    // Columns: sl local_address rem_address st tx_queue rx_queue tr tm:when retrnsmt uid timeout inode
    if cols.len() < 10 {
        return None;
    }

    let state_hex = cols[3];
    // For TCP: only LISTEN (0x0A). For UDP: state is always 07 (close); include all.
    if protocol == Protocol::Tcp {
        if state_hex != "0A" {
            return None;
        }
    }

    let local_hex = cols[1]; // "0100007F:0035" (little-endian hex IP:port)
    let local_addr = hex_addr_to_string(local_hex)?;

    let inode: u64 = cols[9].parse().ok()?;
    let (pid, process) = inode_to_pid.get(&inode).cloned().unzip();

    Some(OpenPort {
        protocol,
        local_addr,
        pid,
        process,
    })
}

/// Convert `/proc/net/tcp` hex address `"0100007F:0050"` to `"127.0.0.1:80"`.
#[cfg(target_os = "linux")]
fn hex_addr_to_string(hex: &str) -> Option<String> {
    let (addr_hex, port_hex) = hex.split_once(':')?;

    // IPv4: 8 hex chars (little-endian u32)
    // IPv6: 32 hex chars (4 little-endian u32s)
    let port = u16::from_str_radix(port_hex, 16).ok()?;

    if addr_hex.len() == 8 {
        let n = u32::from_str_radix(addr_hex, 16).ok()?;
        let ip = std::net::Ipv4Addr::from(n.to_be());
        Some(format!("{ip}:{port}"))
    } else if addr_hex.len() == 32 {
        // Parse four little-endian u32s.
        let mut words = [0u32; 4];
        for (i, word) in words.iter_mut().enumerate() {
            *word = u32::from_str_radix(&addr_hex[i * 8..(i + 1) * 8], 16).ok()?;
        }
        let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_be_bytes()).collect();
        let ip = std::net::Ipv6Addr::from(<[u8; 16]>::try_from(bytes.as_slice()).ok()?);
        Some(format!("[{ip}]:{port}"))
    } else {
        None
    }
}

/// Build a map from inode → (pid, process_name) by scanning `/proc/<pid>/fd/`.
#[cfg(target_os = "linux")]
fn build_inode_to_pid_map() -> HashMap<u64, (u32, String)> {
    let mut map = HashMap::new();

    let proc_dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => return map,
    };

    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let pid: u32 = match name_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };

        let comm_path = entry.path().join("comm");
        let process_name = std::fs::read_to_string(&comm_path)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        let fd_dir = entry.path().join("fd");
        let fd_entries = match std::fs::read_dir(&fd_dir) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for fd_entry in fd_entries.flatten() {
            if let Ok(link) = std::fs::read_link(fd_entry.path()) {
                let link_str = link.to_string_lossy();
                // socket:[12345] format
                if let Some(inode_str) = link_str
                    .strip_prefix("socket:[")
                    .and_then(|s| s.strip_suffix(']'))
                {
                    if let Ok(inode) = inode_str.parse::<u64>() {
                        map.insert(inode, (pid, process_name.clone()));
                    }
                }
            }
        }
    }

    map
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn hex_addr_ipv4() {
        // 0100007F = 127.0.0.1 (little-endian), port 0x0016 = 22
        let result = hex_addr_to_string("0100007F:0016").unwrap();
        assert_eq!(result, "127.0.0.1:22");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn hex_addr_any() {
        // 00000000 = 0.0.0.0, port 0x0050 = 80
        let result = hex_addr_to_string("00000000:0050").unwrap();
        assert_eq!(result, "0.0.0.0:80");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn hex_addr_invalid() {
        assert!(hex_addr_to_string("ZZZZ:0050").is_none());
    }
}
