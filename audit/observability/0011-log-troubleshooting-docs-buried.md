---
id: OBS-011
title: Log locations and troubleshooting only in testing docs, not user-facing
angle: observability
severity: low
category: docs
is_workaround: false
subsystem: docs
evidence:
  - docs/testing.md:3267
status: open
---

## What
The one place that documents where the durable log lives and how to work with it is
`docs/testing.md` ("Application log file (#1570)", lines ~3257-3306) — an internal testing
document. There is **no user-facing troubleshooting/diagnostics page** (in `README.md` or a
`docs/troubleshooting.md`) telling a user where `termihub.log` is, how to read it, how to
raise verbosity, or how to attach logs to a bug report. A grep for log-path/troubleshooting
strings across `docs/*.md` and `README.md` returns only the testing doc and unrelated
test-harness references.

## Why it matters
Field support is only turnkey if the user can find the artifacts. When a supporter says
"send me your log," the user has no documented path to follow — the locations
(`~/Library/Logs/com.termihub.app/termihub.log`, `%LOCALAPPDATA%\...`,
`~/.local/share/...`) exist but are buried in a doc users never open. This slows every bug
report and is trivially fixable.

## Evidence
`docs/testing.md:3267-3270` — the platform log paths, documented in a testing context only.
No user-facing troubleshooting doc exists.

## Recommendation
Add a short user-facing `docs/troubleshooting.md` (linked from README): where logs live per
platform, how to open the log folder (ideally via the OBS-008 Diagnostics panel button), how
to raise verbosity (OBS-009 / `TERMIHUB_FILE_LOG`), and what to include in a bug report.
Keep the testing-doc section for the manual test, but cross-link it.
