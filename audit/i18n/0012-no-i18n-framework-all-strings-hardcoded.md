---
id: I18N-012
title: No i18n framework or message catalog — every UI string is hardcoded English
angle: i18n
severity: high
category: i18n
is_workaround: false
subsystem: src (whole frontend)
evidence:
  - package.json
  - src/components
status: open
---

## What
termiHub has **no internationalization framework and no message catalog**.
There is no `react-intl`/FormatJS, `i18next`/`react-i18next`, `lingui`, or
`polyglot` dependency in `package.json`, no `src/locales/`, no `.po`/`.json`
translation files, and no `<FormattedMessage>` / `t()` call anywhere. The only
locale-related code is two defensive utilities (`src/utils/locale.ts`,
`ensureValidLocale.ts`) that sanitize `navigator.language` — they do not
externalize any strings.

Every user-facing string is a literal embedded in JSX/TS: button labels, dialog
copy, menu items, tooltips, toasts, error messages, empty-state text, ARIA
labels, and placeholders.

## Why it matters
Bucket B (localization-readiness debt) — this is the single largest item and it
determines whether localizing termiHub is a small or a huge effort. **It is a
huge effort.** Rough magnitude across `src/**` (≈197 `.tsx` + ≈295 `.ts`
non-test files):

- ~353 `toast.{success,error,info,loading,warning}(…)` literal calls
- ~426 literal `title=` / `placeholder=` / `aria-label=` attributes
- ~230+ visible JSX text nodes (an undercount — the regex only caught
  single-segment capitalized text; real count is higher)
- Plus hardcoded `title`/`message` strings inside error classifiers
  (`classifyAgentError.ts`, the connection-overlay hint tables, etc.) and Rust
  backend error strings surfaced verbatim to the UI.

There is **zero externalization** today, so shipping any second language means a
full retrofit: introduce a framework, extract every string to keys, thread a
locale/provider through the tree, and localize the Rust-side user-facing error
strings too (which the frontend currently both displays *and* pattern-matches —
see I18N-001..010).

## Evidence
- `package.json` — no i18n dependency present.
- `find src -iname '*locales*' -o -iname '*i18n*' -o -iname '*.po'` → only the
  two locale-guard utilities; no catalog.
- Counts above from `grep` over `src/**` (excluding tests).

## Recommendation
This is a strategic decision, not a quick fix. If localization is a v0.1 goal:
1. Adopt a mature framework (FormatJS/`react-intl` or `i18next`) — per the repo's
   "prefer libraries" rule, do not hand-roll a catalog.
2. Extract strings incrementally, component-area by area, behind an extraction
   lint that fails on new hardcoded JSX text.
3. **Prerequisite:** convert backend-error *classification* to structured codes
   (I18N-001/002/007/008/009/010) first — otherwise localizing the Rust error
   strings will break the frontend's substring matching. The structured-error
   work is a hard dependency of safe localization, and is worth doing for
   correctness even if translation is deferred.

If localization is **not** a v0.1 goal, record that explicitly and still do the
structured-error work, since the bucket-A bugs bite under a non-English *remote
/ OS* even when the UI stays English.
