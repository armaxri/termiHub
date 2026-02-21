use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

use super::manager::CredentialManager;

/// Event emitted when the credential store is locked by the auto-lock timer.
const EVENT_STORE_LOCKED: &str = "credential-store-locked";
/// Event emitted when the credential store status changes.
const EVENT_STORE_STATUS_CHANGED: &str = "credential-store-status-changed";

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
    /// Returns `true` if the timer has expired (timeout elapsed since last activity).
    fn is_expired(&self) -> bool {
        match self.timeout_minutes {
            Some(mins) if mins > 0 => {
                self.last_activity.elapsed() >= Duration::from_secs(u64::from(mins) * 60)
            }
            _ => false,
        }
    }

    /// Returns the remaining duration until the timer expires, or `None` if
    /// the timer is disabled, already expired, or the store is locked.
    fn remaining_duration(&self) -> Option<Duration> {
        if !self.store_unlocked {
            return None;
        }
        match self.timeout_minutes {
            Some(mins) if mins > 0 => {
                let timeout = Duration::from_secs(u64::from(mins) * 60);
                let elapsed = self.last_activity.elapsed();
                if elapsed >= timeout {
                    None // already expired
                } else {
                    Some(timeout - elapsed)
                }
            }
            _ => None,
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
pub struct AutoLockTimer {
    inner: Mutex<TimerInner>,
    condvar: Condvar,
    shutdown: AtomicBool,
}

impl AutoLockTimer {
    /// Create a new `AutoLockTimer` and spawn its background thread.
    ///
    /// - `app_handle`: used to emit events when the store is auto-locked.
    /// - `credential_manager`: used to perform the actual lock operation.
    /// - `timeout_minutes`: initial timeout (`None` or `Some(0)` = disabled).
    pub fn new(
        app_handle: AppHandle,
        credential_manager: Arc<CredentialManager>,
        timeout_minutes: Option<u32>,
    ) -> Arc<Self> {
        let timer = Arc::new(Self {
            inner: Mutex::new(TimerInner {
                timeout_minutes,
                last_activity: Instant::now(),
                store_unlocked: false,
            }),
            condvar: Condvar::new(),
            shutdown: AtomicBool::new(false),
        });

        let timer_clone = Arc::clone(&timer);
        std::thread::Builder::new()
            .name("auto-lock-timer".to_string())
            .spawn(move || {
                timer_clone.run_loop(&app_handle, &credential_manager);
            })
            .expect("Failed to spawn auto-lock timer thread");

        timer
    }

    /// Record credential activity, resetting the inactivity timer.
    pub fn record_activity(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_activity = Instant::now();
        }
        self.condvar.notify_one();
    }

    /// Update the timeout duration. `None` or `Some(0)` disables auto-lock.
    pub fn set_timeout(&self, minutes: Option<u32>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.timeout_minutes = minutes;
            // Reset activity when changing timeout so it starts fresh
            inner.last_activity = Instant::now();
        }
        self.condvar.notify_one();
    }

    /// Notify the timer that the store has been unlocked.
    pub fn notify_unlocked(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.store_unlocked = true;
            inner.last_activity = Instant::now();
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
    fn run_loop(&self, app_handle: &AppHandle, credential_manager: &CredentialManager) {
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

            match inner.remaining_duration() {
                None if inner.is_expired() => {
                    // Timer has expired — lock the store
                    info!("Auto-lock timer expired, locking credential store");
                    inner.store_unlocked = false;
                    drop(inner);

                    // Perform the lock outside of our mutex to avoid deadlock
                    credential_manager.with_master_password_store(|s| s.lock());

                    // Emit events so the frontend can react
                    if let Err(e) = app_handle.emit(EVENT_STORE_LOCKED, ()) {
                        warn!("Failed to emit {}: {}", EVENT_STORE_LOCKED, e);
                    }

                    use super::types::build_status_info;
                    let status_info = build_status_info(credential_manager);
                    if let Err(e) = app_handle.emit(EVENT_STORE_STATUS_CHANGED, &status_info) {
                        warn!("Failed to emit {}: {}", EVENT_STORE_STATUS_CHANGED, e);
                    }
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
}

impl Drop for AutoLockTimer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_inner(timeout_minutes: Option<u32>, store_unlocked: bool) -> TimerInner {
        TimerInner {
            timeout_minutes,
            last_activity: Instant::now(),
            store_unlocked,
        }
    }

    #[test]
    fn is_expired_returns_false_when_disabled() {
        let inner = make_inner(None, true);
        assert!(!inner.is_expired());
    }

    #[test]
    fn is_expired_returns_false_when_zero() {
        let inner = make_inner(Some(0), true);
        assert!(!inner.is_expired());
    }

    #[test]
    fn is_expired_returns_false_when_recent_activity() {
        let inner = make_inner(Some(15), true);
        assert!(!inner.is_expired());
    }

    #[test]
    fn is_expired_returns_true_when_elapsed() {
        let mut inner = make_inner(Some(1), true);
        // Simulate activity 2 minutes ago
        inner.last_activity = Instant::now() - Duration::from_secs(120);
        assert!(inner.is_expired());
    }

    #[test]
    fn remaining_duration_returns_none_when_disabled() {
        let inner = make_inner(None, true);
        assert!(inner.remaining_duration().is_none());
    }

    #[test]
    fn remaining_duration_returns_none_when_store_locked() {
        let inner = make_inner(Some(15), false);
        assert!(inner.remaining_duration().is_none());
    }

    #[test]
    fn remaining_duration_returns_none_when_expired() {
        let mut inner = make_inner(Some(1), true);
        inner.last_activity = Instant::now() - Duration::from_secs(120);
        assert!(inner.remaining_duration().is_none());
    }

    #[test]
    fn remaining_duration_returns_some_when_active() {
        let inner = make_inner(Some(15), true);
        let remaining = inner.remaining_duration().unwrap();
        // Should be close to 15 minutes
        assert!(remaining > Duration::from_secs(14 * 60));
        assert!(remaining <= Duration::from_secs(15 * 60));
    }

    #[test]
    fn remaining_duration_decreases_over_time() {
        let mut inner = make_inner(Some(15), true);
        // Simulate activity 5 minutes ago
        inner.last_activity = Instant::now() - Duration::from_secs(5 * 60);
        let remaining = inner.remaining_duration().unwrap();
        // Should be close to 10 minutes
        assert!(remaining > Duration::from_secs(9 * 60));
        assert!(remaining <= Duration::from_secs(10 * 60));
    }
}
