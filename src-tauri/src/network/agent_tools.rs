//! Network-tool keys, localities and `tool.*` params (#2190, #3731).
//!
//! Every built-in network tool runs a core `ToolRegistry` tool — on this
//! computer or, when its run-location resolves to an agent, from the agent's
//! registry behind `tool.*` (see [`super::tool_runner`]). This module holds what
//! both locations share: the per-tool run-location keys (which double as the
//! registry tool ids), each tool's [`Locality`], and the camelCase params the
//! tools take. Because one params object feeds both locations, a tool probes
//! identically wherever it runs.
//!
//! Run-location is a **desktop-side preference**: nothing here is baked into the
//! payload — an agent is simply asked to run a network probe from its own
//! vantage.

use serde::Deserialize;
use serde_json::{json, Value};

use termihub_core::network::defaults;
use termihub_core::network::types::OpenPort;

use crate::run_location::Locality;

/// Run-location preference keys for the built-in network tools (#2190).
///
/// Each key identifies a tool **type** (not an instance) in the desktop-side
/// per-tool run-location preference map on [`NetworkManager`](super::NetworkManager).
/// Every key but [`HTTP_MONITOR`](tool::HTTP_MONITOR) is also the tool's id in
/// the core `ToolRegistry`, so a key names the tool that runs.
pub mod tool {
    /// Ping session (streamed).
    pub const PING: &str = "ping";
    /// Traceroute (streamed).
    pub const TRACEROUTE: &str = "traceroute";
    /// TCP port scan (streamed).
    pub const PORT_SCAN: &str = "port_scan";
    /// DNS lookup (one-shot).
    pub const DNS: &str = "dns";
    /// Wake-on-LAN (one-shot).
    pub const WOL: &str = "wol";
    /// Open (listening) ports (one-shot, PROD-033). Routed to an agent it lists
    /// the **agent host's** listening ports.
    pub const OPEN_PORTS: &str = "open_ports";
    /// Ping sweep (streamed, PROD-033).
    pub const PING_SWEEP: &str = "ping_sweep";
    /// HTTP monitor — **not** a registry tool. As of #2592 a monitor *can* run on
    /// an agent, but through the per-monitor `service.*` hosting path
    /// ([`NetworkManager::start_agent_monitor`](super::NetworkManager)), not this
    /// per-tool-type network-tool preference. This key stays desktop-only here so
    /// the network-tool selector never offers it an agent over the wrong path.
    pub const HTTP_MONITOR: &str = "http_monitor";
}

/// The [`Locality`] of a network tool (#2190).
///
/// Every registry tool is [`Locality::LocalOrAgent`]; the HTTP monitor is
/// [`Locality::DesktopOnly`] on this per-tool-type path because a monitor is
/// agent-hosted per monitor via `service.*` instead, so the resolver must never
/// offer it an agent here.
pub fn locality_for(tool: &str) -> Locality {
    match tool {
        tool::HTTP_MONITOR => Locality::DesktopOnly,
        _ => Locality::LocalOrAgent,
    }
}

// ── Tool params (camelCase, as the core `ToolRegistry` tools take them) ───────
//
// Absent optionals get the documented defaults, so a run probes the same way
// on this computer and on an agent.

/// `port_scan` params. `targets` is the spec already expanded with the core
/// `parse_target_spec`, so every location probes exactly the same host set;
/// `host` keeps the raw spec alongside it.
pub fn port_scan_tool_params(
    host: &str,
    targets: &[String],
    ports: &str,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> Value {
    json!({
        "host": host,
        "targets": targets,
        "ports": ports,
        "timeoutMs": timeout_ms.unwrap_or(defaults::PORT_SCAN_TIMEOUT_MS),
        "concurrency": concurrency.unwrap_or(defaults::PORT_SCAN_CONCURRENCY),
    })
}

/// `ping` params. An absent count is kept: the ping runs until Stop (on an
/// agent, bounded only by its per-run lifetime cap).
pub fn ping_tool_params(host: &str, interval_ms: Option<u64>, count: Option<u32>) -> Value {
    json!({
        "host": host,
        "intervalMs": interval_ms.unwrap_or(defaults::PING_INTERVAL_MS),
        "count": count,
    })
}

/// `ping_sweep` params (`targets`, `timeoutMs`, `concurrency`,
/// `resolveHostnames`). The desktop expands the target spec itself, so the tool
/// receives the concrete address list.
pub fn ping_sweep_tool_params(
    targets: &[String],
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    resolve_hostnames: Option<bool>,
) -> Value {
    json!({
        "targets": targets,
        "timeoutMs": timeout_ms.unwrap_or(defaults::PING_SWEEP_TIMEOUT_MS),
        "concurrency": concurrency.unwrap_or(defaults::PING_SWEEP_CONCURRENCY),
        "resolveHostnames": resolve_hostnames.unwrap_or(defaults::PING_SWEEP_RESOLVE_HOSTNAMES),
    })
}

/// `traceroute` params.
pub fn traceroute_tool_params(host: &str, max_hops: Option<u8>) -> Value {
    json!({
        "host": host,
        "maxHops": max_hops.unwrap_or(defaults::TRACEROUTE_MAX_HOPS),
    })
}

/// `dns` params.
pub fn dns_tool_params(hostname: &str, record_type: &str, server: Option<&str>) -> Value {
    json!({
        "hostname": hostname,
        "recordType": record_type,
        "server": server,
    })
}

/// `wol` params.
pub fn wol_tool_params(mac: &str, broadcast: &str, port: u16) -> Value {
    json!({ "mac": mac, "broadcast": broadcast, "port": port })
}

/// The `open_ports` aggregate: `{ ports: [OpenPort] }`.
#[derive(Debug, Deserialize)]
struct OpenPortsResult {
    ports: Vec<OpenPort>,
}

/// Unwrap the `open_ports` aggregate into the bare port list the command
/// returns (the frontend cannot tell where it ran).
pub fn parse_open_ports_result(result: Value) -> Result<Vec<OpenPort>, serde_json::Error> {
    serde_json::from_value::<OpenPortsResult>(result).map(|r| r.ports)
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::tool::ToolRegistry;

    #[test]
    fn http_monitor_is_desktop_only_every_other_tool_is_routable() {
        assert_eq!(locality_for(tool::HTTP_MONITOR), Locality::DesktopOnly);
        for t in [
            tool::PING,
            tool::TRACEROUTE,
            tool::PORT_SCAN,
            tool::DNS,
            tool::WOL,
            tool::OPEN_PORTS,
            tool::PING_SWEEP,
        ] {
            assert_eq!(
                locality_for(t),
                Locality::LocalOrAgent,
                "{t} must be routable"
            );
        }
    }

    /// Every routable key is the id of a registered core tool, so the key the
    /// command resolves is the tool that runs (#3731).
    #[test]
    fn every_routable_key_is_a_registry_tool_id() {
        let registry = ToolRegistry::with_builtin_network_tools();
        for t in [
            tool::PING,
            tool::TRACEROUTE,
            tool::PORT_SCAN,
            tool::DNS,
            tool::WOL,
            tool::OPEN_PORTS,
            tool::PING_SWEEP,
        ] {
            assert!(registry.has_tool(t), "{t} is not a registry tool");
        }
        assert!(!registry.has_tool(tool::HTTP_MONITOR));
    }

    /// #3385 parity: for any spec, the targets the desktop sends (expanded
    /// locally with `parse_target_spec`) resolve in the tool to the same host
    /// set — and a tool given only the raw `host` expands it to that same set.
    #[test]
    fn port_scan_targets_match_the_tool_expansion() {
        use termihub_core::network::{parse_target_spec, resolve_targets};
        for spec in [
            "10.0.0.5",
            "scan.example",
            "192.168.0.0/28",
            "10.0.0.1, 192.168.1.0/30, scan.example",
        ] {
            let local = parse_target_spec(spec).unwrap();
            let params = port_scan_tool_params(spec, &local, "22", None, None);
            assert_eq!(params["targets"], json!(local), "{spec}: targets");
            let sent: Vec<String> = serde_json::from_value(params["targets"].clone()).unwrap();
            assert_eq!(resolve_targets(Some(spec), Some(&sent)).unwrap(), local);
            assert_eq!(resolve_targets(Some(spec), None).unwrap(), local);
        }
    }

    #[test]
    fn tool_params_are_camel_case_with_local_defaults() {
        assert_eq!(
            port_scan_tool_params("h", &["h".to_string()], "1-1024", None, Some(8)),
            json!({
                "host": "h",
                "targets": ["h"],
                "ports": "1-1024",
                "timeoutMs": defaults::PORT_SCAN_TIMEOUT_MS,
                "concurrency": 8,
            })
        );
        // A ping keeps an absent count (runs until Stop).
        assert_eq!(
            ping_tool_params("h", None, None),
            json!({ "host": "h", "intervalMs": defaults::PING_INTERVAL_MS, "count": null })
        );
        assert_eq!(ping_tool_params("h", Some(500), Some(3))["count"], 3);
        assert_eq!(
            traceroute_tool_params("h", None),
            json!({ "host": "h", "maxHops": defaults::TRACEROUTE_MAX_HOPS })
        );
        let targets = vec!["10.0.0.1".to_string(), "10.0.0.2".to_string()];
        assert_eq!(
            ping_sweep_tool_params(&targets, Some(250), Some(8), Some(false)),
            json!({
                "targets": ["10.0.0.1", "10.0.0.2"],
                "timeoutMs": 250,
                "concurrency": 8,
                "resolveHostnames": false,
            })
        );
        let d = ping_sweep_tool_params(&targets, None, None, None);
        assert_eq!(d["timeoutMs"], defaults::PING_SWEEP_TIMEOUT_MS);
        assert_eq!(d["concurrency"], defaults::PING_SWEEP_CONCURRENCY);
        assert_eq!(
            d["resolveHostnames"],
            defaults::PING_SWEEP_RESOLVE_HOSTNAMES
        );
        assert_eq!(
            dns_tool_params("example.com", "AAAA", Some("1.1.1.1")),
            json!({ "hostname": "example.com", "recordType": "AAAA", "server": "1.1.1.1" })
        );
        assert_eq!(
            dns_tool_params("example.com", "A", None)["server"],
            Value::Null
        );
        assert_eq!(
            wol_tool_params("aa:bb:cc:dd:ee:ff", "255.255.255.255", 9),
            json!({ "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "255.255.255.255", "port": 9 })
        );
    }

    #[test]
    fn open_ports_result_parses_into_bare_list() {
        // The `{ports}` aggregate of the `open_ports` tool; the command returns
        // the bare array.
        let result = json!({
            "ports": [
                { "protocol": "TCP", "localAddr": "0.0.0.0:22", "pid": 1, "process": "sshd" },
                { "protocol": "UDP", "localAddr": "[::]:53", "pid": null, "process": null }
            ]
        });
        let ports = parse_open_ports_result(result).unwrap();
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].local_addr, "0.0.0.0:22");
        assert_eq!(ports[0].pid, Some(1));
        assert_eq!(ports[1].process, None);

        let wire = serde_json::to_value(&ports).unwrap();
        assert!(wire.is_array());
        assert_eq!(wire[0]["localAddr"], "0.0.0.0:22");
    }

    #[test]
    fn open_ports_result_rejects_a_bare_array() {
        // The tool wraps the list under `ports`; a bare array is a contract
        // break and must surface as an error, not an empty list.
        assert!(parse_open_ports_result(json!([])).is_err());
    }
}
