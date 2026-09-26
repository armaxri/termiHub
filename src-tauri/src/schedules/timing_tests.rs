//! Next-run computation tests, including DST transitions, against synthetic
//! zones that model real 2026 rules exactly (no tz database in the tree).

use super::*;
use chrono::{FixedOffset, NaiveDate, Offset};

/// A synthetic zone with one DST period `[start, end)` (UTC instants).
pub(crate) trait DstRule: Copy + std::fmt::Debug {
    const STD_SECS: i32;
    const DST_SECS: i32;
    /// DST start as a UTC naive datetime.
    fn start() -> NaiveDateTime;
    /// DST end as a UTC naive datetime.
    fn end() -> NaiveDateTime;
}

fn utc_naive(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(y, m, d)
        .unwrap()
        .and_hms_opt(h, min, 0)
        .unwrap()
}

/// Europe/Berlin 2026: CET +1, CEST +2; 29 Mar 01:00Z → 25 Oct 01:00Z.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Berlin;
impl DstRule for Berlin {
    const STD_SECS: i32 = 3600;
    const DST_SECS: i32 = 7200;
    fn start() -> NaiveDateTime {
        utc_naive(2026, 3, 29, 1, 0)
    }
    fn end() -> NaiveDateTime {
        utc_naive(2026, 10, 25, 1, 0)
    }
}

/// America/New_York 2026: EST −5, EDT −4; 8 Mar 07:00Z → 1 Nov 06:00Z.
#[derive(Debug, Clone, Copy)]
pub(crate) struct NewYork;
impl DstRule for NewYork {
    const STD_SECS: i32 = -5 * 3600;
    const DST_SECS: i32 = -4 * 3600;
    fn start() -> NaiveDateTime {
        utc_naive(2026, 3, 8, 7, 0)
    }
    fn end() -> NaiveDateTime {
        utc_naive(2026, 11, 1, 6, 0)
    }
}

/// A [`TimeZone`] driven by a [`DstRule`].
#[derive(Debug, Clone, Copy)]
pub(crate) struct DstTz<R: DstRule>(pub R);

impl<R: DstRule> DstTz<R> {
    fn offset_at_utc(utc: &NaiveDateTime) -> FixedOffset {
        let secs = if *utc >= R::start() && *utc < R::end() {
            R::DST_SECS
        } else {
            R::STD_SECS
        };
        FixedOffset::east_opt(secs).unwrap()
    }
}

/// Resolve for a zero-sized rule: [`TimeZone::from_offset`] must rebuild the
/// zone from an offset, which a ZST can always do.
pub(crate) trait ZeroSized {
    fn instance() -> Self;
}
impl ZeroSized for Berlin {
    fn instance() -> Self {
        Berlin
    }
}
impl ZeroSized for NewYork {
    fn instance() -> Self {
        NewYork
    }
}

impl<R: DstRule + ZeroSized> TimeZone for DstTz<R> {
    type Offset = FixedOffset;

    fn from_offset(_offset: &FixedOffset) -> Self {
        DstTz(R::instance())
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<FixedOffset> {
        self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<FixedOffset> {
        let mut valid: Vec<(NaiveDateTime, FixedOffset)> = Vec::new();
        for secs in [R::DST_SECS, R::STD_SECS] {
            let off = FixedOffset::east_opt(secs).unwrap();
            let utc = *local - Duration::seconds(i64::from(secs));
            if Self::offset_at_utc(&utc).fix() == off {
                valid.push((utc, off));
            }
        }
        valid.sort_by_key(|(utc, _)| *utc);
        valid.dedup_by_key(|(utc, _)| *utc);
        match valid.as_slice() {
            [] => LocalResult::None,
            [(_, o)] => LocalResult::Single(*o),
            [(_, a), (_, b), ..] => LocalResult::Ambiguous(*a, *b),
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
        Self::offset_at_utc(&utc.and_hms_opt(0, 0, 0).unwrap())
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
        Self::offset_at_utc(utc)
    }
}

const BERLIN: DstTz<Berlin> = DstTz(Berlin);
const NEW_YORK: DstTz<NewYork> = DstTz(NewYork);

fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
    Utc.from_utc_datetime(&utc_naive(y, m, d, h, min))
}

fn daily(time: &str) -> ScheduleRule {
    ScheduleRule::Daily {
        time: time.to_string(),
    }
}

fn weekly(days: &[ScheduleWeekday], time: &str) -> ScheduleRule {
    ScheduleRule::Weekly {
        days: days.to_vec(),
        time: time.to_string(),
    }
}

fn interval(m: u32) -> ScheduleRule {
    ScheduleRule::Interval { every_minutes: m }
}

fn next(rule: &ScheduleRule, after: DateTime<Utc>) -> DateTime<Utc> {
    next_run_after(rule, after, after, &BERLIN).unwrap()
}

// ── validation ──────────────────────────────────────────────────────────

#[test]
fn parse_time_accepts_24h_hh_mm_only() {
    assert!(parse_time("00:00").is_ok());
    assert!(parse_time("23:59").is_ok());
    assert!(parse_time(" 09:05 ").is_ok());
    for bad in ["24:00", "9:05", "09:60", "0905", "09:05:00", "", "ab:cd"] {
        assert!(parse_time(bad).is_err(), "{bad} should be rejected");
    }
}

#[test]
fn validate_rule_enforces_interval_bounds_and_days() {
    assert!(validate_rule(&interval(0)).is_err());
    assert!(validate_rule(&interval(1)).is_ok());
    assert!(validate_rule(&interval(MAX_INTERVAL_MINUTES)).is_ok());
    assert!(validate_rule(&interval(MAX_INTERVAL_MINUTES + 1)).is_err());
    assert!(validate_rule(&weekly(&[], "09:00")).is_err());
    assert!(validate_rule(&weekly(&[ScheduleWeekday::Mon], "09:00")).is_ok());
    assert!(validate_rule(&daily("25:00")).is_err());
}

#[test]
fn invalid_rule_has_no_next_run() {
    assert!(next_run_after(&interval(0), utc(2026, 1, 1, 0, 0), utc(2026, 1, 1, 0, 0), &BERLIN)
        .is_none());
    assert!(next_run_after(&daily("7am"), utc(2026, 1, 1, 0, 0), utc(2026, 1, 1, 0, 0), &BERLIN)
        .is_none());
}

// ── interval ────────────────────────────────────────────────────────────

#[test]
fn interval_fires_every_n_minutes_from_the_anchor() {
    let anchor = utc(2026, 6, 1, 10, 0);
    let rule = interval(15);
    assert_eq!(
        next_run_after(&rule, anchor, anchor, &BERLIN),
        Some(utc(2026, 6, 1, 10, 15))
    );
    // Strictly after: exactly on a slot yields the following one.
    assert_eq!(
        next_run_after(&rule, utc(2026, 6, 1, 10, 15), anchor, &BERLIN),
        Some(utc(2026, 6, 1, 10, 30))
    );
    // Mid-slot keeps the anchor's alignment.
    assert_eq!(
        next_run_after(&rule, utc(2026, 6, 1, 10, 37), anchor, &BERLIN),
        Some(utc(2026, 6, 1, 10, 45))
    );
    // Long after (app was closed): aligned, not drifting.
    assert_eq!(
        next_run_after(&rule, utc(2026, 6, 3, 7, 1), anchor, &BERLIN),
        Some(utc(2026, 6, 3, 7, 15))
    );
}

#[test]
fn interval_before_anchor_returns_the_first_slot_after() {
    let anchor = utc(2026, 6, 1, 10, 0);
    assert_eq!(
        next_run_after(&interval(10), utc(2026, 6, 1, 9, 55), anchor, &BERLIN),
        Some(anchor)
    );
}

#[test]
fn interval_is_absolute_across_dst_switches() {
    // Berlin spring-forward at 01:00Z; a 60-minute interval still fires every
    // 60 real minutes (local clock shows 01:00 → 03:00).
    let anchor = utc(2026, 3, 29, 0, 0);
    let rule = interval(60);
    assert_eq!(
        next_run_after(&rule, anchor, anchor, &BERLIN),
        Some(utc(2026, 3, 29, 1, 0))
    );
    assert_eq!(
        next_run_after(&rule, utc(2026, 3, 29, 1, 0), anchor, &BERLIN),
        Some(utc(2026, 3, 29, 2, 0))
    );
    // Fall-back.
    let anchor = utc(2026, 10, 25, 0, 30);
    assert_eq!(
        next_run_after(&rule, utc(2026, 10, 25, 1, 0), anchor, &BERLIN),
        Some(utc(2026, 10, 25, 1, 30))
    );
}

#[test]
fn one_minute_interval_is_supported() {
    let a = utc(2026, 6, 1, 10, 0);
    assert_eq!(
        next_run_after(&interval(1), a, a, &BERLIN),
        Some(utc(2026, 6, 1, 10, 1))
    );
}

// ── daily ───────────────────────────────────────────────────────────────

#[test]
fn daily_fires_later_today_or_tomorrow() {
    // 08:00 Berlin summer = 06:00Z.
    let rule = daily("09:30");
    assert_eq!(next(&rule, utc(2026, 6, 1, 6, 0)), utc(2026, 6, 1, 7, 30));
    // Exactly at the slot → tomorrow.
    assert_eq!(next(&rule, utc(2026, 6, 1, 7, 30)), utc(2026, 6, 2, 7, 30));
    // After the slot → tomorrow.
    assert_eq!(next(&rule, utc(2026, 6, 1, 20, 0)), utc(2026, 6, 2, 7, 30));
}

#[test]
fn daily_uses_local_date_not_utc_date() {
    // 23:30Z on 1 June is already 01:30 local on 2 June in Berlin: a 00:15
    // daily run is due 2 June 22:15Z → no wait, 00:15 local on 3 June.
    let rule = daily("00:15");
    assert_eq!(next(&rule, utc(2026, 6, 1, 23, 30)), utc(2026, 6, 2, 22, 15));
    // New York: 03:00Z on 2 June is 23:00 local on 1 June; 23:30 local is 03:30Z.
    let rule = daily("23:30");
    assert_eq!(
        next_run_after(&rule, utc(2026, 6, 2, 3, 0), utc(2026, 6, 2, 3, 0), &NEW_YORK),
        Some(utc(2026, 6, 2, 3, 30))
    );
}

#[test]
fn daily_keeps_local_time_across_spring_forward() {
    // 09:00 local: CET (08:00Z) before, CEST (07:00Z) after the switch.
    let rule = daily("09:00");
    assert_eq!(next(&rule, utc(2026, 3, 27, 9, 0)), utc(2026, 3, 28, 8, 0));
    assert_eq!(next(&rule, utc(2026, 3, 28, 8, 0)), utc(2026, 3, 29, 7, 0));
    assert_eq!(next(&rule, utc(2026, 3, 29, 7, 0)), utc(2026, 3, 30, 7, 0));
}

#[test]
fn daily_keeps_local_time_across_fall_back() {
    let rule = daily("09:00");
    assert_eq!(next(&rule, utc(2026, 10, 24, 7, 0)), utc(2026, 10, 25, 8, 0));
    assert_eq!(next(&rule, utc(2026, 10, 25, 8, 0)), utc(2026, 10, 26, 8, 0));
}

#[test]
fn nonexistent_local_time_fires_at_first_valid_minute_after_the_gap() {
    // Berlin 29 Mar 2026: 02:00 → 03:00. A 02:30 run fires at 03:00 CEST
    // (01:00Z), not skipped.
    let rule = daily("02:30");
    assert_eq!(next(&rule, utc(2026, 3, 28, 12, 0)), utc(2026, 3, 29, 1, 0));
    // And returns to 02:30 CEST the day after (00:30Z).
    assert_eq!(next(&rule, utc(2026, 3, 29, 1, 0)), utc(2026, 3, 30, 0, 30));
    // New York 8 Mar 2026: 02:00 → 03:00; 02:15 fires at 03:00 EDT (07:00Z).
    let rule = daily("02:15");
    assert_eq!(
        next_run_after(&rule, utc(2026, 3, 7, 12, 0), utc(2026, 3, 7, 12, 0), &NEW_YORK),
        Some(utc(2026, 3, 8, 7, 0))
    );
}

#[test]
fn gap_boundary_minutes_resolve_correctly() {
    // 01:59 exists (CET), 02:00 does not, 03:00 exists (CEST).
    assert_eq!(
        next(&daily("01:59"), utc(2026, 3, 28, 12, 0)),
        utc(2026, 3, 29, 0, 59)
    );
    assert_eq!(
        next(&daily("02:00"), utc(2026, 3, 28, 12, 0)),
        utc(2026, 3, 29, 1, 0)
    );
    assert_eq!(
        next(&daily("03:00"), utc(2026, 3, 28, 12, 0)),
        utc(2026, 3, 29, 1, 0)
    );
}

#[test]
fn ambiguous_local_time_fires_once_at_the_earlier_occurrence() {
    // Berlin 25 Oct 2026: 03:00 CEST → 02:00 CET, so 02:30 happens at 00:30Z
    // and again at 01:30Z. Fire at 00:30Z only.
    let rule = daily("02:30");
    assert_eq!(next(&rule, utc(2026, 10, 24, 12, 0)), utc(2026, 10, 25, 0, 30));
    // After the first occurrence the next run is the following day, not the
    // second occurrence an hour later.
    assert_eq!(next(&rule, utc(2026, 10, 25, 0, 30)), utc(2026, 10, 26, 1, 30));
}

#[test]
fn midnight_rule_rolls_over_correctly() {
    let rule = daily("00:00");
    // 22:59Z on 1 June = 00:59 on 2 June local → next is 3 June 00:00 = 2 June 22:00Z.
    assert_eq!(next(&rule, utc(2026, 6, 1, 22, 59)), utc(2026, 6, 2, 22, 0));
    // 21:59Z on 1 June = 23:59 local → next is 22:00Z the same UTC day.
    assert_eq!(next(&rule, utc(2026, 6, 1, 21, 59)), utc(2026, 6, 1, 22, 0));
}

#[test]
fn year_rollover() {
    assert_eq!(
        next(&daily("08:00"), utc(2026, 12, 31, 12, 0)),
        utc(2027, 1, 1, 7, 0)
    );
}

// ── weekly ──────────────────────────────────────────────────────────────

use ScheduleWeekday::{Fri, Mon, Sat, Sun, Wed};

#[test]
fn weekly_picks_the_next_matching_weekday() {
    // 1 June 2026 is a Monday.
    let rule = weekly(&[Wed, Fri], "09:00");
    assert_eq!(next(&rule, utc(2026, 6, 1, 12, 0)), utc(2026, 6, 3, 7, 0));
    assert_eq!(next(&rule, utc(2026, 6, 3, 7, 0)), utc(2026, 6, 5, 7, 0));
    // Friday after the slot → next Wednesday.
    assert_eq!(next(&rule, utc(2026, 6, 5, 8, 0)), utc(2026, 6, 10, 7, 0));
}

#[test]
fn weekly_single_day_same_day_before_and_after_slot() {
    let rule = weekly(&[Mon], "09:00");
    // Monday before 09:00 local → today.
    assert_eq!(next(&rule, utc(2026, 6, 1, 6, 0)), utc(2026, 6, 1, 7, 0));
    // Monday after → a week later.
    assert_eq!(next(&rule, utc(2026, 6, 1, 7, 0)), utc(2026, 6, 8, 7, 0));
}

#[test]
fn weekly_day_order_and_duplicates_do_not_matter() {
    let a = weekly(&[Sun, Mon, Sat], "18:00");
    let b = weekly(&[Mon, Sat, Sun, Mon], "18:00");
    let after = utc(2026, 6, 2, 0, 0); // Tuesday
    assert_eq!(next(&a, after), next(&b, after));
    assert_eq!(next(&a, after), utc(2026, 6, 6, 16, 0)); // Saturday 18:00 CEST
}

#[test]
fn weekly_weekday_follows_local_date_near_midnight() {
    // Sunday 22:30Z in New York is still Sunday 18:30 local; a Monday 00:10
    // run is 04:10Z on Monday — and with UTC weekday it would be wrong.
    let rule = weekly(&[Mon], "00:10");
    let after = utc(2026, 6, 7, 22, 30); // Sunday
    assert_eq!(
        next_run_after(&rule, after, after, &NEW_YORK),
        Some(utc(2026, 6, 8, 4, 10))
    );
    // Berlin: Sunday 22:30Z is already Monday 00:30 local → next Monday.
    assert_eq!(next(&rule, after), utc(2026, 6, 14, 22, 10));
}

#[test]
fn weekly_on_dst_switch_day() {
    // 29 Mar 2026 is a Sunday (spring-forward in Berlin).
    let rule = weekly(&[Sun], "02:30");
    assert_eq!(next(&rule, utc(2026, 3, 23, 0, 0)), utc(2026, 3, 29, 1, 0));
    assert_eq!(next(&rule, utc(2026, 3, 29, 1, 0)), utc(2026, 4, 5, 0, 30));
    // 25 Oct 2026 is a Sunday (fall-back).
    assert_eq!(next(&rule, utc(2026, 10, 19, 0, 0)), utc(2026, 10, 25, 0, 30));
    assert_eq!(next(&rule, utc(2026, 10, 25, 0, 30)), utc(2026, 11, 1, 1, 30));
}

#[test]
fn every_weekday_equals_daily() {
    let all = weekly(&[Mon, ScheduleWeekday::Tue, Wed, ScheduleWeekday::Thu, Fri, Sat, Sun], "07:45");
    let d = daily("07:45");
    let mut t = utc(2026, 3, 20, 0, 0);
    for _ in 0..30 {
        let a = next(&all, t);
        assert_eq!(a, next(&d, t));
        t = a;
    }
}

#[test]
fn the_real_local_zone_produces_a_future_run() {
    let now = Utc::now();
    let n = next_run_after(&daily("12:00"), now, now, &chrono::Local).unwrap();
    assert!(n > now);
    assert!(n - now <= Duration::hours(26));
}
