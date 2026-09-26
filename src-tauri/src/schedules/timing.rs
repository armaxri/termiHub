//! Pure next-run computation and rule validation for schedules (PROD-043).
//!
//! Everything here is a pure function of the rule, an instant and a
//! [`TimeZone`], so it is exhaustively testable against synthetic DST zones
//! (production passes [`chrono::Local`]).
//!
//! # DST rules
//!
//! * **Interval** schedules count absolute minutes from their anchor, so a DST
//!   switch never shortens or lengthens the gap between two runs.
//! * **Daily / weekly** schedules fire at a local wall-clock time:
//!   * a time that does **not exist** that day (the spring-forward gap, e.g.
//!     02:30 when clocks jump 02:00 → 03:00) fires at the first valid minute
//!     after the gap (03:00) — the run is moved, never dropped;
//!   * a time that exists **twice** (the fall-back overlap, e.g. 02:30 when
//!     clocks go 03:00 → 02:00) fires once, at the earlier occurrence.

use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};

use super::config::{ScheduleRule, ScheduleWeekday};

/// The shortest allowed interval, in minutes.
pub const MIN_INTERVAL_MINUTES: u32 = 1;

/// The longest allowed interval (one week), in minutes.
pub const MAX_INTERVAL_MINUTES: u32 = 7 * 24 * 60;

/// How many minutes past a spring-forward gap we search for the first valid
/// local minute. Real-world gaps are at most two hours.
const GAP_SEARCH_MINUTES: i64 = 180;

/// How many days ahead a daily/weekly search looks (a weekly rule always
/// matches within 7 days; the margin covers a gap-shifted candidate).
const DAY_SEARCH_LIMIT: u32 = 15;

/// Parse a `HH:MM` 24h local time.
pub fn parse_time(time: &str) -> Result<NaiveTime, String> {
    let trimmed = time.trim();
    let valid_shape = trimmed.len() == 5 && trimmed.as_bytes().get(2) == Some(&b':');
    if !valid_shape {
        return Err(format!("\"{time}\" is not a time in HH:MM format"));
    }
    NaiveTime::parse_from_str(trimmed, "%H:%M")
        .map_err(|_| format!("\"{time}\" is not a valid time (00:00–23:59)"))
}

/// Validate a rule, returning a user-facing error.
pub fn validate_rule(rule: &ScheduleRule) -> Result<(), String> {
    match rule {
        ScheduleRule::Interval { every_minutes } => {
            if *every_minutes < MIN_INTERVAL_MINUTES {
                return Err(format!(
                    "The interval must be at least {MIN_INTERVAL_MINUTES} minute"
                ));
            }
            if *every_minutes > MAX_INTERVAL_MINUTES {
                return Err(format!(
                    "The interval must be at most {MAX_INTERVAL_MINUTES} minutes (one week)"
                ));
            }
            Ok(())
        }
        ScheduleRule::Daily { time } => parse_time(time).map(|_| ()),
        ScheduleRule::Weekly { days, time } => {
            if days.is_empty() {
                return Err("Pick at least one weekday".to_string());
            }
            parse_time(time).map(|_| ())
        }
    }
}

/// Map a local wall-clock time to an instant, applying the DST rules in the
/// module docs. `None` only for a pathological zone with no valid minute in
/// the search window.
pub fn resolve_local<Tz: TimeZone>(tz: &Tz, naive: NaiveDateTime) -> Option<DateTime<Utc>> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(a, b) => {
            let (a, b) = (a.with_timezone(&Utc), b.with_timezone(&Utc));
            Some(a.min(b))
        }
        LocalResult::None => (1..=GAP_SEARCH_MINUTES).find_map(|m| {
            match tz.from_local_datetime(&(naive + Duration::minutes(m))) {
                LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
                LocalResult::Ambiguous(a, b) => {
                    Some(a.with_timezone(&Utc).min(b.with_timezone(&Utc)))
                }
                LocalResult::None => None,
            }
        }),
    }
}

/// The first local-time slot strictly after `after` on a day accepted by
/// `day_ok`.
fn next_local_slot<Tz: TimeZone>(
    tz: &Tz,
    after: DateTime<Utc>,
    time: NaiveTime,
    day_ok: impl Fn(NaiveDate) -> bool,
) -> Option<DateTime<Utc>> {
    // Start one day early: the previous local day's slot can still lie after
    // `after` when a gap shifted it forward.
    let mut date = after.with_timezone(tz).naive_local().date().pred_opt()?;
    for _ in 0..DAY_SEARCH_LIMIT {
        if day_ok(date) {
            if let Some(candidate) = resolve_local(tz, date.and_time(time)) {
                if candidate > after {
                    return Some(candidate);
                }
            }
        }
        date = date.succ_opt()?;
    }
    None
}

/// The next instant strictly after `after` at which `rule` fires.
///
/// `anchor` is the interval origin (the time the schedule was enabled): an
/// interval rule fires at `anchor + k·N` for whole `k`. Daily/weekly rules
/// ignore it. Returns `None` for an invalid rule.
pub fn next_run_after<Tz: TimeZone>(
    rule: &ScheduleRule,
    after: DateTime<Utc>,
    anchor: DateTime<Utc>,
    tz: &Tz,
) -> Option<DateTime<Utc>> {
    validate_rule(rule).ok()?;
    match rule {
        ScheduleRule::Interval { every_minutes } => {
            let step = i64::from(*every_minutes) * 60;
            let elapsed = (after - anchor).num_seconds();
            // Whole steps already elapsed (floored, also for `after < anchor`),
            // then one more so the result is strictly after `after`.
            let k = elapsed.div_euclid(step) + 1;
            Some(anchor + Duration::seconds(k * step))
        }
        ScheduleRule::Daily { time } => {
            let time = parse_time(time).ok()?;
            next_local_slot(tz, after, time, |_| true)
        }
        ScheduleRule::Weekly { days, time } => {
            let time = parse_time(time).ok()?;
            let wanted: Vec<chrono::Weekday> = days
                .iter()
                .copied()
                .map(ScheduleWeekday::to_chrono)
                .collect();
            next_local_slot(tz, after, time, |d| {
                use chrono::Datelike;
                wanted.contains(&d.weekday())
            })
        }
    }
}

#[cfg(test)]
#[path = "timing_tests.rs"]
pub(crate) mod tests;
