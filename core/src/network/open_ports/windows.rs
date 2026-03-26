//! Open ports listing for Windows via `netstat -ano` subprocess.
//!
//! We use `netstat -ano` rather than the raw Win32 API to avoid adding the
//! `windows-sys` feature just for this. The output is well-structured and
//! available on all Windows versions supported by termiHub.

use crate::network::error::NetworkError;
use crate::network::types::{OpenPort, Protocol};

pub fn list_open_ports() -> Result<Vec<OpenPort>, NetworkError> {
    let output = std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
        .map_err(|e| NetworkError::Platform(format!("netstat failed: {e}")))?;

    let text = String::from_utf8_lossy(&output.stdout);
    parse_netstat_output(&text)
}

fn parse_netstat_output(text: &str) -> Result<Vec<OpenPort>, NetworkError> {
    let mut ports = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        let cols: Vec<&str> = line.split_whitespace().collect();

        // Expected format:
        // Proto  LocalAddress  ForeignAddress  State  PID
        // TCP    0.0.0.0:22    0.0.0.0:0       LISTENING  1234
        // UDP    0.0.0.0:68    *:*                        5678
        if cols.len() < 4 {
            continue;
        }

        let proto_str = cols[0].to_uppercase();
        let protocol = match proto_str.as_str() {
            "TCP" | "TCP6" => Protocol::Tcp,
            "UDP" | "UDP6" => Protocol::Udp,
            _ => continue,
        };

        let local_addr = cols[1].to_string();

        match protocol {
            Protocol::Tcp => {
                // Only include LISTENING state.
                if cols.len() < 5 {
                    continue;
                }
                let state = cols[3].to_uppercase();
                if state != "LISTENING" {
                    continue;
                }
                let pid: Option<u32> = cols[4].parse().ok();
                let process = pid.and_then(|p| lookup_process_name(p));

                ports.push(OpenPort {
                    protocol,
                    local_addr,
                    pid,
                    process,
                });
            }
            Protocol::Udp => {
                // UDP has no state column.
                let pid: Option<u32> = cols[3].parse().ok();
                let process = pid.and_then(|p| lookup_process_name(p));

                ports.push(OpenPort {
                    protocol,
                    local_addr,
                    pid,
                    process,
                });
            }
        }
    }

    Ok(ports)
}

/// Attempt to resolve a PID to a process name via `tasklist /FI "PID eq <pid>"`.
fn lookup_process_name(pid: u32) -> Option<String> {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stdout);
    // CSV line: "process.exe","1234","Console","1","10,000 K"
    for line in text.lines() {
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() >= 2 {
            let name = cols[0].trim_matches('"').to_string();
            // Strip .exe suffix for consistency with Unix.
            return Some(name.trim_end_matches(".exe").to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tcp_listening() {
        let text = "  Proto  Local Address          Foreign Address        State           PID\n\
                    TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       1234\n";
        let ports = parse_netstat_output(text).unwrap();
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].protocol, Protocol::Tcp);
        assert_eq!(ports[0].local_addr, "0.0.0.0:22");
        assert_eq!(ports[0].pid, Some(1234));
    }

    #[test]
    fn parse_tcp_established_excluded() {
        let text = "  Proto  Local Address          Foreign Address        State           PID\n\
                    TCP    0.0.0.0:22             10.0.0.1:54321         ESTABLISHED     1234\n";
        let ports = parse_netstat_output(text).unwrap();
        assert!(ports.is_empty());
    }

    #[test]
    fn parse_udp_port() {
        let text = "  Proto  Local Address          Foreign Address        \n\
                    UDP    0.0.0.0:68             *:*                                    5678\n";
        let ports = parse_netstat_output(text).unwrap();
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].protocol, Protocol::Udp);
        assert_eq!(ports[0].local_addr, "0.0.0.0:68");
    }
}
