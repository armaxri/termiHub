---
id: OBS-010
title: No crash reporting or telemetry (privacy posture) — consider minimal opt-in health signal
angle: observability
severity: info
category: missing-feature
is_workaround: false
subsystem: whole app
evidence:
  - Cargo.toml
  - package.json
status: open
---

## What
The app ships with **no** telemetry, analytics, or crash-reporting of any kind. A search of
all Cargo manifests and `package.json` finds no `sentry`, `breakpad`/`crashpad`,
`minidump`, `opentelemetry`, `posthog`, or analytics dependency. Combined with OBS-002
(no panic hook, no local crash capture), this means crashes are neither reported nor
recorded anywhere.

## Why it matters
The zero-telemetry posture is a legitimate and arguably correct default for a
security-sensitive terminal tool — users connecting to production infrastructure will not
tolerate silent phone-home, and the absence is a *feature*. This finding is filed as **info**
to make that a deliberate, recorded decision rather than an omission, and to pair it with a
recommendation, not to push for adding tracking.

For a safety-critical tool, the gap worth considering is not usage analytics but **crash
diagnosability**: even fully offline, the app could capture panics/crashes to a local file
the user *chooses* to attach to a bug report (this is OBS-002's fix and needs no network). If
any network reporting is ever added, it must be strictly **opt-in**, off by default, with a
clear disclosure of exactly what is sent, and never include session content, hostnames, or
credentials.

## Evidence
No crash/telemetry crates in `Cargo.toml`, `src-tauri/Cargo.toml`, `core/Cargo.toml`,
`agent/Cargo.toml`, or `package.json`.

## Recommendation
Keep the no-network-telemetry default. Prioritize **local** crash capture (OBS-002) so
diagnosability does not depend on a network channel. Only if maintainers later want fleet
health signal, add a strictly opt-in, disclosed, content-free channel — decided by the
maintainer, not defaulted on.
