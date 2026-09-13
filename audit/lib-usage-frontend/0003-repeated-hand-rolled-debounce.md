---
id: LIBFE-003
title: Repeated hand-rolled setTimeout debounce across components; extract one shared hook
angle: lib-usage-frontend
severity: low
category: arch
is_workaround: false
subsystem: src/components, src/hooks
evidence:
  - src/components/Settings/SettingsPanel.tsx:116
  - src/components/FileEditor/FileEditor.tsx:638
  - src/hooks/useLocalDirWatch.ts:47
  - src/components/Settings/KeyPathInput.tsx:28
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:119
  - src/test/setup.ts:53
status: open
---

## What

Debouncing is hand-rolled with raw `setTimeout`/`clearTimeout` (and a mutable
`debounceTimer` ref) in ~10 places, each re-implementing the same
arm/cancel/cleanup dance independently:

- `src/components/FileEditor/FileEditor.tsx:638` — `let debounceTimer …; clearTimeout; setTimeout(…)`.
- `src/hooks/useLocalDirWatch.ts:47` — same pattern in a hook.
- `src/components/Settings/SettingsPanel.tsx:116` — debounced auto-save with a manual flush-on-unmount.
- `src/components/Settings/KeyPathInput.tsx:28` — debounced backend validation.
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:119` — debounced resize request.
- plus others (grep `debounceTimer` / `clearTimeout`).

## Why it matters

The individual pattern is trivial, but replicating it by hand is where the subtle
bugs live: **leaked timers that outlive unmount**. There is direct in-repo evidence
of this class of bug — `src/test/setup.ts:53` documents a shim that exists precisely
because a component leaves a *"debounced `setTimeout` that its cleanup never
clears… That leaked timer fires"* during tests. Each hand-rolled copy has to
independently get flush-on-unmount and cancel-on-dep-change right; several combine
it with manual "flush the last pending write" logic (SettingsPanel) that is easy to
get wrong and is safety-relevant when it guards persistence of user settings.

## Evidence

- `src/test/setup.ts:53` — comment describing a leaked debounce timer that a global
  test shim has to defuse (proof the pattern bites).
- Duplicated arm/cancel logic across the files listed above.

## Recommendation

**Do not add a debounce dependency** (`lodash.debounce` etc.) — for a Tauri app a
new dep for this is not worth it, and the React-idiomatic answer lives in a hook.
Extract a single, tested `useDebouncedCallback(fn, delayMs)` (and/or
`useDebouncedValue`) hook under `src/hooks/` that:

- clears its timer on unmount and on dep change,
- exposes a `flush()` and `cancel()` for the SettingsPanel-style "persist the last
  edit" cases,

then migrate the call sites to it and delete the per-component timers. This removes
the leaked-timer failure mode in one place and lets the test-setup shim eventually
go away. Keep-as-is is a defensible call for the one or two most bespoke sites, but
the auto-save / validation debounces should share the hook.
