use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Outcome of finishing a connecting tunnel (see [`ConnectingTracker::finish`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishOutcome {
    /// No Stop was requested — the started forwarder should become active.
    Commit,
    /// Stop was requested while connecting — tear the started forwarder down.
    Cancelled,
    /// The tunnel was no longer tracked as connecting. Treated like `Cancelled`.
    Gone,
}

/// Tracks tunnels that are mid-connect so a Stop request issued during the
/// `connecting` phase can cancel a pending start before it lands in the active
/// map.
///
/// Starting a tunnel runs a blocking SSH handshake before the tunnel is
/// registered as active. During that window `stop_tunnel` has nothing to
/// remove, so without this tracker a Stop click is silently lost and the tunnel
/// later flips to `connected` (issue #829). The tracker records each connecting
/// tunnel with a cancel flag: `stop` sets the flag, and `start` honours it when
/// the handshake completes — tearing the just-built forwarder down instead of
/// committing it.
#[derive(Default)]
pub struct ConnectingTracker {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ConnectingTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        // A poisoned lock only means a previous holder panicked; the map itself
        // stays consistent, so recover rather than propagate the panic.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Mark a tunnel as connecting. Returns `false` if it is already connecting.
    pub fn begin(&self, tunnel_id: &str) -> bool {
        let mut inner = self.lock();
        if inner.contains_key(tunnel_id) {
            return false;
        }
        inner.insert(tunnel_id.to_string(), Arc::new(AtomicBool::new(false)));
        true
    }

    /// Whether the given tunnel is currently in the connecting phase.
    pub fn is_connecting(&self, tunnel_id: &str) -> bool {
        self.lock().contains_key(tunnel_id)
    }

    /// Request cancellation of a connecting tunnel. Returns `true` if the tunnel
    /// was connecting (and is now flagged to cancel when its start completes).
    pub fn request_cancel(&self, tunnel_id: &str) -> bool {
        match self.lock().get(tunnel_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Finish a connecting tunnel, removing it from the tracker and reporting
    /// whether a Stop was requested in the meantime.
    pub fn finish(&self, tunnel_id: &str) -> FinishOutcome {
        match self.lock().remove(tunnel_id) {
            Some(flag) if flag.load(Ordering::SeqCst) => FinishOutcome::Cancelled,
            Some(_) => FinishOutcome::Commit,
            None => FinishOutcome::Gone,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_marks_tunnel_connecting() {
        let tracker = ConnectingTracker::new();
        assert!(!tracker.is_connecting("t1"));
        assert!(tracker.begin("t1"));
        assert!(tracker.is_connecting("t1"));
    }

    #[test]
    fn begin_rejects_duplicate() {
        let tracker = ConnectingTracker::new();
        assert!(tracker.begin("t1"));
        assert!(!tracker.begin("t1"), "second begin must be rejected");
    }

    #[test]
    fn finish_without_cancel_commits() {
        let tracker = ConnectingTracker::new();
        tracker.begin("t1");
        assert_eq!(tracker.finish("t1"), FinishOutcome::Commit);
        assert!(!tracker.is_connecting("t1"), "finish removes the entry");
    }

    #[test]
    fn cancel_then_finish_reports_cancelled() {
        let tracker = ConnectingTracker::new();
        tracker.begin("t1");
        assert!(tracker.request_cancel("t1"));
        assert_eq!(tracker.finish("t1"), FinishOutcome::Cancelled);
    }

    #[test]
    fn request_cancel_unknown_returns_false() {
        let tracker = ConnectingTracker::new();
        assert!(!tracker.request_cancel("missing"));
    }

    #[test]
    fn finish_unknown_reports_gone() {
        let tracker = ConnectingTracker::new();
        assert_eq!(tracker.finish("missing"), FinishOutcome::Gone);
    }

    #[test]
    fn begin_again_after_finish_is_allowed() {
        let tracker = ConnectingTracker::new();
        tracker.begin("t1");
        tracker.finish("t1");
        assert!(
            tracker.begin("t1"),
            "a tunnel can connect again after a previous attempt finishes"
        );
    }

    #[test]
    fn cancel_only_affects_named_tunnel() {
        let tracker = ConnectingTracker::new();
        tracker.begin("t1");
        tracker.begin("t2");
        tracker.request_cancel("t1");
        assert_eq!(tracker.finish("t1"), FinishOutcome::Cancelled);
        assert_eq!(tracker.finish("t2"), FinishOutcome::Commit);
    }
}
