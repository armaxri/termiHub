//! Watches the sandboxed shared folder for changes while an RDP session is
//! connected so the CLIPRDR local file offer can be **re-advertised** without a
//! reconnect (#1788).
//!
//! At connect the sidecar advertises the shared folder's file list once
//! (`#1778`); a file dropped into, removed from, or renamed inside the folder
//! afterwards is invisible to the remote until the offer is re-sent. This module
//! bridges the OS filesystem watcher ([`notify`], which uses inotify on Linux,
//! FSEvents on macOS and `ReadDirectoryChangesW` on Windows) to a single
//! debounced, rate-bounded "re-advertise now" tick the driver loop consumes. The
//! driver then re-enumerates the folder through the existing serve pipeline
//! ([`crate::clipboard::SidecarClipboardBackend::readvertise_local_files`]),
//! which keeps the re-enumeration inside the sandbox root.
//!
//! **Bounding.** A churning folder must not flood the CLIPRDR channel with a
//! format-list PDU per inotify event. [`Debouncer`] enforces three limits: a
//! trailing quiet period ([`DEBOUNCE`]) so a burst collapses into one tick, a
//! hard cap ([`MAX_WAIT`]) so continuous activity cannot starve the trailing edge
//! forever, and a floor ([`MIN_INTERVAL`]) between two ticks so the re-advertise
//! rate stays bounded regardless. The tick channel itself has capacity one and
//! drops extra ticks (a re-advertise reads the folder's current state, so a
//! coalesced-away tick loses nothing).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Trailing quiet period after the last change before a re-advertise fires, so a
/// burst of rapid changes collapses into a single tick.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// Hard cap: re-advertise at most this long after the *first* change of a burst,
/// even if the folder keeps churning — otherwise continuous activity would keep
/// pushing the trailing-edge deadline out and never fire.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// Floor spacing between two consecutive re-advertises, so a churning folder
/// cannot flood the CLIPRDR channel with format-list PDUs.
const MIN_INTERVAL: Duration = Duration::from_secs(1);
/// Depth of the tick channel. One is enough: a pending tick already tells the
/// driver to re-enumerate the folder's current state, so extra ticks queued
/// behind it are redundant and dropped.
const TICK_CAPACITY: usize = 1;

/// A running shared-folder watcher. Dropping it stops the OS watcher (and, once
/// its raw-event channel closes, the debounce task). The driver selects on
/// [`Self::ticks`] and holds the whole value for the session's lifetime so the
/// watcher stays alive.
pub struct FolderWatch {
    /// Kept alive for the session: dropping the watcher unsubscribes from OS
    /// events. Never accessed directly after construction.
    _watcher: notify::RecommendedWatcher,
    /// Debounced, rate-bounded "re-advertise now" ticks.
    pub ticks: mpsc::Receiver<()>,
}

/// Start watching `root` (the already-sandboxed, canonical shared folder)
/// recursively for changes. Returns `None` — non-fatally — if the OS watcher
/// cannot be created or cannot watch the folder; the session then simply keeps
/// its connect-time offer. Must be called from within a Tokio runtime (it spawns
/// the debounce task).
pub fn watch_shared_folder(root: PathBuf) -> Option<FolderWatch> {
    // The notify callback runs on notify's own thread; it forwards a bare
    // "something changed" signal into a tokio channel (an unbounded sender's
    // `send` is non-blocking and callable from any thread). The debounce task
    // stamps its own clock, so the event payload is irrelevant here.
    let (raw_tx, raw_rx) = mpsc::unbounded_channel::<()>();
    let mut watcher = match notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| match res {
            Ok(_event) => {
                let _ = raw_tx.send(());
            }
            Err(e) => warn!(error = %e, "shared-folder watcher reported an error"),
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            warn!(
                error = %e,
                root = %root.display(),
                "failed to create shared-folder watcher; files changed after connect will not be re-advertised (#1788)"
            );
            return None;
        }
    };
    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        warn!(
            error = %e,
            root = %root.display(),
            "failed to watch the shared folder; no re-advertise on change (#1788)"
        );
        return None;
    }

    let (tick_tx, ticks) = mpsc::channel::<()>(TICK_CAPACITY);
    tokio::spawn(debounce_loop(raw_rx, tick_tx, Debouncer::new()));
    debug!(root = %root.display(), "watching shared folder for CLIPRDR re-advertise (#1788)");
    Some(FolderWatch {
        _watcher: watcher,
        ticks,
    })
}

/// The debounce + rate-limit policy, kept as a pure function of instants (no
/// clock, no async) so the coalescing/bounding behaviour is unit-testable.
struct Debouncer {
    debounce: Duration,
    max_wait: Duration,
    min_interval: Duration,
    /// When the last tick fired, or `None` before the first one.
    last_fire: Option<Instant>,
}

impl Debouncer {
    fn new() -> Self {
        Self {
            debounce: DEBOUNCE,
            max_wait: MAX_WAIT,
            min_interval: MIN_INTERVAL,
            last_fire: None,
        }
    }

    #[cfg(test)]
    fn with(debounce: Duration, max_wait: Duration, min_interval: Duration) -> Self {
        Self {
            debounce,
            max_wait,
            min_interval,
            last_fire: None,
        }
    }

    /// The earliest instant a re-advertise may fire, given the current burst's
    /// first change (`burst_start`) and its most recent change (`last_change`):
    /// the trailing-edge deadline (`last_change + debounce`), clamped so it never
    /// waits past `burst_start + max_wait`, then floored to `last_fire +
    /// min_interval` so two ticks stay at least a rate-cap apart.
    fn next_fire_at(&self, burst_start: Instant, last_change: Instant) -> Instant {
        let trailing = last_change + self.debounce;
        let capped = trailing.min(burst_start + self.max_wait);
        match self.last_fire {
            Some(f) => capped.max(f + self.min_interval),
            None => capped,
        }
    }

    fn record_fire(&mut self, at: Instant) {
        self.last_fire = Some(at);
    }
}

/// Drain raw filesystem-change signals into debounced, rate-bounded ticks. Ends
/// when the raw channel closes (watcher dropped) or the tick channel closes
/// (driver gone).
async fn debounce_loop(
    mut raw_rx: mpsc::UnboundedReceiver<()>,
    tick_tx: mpsc::Sender<()>,
    mut debouncer: Debouncer,
) {
    use mpsc::error::TrySendError;
    loop {
        // Block until the first change of a new burst.
        if raw_rx.recv().await.is_none() {
            return; // watcher dropped
        }
        let burst_start = Instant::now();
        let mut last_change = burst_start;
        loop {
            let fire_at = debouncer.next_fire_at(burst_start, last_change);
            tokio::select! {
                biased;
                r = raw_rx.recv() => match r {
                    // Another change extends the burst: reset the trailing edge.
                    Some(()) => last_change = Instant::now(),
                    None => return, // watcher dropped
                },
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(fire_at)) => {
                    debouncer.record_fire(Instant::now());
                    match tick_tx.try_send(()) {
                        // A full channel already holds a tick the driver will act
                        // on, so dropping this one loses nothing.
                        Ok(()) | Err(TrySendError::Full(())) => {}
                        Err(TrySendError::Closed(())) => return, // driver gone
                    }
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn coalesces_a_burst_into_one_trailing_fire() {
        // Debounce 400ms, well under the 2s cap: a change followed by another
        // 100ms later fires 400ms after the *last* change, i.e. once.
        let deb = Debouncer::with(ms(400), ms(2000), ms(1000));
        let t0 = Instant::now();
        assert_eq!(deb.next_fire_at(t0, t0 + ms(100)), t0 + ms(500));
    }

    #[test]
    fn caps_continuous_churn_at_max_wait() {
        // Still churning 1900ms into the burst: the trailing edge would be
        // t0+2300ms, but the max-wait cap forces a fire at t0+2000ms so continuous
        // activity cannot starve the debounce forever.
        let deb = Debouncer::with(ms(400), ms(2000), ms(1000));
        let t0 = Instant::now();
        assert_eq!(deb.next_fire_at(t0, t0 + ms(1900)), t0 + ms(2000));
    }

    #[test]
    fn rate_limits_after_a_recent_fire() {
        // A change 100ms after the previous fire: the trailing edge is t0+500ms
        // but the min-interval floor pushes the next fire to t0+1000ms.
        let mut deb = Debouncer::with(ms(400), ms(2000), ms(1000));
        let t0 = Instant::now();
        deb.record_fire(t0);
        assert_eq!(deb.next_fire_at(t0 + ms(100), t0 + ms(100)), t0 + ms(1000));
    }

    #[tokio::test]
    async fn debounce_loop_coalesces_a_burst_into_one_tick() {
        let (raw_tx, raw_rx) = mpsc::unbounded_channel::<()>();
        let (tick_tx, mut ticks) = mpsc::channel::<()>(TICK_CAPACITY);
        // Tiny real-time durations keep the test fast; the outer timeouts are
        // generous so it is not timing-sensitive.
        let deb = Debouncer::with(ms(30), ms(200), ms(50));
        tokio::spawn(debounce_loop(raw_rx, tick_tx, deb));

        // A rapid burst of three changes.
        for _ in 0..3 {
            raw_tx.send(()).unwrap();
        }
        // Exactly one tick arrives after the quiet period.
        let first = tokio::time::timeout(Duration::from_secs(2), ticks.recv()).await;
        assert_eq!(first.expect("a tick should fire on change"), Some(()));
        // The burst coalesced: no second tick follows from the same activity.
        let second = tokio::time::timeout(ms(150), ticks.recv()).await;
        assert!(second.is_err(), "a burst must coalesce into a single tick");
    }

    #[tokio::test]
    async fn debounce_loop_stops_when_the_watcher_is_dropped() {
        let (raw_tx, raw_rx) = mpsc::unbounded_channel::<()>();
        let (tick_tx, mut ticks) = mpsc::channel::<()>(TICK_CAPACITY);
        let handle = tokio::spawn(debounce_loop(raw_rx, tick_tx, Debouncer::new()));
        // Dropping the raw sender (as dropping the watcher does) ends the loop and
        // closes the tick channel.
        drop(raw_tx);
        assert!(ticks.recv().await.is_none());
        handle.await.unwrap();
    }
}
