//! Watches the **host OS clipboard's file list** for changes while an RDP session
//! is connected so files copied locally mid-session are **re-advertised** over
//! CLIPRDR without a reconnect (#1794).
//!
//! ## Why a poll, not an event
//!
//! The sidecar already reads the host clipboard's native file list at CLIPRDR
//! **format-list** time ([`crate::host_clipboard::read_host_clipboard_files`], via
//! [`crate::clipboard::SidecarClipboardBackend::build_local_file_offer`], #1779):
//! files copied *before* connect — or when the server re-requests — are offered.
//! Files copied *after* connect are invisible until the server asks again. Text has
//! the same push seam today ([`crate::protocol::HostMessage::SetClipboard`]
//! re-advertises on a local text copy); files need an equivalent trigger. This
//! module is the file-list sibling of the shared-folder watcher (#1788): both drive
//! the one re-advertise pipeline
//! ([`crate::clipboard::SidecarClipboardBackend::readvertise_local_files`]).
//!
//! Unlike the shared folder, an OS clipboard has no cheap, cross-platform,
//! window-less change notification the headless sidecar can subscribe to (Windows'
//! `AddClipboardFormatListener` needs a message loop, XFixes needs an X event
//! thread, macOS exposes only a `changeCount` to poll). So this watcher **polls**
//! the existing platform readers on a fixed interval and diffs the returned list
//! against the previous poll, emitting a tick only when the file list actually
//! changed. The poll interval is itself the rate bound: a change re-advertises at
//! most once per [`POLL_INTERVAL`], so rapid host copies cannot flood the CLIPRDR
//! channel. Each read runs on the blocking pool ([`tokio::task::spawn_blocking`])
//! because a platform reader can block (the Linux X11 reader waits up to 3s for the
//! selection), so it never stalls the async driver.
//!
//! ## Gating
//!
//! The watcher is decoupled from — and independent of — the shared-folder watcher:
//! either source can re-advertise without the other having changed. It is started
//! only when the session actually serves local files (file transfer opted in and
//! not view-only), the same gate the connect-time host-clipboard offer already
//! honours (#1778/#1779), so a view-only or text-only session never polls the
//! clipboard. A re-advertise triggered by this watcher still runs through
//! [`readvertise_local_files`](crate::clipboard::SidecarClipboardBackend::readvertise_local_files),
//! which re-applies the opt-in + view-only gate and keeps host-clipboard serving
//! bounded to the paths the user actually copied.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tracing::debug;

/// Interval between two host-clipboard polls. Also the re-advertise rate bound: a
/// mid-session file copy is re-advertised at most once per interval, so a burst of
/// rapid copies cannot flood the CLIPRDR channel. Kept modest so a real X11/Wayland
/// selection round-trip per poll stays cheap.
const POLL_INTERVAL: Duration = Duration::from_millis(750);
/// Depth of the tick channel. One is enough: a pending tick already tells the
/// driver to re-enumerate the clipboard's current state, so extra ticks queued
/// behind it are redundant and dropped.
const TICK_CAPACITY: usize = 1;

/// A running host-clipboard file-list watcher. Dropping it (which the driver does
/// at session end by dropping the value that owns [`Self::ticks`]) closes the tick
/// channel, and the poll task exits at its next wakeup. The driver selects on
/// [`Self::ticks`] and holds the whole value for the session's lifetime so the
/// watcher stays alive.
pub struct HostClipboardWatch {
    /// Debounced-by-polling "re-advertise now" ticks.
    pub ticks: mpsc::Receiver<()>,
}

/// Start polling the host OS clipboard's file list. Must be called from within a
/// Tokio runtime (it spawns the poll task). The connect-time offer already
/// advertised whatever was on the clipboard, so the first poll only establishes the
/// baseline — the watcher ticks on *subsequent* changes.
pub fn watch_host_clipboard() -> HostClipboardWatch {
    watch_with(
        Arc::new(crate::host_clipboard::read_host_clipboard_files),
        POLL_INTERVAL,
    )
}

/// Like [`watch_host_clipboard`] but with an injected reader and interval, so tests
/// can script a sequence of clipboard states and drive the poll loop fast without
/// touching the real OS clipboard.
fn watch_with(
    read_files: Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>,
    interval: Duration,
) -> HostClipboardWatch {
    let (tick_tx, ticks) = mpsc::channel::<()>(TICK_CAPACITY);
    tokio::spawn(poll_loop(read_files, tick_tx, interval));
    debug!("watching host clipboard for CLIPRDR re-advertise (#1794)");
    HostClipboardWatch { ticks }
}

/// Read the host clipboard's current file list on the blocking pool so a slow
/// platform reader never stalls the async driver.
async fn read_current(read_files: &Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>) -> Vec<PathBuf> {
    let reader = Arc::clone(read_files);
    // A panic in the reader (there should be none — every reader swallows its own
    // errors) degrades to "no files", never a torn-down session.
    tokio::task::spawn_blocking(move || reader())
        .await
        .unwrap_or_default()
}

/// Poll the clipboard file list and emit a tick whenever it differs from the
/// previous poll. Ends when the tick channel closes (driver gone). The first read
/// seeds the baseline without ticking: the connect-time offer already covered it.
async fn poll_loop(
    read_files: Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>,
    tick_tx: mpsc::Sender<()>,
    interval: Duration,
) {
    use mpsc::error::TrySendError;
    let mut previous = read_current(&read_files).await;
    loop {
        // Wait out the interval, but wake immediately if the driver dropped the
        // receiver so the poll task exits promptly at session end.
        tokio::select! {
            biased;
            _ = tick_tx.closed() => return,
            _ = tokio::time::sleep(interval) => {}
        }
        let current = read_current(&read_files).await;
        if current == previous {
            continue;
        }
        debug!(
            was = previous.len(),
            now = current.len(),
            "host clipboard file list changed; re-advertising (#1794)"
        );
        previous = current;
        match tick_tx.try_send(()) {
            // A full channel already holds a tick the driver will act on, so
            // dropping this one loses nothing (a re-advertise reads the clipboard's
            // current state).
            Ok(()) | Err(TrySendError::Full(())) => {}
            Err(TrySendError::Closed(())) => return, // driver gone
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    /// A reader that hands out a scripted sequence of clipboard states, one per
    /// call, repeating the final state once the script is exhausted (so the poll
    /// loop keeps seeing "no change" and stops ticking).
    fn scripted(states: Vec<Vec<PathBuf>>) -> Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync> {
        let states = Arc::new(states);
        let calls = Arc::new(AtomicUsize::new(0));
        Arc::new(move || {
            let i = calls.fetch_add(1, Ordering::SeqCst);
            let idx = i.min(states.len().saturating_sub(1));
            states.get(idx).cloned().unwrap_or_default()
        })
    }

    async fn recv_timeout(rx: &mut mpsc::Receiver<()>, ms: u64) -> Option<()> {
        tokio::time::timeout(Duration::from_millis(ms), rx.recv())
            .await
            .ok()
            .flatten()
    }

    #[tokio::test]
    async fn ticks_when_the_file_list_changes_after_the_baseline() {
        // Baseline empty, then a file copied: exactly one tick fires.
        let watch = watch_with(
            scripted(vec![vec![], vec![p("/home/me/a.txt")]]),
            Duration::from_millis(5),
        );
        let mut ticks = watch.ticks;
        assert_eq!(
            recv_timeout(&mut ticks, 500).await,
            Some(()),
            "a mid-session copy must re-advertise"
        );
    }

    #[tokio::test]
    async fn does_not_tick_when_the_baseline_is_unchanged() {
        // The clipboard already holds files at connect and never changes: the
        // connect-time offer covered it, so the watcher stays silent.
        let watch = watch_with(
            scripted(vec![vec![p("/home/me/a.txt")]]),
            Duration::from_millis(5),
        );
        let mut ticks = watch.ticks;
        assert!(
            recv_timeout(&mut ticks, 120).await.is_none(),
            "an unchanged clipboard must not re-advertise"
        );
    }

    #[tokio::test]
    async fn ticks_when_files_are_replaced_by_a_different_set() {
        let watch = watch_with(
            scripted(vec![vec![p("/a")], vec![p("/b"), p("/c")]]),
            Duration::from_millis(5),
        );
        let mut ticks = watch.ticks;
        assert_eq!(recv_timeout(&mut ticks, 500).await, Some(()));
    }

    #[tokio::test]
    async fn ticks_when_the_file_list_is_cleared() {
        // Copying text after files empties the file list; the watcher re-advertises
        // so the now-stale file offer is dropped (the driver falls back to the
        // shared folder or a text advertisement).
        let watch = watch_with(
            scripted(vec![vec![p("/a")], vec![]]),
            Duration::from_millis(5),
        );
        let mut ticks = watch.ticks;
        assert_eq!(recv_timeout(&mut ticks, 500).await, Some(()));
    }

    #[tokio::test]
    async fn coalesces_repeated_reads_of_the_same_list() {
        // After the single change, the list stays put: only one tick, never a
        // steady stream of them.
        let watch = watch_with(
            scripted(vec![vec![], vec![p("/a")]]),
            Duration::from_millis(5),
        );
        let mut ticks = watch.ticks;
        assert_eq!(recv_timeout(&mut ticks, 500).await, Some(()));
        assert!(
            recv_timeout(&mut ticks, 100).await.is_none(),
            "a stable clipboard must not keep re-advertising"
        );
    }

    #[tokio::test]
    async fn poll_task_stops_when_the_receiver_is_dropped() {
        // Track reads so we can prove the task stopped polling after the receiver
        // went away.
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let reader: Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync> = Arc::new(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        });
        let watch = watch_with(reader, Duration::from_millis(5));
        drop(watch.ticks); // as the driver does at session end
                           // Give the task a chance to observe the closed channel and exit.
        tokio::time::sleep(Duration::from_millis(60)).await;
        let after_drop = count.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(
            count.load(Ordering::SeqCst),
            after_drop,
            "the poll task must stop reading once the receiver is dropped"
        );
    }

    #[tokio::test]
    async fn survives_a_reader_that_briefly_holds_a_lock() {
        // The real readers can block; a reader that serializes on a mutex must not
        // deadlock the loop. This mostly guards that reads run on the blocking pool.
        let gate = Arc::new(Mutex::new(0u32));
        let g = Arc::clone(&gate);
        let reader: Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync> = Arc::new(move || {
            let mut n = g.lock().expect("lock");
            *n += 1;
            if *n >= 2 {
                vec![p("/late")]
            } else {
                Vec::new()
            }
        });
        let watch = watch_with(reader, Duration::from_millis(5));
        let mut ticks = watch.ticks;
        assert_eq!(recv_timeout(&mut ticks, 500).await, Some(()));
    }
}
