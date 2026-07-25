//! Subnet / IP-range ping sweep.
//!
//! Enumerates the hosts of an IP range (via [`parse_target_spec`]) and ICMP-pings
//! each concurrently, streaming the responders back as they arrive. Reuses the
//! single-host ICMP implementation from [`super::ping`] (which transparently
//! falls back to a TCP connect probe where raw ICMP sockets need privileges),
//! so a host is "up" whenever it produces a reply within the timeout.
//!
//! Only responding hosts are streamed as results; non-responders are tallied
//! into [`PingSweepSummary::down`].

use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::error::NetworkError;
use super::types::{PingSweepResult, PingSweepSummary};
use super::{dns, ping};

/// Ping every host in `targets` concurrently, streaming responders via
/// `on_result` and returning aggregate [`PingSweepSummary`] counts.
///
/// # Arguments
/// * `targets` – Expanded list of hostnames / IP addresses (e.g. the output of
///   [`super::parse_target_spec`] for a CIDR range).
/// * `timeout_ms` – Per-host probe timeout in milliseconds.
/// * `concurrency` – Maximum number of simultaneous probes.
/// * `resolve_hostnames` – When true, up hosts get a best-effort reverse-DNS
///   (PTR) lookup for the NAME column.
/// * `on_result` – Callback invoked once per responding host (may be called from
///   multiple tasks concurrently).
/// * `cancel` – Token to abort the sweep early; partial counts are still
///   returned.
pub async fn ping_sweep(
    targets: &[String],
    timeout_ms: u64,
    concurrency: usize,
    resolve_hostnames: bool,
    on_result: impl Fn(PingSweepResult) + Send + Sync + 'static,
    cancel: CancellationToken,
) -> Result<PingSweepSummary, NetworkError> {
    let concurrency = concurrency.max(1);
    let sem = Arc::new(Semaphore::new(concurrency));
    let on_result = Arc::new(on_result);

    let started = Instant::now();
    let mut handles = Vec::with_capacity(targets.len());

    for target in targets {
        if cancel.is_cancelled() {
            break;
        }

        let permit = Arc::clone(&sem)
            .acquire_owned()
            .await
            .map_err(|_| NetworkError::Cancelled)?;

        let host = target.clone();
        let cb = Arc::clone(&on_result);
        let cancel = cancel.clone();

        let handle = tokio::spawn(async move {
            let _permit = permit;
            if cancel.is_cancelled() {
                return false;
            }

            // ping_once never errors on a timeout — only on unrecoverable
            // problems (e.g. DNS failure). Treat those as "down" so one bad
            // token can't sink the whole sweep.
            let result = match ping::ping_once(&host, 1, timeout_ms).await {
                Ok(r) => r,
                Err(_) => return false,
            };
            if result.timed_out {
                return false;
            }

            let hostname = if resolve_hostnames {
                match IpAddr::from_str(&host) {
                    Ok(ip) => dns::reverse_lookup(ip).await,
                    Err(_) => None,
                }
            } else {
                None
            };

            cb(PingSweepResult {
                host,
                latency_ms: result.latency_ms,
                hostname,
            });
            true
        });

        handles.push(handle);
    }

    let mut up = 0u32;
    let mut total = 0u32;
    for handle in handles {
        total += 1;
        if let Ok(true) = handle.await {
            up += 1;
        }
    }

    Ok(PingSweepSummary {
        total,
        up,
        down: total - up,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn sweep_cancels_early() {
        let cancel = CancellationToken::new();
        cancel.cancel();

        let targets: Vec<String> = (1..=50).map(|i| format!("192.0.2.{i}")).collect();
        let summary = ping_sweep(&targets, 1000, 10, false, |_| {}, cancel)
            .await
            .unwrap();

        // Nothing should have been probed once already cancelled.
        assert_eq!(summary.total, 0);
        assert_eq!(summary.up, 0);
        assert_eq!(summary.down, 0);
    }

    #[tokio::test]
    async fn sweep_counts_up_and_down() {
        // Loopback should always be up; a TEST-NET-1 address (RFC 5737) should
        // never respond, so it counts as down.
        let cancel = CancellationToken::new();
        let results = Arc::new(Mutex::new(Vec::new()));
        let cb = Arc::clone(&results);

        let targets = vec!["127.0.0.1".to_string(), "192.0.2.1".to_string()];
        let summary = ping_sweep(
            &targets,
            800,
            8,
            false,
            move |r| cb.lock().unwrap().push(r),
            cancel,
        )
        .await
        .unwrap();

        assert_eq!(summary.total, 2);
        assert_eq!(summary.up + summary.down, 2);
        // Every streamed result must be an up host, and the up count matches.
        let results = results.lock().unwrap();
        assert_eq!(results.len() as u32, summary.up);
    }

    #[tokio::test]
    async fn sweep_empty_targets_is_all_zero() {
        let cancel = CancellationToken::new();
        let summary = ping_sweep(&[], 500, 4, false, |_| {}, cancel)
            .await
            .unwrap();
        assert_eq!(summary.total, 0);
        assert_eq!(summary.up, 0);
        assert_eq!(summary.down, 0);
    }
}
