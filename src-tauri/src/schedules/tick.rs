//! One schedule's tick decision (PROD-043): settle its in-flight run, then —
//! when it is due — pause-skip, missed-skip, overlap-skip, wait for a window,
//! or fire. See the execution rules in [`super::manager`].

use std::collections::BTreeSet;

use chrono::{DateTime, TimeZone, Utc};

use super::config::{MissedRunPolicy, Schedule, ScheduleRunOutcome};
use super::history;
use super::manager::{
    anchor_of, initial_due, ActiveRun, Runtime, ACK_TIMEOUT, MISSED_GRACE, STALE_RUN_TIMEOUT,
};
use super::timing::next_run_after;
use super::wire::{aggregate, skipped, ScheduleFire};

/// What every schedule of one tick shares.
pub(super) struct TickContext {
    pub(super) now: DateTime<Utc>,
    pub(super) paused: bool,
    /// Open windows whose frontend listens for fired runs.
    pub(super) audience: BTreeSet<String>,
}

/// The outcome of one schedule's tick.
#[derive(Default)]
pub(super) struct Step {
    /// The run to emit, if it fired.
    pub(super) fire: Option<ScheduleFire>,
    /// Its visible state changed (next run moved, result recorded).
    pub(super) changed: bool,
    /// A stored field changed (persist).
    pub(super) dirty: bool,
}

/// Close an in-flight run whose audience is gone (closed, never acked) or
/// that went stale. Returns whether it settled.
fn settle_active(s: &mut Schedule, rt: &mut Runtime, ctx: &TickContext) -> bool {
    let Some(active) = rt.active.as_mut() else {
        return false;
    };
    let now = ctx.now;
    active.pending.retain(|w| ctx.audience.contains(w));
    if now - active.fired_at > ACK_TIMEOUT {
        let acked = active.acked.clone();
        active.pending.retain(|w| acked.contains(w));
    }
    let stale = now - active.fired_at > STALE_RUN_TIMEOUT;
    if !active.pending.is_empty() && !stale {
        return false;
    }
    let settled = if stale {
        let mut r = aggregate(&active.reports, active.catch_up, active.fired_at, now);
        r.outcome = ScheduleRunOutcome::Failed;
        r.message = Some("No completion was reported within 6 hours".to_string());
        r
    } else {
        aggregate(&active.reports, active.catch_up, active.fired_at, now)
    };
    tracing::info!("scheduled run of {} closed: {:?}", s.id, settled.outcome);
    history::record(s, settled);
    rt.active = None;
    true
}

/// Record a skipped due run.
fn skip(s: &mut Schedule, now: DateTime<Utc>, msg: String, catch_up: bool) -> Step {
    tracing::info!("schedule {}: {msg}", s.id);
    history::record(s, skipped(now, msg, catch_up));
    Step {
        fire: None,
        changed: true,
        dirty: true,
    }
}

/// Advance one schedule to `ctx.now`.
pub(super) fn step<Tz: TimeZone>(
    s: &mut Schedule,
    rt: &mut Runtime,
    ctx: &TickContext,
    tz: &Tz,
) -> Step {
    let now = ctx.now;
    let settled = settle_active(s, rt, ctx);
    let base = Step {
        fire: None,
        changed: settled,
        dirty: settled,
    };
    if !s.enabled {
        rt.next_due = None;
        return base;
    }
    let Some(due) = rt.next_due.or_else(|| initial_due(s, now, tz)) else {
        return base;
    };
    rt.next_due = Some(due);
    if now < due {
        return base;
    }
    // Nobody can run it yet (the app is still booting its window): hold the
    // slot. If this lasts, the run is simply late and the missed rule applies.
    if ctx.audience.is_empty() && !ctx.paused {
        return base;
    }
    let missed = now - due > MISSED_GRACE;
    rt.next_due = next_run_after(&s.rule, now, anchor_of(s, now), tz);
    if ctx.paused {
        tracing::info!("schedule {} due but scheduling is paused; skipped", s.id);
        return Step {
            changed: true,
            ..base
        };
    }
    if missed && s.missed_runs == MissedRunPolicy::Skip {
        let when = due.with_timezone(tz).naive_local().format("%Y-%m-%d %H:%M");
        let msg = format!(
            "Missed the run due at {when} (termiHub was closed or the computer was asleep)"
        );
        return skip(s, now, msg, false);
    }
    if rt.active.is_some() {
        let msg = "Skipped: the previous run was still in progress".to_string();
        return skip(s, now, msg, missed);
    }
    let token = uuid::Uuid::new_v4().to_string();
    tracing::info!(
        "schedule {} fires{} (run {token})",
        s.id,
        if missed { " as a catch-up" } else { "" }
    );
    rt.active = Some(ActiveRun {
        token: token.clone(),
        fired_at: now,
        catch_up: missed,
        pending: ctx.audience.clone(),
        acked: BTreeSet::new(),
        reports: Vec::new(),
    });
    s.last_run_at = Some(now.to_rfc3339());
    Step {
        fire: Some(ScheduleFire {
            token,
            schedule_id: s.id.clone(),
            schedule_name: s.name.clone(),
            action: s.action.clone(),
            targets: s.targets.clone(),
            catch_up: missed,
        }),
        changed: true,
        dirty: true,
    }
}
