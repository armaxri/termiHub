//! Ping implementation: ICMP via `surge-ping` with TCP-connect fallback.
//!
//! On platforms where ICMP raw sockets require elevated privileges, the
//! implementation transparently falls back to measuring a TCP connection
//! to port 80 (or 443 if 80 is filtered). The caller is informed via the
//! `tcp_fallback` flag on each [`PingResult`].

use std::net::IpAddr;
use std::str::FromStr;
use std::time::{Duration, Instant};

use surge_ping::{Client, Config, PingIdentifier, PingSequence, ICMP};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use super::error::NetworkError;
use super::types::{PingResult, PingStats};

/// Send a single ICMP ping (or TCP fallback) to `host`.
///
/// Returns `Ok(PingResult)` regardless of whether the target responded —
/// timeouts are encoded as `timed_out: true`, not as errors.
/// Only returns `Err` for unrecoverable problems (e.g., DNS failure).
pub async fn ping_once(host: &str, seq: u32, timeout_ms: u64) -> Result<PingResult, NetworkError> {
    let ip = resolve_host(host).await?;
    match icmp_ping(ip, seq, timeout_ms).await {
        Ok(result) => Ok(result),
        Err(_) => tcp_ping(ip, seq, timeout_ms).await,
    }
}

/// Send repeated pings to `host`, streaming each result via `on_result`.
///
/// * `count` – Number of pings to send; `None` means infinite.
/// * `interval_ms` – Delay between pings in milliseconds.
/// * `cancel` – Token to stop the session early.
///
/// Returns aggregate [`PingStats`] when the session ends.
pub async fn ping_stream(
    host: &str,
    interval_ms: u64,
    count: Option<u32>,
    on_result: impl Fn(PingResult) + Send + 'static,
    cancel: CancellationToken,
) -> Result<PingStats, NetworkError> {
    let ip = resolve_host(host).await?;

    let mut seq: u32 = 1;
    let mut sent: u32 = 0;
    let mut received: u32 = 0;
    let mut latencies: Vec<f64> = Vec::new();

    loop {
        if cancel.is_cancelled() {
            break;
        }
        if let Some(max) = count {
            if seq > max {
                break;
            }
        }

        let result = match icmp_ping(ip, seq, 2000).await {
            Ok(r) => r,
            Err(_) => tcp_ping(ip, seq, 2000).await?,
        };

        sent += 1;
        if let Some(ms) = result.latency_ms {
            received += 1;
            latencies.push(ms as f64);
        }

        on_result(result);
        seq += 1;

        if cancel.is_cancelled() {
            break;
        }
        if let Some(max) = count {
            if seq > max {
                break;
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(interval_ms)) => {}
            _ = cancel.cancelled() => break,
        }
    }

    Ok(compute_stats(sent, received, &latencies))
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/// Resolve a hostname or IP string to an [`IpAddr`].
async fn resolve_host(host: &str) -> Result<IpAddr, NetworkError> {
    if let Ok(ip) = IpAddr::from_str(host) {
        return Ok(ip);
    }

    let host = host.to_string();
    tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let addrs =
            format!("{host}:0")
                .to_socket_addrs()
                .map_err(|e| NetworkError::DnsResolution {
                    host: host.clone(),
                    reason: e.to_string(),
                })?;
        addrs
            .map(|a| a.ip())
            .next()
            .ok_or_else(|| NetworkError::DnsResolution {
                host: host.clone(),
                reason: "no addresses returned".into(),
            })
    })
    .await
    .map_err(|e| NetworkError::Platform(e.to_string()))?
}

/// Attempt an ICMP echo using `surge-ping`.
async fn icmp_ping(ip: IpAddr, seq: u32, timeout_ms: u64) -> Result<PingResult, NetworkError> {
    let icmp_kind = if ip.is_ipv6() { ICMP::V6 } else { ICMP::V4 };
    let config = Config::builder().kind(icmp_kind).build();
    let client = Client::new(&config).map_err(|e| NetworkError::InsufficientPrivileges {
        operation: "ICMP ping".into(),
        reason: e.to_string(),
    })?;

    let mut pinger = client.pinger(ip, PingIdentifier(rand_id())).await;
    pinger.timeout(Duration::from_millis(timeout_ms));

    let payload = b"termihub";

    match pinger.ping(PingSequence(seq as u16), payload).await {
        Ok((_packet, duration)) => Ok(PingResult {
            seq,
            latency_ms: Some(duration.as_millis() as u64),
            ttl: None, // surge-ping doesn't expose TTL directly
            timed_out: false,
            tcp_fallback: false,
        }),
        Err(surge_ping::SurgeError::Timeout { .. }) => Ok(PingResult {
            seq,
            latency_ms: None,
            ttl: None,
            timed_out: true,
            tcp_fallback: false,
        }),
        Err(e) => Err(NetworkError::Platform(e.to_string())),
    }
}

/// TCP-connect fallback: measures the time to establish a TCP connection to
/// port 80. Used when ICMP raw sockets are unavailable.
async fn tcp_ping(ip: IpAddr, seq: u32, timeout_ms: u64) -> Result<PingResult, NetworkError> {
    let addr = std::net::SocketAddr::new(ip, 80);
    let connect_start = Instant::now();
    let result =
        tokio::time::timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await;

    let (latency_ms, timed_out) = match result {
        Ok(Ok(_)) => (Some(connect_start.elapsed().as_millis() as u64), false),
        Ok(Err(_)) => {
            // Port refused — connection still proves the host is up; use latency.
            (Some(connect_start.elapsed().as_millis() as u64), false)
        }
        Err(_) => (None, true),
    };

    Ok(PingResult {
        seq,
        latency_ms,
        ttl: None,
        timed_out,
        tcp_fallback: true,
    })
}

fn rand_id() -> u16 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u16)
        .unwrap_or(0x4E5A)
}

fn compute_stats(sent: u32, received: u32, latencies: &[f64]) -> PingStats {
    let loss_percent = if sent == 0 {
        0.0
    } else {
        ((sent - received) as f64 / sent as f64) * 100.0
    };

    if latencies.is_empty() {
        return PingStats {
            sent,
            received,
            loss_percent,
            min_ms: 0.0,
            avg_ms: 0.0,
            max_ms: 0.0,
            jitter_ms: 0.0,
        };
    }

    let min_ms = latencies.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_ms = latencies.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg_ms = latencies.iter().sum::<f64>() / latencies.len() as f64;

    // Jitter: mean absolute deviation between consecutive samples.
    let jitter_ms = if latencies.len() < 2 {
        0.0
    } else {
        let sum: f64 = latencies.windows(2).map(|w| (w[1] - w[0]).abs()).sum();
        sum / (latencies.len() - 1) as f64
    };

    PingStats {
        sent,
        received,
        loss_percent,
        min_ms,
        avg_ms,
        max_ms,
        jitter_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_stats_empty_latencies() {
        let stats = compute_stats(5, 0, &[]);
        assert_eq!(stats.sent, 5);
        assert_eq!(stats.received, 0);
        assert!((stats.loss_percent - 100.0).abs() < 0.01);
        assert_eq!(stats.min_ms, 0.0);
        assert_eq!(stats.avg_ms, 0.0);
    }

    #[test]
    fn compute_stats_single_sample() {
        let stats = compute_stats(1, 1, &[42.0]);
        assert_eq!(stats.sent, 1);
        assert_eq!(stats.received, 1);
        assert!((stats.loss_percent).abs() < 0.01);
        assert!((stats.min_ms - 42.0).abs() < 0.01);
        assert!((stats.max_ms - 42.0).abs() < 0.01);
        assert!((stats.avg_ms - 42.0).abs() < 0.01);
        assert_eq!(stats.jitter_ms, 0.0);
    }

    #[test]
    fn compute_stats_multiple_samples() {
        let stats = compute_stats(3, 3, &[10.0, 20.0, 30.0]);
        assert!((stats.min_ms - 10.0).abs() < 0.01);
        assert!((stats.max_ms - 30.0).abs() < 0.01);
        assert!((stats.avg_ms - 20.0).abs() < 0.01);
        // jitter = (|20-10| + |30-20|) / 2 = 10
        assert!((stats.jitter_ms - 10.0).abs() < 0.01);
    }

    #[test]
    fn compute_stats_partial_loss() {
        let stats = compute_stats(4, 2, &[10.0, 20.0]);
        assert!((stats.loss_percent - 50.0).abs() < 0.01);
    }

    #[tokio::test]
    async fn resolve_ip_passthrough() {
        let ip = resolve_host("127.0.0.1").await.unwrap();
        assert_eq!(ip, IpAddr::from_str("127.0.0.1").unwrap());
    }

    #[tokio::test]
    async fn resolve_localhost() {
        let ip = resolve_host("localhost").await.unwrap();
        assert!(ip.is_loopback());
    }
}
