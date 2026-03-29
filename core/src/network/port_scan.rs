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
