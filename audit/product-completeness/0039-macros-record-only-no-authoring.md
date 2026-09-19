---
id: PROD-039
title: Macros can only be recorded, not hand-authored or their step text edited
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/MacroSidebar, src/store/slices/macrosSlice
evidence:
  - src/components/MacroSidebar/MacroEditorDialog.tsx:89
  - src/store/slices/macrosSlice.ts:195
status: open
---

## What
The only way to create a macro is to record it in a live terminal. In the editor, step *data*
is read-only — you can adjust delays and reorder/remove steps, but not type a macro by hand or
fix a captured command's text.

## Why it matters
Users expect to author a macro directly (a known sequence of commands) or correct a typo in a
captured step without re-recording the whole thing.

## Evidence
- `src/components/MacroSidebar/MacroEditorDialog.tsx:89` — `setStepDelay` is the only step mutator; step data read-only at `:114`; no `addStep`.
- `src/store/slices/macrosSlice.ts:195` — creation only via `startMacroRecording`.

## Recommendation
Add "New empty macro" + add/edit-step-text in the editor so macros can be authored and
corrected without recording.
