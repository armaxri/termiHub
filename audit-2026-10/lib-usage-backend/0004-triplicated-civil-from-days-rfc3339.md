---
id: LIBBE2-004
title: "Three hand-copied civil_from_days RFC 3339 formatters in core beside chrono"
angle: lib-usage-backend
severity: low
category: maintainability
is_workaround: false
subsystem: "core (files/utils, plugin/signature, diagnostics/crash_report)"
evidence:
  - core/src/files/utils.rs:2
  - core/src/files/utils.rs:25
  - core/src/plugin/signature.rs:547
  - core/src/plugin/signature.rs:566
  - core/src/diagnostics/crash_report.rs:292
  - core/src/diagnostics/crash_report.rs:309
  - core/src/embedded_servers/activity.rs:361
  - core/Cargo.toml:173
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Core contains three separate copies of Howard Hinnant's days-to-civil algorithm, each with its own RFC 3339 formatter. files/utils.rs::chrono_from_epoch and days_to_ymd use u64 arithmetic. plugin/signature.rs::now_rfc3339, format_epoch_utc and civil_from_days use i64 with a manual negative-era branch. diagnostics/crash_report.rs::format_utc and civil_from_days use div_euclid. Meanwhile core/src/embedded_servers/activity.rs:361 in the same crate uses chrono::Utc::now().to_rfc3339_opts, and src-tauri and agent both depend on chrono non-optionally. The signature.rs comment says the hand-roll exists 'without pulling in a date/time crate', but chrono is already compiled into every shipping binary.

## Why it matters

Three slightly different copies of calendar math will drift, and they already differ in signed vs unsigned handling and era computation. Timestamps that go into signed plugin metadata (signedAt, addedAt) and crash reports should come from one tested implementation. The no-dependency rationale does not hold, because chrono is already in core (optional) and in both binaries.

## Evidence

- `core/src/files/utils.rs:2`
- `core/src/files/utils.rs:25`
- `core/src/plugin/signature.rs:547`
- `core/src/plugin/signature.rs:566`
- `core/src/diagnostics/crash_report.rs:292`
- `core/src/diagnostics/crash_report.rs:309`
- `core/src/embedded_servers/activity.rs:361`
- `core/Cargo.toml:173`

## Recommendation

Make chrono a non-optional core dependency, since every shipping build already links it, and replace all three with `chrono::DateTime::<Utc>::from(system_time).to_rfc3339_opts(SecondsFormat::Secs, true)`. If core must stay chrono-free by default, at least merge the three into one `core::util::time::format_rfc3339_utc(SystemTime)` with a single tested civil_from_days, and route chrono_from_epoch, now_rfc3339 and format_utc through it.

## Verification

Confirmed. There are three separate civil_from_days copies: files/utils.rs:25 (u64), plugin/signature.rs:566 (i64 with a manual era branch), and crash_report.rs:309 (div_euclid). activity.rs:361 in the same crate uses chrono. chrono is optional in core (behind embedded-servers, Cargo.toml:173/344) but non-optional in agent and src-tauri. The signature.rs comment justifies the hand-roll by not pulling in a date crate, which only holds for core-without-features builds. All three copies look correct for post-epoch times, so this is duplication and hygiene, not a bug.
