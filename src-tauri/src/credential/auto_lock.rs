use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

use super::manager::CredentialManager;
use super::types::{build_status_info, CredentialStoreStatusInfo};

/// Event emitted when the credential store is locked by the auto-lock timer.
const EVENT_STORE_LOCKED: &str = "credential-store-locked";
/// Event emitted when the credential store status changes.
const EVENT_STORE_STATUS_CHANGED: &str = "credential-store-status-changed";

/// Payload for the `credential-store-locked` event.
///
/// `auto` distinguishes an inactivity auto-lock (`true`) from a manual/mode-switch
/// lock (`false`) so the frontend can toast on auto-lock only (G7, #1144) without
/// double-toasting the manual lock, which the indicator already confirms.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LockedEventPayload {
    pub auto: bool,
}

/// Source of "now" for the auto-lock timer.
///
/// Production uses [`SystemClock`]; unit tests inject a fake clock they can
/// advance past the (minimum five-minute) timeout without really sleeping
/// (#3690).
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// The real monotonic clock.
struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Receiver of the events the timer fires after an inactivity auto-lock.
///
/// Implemented for [`AppHandle`] in production; unit tests record the events
/// instead, so the lock path is testable without a Tauri runtime (#3690).
pub(crate) trait LockEventSink {
    fn store_locked(&self, payload: LockedEventPayload);
    fn status_changed(&self, status: &CredentialStoreStatusInfo);
}

impl LockEventSink for AppHandle {
    fn store_locked(&self, payload: LockedEventPayload) {
        if let Err(e) = self.emit(EVENT_STORE_LOCKED, payload) {
            warn!("Failed to emit {}: {}", EVENT_STORE_LOCKED, e);
        }
    }

    fn status_changed(&self, status: &CredentialStoreStatusInfo) {
        if let Err(e) = self.emit(EVENT_STORE_STATUS_CHANGED, status) {
            warn!("Failed to emit {}: {}", EVENT_STORE_STATUS_CHANGED, e);
        }
    }
}

/// Lock the master-password store after inactivity and tell the frontend.
///
/// This is what the production timer runs on expiry. `auto: true` tells the
/// frontend this was an inactivity lock, so it can toast.
pub(crate) fn auto_lock_store(credential_manager: &CredentialManager, sink: &dyn LockEventSink) {
    credential_manager.with_master_password_store(|s| s.lock());
    sink.store_locked(LockedEventPayload { auto: true });
    sink.status_changed(&build_status_info(credential_manager));
}

/// Mutable state protected by a `Mutex` and signalled via `Condvar`.
struct TimerInner {
    /// Auto-lock timeout in minutes. `None` means disabled.
    timeout_minutes: Option<u32>,
    /// Timestamp of last credential activity.
    last_activity: Instant,
    /// Whether the master password store is currently unlocked.
    store_unlocked: bool,
}

impl TimerInner {
    /// The configured timeout, or `None` when auto-lock is disabled.
    fn timeout(&self) -> Option<Duration> {
        match self.timeout_minutes {
            Some(mins) if mins > 0 => Some(Duration::from_secs(u64::from(mins) * 60)),
            _ => None,
        }
    }

    /// Returns `true` if the timer has expired (timeout elapsed since last
    /// activity) as of `now`.
    fn is_expired(&self, now: Instant) -> bool {
        match self.timeout() {
            Some(timeout) => now.saturating_duration_since(self.last_activity) >= timeout,
            None => false,
        }
    }

    /// Returns the remaining duration until the timer expires as of `now`, or
    /// `None` if the timer is disabled, already expired, or the store is locked.
    fn remaining_duration(&self, now: Instant) -> Option<Duration> {
        if !self.store_unlocked {
            return None;
        }
        let timeout = self.timeout()?;
        let elapsed = now.saturating_duration_since(self.last_activity);
        if elapsed >= timeout {
            None // already expired
        } else {
            Some(timeout - elapsed)
        }
    }
}

/// Background timer that automatically locks the master password credential
/// store after a configurable period of inactivity.
///
/// Uses `std::thread` + `Condvar` for the background loop (consistent with
/// existing patterns in the codebase). The thread sleeps until either the
/// timeout elapses or it is woken by a state change (activity, config change,
/// unlock/lock notification, or shutdown).
///
/// The loop itself only knows a [`Clock`] and a lock action; the production
/// constructor [`AutoLockTimer::new`] wires those to the real clock and to
/// [`auto_lock_store`] + the [`AppHandle`]. Tests use
/// [`AutoLockTimer::spawn_with`] to drive expiry deterministically (#3690).
pub struct AutoLockTimer {
    inner: Mutex<TimerInner>,
    condvar: Condvar,
    shutdown: AtomicBool,
    clock: Arc<dyn Clock>,
}

impl AutoLockTimer {
    /// Create a new `AutoLockTimer` and spawn its background thread.
    ///
    /// - `app_handle`: used to emit events when the store is auto-locked.
    /// - `credential_manager`: used to perform the actual lock operation.
    /// - `timeout_minutes`: initial timeout (`None` or `Some(0)` = disabled).
    ///
    /// Returns `Err` when the background thread cannot be spawned (e.g. resource
    /// exhaustion). This must **not** panic (WA-RS-004): a dead timer would
    /// never lock the store, so the store could stay unlocked indefinitely — the
    /// opposite of fail-safe for a security feature. Propagating the error lets
    /// the caller keep the store locked and refuse to unlock it until a timer is
    /// available (see [`CredentialManager::has_auto_lock_timer`] and the unlock
    /// commands).
    pub fn new(
        app_handle: AppHandle,
        credential_manager: Arc<CredentialManager>,
        timeout_minutes: Option<u32>,
    ) -> std::io::Result<Arc<Self>> {
        Self::spawn_with(Arc::new(SystemClock), timeout_minutes, move || {
            auto_lock_store(&credential_manager, &app_handle);
        })
    }

    /// Spawn a timer with an injected clock and lock action.
    ///
    /// `on_expire` runs on the timer thread, outside the timer's mutex, each
    /// time an unlocked store stays inactive for the full timeout.
    pub(crate) fn spawn_with(
        clock: Arc<dyn Clock>,
        timeout_minutes: Option<u32>,
        on_expire: impl Fn() + Send + 'static,
    ) -> std::io::Result<Arc<Self>> {
        let timer = Arc::new(Self {
            inner: Mutex::new(TimerInner {
                timeout_minutes,
                last_activity: clock.now(),
                store_unlocked: false,
            }),
            condvar: Condvar::new(),
            shutdown: AtomicBool::new(false),
            clock,
        });

        let timer_clone = Arc::clone(&timer);
        std::thread::Builder::new()
            .name("auto-lock-timer".to_string())
            .spawn(move || {
                timer_clone.run_loop(&on_expire);
            })?;

        Ok(timer)
    }

    /// Record credential activity, resetting the inactivity timer.
    pub fn record_activity(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_activity = self.clock.now();
        }
        self.condvar.notify_one();
    }

    /// Update the timeout duration. `None` or `Some(0)` disables auto-lock.
    pub fn set_timeout(&self, minutes: Option<u32>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.timeout_minutes = minutes;
            // Reset activity when changing timeout so it starts fresh
            inner.last_activity = self.clock.now();
        }
        self.condvar.notify_one();
    }

    /// Notify the timer that the store has been unlocked.
    pub fn notify_unlocked(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.store_unlocked = true;
            inner.last_activity = self.clock.now();
        }
        self.condvar.notify_one();
    }

    /// Notify the timer that the store has been locked (manually or by mode switch).
    pub fn notify_locked(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.store_unlocked = false;
        }
        self.condvar.notify_one();
    }

    /// Signal the background thread to shut down.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.condvar.notify_one();
    }

    /// Background loop: waits for timeout expiry or state changes.
    fn run_loop(&self, on_expire: &dyn Fn()) {
        loop {
            if self.shutdown.load(Ordering::SeqCst) {
                return;
            }

            let mut inner = match self.inner.lock() {
                Ok(guard) => guard,
                Err(_) => return, // poisoned — exit gracefully
            };

            // Determine what to do based on current state
            if !inner.store_unlocked {
                // Store is locked — wait indefinitely until woken
                inner = match self.condvar.wait(inner) {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                drop(inner);
                continue;
            }

            let now = self.clock.now();
            match inner.remaining_duration(now) {
                None if inner.is_expired(now) => {
                    // Timer has expired — lock the store
                    info!("Auto-lock timer expired, locking credential store");
                    inner.store_unlocked = false;
                    drop(inner);

                    // Perform the lock outside of our mutex to avoid deadlock
                    on_expire();
                }
                None => {
                    // Timeout disabled — wait indefinitely
                    inner = match self.condvar.wait(inner) {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    drop(inner);
                }
                Some(remaining) => {
                    // Wait for the remaining duration or a wake-up
                    let (_inner, _timeout_result) =
                        match self.condvar.wait_timeout(inner, remaining) {
                            Ok(result) => result,
                            Err(_) => return,
                        };
                    // Loop back to re-evaluate state (may have been woken by
                    // activity reset, config change, or shutdown)
                }
            }
        }
    }

    /// Wake the loop so it re-reads the (fake) clock. Taking the mutex first
    /// guarantees the loop is either parked on the condvar (and gets this
    /// notification) or has not yet read the clock (and will see the advance).
    #[cfg(test)]
    fn wake(&self) {
        let _guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.condvar.notify_one();
    }
}

impl Drop for AutoLockTimer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::types::StorageMode;
    use std::sync::mpsc;

    const MIN: Duration = Duration::from_secs(60);

    fn make_inner(timeout_minutes: Option<u32>, store_unlocked: bool) -> (TimerInner, Instant) {
        let now = Instant::now();
        let inner = TimerInner {
            timeout_minutes,
            last_activity: now,
            store_unlocked,
        };
        (inner, now)
    }

    #[test]
    fn is_expired_returns_false_when_disabled() {
        let (inner, now) = make_inner(None, true);
        assert!(!inner.is_expired(now + 60 * MIN));
    }

    #[test]
    fn is_expired_returns_false_when_zero() {
        let (inner, now) = make_inner(Some(0), true);
        assert!(!inner.is_expired(now + 60 * MIN));
    }

    #[test]
    fn is_expired_returns_false_when_recent_activity() {
        let (inner, now) = make_inner(Some(15), true);
        assert!(!inner.is_expired(now));
        assert!(!inner.is_expired(now + 14 * MIN));
    }

    #[test]
    fn is_expired_returns_true_when_elapsed() {
        let (inner, now) = make_inner(Some(1), true);
        assert!(inner.is_expired(now + MIN));
        assert!(inner.is_expired(now + 2 * MIN));
    }

    #[test]
    fn remaining_duration_returns_none_when_disabled() {
        let (inner, now) = make_inner(None, true);
        assert!(inner.remaining_duration(now).is_none());
    }

    #[test]
    fn remaining_duration_returns_none_when_store_locked() {
        let (inner, now) = make_inner(Some(15), false);
        assert!(inner.remaining_duration(now).is_none());
    }

    #[test]
    fn remaining_duration_returns_none_when_expired() {
        let (inner, now) = make_inner(Some(1), true);
        assert!(inner.remaining_duration(now + 2 * MIN).is_none());
    }

    #[test]
    fn remaining_duration_returns_full_timeout_right_after_activity() {
        let (inner, now) = make_inner(Some(15), true);
        assert_eq!(inner.remaining_duration(now), Some(15 * MIN));
    }

    #[test]
    fn remaining_duration_decreases_over_time() {
        let (inner, now) = make_inner(Some(15), true);
        assert_eq!(inner.remaining_duration(now + 5 * MIN), Some(10 * MIN));
    }

    #[test]
    fn auto_lock_payload_flags_auto_true() {
        // G7 (#1144): the auto-lock timer must tag its lock event with auto=true
        // so the frontend can show the "auto-locked after inactivity" toast
        // while a manual lock (auto=false) stays silent to avoid a double-toast.
        let payload = LockedEventPayload { auto: true };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["auto"], serde_json::json!(true));
    }

    // --- Timer thread driven by a fake clock (#3690, MT-CRED-04) ---
    //
    // The shortest real timeout is five minutes, so these tests never wait on
    // it: they advance a fake clock and wake the loop. The only real waits are
    // a bounded `recv_timeout` for an expected lock, and a short one to show
    // that no lock fires before the timeout.

    /// How long to wait for a lock that must happen (generous for slow CI).
    const FIRES: Duration = Duration::from_secs(10);
    /// How long to watch for a lock that must *not* happen.
    const QUIET: Duration = Duration::from_millis(200);

    /// A clock that only moves when the test advances it.
    struct FakeClock {
        base: Instant,
        offset: Mutex<Duration>,
    }

    impl FakeClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                base: Instant::now(),
                offset: Mutex::new(Duration::ZERO),
            })
        }

        /// Move time forward and let the timer thread re-evaluate.
        fn advance(&self, timer: &AutoLockTimer, by: Duration) {
            *self.offset.lock().unwrap() += by;
            timer.wake();
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.base + *self.offset.lock().unwrap()
        }
    }

    /// A timer whose lock action reports on a channel.
    fn channel_timer(
        minutes: Option<u32>,
    ) -> (Arc<AutoLockTimer>, Arc<FakeClock>, mpsc::Receiver<()>) {
        let clock = FakeClock::new();
        let (tx, rx) = mpsc::channel();
        let timer = AutoLockTimer::spawn_with(clock.clone(), minutes, move || {
            let _ = tx.send(());
        })
        .expect("spawn timer thread");
        (timer, clock, rx)
    }

    fn is_unlocked(timer: &AutoLockTimer) -> bool {
        timer.inner.lock().unwrap().store_unlocked
    }

    #[test]
    fn unlocked_store_locks_once_timeout_elapses() {
        let (timer, clock, rx) = channel_timer(Some(5));
        timer.notify_unlocked();

        clock.advance(&timer, 5 * MIN - Duration::from_secs(1));
        assert!(rx.recv_timeout(QUIET).is_err(), "locked before the timeout");
        assert!(is_unlocked(&timer));

        clock.advance(&timer, Duration::from_secs(2));
        rx.recv_timeout(FIRES).expect("auto-lock did not fire");
        assert!(!is_unlocked(&timer));

        // It fires exactly once: the store is now locked, so more idle time
        // does nothing until the next unlock.
        clock.advance(&timer, 60 * MIN);
        assert!(rx.recv_timeout(QUIET).is_err(), "auto-lock fired twice");
        timer.shutdown();
    }

    #[test]
    fn activity_resets_the_inactivity_window() {
        let (timer, clock, rx) = channel_timer(Some(5));
        timer.notify_unlocked();

        clock.advance(&timer, 4 * MIN);
        timer.record_activity();
        clock.advance(&timer, 4 * MIN);
        assert!(
            rx.recv_timeout(QUIET).is_err(),
            "activity did not reset the timer"
        );

        clock.advance(&timer, MIN);
        rx.recv_timeout(FIRES).expect("auto-lock did not fire");
        timer.shutdown();
    }

    #[test]
    fn locked_store_never_fires_and_relocking_is_a_no_op() {
        let (timer, clock, rx) = channel_timer(Some(5));

        // Never unlocked: idle time alone must not trigger a lock.
        clock.advance(&timer, 60 * MIN);
        assert!(rx.recv_timeout(QUIET).is_err());

        // Locking an already-locked store changes nothing and fires nothing.
        timer.notify_locked();
        clock.advance(&timer, 60 * MIN);
        assert!(rx.recv_timeout(QUIET).is_err());
        assert!(!is_unlocked(&timer));

        // A manual lock before expiry cancels the pending auto-lock.
        timer.notify_unlocked();
        clock.advance(&timer, 4 * MIN);
        timer.notify_locked();
        clock.advance(&timer, 60 * MIN);
        assert!(rx.recv_timeout(QUIET).is_err());
        timer.shutdown();
    }

    #[test]
    fn disabled_timeout_never_fires() {
        let (timer, clock, rx) = channel_timer(None);
        timer.notify_unlocked();
        clock.advance(&timer, 24 * 60 * MIN);
        assert!(rx.recv_timeout(QUIET).is_err());
        assert!(is_unlocked(&timer));

        // Enabling it later starts a fresh window from that moment.
        timer.set_timeout(Some(5));
        clock.advance(&timer, 5 * MIN);
        rx.recv_timeout(FIRES)
            .expect("auto-lock did not fire after enabling");
        timer.shutdown();
    }

    /// Records the events the production lock action emits.
    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<(&'static str, serde_json::Value)>>,
    }

    impl LockEventSink for RecordingSink {
        fn store_locked(&self, payload: LockedEventPayload) {
            let v = serde_json::to_value(payload).unwrap();
            self.events.lock().unwrap().push((EVENT_STORE_LOCKED, v));
        }

        fn status_changed(&self, status: &CredentialStoreStatusInfo) {
            let v = serde_json::to_value(status).unwrap();
            self.events
                .lock()
                .unwrap()
                .push((EVENT_STORE_STATUS_CHANGED, v));
        }
    }

    #[test]
    fn expiry_locks_the_real_master_password_store_and_emits_events() {
        // MT-CRED-04 end to end below the UI: an unlocked master-password
        // store, the production lock action, and a timeout that elapses.
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(CredentialManager::new(
            StorageMode::MasterPassword,
            dir.path().to_path_buf(),
        ));
        manager
            .with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();
        assert_eq!(
            manager.with_master_password_store(|s| s.is_unlocked()),
            Some(true)
        );

        let sink = Arc::new(RecordingSink::default());
        let clock = FakeClock::new();
        let (tx, rx) = mpsc::channel();
        let (m, k) = (manager.clone(), sink.clone());
        let timer = AutoLockTimer::spawn_with(clock.clone(), Some(5), move || {
            auto_lock_store(&m, k.as_ref());
            let _ = tx.send(());
        })
        .unwrap();
        timer.notify_unlocked();

        clock.advance(&timer, 5 * MIN);
        rx.recv_timeout(FIRES).expect("auto-lock did not fire");
        timer.shutdown();

        assert_eq!(
            manager.with_master_password_store(|s| s.is_unlocked()),
            Some(false)
        );
        let events = sink.events.lock().unwrap();
        assert_eq!(
            *events,
            vec![
                (EVENT_STORE_LOCKED, serde_json::json!({ "auto": true })),
                (
                    EVENT_STORE_STATUS_CHANGED,
                    serde_json::json!({ "mode": "master_password", "status": "locked" })
                ),
            ]
        );
    }
}
