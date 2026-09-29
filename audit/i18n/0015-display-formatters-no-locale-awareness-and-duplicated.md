---
id: I18N-015
title: Byte/number/date display formatters are English-only, hand-rolled, and duplicated
angle: i18n
severity: low
category: i18n
is_workaround: false
subsystem: src/utils/formatters, src/components (StatusBar, EmbeddedServer)
evidence:
  - src/utils/formatters.ts:4
  - src/utils/formatters.ts:11
  - src/components/EmbeddedServerSidebar/EmbeddedServerItem.tsx:43
  - src/components/StatusBar/StatusBar.tsx:71
status: fixed
resolution: "#2819 — shared formatters locale-aware via Intl.NumberFormat + resolveUiLocale (safe-locale); relative-time kept literal"
---

## What
Display formatting for sizes, rates, and relative time is hand-rolled with
`.toFixed(n)` and hardcoded English, and duplicated:

- `formatBytes()` uses `/1024` + `.toFixed(1)` with no locale grouping
  (`utils/formatters.ts:4`), and is re-implemented at least twice more
  (`EmbeddedServerSidebar/EmbeddedServerItem.tsx:43`, inline in
  `StatusBar.tsx:71`) with slightly different unit caps.
- `formatRelativeTime()` returns hardcoded English ("just now", "5m ago") and
  only falls back to `toLocaleDateString(resolveUiLocale())` for old dates
  (`utils/formatters.ts:11-25`).
- RTT/latency/loss/CPU/mem are formatted with `.toFixed(n)` throughout the
  Network Tools and StatusBar components.

`.toFixed` always emits a `.` decimal and no digit grouping, so there is **no
locale bug or crash** here — but the output is unconditionally English-format and
never uses `Intl.NumberFormat`, so it can't be localized and mixes styles with
the few `toLocaleString(resolveUiLocale())` call sites elsewhere.

## Why it matters
Bucket B, low. Not a defect today (correct, crash-safe), but readiness debt:
localizing number/size/time display later means touching every hand-rolled
formatter and reconciling three `formatBytes` copies. The duplication is also a
maintenance smell independent of i18n.

## Evidence
`src/utils/formatters.ts:4-25`; duplicate `formatBytes` at
`EmbeddedServerSidebar/EmbeddedServerItem.tsx:43-46` and inline math at
`StatusBar.tsx:71-72`.

## Recommendation
Consolidate to a single `formatBytes`/`formatRate`/`formatRelativeTime` in
`utils/formatters.ts` (delete the duplicates), and route number/size formatting
through a shared `Intl.NumberFormat(resolveUiLocale(), …)` so it becomes
locale-aware in one place when localization lands. Use `Intl.RelativeTimeFormat`
(guarded locale) for relative times. Low priority; do it alongside I18N-014.
