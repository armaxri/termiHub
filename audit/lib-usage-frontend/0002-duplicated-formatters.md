---
id: LIBFE-002
title: Duplicated byte / relative-time / duration formatters; consolidate (no new dep needed)
angle: lib-usage-frontend
severity: low
category: arch
is_workaround: false
subsystem: src/utils/formatters, formatting call sites
evidence:
  - src/utils/formatters.ts:4
  - src/utils/formatters.ts:12
  - src/components/EmbeddedServerSidebar/EmbeddedServerItem.tsx:43
  - src/types/transfer.ts:253
  - src/components/NetworkTools/monitorStaleness.ts:45
  - src/components/Terminal/TerminalConnectionOverlay.tsx:53
status: open
---

## What

The app has a shared `src/utils/formatters.ts` with `formatBytes()` and
`formatRelativeTime()`, but several call sites reimplement the same logic locally
instead of importing the shared helper:

- **Byte formatting reinvented:**
  - `src/components/EmbeddedServerSidebar/EmbeddedServerItem.tsx:43` — a private
    `formatBytes(n)` duplicating the shared one (with a different unit ceiling: MB
    vs GB).
  - `src/types/transfer.ts:253` — another `while (value >= 1024) …` byte loop.
- **Relative-time / duration reinvented:**
  - `src/components/NetworkTools/monitorStaleness.ts:45` — a second-resolution
    "`Ns`/`Nm ago`/`Nh ago`/`Nd ago`" formatter parallel to `formatRelativeTime`.
  - `src/components/Terminal/TerminalConnectionOverlay.tsx:53` — a private
    `formatElapsed(seconds)` (`5s`, `1m 05s`).

The shared `formatRelativeTime` itself also hand-computes the mins/hours/days
buckets rather than using the built-in, locale-aware `Intl.RelativeTimeFormat`
(the app already resolves a UI locale via `resolveUiLocale()`).

## Why it matters

This is not a bug and not a case for a new dependency — each helper is a handful of
lines, so `pretty-bytes`/`filesize`/`ms` are **not** warranted (they would violate
the "don't add a dep for a 5-line helper" judgement). The issue is **internal
duplication and inconsistency**: the two byte formatters disagree on their top unit
(MB vs GB), and there are three slightly different "N ago" renderers. That drifts
over time and produces inconsistent readouts across panels (transfer sizes vs
embedded-server stats vs file-browser sizes).

## Evidence

- `formatBytes` shared: `src/utils/formatters.ts:4`; duplicated:
  `EmbeddedServerItem.tsx:43`, `types/transfer.ts:253`.
- `formatRelativeTime` shared: `src/utils/formatters.ts:12`; parallel impls:
  `monitorStaleness.ts:45` (deliberately second-resolution — see its own doc
  comment), `TerminalConnectionOverlay.tsx:53` (`formatElapsed`).

## Recommendation

- **Keep it in-house — do not add a formatting dependency.** Consolidate the byte
  formatter to the single `formatBytes` in `utils/formatters.ts` (parameterise the
  max unit if EmbeddedServer really wants to cap at MB) and delete the two copies.
- For relative time, keep one shared implementation. `monitorStaleness` has a
  legitimate reason to differ (needs second-granularity), so either promote a
  `formatRelativeTime({ seconds: true })` option or leave it as a documented
  variant, but fold `formatElapsed` and any others into the shared module.
- Optional, cheap correctness win: back `formatRelativeTime` with the built-in
  `Intl.RelativeTimeFormat` (zero dep, already have the locale) so it is truly
  locale-aware instead of hard-coding English `"m ago"` suffixes.

This finding overlaps the code-duplication angle; it is recorded here as an
"under-used existing helper" case.
