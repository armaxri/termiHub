//! Auto-reconnect policy for the FTP backend (issue #1339).
//!
//! FTP control connections are long-lived and idle between user actions, so
//! servers frequently drop them (idle timeout, NAT eviction, transient network
//! faults). This module provides a small, backend-agnostic retry driver plus the
//! FTP-specific error classification used to decide when a failed operation is
//! worth reconnecting and retrying.
//!
//! The [`run_with_reconnect`] driver is deliberately generic over the operation,
//! the reconnect step and the error type so its retry/backoff behaviour can be
//! unit-tested without a live server (see the tests below); the FTP browser
//! wires it up with [`is_connection_error`] and a real re-establish closure.

use std::future::Future;
use std::time::Duration;

use suppaftp::FtpError;

/// Maximum number of reconnect attempts before giving up (concept: "up to 3
/// retries"). The initial attempt is not counted, so an operation is tried at
/// most `1 + MAX_RECONNECT_RETRIES` times.
pub(crate) const MAX_RECONNECT_RETRIES: usize = 3;

/// Backoff before the `attempt`-th reconnect (0-based): an exponential ramp
/// (100ms, 200ms, 400ms, …) capped at 2s to bound worst-case latency.
pub(crate) fn reconnect_backoff(attempt: usize) -> Duration {
    let shift = attempt.min(4) as u32;
    let ms = 100u64.saturating_mul(1u64 << shift);
    Duration::from_millis(ms.min(2000))
}

/// Whether a [`FtpError`] indicates a broken control connection that a
/// reconnect could plausibly recover.
///
/// Only transport-level failures ([`FtpError::ConnectionError`]) are treated as
/// reconnectable; protocol-level refusals (`550 No such file`, a `530`
/// permission denial, etc.) are surfaced to the caller unchanged so a bad path
/// or permission error is never masked by a pointless reconnect loop.
pub(crate) fn is_connection_error(err: &FtpError) -> bool {
    matches!(err, FtpError::ConnectionError(_))
}

/// A synthetic connection error used when the control stream is absent (the
/// slot is `None`), so the retry driver treats "not connected" as reconnectable.
pub(crate) fn not_connected_err() -> FtpError {
    FtpError::ConnectionError(std::io::Error::new(
        std::io::ErrorKind::NotConnected,
        "FTP control connection not established",
    ))
}

/// Run `op`, retrying on reconnectable errors after invoking `reconnect`.
///
/// * `op` is (re)invoked for each attempt; it must (re)acquire whatever shared
///   state it needs so a fresh connection established by `reconnect` is picked
///   up on the next try.
/// * A failure is retried only when `is_retryable` returns `true` and the
///   attempt budget (`max_retries`) is not yet exhausted; otherwise the error is
///   returned as-is.
/// * Between attempts the driver sleeps for `backoff(attempt)` and then calls
///   `reconnect`. If `reconnect` itself fails, that error is returned
///   immediately (no point retrying an operation we could not reconnect for).
///
/// Returns the first `Ok`, or the last error once retries are exhausted.
pub(crate) async fn run_with_reconnect<T, E, Op, OpFut, Rc, RcFut>(
    max_retries: usize,
    is_retryable: impl Fn(&E) -> bool,
    backoff: impl Fn(usize) -> Duration,
    mut op: Op,
    mut reconnect: Rc,
) -> Result<T, E>
where
    Op: FnMut() -> OpFut,
    OpFut: Future<Output = Result<T, E>>,
    Rc: FnMut() -> RcFut,
    RcFut: Future<Output = Result<(), E>>,
{
    let mut attempt = 0;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(err) => {
                if attempt >= max_retries || !is_retryable(&err) {
                    return Err(err);
                }
                let delay = backoff(attempt);
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                reconnect().await?;
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A `Response`-free retryable error for tests.
    fn conn_err() -> FtpError {
        not_connected_err()
    }

    /// A non-reconnectable protocol error for tests.
    fn proto_err() -> FtpError {
        FtpError::BadResponse
    }

    #[test]
    fn backoff_is_monotonic_and_capped() {
        let d0 = reconnect_backoff(0);
        let d1 = reconnect_backoff(1);
        let d2 = reconnect_backoff(2);
        assert_eq!(d0, Duration::from_millis(100));
        assert_eq!(d1, Duration::from_millis(200));
        assert_eq!(d2, Duration::from_millis(400));
        assert!(d1 > d0 && d2 > d1, "backoff must grow");
        // Far-out attempts plateau (shift is capped) and never exceed 2s.
        let far = reconnect_backoff(100);
        assert_eq!(
            far,
            reconnect_backoff(4),
            "backoff plateaus once shift caps"
        );
        assert!(
            far <= Duration::from_millis(2000),
            "backoff is bounded at 2s"
        );
    }

    #[test]
    fn classifies_connection_vs_protocol_errors() {
        assert!(is_connection_error(&conn_err()));
        assert!(!is_connection_error(&proto_err()));
    }

    #[tokio::test]
    async fn returns_immediately_on_first_success() {
        let calls = Cell::new(0);
        let reconnects = Cell::new(0);
        let result: Result<u8, FtpError> = run_with_reconnect(
            MAX_RECONNECT_RETRIES,
            is_connection_error,
            |_| Duration::ZERO,
            || async {
                calls.set(calls.get() + 1);
                Ok(7)
            },
            || async {
                reconnects.set(reconnects.get() + 1);
                Ok(())
            },
        )
        .await;
        assert_eq!(result.unwrap(), 7);
        assert_eq!(calls.get(), 1, "op runs exactly once on success");
        assert_eq!(reconnects.get(), 0, "no reconnect when the first try works");
    }

    #[tokio::test]
    async fn retries_then_succeeds_and_reconnects_between_attempts() {
        let calls = Cell::new(0);
        let reconnects = Cell::new(0);
        let result: Result<&str, FtpError> = run_with_reconnect(
            MAX_RECONNECT_RETRIES,
            is_connection_error,
            |_| Duration::ZERO,
            || async {
                let n = calls.get() + 1;
                calls.set(n);
                // Fail the first two attempts with a connection error, then succeed.
                if n <= 2 {
                    Err(conn_err())
                } else {
                    Ok("ok")
                }
            },
            || async {
                reconnects.set(reconnects.get() + 1);
                Ok(())
            },
        )
        .await;
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(calls.get(), 3, "op tried 3 times (2 failures + success)");
        assert_eq!(reconnects.get(), 2, "reconnect once per failure");
    }

    #[tokio::test]
    async fn gives_up_after_max_retries_returning_last_error() {
        let calls = Cell::new(0);
        let reconnects = Cell::new(0);
        let result: Result<(), FtpError> = run_with_reconnect(
            MAX_RECONNECT_RETRIES,
            is_connection_error,
            |_| Duration::ZERO,
            || async {
                calls.set(calls.get() + 1);
                Err(conn_err())
            },
            || async {
                reconnects.set(reconnects.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err(), "exhausted retries surface the error");
        // 1 initial + MAX_RECONNECT_RETRIES retries.
        assert_eq!(calls.get(), 1 + MAX_RECONNECT_RETRIES);
        assert_eq!(reconnects.get(), MAX_RECONNECT_RETRIES);
    }

    #[tokio::test]
    async fn does_not_retry_non_reconnectable_errors() {
        let calls = Cell::new(0);
        let reconnects = Cell::new(0);
        let result: Result<(), FtpError> = run_with_reconnect(
            MAX_RECONNECT_RETRIES,
            is_connection_error,
            |_| Duration::ZERO,
            || async {
                calls.set(calls.get() + 1);
                Err(proto_err())
            },
            || async {
                reconnects.set(reconnects.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls.get(), 1, "protocol errors are not retried");
        assert_eq!(reconnects.get(), 0, "no reconnect for protocol errors");
    }

    #[tokio::test]
    async fn propagates_reconnect_failure() {
        let calls = Cell::new(0);
        let result: Result<(), FtpError> = run_with_reconnect(
            MAX_RECONNECT_RETRIES,
            is_connection_error,
            |_| Duration::ZERO,
            || async {
                calls.set(calls.get() + 1);
                Err(conn_err())
            },
            || async { Err(FtpError::BadResponse) },
        )
        .await;
        assert!(matches!(result, Err(FtpError::BadResponse)));
        assert_eq!(calls.get(), 1, "op stops once reconnect fails");
    }
}
