---
id: I18N-013
title: navigator.language is monkeypatched at boot to defuse an uplot C-locale crash
angle: i18n
severity: info
category: workaround
is_workaround: true
subsystem: src/utils/locale
evidence:
  - src/main.tsx:1
  - src/utils/ensureValidLocale.ts:11
  - src/utils/locale.ts:83
status: open
---

## What
On a `C`/`POSIX` locale (default on many Linux/headless/container/CI hosts,
including the GitHub ubuntu runner), WebKitGTK reports `navigator.language ===
"C"`, which is not a valid BCP-47 tag. The bundled `uplot` charting dependency
builds `new Intl.NumberFormat(navigator.language)` at **module-evaluation time**,
so on a `C` locale the whole JS bundle throws `RangeError: invalid language tag:
C` before React mounts → blank app (#2646).

The fix (`ensureValidNavigatorLocale()`, imported as the literal **first** line
of `src/main.tsx`) **overwrites `navigator.language` / `navigator.languages`**
via `Object.defineProperty` with a sanitized valid tag before any module reads
them. A companion `resolveUiLocale()` returns a guaranteed-valid tag for the
app's own `toLocale*` call sites.

## Why it matters
Info / documented workaround (`is_workaround: true`). The guard is well-designed
and the right stopgap, but it is a fragile arrangement worth tracking:

- Correctness depends on `import "./utils/ensureValidLocale"` staying the
  **first** import in `src/main.tsx`. Any reordering, or a new dependency that
  reads `navigator.language` at module scope *before* it, silently reintroduces
  the crash. There is no lint enforcing the ordering.
- It monkeypatches a global `navigator` property — a stopgap around an upstream
  dependency bug, not a real fix.
- It confirms the app genuinely runs under `C`/`POSIX` locales in the field, so
  every locale-sensitive path (the parsers in I18N-003/004/005) really is
  exercised there.

## Evidence
- `src/main.tsx:1-5` — the mandatory first import with the ordering comment.
- `src/utils/ensureValidLocale.ts:11` — side-effect call.
- `src/utils/locale.ts:83-104` — `ensureValidNavigatorLocale()` defines the
  getter override; `resolveUiLocale()` at `:58`.

## Recommendation
Keep the guard (it's correct), but harden it: add an ESLint `import/order` rule
or a unit test asserting `ensureValidLocale` is the first import in `main.tsx`,
so the ordering can't silently regress. Longer term, pursue an upstream `uplot`
fix / pin that doesn't read `navigator.language` at module scope, or wrap the
`uplot` import so the app owns the locale passed in — then the global monkeypatch
can be deleted.
