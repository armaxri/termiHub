//! The single RFC 3339 UTC timestamp formatter for core (LIBBE2-004, #4363).
//!
//! Core used to carry three hand-copied `civil_from_days` date algorithms, one
//! each for file-listing mtimes, plugin signature/trust timestamps and crash
//! reports. They all now format through [`chrono`], which every shipping binary
//! already links. The output shape is unchanged: whole seconds with a `Z`
//! suffix (`YYYY-MM-DDTHH:MM:SSZ`).

use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};

/// Format `t` as an RFC 3339 UTC timestamp with whole-second precision and a
/// `Z` suffix, e.g. `2026-07-26T12:00:00Z`. Sub-second parts are truncated.
#[must_use]
pub fn format_rfc3339_utc(t: SystemTime) -> String {
    DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Format Unix seconds as an RFC 3339 UTC timestamp, like
/// [`format_rfc3339_utc`].
///
/// Returns an empty string when `secs` lies beyond the representable date range
/// (year 262143) — no real file or clock produces such a value.
#[must_use]
pub fn format_epoch_secs_utc(secs: u64) -> String {
    i64::try_from(secs)
        .ok()
        .and_then(|s| DateTime::<Utc>::from_timestamp(s, 0))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// The current time as an RFC 3339 UTC timestamp (see [`format_rfc3339_utc`]).
#[must_use]
pub fn now_rfc3339_utc() -> String {
    format_rfc3339_utc(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    /// The exact outputs the three removed hand-rolled formatters produced.
    #[test]
    fn matches_previous_hand_rolled_output() {
        let cases = [
            (0, "1970-01-01T00:00:00Z"),
            (1_705_321_845, "2024-01-15T12:30:45Z"),
            (1_785_067_200, "2026-07-26T12:00:00Z"),
            (1_790_424_062, "2026-09-26T12:01:02Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (4_107_542_399, "2100-02-28T23:59:59Z"),
            (4_107_542_400, "2100-03-01T00:00:00Z"),
        ];
        for (secs, expected) in cases {
            assert_eq!(format_epoch_secs_utc(secs), expected, "secs={secs}");
            assert_eq!(format_rfc3339_utc(at(secs)), expected, "secs={secs}");
        }
    }

    #[test]
    fn sub_second_part_is_truncated() {
        let t = at(1_705_321_845) + Duration::from_millis(999);
        assert_eq!(format_rfc3339_utc(t), "2024-01-15T12:30:45Z");
    }

    #[test]
    fn out_of_range_epoch_seconds_format_empty() {
        assert_eq!(format_epoch_secs_utc(u64::MAX), "");
    }

    #[test]
    fn now_has_rfc3339_shape() {
        let now = now_rfc3339_utc();
        assert_eq!(now.len(), 20, "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(&now[10..11], "T", "{now}");
    }
}
