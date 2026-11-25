//! Why a service does not run, as far as its row can offer a remedy (#6063).

use serde::{Deserialize, Serialize};

/// The kind of cause behind a service's reason. The reason is for reading, this
/// is for choosing the button beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum ServiceCause {
    /// Something else listens on its port.
    PortInUse,
    /// The agent it runs on is not connected.
    AgentOffline,
    /// The agent it runs on is connected and does not answer about it.
    AgentSilent,
    /// A password it needs is behind the locked credential store.
    StoreLocked,
    /// Its SSH connection could not be made.
    Connection,
    /// A cause of a newer build.
    #[serde(other)]
    Other,
}

/// Whether something else already listens on TCP `host`:`port`.
pub fn tcp_port_in_use(host: &str, port: u16) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(
        std::net::TcpListener::bind((host, port)),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse
    )
}

/// Whether something else already listens on UDP `host`:`port`.
pub fn udp_port_in_use(host: &str, port: u16) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(
        std::net::UdpSocket::bind((host, port)),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse
    )
}

/// The reason to show for a taken port.
pub fn port_in_use_reason(port: u16) -> String {
    format!("Port {port} is already in use. Choose another one, or stop what uses it.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_port_is_told_from_a_free_one_and_from_another_failure() {
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = tcp.local_addr().unwrap().port();
        assert!(tcp_port_in_use("127.0.0.1", taken));
        drop(tcp);
        let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        assert!(udp_port_in_use(
            "127.0.0.1",
            udp.local_addr().unwrap().port()
        ));
        assert!(!udp_port_in_use("127.0.0.1", 0));
        assert!(!tcp_port_in_use("[::1]", 0));
        // Not an address of this machine: no port is taken there.
        assert!(!tcp_port_in_use("192.0.2.1", taken));
        assert!(!tcp_port_in_use("no such host.invalid", 80));
    }

    #[test]
    fn the_wire_names_are_stable_and_a_newer_cause_still_reads() {
        for (cause, wire) in [
            (ServiceCause::PortInUse, "\"portInUse\""),
            (ServiceCause::AgentOffline, "\"agentOffline\""),
            (ServiceCause::AgentSilent, "\"agentSilent\""),
            (ServiceCause::StoreLocked, "\"storeLocked\""),
            (ServiceCause::Connection, "\"connection\""),
        ] {
            assert_eq!(serde_json::to_string(&cause).unwrap(), wire);
            assert_eq!(serde_json::from_str::<ServiceCause>(wire).unwrap(), cause);
        }
        let newer: ServiceCause = serde_json::from_str("\"diskFull\"").unwrap();
        assert_eq!(newer, ServiceCause::Other);
    }
}
