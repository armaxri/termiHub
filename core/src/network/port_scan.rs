//! TCP connect-based port scanner.
//!
//! Performs TCP connect scans only — no SYN/stealth scanning.
//! Results are streamed to the caller via a callback as each probe completes.

use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::error::NetworkError;
use super::types::{PortScanResult, PortScanSummary, PortState};

/// Scan a set of TCP ports on a host, streaming individual results via `on_result`.
///
/// # Arguments
/// * `host` – Target hostname or IP address.
/// * `ports` – Slice of port numbers to scan.
/// * `timeout_ms` – Per-port connection timeout in milliseconds.
/// * `concurrency` – Maximum number of simultaneous probes.
/// * `on_result` – Callback invoked for each completed probe (may be called from
///   multiple tasks concurrently).
/// * `cancel` – Token to abort the scan early.
///
/// Returns a [`PortScanSummary`] on completion (including partial results after
/// cancellation).
pub async fn scan_ports(
    host: &str,
    ports: &[u16],
    timeout_ms: u64,
    concurrency: usize,
    on_result: impl Fn(PortScanResult) + Send + Sync + 'static,
    cancel: CancellationToken,
) -> Result<PortScanSummary, NetworkError> {
    let concurrency = concurrency.max(1);
    let timeout = Duration::from_millis(timeout_ms);
    let sem = Arc::new(Semaphore::new(concurrency));
    let on_result = Arc::new(on_result);

    let started = Instant::now();
    let mut handles = Vec::with_capacity(ports.len());

    for &port in ports {
        if cancel.is_cancelled() {
            break;
        }

        let permit = Arc::clone(&sem)
            .acquire_owned()
            .await
            .map_err(|_| NetworkError::Cancelled)?;

        let host = host.to_string();
        let cb = Arc::clone(&on_result);
        let cancel = cancel.clone();

        let handle = tokio::spawn(async move {
            let _permit = permit;
            if cancel.is_cancelled() {
                return None;
            }

            let result = probe_port(&host, port, timeout).await;
            cb(result.clone());
            Some(result)
        });

        handles.push(handle);
    }

    let mut open = 0u32;
    let mut closed = 0u32;
    let mut filtered = 0u32;

    for handle in handles {
        if let Ok(Some(result)) = handle.await {
            match result.state {
                PortState::Open => open += 1,
                PortState::Closed => closed += 1,
                PortState::Filtered => filtered += 1,
            }
        }
    }

    Ok(PortScanSummary {
        total: open + closed + filtered,
        open,
        closed,
        filtered,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Probe a single TCP port. Never fails — connection errors map to PortState variants.
async fn probe_port(host: &str, port: u16, timeout: Duration) -> PortScanResult {
    let addr_str = format!("{host}:{port}");

    // Resolve the address synchronously (ToSocketAddrs is blocking).
    let addr = match tokio::task::spawn_blocking({
        let addr_str = addr_str.clone();
        move || addr_str.to_socket_addrs().ok().and_then(|mut it| it.next())
    })
    .await
    {
        Ok(Some(addr)) => addr,
        _ => {
            return PortScanResult {
                port,
                state: PortState::Filtered,
                latency_ms: None,
            }
        }
    };

    let started = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => PortScanResult {
            port,
            state: PortState::Open,
            latency_ms: Some(started.elapsed().as_millis() as u64),
        },
        Ok(Err(e)) => {
            // Connection refused → Closed; anything else (network unreachable,
            // host unreachable, etc.) → Filtered.
            let state = if e.kind() == std::io::ErrorKind::ConnectionRefused {
                PortState::Closed
            } else {
                PortState::Filtered
            };
            PortScanResult {
                port,
                state,
                latency_ms: None,
            }
        }
        Err(_timeout) => PortScanResult {
            port,
            state: PortState::Filtered,
            latency_ms: None,
        },
    }
}

/// Maximum number of expanded targets accepted from a target spec.
///
/// Guards against accidental large scans (e.g. someone pasting `0.0.0.0/0`).
/// `/16` already expands to 65 534 hosts — anything above that is almost
/// certainly a mistake and would risk creating a denial-of-service
/// situation on the local network.
pub const MAX_EXPANDED_TARGETS: usize = 65_536;

/// Parse a human-readable target specification into a list of hostnames / IPs.
///
/// Accepted formats (comma-separated, mixed freely):
/// - Single hostname: `"example.com"`
/// - Single IPv4 / IPv6: `"192.168.1.1"`, `"::1"`
/// - CIDR (IPv4 or IPv6): `"192.168.0.0/24"`, `"2001:db8::/120"`
///
/// CIDR ranges expand to their host addresses (network and broadcast
/// addresses are excluded for IPv4 prefixes shorter than `/31`). Returns
/// [`NetworkError::InvalidParameter`] if any token is malformed, the spec
/// is empty, or the expansion exceeds [`MAX_EXPANDED_TARGETS`].
pub fn parse_target_spec(_spec: &str) -> Result<Vec<String>, NetworkError> {
    // Stub — implementation lands in the next commit (TDD red phase).
    Err(NetworkError::InvalidParameter(
        "parse_target_spec is not yet implemented".into(),
    ))
}

/// Parse a human-readable port specification into a list of port numbers.
///
/// Accepted formats:
/// - Single port: `"22"`
/// - Comma-separated: `"22,80,443"`
/// - Range: `"8000-8080"`
/// - Mixed: `"22,80,8000-8080,443"`
pub fn parse_port_spec(spec: &str) -> Result<Vec<u16>, NetworkError> {
    let mut ports = Vec::new();

    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }

        if let Some((start, end)) = part.split_once('-') {
            let start: u16 = start
                .trim()
                .parse()
                .map_err(|_| NetworkError::InvalidParameter(format!("invalid port: '{start}'")))?;
            let end: u16 = end
                .trim()
                .parse()
                .map_err(|_| NetworkError::InvalidParameter(format!("invalid port: '{end}'")))?;
            if start > end {
                return Err(NetworkError::InvalidParameter(format!(
                    "port range {start}-{end}: start must be <= end"
                )));
            }
            ports.extend(start..=end);
        } else {
            let port: u16 = part
                .parse()
                .map_err(|_| NetworkError::InvalidParameter(format!("invalid port: '{part}'")))?;
            ports.push(port);
        }
    }

    if ports.is_empty() {
        return Err(NetworkError::InvalidParameter(
            "port specification is empty".into(),
        ));
    }

    Ok(ports)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_port() {
        assert_eq!(parse_port_spec("80").unwrap(), vec![80]);
    }

    #[test]
    fn parse_comma_separated() {
        assert_eq!(parse_port_spec("22,80,443").unwrap(), vec![22, 80, 443]);
    }

    #[test]
    fn parse_range() {
        assert_eq!(
            parse_port_spec("8080-8083").unwrap(),
            vec![8080, 8081, 8082, 8083]
        );
    }

    #[test]
    fn parse_mixed() {
        assert_eq!(
            parse_port_spec("22,80-82,443").unwrap(),
            vec![22, 80, 81, 82, 443]
        );
    }

    #[test]
    fn parse_invalid_port() {
        assert!(parse_port_spec("abc").is_err());
    }

    #[test]
    fn parse_invalid_range_order() {
        assert!(parse_port_spec("443-80").is_err());
    }

    #[test]
    fn parse_empty_spec() {
        assert!(parse_port_spec("").is_err());
    }

    // ── parse_target_spec ────────────────────────────────────────────────────

    #[test]
    fn parse_target_single_ipv4() {
        assert_eq!(
            parse_target_spec("192.168.1.10").unwrap(),
            vec!["192.168.1.10".to_string()]
        );
    }

    #[test]
    fn parse_target_single_ipv6() {
        assert_eq!(
            parse_target_spec("::1").unwrap(),
            vec!["::1".to_string()]
        );
    }

    #[test]
    fn parse_target_hostname_passthrough() {
        // Hostnames are not parseable as IPs and must pass through unchanged
        // for downstream DNS resolution.
        assert_eq!(
            parse_target_spec("example.com").unwrap(),
            vec!["example.com".to_string()]
        );
    }

    #[test]
    fn parse_target_ipv4_cidr_slash_30() {
        // /30 contains 4 addresses; .hosts() returns the 2 usable host
        // addresses (network + broadcast excluded).
        let result = parse_target_spec("192.168.1.0/30").unwrap();
        assert_eq!(result, vec!["192.168.1.1", "192.168.1.2"]);
    }

    #[test]
    fn parse_target_ipv4_cidr_slash_31() {
        // /31 (RFC 3021) — both addresses are usable.
        let result = parse_target_spec("192.168.1.0/31").unwrap();
        assert_eq!(result, vec!["192.168.1.0", "192.168.1.1"]);
    }

    #[test]
    fn parse_target_ipv4_cidr_slash_32() {
        // /32 — single host.
        let result = parse_target_spec("10.0.0.5/32").unwrap();
        assert_eq!(result, vec!["10.0.0.5"]);
    }

    #[test]
    fn parse_target_ipv4_cidr_slash_24_size() {
        // /24 expands to 254 usable hosts.
        let result = parse_target_spec("192.168.0.0/24").unwrap();
        assert_eq!(result.len(), 254);
        assert_eq!(result.first().unwrap(), "192.168.0.1");
        assert_eq!(result.last().unwrap(), "192.168.0.254");
    }

    #[test]
    fn parse_target_ipv6_cidr() {
        // /126 has 4 addresses; for IPv6 `.hosts()` returns all of them.
        let result = parse_target_spec("2001:db8::/126").unwrap();
        assert_eq!(result.len(), 4);
        assert!(result.iter().any(|h| h == "2001:db8::"));
    }

    #[test]
    fn parse_target_mixed_comma_list() {
        let result = parse_target_spec("192.168.1.1, 10.0.0.0/30, example.com").unwrap();
        // 1 (single) + 2 (/30 hosts) + 1 (hostname) = 4
        assert_eq!(result.len(), 4);
        assert_eq!(result[0], "192.168.1.1");
        assert_eq!(result[1], "10.0.0.1");
        assert_eq!(result[2], "10.0.0.2");
        assert_eq!(result[3], "example.com");
    }

    #[test]
    fn parse_target_empty_spec_errors() {
        assert!(parse_target_spec("").is_err());
        assert!(parse_target_spec("  ").is_err());
        assert!(parse_target_spec(",,").is_err());
    }

    #[test]
    fn parse_target_invalid_cidr_errors() {
        assert!(parse_target_spec("192.168.1.0/33").is_err());
        assert!(parse_target_spec("999.999.999.0/24").is_err());
    }

    #[test]
    fn parse_target_too_large_cidr_errors() {
        // /8 = 16 777 214 hosts → exceeds MAX_EXPANDED_TARGETS.
        let err = parse_target_spec("10.0.0.0/8").unwrap_err();
        assert!(matches!(err, NetworkError::InvalidParameter(_)));
    }

    #[test]
    fn parse_target_skips_empty_tokens() {
        // Leading/trailing/extra commas should be tolerated.
        let result = parse_target_spec(",192.168.1.1,,10.0.0.1,").unwrap();
        assert_eq!(result, vec!["192.168.1.1", "10.0.0.1"]);
    }

    #[tokio::test]
    async fn scan_localhost_refuses_unused_port() {
        // Port 1 is virtually never open; should come back Closed or Filtered.
        let cancel = CancellationToken::new();
        let results = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let results_cb = Arc::clone(&results);

        let summary = scan_ports(
            "127.0.0.1",
            &[1],
            500,
            1,
            move |r| results_cb.lock().unwrap().push(r),
            cancel,
        )
        .await
        .unwrap();

        assert_eq!(summary.total, 1);
        assert_eq!(summary.open, 0);
    }

    #[tokio::test]
    async fn scan_cancels_early() {
        let cancel = CancellationToken::new();
        cancel.cancel();

        // With the token already cancelled, the scan should return immediately.
        let summary = scan_ports(
            "127.0.0.1",
            &(1u16..=100u16).collect::<Vec<_>>(),
            2000,
            10,
            |_| {},
            cancel,
        )
        .await
        .unwrap();

        // Fewer than 100 ports should have been attempted.
        assert!(summary.total < 100);
    }
}
