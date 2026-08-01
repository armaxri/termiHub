//! TCP connect-based port scanner.
//!
//! Performs TCP connect scans only — no SYN/stealth scanning.
//! Results are streamed to the caller via a callback as each probe completes.

use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ipnet::IpNet;
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::error::NetworkError;
use super::types::{PortScanResult, PortScanSummary, PortState};

/// Scan a set of TCP ports on a single host, streaming individual results via
/// `on_result`. Convenience wrapper around [`scan_targets`].
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
    scan_targets(
        &[host.to_string()],
        ports,
        timeout_ms,
        concurrency,
        on_result,
        cancel,
    )
    .await
}

/// Scan a set of TCP ports across one or more targets. Probes for every
/// `(target, port)` combination share a single concurrency budget — useful
/// when expanding a CIDR range without overwhelming the local network stack.
///
/// Work is streamed through a bounded [`JoinSet`]: at most `concurrency` probe
/// tasks are ever in flight, and each is reaped as it completes rather than
/// pre-spawning (and holding a join handle for) one task per combination. This
/// keeps memory and file-descriptor use bounded regardless of how large the
/// `targets × ports` product is, so a wide scan (e.g. a CIDR range across the
/// full port range) throttles instead of exhausting local resources.
///
/// See [`scan_ports`] for argument semantics. `targets` may contain hostnames
/// or IP addresses; each result carries its originating `host` for grouping.
pub async fn scan_targets(
    targets: &[String],
    ports: &[u16],
    timeout_ms: u64,
    concurrency: usize,
    on_result: impl Fn(PortScanResult) + Send + Sync + 'static,
    cancel: CancellationToken,
) -> Result<PortScanSummary, NetworkError> {
    let timeout = Duration::from_millis(timeout_ms);
    let on_result = Arc::new(on_result);
    let probe_cancel = cancel.clone();

    let summary = run_bounded_scan(targets, ports, concurrency, cancel, move |host, port| {
        let cb = Arc::clone(&on_result);
        let cancel = probe_cancel.clone();
        async move {
            if cancel.is_cancelled() {
                return None;
            }
            let result = probe_port(&host, port, timeout).await;
            cb(result.clone());
            Some(result)
        }
    })
    .await;

    Ok(summary)
}

/// Run one probe per `(target, port)` combination with the number of in-flight
/// tasks capped at `concurrency`, tallying the outcomes into a summary.
///
/// Combinations are enumerated lazily and pushed into a [`JoinSet`] one at a
/// time; whenever the set is full the oldest-completed task is reaped before
/// another is spawned, so at most `concurrency` tasks (and join handles) exist
/// at once. Completion order — and therefore the order individual results are
/// observed by `make_probe` — is unspecified, matching the previous behaviour.
///
/// `make_probe` builds the future for a single probe. Factoring it out keeps
/// the bounding logic testable against a fake prober that records its own peak
/// concurrency.
async fn run_bounded_scan<F, Fut>(
    targets: &[String],
    ports: &[u16],
    concurrency: usize,
    cancel: CancellationToken,
    make_probe: F,
) -> PortScanSummary
where
    F: Fn(String, u16) -> Fut,
    Fut: std::future::Future<Output = Option<PortScanResult>> + Send + 'static,
{
    let concurrency = concurrency.max(1);
    let started = Instant::now();

    let mut set: JoinSet<Option<PortScanResult>> = JoinSet::new();
    let mut open = 0u32;
    let mut closed = 0u32;
    let mut filtered = 0u32;

    'outer: for target in targets {
        for &port in ports {
            if cancel.is_cancelled() {
                break 'outer;
            }

            // Backpressure: never let more than `concurrency` tasks be in
            // flight. Reap finished tasks before spawning the next one.
            while set.len() >= concurrency {
                if let Some(joined) = set.join_next().await {
                    record(joined.ok().flatten(), &mut open, &mut closed, &mut filtered);
                }
            }

            set.spawn(make_probe(target.clone(), port));
        }
    }

    // Drain whatever is still running.
    while let Some(joined) = set.join_next().await {
        record(joined.ok().flatten(), &mut open, &mut closed, &mut filtered);
    }

    PortScanSummary {
        total: open + closed + filtered,
        open,
        closed,
        filtered,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

/// Fold a single probe outcome into the running per-state tallies. A `None`
/// outcome (cancelled or a panicked/aborted task) contributes to nothing.
fn record(outcome: Option<PortScanResult>, open: &mut u32, closed: &mut u32, filtered: &mut u32) {
    if let Some(result) = outcome {
        match result.state {
            PortState::Open => *open += 1,
            PortState::Closed => *closed += 1,
            PortState::Filtered => *filtered += 1,
        }
    }
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
                host: host.to_string(),
                port,
                state: PortState::Filtered,
                latency_ms: None,
            }
        }
    };

    let started = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => PortScanResult {
            host: host.to_string(),
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
                host: host.to_string(),
                port,
                state,
                latency_ms: None,
            }
        }
        Err(_timeout) => PortScanResult {
            host: host.to_string(),
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
pub fn parse_target_spec(spec: &str) -> Result<Vec<String>, NetworkError> {
    let mut targets: Vec<String> = Vec::new();

    for raw in spec.split(',') {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }

        if token.contains('/') {
            let net: IpNet = token.parse().map_err(|e| {
                NetworkError::InvalidParameter(format!("invalid CIDR '{token}': {e}"))
            })?;

            for host in net.hosts() {
                if targets.len() >= MAX_EXPANDED_TARGETS {
                    return Err(NetworkError::InvalidParameter(format!(
                        "target spec expands to more than {MAX_EXPANDED_TARGETS} hosts; \
                         refine the CIDR range (current token: '{token}')"
                    )));
                }
                targets.push(host.to_string());
            }
        } else {
            // Keep the original string so hostnames pass through untouched
            // for downstream DNS resolution.
            if targets.len() >= MAX_EXPANDED_TARGETS {
                return Err(NetworkError::InvalidParameter(format!(
                    "target spec expands to more than {MAX_EXPANDED_TARGETS} hosts"
                )));
            }
            targets.push(token.to_string());
        }
    }

    if targets.is_empty() {
        return Err(NetworkError::InvalidParameter(
            "target specification is empty".into(),
        ));
    }

    Ok(targets)
}

/// Parse a human-readable port specification into a list of port numbers.
///
/// Accepted formats:
/// - Single port: `"22"`
/// - Comma-separated: `"22,80,443"`
/// - Range: `"8000-8080"`
/// - Mixed: `"22,80,8000-8080,443"`
///
/// Every port must be within the valid TCP range `1..=65535`; port `0` is
/// IANA-reserved and rejected with [`NetworkError::InvalidParameter`].
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
            if start == 0 {
                return Err(NetworkError::InvalidParameter(format!(
                    "port range {start}-{end}: port must be between 1 and 65535"
                )));
            }
            ports.extend(start..=end);
        } else {
            let port: u16 = part
                .parse()
                .map_err(|_| NetworkError::InvalidParameter(format!("invalid port: '{part}'")))?;
            if port == 0 {
                return Err(NetworkError::InvalidParameter(
                    "port 0 is reserved: port must be between 1 and 65535".into(),
                ));
            }
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

    #[test]
    fn parse_rejects_single_port_zero() {
        // Port 0 is IANA-reserved and can never host a listening TCP service.
        assert!(matches!(
            parse_port_spec("0"),
            Err(NetworkError::InvalidParameter(_))
        ));
    }

    #[test]
    fn parse_rejects_range_starting_at_zero() {
        assert!(matches!(
            parse_port_spec("0-100"),
            Err(NetworkError::InvalidParameter(_))
        ));
    }

    #[test]
    fn parse_accepts_boundary_ports() {
        // The valid TCP port boundaries (1 and 65535) must still parse.
        assert_eq!(parse_port_spec("1").unwrap(), vec![1]);
        assert_eq!(parse_port_spec("65535").unwrap(), vec![65535]);
        assert_eq!(parse_port_spec("1-3").unwrap(), vec![1, 2, 3]);
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
        assert_eq!(parse_target_spec("::1").unwrap(), vec!["::1".to_string()]);
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
    async fn scan_targets_reports_host_per_result() {
        // Scan two distinct loopback targets; every result must carry the
        // host string it originated from.
        let cancel = CancellationToken::new();
        let results = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let results_cb = Arc::clone(&results);

        let targets = vec!["127.0.0.1".to_string(), "127.0.0.2".to_string()];
        let summary = scan_targets(
            &targets,
            &[1],
            500,
            2,
            move |r| results_cb.lock().unwrap().push(r),
            cancel,
        )
        .await
        .unwrap();

        assert_eq!(summary.total, 2);
        let results = results.lock().unwrap();
        let hosts: std::collections::HashSet<_> = results.iter().map(|r| r.host.clone()).collect();
        assert!(hosts.contains("127.0.0.1"));
        assert!(hosts.contains("127.0.0.2"));
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
    async fn run_bounded_scan_caps_in_flight_probes() {
        // Backpressure boundary: with far more (target × port) combinations
        // than the concurrency budget, the number of simultaneously-running
        // probes must never exceed the budget — and must actually reach it,
        // proving the work is streamed rather than serialised or spawned all
        // at once (the memory/FD blowup this guards against).
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cancel = CancellationToken::new();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let targets: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        let ports: Vec<u16> = (1..=40).collect(); // 3 × 40 = 120 combinations
        let concurrency = 8;

        let in_flight_cb = Arc::clone(&in_flight);
        let peak_cb = Arc::clone(&peak);
        let summary = run_bounded_scan(&targets, &ports, concurrency, cancel, move |host, port| {
            let in_flight = Arc::clone(&in_flight_cb);
            let peak = Arc::clone(&peak_cb);
            async move {
                let current = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                // Hold the slot briefly so concurrent probes overlap.
                tokio::time::sleep(Duration::from_millis(10)).await;
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Some(PortScanResult {
                    host,
                    port,
                    state: PortState::Closed,
                    latency_ms: None,
                })
            }
        })
        .await;

        // Every combination was probed and tallied.
        assert_eq!(summary.total, 120);
        assert_eq!(summary.closed, 120);

        let observed_peak = peak.load(Ordering::SeqCst);
        assert!(
            observed_peak <= concurrency,
            "peak in-flight {observed_peak} exceeded the concurrency bound {concurrency}"
        );
        assert_eq!(
            observed_peak, concurrency,
            "expected the concurrency budget to be fully used (peak {observed_peak})"
        );
        // Nothing should still be running once the scan returns.
        assert_eq!(in_flight.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn run_bounded_scan_handles_concurrency_zero() {
        // A zero concurrency request must be clamped to at least one worker
        // (never a deadlock) and still complete every probe.
        let cancel = CancellationToken::new();
        let targets = vec!["h".to_string()];
        let ports: Vec<u16> = (1..=5).collect();

        let summary = run_bounded_scan(&targets, &ports, 0, cancel, move |host, port| async move {
            Some(PortScanResult {
                host,
                port,
                state: PortState::Open,
                latency_ms: None,
            })
        })
        .await;

        assert_eq!(summary.total, 5);
        assert_eq!(summary.open, 5);
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
