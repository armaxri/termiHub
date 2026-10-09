---
id: I18N2-004
title: "Date/time rendering sites bypass resolveUiLocale and mix English words with locale-formatted dates"
angle: i18n
severity: low
category: formatting
is_workaround: false
subsystem: "src/components (Schedules, EmbeddedServerSidebar, Settings/BackupRestore)"
evidence:
  - src/components/Schedules/scheduleForm.ts:228
  - src/components/Schedules/scheduleForm.ts:232
  - src/components/EmbeddedServerSidebar/EmbeddedServerActivityPanel.tsx:73
  - src/components/Settings/BackupRestoreDialog.tsx:234
status: fixed
resolution: "#4374 — schedule/activity/backup dates go through UI-locale formatters (formatClockTime/formatShortDate/formatRelativeDay); lint bans bare toLocale*String()"
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: I18N-015
---

## What

The I18N-015 fix made display formatters use `resolveUiLocale()`. Three newer
sites call `toLocaleDateString(undefined, …)`, `toLocaleTimeString()` and
`toLocaleString()` with the engine default locale. `formatNextRun` also joins
hardcoded English "today"/"tomorrow" with a date in the default locale.

## Why it matters

With a non-English OS locale, the schedule list mixes languages ("today 09:00"
next to "Mi., 3. Juni 09:00"), and these timestamps can disagree in format with
every other timestamp in the app, which uses the validated UI locale. The engine
default is not the crash path, so the impact is consistency only.

## Evidence

- `src/components/Schedules/scheduleForm.ts:228`
- `src/components/Schedules/scheduleForm.ts:232`
- `src/components/EmbeddedServerSidebar/EmbeddedServerActivityPanel.tsx:73`
- `src/components/Settings/BackupRestoreDialog.tsx:234`

## Recommendation

Pass `resolveUiLocale()` at all three sites, or better, route them through
shared helpers in `src/utils/formatters.ts`. For `formatNextRun`, either format
the whole string in one locale (e.g. `Intl.RelativeTimeFormat`/`DateTimeFormat`
with resolveUiLocale) or keep the weekday/month in en-US to match the English-
only beta copy.

## Verification

Confirmed. scheduleForm.ts:228-232 returns hardcoded English 'today'/'tomorrow'
and otherwise uses toLocaleDateString(undefined, ...).
EmbeddedServerActivityPanel.tsx:73 uses toLocaleTimeString() and
BackupRestoreDialog.tsx:234 uses toLocaleString(), both with the engine default
locale instead of resolveUiLocale. The docstring expects 'Wed 3 Jun', which
shows mixed-language output is unintended. The impact is only that formats
disagree with the rest of the app, so low is right.
