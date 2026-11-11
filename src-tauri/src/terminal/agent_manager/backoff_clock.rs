//! The clock the in-task agent reconnect backoff waits on (#5339).
//!
//! [`reconnect_agent`](super::reconnect::reconnect_agent) waits out each
//! backoff window through a [`BackoffClock`] carried in its
//! [`ReconnectTuning`](super::reconnect::ReconnectTuning). Production always
//! runs [`TOKIO_BACKOFF_CLOCK`], which is `tokio::time::sleep`: the same timer
//! the loop slept on before this seam existed.
//!
//! The seam exists for tests. The reconnect connect runs through
//! `block_in_place`, which needs a multi-thread runtime, while tokio's paused
//! clock (`start_paused`) needs a current-thread one. So the backoff cannot be
//! put into virtual time by pausing tokio. A test swaps in a virtual clock
//! instead (`virtual_backoff_clock::VirtualBackoffClock`) and steps the
//! backoff and park timing exactly, instead of watching a wall-clock window.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// One pending backoff wait: resolves once its delay has elapsed on the clock
/// that made it.
pub(super) type BackoffSleep = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Source of the reconnect loop's backoff waits.
pub(super) trait BackoffClock: Send + Sync {
    /// A wait that resolves after `delay` on this clock.
    fn sleep(&self, delay: Duration) -> BackoffSleep;
}

/// The real timer: `tokio::time::sleep`.
#[derive(Debug)]
pub(super) struct TokioBackoffClock;

impl BackoffClock for TokioBackoffClock {
    fn sleep(&self, delay: Duration) -> BackoffSleep {
        Box::pin(tokio::time::sleep(delay))
    }
}

/// The production backoff clock.
pub(super) static TOKIO_BACKOFF_CLOCK: TokioBackoffClock = TokioBackoffClock;
