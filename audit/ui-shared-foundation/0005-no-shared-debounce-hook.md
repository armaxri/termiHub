---
id: UISF-005
title: No shared useDebounce hook — debounced save/validate re-hand-rolled with setTimeout + refs
angle: ui-shared-foundation
severity: low
category: arch
is_workaround: false
subsystem: src/hooks
evidence:
  - src/components/Settings/SettingsPanel.tsx:180
  - src/components/Settings/PluginSettingsSection.tsx:10
  - src/components/Settings/KeyPathInput.tsx:8
status: open
---

## What

There is no `useDebounce`/`useDebouncedCallback` hook in `src/hooks/`. Components that need
debounced behaviour (auto-save after edits, delayed backend validation) each re-implement the same
`setTimeout` + `useRef(timer)` + cleanup dance:

- `Settings/SettingsPanel.tsx:180` — "Debounced save for General/Appearance/Terminal settings".
- `Settings/PluginSettingsSection.tsx:10` — "Debounce before a plugin's edited settings are persisted".
- `Settings/KeyPathInput.tsx:8,28` — "Debounce (ms) before validating a typed key path against the backend".

## Why it matters

Debounce is subtle to get right (stale-closure capture, cleanup on unmount, cancel-and-flush on
save). Each hand-rolled copy re-risks those bugs and cannot share the "flush pending on unmount"
logic that `SettingsPanel` already needs. A single tested hook removes the boilerplate and the
per-copy correctness risk.

## Evidence

Three independent inline debounce implementations (frontmatter). No `debounce` hook exists under
`src/hooks/`; the only library-provided debounce in use is react-virtual's internal one in
`FileBrowser.tsx`.

## Recommendation

Add `useDebouncedCallback(fn, ms)` (or adopt a small maintained lib per the repo's "prefer
libraries" rule) to `src/hooks/`, returning a stable debounced fn plus `cancel`/`flush`. Migrate the
three settings sites. Fold this into the `useSearchQuery` hook proposed in UISF-004.
