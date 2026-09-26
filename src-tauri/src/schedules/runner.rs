//! The scheduler loop (PROD-043): ticks the [`ScheduleManager`] on a fixed
//! period while the app runs and hands fired runs to the app windows.
//!
//! The loop reads the **wall clock** on every tick (through [`Clock`]), so a
//! machine that slept or a suspended process simply sees a jump in time and the
//! manager's missed-run policy applies. The clock and the event sink are
//! injected so tests drive the loop under tokio's paused time.

use std::sync::Arc;

use chrono::{DateTime, TimeZone, Utc};
use tauri::{AppHandle, Emitter, Manager};

use super::manager::{ScheduleFire, ScheduleManager};

/// How often the loop ticks. Well inside [`super::manager::MISSED_GRACE`], so
/// an on-time run is never mistaken for a missed one.
pub const TICK_PERIOD: std::time::Duration = std::time::Duration::from_secs(15);

/// Event carrying a [`ScheduleFire`] to the windows.
pub const EVENT_SCHEDULE_FIRE: &str = "schedule-fire";

/// Event telling the windows to reload the schedule list (a run settled, a
/// result was recorded, a next-run time moved).
pub const EVENT_SCHEDULES_CHANGED: &str = "schedules-changed";

/// A source of the current wall-clock time.
pub trait Clock: Send + Sync {
    /// Now, in UTC.
    fn now(&self) -> DateTime<Utc>;
}

/// The real wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Where the loop sends its decisions.
pub trait ScheduleSink: Send + Sync {
    /// Labels of the currently open app windows.
    fn live_windows(&self) -> Vec<String>;
    /// Deliver a fired run to every window.
    fn fire(&self, fire: &ScheduleFire);
    /// Tell the windows the schedule list changed.
    fn changed(&self);
}

/// The Tauri sink: emits to every webview window.
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    /// Wrap an app handle.
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ScheduleSink for TauriSink {
    fn live_windows(&self) -> Vec<String> {
        self.app.webview_windows().keys().cloned().collect()
    }

    fn fire(&self, fire: &ScheduleFire) {
        if let Err(e) = self.app.emit(EVENT_SCHEDULE_FIRE, fire) {
            tracing::warn!("failed to emit {EVENT_SCHEDULE_FIRE}: {e}");
        }
    }

    fn changed(&self) {
        if let Err(e) = self.app.emit(EVENT_SCHEDULES_CHANGED, ()) {
            tracing::warn!("failed to emit {EVENT_SCHEDULES_CHANGED}: {e}");
        }
    }
}

/// One tick: advance the manager and forward what it decided.
pub fn tick_once<Tz: TimeZone>(
    manager: &ScheduleManager,
    clock: &dyn Clock,
    tz: &Tz,
    sink: &dyn ScheduleSink,
) {
    let result = manager.tick(clock.now(), tz, &sink.live_windows());
    for fire in &result.fires {
        sink.fire(fire);
    }
    if result.changed {
        sink.changed();
    }
}

/// Run the scheduler forever (until the task is dropped), ticking every
/// `period`.
pub async fn run_loop<Tz>(
    manager: Arc<ScheduleManager>,
    clock: Arc<dyn Clock>,
    tz: Tz,
    sink: Arc<dyn ScheduleSink>,
    period: std::time::Duration,
) where
    Tz: TimeZone + Send + Sync + 'static,
{
    let mut interval = tokio::time::interval(period);
    // After a stall (sleep), tick once — the manager itself handles the
    // missed slots; replaying every lost tick would be pointless.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        tick_once(&manager, clock.as_ref(), &tz, sink.as_ref());
    }
}

/// Start the scheduler loop for the app (production wiring: wall clock, the
/// machine's local time zone, Tauri events).
pub fn start(app: &AppHandle) {
    let Some(manager) = app.try_state::<Arc<ScheduleManager>>() else {
        tracing::warn!("schedule manager unavailable; scheduled runs are disabled");
        return;
    };
    let manager = manager.inner().clone();
    let sink: Arc<dyn ScheduleSink> = Arc::new(TauriSink::new(app.clone()));
    tauri::async_runtime::spawn(run_loop(
        manager,
        Arc::new(SystemClock),
        chrono::Local,
        sink,
        TICK_PERIOD,
    ));
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
