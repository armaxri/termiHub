//! The schedule authority (PROD-043): CRUD, the enable/confirm/pause safety
//! rules, and the pure-given-a-clock [`ScheduleManager::tick`] that decides
//! which schedules fire.
//!
//! # Execution rules
//!
//! On every tick, for each **enabled** schedule whose next run is due:
//!
//! 1. **Global pause** — while paused, the due run is skipped silently and the
//!    next run is computed from now (a resume never replays the paused period).
//! 2. **Missed run** — a run more than [`MISSED_GRACE`] late (the app was
//!    closed or the machine slept) is skipped with a logged reason, or — when
//!    the schedule's policy is `run-once` — run once now, however many slots
//!    were missed.
//! 3. **No overlap** — if the schedule's previous run is still in flight, the
//!    due run is skipped with a logged reason.
//! 4. Otherwise it **fires**: a [`ScheduleFire`] is emitted to every open app
//!    window whose frontend registered as listening (while none has — the app
//!    is booting — the due run is held). The run stays in flight until each of
//!    those windows reported, closed, or failed to acknowledge it within
//!    [`ACK_TIMEOUT`], or [`STALE_RUN_TIMEOUT`] passed.
//!
//! Whether the targets are connected is decided by the frontend (it owns the
//! tabs); a window with no connected target reports `skipped`.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use tauri::AppHandle;

use super::config::{Schedule, ScheduleStore, ScheduleTargets};
use super::storage::ScheduleStorage;
use super::tick::{self, TickContext};
use super::timing::next_run_after;
use super::wire::{aggregate, err, validate_input};
pub use super::wire::{
    ScheduleFire, ScheduleInput, ScheduleView, SchedulerState, TickResult, WindowRunReport,
};
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// How late a due run may be and still count as on time. Anything later was
/// missed (the app was closed, the machine slept, or the loop was starved).
pub const MISSED_GRACE: Duration = Duration::minutes(2);

/// A fired run that no window settled within this long is closed as failed,
/// so a lost report (a crashed webview) cannot block the schedule forever.
pub const STALE_RUN_TIMEOUT: Duration = Duration::hours(6);

/// A window that has not acknowledged a fired run within this long (it was
/// reloading, or its listener is gone) is dropped from the run's audience.
pub const ACK_TIMEOUT: Duration = Duration::seconds(60);

/// A fired run awaiting its windows' reports.
#[derive(Debug, Clone)]
pub(super) struct ActiveRun {
    pub(super) token: String,
    pub(super) fired_at: DateTime<Utc>,
    pub(super) catch_up: bool,
    /// Windows that still owe a report.
    pub(super) pending: BTreeSet<String>,
    /// Windows that acknowledged receiving the fire.
    pub(super) acked: BTreeSet<String>,
    pub(super) reports: Vec<WindowRunReport>,
}

/// In-memory scheduling state of one schedule.
#[derive(Debug, Default, Clone)]
pub(super) struct Runtime {
    pub(super) next_due: Option<DateTime<Utc>>,
    pub(super) active: Option<ActiveRun>,
}

struct Inner {
    store: ScheduleStore,
    runtime: HashMap<String, Runtime>,
    /// Windows whose frontend is listening for `schedule-fire` (registered
    /// via `register_schedule_window`). Only these receive runs.
    ready: BTreeSet<String>,
}

/// Central schedule manager.
pub struct ScheduleManager {
    inner: Mutex<Inner>,
    storage: ScheduleStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

fn parse_ts(s: Option<&str>) -> Option<DateTime<Utc>> {
    s.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

/// The interval origin: when the schedule was (last) enabled or re-timed.
pub(super) fn anchor_of(s: &Schedule, now: DateTime<Utc>) -> DateTime<Utc> {
    parse_ts(s.enabled_at.as_deref())
        .or_else(|| parse_ts(Some(&s.created_at)))
        .unwrap_or(now)
}

/// The first due time for a schedule with no in-memory state (app start):
/// the first slot after the latest point the schedule was known current, so
/// a slot that passed while the app was closed is detected as missed.
pub(super) fn initial_due<Tz: TimeZone>(
    s: &Schedule,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Option<DateTime<Utc>> {
    let after = [
        parse_ts(s.last_run_at.as_deref()),
        parse_ts(s.enabled_at.as_deref()),
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(now)
    .min(now);
    next_run_after(&s.rule, after, anchor_of(s, now), tz)
}

impl ScheduleManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            ScheduleStorage::new(app_handle).context("Failed to initialize schedule storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load schedules")?;
        Ok(Self::from_parts(result.data, storage, result.warnings))
    }

    fn from_parts(
        store: ScheduleStore,
        storage: ScheduleStorage,
        warnings: Vec<RecoveryWarning>,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                store,
                runtime: HashMap::new(),
                ready: BTreeSet::new(),
            }),
            storage,
            recovery_warnings: Mutex::new(warnings),
        }
    }

    /// A manager over a test directory.
    #[cfg(test)]
    pub fn new_test(dir: &std::path::Path) -> Self {
        let storage = ScheduleStorage::new_test(dir);
        let store = storage
            .load_with_recovery()
            .map(|r| r.data)
            .unwrap_or_default();
        Self::from_parts(store, storage, Vec::new())
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, TerminalError> {
        self.inner.lock().map_err(|e| err(e.to_string()))
    }

    fn persist(&self, store: &ScheduleStore) -> Result<(), TerminalError> {
        self.storage.save(store).map_err(|e| err(e.to_string()))
    }

    fn view<Tz: TimeZone>(
        inner: &Inner,
        s: &Schedule,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> ScheduleView {
        let rt = inner.runtime.get(&s.id);
        let next = if s.enabled {
            rt.and_then(|r| r.next_due)
                .or_else(|| initial_due(s, now, tz))
                .map(|d| d.max(now).to_rfc3339())
        } else {
            None
        };
        ScheduleView {
            schedule: s.clone(),
            next_run_at: next,
            running: rt.is_some_and(|r| r.active.is_some()),
        }
    }

    fn state_of<Tz: TimeZone>(inner: &Inner, now: DateTime<Utc>, tz: &Tz) -> SchedulerState {
        SchedulerState {
            paused: inner.store.paused,
            schedules: inner
                .store
                .schedules
                .iter()
                .map(|s| Self::view(inner, s, now, tz))
                .collect(),
        }
    }

    /// The whole scheduler state.
    pub fn state<Tz: TimeZone>(
        &self,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> Result<SchedulerState, TerminalError> {
        let inner = self.lock()?;
        Ok(Self::state_of(&inner, now, tz))
    }

    /// Add or update a schedule from the editor.
    ///
    /// A new schedule is always stored **disabled** and unconfirmed. On
    /// update, the backend-owned fields are preserved — except that changing
    /// the action or the targets disables the schedule and drops its
    /// confirmation, so a schedule can never start typing into new hosts
    /// without the user confirming them again.
    pub fn save<Tz: TimeZone>(
        &self,
        mut input: ScheduleInput,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> Result<ScheduleView, TerminalError> {
        validate_input(&input)?;
        input.name = input.name.trim().to_string();
        if let ScheduleTargets::Connections { connection_ids } = &mut input.targets {
            let mut seen = BTreeSet::new();
            connection_ids.retain(|c| !c.trim().is_empty() && seen.insert(c.clone()));
        }
        if input.id.trim().is_empty() {
            input.id = format!("schedule-{}", uuid::Uuid::new_v4());
        }
        let stamp = now.to_rfc3339();
        let mut inner = self.lock()?;
        let inner = &mut *inner;
        let idx = match inner.store.schedules.iter().position(|s| s.id == input.id) {
            Some(i) => {
                let s = &mut inner.store.schedules[i];
                let retarget = s.action != input.action || s.targets != input.targets;
                let retimed = s.rule != input.rule;
                if retarget {
                    s.enabled = false;
                    s.confirmed_at = None;
                    s.enabled_at = None;
                }
                if retimed && s.enabled {
                    // Re-time from now: an edit never triggers a catch-up.
                    s.enabled_at = Some(stamp.clone());
                }
                s.name = input.name;
                s.action = input.action;
                s.targets = input.targets;
                s.rule = input.rule;
                s.missed_runs = input.missed_runs;
                s.updated_at = stamp.clone();
                i
            }
            None => {
                inner.store.schedules.push(Schedule {
                    id: input.id.clone(),
                    name: input.name,
                    action: input.action,
                    targets: input.targets,
                    rule: input.rule,
                    missed_runs: input.missed_runs,
                    enabled: false,
                    confirmed_at: None,
                    enabled_at: None,
                    last_run_at: None,
                    last_result: None,
                    history: Vec::new(),
                    created_at: stamp.clone(),
                    updated_at: stamp,
                });
                inner.store.schedules.len() - 1
            }
        };
        let s = &inner.store.schedules[idx];
        let next = if s.enabled {
            next_run_after(&s.rule, now, anchor_of(s, now), tz)
        } else {
            None
        };
        inner.runtime.entry(s.id.clone()).or_default().next_due = next;
        self.persist(&inner.store)?;
        Ok(Self::view(inner, &inner.store.schedules[idx], now, tz))
    }

    /// Delete a schedule. An in-flight run is left to finish; its report is
    /// then ignored.
    pub fn delete(&self, id: &str) -> Result<(), TerminalError> {
        let mut inner = self.lock()?;
        let before = inner.store.schedules.len();
        inner.store.schedules.retain(|s| s.id != id);
        if inner.store.schedules.len() == before {
            return Err(err(format!("Schedule not found: {id}")));
        }
        inner.runtime.remove(id);
        self.persist(&inner.store)
    }

    /// Enable or disable a schedule.
    ///
    /// The **first** enable must carry `confirmed = true` — the user saw and
    /// accepted the list of hosts the schedule will type into; without it the
    /// call is refused. Enabling re-anchors the schedule at `now`, so it never
    /// catches up on slots from before it was enabled.
    pub fn set_enabled<Tz: TimeZone>(
        &self,
        id: &str,
        enabled: bool,
        confirmed: bool,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> Result<ScheduleView, TerminalError> {
        let mut inner = self.lock()?;
        let inner = &mut *inner;
        let idx = inner
            .store
            .schedules
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| err(format!("Schedule not found: {id}")))?;
        let s = &mut inner.store.schedules[idx];
        let stamp = now.to_rfc3339();
        if enabled {
            if s.confirmed_at.is_none() && !confirmed {
                return Err(err(
                    "Confirm the hosts this schedule will send input to before enabling it",
                ));
            }
            if s.confirmed_at.is_none() {
                s.confirmed_at = Some(stamp.clone());
            }
            if !s.enabled {
                s.enabled = true;
                s.enabled_at = Some(stamp.clone());
            }
        } else {
            s.enabled = false;
        }
        s.updated_at = stamp;
        let next = if s.enabled {
            next_run_after(&s.rule, now, anchor_of(s, now), tz)
        } else {
            None
        };
        inner.runtime.entry(id.to_string()).or_default().next_due = next;
        self.persist(&inner.store)?;
        Ok(Self::view(inner, &inner.store.schedules[idx], now, tz))
    }

    /// Set the global pause switch. Resuming re-times every schedule from
    /// `now`, so runs that fell due while paused are not replayed.
    pub fn set_paused<Tz: TimeZone>(
        &self,
        paused: bool,
        now: DateTime<Utc>,
        tz: &Tz,
    ) -> Result<SchedulerState, TerminalError> {
        let mut inner = self.lock()?;
        let inner = &mut *inner;
        let was = inner.store.paused;
        inner.store.paused = paused;
        if was && !paused {
            for s in &inner.store.schedules {
                let next = if s.enabled {
                    next_run_after(&s.rule, now, anchor_of(s, now), tz)
                } else {
                    None
                };
                inner.runtime.entry(s.id.clone()).or_default().next_due = next;
            }
        }
        self.persist(&inner.store)?;
        Ok(Self::state_of(inner, now, tz))
    }

    /// Record one window's report for the run `token`. Returns `true` when it
    /// settled a run (so the caller can emit `schedules-changed`); an unknown
    /// or already-settled token is ignored.
    pub fn report(
        &self,
        token: &str,
        window: &str,
        report: WindowRunReport,
        now: DateTime<Utc>,
    ) -> Result<bool, TerminalError> {
        let mut inner = self.lock()?;
        let inner = &mut *inner;
        let Some((id, rt)) = inner
            .runtime
            .iter_mut()
            .find(|(_, rt)| rt.active.as_ref().is_some_and(|a| a.token == token))
        else {
            tracing::debug!("schedule report for unknown run {token} ignored");
            return Ok(false);
        };
        let id = id.clone();
        let Some(active) = rt.active.as_mut() else {
            return Ok(false);
        };
        if !active.pending.remove(window) {
            tracing::debug!("schedule report from unexpected window {window} ignored");
            return Ok(false);
        }
        active.reports.push(report);
        if !active.pending.is_empty() {
            return Ok(false);
        }
        let result = aggregate(&active.reports, active.catch_up, active.fired_at, now);
        rt.active = None;
        tracing::info!(
            "scheduled run of {id} settled: {:?} ({})",
            result.outcome,
            result.message.as_deref().unwrap_or("")
        );
        if let Some(s) = inner.store.schedules.iter_mut().find(|s| s.id == id) {
            super::history::record(s, result);
        }
        if let Err(e) = self.persist(&inner.store) {
            tracing::warn!("failed to persist schedule result: {e}");
        }
        Ok(true)
    }

    /// Mark `window` as listening for fired runs (its frontend booted or
    /// reloaded). Idempotent.
    pub fn mark_window_ready(&self, window: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ready.insert(window.to_string());
        }
    }

    /// A window acknowledges it received the fired run `token` (it will
    /// report). Unknown tokens are ignored.
    pub fn ack(&self, token: &str, window: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        for rt in inner.runtime.values_mut() {
            if let Some(active) = rt.active.as_mut().filter(|a| a.token == token) {
                active.acked.insert(window.to_string());
            }
        }
    }

    /// Advance the scheduler to `now`. `live_windows` are the labels of the
    /// open app windows; a run goes to those that also registered as ready.
    /// Pure apart from persistence.
    pub fn tick<Tz: TimeZone>(
        &self,
        now: DateTime<Utc>,
        tz: &Tz,
        live_windows: &[String],
    ) -> TickResult {
        let Ok(mut guard) = self.inner.lock() else {
            return TickResult::default();
        };
        let inner = &mut *guard;
        let live: BTreeSet<String> = live_windows.iter().cloned().collect();
        // A closed window must re-register if a window with its label reopens.
        inner.ready.retain(|w| live.contains(w));
        let ctx = TickContext {
            now,
            paused: inner.store.paused,
            audience: inner.ready.clone(),
        };
        let mut result = TickResult::default();
        let mut dirty = false;
        for s in inner.store.schedules.iter_mut() {
            let rt = inner.runtime.entry(s.id.clone()).or_default();
            let step = tick::step(s, rt, &ctx, tz);
            result.changed |= step.changed;
            dirty |= step.dirty;
            result.fires.extend(step.fire);
        }
        // Only persist when a stored field changed (a fire / a result); a pure
        // re-computation of the next due time needs no write.
        if dirty {
            if let Err(e) = self.persist(&inner.store) {
                tracing::warn!("failed to persist schedules after tick: {e}");
            }
        }
        result
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manager_history_tests.rs"]
mod history_tests;
